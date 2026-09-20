"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const { normalizedTimeframe, normalizedSymbol, positionMarket } = require("./position-ownership");
const { tradingDay } = require("./market-calendar");
const POLICY_VERSION = "2026-09-14-mock-allocation-v2";
function policyFingerprint(env = process.env) {
  const hash = createHash("sha256");
  for (const file of ["position-sizer.ts", "position-ownership.ts", "trade-controller.ts", "paper-order-executor.ts", "../executor/account-executor.ts", "../executor/entry-allocation.ts", "../executor/broker-protection.ts", "../signals/signal-state-machine.ts", "../signals/nested-webhook.ts", "../signals/signal-normalizer.ts"]) {
    hash.update(file); hash.update(fs.readFileSync(path.join(__dirname, file)));
  }
  for (const key of ["ACCOUNT_ENTRY_ALLOCATION", "ACCOUNT_BROKER_PROTECTION", "KIS_LIVE_AFTER_MARKET_EXTENDED", "ACCOUNT_AUTO_CAP_RATIO", "ACCOUNT_MAX_OPEN_RISK_RATIO", "MAX_OPEN_POSITIONS", "PARTIAL_EXIT_1_RATIO", "PARTIAL_EXIT_2_RATIO", "BUY_APPROVAL_TTL_MINUTES", "ACCOUNT_SIGNAL_MAX_AGE_MINUTES", "KIS_SIGNAL_MAX_AGE_MINUTES"]) hash.update(`${key}=${env[key] || "default"}\n`);
  return hash.digest("hex");
}
function assertLivePolicy(environments, readOnly, hash, env = process.env) {
  if (!readOnly && Object.values(environments).includes("live") && env.ACCOUNT_APPROVED_POLICY_HASH !== hash) throw Error(`실계좌 정책 검토·고정 필요: ACCOUNT_APPROVED_POLICY_HASH=${hash}`);
}

// A research deadline, not an order deadline. Reuse the exchange calendar, including holidays/DST.
function nextDailyClose(exchange, at) {
  if (!["KRX", "KOSPI", "KOSDAQ", "NASDAQ", "NYSE", "AMEX", "NYSEARCA", "ARCA"].includes(exchange)) return null;
  const { domesticSessionClock, usSessionClock } = require("./paper-order-executor");
  const market = positionMarket(exchange), clock = market === "KRX" ? domesticSessionClock : usSessionClock;
  const sourceDate = clock(new Date(at)).date;
  const noon = Math.floor(at / 86400000) * 86400000 + 12 * 3600000;
  for (let d = 0; d <= 10; d++) {
    const seed = noon + d * 86400000, local = clock(new Date(seed));
    if (local.date <= sourceDate) continue;
    const day = tradingDay(market, local.date, local.weekday);
    if (!day.known) return null;
    if (day.closed) continue;
    return seed + ((market === "KRX" ? 930 : day.early ? 780 : 960) - local.minutes) * 60000;
  }
  return null;
}

function observeEntryTiming(state, record, policyHash, now) {
  const study = state.entryTiming ||= { version: 1, startedAt: new Date(now).toISOString(),
    baselineHash: policyHash || null, status: "COLLECTING", events: [], candidates: [] };
  if (!policyHash || study.baselineHash !== policyHash) study.status = "PAUSED_POLICY_CHANGE";
  const p = record.payload, at = Date.parse(record.receivedAt), frame = normalizedTimeframe(p.timeframe);
  if (study.events.some(e => e.requestId === record.requestId)) return;
  const instrument = `${positionMarket(p.exchange)}:${normalizedSymbol(p.ticker)}`;
  const event = { requestId: record.requestId, at: record.receivedAt, instrument, timeframe: frame,
    action: p.action, signalCode: record.outcome?.signal?.signalCode || "UNKNOWN", decision: record.outcome?.decision,
    price: p.price, stopPrice: p.sl ?? null, sigma: p.sb_z_score ?? null,
    verdict: record.risk?.verdict || "UNKNOWN", reason: record.risk?.reason || "", policyHash: policyHash || null };
  study.events.push(event); // Includes blocked entries, exits and CHECK signals; no fictitious fills.
  if (at < (study.lastObservedAt || 0)) { event["excludedReason"] = "OUT_OF_ORDER"; return; }
  study.lastObservedAt = at;
  if (study.status !== "COLLECTING") {
    for (const c of study.candidates.filter(c => c.status === "WAITING")) c.status = "POLICY_CHANGED";
    return;
  }
  const isEntry = p.action === "BUY" && record.outcome?.decision === "ENTRY_CANDIDATE";
  for (const c of study.candidates.filter(c => c.status === "WAITING")) {
    if (now >= c.expiresAt) { c.status = "EXPIRED"; continue; }
    if (c.instrument !== instrument || at <= Date.parse(c.at)) continue;
    if (["EXIT_CANDIDATE", "EXIT_IF_FILLED"].includes(event.decision)
      || ["ENTRY_INVALIDATED", "ENTRY_EXPIRED", "PEG_INVALIDATED", "PEG_EXPIRED", "RANGE_ENTRY_BLOCK"].includes(event.signalCode)) {
      c.status = "INVALIDATED"; c.closedBy = event.requestId;
    } else if (frame === "1D" && isEntry) {
      c.status = "SUPERSEDED"; c.closedBy = event.requestId;
    } else if (frame === "240" && isEntry) {
      c.status = "NEW_4H_SIGNAL"; c.trigger = event;
      c.referencePriceChangePct = (p.price / c.price - 1) * 100;
      c.executionStatus = "NOT_SIMULATED"; // Account gates and intrabar paths are not observable here.
    }
  }
  if (frame === "1D" && isEntry) {
    const expiresAt = nextDailyClose(p.exchange, at);
    study.candidates.push({ ...event, expiresAt, status: expiresAt === null ? "CALENDAR_UNKNOWN" : "WAITING" });
  }
}

