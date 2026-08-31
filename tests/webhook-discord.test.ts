"use strict";

const assert = require("node:assert/strict");
const { decodeSignalEmbed, encodeSignalEnvelope, TRANSPORT_URL_PREFIX } = require("../src/discord/discord-signal-envelope");
const {
  formatBrokerStartup,
  formatBuyApproval,
  formatDailyJournal,
  formatDeferredOrder,
  formatExecutorError,
  formatUncreatedOrder,
  formatOrderStatus,
  formatTradeJournal,
} = require("../src/discord/order-discord");
const {
  formatWebhookRecord,
  targetSignalChannels,
} = require("../src/discord/webhook-discord");

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
assert.deepEqual(targetSignalChannels(base), ["국장-전체신호", "국장-진입신호", "국장-매매신호"]);
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
assert.equal(normal.embed.footer, undefined);
assert.equal(normal.embed.author.name, "자동주문 연동");
assert(normal.embed.author.url.startsWith(TRANSPORT_URL_PREFIX));
assert.equal(decodeSignalEmbed(normal.embed).requestId, base.requestId);
assert.equal(decodeSignalEmbed({ footer: { text: encodeSignalEnvelope(base) } }).requestId, base.requestId);
assert.equal(normal.embed.timestamp, undefined);

const observationRecord = {
  ...base,
  payload: { ...base.payload, ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ", action: "CHECK" },
  risk: { verdict: "NO_ACTION", reason: "주문 대상이 아닌 신호" },
  outcome: {
    ...base.outcome,
    decision: "INFO_ONLY",
    signal: { signalCode: "SETUP_FORMING", modifiers: [] },
  },
};
const observation = formatWebhookRecord(observationRecord);
assert.equal(observation.targetChannel, "미국-관찰신호");
assert.deepEqual(targetSignalChannels(observationRecord), ["미국-전체신호", "미국-관찰신호"]);
assert(observation.text.includes("TradingView 관찰 신호"));
assert.equal(observation.embed.color, 0xFEE75C);

const usTrade = formatWebhookRecord({
  ...base,
  payload: { ...base.payload, ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ" },
});
assert.deepEqual(targetSignalChannels({
  ...base,
  payload: { ...base.payload, ticker: "NVDA", name: "NVIDIA", exchange: "NASDAQ" },
  orderAttempt: { status: "ERROR", reason: "키움 주문 실패" },
}), ["미국-전체신호", "미국-진입신호", "미국-매매신호"]);
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
assert.equal(dailyReview.targetChannel, "국장-진입신호");
assert(dailyReview.text.includes("TradingView 진입 신호"));

const pendingApproval = formatWebhookRecord({
  ...base,
  risk: { verdict: "BUY_PENDING_APPROVAL", reason: "사용자 BUY 승인 대기" },
});
assert.deepEqual(targetSignalChannels({
  ...base,
  risk: { verdict: "BUY_PENDING_APPROVAL" },
}), ["국장-전체신호", "국장-진입신호", "국장-매매신호"]);

assert.deepEqual(targetSignalChannels({
  ...base,
  payload: { ...base.payload, action: "SELL" },
  outcome: { ...base.outcome, decision: "PARTIAL_EXIT_CANDIDATE" },
}), ["국장-전체신호", "국장-청산신호", "국장-매매신호"]);

const sized = formatWebhookRecord({
  ...base,
  positionPreview: {
    available: true, blocked: false, equity: 100000, availableCash: 90000,
    quantity: 55, positionValue: 13750, stopLossAmount: 550, riskBudget: 550, currency: "USD",
  },
});
assert(sized.text.includes("55주"));
const liveSized = formatWebhookRecord({
  ...base,
  positionPreview: {
    available: true, blocked: false, equity: 5000000, availableCash: 5000000,
    totalAccountEquity: 50000000, autoCapital: 5000000, autoCapitalRatio: 0.1,
    currentOpenRisk: 50000, maxOpenRisk: 75000, maxOpenRiskRatio: 0.015,
    quantity: 10, positionValue: 1000000, projectedPositionRatio: 20, positionLimitRatio: 0.2,
    stopLossAmount: 25000, riskBudget: 25000, currency: "KRW",
  },
});
assert(liveSized.text.includes("실계좌 안전한도"));
assert(liveSized.text.includes("자동운용금 비중"));
assert(liveSized.text.includes("동시 손절위험"));
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
  clipped.embed.author.name,
  clipped.embed.author.url,
  ...clipped.embed.fields.flatMap((field) => [field.name, field.value]),
].reduce((sum, value) => sum + value.length, 0) <= 6_000);

