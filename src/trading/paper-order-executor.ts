"use strict";

const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { refreshPaperOrder, trackPaperOrder } = require("./order-tracking");
const { scopePositionPreview, managedPosition, normalizedSymbol, normalizedTimeframe } = require("./position-ownership");
const { tradingDay } = require("./market-calendar");

type SignalRecord = { payload: any; risk?: any; positionPreview?: any; outcome?: any; source?: string; requestId?: string; [key: string]: any };
type ExecutorOptions = { enabled: boolean; environment: string; domesticClient: any; overseasClient: any; tracker: any; brokerLabel?: string; partialExit1Ratio?: number; partialExit2Ratio?: number; now?: Date; symbol?: string; lockFile?: string; client?: any; attempts?: number; delayMs?: number; [key: string]: any };
type Session = "PRE" | "REGULAR" | "AFTER_CLOSE" | "AFTER_SINGLE" | "AFTER" | "CLOSED";
type AccountSession = { environment?: string; id?: string; afterMarketExtended?: boolean };

function blocked(reason: string) {
  return { status: "BLOCKED", reason };
}

const US_EXCHANGE: Record<string, string> = {
  NASDAQ: "ND", ND: "ND",
  NYSE: "NY", NY: "NY",
  AMEX: "NA", NYSEARCA: "NA", ARCA: "NA", NA: "NA",
};

function isUsMarketClosedError(error: unknown) {
  return /RC4058|장\s*종료/.test(String(error instanceof Error ? error.message : error || ""));
}

function isRetryablePreOrderError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "");
  return isUsMarketClosedError(error)
    || /\[(?:VTTS|TTTS)3012R\].*Gateway\s*라우팅\s*오류/i.test(message);
}

