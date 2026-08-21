"use strict";

const assert = require("node:assert/strict");
const { TradeController } = require("./trade-controller");

function entry(index, overrides = {}) {
  const ticker = String(index).padStart(6, "0");
  return {
    requestId: `request-${index}`,
    receivedAt: `2026-08-10T01:00:${String(index).padStart(2, "0")}Z`,
    validation: { ok: true },
    payload: {
      ticker, name: `테스트${index}`, exchange: "KRX", action: "BUY",
      price: 100, sl: 95, conviction: "A",
      daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true,
      ...overrides,
    },
    outcome: { decision: "ENTRY_CANDIDATE", signal: { signalCode: "ENTRY_STANDARD" } },
  };
}

const controller = new TradeController({ maxOpenPositions: 5, initialMode: "SHADOW" });
for (let index = 1; index <= 5; index += 1) {
  assert.equal(controller.evaluate(entry(index)).verdict, "SHADOW_ENTRY");
}
const sixth = controller.evaluate(entry(6));
assert.equal(sixth.verdict, "BLOCKED_MAX_POSITIONS");
assert.equal(sixth.openCount, 5);
assert.equal(sixth.liveOrderCreated, false);

const exit = {
  ...entry(1),
  payload: { ...entry(1).payload, action: "SELL" },
  outcome: { decision: "EXIT_CANDIDATE", signal: { signalCode: "EXIT_FINAL" } },
};
assert.equal(controller.evaluate(exit).verdict, "SHADOW_EXIT");
assert.equal(controller.evaluate(entry(6)).verdict, "SHADOW_ENTRY");

const noStop = new TradeController().evaluate(entry(7, { sl: null }));
assert.equal(noStop.verdict, "BLOCKED_INVALID_STOP");
const gradeD = new TradeController().evaluate(entry(8, { conviction: "D" }));
assert.equal(gradeD.verdict, "BLOCKED_CONVICTION_D");
const sizingBlockedRecord = { ...entry(8), positionPreview: { blocked: true, reason: "ATR 과열" } };
const sizingBlockedController = new TradeController();
assert.equal(sizingBlockedController.evaluate(sizingBlockedRecord).verdict, "BLOCKED_POSITION_SIZE");
assert.equal(sizingBlockedController.status().openCount, 0);

assert.equal(new TradeController().evaluate(entry(81, { daily_trend: "BEAR" })).verdict, "BLOCKED_DAILY_BEAR");
assert.equal(new TradeController().evaluate(entry(82, { daily_above_200ma: false })).verdict, "BLOCKED_DAILY_200MA");
assert.equal(new TradeController().evaluate(entry(83, { daily_trend: "MIXED" })).verdict, "REVIEW_DAILY_CONFIRMATION");
assert.equal(new TradeController().evaluate(entry(84, { daily_ema_aligned: false })).verdict, "REVIEW_DAILY_CONFIRMATION");
assert.equal(new TradeController().evaluate(entry(85, { daily_trend: undefined })).verdict, "BLOCKED_DAILY_DATA");

const earlyPaper = new TradeController({ initialMode: "PAPER_AUTO", earlyEntryApprovalEnabled: true });
const earlyEntry = entry(86, { daily_trend: "MIXED" });
assert.equal(earlyPaper.evaluate(earlyEntry).verdict, "BUY_PENDING_APPROVAL");
assert.equal(earlyPaper.status().openCount, 0);
earlyEntry.buyApproved = true;
assert.equal(earlyPaper.evaluate(earlyEntry).verdict, "PAPER_ENTRY");
assert.equal(earlyPaper.status().openCount, 1);
earlyEntry.buyApproved = false;
assert.equal(earlyPaper.evaluate(earlyEntry).verdict, "BLOCKED_PENDING_ORDER");

const halted = new TradeController();
halted.setHalted(true);
assert.equal(halted.evaluate(entry(9)).verdict, "BLOCKED_HALTED");
assert.equal(halted.status().liveOrdersEnabled, false);