const duplicate = formatWebhookRecord({ ...base, outcome: { ...base.outcome, duplicate: true } });
assert.equal(duplicate.channel, "system");
assert(duplicate.text.includes("중복 신호 무시"));

const rejected = formatWebhookRecord({
  ...base,
  payload: { ...base.payload, ai_summary: "원본 상세값" },
  validation: { ok: false, errors: ["필수 필드 누락: ticker"] },
  outcome: { decision: "REJECTED_INVALID", orderCreated: false, warnings: [] },
});
assert.equal(rejected.channel, "system");
assert(rejected.text.includes("웹훅 차단"));
assert(rejected.text.includes("필수 필드 누락"));
assert.equal(rejected.text.split("\n").length, 5);
assert.equal(rejected.text.includes("TradingView 원본 지표 전체값"), false);
assert.equal(rejected.text.includes("원본 상세값"), false);
assert.equal(rejected.text.includes("request_id"), false);

const order = formatOrderStatus({
  orderNo: "000000282", symbol: "AAPL", name: "Apple Inc.", side: "BUY", status: "PARTIALLY_FILLED",
  orderQuantity: 2, filledQuantity: 1, remainingQuantity: 1,
});
assert.equal(order.channel, "system");
assert(order.text.includes("애플 / Apple (AAPL)"));
assert(order.text.includes("PARTIALLY_FILLED"));
assert(order.text.includes("0282"));
assert.equal(order.embed.title, "⏳ BUY · 부분 체결");
assert(order.embed.description.includes("애플 / Apple (AAPL)"));
const kisOrder = formatOrderStatus({
  orderNo: "5678", symbol: "AAPL", name: "Apple Inc.", side: "BUY", status: "ACCEPTED",
  orderQuantity: 1, filledQuantity: 0, remainingQuantity: 1, brokerLabel: "한투 모의계좌",
});
assert(kisOrder.text.includes("한투 모의계좌 주문 상태"));
assert.equal(kisOrder.embed.footer.text, "한투 모의계좌");
const acceptedSizing = formatOrderStatus({
  orderNo: "1903", symbol: "SE", side: "BUY", status: "ACCEPTED", market: "NYSE",
  orderQuantity: 63, filledQuantity: 0, remainingQuantity: 63,
  limitPrice: 121.18, orderStrategy: "신호가·현재가 기준 상한 지정가",
  plannedInvestment: 7634.655, projectedPositionRatio: 7.634655, positionLimitRatio: 0.2, currency: "USD",
  pyramidStage: 2, pyramidRatio: 0.25, initialEntryQuantity: 8,
});
assert(acceptedSizing.text.includes("**예상 투입**: $7,634.66"));
assert(acceptedSizing.text.includes("**주문 후 예상 계좌 비중**: 7.63% / 최대 20%"));
assert(acceptedSizing.text.includes("**매수 상한가**: $121.18"));
assert(acceptedSizing.embed.fields.some((field) => field.name === "주문 방식" && field.value.includes("상한 지정가")));
assert(acceptedSizing.text.includes("피라미딩 2차 · 최초 진입 8주의 25%"));
const liveAcceptedSizing = formatOrderStatus({
  orderNo: "1904", symbol: "AAPL", side: "BUY", status: "ACCEPTED", market: "NASDAQ",
  orderQuantity: 2, filledQuantity: 0, remainingQuantity: 2, plannedInvestment: 500,
  projectedPositionRatio: 12.5, positionLimitRatio: 0.2, autoCapital: 4000, currency: "USD",
});
assert(liveAcceptedSizing.text.includes("**주문 후 예상 자동운용금 비중**"));
const filledSizing = formatOrderStatus({
  orderNo: "1903", symbol: "SE", side: "BUY", status: "FILLED", market: "NYSE",
  orderQuantity: 63, filledQuantity: 63, remainingQuantity: 0, fillPrice: 120.95,
  positionRatio: 7.62, currency: "USD",
});
assert(filledSizing.text.includes("**체결가**: $120.95"));
assert(filledSizing.text.includes("**실제 투입**: $7,619.85"));
assert(filledSizing.text.includes("**체결 후 계좌 비중**: 7.62%"));
assert(filledSizing.embed.fields.some((field) => field.name === "실제 투입·비중" && field.value.includes("7.62%")));
const tradeJournal = formatTradeJournal({
  orderNo: "9346", symbol: "SE", name: "SEA(ADR)", koreanName: "씨", englishName: "Sea Limited", side: "BUY", status: "FILLED", market: "NYSE",
  orderQuantity: 63, filledQuantity: 63, remainingQuantity: 0, fillPrice: 121.18,
  positionRatio: 7.64, currency: "USD", brokerLabel: "한투 모의계좌",
});
assert.equal(tradeJournal.embed.title, "📘 BUY · 매매 기록");
assert.equal(tradeJournal.embed.description, "**씨 / Sea Limited (SE)**");
assert(tradeJournal.text.includes("**실제 투입**: $7,634.34"));
assert(tradeJournal.text.includes("**체결 후 계좌 비중**: 7.64%"));
assert.equal(tradeJournal.embed.footer.text, "한투 모의계좌 체결 기준");
const legacySeaOrder = formatOrderStatus({
  orderNo: "1903", symbol: "SE", name: "씨이에이(ADS)", side: "BUY", status: "FILLED",
  orderQuantity: 63, filledQuantity: 63, remainingQuantity: 0,
});
assert.equal(legacySeaOrder.embed.description, "**씨 / Sea Limited (SE)**");