function entryTimingSummary(state, signals = {}, now = Date.now(), brokers = []) {
  const study = state.entryTiming;
  if (!study) return { status: "NOT_STARTED", candidates: [], note: "새 신호 수신부터 비교 기록 시작" };
  const results = requestId => {
    const progress = { ...signals[requestId]?.progress };
    for (const broker of brokers) {
      const order = broker.tracker.list().find(o => o.requestId === requestId && o.environment === broker.environment);
      if (order) progress[broker.id] = { ...progress[broker.id], orderStatus: order.status,
        filledQuantity: order.filledQuantity, remainingQuantity: order.remainingQuantity,
        reconciliationRequired: Boolean(order.reconciliationRequired), policyHash: order.policyHash || null };
    }
    return progress;
  };
  const candidates = study.candidates.map(c => ({ ...c,
    status: c.status === "WAITING" && now >= c.expiresAt ? "EXPIRED" : c.status,
    baselineAccountResults: results(c.requestId),
    triggerAccountResults: c.trigger ? results(c.trigger.requestId) : {} }));
  return { status: study.status, startedAt: study.startedAt, baselineHash: study.baselineHash,
    counts: candidates.reduce((counts, c) => { counts[c.status] = (counts[c.status] || 0) + 1; return counts; }, {}), candidates,
    hypotheticalNetReturn: null, hypotheticalMaxDrawdown: null,
    note: "관찰 비교만: 전체 일봉 진입 후보와 최초 새 4시간봉 진입을 연결. 계좌별 차단 이유는 별도 대조. 신호 가격 차이는 수익률이 아니며 가상 체결·비용·낙폭을 만들지 않음. 다음 거래일 정규장 마감은 연구용 기한이며 실제 알림 세션 확인 필요." };
}

function recordForwardStudy(file, record, options = {}) {
  const p = record.payload || {}, time = Date.parse(record.receivedAt), now = (options as any).now ?? Date.now();
  if ((options as any).recovered || p.paper_order_test || !record.requestId || !record.validation?.ok || !normalizedTimeframe(p.timeframe) || !(p.price > 0)
    || !Number.isFinite(time) || time > now || now - time > 30 * 60_000) return false;
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, startedAt: new Date(now).toISOString(), observations: [] };
  if (time < Date.parse(state.startedAt) - 30_000 || state.observations.some(row => row.requestId === record.requestId)) return false;
  observeEntryTiming(state, record, (options as any).policyHash, now);
  const key = `${p.exchange}:${p.ticker}:${normalizedTimeframe(p.timeframe)}`;
  // Next same-timeframe observed signal, not a fictitious fill or a fixed-horizon return.
  for (const row of state.observations.filter(row => row.key === key && !row.nextObservation && Date.parse(row.at) < time)) {
    row.nextObservation = { at: record.receivedAt, price: p.price, priceChangePct: (p.price / row.price - 1) * 100 };
  }
  if (p.action === "BUY" && ["ENTRY_CANDIDATE", "ADD_CANDIDATE"].includes(record.outcome?.decision)) {
    const sigma = typeof p.sb_z_score === "number" && Number.isFinite(p.sb_z_score) ? p.sb_z_score : null;
    state.observations.push({ requestId: record.requestId, key, at: record.receivedAt, price: p.price, sigma,
      commonVerdict: record.risk?.verdict, policyVersion: POLICY_VERSION, policyHash: (options as any).policyHash,
      comparison: { liveSigmaCeiling25: sigma === null ? null : sigma <= 2.5, mockSigmaCeiling35: sigma === null ? null : sigma <= 3.5 },
      note: "Sigma 필터만 비교. 다른 게이트·현금·체결·부분매매는 평가하지 않음. 실제 승률/수익률이 아님." });
  }
  // ponytail: JSON forward observations; archive completed observations if rewrite size becomes material.
  const temporary = `${file}.tmp`, fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  return true;
}
module.exports = { POLICY_VERSION, policyFingerprint, assertLivePolicy, recordForwardStudy, nextDailyClose, entryTimingSummary };
