"use strict";

const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const { refreshPaperOrder, trackPaperOrder } = require("./order-tracking");

function blocked(reason) {
  return { status: "BLOCKED", reason };
}

const US_EXCHANGE = {
  NASDAQ: "ND", ND: "ND",
  NYSE: "NY", NY: "NY",
  AMEX: "NA", NYSEARCA: "NA", ARCA: "NA", NA: "NA",
};

function isUsMarketClosedError(error) {
  return /RC4058|장\s*종료/.test(String(error?.message || error || ""));
}

function domesticSessionClock(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function domesticSession(value = new Date()) {
  const { weekday, minutes } = domesticSessionClock(value);
  if (["Sat", "Sun"].includes(weekday)) return "CLOSED";
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
  const { weekday, minutes } = usSessionClock(value);
  if (["Sat", "Sun"].includes(weekday)) return "CLOSED";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "PRE";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "REGULAR";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "AFTER";
  return "CLOSED";
}

function isUsOrderSession(value = new Date()) {
  return ["PRE", "REGULAR", "AFTER"].includes(usSession(value));
}

function isUsBuySession(value = new Date()) {
  return ["REGULAR", "AFTER"].includes(usSession(value));
}

function isUsEntry(record) {
  const exchange = String(record?.payload?.exchange || "").toUpperCase();
  return record?.payload?.paper_order_test !== true
    && record?.payload?.action === "BUY"
    && ["PAPER_ENTRY", "PAPER_ADD"].includes(record?.risk?.verdict)
    && Boolean(US_EXCHANGE[exchange]);
}

function shouldDeferUsEntry(record, error) {
  return isUsEntry(record) && isUsMarketClosedError(error);
}

function shouldDelayUsEntry(record, value = new Date()) {
  return isUsEntry(record) && !isUsBuySession(value);
}

function isDomesticEntry(record) {
  return record?.payload?.paper_order_test !== true
    && record?.payload?.exchange === "KRX"
    && record?.payload?.action === "BUY"
    && ["PAPER_ENTRY", "PAPER_ADD"].includes(record?.risk?.verdict);
}

function shouldDeferEntry(record, error) {
  return (isUsEntry(record) || isDomesticEntry(record)) && isUsMarketClosedError(error);
}

function shouldDelayEntry(record, value = new Date()) {
  if (isUsEntry(record)) return !isUsBuySession(value);
  if (isDomesticEntry(record)) return !isDomesticBuySession(value);
  return false;
}

function partialExitRatio(record, options) {
  const code = record.outcome?.signal?.signalCode;
  const level = record.outcome?.signal?.tpLevel;
  if (code === "EXIT_PARTIAL_1" || (code === "TAKE_PROFIT" && level === 1)) return options.partialExit1Ratio ?? 0.25;
  if (code === "EXIT_PARTIAL_2" || (code === "TAKE_PROFIT" && level === 2)) return options.partialExit2Ratio ?? 0.5;
  return null;
}

function partialExitStage(record) {
  const code = record.outcome?.signal?.signalCode;
  const level = record.outcome?.signal?.tpLevel;
  if (code === "EXIT_PARTIAL_1" || (code === "TAKE_PROFIT" && level === 1)) return "TP1";
  if (code === "EXIT_PARTIAL_2" || (code === "TAKE_PROFIT" && level === 2)) return "TP2";
  return null;
}

function partialExitQuantity(tradableQuantity, ratio) {
  if (!Number.isInteger(tradableQuantity) || tradableQuantity < 1 || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return 0;
  return Math.floor(tradableQuantity * ratio);
}

function protectedUsBuyLimit(signalPrice, currentPrice) {
  if (!Number.isFinite(signalPrice) || signalPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("미국주식 매수 상한가 계산에 유효한 신호가와 현재가가 필요합니다.");
  }
  const raw = Math.min(signalPrice, currentPrice * 1.005);
  const scale = raw < 1 ? 10_000 : 100;
  return Math.floor(raw * scale + Number.EPSILON) / scale;
}

async function submitPaperOrder(record, options) {
  if (record.payload?.paper_order_test === true) return null;

  const { payload, risk, positionPreview } = record;
  const entry = ["PAPER_ENTRY", "PAPER_ADD"].includes(risk?.verdict) && payload.action === "BUY";
  const exit = risk?.verdict === "PAPER_EXIT";
  const partialExit = risk?.verdict === "PAPER_PARTIAL_EXIT";
  if (!entry && !exit && !partialExit) return null;
  if (!options.enabled) return blocked(`${options.brokerLabel || "키움"} 모의 자동주문 비활성`);
  if (!["mock", "live"].includes(options.environment)) return blocked("지원하지 않는 계좌 환경");
  const side = entry ? "BUY" : "SELL";

  const exchange = String(payload.exchange || "").toUpperCase();
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
      const tradable = (await client.getDomesticBalance()).holdings.find((item) => item.code.replace(/^A/, "") === payload.ticker)?.tradableQuantity;
      quantity = partialExit ? partialExitQuantity(tradable, partialExitRatio(record, options)) : tradable;
    }
    if (!Number.isInteger(quantity) || quantity < 1) return blocked("주문 가능한 국내주식 수량 없음");
    const session = domesticSession(options.now || new Date());
    orderStyle = session === "REGULAR" ? "PROTECTED" : "MARKET";
    marketFallbackAllowed = orderStyle === "PROTECTED" && record.outcome?.signal?.signalCode === "EXIT_CRASH";
    orderStrategy = session === "REGULAR"
      ? `최유리 IOC 최대 2회${marketFallbackAllowed ? " 후 급락 손절 잔량만 시장가" : " · 시장가 전환 없음"}`
      : { PRE: "장전 시간외 종가", AFTER_CLOSE: "장후 시간외 종가", AFTER_SINGLE: "시간외 단일가 지정가" }[session];
    order = await client.placeDomesticMarketOrder({
      side, symbol: payload.ticker, quantity, price: payload.price,
      session, orderStyle,
    });
  } else {
    client = options.overseasClient;
    const kiwoomExchange = US_EXCHANGE[exchange];
    if (!kiwoomExchange) return blocked(`지원하지 않는 거래소: ${exchange || "없음"}`);
    if (entry) quantity = positionPreview?.quantity;
    else {
      const tradable = (await client.getUsBalance({ exchange: kiwoomExchange })).holdings.find((item) => item.code === payload.ticker)?.tradableQuantity;
      quantity = partialExit ? partialExitQuantity(tradable, partialExitRatio(record, options)) : tradable;
    }
    if (!Number.isInteger(quantity) || quantity < 1) return blocked("주문 가능한 미국주식 수량 없음");
    limitPrice = payload.price;
    if (entry) {
      const quote = await client.getUsQuote({ exchange: kiwoomExchange, symbol: payload.ticker });
      referencePrice = quote.currentPrice;
      limitPrice = protectedUsBuyLimit(payload.price, referencePrice);
      orderStrategy = "신호가·현재가 기준 상한 지정가";
    } else {
      orderStrategy = "신호가 지정가";
    }
    order = await client.placeUsLimitOrder({
      side, exchange: kiwoomExchange, symbol: payload.ticker,
      quantity, price: limitPrice,
    });
    order.exchange = kiwoomExchange;
  }
  return options.tracker.record({
    ...order, orderQuantity: quantity, filledQuantity: 0, remainingQuantity: quantity,
    orderStyle, orderStrategy, marketFallbackAllowed, limitPrice, referencePrice,
    brokerLabel: options.brokerLabel || "키움 모의계좌",
    source: record.source || "TRADINGVIEW", market: exchange, name: payload.name,
    koreanName: payload.koreanName, englishName: payload.englishName,
    signalType: payload.type, signalPrice: payload.price, stopPrice: positionPreview?.stopPrice ?? payload.sl,
    conviction: payload.conviction, requestId: record.requestId,
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
    currency: positionPreview?.currency || (exchange === "KRX" ? "KRW" : "USD"),
  });
}

