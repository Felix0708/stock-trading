"use strict";

const assert = require("node:assert/strict");
const { calculatePositionSize, calculateWebhookPositionPreview, effectiveStopPrice, inferPositionProfitable, isDailyTimeframe } = require("../src/trading/position-sizer");

const base = { equity: 100000, availableCash: 100000, entryPrice: 100, stopPrice: 95 };
assert.equal(calculatePositionSize({ ...base, conviction: "B" }).quantity, 100);
assert.equal(calculatePositionSize({ ...base, conviction: "S" }).quantity, 130);
assert.equal(calculatePositionSize({ ...base, conviction: "A", dailySetupStage: "COMPLETE" }).quantity, 130);
assert.equal(calculatePositionSize({ ...base, conviction: "C" }).quantity, 70);
assert.equal(calculatePositionSize({ ...base, conviction: "C", dailySetupStage: "COMPLETE" }).quantity, 90);
assert.equal(calculatePositionSize({ ...base, conviction: "D" }).blocked, true);
assert.equal(calculatePositionSize({ ...base, conviction: "B", atrDot: true }).blocked, true);
assert.equal(calculatePositionSize({ ...base, conviction: "B", sbZScore: 2.2 }).quantity, 50);
assert.equal(calculatePositionSize({ equity: 100000, entryPrice: 1000, stopPrice: 999 }).quantity, 20);
assert.equal(calculatePositionSize({ ...base, openPositions: 5 }).blocked, true);
assert.throws(() => calculatePositionSize({ ...base, stopPrice: 101 }), /손절가/);

const record = {
  payload: {
    price: 100, sl: 95, conviction: "A", daily_setup_stage: "FORMING",
    atr_multiple: 2, atr_dot: false, atr_dot_threshold: 7, sb_z_score: 1,
  },
  outcome: { decision: "ENTRY_CANDIDATE" },
};
const preview = calculateWebhookPositionPreview(record, {
  equity: 100000, availableCash: 100000, openPositions: 0, maxOpenPositions: 5,
});
assert.equal(preview.quantity, 110);
assert.equal(preview.positionValue, 11000);
assert.equal(preview.blocked, false);
const earlyPreview = calculateWebhookPositionPreview({
  ...record,
  payload: { ...record.payload, daily_trend: "MIXED", daily_ema_aligned: false, daily_above_200ma: true },
}, {
  equity: 100000, availableCash: 100000, openPositions: 0, maxOpenPositions: 5,
});
assert.equal(earlyPreview.earlyEntry, true);
assert.equal(earlyPreview.quantity, 55);
assert.equal(earlyPreview.positionLimitRatio, 0.1);
const dailyPreview = calculateWebhookPositionPreview({
  ...record,
  payload: { ...record.payload, timeframe: "1D", daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true },
}, {
  equity: 100000, availableCash: 100000, openPositions: 0, maxOpenPositions: 5,
});
assert.equal(dailyPreview.earlyEntry, true);
assert.equal(dailyPreview.quantity, 55);
assert.equal(dailyPreview.positionLimitRatio, 0.1);
assert.equal(isDailyTimeframe("D"), true);
assert.equal(isDailyTimeframe("1D"), true);
assert.equal(isDailyTimeframe("240"), false);
const pegRecord = {
  ...record,
  payload: { ...record.payload, sl: null, momentum_sl: null, daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true },
  outcome: { decision: "ENTRY_CANDIDATE", signal: { signalCode: "PEG_PULLBACK" } },
};
const pegPreview = calculateWebhookPositionPreview(pegRecord, {
  equity: 100000, availableCash: 100000, openPositions: 0, maxOpenPositions: 5,
});
assert.equal(pegPreview.capitalOnly, true);
assert.equal(pegPreview.positionLimitRatio, 0.1);
assert.equal(pegPreview.quantity, 100);
assert.equal(pegPreview.riskBudget, null);
assert.equal(effectiveStopPrice({ ...pegRecord, payload: { ...pegRecord.payload, momentum_sl: 94 } }), 94);
const heldPreview = calculateWebhookPositionPreview({ ...record, outcome: { decision: "ADD_CANDIDATE" } }, {
  equity: 100000, availableCash: 100000, openPositions: 5, maxOpenPositions: 5,
  currentPositionValue: 19000, currentPositionQuantity: 190, hasExistingPosition: true,
});
assert.equal(heldPreview.blocked, false);
assert.equal(heldPreview.quantity, 10);
assert.equal(heldPreview.projectedPositionValue, 20000);
assert.equal(heldPreview.projectedPositionRatio, 20);
assert.equal(inferPositionProfitable([{ profitRate: 1.2 }], null, 100), true);
assert.equal(inferPositionProfitable([{ purchaseAmount: 1000, evaluationAmount: 950 }], null, 100), false);
assert.equal(inferPositionProfitable([], { fillPrice: 90 }, 100), true);
assert.equal(inferPositionProfitable([], null, 100), null);
assert.match(calculateWebhookPositionPreview(record, {
  equity: 100000, availableCash: 100000, openPositions: 1, maxOpenPositions: 5,
  currentPositionValue: 20000, hasExistingPosition: true,
}).reason, /20%/);
assert.equal(calculateWebhookPositionPreview({ ...record, outcome: { decision: "INFO_ONLY" } }, {}), null);
console.log("position-sizer test OK");
