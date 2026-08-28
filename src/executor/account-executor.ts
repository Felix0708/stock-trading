"use strict";

const fs = require("node:fs");
const { Client, GatewayIntentBits } = require("discord.js");
const { syncAccountPortfolio } = require("./account-portfolio");
const { parseBuyApprovalCommand } = require("./buy-approval");
const { decodeSignalEmbed } = require("../discord/discord-signal-envelope");
const { KiwoomClient, kiwoomCredentials } = require("../brokers/kiwoom-client");
const { KisClient, kisCredentials } = require("../brokers/kis-client");
const { enrichInstrumentNames, formatInstrumentLabel } = require("../research/instrument-names");
const { OrderTracker } = require("../trading/order-tracker");
const {
  domesticSession,
  domesticSessionClock,
  partialExitStage,
  refreshPaperOrder,
  shouldDeferEntry,
  shouldDelayEntry,
  submitPaperOrder,
  trackPaperOrder,
  usSession,
  usSessionClock,
} = require("../trading/paper-order-executor");
const { calculateWebhookPositionPreview, inferPositionProfitable } = require("../trading/position-sizer");
const { formatBrokerStartup, formatDeferredBuy, formatExecutorError, formatOrderStatus, formatTradeJournal, formatUncreatedOrder } = require("../discord/order-discord");

function shouldConsumeMessage(message, config) {
  return message?.author?.bot === true
    && config.sourceChannelIds.has(message.channelId)
    && config.sourceBotIds.has(message.author.id);
}

class SignalReceiptStore {
  file: string;
  state: any;

  constructor(file, defaultAutoTrading = false) {
    this.file = file;
    this.state = file && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { requestIds: [], messageIds: [], pending: {} };
    this.state.pending ||= {};
    this.state.deferred ||= {};
    this.state.partialExits ||= {};
    this.state.invalidations ||= {};
    this.state.autoTrading ??= defaultAutoTrading;
  }

  claim(requestId, messageId) {
    if (!requestId || !messageId || this.state.requestIds.includes(requestId) || this.state.messageIds.includes(messageId)) return false;
    this.state.requestIds.push(requestId);
    this.state.messageIds.push(messageId);
    this.write();
    return true;
  }

