"use strict";

const assert = require("node:assert/strict");
const {
  formatBuyApproval,
  formatDailyJournal,
  formatOrderStatus,
  formatWebhookRecord,
} = require("./webhook-discord");

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
assert.equal(normal.embed.color, 0x57F287);
assert.equal(normal.embed.title, "🟢 A · 💰 정석 진입 @SR↩");
assert(normal.embed.description.includes("삼성전자 (005930)"));
assert(normal.embed.description.includes("80,000원 · SL 77,500원 · R/R 2.2"));
assert(normal.embed.fields.some((field) => field.name === "AI 평가" && field.value === "상승 추세"));
assert(normal.embed.fields.some((field) => field.name === "자동매매" && field.value.includes("PAPER_ENTRY")));
assert.equal(normal.embed.footer.text, "Lazy Alpha");
assert.equal(normal.embed.timestamp, undefined);

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
assert.equal(observation.embed.color, 0xFEE75C);

const usTrade = formatWebhookRecord({
  ...base,
  payload: { ...base.payload, ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ" },
});
assert.equal(usTrade.targetChannel, "미국-매매신호");
assert(usTrade.embed.description.includes("NVIDIA (NVDA)"));

const domesticObservation = formatWebhookRecord({
  ...base,
  payload: { ...base.payload, action: "CHECK" },
  risk: { verdict: "NO_ACTION", reason: "주문 대상이 아닌 신호" },
  outcome: { ...base.outcome, decision: "INFO_ONLY" },
});
assert.equal(domesticObservation.targetChannel, "국장-관찰신호");

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

const clipped = formatWebhookRecord({
  ...base,
  payload: {
    ...base.payload,
    name: "가".repeat(2_000), type: "나".repeat(2_000), status: "다".repeat(2_000),
    ema_align: "라".repeat(2_000), ai_summary: "마".repeat(2_000), desc: "바".repeat(2_000),
    market: "사".repeat(2_000),
  },
  risk: { verdict: "PAPER_ENTRY", reason: "아".repeat(2_000) },
});
assert.equal(clipped.embed.fields.find((field) => field.name === "AI 평가").value.length, 1_024);
assert([
  clipped.embed.title,
  clipped.embed.description,
  clipped.embed.footer.text,
  ...clipped.embed.fields.flatMap((field) => [field.name, field.value]),
].reduce((sum, value) => sum + value.length, 0) <= 6_000);

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
assert.equal(order.embed.title, "⏳ BUY · 부분 체결");
assert(order.embed.description.includes("Apple Inc. (AAPL)"));

const approval = formatBuyApproval(base, {
  ticker: "005930", name: "삼성전자",
}, 15);
assert.equal(approval.embed.title, "⏳ BUY 승인 대기 · A");
assert(approval.embed.description.includes("삼성전자 (005930)"));
assert(approval.embed.fields.some((field) => field.name === "승인" && field.value.includes("사줘 005930")));

const journal = formatDailyJournal("2026-08-21", ["- 09:10 · **BUY** · 삼성전자 (005930) · 1주 @ 80,000원"]);
assert.equal(journal.embed.title, "📘 2026-08-21 모의매매 일지");
assert(journal.embed.description.includes("삼성전자 (005930)"));

console.log("webhook-discord test OK");
