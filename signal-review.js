"use strict";

const WATCHLIST_CODES = new Set([
  "SETUP_FORMING", "VCP_FORMING", "PEG_STARTED", "RANGE_BREAKOUT", "POST_SURGE_PULLBACK",
]);

function shouldReviewSignal(record) {
  const pendingBuy = record?.payload?.action === "BUY" && record?.risk?.verdict === "BUY_PENDING_APPROVAL";
  const dailyReview = record?.payload?.action === "BUY" && record?.risk?.verdict === "REVIEW_DAILY_CONFIRMATION";
  return Boolean(
    record?.validation?.ok
    && record.payload?.paper_order_test !== true
    && !record.outcome?.duplicate
    && !["BLOCKED", "REJECTED_INVALID"].includes(record.outcome?.decision)
    && (pendingBuy || dailyReview || (record.payload?.action === "CHECK" && WATCHLIST_CODES.has(record.outcome?.signal?.signalCode))),
  );
}

function compactSignal(record, index) {
  const payload = record.payload;
  const outcome = record.outcome;
  const signal = outcome.signal || {};
  return [
    `[${index + 1}] ${payload.name || "-"} (${payload.ticker}) / ${payload.exchange || "-"}`,
    `action=${payload.action}, raw_type=${payload.type}, signal_code=${signal.signalCode}, decision=${outcome.decision}`,
    `price=${payload.price}, sl=${payload.sl ?? "null"}, rr=${payload.rr ?? "null"}, timeframe=${payload.timeframe}`,
    `conviction=${payload.conviction}, score=${payload.score}, status=${payload.status}, market=${payload.market}`,
    `daily_trend=${payload.daily_trend}, daily_rs=${payload.daily_rs}, setup=${payload.daily_setup_stage}, volume=${payload.daily_volume_trend}, above_200ma=${payload.daily_above_200ma}`,
    `atr_multiple=${payload.atr_multiple}, atr_dot=${payload.atr_dot}, z_score=${payload.sb_z_score}, rsi2=${payload.rsi2}, upper_wick_pct=${payload.upper_wick_pct}`,
    `risk_gate=${record.risk?.verdict || "-"}, risk_reason=${record.risk?.reason || "-"}, positions=${record.risk?.openCount ?? "-"}/${record.risk?.maxOpenPositions ?? "-"}`,
  ].join("\n");
}

function buildSignalReviewTopic(records) {
  const simulatorOnly = records.every((record) => record.payload?.exchange === "SIMULATOR");
  const pendingBuy = records.some((record) => record.risk?.verdict === "BUY_PENDING_APPROVAL");
  const dailyReview = records.some((record) => record.risk?.verdict === "REVIEW_DAILY_CONFIRMATION");
  return [
    "TradingView Webhook v6.2 워치리스트 사전 검토입니다. 제공된 원본 값과 내부 코드는 공통 사실이며 임의로 바꾸지 마세요.",
    pendingBuy
      ? "BUY 신호는 사용자 승인 대기 중이며 아직 주문·체결되지 않았습니다."
      : dailyReview
        ? "BUY 신호는 일봉 강세·정배열이 확정되지 않아 주문 없이 검토 중입니다."
        : "아직 진입·청산 신호가 아닌 관찰 단계입니다. 키움 주문·체결이 있다고 가정하지 마세요.",
    "각 참가자는 자신의 투자 철학으로 찬성/조건부 찬성/보류/반대 중 하나를 먼저 밝히고, 근거·반대근거·부족한 데이터·무효화 조건을 6개 항목 이내로 답하세요.",
    "정확한 수량이나 즉시 매수·매도 명령을 만들지 마세요. 여러 신호가 있으면 우선순위도 제시하세요.",
    simulatorOnly ? "모든 항목이 SIMULATOR 테스트이므로 외부 사실 검색 없이 연동과 판단 형식만 점검하세요." : "현재 시장·뉴스가 판단에 필수일 때만 실시간 검색하고 공식 출처 링크와 확인 시각을 붙이세요.",
    "",
    ...records.map(compactSignal),
  ].join("\n\n");
}

class SignalReviewBatcher {
  constructor(onBatch, options = {}) {
    this.onBatch = onBatch;
    this.onError = options.onError || ((error) => console.error("AI 신호 검토 실패:", error));
    this.windowMs = options.windowMs ?? 5_000;
    this.maxBatch = options.maxBatch ?? 10;
    this.pending = [];
    this.timer = null;
    this.processing = Promise.resolve();
  }

  add(record) {
    if (!shouldReviewSignal(record)) return false;
    this.pending.push(record);
    if (this.pending.length >= this.maxBatch) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.windowMs);
    return true;
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return this.processing;
    const batch = this.pending.splice(0, this.maxBatch);
    this.processing = this.processing.then(() => this.onBatch(batch)).catch(this.onError);
    if (this.pending.length) this.timer = setTimeout(() => void this.flush(), 0);
    return this.processing;
  }
}

module.exports = {
  SignalReviewBatcher,
  buildSignalReviewTopic,
  shouldReviewSignal,
};