  putPending(record, messageId, ttlMs, brokerIds) {
    const key = `${record.payload.exchange}:${record.payload.ticker}`;
    this.state.pending[key] = { key, record, messageId, brokerIds, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.write();
    return this.state.pending[key];
  }

  findPending({ ticker = "", messageId = "", now = Date.now() } = {}) {
    const rows: any[] = (Object.values(this.state.pending) as any[])
      .filter((item) => item.expiresAt > now)
      .filter((item) => !ticker || item.record.payload.ticker === ticker)
      .filter((item) => !messageId || item.messageId === messageId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return rows.length === 1 ? rows[0] : null;
  }

  removePending(key) {
    delete this.state.pending[key];
    this.write();
  }

  putInvalidation(brokerId, record, entryPrice, now = Date.now()) {
    const key = `${brokerId}:${record.payload.exchange}:${record.payload.ticker}`;
    this.state.invalidations[key] = {
      key, brokerId, record, entryPrice,
      guardRequestId: `entry-invalidation-${brokerId}-${record.requestId}`,
      createdAt: now, expiresAt: now + 30 * 60_000,
    };
    this.write();
    return this.state.invalidations[key];
  }

  listInvalidations() {
    return Object.values(this.state.invalidations) as any[];
  }

  removeInvalidation(key) {
    delete this.state.invalidations[key];
    this.write();
  }

  clearInvalidations(record) {
    const suffix = `:${record.payload.exchange}:${record.payload.ticker}`;
    let removed = 0;
    for (const key of Object.keys(this.state.invalidations)) {
      if (!key.endsWith(suffix)) continue;
      delete this.state.invalidations[key];
      removed += 1;
    }
    if (removed) this.write();
    return removed;
  }

  putDeferred(brokerId, record, ttlMs) {
    const key = `${brokerId}:${record.requestId}`;
    this.state.deferred[key] = {
      key, brokerId, record, queuedAt: Date.now(), expiresAt: Date.now() + ttlMs, lastAttemptMarketDate: "",
    };
    this.write();
    return this.state.deferred[key];
  }

  listDeferred() {
    return Object.values(this.state.deferred) as any[];
  }

  markDeferredAttempt(key, marketDate) {
    if (!this.state.deferred[key]) return;
    this.state.deferred[key].lastAttemptMarketDate = marketDate;
    this.write();
  }

  markDeferredFailure(key, error) {
    if (!this.state.deferred[key]) return;
    this.state.deferred[key].lastError = String(error?.message || error);
    this.state.deferred[key].lastFailedAt = new Date().toISOString();
    this.write();
  }

  removeDeferred(key) {
    delete this.state.deferred[key];
    this.write();
  }

  partialExitKey(brokerId, market, symbol, stage) {
    return [brokerId, market, symbol, stage].map((value) => String(value || "").toUpperCase()).join(":");
  }

  partialExitBlocked(brokerId, record) {
    const stage = partialExitStage(record);
    if (!stage) return false;
    return Boolean(this.state.partialExits[this.partialExitKey(brokerId, record.payload.exchange, record.payload.ticker, stage)]);
  }

  reservePartialExit(brokerId, order) {
    if (!order.partialExitStage) return;
    const key = this.partialExitKey(brokerId, order.market, order.symbol, order.partialExitStage);
    this.state.partialExits[key] = { status: "PENDING", orderNo: order.orderNo };
    this.write();
  }

  reconcileTradeStage(brokerId, order) {
    if (order.fullExit && order.status === "FILLED") {
      this.resetPartialExits(brokerId, order.market, order.symbol);
      return;
    }
    if (!order.partialExitStage) return;
    const key = this.partialExitKey(brokerId, order.market, order.symbol, order.partialExitStage);
    if (Number(order.filledQuantity || 0) > 0) this.state.partialExits[key] = { status: "EXECUTED", orderNo: order.orderNo };
    else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) delete this.state.partialExits[key];
    else return;
    this.write();
  }

  resetPartialExits(brokerId, market, symbol) {
    const prefix = this.partialExitKey(brokerId, market, symbol, "");
    for (const key of Object.keys(this.state.partialExits)) {
      if (key.startsWith(prefix)) delete this.state.partialExits[key];
    }
    this.write();
  }

  autoTrading() {
    return this.state.autoTrading === true;
  }

  setAutoTrading(enabled) {
    this.state.autoTrading = enabled;
    this.write();
  }

  write() {
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function csv(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function enabledBrokerIds(env = process.env) {
  const enabled = env.ACCOUNT_EXECUTOR_ENABLED === "true" || env.KIS_CONSUMER_ENABLED === "true";
  if (!enabled) return [];
  return [env.EXECUTOR_KIWOOM_ENABLED === "true" ? "KIWOOM" : "", env.EXECUTOR_KIS_ENABLED !== "false" ? "KIS" : ""].filter(Boolean);
}

function brokerEnvironments(brokerIds, env = process.env) {
  const environments = Object.fromEntries(brokerIds.map((id) => [id, env[`${id}_ENV`] || "mock"]));
  if (Object.values(environments).some((environment) => !["mock", "live"].includes(environment))) throw new Error("계좌 환경은 mock 또는 live여야 합니다.");
  if (Object.values(environments).includes("live") && env.ACCOUNT_LIVE_TRADING !== "true" && env.ACCOUNT_READ_ONLY !== "true") throw new Error("실계좌는 ACCOUNT_LIVE_TRADING=true 또는 ACCOUNT_READ_ONLY=true가 필요합니다.");
  return environments;
}

function readOnlySignalAllowed(record, readOnly) {
  return !readOnly || record.payload?.paper_order_test === true;
}

function accountPortfolioSyncMinutes(env = process.env) {
  const minutes = Number(env.ACCOUNT_PORTFOLIO_SYNC_MINUTES || 1440);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("ACCOUNT_PORTFOLIO_SYNC_MINUTES는 1~1440 범위여야 합니다.");
  return minutes;
}

function accountRiskPolicy(env = process.env) {
  const autoCapitalRatio = Number(env.ACCOUNT_AUTO_CAP_RATIO || 0.10);
  const maxOpenRiskRatio = Number(env.ACCOUNT_MAX_OPEN_RISK_RATIO || 0.015);
  if (!Number.isFinite(autoCapitalRatio) || autoCapitalRatio <= 0 || autoCapitalRatio > 1) {
    throw new Error("ACCOUNT_AUTO_CAP_RATIO는 0 초과 1 이하여야 합니다.");
  }
  if (!Number.isFinite(maxOpenRiskRatio) || maxOpenRiskRatio <= 0 || maxOpenRiskRatio > 1) {
    throw new Error("ACCOUNT_MAX_OPEN_RISK_RATIO는 0 초과 1 이하여야 합니다.");
  }
  return { autoCapitalRatio, maxOpenRiskRatio };
}

function discordMessagePayload(message) {
  return message.embed ? { embeds: [message.embed] } : { content: message.text || String(message) };
}

function orderNeedsResultReport(order) {
  if (order.source !== "USER_SCHEDULED_EXIT" || order.executorReportable !== true || order.status === "ACCEPTED") return false;
  return order.executionReportedStatus !== order.status
    || (order.status === "FILLED" && order.journalReportedStatus !== order.status);
}

function orderNeedsPortfolioSync(order) {
  return ["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(order.status)
    && Number(order.filledQuantity || 0) > Number(order.portfolioSyncedFilledQuantity || 0);
}

function errorReportDue(previousAt, now = Date.now(), cooldownMs = 30 * 60_000) {
  return !Number.isFinite(previousAt) || now - previousAt >= cooldownMs;
}

function liveAutoBuyEligible(record) {
  const payload = record?.payload || {};
  return payload.action === "BUY"
    && ["A", "S"].includes(payload.conviction)
    && payload.daily_trend === "BULL"
    && payload.daily_ema_aligned === true
    && payload.daily_above_200ma === true;
}

function approvedEntryVerdict(record) {
  return record?.outcome?.decision === "ADD_CANDIDATE" ? "PAPER_ADD" : "PAPER_ENTRY";
}

function invalidationExitReason(pending, currentPrice, now = Date.now()) {
  if (Number.isFinite(currentPrice) && currentPrice <= pending.entryPrice * 0.97) return "진입가 대비 3% 이상 하락";
  if (now >= pending.expiresAt) return "진입 무효 확인 30분 초과";
  return "";
}

function momentumExitRecommendation(account, payload) {
  const profitRate = account.positionProfitRate;
  if (!account.hasExistingPosition || account.currentPositionQuantity < 1) return null;
  let label;
  let range;
  if (Number.isFinite(payload.momentum_tp) && payload.price >= payload.momentum_tp) {
    label = "목표가 도달";
    range = [0.4, 0.5];
  } else if (Number.isFinite(profitRate) && profitRate > 0) {
    label = "수익 중";
    range = [0.2, 0.3];
  } else if (Number.isFinite(profitRate) && profitRate < 0) {
    label = "손실 중";
    range = [0.3, 0.5];
  } else if (Number.isFinite(profitRate)) {
    label = "본전";
    range = [0.1, 0.2];
  } else {
    return { label: "수익률 확인 불가", range: null, ratio: null, quantity: 0, profitRate: null };
  }
  const ratio = payload.daily_trend === "BULL" ? range[0]
    : payload.daily_trend === "BEAR" ? range[1] : (range[0] + range[1]) / 2;
  return { label, range, ratio, quantity: Math.floor(account.currentPositionQuantity * ratio), profitRate };
}

function buyApprovalRequiredForBroker(broker, record, autoTrading) {
  if (!autoTrading) return true;
  return broker.environment === "live" && !liveAutoBuyEligible(record);
}

function accountCommand(content, executorName = "") {
  const text = String(content || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["!account", "!account help", "!계좌", "!계좌 도움말"].includes(text)) return "HELP";
  if (["!account status", "!계좌 상태", "주문 실행기 상태 보여줘", "주문 실행기 상태 확인"].includes(text)) return "STATUS";
  if (["!account orders", "!계좌 주문"].includes(text)) return "ORDERS";
  const bangAuto = text.match(/^!(?:account|계좌)\s+(?:auto|자동매매)\s+(on|off|status|켜|꺼|상태)$/);
  if (bangAuto) {
    if (["on", "켜"].includes(bangAuto[1])) return "AUTO_ON";
    if (["off", "꺼"].includes(bangAuto[1])) return "AUTO_OFF";
    return "AUTO_STATUS";
  }

  const compact = text.replace(/\s+/g, "");
  const auto = compact.match(/^(.+?)?자동매매(켜|켜줘|시작|시작해|꺼|꺼줘|중지|중지해|상태)(?:보여줘|알려줘|확인)?$/);
  if (auto) {
    const requestedName = auto[1] || "";
    const ownName = String(executorName || "").toLowerCase().replace(/\s+/g, "").replace(/계좌$/, "");
    if (requestedName && !["내", "현재"].includes(requestedName) && ownName && requestedName !== ownName) return "";
    if (["켜", "켜줘", "시작", "시작해"].includes(auto[2])) return "AUTO_ON";
    if (["꺼", "꺼줘", "중지", "중지해"].includes(auto[2])) return "AUTO_OFF";
    return "AUTO_STATUS";
  }
  const match = compact.match(/^(.+?)?계좌(명령어|도움말|상태|최근주문|주문내역)(?:보여줘|알려줘|확인)?$/);
  if (!match) return "";
  const requestedName = match[1] || "";
  const ownName = String(executorName || "").toLowerCase().replace(/\s+/g, "").replace(/계좌$/, "");
  if (requestedName && !["내", "현재"].includes(requestedName) && ownName && requestedName !== ownName) return "";
  if (["명령어", "도움말"].includes(match[2])) return "HELP";
  if (match[2] === "상태") return "STATUS";
  if (["최근주문", "주문내역"].includes(match[2])) return "ORDERS";
  return "";
}

function accountNumber(value) {
  const match = String(value || "").match(/^(\d{8})(?:-(\d{2}))?$/);
  if (!match) throw new Error("KIS_ACCOUNT_NO는 12345678-01 형식이어야 합니다.");
  return { accountNo: match[1], productCode: match[2] || process.env.KIS_ACCOUNT_PRODUCT_CODE || "01" };
}

function signalExchange(exchange) {
  const value = String(exchange || "").toUpperCase();
  if (["KRX", "KOSPI", "KOSDAQ"].includes(value)) return "KRX";
  if (["NASDAQ", "NASD", "ND"].includes(value)) return "ND";
  if (["NYSE", "NY"].includes(value)) return "NY";
  if (["AMEX", "ARCA", "NYSEARCA", "NA"].includes(value)) return "NA";
  throw new Error(`지원하지 않는 거래소: ${exchange || "없음"}`);
}

function accountSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  return /^A\d{6}$/.test(value) ? value.slice(1) : value;
}

function trackedPortfolio(orders, domesticHoldings, usHoldings, usdExchangeRate = 1) {
  const positions = new Map();
  const marketOf = (market) => String(market || "").toUpperCase() === "KRX" ? "KRX" : "US";
  const keyOf = (market, symbol) => `${marketOf(market)}:${accountSymbol(symbol)}`;
  const ordered = [...orders].sort((a, b) => Number(a.revision || 0) - Number(b.revision || 0));
  for (const order of ordered) {
    const key = keyOf(order.market, order.symbol);
    if (order.fullExit && order.status === "FILLED") positions.delete(key);
    else if (order.entryType && Number(order.filledQuantity || 0) > 0) {
      positions.set(key, { market: marketOf(order.market), symbol: accountSymbol(order.symbol), stopPrice: Number(order.stopPrice) || null });
    }
  }

  let deployedKrw = 0;
  let openRiskKrw = 0;
  let hasUsExposure = false;
  for (const position of positions.values()) {
    const holdings = position.market === "KRX" ? domesticHoldings : usHoldings;
    const held = holdings.filter((holding) => accountSymbol(holding.code) === position.symbol);
    const quantity = held.reduce((sum, holding) => sum + Number(holding.quantity || 0), 0);
    const evaluation = held.reduce((sum, holding) => sum + Number(holding.evaluationAmount || 0), 0);
    if (quantity <= 0 || evaluation <= 0) continue;
    const purchaseAmount = held.reduce((sum, holding) => sum + Number(holding.purchaseAmount || 0), 0);
    const purchasePrice = purchaseAmount > 0 ? purchaseAmount / quantity
      : held.reduce((sum, holding) => sum + Number(holding.purchasePrice || 0) * Number(holding.quantity || 0), 0) / quantity;
    const fx = position.market === "KRX" ? 1 : usdExchangeRate;
    if (position.market === "US") hasUsExposure = true;
    deployedKrw += evaluation * fx;
    openRiskKrw += (position.stopPrice > 0 && purchasePrice > position.stopPrice
      ? quantity * (purchasePrice - position.stopPrice) : evaluation) * fx;
  }

  for (const order of ordered.filter((item) => item.entryType && PENDING_ORDER_STATUSES.has(item.status))) {
    const orderQuantity = Number(order.orderQuantity || 0);
    const remainingRatio = orderQuantity > 0 ? Math.max(0, Number(order.remainingQuantity || 0)) / orderQuantity : 1;
    const fx = marketOf(order.market) === "KRX" ? 1 : usdExchangeRate;
    const remainingInvestment = Number(order.plannedInvestment || 0) * remainingRatio;
    const plannedRisk = Number(order.plannedRisk);
    if (marketOf(order.market) === "US" && remainingRatio > 0) hasUsExposure = true;
    deployedKrw += remainingInvestment * fx;
    openRiskKrw += (Number.isFinite(plannedRisk) && plannedRisk > 0 ? plannedRisk * remainingRatio : remainingInvestment) * fx;
  }
  return { deployedKrw, openRiskKrw, hasUsExposure };
}

async function accountContext(clients, record, maxOpenPositions, options: any = {}) {
  const domesticClient = clients.domesticClient || clients;
  const overseasClient = clients.overseasClient || clients;
  const domestic = await domesticClient.getDomesticBalance();
  const usBalances = overseasClient.getUsBalances
    ? await overseasClient.getUsBalances()
    : [await overseasClient.getUsBalance()];
  const usHoldings = [...new Map(usBalances.flatMap((balance) => balance.holdings).map((holding) => [holding.code, holding])).values()];
  const market = signalExchange(record.payload.exchange);
  const holdings = market === "KRX" ? domestic.holdings : usHoldings;
  const current = holdings.filter((holding) => accountSymbol(holding.code) === accountSymbol(record.payload.ticker));
  const cashResult = market === "KRX"
    ? await domesticClient.getDomesticCash({ symbol: record.payload.ticker, price: record.payload.price })
    : await overseasClient.getUsCash({ exchange: market, symbol: record.payload.ticker, price: record.payload.price });
  const cash = market === "KRX" ? cashResult.orderableAmount : cashResult.usd;
  const evaluation = holdings.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  const policy = options.riskPolicy || null;
  const orders = policy ? options.orders || [] : [];
  const previewPortfolio = policy ? trackedPortfolio(orders, domestic.holdings, usHoldings, 1) : null;
  let usdExchangeRate = Number(cashResult.usdExchangeRate || 0);
  if (policy && (market !== "KRX" || previewPortfolio.hasUsExposure) && usdExchangeRate <= 0) {
    usdExchangeRate = Number(await overseasClient.getUsdExchangeRate());
  }
  if (policy && (market !== "KRX" || previewPortfolio.hasUsExposure) && usdExchangeRate <= 0) throw new Error("USD 환율을 확인할 수 없어 신규매수를 차단합니다.");
  const portfolio = policy ? trackedPortfolio(orders, domestic.holdings, usHoldings, usdExchangeRate || 1) : { deployedKrw: 0, openRiskKrw: 0 };
  const domesticEquity = Number(domestic.estimatedAssets || domestic.totalEvaluation || 0);
  const currencyFactor = market === "KRX" ? 1 : usdExchangeRate || 1;
  const totalAccountEquityKrw = policy ? (domesticEquity > 0 ? domesticEquity : (cash + evaluation) * currencyFactor) : null;
  const totalAccountEquity = policy ? totalAccountEquityKrw / currencyFactor
    : market === "KRX" ? domesticEquity : cash + evaluation;
  const autoCapital = policy ? totalAccountEquity * policy.autoCapitalRatio : null;
  const equity = autoCapital || totalAccountEquity;
  const availableCash = policy
    ? Math.min(cash, Math.max(0, (totalAccountEquityKrw * policy.autoCapitalRatio - portfolio.deployedKrw) / currencyFactor))
    : cash;
  const currentPositionValue = current.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  const currentPositionQuantity = current.reduce((sum, holding) => sum + holding.quantity, 0);
  const purchaseAmount = current.reduce((sum, holding) => sum + (Number(holding.purchaseAmount) || 0), 0);
  const profitLoss = current.reduce((sum, holding) => sum + (Number(holding.profitLoss) || 0), 0);
  const weightedPurchasePrice = current.reduce(
    (sum, holding) => sum + (Number(holding.purchasePrice) || 0) * holding.quantity, 0,
  );
  return {
    equity, availableCash, currency: market === "KRX" ? "KRW" : "USD",
    totalAccountEquity, autoCapital, autoCapitalRatio: policy?.autoCapitalRatio,
    currentOpenRisk: policy ? portfolio.openRiskKrw / currencyFactor : null,
    maxOpenRisk: policy ? autoCapital * policy.maxOpenRiskRatio : null,
    maxOpenRiskRatio: policy?.maxOpenRiskRatio,
    openPositions: domestic.holdings.length + usHoldings.length,
    maxOpenPositions,
    currentPositionValue,
    accountPositionRatio: totalAccountEquity > 0 ? currentPositionValue / totalAccountEquity * 100 : 0,
    currentPositionQuantity,
    hasExistingPosition: current.length > 0,
    positionProfitable: inferPositionProfitable(current, null, record.payload.price),
    averageEntryPrice: purchaseAmount > 0 && currentPositionQuantity > 0
      ? purchaseAmount / currentPositionQuantity
      : weightedPurchasePrice > 0 && currentPositionQuantity > 0 ? weightedPurchasePrice / currentPositionQuantity : null,
    positionProfitRate: purchaseAmount > 0 ? profitLoss / purchaseAmount * 100
      : current.find((holding) => Number.isFinite(holding.profitRate))?.profitRate ?? null,
    currentHoldings: current,
    domesticHoldings: domestic.holdings,
    usHoldings,
  };
}

function enforceOwnAccountRules(record, account, preview) {
  if (!["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict)) return preview;
  if (record.risk.verdict === "PAPER_ENTRY" && account.hasExistingPosition) {
    return { ...preview, blocked: true, quantity: 0, reason: "해당 계좌에 이미 보유 중 — 중복 진입 차단" };
  }
  if (record.risk.verdict === "PAPER_ADD" && (!account.hasExistingPosition || account.positionProfitable !== true)) {
    return { ...preview, blocked: true, quantity: 0, reason: "해당 계좌에 수익 중인 기존 포지션이 없어 추가매수 차단" };
  }
  return preview;
}

function enforceOpenRiskLimit(preview) {
  if (!preview || preview.blocked || preview.capitalOnly) return preview;
  if (preview.currentOpenRisk + preview.stopLossAmount <= preview.maxOpenRisk) return preview;
  return { ...preview, blocked: true, quantity: 0, reason: `동시 손절위험 ${(preview.maxOpenRiskRatio * 100).toFixed(1)}% 한도 초과` };
}

const PYRAMID_RATIOS = [0.5, 0.25];
const PENDING_ORDER_STATUSES = new Set(["ACCEPTED", "CANCEL_REQUESTED", "PARTIALLY_FILLED"]);

function pyramidPlan(orders, record) {
  const market = String(record.payload?.exchange || "").toUpperCase();
  const symbol = String(record.payload?.ticker || "").replace(/^A/, "").toUpperCase();
  let initialEntryQuantity = 0;
  let completedAdds = 0;
  let initialEntryPending = false;

  for (const order of [...orders].sort((a, b) => Number(a.revision || 0) - Number(b.revision || 0))) {
    if (String(order.market || "").toUpperCase() !== market
        || String(order.symbol || "").replace(/^A/, "").toUpperCase() !== symbol) continue;
    const filledQuantity = Number(order.filledQuantity || 0);
    if (order.fullExit && order.status === "FILLED") {
      initialEntryQuantity = 0;
      completedAdds = 0;
      initialEntryPending = false;
    } else if (order.entryType === "PAPER_ENTRY" && filledQuantity > 0) {
      initialEntryQuantity = filledQuantity;
      completedAdds = 0;
      initialEntryPending = PENDING_ORDER_STATUSES.has(order.status);
    } else if (initialEntryQuantity > 0 && order.entryType === "PAPER_ADD") {
      if (PENDING_ORDER_STATUSES.has(order.status)) {
        return { blocked: true, reason: "이전 피라미딩 추가매수 체결 확인 중" };
      }
      if (filledQuantity > 0) completedAdds += 1;
    }
  }

  if (initialEntryQuantity < 1) return { blocked: true, reason: "최초 진입 체결수량 기록 없음 — 피라미딩 차단" };
  if (initialEntryPending) return { blocked: true, reason: "최초 진입 주문 체결 완료 확인 중 — 피라미딩 차단" };
  if (completedAdds >= PYRAMID_RATIOS.length) return { blocked: true, reason: "피라미딩 2차까지 실행 완료" };
  const ratio = PYRAMID_RATIOS[completedAdds];
  const quantity = Math.floor(initialEntryQuantity * ratio);
  if (quantity < 1) return { blocked: true, reason: `최초 진입 ${initialEntryQuantity}주의 피라미딩 ${completedAdds + 1}차 수량이 1주 미만` };
  return { blocked: false, stage: completedAdds + 1, ratio, quantity, initialEntryQuantity };
}

function applyPyramidSizing(record, preview, orders) {
  if (record.risk?.verdict !== "PAPER_ADD" || preview?.blocked) return preview;
  const plan = pyramidPlan(orders, record);
  if (plan.blocked) return { ...preview, blocked: true, quantity: 0, reason: plan.reason };
  const quantity = Math.min(preview.quantity, plan.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) return { ...preview, blocked: true, quantity: 0, reason: "피라미딩 주문수량이 1주 미만" };
  const positionValue = quantity * record.payload.price;
  const projectedPositionValue = preview.currentPositionValue + positionValue;
  return {
    ...preview,
    quantity,
    positionValue,
    projectedPositionValue,
    projectedPositionRatio: projectedPositionValue / preview.equity * 100,
    ...(preview.capitalOnly ? { stopLossAmount: null }
      : Number.isFinite(preview.entryPrice) && Number.isFinite(preview.stopPrice)
        ? { stopLossAmount: quantity * (preview.entryPrice - preview.stopPrice) }
        : Number.isFinite(preview.stopLossAmount) ? { stopLossAmount: preview.stopLossAmount } : {}),
    pyramidStage: plan.stage,
    pyramidRatio: plan.ratio,
    initialEntryQuantity: plan.initialEntryQuantity,
  };
}

async function reconcilePendingBrokerOrders(broker) {
  const changes = [];
  for (const previous of broker.tracker.pending()) {
    const current = await refreshPaperOrder(previous, broker);
    if (["status", "filledQuantity", "remainingQuantity", "fillPrice"].some((key) => current[key] !== previous[key])) {
      changes.push({ previous, current });
    }
  }
  return changes;
}

async function holdingLines(account) {
  const rows = await enrichInstrumentNames([
    ...account.domesticHoldings.map((item) => ({ ...item, exchange: "KRX", ticker: item.code })),
    ...account.usHoldings.map((item) => ({ ...item, exchange: item.exchange, ticker: item.code })),
  ]);
  return rows.length
    ? rows.map((item) => `${formatInstrumentLabel(item)} · ${item.quantity}주`).join("\n")
    : "보유 종목 없음";
}

function approvalText(record, previews, brokerIds = Object.keys(previews)) {
  const lines = Object.values(previews).map(({ label, preview }) => preview.blocked
    ? `**${label}**: 불가 · ${preview.reason}`
    : `**${label}**: ${preview.quantity}주 · 예상 ${preview.currency === "KRW" ? `${Math.round(preview.positionValue).toLocaleString("ko-KR")}원` : `$${preview.positionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} · 주문 후 ${Number.isFinite(preview.autoCapital) ? "자동운용금" : "계좌"} 비중 ${preview.projectedPositionRatio.toFixed(2)}% / 최대 ${preview.positionLimitRatio * 100}%${preview.pyramidStage ? ` · 피라미딩 ${preview.pyramidStage}차(최초 ${preview.initialEntryQuantity}주의 ${preview.pyramidRatio * 100}%)` : ""}`);
  const commands = brokerIds.length === 2
    ? "`사줘`·`둘다` / `키움만` / `한투만` / `안 사`"
    : `${brokerIds[0] === "KIWOOM" ? "`키움만`" : "`한투만`"} / \`안 사\``;
  return [
    "⏳ **BUY 승인 대기**",
    `**종목**: ${formatInstrumentLabel(record.payload)}`,
    ...(Object.values(previews).some(({ preview }) => preview.capitalOnly)
      ? ["⚠️ **PEG 손절가 없음** · 위험금액 계산 불가 · 종목 최대 10% 한도"] : []),
    ...Object.values(previews).filter(({ preview }) => Number.isFinite(preview.autoCapital)).map(({ label, preview }) =>
      `**${label} 실계좌 안전한도**: 계좌 총액 ${preview.currency === "KRW" ? `${Math.round(preview.totalAccountEquity).toLocaleString("ko-KR")}원` : `$${preview.totalAccountEquity.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} · 자동운용 ${(preview.autoCapitalRatio * 100).toFixed(0)}% · 동시 손절위험 최대 ${(preview.maxOpenRiskRatio * 100).toFixed(1)}%`),
    ...lines,
    commands,
  ].join("\n");
}

async function start() {
  const brokerIds = enabledBrokerIds();
  if (!brokerIds.length) throw new Error("ACCOUNT_EXECUTOR_ENABLED=true와 사용할 증권사 설정이 필요합니다.");
  const readOnly = process.env.ACCOUNT_READ_ONLY === "true";
  const environments = brokerEnvironments(brokerIds);
  const sourceChannelIds = csv(process.env.ACCOUNT_SOURCE_CHANNEL_IDS || process.env.KIS_SOURCE_CHANNEL_IDS);
  const sourceBotIds = csv(process.env.ACCOUNT_SOURCE_BOT_IDS || process.env.KIS_SOURCE_BOT_IDS);
  if (!sourceChannelIds.size || !sourceBotIds.size) throw new Error("신뢰할 Discord 원본 채널 ID와 봇 ID가 필요합니다.");
  const executorName = process.env.ACCOUNT_EXECUTOR_NAME || "기본 사용자";
  const accountLabel = executorName.endsWith("계좌") ? executorName : `${executorName} 계좌`;
  const receipts = new SignalReceiptStore(
    process.env.ACCOUNT_SIGNAL_RECEIPT_FILE || process.env.KIS_SIGNAL_RECEIPT_FILE || "account-signal-receipts.json",
    process.env.ACCOUNT_AUTO_TRADING === "true",
  );
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const trusted = { sourceChannelIds, sourceBotIds };
  const targetGuildId = process.env.ACCOUNT_TARGET_GUILD_ID || process.env.KIS_TARGET_GUILD_ID;
  const channels = {
    order: process.env.ACCOUNT_ORDER_CHANNEL || process.env.KIS_ORDER_CHANNEL,
    execution: process.env.ACCOUNT_EXECUTION_CHANNEL || process.env.KIS_EXECUTION_CHANNEL,
    journal: process.env.ACCOUNT_JOURNAL_CHANNEL || process.env.KIS_JOURNAL_CHANNEL,
    portfolio: process.env.ACCOUNT_PORTFOLIO_CHANNEL || process.env.KIS_PORTFOLIO_CHANNEL,
    system: process.env.ACCOUNT_SYSTEM_CHANNEL || process.env.KIS_SYSTEM_CHANNEL,
  };
  const maxAgeMs = Number(process.env.ACCOUNT_SIGNAL_MAX_AGE_MINUTES || process.env.KIS_SIGNAL_MAX_AGE_MINUTES || 30) * 60_000;
  const maxOpenPositions = Number(process.env.MAX_OPEN_POSITIONS || 5);
  const riskPolicy = Object.values(environments).includes("live") ? accountRiskPolicy() : null;
  const ownerId = process.env.EXECUTOR_OWNER_ID || process.env.DISCORD_OWNER_ID;
  if (!ownerId) throw new Error("EXECUTOR_OWNER_ID 또는 DISCORD_OWNER_ID가 필요합니다.");
  const approvalTtlMs = Number(process.env.BUY_APPROVAL_TTL_MINUTES || 30) * 60_000;
  const deferredTtlMs = 5 * 24 * 60 * 60_000;
  const portfolioSyncMinutes = accountPortfolioSyncMinutes();
  const brokers = [];
  const errorReports = new Map();
  if (brokerIds.includes("KIWOOM")) {
    const domesticCredentials = kiwoomCredentials(environments.KIWOOM, "domestic");
    const overseasCredentials = kiwoomCredentials(environments.KIWOOM, "overseas");
    brokers.push({
      id: "KIWOOM", label: "키움", environment: environments.KIWOOM,
      domesticClient: new KiwoomClient({ ...domesticCredentials, environment: environments.KIWOOM, timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      overseasClient: new KiwoomClient({ ...overseasCredentials, environment: environments.KIWOOM, timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      tracker: new OrderTracker(process.env.KIWOOM_ORDER_STATE_FILE || "kiwoom-orders.json"),
    });
  }
  if (brokerIds.includes("KIS")) {
    const credentials = kisCredentials(environments.KIS);
    const account = accountNumber(credentials.accountNo);
    const kis = new KisClient({
      appKey: credentials.appKey,
      appSecret: credentials.appSecret,
      ...account,
      environment: environments.KIS,
      timeoutMs: Number(process.env.KIS_TIMEOUT_MS || 5_000),
    });
    brokers.push({ id: "KIS", label: "한투", environment: environments.KIS, domesticClient: kis, overseasClient: kis, tracker: new OrderTracker(process.env.KIS_ORDER_STATE_FILE || "kis-orders.json") });
  }
  let queue: Promise<any> = Promise.resolve();

  async function targetChannel(configured) {
    const guild = await client.guilds.fetch(targetGuildId);
    const available = await guild.channels.fetch();
    const channel = available.get(configured) || available.find((item) => item?.name === configured);
    if (!channel?.isTextBased()) throw new Error(`Discord 기록 채널을 찾을 수 없습니다: ${configured || "미설정"}`);
    return channel;
  }

  async function send(channelName, message) {
    const channel = await targetChannel(channelName);
    return channel.send(discordMessagePayload(message));
  }

  const brokerAccountLabel = (broker) => `${broker.label} ${broker.environment === "live" ? "실계좌" : "모의계좌"}`;
  const accountSummary = () => brokers.map(brokerAccountLabel).join(" + ");

  async function reportError(title, error, record = null) {
    const reportKey = [title, error?.message || error, record?.payload?.ticker || record?.symbol || ""].join("\n");
    if (!errorReportDue(errorReports.get(reportKey))) return;
    try {
      await send(channels.system, formatExecutorError(title, error, record));
      errorReports.set(reportKey, Date.now());
    } catch (reportingError) {
      console.error(`${title}: ${error.message}; Discord 오류: ${reportingError.message}`);
    }
  }

  async function syncPortfolio() {
    const result = await syncAccountPortfolio(await targetChannel(channels.portfolio), brokers);
    for (const failure of result.failures) {
      await reportError(`${failure.label} 포트폴리오 조회 실패`, failure.reason);
    }
    return result;
  }

  async function previewFor(broker, record) {
    const sizingRecord = structuredClone(record);
    if (sizingRecord.risk?.verdict === "BUY_PENDING_APPROVAL") {
      sizingRecord.risk.verdict = approvedEntryVerdict(sizingRecord);
    }
    const liveRiskPolicy = broker.environment === "live" ? riskPolicy : null;
    const ownAccount = await accountContext(broker, sizingRecord, maxOpenPositions, { orders: broker.tracker.list(), riskPolicy: liveRiskPolicy });
    const sized = applyPyramidSizing(sizingRecord,
      enforceOwnAccountRules(sizingRecord, ownAccount, calculateWebhookPositionPreview(sizingRecord, ownAccount)),
      broker.tracker.list());
    const preview = liveRiskPolicy ? enforceOpenRiskLimit(sized) : sized;
    return { label: broker.label, preview };
  }

  async function withPortfolioMetrics(broker, order) {
    const account = await accountContext(broker, { payload: {
      exchange: order.market, ticker: order.symbol, price: order.fillPrice || order.signalPrice,
    } }, maxOpenPositions);
    return broker.tracker.record({
      ...order,
      accountEquity: account.equity,
      positionValueAfterFill: account.currentPositionValue,
      positionRatio: account.accountPositionRatio,
      currency: account.currency,
    });
  }

  async function reportOrderResult(broker, order) {
    let reported = { ...order, resultAt: order.resultAt || order.updatedAt };
    receipts.reconcileTradeStage(broker.id, reported);
    if (reported.executionReportedStatus !== reported.status) {
      await send(channels.execution, formatOrderStatus(reported));
      reported = broker.tracker.record({ ...reported, executionReportedStatus: reported.status });
    }
    if (reported.status === "FILLED" && reported.journalReportedStatus !== reported.status) {
      await send(channels.journal, formatTradeJournal(reported));
      reported = broker.tracker.record({ ...reported, journalReportedStatus: reported.status });
    }
    return reported;
  }

  async function execute(broker, record) {
    if (!readOnlySignalAllowed(record, readOnly)) return null;
    record.positionPreview = (await previewFor(broker, record)).preview;
    if (record.payload?.paper_order_test === true) {
      await send(channels.order, { text: `✅ **${brokerAccountLabel(broker)} 자동매매 연동 테스트 통과**\n**종목**: ${formatInstrumentLabel(record.payload)}\n계좌 조회 정상 · 주문 생성 없음` });
      return null;
    }
    const stage = partialExitStage(record);
    if (stage && receipts.partialExitBlocked(broker.id, record)) {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "부분청산 중복 차단",
        reason: `${stage}은 현재 포지션에서 이미 실행 또는 주문 대기 중`,
      }));
      return null;
    }
    let order = await submitPaperOrder(record, {
      enabled: true, environment: broker.environment,
      domesticClient: broker.domesticClient, overseasClient: broker.overseasClient,
      tracker: broker.tracker, brokerLabel: brokerAccountLabel(broker),
      partialExit1Ratio: Number(process.env.PARTIAL_EXIT_1_RATIO || 0.25),
      partialExit2Ratio: Number(process.env.PARTIAL_EXIT_2_RATIO || 0.5),
    });
    if (!order || order.status === "BLOCKED") {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 차단",
        reason: order?.reason || record.positionPreview?.reason || "주문 조건 불충족",
      }));
      return null;
    }
    if (order.entryType === "PAPER_ENTRY") receipts.resetPartialExits(broker.id, order.market, order.symbol);
    if (order.partialExitStage) receipts.reservePartialExit(broker.id, order);
    const statusMessage = await send(channels.order, formatOrderStatus(order));
    order = broker.tracker.record({ ...order, statusMessageId: statusMessage.id });
    let final = await trackPaperOrder(order, { domesticClient: broker.domesticClient, overseasClient: broker.overseasClient, tracker: broker.tracker, attempts: 5, delayMs: 2_000 });
    receipts.reconcileTradeStage(broker.id, final);
    if (final.status !== order.status || final.filledQuantity !== order.filledQuantity) {
      if (final.filledQuantity > order.filledQuantity) {
        final = await withPortfolioMetrics(broker, final).catch(async (error) => {
          await reportError(`${broker.label} 체결 비중 조회 실패`, error, record);
          return final;
        });
      }
      final = await reportOrderResult(broker, final);
    }
    if (orderNeedsPortfolioSync(final)) {
      try {
        const synced = await syncPortfolio();
        if (synced.succeededBrokerIds.has(broker.id)) {
          final = broker.tracker.record({ ...final, portfolioSyncedFilledQuantity: final.filledQuantity });
        }
      } catch (error) {
        await reportError("포트폴리오 주문 후 갱신 실패", error);
      }
    }
    return final;
  }

  async function reconcileOrders() {
    let portfolioChanged = false;
    for (const broker of brokers) {
      let changes;
      try {
        changes = await reconcilePendingBrokerOrders(broker);
      } catch (error) {
        await reportError(`${broker.label} 미완료 주문 체결 조회 실패`, error);
        continue;
      }
      for (const { previous, current } of changes) {
        let reported = current;
        if (current.filledQuantity > previous.filledQuantity) {
          try {
            reported = await withPortfolioMetrics(broker, current);
          } catch (error) {
            await reportError(`${broker.label} 체결 비중 조회 실패`, error, { payload: current });
          }
        }
        reported = await reportOrderResult(broker, reported);
        if (orderNeedsPortfolioSync(reported)) portfolioChanged = true;
      }
      for (const order of broker.tracker.list().filter(orderNeedsResultReport)) {
        let reported = order;
        if (order.filledQuantity > 0 && !Number.isFinite(order.positionRatio)) {
          reported = await withPortfolioMetrics(broker, order).catch(async (error) => {
            await reportError(`${broker.label} 체결 비중 조회 실패`, error, { payload: order });
            return order;
          });
        }
        reported = await reportOrderResult(broker, reported);
        if (orderNeedsPortfolioSync(reported)) portfolioChanged = true;
      }
      if (broker.tracker.list().some(orderNeedsPortfolioSync)) portfolioChanged = true;
    }
    if (portfolioChanged) {
      try {
        const synced = await syncPortfolio();
        for (const broker of brokers) {
          if (!synced.succeededBrokerIds.has(broker.id)) continue;
          for (const order of broker.tracker.list().filter(orderNeedsPortfolioSync)) {
            broker.tracker.record({ ...order, portfolioSyncedFilledQuantity: order.filledQuantity });
          }
        }
      } catch (error) {
        await reportError("포트폴리오 체결 후 갱신 실패", error);
      }
    }
    return portfolioChanged;
  }

  async function executeOrDefer(broker, record, { retry = false } = {}) {
    if (!readOnlySignalAllowed(record, readOnly)) return null;
    if (!retry && shouldDelayEntry(record)) {
      receipts.putDeferred(broker.id, record, deferredTtlMs);
      await send(channels.order, formatDeferredBuy(record, broker.label, broker.environment));
      return null;
    }
    try {
      return await execute(broker, record);
    } catch (error) {
      if (shouldDeferEntry(record, error)) {
        if (!retry) {
          receipts.putDeferred(broker.id, record, deferredTtlMs);
          await send(channels.order, formatDeferredBuy(record, broker.label, broker.environment));
        }
        return null;
      }
      const action = record.payload.action === "BUY" ? "매수" : "매도";
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 실패",
        reason: "계좌 조회 또는 주문 요청 실패",
      }));
      await reportError(`${broker.label} 자동 ${action} 실패`, error, record);
      return null;
    }
  }

  async function retryDeferred(now = new Date()) {
    for (const deferred of receipts.listDeferred()) {
      if (deferred.expiresAt <= now.getTime()) {
        receipts.removeDeferred(deferred.key);
        await send(channels.order, { text: `⌛ **매수 예약 만료**\n${formatInstrumentLabel(deferred.record.payload)}` });
        continue;
      }
      const record = structuredClone(deferred.record);
      if (shouldDelayEntry(record, now)) continue;
      const domestic = record.payload.exchange === "KRX";
      const clock = domestic ? domesticSessionClock(now) : usSessionClock(now);
      const attemptKey = `${clock.date}:${domestic ? domesticSession(now) : usSession(now)}`;
      if (deferred.lastAttemptMarketDate === attemptKey) continue;
      receipts.markDeferredAttempt(deferred.key, attemptKey);
      const broker = brokers.find((item) => item.id === deferred.brokerId);
      if (!broker) {
        receipts.removeDeferred(deferred.key);
        continue;
      }
      try {
        const quoteClient = domestic ? broker.domesticClient : broker.overseasClient;
        if (domestic && quoteClient?.getDomesticQuote) {
          const quote = await quoteClient.getDomesticQuote({ symbol: record.payload.ticker });
          record.payload.price = quote.currentPrice;
          if (quote.name) record.payload.name = quote.name;
        } else if (quoteClient) {
          const quote = await quoteClient.getUsQuote({ exchange: signalExchange(record.payload.exchange), symbol: record.payload.ticker });
          record.payload.price = quote.currentPrice;
          if (quote.name) record.payload.name = quote.name;
        }
        await execute(broker, record);
        receipts.removeDeferred(deferred.key);
      } catch (error) {
        if (shouldDeferEntry(record, error)) continue;
        receipts.markDeferredFailure(deferred.key, error);
        await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
          title: "예약 매수 실패",
          reason: "계좌 조회 또는 주문 요청 실패",
        }));
        await reportError(`${broker.label} 예약 매수 재시도 실패`, error, record);
      }
    }
  }

  async function currentSignalPrice(broker, payload) {
    if (signalExchange(payload.exchange) === "KRX") {
      return (await broker.domesticClient.getDomesticQuote({ symbol: payload.ticker })).currentPrice;
    }
    return (await broker.overseasClient.getUsQuote({
      exchange: signalExchange(payload.exchange), symbol: payload.ticker,
    })).currentPrice;
  }

  async function checkInvalidations(now = new Date()) {
    if (!receipts.autoTrading()) return;
    for (const pending of receipts.listInvalidations()) {
      const broker = brokers.find((item) => item.id === pending.brokerId);
      if (!broker) {
        receipts.removeInvalidation(pending.key);
        continue;
      }
      let currentPrice = null;
      let reason = invalidationExitReason(pending, currentPrice, now.getTime());
      if (!reason) {
        try {
          currentPrice = await currentSignalPrice(broker, pending.record.payload);
          reason = invalidationExitReason(pending, currentPrice, now.getTime());
        } catch (error) {
          await reportError(`${broker.label} 진입 무효 가격 조회 실패`, error, pending.record);
          continue;
        }
      }
      if (!reason) continue;
      const account = await accountContext(broker, pending.record, maxOpenPositions);
      if (!account.hasExistingPosition) {
        receipts.removeInvalidation(pending.key);
        continue;
      }
      const record = structuredClone(pending.record);
      record.requestId = pending.guardRequestId;
      record.receivedAt = now.toISOString();
      record.source = "ENTRY_INVALIDATION_GUARD";
      record.payload.action = "SELL";
      record.payload.type = reason;
      if (Number.isFinite(currentPrice)) record.payload.price = currentPrice;
      record.outcome = { decision: "EXIT_IF_FILLED", signal: { signalCode: "ENTRY_INVALIDATION_GUARD" } };
      record.risk = { verdict: "PAPER_EXIT", reason };
      const order = await executeOrDefer(broker, record);
      if (order || broker.tracker.list().some((item) => item.requestId === pending.guardRequestId)) {
        receipts.removeInvalidation(pending.key);
      }
    }
  }

  async function processLifecycle(record) {
    if (record.risk?.verdict === "WAIT") {
      let stored = 0;
      for (const broker of brokers) {
        const account = await accountContext(broker, record, maxOpenPositions);
        if (!account.hasExistingPosition) continue;
        const entryPrice = account.averageEntryPrice || record.outcome?.state?.entrySignalPrice || record.payload.price;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
        receipts.putInvalidation(broker.id, record, entryPrice);
        stored += 1;
      }
      await send(channels.system, { text: stored
        ? `⏳ **진입 무효 감시 시작**\n**종목**: ${formatInstrumentLabel(record.payload)}\n30초 간격 -3% 감시 · 확인/만료 대기 · 30분 초과 시 전량청산`
        : `ℹ️ **진입 무효 수신**\n**종목**: ${formatInstrumentLabel(record.payload)}\n보유 계좌가 없어 감시를 시작하지 않았습니다.` });
      return true;
    }
    if (record.risk?.verdict === "KEEP") {
      receipts.clearInvalidations(record);
      await send(channels.system, { text: `✅ **진입 확정**\n**종목**: ${formatInstrumentLabel(record.payload)}\n진입 무효 감시를 해제하고 보유를 유지합니다.` });
      return true;
    }
    if (record.risk?.verdict === "REVIEW_PARTIAL_EXIT") {
      for (const broker of brokers) {
        const account = await accountContext(broker, record, maxOpenPositions);
        const advice = momentumExitRecommendation(account, record.payload);
        const range = advice?.range ? `${advice.range[0] * 100}~${advice.range[1] * 100}%` : "판단 보류";
        const suggested = advice?.ratio === null || !advice ? "수익률 확인 필요"
          : `${advice.ratio * 100}% · ${advice.quantity}주`;
        await send(channels.order, { text: [
          `📉 **${brokerAccountLabel(broker)} 상승 모멘텀 종료 검토**`,
          `**종목**: ${formatInstrumentLabel(record.payload)}`,
          `**현재 상태**: ${advice?.label || "보유 없음"}${Number.isFinite(advice?.profitRate) ? ` · ${advice.profitRate.toFixed(2)}%` : ""}`,
          `**MD 권장 범위**: ${range}`,
          `**일봉 반영 제안**: ${suggested}`,
          "자동 주문은 생성하지 않습니다.",
        ].join("\n") });
      }
      return true;
    }
    if (record.risk?.verdict === "PAPER_EXIT" && record.outcome?.decision === "EXIT_IF_FILLED") {
      receipts.clearInvalidations(record);
    }
    return false;
  }

  async function processApproval(message) {
    if (message.author.bot || message.author.id !== ownerId) return false;
    const approvalChannel = channels.order;
    if (message.channelId !== approvalChannel && message.channel?.name !== approvalChannel) return false;
    const command = parseBuyApprovalCommand(message.content);
    if (!command.matched) return false;
    if (readOnly) {
      await message.reply("읽기 전용 계좌 점검 중이므로 주문 승인을 실행하지 않습니다.");
      return true;
    }
    if (command.ambiguous) {
      await message.reply("계좌 선택이 애매합니다. `둘다`, `키움만`, `한투만`, `안 사` 중 하나로 말해 주세요.");
      return true;
    }
    const pending = receipts.findPending({ ticker: command.ticker, messageId: message.reference?.messageId || "" })
      || (!command.ticker && !message.reference?.messageId ? receipts.findPending() : null);
    if (!pending) {
      await message.reply("승인할 BUY가 하나로 특정되지 않습니다. 승인 대기 메시지에 답장하거나 종목코드를 함께 적어 주세요.");
      return true;
    }
    if (command.action === "CANCEL") {
      receipts.removePending(pending.key);
      await send(channels.execution, formatUncreatedOrder(accountSummary(), pending.record, {
        title: "사용자 BUY 승인 거부",
        reason: "사용자가 BUY 승인을 거부했습니다.",
      }));
      await message.reply(`BUY 승인을 거부했습니다: ${formatInstrumentLabel(pending.record.payload)}`);
      return true;
    }
    const allowedBrokerIds = pending.brokerIds || command.brokers;
    const selected = brokers.filter((broker) => command.brokers.includes(broker.id) && allowedBrokerIds.includes(broker.id));
    if (!selected.length) {
      await message.reply("선택한 증권사 실행기가 연결되어 있지 않습니다.");
      return true;
    }
    receipts.removePending(pending.key);
    for (const broker of selected) {
      try {
        const approved = structuredClone(pending.record);
        if (approved.risk?.verdict === "BUY_PENDING_APPROVAL") {
          approved.risk = { verdict: approvedEntryVerdict(approved), reason: "사용자 BUY 승인" };
        }
        await executeOrDefer(broker, approved);
      } catch (error) {
        await reportError(`${broker.label} 승인 주문 실패`, error, pending.record);
      }
    }
    return true;
  }

  async function processMessage(message) {
    if (!shouldConsumeMessage(message, trusted)) return;
    const record = decodeSignalEmbed(message.embeds?.[0]);
    if (!record) return;
    if (!readOnlySignalAllowed(record, readOnly)) return;
    if (Date.now() - new Date(record.receivedAt).getTime() > maxAgeMs) return;
    if (!receipts.claim(record.requestId, message.id)) return;

    try {
      record.source = "DISCORD_SIGNAL";
      [record.payload] = await enrichInstrumentNames([record.payload]);
      if (await processLifecycle(record)) return;
      const pendingApproval = record.risk?.verdict === "BUY_PENDING_APPROVAL";
      const entry = (pendingApproval || ["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict)) && record.payload.action === "BUY";
      const approvalBrokers = pendingApproval ? brokers
        : entry ? brokers.filter((broker) => buyApprovalRequiredForBroker(broker, record, receipts.autoTrading())) : [];
      if (approvalBrokers.length) {
        const previews = Object.fromEntries(await Promise.all(approvalBrokers.map(async (broker) => [broker.id, await previewFor(broker, structuredClone(record))])));
        const channel = await targetChannel(channels.order);
        const brokerIds = approvalBrokers.map((broker) => broker.id);
        const approval = await channel.send(approvalText(record, previews, brokerIds));
        receipts.putPending(record, approval.id, approvalTtlMs, brokerIds);
      }
      if (!entry && !receipts.autoTrading()) {
        await send(channels.system, { text: `⏸️ **${accountLabel} 자동매매 OFF**\n**종목**: ${formatInstrumentLabel(record.payload)}\n신호는 수신했지만 주문하지 않았습니다.` });
        return;
      }
      for (const broker of brokers.filter((item) => !approvalBrokers.includes(item))) {
        try {
          await executeOrDefer(broker, structuredClone(record));
        } catch (error) {
          await reportError(`${broker.label} 자동 주문 실패`, error, record);
        }
      }
    } catch (error) {
      await reportError(`${accountLabel} 주문 실행기 처리 실패`, error, record);
    }
  }

  async function processOwnerCommand(message) {
    if (message.author.bot || message.author.id !== ownerId) return false;
    if (![channels.system, channels.order].includes(message.channelId) && ![channels.system, channels.order].includes(message.channel?.name)) return false;
    const command = accountCommand(message.content, executorName);
    if (!command) return false;
    if (command === "HELP") {
      await message.reply(["🧾 **계좌 주문 실행기 명령어**", "`!account status`", "`!account orders`", "`!account auto on` / `!account auto off` / `!account auto status`", "수동 BUY 승인: `사줘`·`둘다` / `키움만` / `한투만` / `안 사`"].join("\n"));
    } else if (command === "STATUS") {
      await message.reply([`🧭 **${accountLabel} 주문 실행기 상태**`, `증권사: ${accountSummary()}`, `신뢰 채널: ${sourceChannelIds.size}개`, `자동매매: ${receipts.autoTrading() ? "ON" : "OFF"}`, `실계좌: ${brokers.some((broker) => broker.environment === "live") ? "활성 · 강한 BUY 자동, 축소 BUY 승인" : "지원 · 현재 잠금"}`].join("\n"));
    } else if (["AUTO_ON", "AUTO_OFF", "AUTO_STATUS"].includes(command)) {
      if (readOnly) {
        await message.reply("🔒 **읽기 전용 계좌 점검 모드**\n자동매매 설정을 바꾸지 않으며 주문 없는 종단간 테스트만 처리합니다.");
        return true;
      }
      if (command !== "AUTO_STATUS") receipts.setAutoTrading(command === "AUTO_ON");
      await message.reply(`🤖 **${accountLabel} 자동매매 ${receipts.autoTrading() ? "ON" : "OFF"}**\n${receipts.autoTrading() ? "모의계좌는 BUY를 자동 주문하고, 실계좌는 강한 BUY만 자동·축소 BUY는 승인 후 주문합니다." : "신호는 수신하지만 자동 주문하지 않습니다."}\n실계좌 기능은 지원하며 현재 계좌 설정의 잠금 상태를 따릅니다.`);
    } else {
      const orders = brokers.flatMap((broker) => broker.tracker.list().slice(0, 5).map((order) => `${broker.label} · ${order.name || order.symbol} (${order.symbol}) · ${order.side} · ${order.status}`)).slice(0, 10);
      await message.reply(["📋 **계좌별 최근 주문**", ...(orders.length ? orders : ["저장된 주문 없음"])].join("\n"));
    }
    return true;
  }

  client.on("messageCreate", (message) => {
    queue = queue.then(async () => {
      if (await processOwnerCommand(message)) return;
      if (await processApproval(message)) return;
      await processMessage(message);
    }).catch((error) => reportError("Discord 메시지 처리 실패", error));
  });
  client.once("clientReady", async () => {
    console.log([
      `\n✅ ${accountLabel} 주문 실행기 준비 완료`,
      `Discord: ${client.user.tag}`,
      `계좌: ${accountSummary()} · 실계좌 기능 지원`,
      `수신: 매매신호 채널 ${sourceChannelIds.size}개`,
      `처리: ${readOnly ? "읽기 전용 · 주문 없는 테스트만" : `공통 신호 → 계좌별 수량 계산 → ${receipts.autoTrading() ? "자동 주문" : "BUY 승인"}`}`,
    ].join("\n"));
    await send(channels.system, { text: formatBrokerStartup(
      `${accountLabel} 주문 실행기`,
      client.user.tag,
      `${accountSummary()} · 신뢰 채널 ${sourceChannelIds.size}개 · ${readOnly ? "읽기 전용" : `자동매매 ${receipts.autoTrading() ? "ON" : "OFF"}`}`,
      readOnly ? "주문 잠금 · 주문 없는 종단간 테스트만 허용" : brokers.some((broker) => broker.environment === "live") ? "실계좌 활성 · 강한 BUY 자동, 축소 BUY 승인" : "실계좌 지원 · 현재 잠금",
    ) });
    const reconciled = readOnly ? false : await reconcileOrders().catch(async (error) => {
      await reportError("미완료 주문 시작 조회 실패", error);
      return false;
    });
    if (!reconciled) await syncPortfolio().catch((error) => reportError("포트폴리오 시작 갱신 실패", error));
    setInterval(() => {
      queue = queue.then(() => syncPortfolio()).catch((error) => reportError("포트폴리오 일일 갱신 실패", error));
    }, portfolioSyncMinutes * 60_000).unref();
    for (const channelId of sourceChannelIds) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;
      const recent = [...(await channel.messages.fetch({ limit: 50 })).values()].reverse();
      for (const message of recent) queue = queue.then(() => processMessage(message));
    }
    if (!readOnly) {
      setInterval(() => {
        queue = queue.then(() => retryDeferred()).catch((error) => reportError("미국 예약 주문 재시도 실패", error));
      }, 15_000).unref();
      setInterval(() => {
        queue = queue
          .then(() => checkInvalidations())
          .then(() => reconcileOrders())
          .catch((error) => reportError("진입 무효 감시 또는 미완료 주문 체결 조회 실패", error));
      }, 30_000).unref();
    }
  });
  await client.login(process.env.ACCOUNT_DISCORD_TOKEN || process.env.KIS_DISCORD_TOKEN || process.env.DISCORD_TOKEN_DRUCKENMILLER);
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { SignalReceiptStore, accountCommand, accountContext, accountPortfolioSyncMinutes, accountRiskPolicy, accountSymbol, applyPyramidSizing, approvalText, approvedEntryVerdict, brokerEnvironments, buyApprovalRequiredForBroker, discordMessagePayload, enabledBrokerIds, enforceOpenRiskLimit, enforceOwnAccountRules, errorReportDue, invalidationExitReason, liveAutoBuyEligible, momentumExitRecommendation, orderNeedsPortfolioSync, orderNeedsResultReport, pyramidPlan, readOnlySignalAllowed, reconcilePendingBrokerOrders, shouldConsumeMessage, signalExchange, start, trackedPortfolio };
