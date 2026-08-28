"use strict";

const assert = require("node:assert/strict");
const { SignalReviewBatcher, buildSignalReviewTopic, shouldReviewSignal } = require("../src/ai/signal-review");

function record(action = "CHECK", overrides = {}) {
  return {
    validation: { ok: true },
    payload: {
      ticker: "TEST", name: "Discord 연동 테스트", exchange: "SIMULATOR", timeframe: "240",
      action, type: "⚒️ 셋업 형성 중", price: 100, sl: 95, rr: 2, conviction: "A", score: 80,
      status: "Green(GO)", market: "📈 강세 정렬", daily_trend: "BULL", daily_rs: 75,
      daily_setup_stage: "COMPLETE", daily_volume_trend: "ACCUMULATION", daily_above_200ma: true,
      atr_multiple: 2, atr_dot: false, sb_z_score: 1.2, rsi2: 50, upper_wick_pct: 10,
    },
    outcome: {
      duplicate: false, decision: "INFO_ONLY",
      signal: { signalCode: "SETUP_FORMING" },
    },
    ...overrides,
  };
}

assert.equal(shouldReviewSignal(record("CHECK")), true);
assert.equal(shouldReviewSignal(record("BUY")), false);
const pendingBuy = record("BUY", { risk: { verdict: "BUY_PENDING_APPROVAL" } });
assert.equal(shouldReviewSignal(pendingBuy), true);
const dailyReview = record("BUY", { risk: { verdict: "REVIEW_DAILY_CONFIRMATION" } });
assert.equal(shouldReviewSignal(dailyReview), true);
assert.equal(shouldReviewSignal(record("SELL")), false);
assert.equal(shouldReviewSignal(record("CHECK", { payload: { ...record().payload, paper_order_test: true } })), false);
assert.equal(shouldReviewSignal(record("CHECK", { outcome: { duplicate: true, decision: "DUPLICATE_IGNORED" } })), false);

const topic = buildSignalReviewTopic([record()]);
assert(topic.includes("Webhook v6.2"));
assert(topic.includes("SETUP_FORMING"));
assert(topic.includes("SIMULATOR 테스트"));
assert(topic.includes("관찰 단계"));
assert(buildSignalReviewTopic([pendingBuy]).includes("사용자 승인 대기"));
assert(buildSignalReviewTopic([dailyReview]).includes("일봉 강세·정배열"));

async function run() {
  const batches = [];
  const batcher = new SignalReviewBatcher(async (items) => batches.push(items), { maxBatch: 2, windowMs: 60_000 });
  batcher.add(record("CHECK"));
  batcher.add(record("CHECK"));
  await batcher.flush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  console.log("signal-review test OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