const paper = new TradeController({ initialMode: "PAPER_AUTO" });
const paperEntry = entry(10);
assert.equal(paper.evaluate(paperEntry).verdict, "PAPER_ENTRY");
assert.equal(paper.evaluate(paperEntry).verdict, "BLOCKED_PENDING_ORDER");
paper.reconcileOrder(paperEntry, { status: "FILLED", orderNo: "10", filledQuantity: 3, fillPrice: 101 });
assert.equal(paper.status().positions[0].quantity, 3);
const paperAdd = { ...paperEntry, requestId: "request-10-add", outcome: { decision: "ADD_CANDIDATE" }, positionPreview: { hasExistingPosition: true, currentPositionQuantity: 3, positionProfitable: true } };
assert.equal(paper.evaluate(paperAdd).verdict, "PAPER_ADD");
paper.reconcileOrder(paperAdd, { status: "FILLED", orderNo: "11", filledQuantity: 2, fillPrice: 102 });
assert.equal(paper.status().positions[0].quantity, 5);
assert.equal(paper.status().positions[0].fillPrice, 101.4);
const losingAdd = { ...paperAdd, requestId: "request-10-losing-add", positionPreview: { ...paperAdd.positionPreview, positionProfitable: false } };
assert.equal(paper.evaluate(losingAdd).verdict, "BLOCKED_ADD_NOT_PROFITABLE");
const unknownAdd = { ...paperAdd, requestId: "request-10-unknown-add", positionPreview: { ...paperAdd.positionPreview, positionProfitable: null } };
assert.equal(paper.evaluate(unknownAdd).verdict, "BLOCKED_ADD_PROFIT_UNKNOWN");
const paperPartial = {
  ...paperEntry,
  requestId: "request-10-partial",
  payload: { ...paperEntry.payload, action: "SELL" },
  outcome: { decision: "PARTIAL_EXIT_CANDIDATE", signal: { signalCode: "EXIT_PARTIAL_1" } },
};
assert.equal(paper.evaluate(paperPartial).verdict, "PAPER_PARTIAL_EXIT");
paper.reconcileOrder(paperPartial, { status: "FILLED", filledQuantity: 1, updatedAt: "2026-08-10T02:00:00Z" });
assert.equal(paper.status().positions[0].quantity, 4);
assert.equal(paper.evaluate(paperPartial).verdict, "BLOCKED_PARTIAL_DUPLICATE");
const rejectedPartial = {
  ...paperPartial,
  requestId: "request-10-partial-2",
  outcome: { decision: "PARTIAL_EXIT_CANDIDATE", signal: { signalCode: "EXIT_PARTIAL_2" } },
};
assert.equal(paper.evaluate(rejectedPartial).verdict, "PAPER_PARTIAL_EXIT");
paper.reconcileOrder(rejectedPartial, { status: "REJECTED" });
assert.equal(paper.evaluate(rejectedPartial).verdict, "PAPER_PARTIAL_EXIT");
paper.reconcileOrder(rejectedPartial, { status: "REJECTED" });
const paperMomentumEnd = { ...paperPartial, outcome: { decision: "REVIEW_PARTIAL_EXIT" } };
assert.equal(paper.evaluate(paperMomentumEnd).verdict, "REVIEW_PARTIAL_EXIT");
const paperExit = { ...paperEntry, payload: { ...paperEntry.payload, action: "SELL" }, outcome: { decision: "EXIT_CANDIDATE" } };
assert.equal(paper.evaluate(paperExit).verdict, "PAPER_EXIT");
assert.equal(paper.status().openCount, 1);
paper.reconcileOrder(paperExit, { status: "FILLED" });
assert.equal(paper.status().openCount, 0);

const rejectedPaper = new TradeController({ initialMode: "PAPER_AUTO" });
const rejectedEntry = entry(11);
rejectedPaper.evaluate(rejectedEntry);
rejectedPaper.reconcileOrder(rejectedEntry, { status: "REJECTED" });
assert.equal(rejectedPaper.status().openCount, 0);

const approvalPaper = new TradeController({ initialMode: "PAPER_AUTO", buyApprovalRequired: true });
const approvalEntry = entry(12);
assert.equal(approvalPaper.evaluate(approvalEntry).verdict, "BUY_PENDING_APPROVAL");
assert.equal(approvalPaper.status().openCount, 0);
approvalEntry.buyApproved = true;
assert.equal(approvalPaper.evaluate(approvalEntry).verdict, "PAPER_ENTRY");
assert.equal(approvalPaper.status().openCount, 1);

console.log("trade-controller test OK");
