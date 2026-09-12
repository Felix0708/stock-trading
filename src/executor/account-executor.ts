"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { Client, GatewayIntentBits } = require("discord.js");
const { syncAccountPortfolio, strategyComparison, formatStrategyComparisonMessage } = require("./account-portfolio");
const { writeAccountHealth } = require("./account-health");
const { evidenceFile, readEvidence, writeEvidence, collectBrokerEvidence, applyEvidence, validateStatement, reconciliationPlan, koreanDate, refreshAccountEquity, equityAccountRef, equityScopes } = require("./account-evidence");
const { equityPerformance, importCashFlows } = require("./equity-performance");
const { brokerStop, protectionReadiness, currentProtection, ensureProtection, releaseProtection } = require("./broker-protection");
const { formatLifecycleCard } = require("./signal-lifecycle");
const { calendarNotices } = require("../trading/market-calendar");
const { parseBuyApprovalCommand } = require("./buy-approval");
const { decodeSignalEmbed } = require("../discord/discord-signal-envelope");
const { KiwoomClient, kiwoomCredentials } = require("../brokers/kiwoom-client");
const { KisClient, kisCredentials } = require("../brokers/kis-client");
const { enrichInstrumentNames, formatInstrumentLabel } = require("../research/instrument-names");
const { stockBriefingSyncReady, syncStockBriefingHoldings, syncStockBriefingEquity } = require("../integrations/stock-briefing");
const { OrderTracker } = require("../trading/order-tracker");
const { normalizedSymbol, normalizedTimeframe, sameTimeframe, emergencyExit, managedPosition, scopePositionPreview, restoreOrderSignalMetadata, orderTime } = require("../trading/position-ownership");

const { POLICY_VERSION, policyFingerprint, assertLivePolicy } = require("../trading/policy-study");
const {
  domesticSession,
  domesticSessionClock,
  isUsMarketClosedError,
  partialExitStage,
  protectedUsBuyLimit,
  refreshPaperOrder,
  shouldDeferOrder,
  shouldDelayOrder,
  submitPaperOrder,
  trackPaperOrder,
  usSession,
  usSessionClock,
} = require("../trading/paper-order-executor");
const { calculateWebhookPositionPreview, inferPositionProfitable, isDailyTimeframe } = require("../trading/position-sizer");
const { formatBrokerStartup, formatExecutorError, formatOrderStatus, formatTradeJournal, formatUncreatedOrder } = require("../discord/order-discord");

const VERIFICATION_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MARKET_TRANSITION_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

function verificationDelayMs(attempts) {
  return VERIFICATION_RETRY_DELAYS_MS[Math.min(Math.max(Number(attempts) - 1, 0), VERIFICATION_RETRY_DELAYS_MS.length - 1)];
}

function marketTransitionRetryDelayMs(attempts) {
  return MARKET_TRANSITION_RETRY_DELAYS_MS[Math.min(Math.max(Number(attempts) - 1, 0), MARKET_TRANSITION_RETRY_DELAYS_MS.length - 1)];
}

function orderAttemptKey(record, now = new Date()) {
  const domestic = record?.payload?.exchange === "KRX";
  const clock = domestic ? domesticSessionClock(now) : usSessionClock(now);
  return `${clock.date}:${domestic ? domesticSession(now) : usSession(now)}`;
}

function shouldRetryMarketTransition(record, error, now = new Date(), account = {}) {
  return record?.payload?.exchange !== "KRX"
    && !shouldDelayOrder(record, now, account)
    && shouldDeferOrder(record, error)
    && isUsMarketClosedError(error);
}

function deferredOrderAttemptDue(deferred, attemptKey, now = Date.now()) {
  if (deferred?.orderRetrySessionKey === attemptKey) {
    return deferred.nextAttemptAt === Number.MAX_SAFE_INTEGER
      || Number(deferred.nextAttemptAt || 0) <= now;
  }
  return deferred?.lastAttemptMarketDate !== attemptKey;
}

function requiresExistingPosition(record) {
  return record?.risk?.verdict === "PAPER_ADD"
    || (record?.payload?.action === "SELL" && ["PAPER_EXIT", "PAPER_PARTIAL_EXIT"].includes(record?.risk?.verdict));
}

function skippedNoPosition(record, preview) {
  return requiresExistingPosition(record) && preview?.hasExistingPosition !== true
    ? { status: "SKIPPED_NO_POSITION", reason: "해당 계좌 미보유" }
    : null;
}

function skippedExistingEntry(record, preview) {
  return record?.risk?.verdict === "PAPER_ENTRY" && preview?.hasExistingPosition === true
    ? { status: "SKIPPED_EXISTING_POSITION", reason: "해당 계좌 보유 확인 — 추가 주문 없음" }
    : null;
}

