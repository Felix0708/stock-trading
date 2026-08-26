"use strict";

const assert = require("node:assert/strict");
const { decodeSignalEnvelope, encodeSignalEnvelope } = require("./discord-signal-envelope");

const record = {
  requestId: "request-1",
  receivedAt: "2026-08-23T01:00:00.000Z",
  payload: {
    ticker: "005930", name: "삼성전자", exchange: "KRX", timeframe: "240",
    action: "BUY", type: "정석 진입", price: 80000, sl: 77500, rr: 2.2,
    conviction: "A", paper_order_test: true, raw_debug_payload: "x".repeat(10_000),
  },
  outcome: { decision: "ENTRY_CANDIDATE", signal: { signalCode: "ENTRY_STANDARD" } },
  risk: { verdict: "PAPER_ENTRY", reason: "모의 진입" },
  orderAttempt: { status: "ERROR", reason: "키움 주문 실패" },
};

const encoded = encodeSignalEnvelope(record);
assert(encoded.startsWith("LAZY_SIGNAL_V1:"));
assert.deepEqual(decodeSignalEnvelope(encoded), {
  requestId: record.requestId,
  receivedAt: record.receivedAt,
  payload: Object.fromEntries(Object.entries(record.payload).filter(([key]) => key !== "raw_debug_payload")),
  outcome: record.outcome,
  risk: { verdict: record.risk.verdict, reason: record.risk.reason },
});
assert(encodeSignalEnvelope({ ...record, orderAttempt: { status: "BLOCKED" } }));
assert.equal(encodeSignalEnvelope({ ...record, risk: { verdict: "NO_ACTION" } }), null);
assert.equal(decodeSignalEnvelope("Lazy Alpha"), null);
assert.throws(() => decodeSignalEnvelope(`${encoded}broken`), /신호 봉투/);

console.log("discord-signal-envelope test OK");
