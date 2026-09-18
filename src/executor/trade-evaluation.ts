"use strict";

const { usSession, usSessionClock } = require("../trading/paper-order-executor");
const { tradingDay } = require("../trading/market-calendar");
const { normalizedSymbol } = require("../trading/position-ownership");

const EVALUATION_REASONS = {
  MOCK_SESSION_LIMIT: "모의 거래시간 제한",
  SYSTEM_INCIDENT: "시스템·조회 장애 기록",
  POLICY_CHANGE: "보유 중 정책 변경",
  DATA_INSUFFICIENT: "정책·시각 증빙 부족",
  EXECUTION_DELAY_UNATTRIBUTED: "실행·확인 지연 (원인 미확정)",
  REVIEW_REQUIRED: "기타 검토 필요",
};
// An evaluation flag, not an order timeout or proof of an outage.
const DELAY_REVIEW_MS = 5 * 60_000;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function issueCategory(issue) {
  if (/정책 변경/.test(issue)) return "POLICY_CHANGE";
  if (/장애|404|502|504|Gateway|조회 실패|네트워크/.test(issue)) return "SYSTEM_INCIDENT";
  return "REVIEW_REQUIRED";
}

function evaluateExecution(order, signal: any = {}, broker: any = {}) {
  const record = signal.record;
  const matches = record?.payload && normalizedSymbol(record.payload.ticker) === normalizedSymbol(order.symbol) && record.payload.action === order.side;
  const received = timestamp(order.signalReceivedAt || (matches ? record.receivedAt : null));
  const requested = timestamp(order.orderRequestedAt);
  const accepted = timestamp(order.orderAcceptedAt);
  // lastFillAt is a local observation unless a broker statement explicitly proves it.
  const filled = timestamp(order.evidenceFilledAt);
  const observed = timestamp(order.lastFillAt);
  const end = filled ?? observed;
  const categories = new Set<string>();
  for (const issue of order.evaluationIssues || []) categories.add(issueCategory(issue));
  const history = matches ? (signal.progressHistory || []).filter(h => h.brokerId === broker.id
    && typeof h.updatedAt === "number" && received !== null && h.updatedAt >= received
    && accepted !== null && h.updatedAt <= accepted) : [];
  for (const h of history) {
    if (/장애|404|502|504|Gateway|조회 실패|네트워크/.test(h.reason || "")) categories.add("SYSTEM_INCIDENT");
    else if (["DEFER_REQUIRED", "APPROVAL", "UNKNOWN"].includes(h.status)) categories.add("REVIEW_REQUIRED");
  }
  if (!/^[a-f0-9]{64}$/.test(order.policyHash || "") || received === null || requested === null
    || accepted === null || end === null || requested < received || accepted < requested || end < requested) {
    categories.add("DATA_INSUFFICIENT");
  }
  const market = String(order.market || "").toUpperCase();
  if ((order.environment || broker.environment) === "mock" && received !== null
    && ["NASDAQ", "NYSE", "AMEX", "NYSEARCA", "ARCA", "ND", "NY", "NA"].includes(market)) {
    const at = new Date(received), clock = usSessionClock(at);
    const day = tradingDay("US", clock.date, clock.weekday);
    if (!day.known) categories.add("DATA_INSUFFICIENT");
    else if (usSession(at) !== "REGULAR") categories.add("MOCK_SESSION_LIMIT");
  }
  const interval = (a, b) => a !== null && b !== null && b >= a ? b - a : null;
  const timing = {
    signalReceivedAt: received === null ? null : new Date(received).toISOString(),
    orderRequestedAt: requested === null ? null : new Date(requested).toISOString(),
    orderAcceptedAt: accepted === null ? null : new Date(accepted).toISOString(),
    brokerFilledAt: filled === null ? null : new Date(filled).toISOString(),
    fillObservedAt: observed === null ? null : new Date(observed).toISOString(),
    signalToRequestMs: interval(received, requested), requestToAcceptanceMs: interval(requested, accepted),
    acceptanceToFillMs: interval(accepted, end), fillTimeSource: filled !== null ? "BROKER_EVIDENCE" : observed !== null ? "LOCAL_OBSERVATION" : "UNKNOWN",
  };
  if ((timing.signalToRequestMs !== null && timing.signalToRequestMs > DELAY_REVIEW_MS && !categories.has("MOCK_SESSION_LIMIT"))
    || (timing.requestToAcceptanceMs !== null && timing.requestToAcceptanceMs > DELAY_REVIEW_MS)
    || (timing.acceptanceToFillMs !== null && timing.acceptanceToFillMs > DELAY_REVIEW_MS)) {
    categories.add("EXECUTION_DELAY_UNATTRIBUTED");
  }
  return { categories: [...categories], timing };
}

function evaluationSummary(completed) {
  const eligible = completed.filter(t => !t.evaluationCategories.length);
  const reasons = {};
  for (const trade of completed) for (const code of trade.evaluationCategories) reasons[code] = (reasons[code] || 0) + 1;
  const cohorts = new Map();
  for (const trade of eligible) {
    const key = JSON.stringify([trade.policyHash, trade.currency]);
    if (!cohorts.has(key)) cohorts.set(key, { policy_hash: trade.policyHash, currency: trade.currency,
      count: 0, wins: 0, losses: 0, draws: 0, win_rate: null, profit_loss: 0, net_profit_loss: 0, unknown_costs: 0 });
    const c = cohorts.get(key); c.count++; c.profit_loss += trade.profitLoss;
    c[trade.profitLoss > 0 ? "wins" : trade.profitLoss < 0 ? "losses" : "draws"]++;
    if (trade.netProfitLoss === null) { c.unknown_costs++; c.net_profit_loss = null; }
    else if (c.net_profit_loss !== null) c.net_profit_loss += trade.netProfitLoss;
    c.win_rate = c.wins + c.losses ? c.wins / (c.wins + c.losses) * 100 : null;
  }
  return { version: 1, total_count: completed.length, eligible_count: eligible.length,
    excluded_count: completed.length - eligible.length, reason_counts: reasons, cohorts: [...cohorts.values()] };
}

module.exports = { EVALUATION_REASONS, DELAY_REVIEW_MS, evaluateExecution, evaluationSummary, issueCategory };