function executionPreview(record, account, calculated) {
  if (calculated || !requiresExistingPosition(record)) return calculated;
  return {
    ...account,
    blocked: false,
    quantity: account.currentPositionQuantity || 0,
  };
}

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
    this.state.inbox ||= {};
    this.state.attempts ||= {};
    this.state.exits ||= {};
    this.state.signals ||= {};
    this.state.autoTrading ??= defaultAutoTrading;
    for (const deferred of Object.values(this.state.deferred) as any[]) {
      deferred.kind ||= "ORDER";
      deferred.verificationAttempts ||= 0;
      deferred.orderRetryAttempts ||= 0;
      deferred.orderRetrySessionKey ||= "";
      deferred.nextAttemptAt ??= deferred.queuedAt || 0;
    }
    if (this.coalesceDeferredEntries()) this.write();
  }

  claim(requestId, messageId, persist = true) {
    if (!requestId || !messageId || this.state.requestIds.includes(requestId) || this.state.messageIds.includes(messageId)) return false;
    this.state.requestIds.push(requestId);
    this.state.messageIds.push(messageId);
    if (persist) this.write();
    return true;
  }

  receive(record, messageId, maxAgeMs = 30 * 60_000) {
    if (this.state.inbox[record.requestId]) return this.state.inbox[record.requestId];
    if (!this.claim(record.requestId, messageId, false)) return null;
    // claim과 작업 저장은 같은 원자적 파일 교체로 처리합니다.
    this.state.inbox[record.requestId] = { record, completed: [], expiresAt: new Date(record.receivedAt).getTime() + maxAgeMs };
    this.signal(record);
    this.write();
    return this.state.inbox[record.requestId];
  }

  signal(record, brokerId = "", result = null) {
    // ponytail: per-account JSON ledger; archive closed signal cards if file rewrite latency grows.
    const entry = this.state.signals[record.requestId] ||= { record: {
      requestId: record.requestId, receivedAt: record.receivedAt,
      payload: Object.fromEntries(["ticker", "exchange", "action", "timeframe", "name", "koreanName", "englishName", "price", "sl", "conviction", "sb_z_score"].map(key => [key, record.payload?.[key]])),
      outcome: { signal: record.outcome?.signal }, risk: record.risk, policyVersion: record.policyVersion || POLICY_VERSION,
    }, progress: {}, messageId: "" };
    for (const key of ["name", "koreanName", "englishName"]) if (record.payload?.[key]) entry.record.payload[key] = record.payload[key];
    if (brokerId && result) entry.progress[brokerId] = { status: result.status, reason: result.reason || "", updatedAt: Date.now() };
    this.write();
    return entry;
  }

  completeBroker(item, brokerId) {
    if (!item.completed.includes(brokerId)) item.completed.push(brokerId);
    this.write();
  }

  supersededEntry(brokerId, record) {
    const key = `${brokerId}:${record.payload.exchange}:${record.payload.ticker}`;
    const exitedAt = Math.max(Number(this.state.exits[`${key}:${normalizedTimeframe(record.payload.timeframe)}`] || 0), Number(this.state.exits[`${key}:ALL`] || 0), Number(this.state.exits[key] || 0));
    return record.payload.action === "BUY" && exitedAt >= new Date(record.receivedAt).getTime();
  }

  rememberExit(brokerId, record) {
    if (record.payload.action !== "SELL" || !["PAPER_EXIT", "PAPER_PARTIAL_EXIT"].includes(record.risk?.verdict)) return;
    const key = `${brokerId}:${record.payload.exchange}:${record.payload.ticker}:${emergencyExit(record) ? "ALL" : normalizedTimeframe(record.payload.timeframe)}`;
    this.state.exits[key] = Math.max(this.state.exits[key] || 0, new Date(record.receivedAt).getTime());
    for (const deferred of this.listDeferred()) {
      if (deferred.brokerId === brokerId && this.supersededEntry(brokerId, deferred.record)) {
        this.signal(deferred.record, brokerId, { status: "CANCELLED", reason: "이후 청산 신호로 진입 예약 취소" });
        delete this.state.deferred[deferred.key];
      }
    }
    for (const pending of Object.values(this.state.pending) as any[]) {
      if (!this.supersededEntry(brokerId, pending.record)) continue;
      this.signal(pending.record, brokerId, { status: "CANCELLED", reason: "이후 청산 신호로 승인 대기 취소" });
      pending.brokerIds = (pending.brokerIds || []).filter(id => id !== brokerId);
      if (!pending.brokerIds.length) delete this.state.pending[pending.key];
    }
    this.write();
  }

  attempt(brokerId, record, status = "") {
    const key = `${brokerId}:${record.requestId}`;
    if (status) {
      this.state.attempts[key] = { status, market: record.payload.exchange, symbol: record.payload.ticker };
      this.write();
    }
    return this.state.attempts[key];
  }

  putPending(record, messageId, ttlMs, brokerIds) {
    const existing: any = Object.values(this.state.pending).find((item: any) => item.record.requestId === record.requestId);
    const key = existing?.key || record.requestId;
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
    const key = `${brokerId}:${record.payload.exchange}:${record.payload.ticker}:${normalizedTimeframe(record.payload.timeframe)}`;
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
    let removed = 0;
    for (const key of Object.keys(this.state.invalidations)) {
      const pending = this.state.invalidations[key];
      if (pending.record?.payload?.exchange !== record.payload.exchange || pending.record?.payload?.ticker !== record.payload.ticker) continue;
      if (!emergencyExit(record) && !sameTimeframe(pending.record?.payload?.timeframe, record.payload.timeframe)) continue;
      delete this.state.invalidations[key];
      removed += 1;
    }
    if (removed) this.write();
    return removed;
  }

  putDeferred(brokerId, record, ttlMs, { kind = "ORDER", now = Date.now() } = {}) {
    const same = this.state.deferred[`${brokerId}:${record.requestId}`];
    if (same) return same;
    const existing = kind === "ORDER" ? this.findDeferredEntry(brokerId, record) : null;
    if (existing) return existing;
    const key = `${brokerId}:${record.requestId}`;
    this.state.deferred[key] = {
      key, brokerId, record, kind, queuedAt: now, expiresAt: now + ttlMs,
      lastAttemptMarketDate: "", verificationAttempts: 0,
      orderRetryAttempts: 0, orderRetrySessionKey: "", nextAttemptAt: now,
    };
    this.write();
    return this.state.deferred[key];
  }

  listDeferred() {
    return Object.values(this.state.deferred) as any[];
  }

  deferredEntryKey(brokerId, record) {
    if (record?.risk?.verdict !== "PAPER_ENTRY") return "";
    return [brokerId, record.payload?.exchange, record.payload?.ticker]
      .map((value) => String(value || "").toUpperCase()).join(":");
  }

  findDeferredEntry(brokerId, record) {
    const entryKey = this.deferredEntryKey(brokerId, record);
    return entryKey ? this.listDeferred().find((item) => item.kind === "ORDER"
      && this.deferredEntryKey(item.brokerId, item.record) === entryKey) : null;
  }

  coalesceDeferredEntries() {
    const seen = new Set();
    let removed = 0;
    for (const deferred of this.listDeferred().sort((a, b) => Number(a.queuedAt || 0) - Number(b.queuedAt || 0))) {
      const entryKey = this.deferredEntryKey(deferred.brokerId, deferred.record);
      if (!entryKey || deferred.kind !== "ORDER") continue;
      if (!seen.has(entryKey)) {
        seen.add(entryKey);
        continue;
      }
      delete this.state.deferred[deferred.key];
      removed += 1;
    }
    return removed;
  }

  markDeferredAttempt(key, marketDate) {
    const deferred = this.state.deferred[key];
    if (!deferred) return;
    if (deferred.orderRetrySessionKey && deferred.orderRetrySessionKey !== marketDate) {
      deferred.orderRetryAttempts = 0;
      deferred.orderRetrySessionKey = "";
      deferred.nextAttemptAt = Date.now();
    }
    deferred.lastAttemptMarketDate = marketDate;
    this.write();
  }

  markDeferredFailure(key, error) {
    if (!this.state.deferred[key]) return;
    this.state.deferred[key].lastError = String(error?.message || error);
    this.state.deferred[key].lastFailedAt = new Date().toISOString();
    this.write();
  }

  markVerificationFailure(key, error, now = Date.now()) {
    const deferred = this.state.deferred[key];
    if (!deferred) return null;
    deferred.kind = "VERIFY";
    deferred.verificationAttempts = Number(deferred.verificationAttempts || 0) + 1;
    deferred.nextAttemptAt = now + verificationDelayMs(deferred.verificationAttempts);
    deferred.lastError = String(error?.message || error);
    deferred.lastFailedAt = new Date(now).toISOString();
    this.write();
    return deferred;
  }

  markMarketTransitionFailure(key, attemptKey, error, now = Date.now()) {
    const deferred = this.state.deferred[key];
    if (!deferred) return null;
    if (deferred.orderRetrySessionKey !== attemptKey) deferred.orderRetryAttempts = 0;
    deferred.kind = "ORDER";
    deferred.orderRetrySessionKey = attemptKey;
    deferred.orderRetryAttempts = Number(deferred.orderRetryAttempts || 0) + 1;
    deferred.lastAttemptMarketDate = attemptKey;
    const delay = marketTransitionRetryDelayMs(deferred.orderRetryAttempts);
    deferred.nextAttemptAt = delay === null ? Number.MAX_SAFE_INTEGER : now + delay;
    deferred.lastError = String(error?.message || error);
    deferred.lastFailedAt = new Date(now).toISOString();
    this.write();
    return deferred;
  }

  markDeferredOrder(key, marketDate = "") {
    const deferred = this.state.deferred[key];
    if (!deferred) return;
    deferred.kind = "ORDER";
    deferred.lastAttemptMarketDate = marketDate;
    deferred.orderRetryAttempts = 0;
    deferred.orderRetrySessionKey = "";
    deferred.nextAttemptAt = Date.now();
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
    if (order.fullExit && order.status === "FILLED" && Number(order.filledQuantity) >= Number(order.preTradeManagedQuantity ?? order.preTradePositionQuantity ?? order.filledQuantity)) {
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
    const fd = fs.openSync(temporary, "w", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(this.state, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(require("node:path").dirname(this.file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
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
  if (order.executorReportable !== true || (order.status === "ACCEPTED" && !brokerStop(order))) return false;
  return order.executionReportedStatus !== order.status
    || (order.status === "PARTIALLY_FILLED" && order.executionReportedFilledQuantity !== order.filledQuantity)
    || (order.status === "FILLED" && order.journalReportedStatus !== order.status);
}

function orderNeedsPortfolioSync(order) {
  return ["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(order.status)
    && Number(order.filledQuantity || 0) > Number(order.portfolioSyncedFilledQuantity || 0);
}

function errorReportDue(previousAt, now = Date.now(), cooldownMs = 30 * 60_000) {
  return !Number.isFinite(previousAt) || now - previousAt >= cooldownMs;
}

function orderStatusUnknown(error) {
  return error?.orderStatusUnknown === true;
}

function liveAutoBuyEligible(record) {
  const payload = record?.payload || {};
  return payload.action === "BUY"
    && normalizedTimeframe(payload.timeframe) === "240"
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
  if (broker.environment === "live" && isDailyTimeframe(record?.payload?.timeframe)) return true;
  return broker.environment === "live" && !liveAutoBuyEligible(record);
}

function accountCommand(content, executorName = "") {
  const text = String(content || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["!account", "!account help", "!계좌", "!계좌 도움말"].includes(text)) return "HELP";
  if (["!account status", "!계좌 상태", "주문 실행기 상태 보여줘", "주문 실행기 상태 확인"].includes(text)) return "STATUS";
  if (["!account orders", "!계좌 주문"].includes(text)) return "ORDERS";
  if (["!account performance", "!계좌 성과", "계좌 전략 성과 보여줘"].includes(text)) return "PERFORMANCE";
  if (["!account reconcile", "!계좌 대조"].includes(text)) return "RECONCILE";
  if (["!account import", "!계좌 증빙반영"].includes(text)) return "IMPORT_EVIDENCE";
  if (["!account protection", "!계좌 보호"].includes(text)) return "PROTECTION";
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
  return normalizedSymbol(symbol);
}

function trackedPortfolio(orders, domesticHoldings, usHoldings, usdExchangeRate = 1) {
  const positions = new Map();
  const marketOf = (market) => String(market || "").toUpperCase() === "KRX" ? "KRX" : "US";
  const keyOf = (market, symbol) => `${marketOf(market)}:${accountSymbol(symbol)}`;
  const ordered = [...orders].sort((a, b) => orderTime(a) - orderTime(b));
  for (const order of ordered) {
    const key = keyOf(order.market, order.symbol);
    if (order.entryType && Number(order.filledQuantity || 0) > 0 && !positions.has(key)) {
      const owned = managedPosition(orders, { exchange: order.market, ticker: order.symbol }, order.environment || "mock");
      if (owned.quantity) positions.set(key, { ...owned, market: marketOf(order.market), symbol: accountSymbol(order.symbol) });
    }
  }

  let deployedKrw = 0;
  let openRiskKrw = 0;
  let hasUsExposure = false;
  for (const position of positions.values()) {
    const holdings = position.market === "KRX" ? domesticHoldings : usHoldings;
    const held = holdings.filter((holding) => accountSymbol(holding.code) === position.symbol);
    const accountQuantity = held.reduce((sum, holding) => sum + Number(holding.quantity || 0), 0);
    const quantity = Math.min(accountQuantity, position.quantity);
    const evaluation = accountQuantity > 0 ? held.reduce((sum, holding) => sum + Number(holding.evaluationAmount || 0), 0) * quantity / accountQuantity : 0;
    if (quantity <= 0 || evaluation <= 0) continue;
    const purchaseAmount = held.reduce((sum, holding) => sum + Number(holding.purchaseAmount || 0), 0);
    const purchasePrice = position.averagePrice || (purchaseAmount > 0 ? purchaseAmount / accountQuantity
      : held.reduce((sum, holding) => sum + Number(holding.purchasePrice || 0) * Number(holding.quantity || 0), 0) / accountQuantity);
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
  const market = signalExchange(record.payload.exchange);
  const positionOnly = options.positionOnly === true;
  const domestic = positionOnly && market !== "KRX"
    ? { holdings: [], estimatedAssets: 0, totalEvaluation: 0 }
    : await domesticClient.getDomesticBalance();
  const usBalances = positionOnly
    ? market === "KRX" ? [] : [await overseasClient.getUsBalance({ exchange: market })]
    : overseasClient.getUsBalances
      ? await overseasClient.getUsBalances()
      : [await overseasClient.getUsBalance()];
  const usHoldings = [...new Map(usBalances.flatMap((balance) => balance.holdings).map((holding) => [holding.code, holding])).values()];
  const holdings = market === "KRX" ? domestic.holdings : usHoldings;
  const current = holdings.filter((holding) => accountSymbol(holding.code) === accountSymbol(record.payload.ticker));
  const cashResult = positionOnly
    ? { orderableAmount: 0, usd: 0, usdExchangeRate: 0 }
    : market === "KRX"
      ? await domesticClient.getDomesticCash({ symbol: record.payload.ticker, price: record.payload.price })
      : await overseasClient.getUsCash({ exchange: market, symbol: record.payload.ticker, price: record.payload.price });
  const cash = market === "KRX" ? cashResult.orderableAmount : cashResult.usd;
  const evaluation = holdings.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  const policy = positionOnly ? null : options.riskPolicy || null;
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
  if (!preview || preview.blocked) return preview;
  if (preview.capitalOnly || ![preview.currentOpenRisk, preview.stopLossAmount, preview.maxOpenRisk].every(Number.isFinite)) {
    return { ...preview, blocked: true, quantity: 0, reason: "실계좌 손절위험을 확인할 수 없어 신규매수 차단" };
  }
  if (preview.currentOpenRisk + preview.stopLossAmount <= preview.maxOpenRisk) return preview;
  return { ...preview, blocked: true, quantity: 0, reason: `동시 손절위험 ${(preview.maxOpenRiskRatio * 100).toFixed(1)}% 한도 초과` };
}

const PYRAMID_RATIOS = [0.5, 0.25];
const PENDING_ORDER_STATUSES = new Set(["ACCEPTED", "CANCEL_REQUESTED", "PARTIALLY_FILLED", "UNKNOWN"]);

function pendingSymbolOrder(orders, record) {
  const market = String(record?.payload?.exchange || "").toUpperCase();
  const symbol = accountSymbol(record?.payload?.ticker);
  return orders.find((order) => PENDING_ORDER_STATUSES.has(order.status)
    && !(brokerStop(order) && order.status === "ACCEPTED" && !order.cancelSubmitted)
    && String(order.market || "").toUpperCase() === market
    && accountSymbol(order.symbol) === symbol) || null;
}

function pyramidPlan(orders, record) {
  const market = String(record.payload?.exchange || "").toUpperCase();
  const symbol = accountSymbol(record.payload?.ticker);
  let initialEntryQuantity = 0;
  let completedAdds = 0;
  let initialEntryPending = false;

  let remainingOwned = 0;
  for (const order of [...orders].sort((a, b) => orderTime(a) - orderTime(b))) {
    if (String(order.market || "").toUpperCase() !== market
        || accountSymbol(order.symbol) !== symbol) continue;
    const filledQuantity = Number(order.filledQuantity || 0);
    if (order.side === "SELL" || order.fullExit) remainingOwned = Math.max(0, remainingOwned - filledQuantity);
    if (order.fullExit && remainingOwned === 0 && filledQuantity > 0) {
      initialEntryQuantity = 0;
      completedAdds = 0;
      initialEntryPending = false;
    } else if (order.entryType === "PAPER_ENTRY" && filledQuantity > 0) {
      remainingOwned += filledQuantity;
      initialEntryQuantity = filledQuantity;
      completedAdds = 0;
      initialEntryPending = PENDING_ORDER_STATUSES.has(order.status);
    } else if (initialEntryQuantity > 0 && order.entryType === "PAPER_ADD") {
      remainingOwned += filledQuantity;
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
    if (brokerStop(previous)) continue; // Native protection has stricter identity/trigger verification.
    let current;
    const date = koreanDate(previous.createdAt, broker.id === "KIWOOM" ? "America/New_York" : "Asia/Seoul");
    if (previous.status !== "UNKNOWN" && previous.market !== "KRX" && date
      && date < koreanDate(new Date(), broker.id === "KIWOOM" ? "America/New_York" : "Asia/Seoul")
      && broker.overseasClient.getUsHistoricalExecutions) {
      if (Date.now() - Date.parse(previous.historyCheckedAt || "") < 300000) continue;
      const rows = await broker.overseasClient.getUsHistoricalExecutions({ date, symbol: previous.symbol, exchange: previous.exchange });
      const plan = reconciliationPlan([previous], rows, broker.environment);
      current = broker.tracker.record(plan.updates.length === 1 ? { ...plan.updates[0], reconciliationRequired: !["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(plan.updates[0].status), historyCheckedAt: new Date().toISOString() }
        : { ...previous, historyCheckedAt: new Date().toISOString(), reconciliationRequired: true });
      // An empty current-day list or an old "accepted" row does not prove expiry.
      // Keep the original order blocking a duplicate until final broker evidence arrives.
    } else current = await refreshPaperOrder(previous, broker);
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
    : brokerIds.length === 1
      ? `${brokerIds[0] === "KIWOOM" ? "`키움만`" : "`한투만`"} / \`안 사\``
      : "승인 가능한 계좌 없음";
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

function approvalCard(record, previews, brokerIds, ttlMs) {
  const text = approvalText(record, previews, brokerIds);
  const [, ...description] = text.split("\n");
  return {
    text,
    embed: {
      color: 0xFEE75C,
      title: "⏳ BUY 승인 대기",
      description: description.join("\n"),
      footer: { text: `${Math.round(ttlMs / 60_000)}분 안에 승인 · 승인 전 주문 생성 안 됨` },
      ...(record.receivedAt ? { timestamp: record.receivedAt } : {}),
    },
  };
}

function availableApprovalBrokerIds(previews, brokerIds = Object.keys(previews)) {
  return brokerIds.filter((brokerId) => previews[brokerId] && previews[brokerId].preview?.blocked !== true);
}

async function start() {
  const brokerIds = enabledBrokerIds();
  if (!brokerIds.length) throw new Error("ACCOUNT_EXECUTOR_ENABLED=true와 사용할 증권사 설정이 필요합니다.");
  const readOnly = process.env.ACCOUNT_READ_ONLY === "true";
  const environments = brokerEnvironments(brokerIds);
  const approvedHash = policyFingerprint();
  assertLivePolicy(environments, readOnly, approvedHash);
  console.log(`정책 지문: ${approvedHash} · 주문 없는 후보 비교와 분리`);
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
      protectionEnabled: environments.KIWOOM === "live" && process.env.ACCOUNT_BROKER_PROTECTION === "true",
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
    brokers.push({ id: "KIS", label: "한투", environment: environments.KIS,
      afterMarketExtended: process.env.KIS_LIVE_AFTER_MARKET_EXTENDED === "true",
      domesticClient: kis, overseasClient: kis, tracker: new OrderTracker(process.env.KIS_ORDER_STATE_FILE || "kis-orders.json") });
  }
  const runtime = createAccountRuntime({ brokers, receipts, client, readOnly, sourceChannelIds, trusted, targetGuildId, channels,
    maxAgeMs, maxOpenPositions, riskPolicy, ownerId, approvalTtlMs, deferredTtlMs, portfolioSyncMinutes,
    executorName, accountLabel, errorReports });
  // Restore only exact request/action/instrument matches after environment validation; never guess a legacy entry timeframe.
  const eventFile = process.env.WEBHOOK_LOG_FILE || "webhook-events.jsonl";
  if (!readOnly && fs.existsSync(eventFile)) {
    const records = fs.readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    for (const broker of brokers) for (const order of restoreOrderSignalMetadata(broker.tracker.list(), records)) broker.tracker.record(order);
  }
  return runtime.listen();
}

function createAccountRuntime({ brokers, receipts, client, readOnly = false, sourceChannelIds = new Set(), trusted,
  targetGuildId, channels, maxAgeMs = 30 * 60_000, maxOpenPositions = 5, riskPolicy = null, ownerId,
  approvalTtlMs = 30 * 60_000, deferredTtlMs = 5 * 24 * 60 * 60_000, portfolioSyncMinutes = 1440,
  executorName = "계좌", accountLabel = "계좌", errorReports = new Map(), trackingOptions = {}, enrichNames = enrichInstrumentNames }: any) {
  receipts.state.environments ||= {};
  for (const broker of brokers) {
    if (readOnly) continue;
    if (broker.tracker.list().some((order) => (order.environment || "mock") !== broker.environment)) {
      throw new Error(`${broker.label} 주문 상태 파일에 다른 계좌 환경의 기록이 있습니다. 모의·실계좌 파일을 분리하세요.`);
    }
    const previous = receipts.state.environments[broker.id]
      || (receipts.state.requestIds.length || receipts.listDeferred().length || Object.keys(receipts.state.pending).length ? "mock" : broker.environment);
    if (previous !== broker.environment) throw new Error(`${broker.label} 모의·실계좌 수신/예약 상태 파일을 분리하세요.`);
    receipts.state.environments[broker.id] = broker.environment;
  }
  if (!readOnly) receipts.write();
  const executionPolicyHash = policyFingerprint();
  const brokerQueues = new Map();
  const submitting = new Set();
  const brokerCompletedAt = new Map(brokers.map(broker => [broker.id, Date.now()]));
  const scheduled = new Map();
  const stopMonitorOutages = new Map();
  function brokerWork(broker, task, key = "") {
    const jobKey = `${broker.id}:${key}`;
    if (key && scheduled.has(jobKey)) return scheduled.get(jobKey);
    const job = (brokerQueues.get(broker.id) || Promise.resolve()).then(task);
    const settled = job.catch(error => reportError(`${broker.label} 작업 처리 실패`, error)).finally(() => {
      if (key) scheduled.delete(jobKey);
      brokerCompletedAt.set(broker.id, Date.now());
      workerAt = Math.min(...brokerCompletedAt.values() as Iterable<number>);
    });
    brokerQueues.set(broker.id, settled);
    if (key) scheduled.set(jobKey, settled);
    return settled;
  }
  let portfolioJob = null;
  let equitySyncJob = null;
  function requestEquitySync() {
    if (readOnly || !receipts.file || !process.env.STOCK_BRIEFING_TOKEN) return;
    if (!equitySyncJob) equitySyncJob = (async () => {
      const file = evidenceFile(receipts.file);
      await Promise.all(brokers.map(broker => brokerWork(broker, async () => {
        let collected;
        try { collected = await refreshAccountEquity(broker, file); }
        catch (error) { await reportEquityStatus(broker, error); return; }
        if (collected) await reportEquityStatus(broker);
      }, "equity")));
      const synced = await syncStockBriefingEquity(readEvidence(file), {
        checkpoint: receipts.state.briefingEquitySync ||= {}, saveCheckpoint: () => receipts.write(),
      });
      if (synced.sent) console.log(`Stock-Briefing 계좌 자산 동기화: ${synced.series}계좌 범위 · ${synced.synced}일별 관측`);
      if (synced.sent || synced.skipped) await reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화");
    })().catch(error => reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화", error))
      .catch(error => console.error("자산 동기화 상태 알림 저장/전송 실패:", error.message))
      .finally(() => { equitySyncJob = null; });
  }
  async function reconcileEvidence(broker) {
    if (readOnly || !receipts.file || !broker.overseasClient.getUsHistoricalExecutions) return null;
    const report = await collectBrokerEvidence(broker);
    const changed = applyEvidence(broker, report, evidenceFile(receipts.file));
    if (report.equityError) await reportEquityStatus(broker, new Error(report.equityError));
    else if (report.equity.length) await reportEquityStatus(broker);
    if (changed) void requestPortfolioSync();
    return { broker: broker.id, changed, discrepancies: report.remainingDiscrepancies.length,
      historyErrors: report.historyErrors, transactionError: report.transactionError, equityError: report.equityError };
  }
  function latestOrder(broker, order) {
    return broker.tracker.list().find(item => order.storageKey ? item.storageKey === order.storageKey
      : item.orderNo === order.orderNo && item.requestId === order.requestId) || order;
  }
  let portfolioAgain = false;
  function requestPortfolioSync() {
    portfolioAgain = true;
    if (!portfolioJob) portfolioJob = (async () => {
      while (portfolioAgain) {
        portfolioAgain = false;
        // Only acknowledge the fills included when this snapshot started, never a newer in-flight fill.
        const fills = brokers.flatMap(broker => broker.tracker.list().filter(orderNeedsPortfolioSync)
          .map(order => ({ broker, order, filledQuantity: order.filledQuantity })));
        try {
          const result = await syncPortfolio();
          for (const { broker, order, filledQuantity } of fills) {
            if (!result.succeededBrokerIds.has(broker.id)) continue;
            const current = latestOrder(broker, order);
            if (current) broker.tracker.record({ ...current, portfolioSyncedFilledQuantity: filledQuantity });
          }
        } catch (error) { await reportError("포트폴리오 갱신 재시도 대기", error); }
      }
    })().finally(() => { portfolioJob = null; });
    return portfolioJob;
  }
  let workerAt = Date.now();
  let initialized = false;
  let reportJob = null;
  let reportsAgain = false;
  function requestOrderReports() {
    reportsAgain = true;
    if (!reportJob) reportJob = (async () => {
      while (reportsAgain) {
        reportsAgain = false;
        for (const broker of brokers) for (const order of broker.tracker.list().filter(orderNeedsResultReport)) {
          try {
            const enriched = order.filledQuantity > 0 ? await withPortfolioMetrics(broker, order).catch(() => order) : order;
            await reportOrderResult(broker, enriched);
          } catch (error) { await reportError(`${broker.label} 체결 기록 전송 재시도 대기`, error); }
        }
      }
    })().finally(() => { reportJob = null; });
    return reportJob;
  }
  let cardJob = null;
  let cardsAgain = false;
  function refreshLifecycleCards() {
    cardsAgain = true;
    if (!cardJob) cardJob = (async () => {
      while (cardsAgain) {
        cardsAgain = false;
        const snapshots = brokers.map(broker => {
          const orders = broker.tracker.list();
          return { ...broker, submitting, tracker: { list: () => orders } };
        });
        for (const entry of Object.values(receipts.state.signals) as any[]) {
          const payload = formatLifecycleCard(entry, snapshots, receipts);
          const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
          if (entry.rendered === digest) continue;
          try {
            const channel = await targetChannel(channels.order);
            let message;
            if (entry.messageId) {
              try { message = await channel.messages.fetch(entry.messageId); }
              catch (error) { if (error.code !== 10008) throw error; } // recreate only a confirmed deleted message
            }
            const sent = message ? await message.edit(payload) : await channel.send(payload);
            entry.messageId = sent.id;
            entry.rendered = digest;
            for (const pending of Object.values(receipts.state.pending) as any[]) {
              if (pending.record.requestId === entry.record.requestId) pending.messageId = sent.id;
            }
            for (const broker of brokers) {
              const order = broker.tracker.list().find(order => order.requestId === entry.record.requestId);
              if (order && order.statusMessageId !== sent.id) broker.tracker.record({ ...order, statusMessageId: sent.id });
            }
            receipts.write();
          } catch (error) { await reportError("주문 진행 카드 갱신 재시도 대기", error, entry.record); }
        }
      }
    })().finally(() => { cardJob = null; });
    return cardJob;
  }

  function progress(broker, record, result) {
    if (!record.requestId || record.payload?.paper_order_test) return;
    receipts.signal(record, broker.id, result);
    void refreshLifecycleCards();
  }

  async function targetChannel(configured) {
    const guild = await client.guilds.fetch(targetGuildId);
    const available = await guild.channels.fetch();
    const matches = available.has(configured) ? [available.get(configured)]
      : [...available.values()].filter((item: any) => item?.name === configured);
    const channel = matches.length === 1 ? matches[0] : null;
    if (!channel?.isTextBased()) throw new Error(`Discord 기록 채널을 찾을 수 없습니다: ${configured || "미설정"}`);
    return channel;
  }

  async function acceptsOwnerMessage(message, allowedChannels) {
    if (message.author?.bot || message.author?.id !== ownerId || !targetGuildId || message.guildId !== targetGuildId) return false;
    for (const configured of allowedChannels.filter(Boolean)) {
      if (message.channelId === configured) return true;
      if (message.channel?.name === configured && message.channelId === (await targetChannel(configured)).id) return true;
    }
    return false;
  }

  async function send(channelName, message) {
    const channel = await targetChannel(channelName);
    return channel.send(discordMessagePayload(message));
  }

  const brokerAccountLabel = (broker) => `${broker.label} ${broker.environment === "live" ? "실계좌" : "모의계좌"}`;
  const accountSummary = () => brokers.map(brokerAccountLabel).join(" + ");

  async function reportEquityStatus(broker, error = null) {
    return reportDataStatus(`${broker.id}:${broker.environment}`, `${brokerAccountLabel(broker)} 자산 그래프 조회`, error);
  }

  async function reportDataStatus(key, label, error = null) {
    // Persist the incident, not a cooldown: restarting must not replay an hourly alert.
    const incidents = receipts.state.equityOutages ||= {};
    if (error) {
      const incident = incidents[key] ||= { since: new Date().toISOString(), notified: false };
      incident.reason = String(error.message || error).slice(0, 1000);
      receipts.write();
      if (incident.notified) return;
      await send(channels.system, { text: `⚠️ **${label} 지연 · 주문과 별개**\n${incident.reason}\n기존 기록은 유지하며 다음 주기에 재확인합니다. 같은 장애는 반복 통보하지 않고, 해당 데이터 요청의 복구 확인 시 알립니다.` });
      incident.notified = true;
      receipts.write();
    } else if (incidents[key]) {
      if (incidents[key].notified) await send(channels.system, { text: `✅ **${label} 복구**\n해당 데이터 요청의 성공을 확인했습니다. 주문 체결이나 실시간 감시 복구를 뜻하지 않습니다.` });
      delete incidents[key];
      receipts.write();
    }
  }

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

  async function reportUnknownOrder(broker, record, error) {
    const action = record.payload.action === "BUY" ? "매수" : "매도";
    try {
      await send(channels.execution, { text: [
        `⚠️ **${brokerAccountLabel(broker)} ${action} 주문 상태 확인 필요**`,
        `**종목**: ${formatInstrumentLabel(record.payload)}`,
        "증권사 응답이 끊겨 주문 접수 여부를 확정할 수 없습니다.",
        "중복 주문 방지를 위해 자동 재주문을 차단했습니다. 증권사 주문내역을 확인해 주세요.",
      ].join("\n") });
    } catch (notificationError) {
      console.error(`${broker.label} 주문 상태 알림 실패: ${notificationError.message}`);
    }
    await reportError(`${broker.label} ${action} 주문 상태 불명`, error, record);
  }

  async function syncPortfolio() {
    requestEquitySync(); // Separate failure/retry path: never holds up a fill acknowledgement or holdings sync.
    receipts.state.calendarNotices ||= {};
    for (const notice of calendarNotices()) {
      if (Date.now() - (receipts.state.calendarNotices[notice] || 0) < 86400_000) continue;
      await send(channels.system, { text: `📅 ${notice}\n공식 일정을 반영하기 전에는 해당 날짜를 주문 가능일로 추정하지 않습니다.` });
      receipts.state.calendarNotices[notice] = Date.now();
      receipts.write();
    }
    const channel = await targetChannel(channels.portfolio);
    const result = await syncAccountPortfolio(channel, brokers);
    const recent = await channel.messages.fetch({ limit: 100 });
    const existing = [...recent.values()].find((message: any) => message.author?.id === client.user?.id
      && message.embeds?.some(embed => embed.title === "자동매매 전략 비교"));
    const comparison = formatStrategyComparisonMessage(brokers, receipts.state.signals);
    if (existing) await existing.edit(comparison); else await channel.send(comparison);
    for (const broker of brokers) {
      const failure = result.failures.find(item => item.id === broker.id);
      await reportDataStatus(`portfolio:${broker.id}:${broker.environment}`, `${brokerAccountLabel(broker)} 포트폴리오 조회`, failure?.reason || null);
    }
    if (process.env.STOCK_BRIEFING_TOKEN && stockBriefingSyncReady(result, brokers.length)) {
      try {
        const synced = await syncStockBriefingHoldings(result.accounts, { performance: result.performance });
        console.log(`Stock-Briefing 보유종목 동기화: ${synced.synced}종목`);
      } catch (error) {
        await reportError("Stock-Briefing 보유종목 동기화 실패", error);
      }
    }
    return result;
  }

  async function previewFor(broker, record) {
    if (record.payload?.action === "BUY" && broker.environment === "live") {
      const reason = protectionReadiness(broker, record.payload.exchange);
      if (reason) return { label: broker.label, preview: { blocked: true, quantity: 0, reason } };
    }
    const sizingRecord = structuredClone(record);
    if (sizingRecord.risk?.verdict === "BUY_PENDING_APPROVAL") {
      sizingRecord.risk.verdict = approvedEntryVerdict(sizingRecord);
    }
    const liveRiskPolicy = broker.environment === "live" ? riskPolicy : null;
    const positionOnly = record.payload?.action === "SELL"
      && ["PAPER_EXIT", "PAPER_PARTIAL_EXIT"].includes(sizingRecord.risk?.verdict);
    let ownAccount;
    try {
      ownAccount = await accountContext(broker, sizingRecord, maxOpenPositions, {
        orders: broker.tracker.list(), riskPolicy: liveRiskPolicy, positionOnly,
      });
    } catch (error) {
      const verificationError: any = error instanceof Error ? error : new Error(String(error));
      verificationError.accountVerificationFailed = true;
      throw verificationError;
    }
    const calculated = executionPreview(sizingRecord, ownAccount, calculateWebhookPositionPreview(sizingRecord, ownAccount, broker.environment));
    const pendingOrder = pendingSymbolOrder(broker.tracker.list(), sizingRecord);
    if (pendingOrder) {
      return { label: broker.label, preview: {
        ...calculated,
        blocked: true,
        retryable: true,
        quantity: 0,
        reason: `동일 종목 ${pendingOrder.side === "SELL" ? "매도" : "매수"} 주문 체결 확인 중`,
      } };
    }
    const sized = applyPyramidSizing(sizingRecord,
      scopePositionPreview(sizingRecord, enforceOwnAccountRules(sizingRecord, ownAccount, calculated), broker.tracker.list(), broker.environment),
      broker.tracker.list());
    const preview = liveRiskPolicy && record.payload.action === "BUY" ? enforceOpenRiskLimit(sized) : sized;
    return { label: broker.label, preview };
  }

  async function withPortfolioMetrics(broker, order) {
    const account = await accountContext(broker, { payload: {
      exchange: order.market, ticker: order.symbol, price: order.fillPrice || order.signalPrice,
    } }, maxOpenPositions);
    return broker.tracker.record({
      ...latestOrder(broker, order),
      accountEquity: account.equity,
      positionValueAfterFill: account.currentPositionValue,
      positionRatio: account.accountPositionRatio,
      currency: account.currency,
    });
  }

  async function reportOrderResult(broker, order) {
    let reported = { ...order, resultAt: order.resultAt || order.updatedAt };
    receipts.reconcileTradeStage(broker.id, reported);
    if (reported.executionReportedStatus !== reported.status || reported.executionReportedFilledQuantity !== reported.filledQuantity) {
      await send(channels.execution, formatOrderStatus(reported));
      broker.tracker.record({ ...latestOrder(broker, order), executionReportedStatus: reported.status, executionReportedFilledQuantity: reported.filledQuantity });
    }
    if (reported.status === "FILLED" && reported.journalReportedStatus !== reported.status) {
      await send(channels.journal, formatTradeJournal(reported));
      broker.tracker.record({ ...latestOrder(broker, order), journalReportedStatus: reported.status });
    }
    return latestOrder(broker, reported);
  }

  async function execute(broker, record, options = {}) {
    progress(broker, record, { status: "PROCESSING" });
    try {
      const result = await executeOrder(broker, record, options);
      progress(broker, record, result || { status: "NO_ACTION" });
      return result;
    } catch (error) {
      progress(broker, record, { status: orderStatusUnknown(error) ? "UNKNOWN" : "DEFER_REQUIRED", reason: "계좌·주문 상태 재확인 필요" });
      throw error;
    }
  }

  async function executeOrder(broker, record, { manual = false } = {}) {
    if (!readOnlySignalAllowed(record, readOnly)) return null;
    if (record.source === "LOCAL_STOP_GUARD") {
      if (broker.environment !== "mock") return { status: "BLOCKED", reason: "로컬 자동 손절은 모의계좌 전용" };
      const owned = managedPosition(broker.tracker.list(), record.payload, broker.environment);
      if (!owned.quantity || owned.entryRequestId !== record.positionEntryRequestId) {
        return { status: "NO_ACTION", reason: "손절 대상 포지션 종료 또는 변경 · 주문 없음" };
      }
    }
    if (record.executionDeadline && Date.now() >= record.executionDeadline) return { status: "EXPIRED", reason: "주문 유효시간 종료" };
    if (!manual && !receipts.autoTrading() && record.payload?.paper_order_test !== true) return { status: "DEFER_REQUIRED" };
    if (receipts.supersededEntry(broker.id, record)) return { status: "BLOCKED", reason: "이후 청산 신호로 취소된 진입" };
    const existingOrder = broker.tracker.list().find((order) => order.requestId === record.requestId);
    if (existingOrder) return existingOrder;
    const attempt = receipts.attempt(broker.id, record);
    if (["SUBMITTING", "UNKNOWN"].includes(attempt?.status)) {
      const error: any = new Error("이 신호의 이전 주문 접수 여부 확인 필요");
      error.orderStatusUnknown = true;
      throw error;
    }
    try { currentProtection(broker, receipts, record.payload); } // Unknown STOP blocks ordinary orders, but is not their submission.
    catch (error) { throw Object.assign(new Error(error.message), { accountVerificationFailed: true }); }
    if (Object.entries(receipts.state.attempts).some(([key, a]: [string, any]) => key.startsWith(`${broker.id}:`) && ["SUBMITTING", "UNKNOWN"].includes(a.status)
      && a.market === record.payload.exchange && a.symbol === record.payload.ticker)) {
      return { status: "DEFER_REQUIRED", verificationPending: true };
    }
    if (record.payload?.paper_order_test === true) {
      const market = signalExchange(record.payload.exchange);
      await broker.domesticClient.getDomesticBalance();
      if (broker.overseasClient.getUsBalances) await broker.overseasClient.getUsBalances();
      else await broker.overseasClient.getUsBalance();
      if (market === "KRX") await broker.domesticClient.getDomesticCash({ symbol: record.payload.ticker, price: record.payload.price });
      else await broker.overseasClient.getUsCash({ exchange: market, symbol: record.payload.ticker, price: record.payload.price });
      await send(channels.order, { text: `✅ **${brokerAccountLabel(broker)} 자동매매 연동 테스트 통과**\n**종목**: ${formatInstrumentLabel(record.payload)}\n계좌 조회 정상 · 주문 생성 없음` });
      return null;
    }
    if (shouldDelayOrder(record, new Date(), broker) && !requiresExistingPosition(record)) return { status: "DEFER_REQUIRED" };
    if (!shouldDelayOrder(record, new Date(), broker)) {
      try {
        const quote = await currentSignalPrice(broker, record.payload);
        if (!Number.isFinite(quote) || quote <= 0) throw new Error("유효한 현재가 확인 실패");
        if (record.source === "LOCAL_STOP_GUARD" && (broker.environment !== "mock" || quote > record.payload.sl)) {
          return { status: "NO_ACTION", reason: "모의 손절 재확인 조건 해소 · 주문 없음" };
        }
        record.originalSignalPrice ??= record.payload.price;
        record.payload.price = record.payload.action === "BUY" && signalExchange(record.payload.exchange) !== "KRX"
          ? protectedUsBuyLimit(record.originalSignalPrice, quote) : quote;
      } catch (error) {
        error.accountVerificationFailed = true;
        throw error;
      }
    }
    if ((record.payload.action === "SELL" || record.risk?.verdict === "PAPER_ADD") && !shouldDelayOrder(record, new Date(), broker)) {
      const owned = managedPosition(broker.tracker.list(), record.payload, broker.environment);
      if (owned.quantity && (emergencyExit(record) || sameTimeframe(owned.timeframe, record.payload.timeframe))
        && (!Number.isFinite(Date.parse(record.receivedAt)) || Date.parse(record.receivedAt) >= owned.entryAt)) {
        try {
          if (!await releaseProtection(broker, receipts, record.payload, () => manual || receipts.autoTrading())) return { status: "DEFER_REQUIRED", verificationPending: true };
        } catch (error) { throw Object.assign(new Error(error.message), { accountVerificationFailed: true }); }
      }
    }
    await settlePendingBuys(broker, record, manual);
    record.positionPreview = (await previewFor(broker, record)).preview;
    record.accountVerified = true;
    if (record.positionPreview?.retryable) return { status: "DEFER_REQUIRED", verificationPending: true };
    if (record.positionPreview?.skipStatus) {
      console.log(`${record.positionPreview.skipStatus}: ${record.payload.ticker} · ${record.positionPreview.reason}`);
      return { status: record.positionPreview.skipStatus, reason: record.positionPreview.reason };
    }
    const existingEntry = skippedExistingEntry(record, record.positionPreview);
    if (existingEntry) return existingEntry;
    const skipped = skippedNoPosition(record, record.positionPreview);
    if (skipped) return skipped;
    if (record.positionPreview?.blocked) {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 차단",
        reason: record.positionPreview.reason || "주문 조건 불충족",
      }));
      return { status: "BLOCKED", reason: record.positionPreview.reason || "주문 조건 불충족" };
    }
    if (shouldDelayOrder(record, new Date(), broker)) return { status: "DEFER_REQUIRED" };
    const stage = partialExitStage(record);
    if (stage && receipts.partialExitBlocked(broker.id, record)) {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "부분청산 중복 차단",
        reason: `${stage}은 현재 포지션에서 이미 실행 또는 주문 대기 중`,
      }));
      return { status: "BLOCKED", reason: `${stage} 이미 실행 또는 주문 대기 중` };
    }
    if (!manual && !receipts.autoTrading()) return { status: "DEFER_REQUIRED" };
    if (record.executionDeadline && Date.now() >= record.executionDeadline) return { status: "EXPIRED", reason: "계좌 확인 중 주문 유효시간 종료" };
    if (receipts.supersededEntry(broker.id, record)) return { status: "CANCELLED", reason: "계좌 확인 중 후속 청산 신호 수신" };
    receipts.attempt(broker.id, record, "SUBMITTING");
    record.executorReportable = true;
    record.policyVersion = POLICY_VERSION;
    record.policyHash = executionPolicyHash;
    let order;
    const submissionKey = `${broker.id}:${record.requestId}`;
    submitting.add(submissionKey);
    try {
      order = await submitPaperOrder(record, {
        enabled: true, environment: broker.environment, id: broker.id, afterMarketExtended: broker.afterMarketExtended,
        domesticClient: broker.domesticClient, overseasClient: broker.overseasClient,
        tracker: broker.tracker, brokerLabel: brokerAccountLabel(broker),
        canSubmit: () => (manual || receipts.autoTrading()) && (!record.executionDeadline || Date.now() < record.executionDeadline) && !receipts.supersededEntry(broker.id, record),
        partialExit1Ratio: Number(process.env.PARTIAL_EXIT_1_RATIO || 0.25),
        partialExit2Ratio: Number(process.env.PARTIAL_EXIT_2_RATIO || 0.5),
      });
    } catch (error) {
      receipts.attempt(broker.id, record, orderStatusUnknown(error) ? "UNKNOWN" : "RETRYABLE");
      throw error;
    } finally { submitting.delete(submissionKey); }
    receipts.attempt(broker.id, record, order && order.status !== "BLOCKED" ? "ACCEPTED" : "BLOCKED");
    if (order?.status === "BLOCKED" && !manual && !receipts.autoTrading()) return { status: "DEFER_REQUIRED" };
    if (!order || order.status === "BLOCKED") {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 차단",
        reason: order?.reason || record.positionPreview?.reason || "주문 조건 불충족",
      }));
      return { status: "BLOCKED", reason: order?.reason || record.positionPreview?.reason || "주문 조건 불충족" };
    }
    if (order.entryType === "PAPER_ENTRY") receipts.resetPartialExits(broker.id, order.market, order.symbol);
    if (order.partialExitStage) receipts.reservePartialExit(broker.id, order);
    progress(broker, record, order);
    let final = await trackPaperOrder(order, { domesticClient: broker.domesticClient, overseasClient: broker.overseasClient, tracker: broker.tracker, attempts: 5, delayMs: 2_000, ...trackingOptions,
      canSubmit: () => (manual || receipts.autoTrading()) && (!record.executionDeadline || Date.now() < record.executionDeadline) && !receipts.supersededEntry(broker.id, record) });
    receipts.reconcileTradeStage(broker.id, final);
    void requestOrderReports();
    if (orderNeedsPortfolioSync(final)) void requestPortfolioSync();
    if (broker.protectionEnabled) await checkManagedStops([broker]);
    return final;
  }

  async function settlePendingBuys(broker, record, manual = false) {
    if (record.payload.action !== "SELL" || shouldDelayOrder(record, new Date(), broker)) return;
    for (const previous of broker.tracker.list().filter((order) => order.side === "BUY" && pendingSymbolOrder([order], record))) {
      if (!emergencyExit(record) && !sameTimeframe(previous.timeframe, record.payload.timeframe)) continue;
      const current = await refreshPaperOrder(previous, broker);
      if (!PENDING_ORDER_STATUSES.has(current.status)) continue;
      if (current.status === "UNKNOWN" || current.cancelSubmitted) continue;
      const api = current.market === "KRX" ? broker.domesticClient : broker.overseasClient;
      const cancel = current.market === "KRX" ? api.cancelDomesticOrder : api.cancelUsOrder;
      if (!cancel) continue;
      if (!manual && !receipts.autoTrading()) return;
      broker.tracker.record({ ...current, cancelSubmitted: true });
      try {
        const result = await cancel.call(api, { orderNo: current.activeOrderNo || current.orderNo,
          symbol: accountSymbol(current.symbol), exchange: signalExchange(current.market), quantity: current.remainingQuantity });
        broker.tracker.record({ ...current, ...result, orderNo: current.orderNo, status: "CANCEL_REQUESTED", cancelSubmitted: true });
      } catch (error) {
        broker.tracker.record({ ...current, cancelSubmitted: orderStatusUnknown(error) });
        await reportError(`${broker.label} 매수 잔량 취소 확인 대기`, error, record);
      }
    }
  }

  async function reconcileOrders(selected = brokers) {
    let portfolioChanged = false;
    for (const broker of selected) {
      let changes;
      try {
        changes = await reconcilePendingBrokerOrders(broker);
      } catch (error) {
        await reportError(`${broker.label} 미완료 주문 체결 조회 실패`, error);
        continue;
      }
      for (const { current } of changes) {
        receipts.reconcileTradeStage(broker.id, current);
        if (orderNeedsPortfolioSync(current)) portfolioChanged = true;
      }
      for (const order of broker.tracker.list()) {
        const intent = receipts.state.attempts[`${broker.id}:${order.requestId}`];
        if (order.requestId && order.orderNo && order.status !== "UNKNOWN" && ["SUBMITTING", "UNKNOWN"].includes(intent?.status)) {
          receipts.attempt(broker.id, { requestId: order.requestId, payload: { exchange: order.market, ticker: order.symbol } }, "ACCEPTED");
        }
      }
      for (const order of broker.tracker.list().filter((order) => order.requestId && !order.statusMessageId)) {
        receipts.signal({ requestId: order.requestId, receivedAt: order.createdAt, policyVersion: order.policyVersion || "legacy", payload: {
          ticker: order.symbol, name: order.name, koreanName: order.koreanName, exchange: order.market, timeframe: order.timeframe, action: order.side,
        }, outcome: { signal: { signalCode: order.signalCode } } }, broker.id, order);
      }
      if (broker.tracker.list().some(orderNeedsPortfolioSync)) portfolioChanged = true;
    }
    if (portfolioChanged) void requestPortfolioSync();
    void refreshLifecycleCards();
    void requestOrderReports();
    return portfolioChanged;
  }

  async function executeOrDefer(broker, record, { retry = false, manual = false } = {}) {
    if (!readOnlySignalAllowed(record, readOnly)) return null;
    if (!retry && receipts.findDeferredEntry(broker.id, record)) {
      progress(broker, record, { status: "NO_ACTION", reason: "이전 진입 예약이 이미 대기 중 · 중복 예약 안 함" });
      return null;
    }
    if (!retry && !requiresExistingPosition(record) && shouldDelayOrder(record, new Date(), broker)) {
      receipts.putDeferred(broker.id, record, deferredTtlMs);
      progress(broker, record, { status: "DEFER_REQUIRED" });
      return null;
    }
    try {
      const result = await execute(broker, record, { manual });
      if (result?.status === "DEFER_REQUIRED") {
        const deferred = receipts.putDeferred(broker.id, record, deferredTtlMs, { kind: result.verificationPending ? "VERIFY" : "ORDER" });
        if (result.verificationPending) receipts.markVerificationFailure(deferred.key, new Error("이전 주문 종료 확인 대기"));
        progress(broker, record, { status: "DEFER_REQUIRED" });
        return null;
      }
      return result;
    } catch (error) {
      if (error.autoTradingPaused) {
        if (receipts.supersededEntry(broker.id, record)) {
          const result = { status: "CANCELLED", reason: "후속 청산 신호로 주문 송신 취소" };
          progress(broker, record, result);
          return result;
        }
        if (record.executionDeadline && Date.now() >= record.executionDeadline) {
          const result = { status: "EXPIRED", reason: "주문 송신 대기 중 유효시간 종료" };
          progress(broker, record, result);
          return result;
        }
        receipts.putDeferred(broker.id, record, deferredTtlMs);
        return null;
      }
      if (orderStatusUnknown(error)) {
        receipts.attempt(broker.id, record, "UNKNOWN");
        await reportUnknownOrder(broker, record, error);
        return { status: "UNKNOWN", orderStatusUnknown: true };
      }
      if (error?.accountVerificationFailed === true) {
        const deferred = receipts.putDeferred(broker.id, record, deferredTtlMs, { kind: "VERIFY" });
        receipts.markVerificationFailure(deferred.key, error);
        progress(broker, record, { status: "DEFER_REQUIRED" });
        return null;
      }
      if (shouldDeferOrder(record, error)) {
        if (!retry) {
          const now = new Date();
          const transitionRetry = shouldRetryMarketTransition(record, error, now, broker);
          const deferred = receipts.putDeferred(broker.id, record, deferredTtlMs, { now: now.getTime() });
          if (transitionRetry) receipts.markMarketTransitionFailure(deferred.key, orderAttemptKey(record, now), error, now.getTime());
          else receipts.markDeferredFailure(deferred.key, error);
          progress(broker, record, { status: "DEFER_REQUIRED" });
        }
        return null;
      }
      if (broker.tracker.list().some((order) => order.requestId === record.requestId)) {
        await reportError("주문 접수 후 후속 처리 실패 · 재주문 안 함", error, record);
        return { status: "ACCEPTED" };
      }
      const action = record.payload.action === "BUY" ? "매수" : "매도";
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 실패",
        reason: "계좌 조회 또는 주문 요청 실패",
      }));
      await reportError(`${broker.label} 자동 ${action} 실패`, error, record);
      progress(broker, record, { status: "BLOCKED", reason: "계좌 조회 또는 주문 요청 실패 · 시스템상태 확인 필요" });
      return { status: "BLOCKED" };
    }
  }

  async function retryDeferred(now = new Date(), selected = brokers) {
    for (const deferred of receipts.listDeferred().filter(item => selected.some(broker => broker.id === item.brokerId))) {
      const action = deferred.record.payload.action === "SELL" ? "매도" : "매수";
      if (deferred.expiresAt <= now.getTime()) {
        receipts.removeDeferred(deferred.key);
        receipts.signal(deferred.record, deferred.brokerId, { status: "EXPIRED", reason: "예약 유효시간 종료 · 새 신호 필요" });
        void refreshLifecycleCards();
        continue;
      }
      if (!receipts.autoTrading()) continue;
      const record = structuredClone(deferred.record);
      record.executionDeadline = deferred.expiresAt;
      const broker = brokers.find((item) => item.id === deferred.brokerId);
      if (!broker) continue;
      const verificationPending = deferred.kind === "VERIFY";
      if (verificationPending && deferred.nextAttemptAt > now.getTime()) continue;
      if (!verificationPending && shouldDelayOrder(record, now, broker)) continue;
      const attemptKey = orderAttemptKey(record, now);
      if (!verificationPending) {
        if (!deferredOrderAttemptDue(deferred, attemptKey, now.getTime())) continue;
        receipts.markDeferredAttempt(deferred.key, attemptKey);
      }
      try {
        const result = await execute(broker, record);
        if (result?.status === "DEFER_REQUIRED") {
          if (result.verificationPending) receipts.markVerificationFailure(deferred.key, new Error("이전 주문 종료 확인 대기"), now.getTime());
          else receipts.markDeferredOrder(deferred.key);
          continue;
        }
        receipts.removeDeferred(deferred.key);
      } catch (error) {
        if (error.autoTradingPaused) {
          receipts.markDeferredOrder(deferred.key);
          continue;
        }
        if (orderStatusUnknown(error)) {
          receipts.removeDeferred(deferred.key);
          await reportUnknownOrder(broker, record, error);
          continue;
        }
        if (error?.accountVerificationFailed === true) {
          const pending = receipts.markVerificationFailure(deferred.key, error, now.getTime());
          if (pending?.verificationAttempts === 3) await reportError(`${broker.label} 보유 확인 반복 실패`, error, record);
          continue;
        }
        if (shouldDeferOrder(record, error)) {
          if (shouldRetryMarketTransition(record, error, now, broker)) {
            const pending = receipts.markMarketTransitionFailure(deferred.key, attemptKey, error, now.getTime());
            if (pending) void refreshLifecycleCards();
          } else {
            receipts.markDeferredOrder(deferred.key, attemptKey);
            receipts.markDeferredFailure(deferred.key, error);
          }
          continue;
        }
        if (verificationPending && record.accountVerified === true) receipts.markDeferredOrder(deferred.key, attemptKey);
        receipts.markDeferredFailure(deferred.key, error);
        await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
          title: `예약 ${action} 실패`,
          reason: "계좌 조회 또는 주문 요청 실패",
        }));
        await reportError(`${broker.label} 예약 ${action} 재시도 실패`, error, record);
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

  async function checkManagedStops(selected = brokers) {
    for (const broker of selected) {
      let queryError = null;
      let checked = 0;
      let incomplete = false;
      let ownedCount = 0;
      const outageKey = `stop-monitor:${broker.id}:${broker.environment}`;
      const incident = stopMonitorOutages.get(outageKey) || { unresolved: new Set(), startedAt: Date.now(), recoveredAt: null, notified: false };
      const unresolved = incident.unresolved;
      const orders = broker.tracker.list();
      const symbols = new Map(orders.filter(order => order.entryType).map(order => [`${order.market}:${order.symbol}`, order]));
      for (const order of symbols.values() as Iterable<any>) {
        const payload = { ticker: order.symbol, exchange: order.market, action: "SELL", koreanName: order.koreanName, name: order.name };
        if (broker.protectionEnabled && !shouldDelayOrder({ payload, risk: { verdict: "PAPER_EXIT" } }, new Date(), broker)) {
          try {
            const result = await ensureProtection(broker, receipts, payload, () => !readOnly && receipts.autoTrading());
            if (result.status === "UNPROTECTED") await reportError(`${broker.label} 증권사 보호 미적용`, new Error(result.reason));
            if (result.order) { void requestOrderReports(); if (orderNeedsPortfolioSync(result.order)) void requestPortfolioSync(); }
          } catch (error) { await reportError(`${broker.label} 증권사 보호주문 확인 필요`, error); }
        }
        const freshOrders = broker.tracker.list();
        const owned = managedPosition(freshOrders, payload, broker.environment);
        const symbolKey = `${order.market}:${order.symbol}`;
        if (!owned.quantity) { unresolved.delete(symbolKey); continue; }
        ownedCount++;
        const marketClosed = shouldDelayOrder({ payload, risk: { verdict: "PAPER_EXIT" } }, new Date(), broker);
        // Finish a read-only recovery check even if the outage crossed market close.
        // Outside trading hours, healthy accounts still make no stop-monitor requests.
        if (marketClosed && !stopMonitorOutages.has(outageKey)) continue;
        try {
          const account = await accountContext(broker, { payload }, maxOpenPositions, { positionOnly: true });
          if (!Number.isInteger(account.currentPositionQuantity) || account.currentPositionQuantity < owned.quantity) {
            incomplete = true;
            await reportError(`${broker.label} 자동매매 보유 기록 대조 필요`,
              new Error("실제 잔고가 자동매매 기록보다 적습니다. 기록을 임의로 청산 처리하지 않으며 해당 종목 신규 주문을 차단합니다."), { payload });
            continue;
          }
          if (!Number.isFinite(owned.stopPrice) || !(owned.stopPrice > 0)) { checked++; unresolved.delete(symbolKey); continue; }
          const price = await currentSignalPrice(broker, payload);
          if (!Number.isFinite(price) || price <= 0) throw new Error("유효한 현재가 없음");
          checked++;
          unresolved.delete(symbolKey);
          if (!marketClosed && price <= owned.stopPrice) {
            if (broker.environment === "mock" && !readOnly && receipts.autoTrading() && owned.entryRequestId && owned.entryAt > 0) {
              const entry = freshOrders.find(item => item.requestId === owned.entryRequestId);
              const previous = freshOrders.filter(item => item.source === "LOCAL_STOP_GUARD"
                && item.positionEntryRequestId === owned.entryRequestId);
              // Terminal residuals get a new id; pending/uncertain submissions retain the same durable id across restarts.
              const generation = previous.filter(item => ["CANCELLED", "REJECTED", "EXPIRED"].includes(item.status)).length;
              const record = { requestId: `${owned.entryRequestId}:local-stop:${generation}`, receivedAt: new Date().toISOString(),
                source: "LOCAL_STOP_GUARD", positionEntryRequestId: owned.entryRequestId,
                evaluationIssues: [...new Set([...(entry?.evaluationIssues || []),
                  ...(entry?.policyVersion !== POLICY_VERSION ? ["보유 중 손절 정책 변경 · 기존 전략과 직접 비교 제외"] : [])])],
                payload: { ...payload, timeframe: owned.timeframe, type: "모의계좌 손절선 이탈", price, sl: owned.stopPrice },
                outcome: { decision: "EXIT_IF_FILLED", signal: { signalCode: "EXIT_CRASH" } },
                risk: { verdict: "PAPER_EXIT", reason: "모의 자동매매 보유분의 저장 손절선 이탈 · 주문 직전 재확인" } };
              await executeOrDefer(broker, record);
            } else await reportError(`${broker.label} 손절 기준 이탈 · 보유 확인 필요`,
              new Error("저장된 손절 기준 이하입니다. 실계좌·자동매매 OFF·읽기전용·진입 증빙 미확인은 자동 청산하지 않습니다."), { payload });
          }
        } catch (error) { queryError ||= error; unresolved.add(symbolKey); }
      }
      if (queryError) {
        if (!stopMonitorOutages.has(outageKey)) console.warn(`${brokerAccountLabel(broker)} 손절 감시 조회 재확인:`, String(queryError.message || queryError).slice(0, 1000));
        incident.recoveredAt = null;
        stopMonitorOutages.set(outageKey, incident); // Health becomes unhealthy immediately, independently of Discord debounce.
        // One account outage, not a separate incident for every holding or changing error message.
        if (Date.now() - incident.startedAt >= 60_000 && errorReportDue(errorReports.get(outageKey))) {
          try {
            await send(channels.system, { text: `⚠️ **${brokerAccountLabel(broker)} 손절 감시 조회 장애**\n일부 또는 전체 보유종목의 잔고·현재가 조회가 1분 이상 안정적으로 복구되지 않았습니다.\n**사유**: ${String(queryError.message || queryError).slice(0, 1000)}\n30초 주기 재확인${broker.id === "KIS" ? " · 인증 재발급 최소 61초 간격" : ""}.\n이 알림은 조회 장애이며 매도 주문 실패가 아닙니다. 연속 정상 조회 확인 후 다시 알립니다.` });
            incident.notified = true;
            errorReports.set(outageKey, Date.now());
          } catch (error) { console.error("손절 감시 장애 알림 실패:", error.message); }
        }
      } else if (stopMonitorOutages.has(outageKey)) {
        if (checked < ownedCount || incomplete || unresolved.size > 0) { incident.recoveredAt = null; continue; }
        if (ownedCount) {
          incident.recoveredAt ??= Date.now();
          if (Date.now() - incident.recoveredAt < 30_000) continue;
        }
        try {
          if (incident.notified) await send(channels.system, { text: `✅ **${brokerAccountLabel(broker)} 손절 감시 조회 ${ownedCount ? "복구" : "장애 해제"}**\n${ownedCount ? `감시 대상 ${checked}종목 전체의 잔고·현재가 조회를 30초 이상 간격의 연속 점검에서 확인했습니다.` : "현재 자동매매 관리 보유분이 없어 감시 대상이 해소됐습니다."} 매도 체결이나 증권사 보호주문 등록을 뜻하지 않습니다.` });
          errorReports.delete(outageKey);
          stopMonitorOutages.delete(outageKey);
          console.info(`${brokerAccountLabel(broker)} 손절 감시 조회 상태 정상화`);
        } catch (error) { console.error("손절 감시 복구 알림 실패:", error.message); }
      }
    }
  }

  async function checkInvalidations(now = new Date(), selected = brokers) {
    if (!receipts.autoTrading()) return;
    for (const pending of receipts.listInvalidations().filter(item => selected.some(broker => broker.id === item.brokerId))) {
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
      const owned = managedPosition(broker.tracker.list(), pending.record.payload, broker.environment);
      if (!owned.quantity || !sameTimeframe(owned.timeframe, pending.record.payload.timeframe)
        || (pending.entryRequestId && pending.entryRequestId !== owned.entryRequestId)) {
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

  async function processLifecycle(record, lifecycleBrokers = brokers) {
    if (record.risk?.verdict === "WAIT") {
      let stored = 0;
      for (const broker of lifecycleBrokers) {
        const account = await accountContext(broker, record, maxOpenPositions);
        if (!account.hasExistingPosition) continue;
        const owned = managedPosition(broker.tracker.list(), record.payload, broker.environment);
        if (!owned.quantity || !sameTimeframe(owned.timeframe, record.payload.timeframe)) continue;
        const entryPrice = owned.averagePrice || record.outcome?.state?.entrySignalPrice || record.payload.price;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
        const invalidation = receipts.putInvalidation(broker.id, record, entryPrice);
        invalidation.entryRequestId = owned.entryRequestId;
        receipts.write();
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
      for (const broker of lifecycleBrokers) {
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
    if (!await acceptsOwnerMessage(message, [channels.order])) return false;
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
      receipts.signal(pending.record).declined = true;
      for (const broker of brokers) progress(broker, pending.record, { status: "CANCELLED", reason: "사용자 BUY 승인 거부" });
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
    const approved = structuredClone(pending.record);
    approved.executionDeadline = pending.expiresAt;
    if (approved.risk?.verdict === "BUY_PENDING_APPROVAL") approved.risk = { verdict: approvedEntryVerdict(approved), reason: "사용자 BUY 승인" };
    for (const broker of selected) receipts.putDeferred(broker.id, approved, deferredTtlMs);
    receipts.signal(pending.record).approvalClosed = true;
    for (const broker of brokers.filter(broker => !selected.includes(broker))) {
      progress(broker, pending.record, { status: "NO_ACTION", reason: "승인 시 선택되지 않은 계좌 · 주문 안 함" });
    }
    receipts.removePending(pending.key);
    const jobs = selected.map(broker => brokerWork(broker, async () => {
      try {
        const deferred = receipts.putDeferred(broker.id, approved, deferredTtlMs);
        const result = await executeOrDefer(broker, structuredClone(approved), { manual: true, retry: true });
        if (result && result.status !== "DEFER_REQUIRED") receipts.removeDeferred(deferred.key);
      } catch (error) {
        await reportError(`${broker.label} 승인 주문 실패`, error, pending.record);
      }
    }));
    await message.reply(`승인 접수: ${selected.map(broker => broker.label).join("·")} · 실제 접수·체결 결과는 같은 카드에서 갱신합니다.`);
    await Promise.all(jobs);
    await refreshLifecycleCards();
    return true;
  }

  async function processMessage(message) {
    if (!shouldConsumeMessage(message, trusted)) return;
    const record = decodeSignalEmbed(message.embeds?.[0]);
    if (!record || !readOnlySignalAllowed(record, readOnly)) return;
    const receivedAt = new Date(record.receivedAt).getTime();
    if (!Number.isFinite(receivedAt) || Date.now() - receivedAt > maxAgeMs || receivedAt > Date.now() + 60_000) return;
    const item = receipts.receive(record, message.id, maxAgeMs);
    if (item) {
      // New exits invalidate queued buys immediately, even while that broker is waiting for an API response.
      for (const broker of brokers) receipts.rememberExit(broker.id, record);
      await processInbox(item);
    }
  }

  async function processInbox(item) {
    await Promise.all(brokers.map(broker => brokerWork(broker, () => processInboxBroker(item, broker), `inbox:${item.record.requestId}`)));
    await retryApprovalCards();
  }

  async function processInboxBroker(item, broker) {
    if (item.completed.includes(broker.id)) return;
    const record = structuredClone(item.record);
    record.executionDeadline = item.expiresAt;
    record.source = "DISCORD_SIGNAL";
    try {
      if (item.expiresAt <= Date.now() || receipts.state.signals[record.requestId]?.declined || receipts.state.signals[record.requestId]?.approvalClosed) {
        progress(broker, record, { status: item.expiresAt <= Date.now() ? "EXPIRED" : "CANCELLED", reason: "신호 유효시간 종료 또는 사용자 승인 결정 완료" });
        receipts.completeBroker(item, broker.id);
        return;
      }
      try { [record.payload] = await enrichNames([record.payload]); } catch { /* 이름 조회 장애는 주문 처리를 막지 않습니다. */ }
      receipts.rememberExit(broker.id, record);
      if (receipts.supersededEntry(broker.id, record)) {
        progress(broker, record, { status: "CANCELLED", reason: "이후 청산 신호로 취소된 진입" });
        receipts.completeBroker(item, broker.id);
        return;
      }
      if (await processLifecycle(record, [broker])) {
        progress(broker, record, { status: "NO_ACTION", reason: record.risk?.reason || "관찰 상태 반영" });
        receipts.completeBroker(item, broker.id);
        return;
      }
      const pendingApproval = record.risk?.verdict === "BUY_PENDING_APPROVAL";
      const entry = (pendingApproval || ["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict)) && record.payload.action === "BUY";
      if (pendingApproval || (entry && buyApprovalRequiredForBroker(broker, record, receipts.autoTrading()))) {
        const result = await previewFor(broker, structuredClone(record));
        if (result.preview?.retryable) return;
        if (receipts.supersededEntry(broker.id, record) || receipts.state.signals[record.requestId]?.approvalClosed) {
          progress(broker, record, { status: "CANCELLED", reason: "계좌 확인 중 청산 신호 수신 또는 승인 결정 완료" });
          receipts.completeBroker(item, broker.id);
          return;
        }
        if (result.preview?.blocked) {
          progress(broker, record, { status: "BLOCKED", reason: result.preview.reason });
          if (!skippedExistingEntry(record, result.preview)) await send(channels.execution,
            formatUncreatedOrder(brokerAccountLabel(broker), record, { title: "주문 차단", reason: result.preview.reason }));
        } else if (!receipts.state.signals[record.requestId]?.declined) {
          const previous: any = Object.values(receipts.state.pending).find((pending: any) => pending.record.requestId === record.requestId);
          const combined = { ...(previous?.record.requestId === record.requestId ? previous.previews : {}), [broker.id]: result };
          const pending = receipts.putPending(record, receipts.signal(record).messageId,
            Math.max(1, Math.min(approvalTtlMs, item.expiresAt - Date.now())), Object.keys(combined));
          pending.previews = combined;
          progress(broker, record, { status: "APPROVAL" });
        }
      } else {
        await executeOrDefer(broker, structuredClone(record));
      }
      receipts.completeBroker(item, broker.id);
    } catch (error) {
      progress(broker, record, { status: "DEFER_REQUIRED", reason: "계좌 확인 실패 · 15초 주기 재확인" });
      await reportError(`${broker.label} 신호 처리 재시도 대기`, error, record);
    } finally {
      if (brokers.every(broker => item.completed.includes(broker.id))) {
        delete receipts.state.inbox[record.requestId];
        receipts.write();
      }
      void refreshLifecycleCards();
    }
  }

  async function retryApprovalCards() {
    for (const pending of Object.values(receipts.state.pending) as any[]) {
      const entry = receipts.signal(pending.record);
      entry.messageId ||= pending.messageId;
    }
    await refreshLifecycleCards();
  }

  async function retryInbox() {
    await Promise.all(brokers.map(broker => brokerWork(broker, async () => {
      for (const item of Object.values(receipts.state.inbox) as any[]) await processInboxBroker(item, broker);
    }, "inbox-recovery")));
    await retryApprovalCards();
  }

  async function processOwnerCommand(message) {
    if (!await acceptsOwnerMessage(message, [channels.system, channels.order])) return false;
    const command = accountCommand(message.content, executorName);
    if (!command) return false;
    if (command === "HELP") {
      await message.reply(["🧾 **계좌 주문 실행기 명령어**", "`!account status`", "`!account orders`", "`!account protection` · 증권사 보호주문 상태 (주문 없음)", "`!account performance` · 전략별 성과·총자산·후보 비교 자료", "`!account reconcile` · 증권사 증빙 대조 (주문 없음)", "`!account import` · 로컬 명세서 체결·입출금 증빙 반영 (주문 없음)", "`!account auto on` / `!account auto off` / `!account auto status`", "수동 BUY 승인: `사줘`·`둘다` / `키움만` / `한투만` / `안 사`"].join("\n"));
    } else if (command === "PROTECTION") {
      const report = brokers.map(broker => ({ broker: broker.id, environment: broker.environment,
        enabled: broker.protectionEnabled === true, readiness: protectionReadiness(broker, "NASDAQ") || "STOP API 연계 활성 · 개별 주문 조회 필요",
        orders: broker.tracker.list().filter(brokerStop).map(o => ({ symbol: o.symbol, status: o.status, quantity: o.orderQuantity,
          filled: o.filledQuantity, remaining: o.remainingQuantity, stopPrice: o.stopPrice, verifiedAt: o.protectionVerifiedAt || null })) }));
      await message.reply({ content: "증권사 보호주문 상태입니다. 활성 설정과 실제 주문 접수는 별개이며 장 종료 후 유지 여부를 보장하지 않습니다.",
        files: [{ name: "broker-protection.json", attachment: Buffer.from(JSON.stringify(report, null, 2)) }] });
    } else if (command === "RECONCILE" || command === "IMPORT_EVIDENCE") {
      if (readOnly || !receipts.file) { await message.reply("읽기 전용 모드에서는 기록도 변경하지 않습니다."); return true; }
      await message.reply("증빙 대조를 시작합니다. 주문·취소 요청은 보내지 않습니다.");
      const reports = [];
      for (const broker of brokers) await brokerWork(broker, async () => {
        try {
        if (command === "RECONCILE") { reports.push(await reconcileEvidence(broker)); return; }
        const file = `${receipts.file}.${broker.id}.statement.json`;
        if (!fs.existsSync(file)) { reports.push({ broker: broker.id, reason: "로컬 명세서 파일 없음" }); return; }
        const input = JSON.parse(fs.readFileSync(file, "utf8"));
        const rows = validateStatement(input, broker);
        const proofFile = evidenceFile(receipts.file), state = readEvidence(proofFile);
        importCashFlows(state, input, broker); // Validate the entire cash-flow section before touching orders.
        const reconciliation = reconciliationPlan(broker.tracker.list(), rows, broker.environment);
        if (reconciliation.conflicts.length) throw Error("명세서 충돌 · 주문번호/날짜/수량을 확인하세요.");
        writeEvidence(proofFile, state);
        const changed = applyEvidence(broker, { brokerId: broker.id, environment: broker.environment, capturedAt: new Date().toISOString(), reconciliation, costs: { updates: [] }, source: input.source }, proofFile);
        reports.push({ broker: broker.id, changed, cashFlowCoverageImported: Boolean(input.cashFlowCoverage) });
        } catch (error) { reports.push({ broker: broker.id, error: error.message }); throw error; }
      }, "evidence");
      await message.reply({ content: "대조 결과입니다. 미지원 조회는 명세서 증빙이 필요하며 잔고 차이만으로 체결을 만들지 않습니다.", files: [{ name: "account-reconciliation.json", attachment: Buffer.from(JSON.stringify(reports, null, 2)) }] });
      void requestPortfolioSync();
    } else if (command === "PERFORMANCE") {
      const file = process.env.TRADING_DECISION_LOG_FILE || "trading-decisions.jsonl";
      const decisions = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
      const latest = new Map(decisions.map(row => [row.requestId, row]));
      const evidence = receipts.file ? readEvidence(evidenceFile(receipts.file)) : { equity: [], cashFlows: [], cashFlowCoverage: [] };
      const studyFile = "forward-policy-study.json";
      const report = { at: new Date().toISOString(), notes: "실제 체결·최종청산 기준. 비용 미확인은 null. 신호가 대비 체결 차이는 실제 손익에 이미 반영되어 재차 차감하지 않음. 실현손익 낙폭은 계좌 MDD가 아님.",
        accounts: brokers.map(broker => ({ broker: broker.id, environment: broker.environment, ...strategyComparison(broker, receipts.state.signals) })),
        accountEquity: brokers.flatMap(broker => [...equityScopes(broker),
          ...(broker.id === "KIWOOM" && broker.domesticClient ? ["account-total-assets"] : [])].flatMap(scope => {
          const accountRef = equityAccountRef(evidence, broker, scope);
          const scopes = new Map(evidence.equity.filter(row => row.accountRef === accountRef).map(row => [`${row.currency}:${row.scope}`, row]));
          return [...scopes.values() as Iterable<any>].map(row => ({ accountRef, scope: row.scope,
            ...equityPerformance(evidence, broker.id, broker.environment, row.currency, { accountRef, scope: row.scope }) }));
        })),
        evidenceStatus: Object.values(evidence.brokers || {}).map((row: any) => ({ brokerId: row.brokerId, environment: row.environment,
          capturedAt: row.capturedAt, discrepancies: row.remainingDiscrepancies, historyErrors: row.historyErrors,
          transactionError: row.transactionError, equityError: row.equityError })),
        forwardStudy: fs.existsSync(studyFile) ? JSON.parse(fs.readFileSync(studyFile, "utf8")) : { observations: [], reason: "새 신호 수신 후 비교 시작" },
        commonSignalBlocks: [...latest.values() as Iterable<any>].filter(row => String(row.verdict).startsWith("BLOCKED"))
          .map(({ requestId, at, ticker, timeframe, signalCode, sigmaZ, policyVersion, verdict, reason }) => ({ requestId, at, ticker, timeframe, signalCode, sigmaZ, policyVersion, verdict, reason })) };
      await message.reply({ ...formatStrategyComparisonMessage(brokers, receipts.state.signals), files: [{ name: "strategy-performance.json", attachment: Buffer.from(JSON.stringify(report, null, 2)) }] });
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

  async function listen() {
    const publishHealth = () => {
      try {
        writeAccountHealth(receipts.file, { discordReady: client.isReady(), initialized, workerAt,
          brokerQueriesHealthy: stopMonitorOutages.size === 0,
          uncertainOrders: brokers.some(broker => broker.tracker.list().some(order => order.status === "UNKNOWN" || order.reconciliationRequired === true))
            || Object.values(receipts.state.protection || {}).some((intent: any) => intent.status === "UNKNOWN" || (intent.status === "SUBMITTING" && Date.now() - Date.parse(intent.createdAt) > 60_000))
            || Object.entries(receipts.state.attempts).some(([key, attempt]: [string, any]) => attempt.status === "UNKNOWN" || (attempt.status === "SUBMITTING" && !submitting.has(key))) });
      } catch (error) { console.error("실행기 상태 기록 실패:", error.message); }
    };
    publishHealth();
    setInterval(publishHealth, 15_000).unref();
    client.on("messageCreate", (message) => {
      void (async () => {
        if (await processOwnerCommand(message)) return;
        if (await processApproval(message)) return;
        await processMessage(message);
      })().catch((error) => reportError("Discord 메시지 처리 실패", error));
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
      ) }).catch(error => reportError("시작 알림 전송 실패", error));
      if (!readOnly) for (const broker of brokers) void brokerWork(broker, () => reconcileOrders([broker]), "reconcile");
      void requestPortfolioSync();
      setInterval(requestEquitySync, 60 * 60_000).unref();
      const refreshEvidence = () => {
        if (readOnly || !receipts.file) return;
        let saved;
        try { saved = readEvidence(evidenceFile(receipts.file)); }
        catch (error) { void reportError("증빙 파일 확인 필요", error); return; }
        for (const broker of brokers) {
          const at = Date.parse(saved.brokers[`${broker.id}:${broker.environment}`]?.capturedAt || "");
          if (!Number.isFinite(at) || Date.now() - at >= 24 * 60 * 60_000) void brokerWork(broker, () => reconcileEvidence(broker), "evidence");
        }
      };
      refreshEvidence();
      setInterval(refreshEvidence, 60 * 60_000).unref();
      setInterval(() => {
        void requestPortfolioSync();
      }, portfolioSyncMinutes * 60_000).unref();
      for (const channelId of sourceChannelIds) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased()) continue;
          const recent = [...(await channel.messages.fetch({ limit: 50 })).values()].reverse();
          for (const message of recent) void processMessage(message).catch(error => reportError("시작 신호 복구 실패", error));
        } catch (error) { await reportError("시작 신호 채널 조회 실패", error); }
      }
      initialized = true;
      workerAt = Date.now();
      publishHealth();
      setInterval(() => {
        for (const broker of brokers) void brokerWork(broker, () => {}, "heartbeat");
        void refreshLifecycleCards();
      }, 15_000).unref();
      if (!readOnly) {
        setInterval(() => {
          void retryInbox().catch(error => reportError("수신 신호 재확인 실패", error));
          for (const broker of brokers) void brokerWork(broker, () => retryDeferred(new Date(), [broker]), "deferred");
        }, 15_000).unref();
        setInterval(() => {
          for (const broker of brokers) void brokerWork(broker, async () => {
            await checkInvalidations(new Date(), [broker]);
            await reconcileOrders([broker]);
            await checkManagedStops([broker]);
          }, "reconcile");
        }, 30_000).unref();
      }
    });
    await client.login(process.env.ACCOUNT_DISCORD_TOKEN || process.env.KIS_DISCORD_TOKEN || process.env.DISCORD_TOKEN_DRUCKENMILLER);
  }
  return { listen, execute, executeOrDefer, retryDeferred, retryInbox, processMessage, processApproval, processOwnerCommand, reconcileOrders, checkManagedStops, refreshLifecycleCards, reportEquityStatus, reportDataStatus };
}

if (require.main === module) start().catch(require("../../scripts/network-failure.cjs").fatal);


module.exports = { createAccountRuntime, SignalReceiptStore, accountCommand, accountContext, accountPortfolioSyncMinutes, accountRiskPolicy, accountSymbol, applyPyramidSizing, approvalCard, approvalText, approvedEntryVerdict, availableApprovalBrokerIds, brokerEnvironments, buyApprovalRequiredForBroker, deferredOrderAttemptDue, discordMessagePayload, enabledBrokerIds, enforceOpenRiskLimit, enforceOwnAccountRules, errorReportDue, executionPreview, invalidationExitReason, liveAutoBuyEligible, marketTransitionRetryDelayMs, momentumExitRecommendation, orderAttemptKey, orderNeedsPortfolioSync, orderNeedsResultReport, orderStatusUnknown, pendingSymbolOrder, pyramidPlan, readOnlySignalAllowed, reconcilePendingBrokerOrders, requiresExistingPosition, shouldConsumeMessage, shouldRetryMarketTransition, signalExchange, skippedExistingEntry, skippedNoPosition, start, trackedPortfolio, verificationDelayMs };
