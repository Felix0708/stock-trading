"use strict";

const assert = require("node:assert/strict");
const { formatOrderStatus, formatWebhookRecord } = require("./webhook-discord");

const base = {
  requestId: "request-1",
  payload: {
    ticker: "005930", name: "삼성전자", exchange: "KRX", timeframe: "240",
    action: "BUY", type: "💰 정석 진입 @SR↩", price: 80000, sl: 77500, rr: 2.2,
    conviction: "A", score: 82, ai_summary: "상승 추세", atr_dot: false,
  },
  validation: { ok: true, errors: [] },
  outcome: {
    decision: "ENTRY_CANDIDATE", duplicate: false, orderCreated: false, warnings: [],
    signal: { signalCode: "ENTRY_STANDARD", modifiers: ["SR_FLIP"] },
  },
  risk: { verdict: "PAPER_ENTRY", reason: "키움 모의 진입 주문 대기" },
};

const normal = formatWebhookRecord(base);
assert.equal(normal.channel, "signal");
assert.equal(normal.targetChannel, "국장-매매신호");
assert(normal.text.includes("💰 정석 진입 @SR↩"));
assert(normal.text.includes("ENTRY_STANDARD"));
assert(normal.text.includes("생성 안 됨"));
assert(normal.text.includes("`ai_summary`: \"상승 추세\""));
assert(normal.text.includes("`atr_dot`: false"));

const observation = formatWebhookRecord({
  ...base,
  payload: { ...base.payload, ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ", action: "CHECK" },
  risk: { verdict: "NO_ACTION", reason: "주문 대상이 아닌 신호" },
  outcome: {
    ...base.outcome,
    decision: "INFO_ONLY",
    signal: { signalCode: "SETUP_FORMING", modifiers: [] },
  },
});
assert.equal(observation.targetChannel, "미국-관찰신호");
assert(observation.text.includes("TradingView 관찰 신호"));

const dailyReview = formatWebhookRecord({
  ...base,
  risk: { verdict: "REVIEW_DAILY_CONFIRMATION", reason: "일봉 강세·정배열 미확정 — 주문 없이 검토" },
});
assert.equal(dailyReview.targetChannel, "국장-관찰신호");
assert(dailyReview.text.includes("TradingView 관찰 신호"));

const pendingApproval = formatWebhookRecord({
  ...base,
  risk: { verdict: "BUY_PENDING_APPROVAL", reason: "사용자 BUY 승인 대기" },
});
assert.equal(pendingApproval.targetChannel, "국장-매매신호");

const sized = formatWebhookRecord({
  ...base,
  positionPreview: {
    available: true, blocked: false, equity: 100000, availableCash: 90000,
    quantity: 55, positionValue: 13750, stopLossAmount: 550, riskBudget: 550, currency: "USD",
  },
});
assert(sized.text.includes("55주"));
assert(sized.text.includes("$13,750"));
const krwSized = formatWebhookRecord({
  ...base,
  positionPreview: {
    available: true, blocked: false, equity: 500000000, availableCash: 400000000,
    quantity: 10, positionValue: 800000, stopLossAmount: 25000, riskBudget: 2500000, currency: "KRW",
  },
});
assert(krwSized.text.includes("800,000원"));
const sizingBlocked = formatWebhookRecord({
  ...base,
  positionPreview: { available: true, blocked: true, reason: "ATR 과열" },
});
assert(sizingBlocked.text.includes("차단 — ATR 과열"));

const duplicate = formatWebhookRecord({ ...base, outcome: { ...base.outcome, duplicate: true } });
assert.equal(duplicate.channel, "system");
assert(duplicate.text.includes("중복 신호 무시"));

const rejected = formatWebhookRecord({
  ...base,
  validation: { ok: false, errors: ["필수 필드 누락: ticker"] },
  outcome: { decision: "REJECTED_INVALID", orderCreated: false, warnings: [] },
});
assert.equal(rejected.channel, "system");
assert(rejected.text.includes("웹훅 차단"));
assert(rejected.text.includes("필수 필드 누락"));

const order = formatOrderStatus({
  orderNo: "000000282", symbol: "AAPL", name: "Apple Inc.", side: "BUY", status: "PARTIALLY_FILLED",
  orderQuantity: 2, filledQuantity: 1, remainingQuantity: 1,
});
assert.equal(order.channel, "system");
assert(order.text.includes("Apple Inc. (AAPL)"));
assert(order.text.includes("PARTIALLY_FILLED"));
assert(order.text.includes("0282"));

console.log("webhook-discord test OK");