function domesticSessionClock(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function domesticSession(value = new Date()): Session {
  const { date, weekday, minutes } = domesticSessionClock(value);
  if (tradingDay("KRX", date, weekday).closed) return "CLOSED";
  if (minutes >= 8 * 60 + 30 && minutes < 8 * 60 + 40) return "PRE";
  if (minutes >= 9 * 60 && minutes < 15 * 60 + 30) return "REGULAR";
  if (minutes >= 15 * 60 + 40 && minutes < 16 * 60) return "AFTER_CLOSE";
  if (minutes >= 16 * 60 && minutes < 18 * 60) return "AFTER_SINGLE";
  return "CLOSED";
}

function isDomesticOrderSession(value = new Date()) {
  return domesticSession(value) !== "CLOSED";
}

function isDomesticBuySession(value = new Date()) {
  return ["REGULAR", "AFTER_CLOSE", "AFTER_SINGLE"].includes(domesticSession(value));
}

function usSessionClock(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isUsRegularSession(value = new Date()) {
  return usSession(value) === "REGULAR";
}

function usSession(value = new Date()) {
  const { date, weekday, minutes } = usSessionClock(value);
  const day = tradingDay("US", date, weekday);
  if (day.closed) return "CLOSED";
  const close = (day.early ? 13 : 16) * 60;
  const extendedClose = (day.early ? 17 : 20) * 60;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "PRE";
  if (minutes >= 9 * 60 + 30 && minutes < close) return "REGULAR";
  if (minutes >= close && minutes < extendedClose) return "AFTER";
  return "CLOSED";
}

function isUsOrderSession(value = new Date()) {
  return ["PRE", "REGULAR", "AFTER"].includes(usSession(value));
}

function isUsBuySession(value = new Date()) {
  return ["REGULAR", "AFTER"].includes(usSession(value));
}

function isUsEntry(record: SignalRecord) {
  const exchange = String(record?.payload?.exchange || "").toUpperCase();
  return record?.payload?.paper_order_test !== true
    && record?.payload?.action === "BUY"
    && ["PAPER_ENTRY", "PAPER_ADD"].includes(record?.risk?.verdict)
    && Boolean(US_EXCHANGE[exchange]);
}

function shouldDeferUsEntry(record: SignalRecord, error: unknown) {
  return isUsEntry(record) && isUsMarketClosedError(error);
}

function shouldDelayUsEntry(record: SignalRecord, value = new Date(), account: AccountSession = {}) {
  return isUsEntry(record) && shouldDelayOrder(record, value, account);
}

function isDomesticEntry(record: SignalRecord) {
  return record?.payload?.paper_order_test !== true
    && record?.payload?.exchange === "KRX"
    && record?.payload?.action === "BUY"
    && ["PAPER_ENTRY", "PAPER_ADD"].includes(record?.risk?.verdict);
}

function isExecutableOrder(record: SignalRecord) {
  if (record?.payload?.paper_order_test === true) return false;
  if (record?.payload?.action === "BUY") return ["PAPER_ENTRY", "PAPER_ADD"].includes(record?.risk?.verdict);
  if (record?.payload?.action === "SELL") return ["PAPER_EXIT", "PAPER_PARTIAL_EXIT"].includes(record?.risk?.verdict);
  return false;
}

function shouldDeferOrder(record: SignalRecord, error: unknown) {
  return isExecutableOrder(record) && isRetryablePreOrderError(error);
}

function shouldDelayOrder(record: SignalRecord, value = new Date(), account: AccountSession = {}) {
  if (!isExecutableOrder(record)) return false;
  const buy = record.payload.action === "BUY";
  if (Boolean(US_EXCHANGE[String(record.payload.exchange || "").toUpperCase()])) {
    const session = usSession(value);
    if (session === "REGULAR") return false;
    // Exchange hours are not account eligibility. Unspecified accounts fail closed outside regular hours.
    if (account.environment !== "live" || !["KIWOOM", "KIS"].includes(account.id || "")) return true;
    if (session === "PRE") return buy; // Existing strategy: no premarket BUY.
    if (session !== "AFTER") return true;
    const cutoff = account.id === "KIWOOM" ? 8 : account.afterMarketExtended === true ? 9 : 7;
    return domesticSessionClock(value).minutes >= cutoff * 60;
  }
  if (record.payload.exchange === "KRX") {
    return buy ? !isDomesticBuySession(value) : !isDomesticOrderSession(value);
  }
  return false;
}

function nextOrderCheck(record: SignalRecord, from = new Date(), afterSession = "", account: AccountSession = {}): number | null {
  if (!isExecutableOrder(record)) return null;
  const sessionKey = (value: Date) => record.payload.exchange === "KRX"
    ? `${domesticSessionClock(value).date}:${domesticSession(value)}` : `${usSessionClock(value).date}:${usSession(value)}`;
  if (!shouldDelayOrder(record, from, account) && sessionKey(from) !== afterSession) return from.getTime();
  // Offset at UTC noon is after the NY DST switch, before every possible next session.
  const clock = record.payload.exchange === "KRX" ? domesticSessionClock : usSessionClock;
  const boundaries = record.payload.exchange === "KRX" ? [510, 540, 940, 960] : [240, 570, 780, 960];
  const noon = Math.floor(from.getTime() / 86400_000) * 86400_000 + 12 * 3600_000;
  for (let day = -1; day <= 10; day++) {
    const seed = noon + day * 86400_000;
    const midnight = seed - clock(new Date(seed)).minutes * 60_000;
    for (const minutes of boundaries) {
      const value = new Date(midnight + minutes * 60_000);
      if (value.getTime() >= from.getTime() && !shouldDelayOrder(record, value, account) && sessionKey(value) !== afterSession) return value.getTime();
    }
  }
  return null;
}

function shouldDeferEntry(record: SignalRecord, error: unknown) {
  return (isUsEntry(record) || isDomesticEntry(record)) && isUsMarketClosedError(error);
}

function shouldDelayEntry(record: SignalRecord, value = new Date(), account: AccountSession = {}) {
  if (isUsEntry(record)) return shouldDelayOrder(record, value, account);
  if (isDomesticEntry(record)) return !isDomesticBuySession(value);
  return false;
}

function partialExitRatio(record: SignalRecord, options: ExecutorOptions) {
  const code = record.outcome?.signal?.signalCode;
  const level = record.outcome?.signal?.tpLevel;
  if (code === "EXIT_PARTIAL_1" || (code === "TAKE_PROFIT" && level === 1)) return options.partialExit1Ratio ?? 0.25;
  if (code === "EXIT_PARTIAL_2" || (code === "TAKE_PROFIT" && level === 2)) return options.partialExit2Ratio ?? 0.5;
  return null;
}

function partialExitStage(record: SignalRecord) {
  const code = record.outcome?.signal?.signalCode;
  const level = record.outcome?.signal?.tpLevel;
  if (code === "EXIT_PARTIAL_1" || (code === "TAKE_PROFIT" && level === 1)) return "TP1";
  if (code === "EXIT_PARTIAL_2" || (code === "TAKE_PROFIT" && level === 2)) return "TP2";
  return null;
}

function partialExitQuantity(tradableQuantity: number, ratio: number | null) {
  if (!Number.isInteger(tradableQuantity) || tradableQuantity < 1 || typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return 0;
  return Math.floor(tradableQuantity * ratio);
}

function previewTradableQuantity(positionPreview: any, ticker: string) {
  const holding = positionPreview?.currentHoldings?.find((item: any) => normalizedSymbol(item.code) === normalizedSymbol(ticker));
  const quantity = Number(holding?.tradableQuantity ?? holding?.quantity);
  return Number.isInteger(quantity) && quantity >= 0 ? quantity : null;
}

function protectedUsBuyLimit(signalPrice: number, currentPrice: number) {
  if (!Number.isFinite(signalPrice) || signalPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("미국주식 매수 상한가 계산에 유효한 신호가와 현재가가 필요합니다.");
  }
  const raw = Math.min(signalPrice, currentPrice * 1.005);
  const scale = raw < 1 ? 10_000 : 100;
  return Math.floor(raw * scale + Number.EPSILON) / scale;
}

async function submitPaperOrder(record: SignalRecord, options: ExecutorOptions) {
  if (record.payload?.paper_order_test === true) return null;

  const { payload, risk } = record;
  let positionPreview = record.positionPreview;
  const entry = ["PAPER_ENTRY", "PAPER_ADD"].includes(risk?.verdict) && payload.action === "BUY";
  const exit = risk?.verdict === "PAPER_EXIT";
  const partialExit = risk?.verdict === "PAPER_PARTIAL_EXIT";
  if (!entry && !exit && !partialExit) return null;
  if (entry && positionPreview?.blocked) return blocked(positionPreview.reason || "주문 조건 불충족");
  if (entry && !normalizedTimeframe(payload.timeframe)) return blocked("진입 기준 시간봉(4시간/일봉) 확인 필요");
  if (!options.enabled) return blocked(`${options.brokerLabel || "키움"} 모의 자동주문 비활성`);
  if (!["mock", "live"].includes(options.environment)) return blocked("지원하지 않는 계좌 환경");
  const side = entry ? "BUY" : "SELL";

  const exchange = String(payload.exchange || "").toUpperCase();
  if (exchange !== "KRX" && !US_EXCHANGE[exchange]) return blocked(`지원하지 않는 거래소: ${exchange || "없음"}`);
  const canSubmit = () => {
    if (exchange !== "KRX" && shouldDelayOrder(record, options.now || new Date(), options)) {
      // Thrown before HTTP, including after the broker's rate-limit/token queue: safe to defer, never UNKNOWN.
      throw new Error(`${options.environment === "mock" ? "모의계좌 정규장" : "실계좌 지원 세션"} 대기 · 장종료 · 주문 송신 안 함`);
    }
    return !options.canSubmit || options.canSubmit();
  };
  if (!canSubmit()) return blocked("자동매매 OFF · 주문 송신 중지");
  const trackedOrders = options.tracker.list?.() || [];
  if (exit || partialExit || risk?.verdict === "PAPER_ADD" || managedPosition(trackedOrders, payload, options.environment).quantity > 0) {
    if (!positionPreview?.currentHoldings) {
      const balance = exchange === "KRX" ? await options.domesticClient.getDomesticBalance()
        : await options.overseasClient.getUsBalance({ exchange: US_EXCHANGE[exchange] });
      const holdings = balance.holdings.filter((item: any) => normalizedSymbol(item.code) === normalizedSymbol(payload.ticker));
      positionPreview = { ...positionPreview, currentHoldings: holdings,
        currentPositionQuantity: holdings.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0) };
    }
    positionPreview = scopePositionPreview(record, positionPreview, trackedOrders, options.environment);
    if (positionPreview?.blocked) return blocked(positionPreview.reason);
  }
  let client;
  let quantity;
  let order;
  let orderStyle;
  let orderStrategy;
  let limitPrice;
  let referencePrice;
  let marketFallbackAllowed = false;
  if (exchange === "KRX") {
    client = options.domesticClient;
    if (!/^\d{6}$/.test(payload.ticker)) return blocked("국내주식 종목코드는 6자리여야 함");
    if (entry) quantity = positionPreview?.quantity;
    else {
      const previewTradable = previewTradableQuantity(positionPreview, payload.ticker);
      const tradable = previewTradable ?? (await client.getDomesticBalance()).holdings.find((item: any) => normalizedSymbol(item.code) === normalizedSymbol(payload.ticker))?.tradableQuantity;
      const ownedTradable = Math.min(Number(tradable), Number(positionPreview.managedQuantity));
      quantity = partialExit ? partialExitQuantity(ownedTradable, partialExitRatio(record, options)) : ownedTradable;
    }
    if (!Number.isInteger(quantity) || quantity < 1) return blocked("주문 가능한 국내주식 수량 없음");
    const session = domesticSession(options.now || new Date());
    orderStyle = session === "REGULAR" ? "PROTECTED" : "MARKET";
    marketFallbackAllowed = orderStyle === "PROTECTED" && record.outcome?.signal?.signalCode === "EXIT_CRASH";
    orderStrategy = session === "REGULAR"
      ? `최유리 IOC 최대 2회${marketFallbackAllowed ? " 후 급락 손절 잔량만 시장가" : " · 시장가 전환 없음"}`
      : ({ PRE: "장전 시간외 종가", AFTER_CLOSE: "장후 시간외 종가", AFTER_SINGLE: "시간외 단일가 지정가", CLOSED: "장 종료" } as Record<string, string>)[session];
    if (!canSubmit()) return blocked("자동매매 OFF · 주문 송신 중지");
    order = await client.placeDomesticMarketOrder({
      side, symbol: payload.ticker, quantity, price: payload.price,
      session, orderStyle,
      canSubmit,
    });
  } else {
    client = options.overseasClient;
    const kiwoomExchange = US_EXCHANGE[exchange];
    if (!kiwoomExchange) return blocked(`지원하지 않는 거래소: ${exchange || "없음"}`);
    if (entry) quantity = positionPreview?.quantity;
    else {
      const previewTradable = previewTradableQuantity(positionPreview, payload.ticker);
      const tradable = previewTradable ?? (await client.getUsBalance({ exchange: kiwoomExchange })).holdings.find((item: any) => normalizedSymbol(item.code) === normalizedSymbol(payload.ticker))?.tradableQuantity;
      const ownedTradable = Math.min(Number(tradable), Number(positionPreview.managedQuantity));
      quantity = partialExit ? partialExitQuantity(ownedTradable, partialExitRatio(record, options)) : ownedTradable;
    }
    if (!Number.isInteger(quantity) || quantity < 1) return blocked("주문 가능한 미국주식 수량 없음");
    limitPrice = payload.price;
    if (entry) {
      const quote = await client.getUsQuote({ exchange: kiwoomExchange, symbol: payload.ticker });
      referencePrice = quote.currentPrice;
      limitPrice = protectedUsBuyLimit(payload.price, referencePrice);
      orderStrategy = "신호가·현재가 기준 상한 지정가";
    } else {
      orderStrategy = record.originalSignalPrice !== undefined ? "주문 직전 현재가 지정가" : "신호가 지정가";
    }
    if (!canSubmit()) return blocked("자동매매 OFF · 주문 송신 중지");
    order = await client.placeUsLimitOrder({
      side, exchange: kiwoomExchange, symbol: payload.ticker,
      quantity, price: limitPrice,
      canSubmit,
    });
    order.exchange = kiwoomExchange;
  }
  const trackedOrder = {
    ...(record.executorReportable ? { executorReportable: true } : {}),
    ...order, orderQuantity: quantity, filledQuantity: 0, remainingQuantity: quantity,
    orderStyle, orderStrategy, marketFallbackAllowed, limitPrice, referencePrice,
    brokerLabel: options.brokerLabel || "키움 모의계좌",
    environment: options.environment,
    source: record.source || "TRADINGVIEW", market: exchange, name: payload.name,
    timeframe: payload.timeframe,
    policyVersion: record.policyVersion || "legacy",
    policyHash: record.policyHash || null,
    sizingContext: { sigmaZ: payload.sb_z_score, heatMultiplier: positionPreview?.heatMultiplier,
      riskBudget: positionPreview?.riskBudget, entryTimeframe: positionPreview?.entryTimeframe },
    koreanName: payload.koreanName, englishName: payload.englishName,
    signalType: payload.type, signalPrice: record.originalSignalPrice ?? payload.price, executionPrice: payload.price, stopPrice: positionPreview?.stopPrice ?? payload.sl,
    conviction: payload.conviction, requestId: record.requestId,
    signalCode: record.outcome?.signal?.signalCode,
    partialExitRatio: partialExit ? partialExitRatio(record, options) : null,
    partialExitStage: partialExit ? partialExitStage(record) : null,
    fullExit: exit,
    entryType: entry ? risk.verdict : null,
    pyramidStage: positionPreview?.pyramidStage || null,
    pyramidRatio: positionPreview?.pyramidRatio || null,
    initialEntryQuantity: positionPreview?.initialEntryQuantity || null,
    plannedInvestment: positionPreview?.positionValue,
    plannedRisk: positionPreview?.stopLossAmount,
    projectedPositionRatio: positionPreview?.projectedPositionRatio,
    positionLimitRatio: positionPreview?.positionLimitRatio,
    accountEquity: positionPreview?.totalAccountEquity || positionPreview?.equity,
    autoCapital: positionPreview?.autoCapital,
    autoCapitalRatio: positionPreview?.autoCapitalRatio,
    preTradePositionValue: positionPreview?.currentPositionValue,
    preTradePositionQuantity: positionPreview?.currentPositionQuantity,
    preTradeManagedQuantity: positionPreview?.managedQuantity,
    preTradeAverageEntryPrice: positionPreview?.averageEntryPrice,
    currency: positionPreview?.currency || (exchange === "KRX" ? "KRW" : "USD"),
  };
  try { return options.tracker.record(trackedOrder); } catch (error) {
    // 증권사 접수 후 디스크 오류: 저장 실패를 미접수로 해석해 재주문하면 안 됩니다.
    (error as any).orderStatusUnknown = true;
    throw error;
  }
}

async function submitPaperTestOrder(record: SignalRecord, options: ExecutorOptions) {
  if (record.payload?.paper_order_test !== true) return null;
  if (!options.enabled) return blocked("PAPER_ORDER_TEST_ENABLED=false");
  if (record.risk?.verdict !== "PAPER_ENTRY") return blocked(`자동매매 게이트: ${record.risk?.verdict || "없음"}`);
  if (record.payload.exchange !== "KRX" || record.payload.action !== "BUY") return blocked("KRX 매수 테스트 신호만 허용");
  if (record.payload.ticker !== options.symbol) return blocked(`허용 종목은 ${options.symbol} 한 종목뿐`);

  try {
    fs.writeFileSync(options.lockFile, `${JSON.stringify({ requestId: record.requestId, status: "SUBMITTING" })}\n`, {
      flag: "wx", mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return blocked("모의주문 1회 테스트가 이미 실행됨");
    throw error;
  }

  const order = await options.client.placeDomesticMarketOrder({ side: "BUY", symbol: options.symbol, quantity: 1 });
  fs.writeFileSync(options.lockFile, `${JSON.stringify({ requestId: record.requestId, orderNo: order.orderNo, status: order.status })}\n`, { mode: 0o600 });
  return options.tracker.record({ ...order, filledQuantity: 0, remainingQuantity: 1, source: "TRADINGVIEW_TEST" });
}

async function trackPaperTestOrder(order: any, options: ExecutorOptions) {
  for (let attempt = 0; attempt < (options.attempts ?? 15); attempt += 1) {
    const rows = await options.client.getDomesticOrderExecutions({ symbol: order.symbol });
    const current = rows.find((item: any) => item.orderNo === order.orderNo);
    if (current) {
      const saved = options.tracker.record({ ...order, ...current });
      if (["FILLED", "CANCELLED", "REJECTED"].includes(saved.status)) return saved;
    }
    await delay(options.delayMs ?? 1000);
  }
  return order;
}

module.exports = {
  domesticSession,
  domesticSessionClock,
  isDomesticBuySession,
  isDomesticOrderSession,
  isUsBuySession,
  isUsMarketClosedError,
  isRetryablePreOrderError,
  isUsOrderSession,
  isUsRegularSession,
  nextOrderCheck,
  partialExitQuantity,
  partialExitRatio,
  partialExitStage,
  previewTradableQuantity,
  protectedUsBuyLimit,
  refreshPaperOrder,
  shouldDeferUsEntry,
  shouldDeferEntry,
  shouldDeferOrder,
  shouldDelayEntry,
  shouldDelayOrder,
  shouldDelayUsEntry,
  submitPaperOrder,
  trackPaperOrder,
  submitPaperTestOrder,
  trackPaperTestOrder,
  usSessionClock,
  usSession,
};