const approval = formatBuyApproval(base, {
  ticker: "005930", name: "삼성전자",
}, 15);
assert.equal(approval.embed.title, "⏳ BUY 승인 대기 · A");
assert(approval.embed.description.includes("삼성전자 (005930)"));
assert(approval.embed.fields.some((field) => field.name === "승인" && field.value.includes("사줘 005930")));

const journal = formatDailyJournal("2026-08-21", ["- 09:10 · **BUY** · 삼성전자 (005930) · 1주 @ 80,000원"]);
assert.equal(journal.embed.title, "📘 2026-08-21 모의매매 일지");
assert(journal.embed.description.includes("삼성전자 (005930)"));
assert.equal(formatDailyJournal("2026-08-21", [], "한투 모의계좌").embed.footer.text, "한투 모의계좌 체결 기준");
assert.equal(
  formatBrokerStartup("공통 신호 서버", "드러켄밀러#2229", "TradingView 웹훅 수신 · 계좌 중립 신호 전달"),
  "✅ 공통 신호 서버 연결 · 드러켄밀러#2229\nTradingView 웹훅 수신 · 계좌 중립 신호 전달 · 실계좌 차단",
);
assert.equal(formatBrokerStartup("계좌 실행기", "봇#1", "키움 모의", "실계좌 지원 · 현재 잠금"), "✅ 계좌 실행기 연결 · 봇#1\n키움 모의 · 실계좌 지원 · 현재 잠금");
const deferredBuy = formatDeferredOrder(base, "한투", "mock");
assert.equal(deferredBuy.event, "DEFERRED_BUY");
assert.equal(deferredBuy.text.includes("청산 실패"), false);
assert(formatDeferredOrder({ ...base, payload: { ...base.payload, exchange: "KRX" } }, "키움", "mock").text.includes("국내 모의 매수 예약"));
const deferredSell = formatDeferredOrder({ ...base, payload: { ...base.payload, exchange: "NASDAQ", action: "SELL" } }, "한투", "mock");
assert.equal(deferredSell.event, "DEFERRED_SELL");
assert(deferredSell.text.includes("한투 미국 모의 매도 예약"));
assert(deferredSell.text.includes("계좌 보유·주문 가능 수량"));
assert.equal(formatExecutorError("한투 예약 매수 재시도 실패", new Error("장 종료"), base).event, "EXECUTOR_ERROR");
const executorOrderFailure = formatUncreatedOrder("키움 모의계좌", base, { title: "주문 실패", reason: "계좌 조회 실패" });
assert.equal(executorOrderFailure.channel, "execution");
assert(executorOrderFailure.embed.title.includes("키움 모의계좌 주문 실패"));
assert(executorOrderFailure.embed.fields.some((field) => field.name === "사유" && field.value === "계좌 조회 실패"));
assert(executorOrderFailure.embed.footer.text.includes("주문 생성 안 됨"));
const userRejectedBuy = formatUncreatedOrder("두 계좌", base, { title: "사용자 BUY 승인 거부", reason: "사용자가 BUY 승인을 거부했습니다." });
assert(userRejectedBuy.embed.title.includes("사용자 BUY 승인 거부"));
const rejectedOrder = formatOrderStatus({
  orderNo: "1903", symbol: "SE", side: "BUY", status: "REJECTED", market: "NYSE",
  orderQuantity: 63, filledQuantity: 0, remainingQuantity: 63, rawStatus: "증권사 주문 거부",
  resultAt: "2026-08-12T00:00:07.301Z", updatedAt: "2026-08-27T01:35:01.621Z",
});
assert(rejectedOrder.embed.fields.some((field) => field.name === "사유" && field.value === "증권사 주문 거부"));
assert.equal(rejectedOrder.embed.timestamp, "2026-08-12T00:00:07.301Z");

console.log("webhook-discord test OK");
