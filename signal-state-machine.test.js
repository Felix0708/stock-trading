"use strict";

const assert = require("node:assert/strict");
const { SignalStateMachine } = require("./signal-state-machine");

function signal(action, type, price = 100) {
  return {
    exchange: "KRX",
    ticker: "005930",
    timeframe: "240",
    action,
    type,
    price,
    sl: null,
    rr: null,
  };
}

const machine = new SignalStateMachine({}, { deduplicationMs: 5_000 });
const entered = machine.handle(signal("BUY", "💰 정석 진입", 100), "2026-08-10T01:00:00Z");
assert.equal(entered.decision, "ENTRY_CANDIDATE");
assert.equal(entered.state.status, "ENTRY_SIGNALLED");
assert.equal(entered.orderCreated, false);

const duplicate = machine.handle(signal("BUY", "💰 정석 진입", 100), "2026-08-10T01:00:01Z");
assert.equal(duplicate.decision, "DUPLICATE_IGNORED");
assert.equal(duplicate.duplicate, true);

const invalidated = machine.handle(signal("SELL", "🚫 진입 무효", 98), "2026-08-10T01:00:02Z");
assert.equal(invalidated.decision, "WAIT_FOR_CONFIRMATION");
assert.equal(invalidated.state.status, "ENTRY_INVALID_PENDING");
assert.equal(invalidated.orderCreated, false);

const confirmed = machine.handle(signal("CHECK", "✅ 진입 확정", 101), "2026-08-10T01:00:03Z");
assert.equal(confirmed.decision, "KEEP_IF_FILLED");
assert.equal(confirmed.state.status, "ENTRY_CONFIRMED");

const partial = machine.handle(signal("SELL", "🎯 TP1 달성", 110), "2026-08-10T01:01:00Z");
assert.equal(partial.decision, "PARTIAL_EXIT_CANDIDATE");
assert.equal(partial.state.status, "ENTRY_CONFIRMED");

const second = new SignalStateMachine();
second.handle(signal("BUY", "🚀 돌파 진입", 100), "2026-08-10T02:00:00Z");
second.handle(signal("SELL", "🚫 진입 무효", 97), "2026-08-10T02:00:01Z");
const expired = second.handle(signal("CHECK", "⛔ 진입 만료", 96), "2026-08-10T02:00:02Z");
assert.equal(expired.decision, "EXIT_IF_FILLED");
assert.equal(expired.state.status, "ENTRY_EXPIRED");

const missingHistory = new SignalStateMachine().handle(
  signal("SELL", "🚫 진입 무효", 99),
  "2026-08-10T03:00:00Z",
);
assert(missingHistory.warnings.some((warning) => warning.includes("선행 진입 신호")));

const unknown = new SignalStateMachine().handle(
  signal("BUY", "🆕 새 진입 신호", 100),
  "2026-08-10T04:00:00Z",
);
assert.equal(unknown.decision, "BLOCKED");
assert.equal(unknown.orderCreated, false);

const restored = new SignalStateMachine(machine.snapshot());
assert.equal(restored.snapshot().instruments["KRX:005930:240"].status, "ENTRY_CONFIRMED");

console.log("signal-state-machine test OK");