async function submitPaperTestOrder(record, options) {
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
    if (error.code === "EEXIST") return blocked("모의주문 1회 테스트가 이미 실행됨");
    throw error;
  }

  const order = await options.client.placeDomesticMarketOrder({ side: "BUY", symbol: options.symbol, quantity: 1 });
  fs.writeFileSync(options.lockFile, `${JSON.stringify({ requestId: record.requestId, orderNo: order.orderNo, status: order.status })}\n`, { mode: 0o600 });
  return options.tracker.record({ ...order, filledQuantity: 0, remainingQuantity: 1, source: "TRADINGVIEW_TEST" });
}

async function trackPaperTestOrder(order, options) {
  for (let attempt = 0; attempt < (options.attempts ?? 15); attempt += 1) {
    const rows = await options.client.getDomesticOrderExecutions({ symbol: order.symbol });
    const current = rows.find((item) => item.orderNo === order.orderNo);
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
  isUsOrderSession,
  isUsRegularSession,
  partialExitQuantity,
  partialExitRatio,
  partialExitStage,
  protectedUsBuyLimit,
  refreshPaperOrder,
  shouldDeferUsEntry,
  shouldDeferEntry,
  shouldDelayEntry,
  shouldDelayUsEntry,
  submitPaperOrder,
  trackPaperOrder,
  submitPaperTestOrder,
  trackPaperTestOrder,
  usSessionClock,
  usSession,
};
