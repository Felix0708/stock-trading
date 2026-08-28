"use strict";

const assert = require("node:assert/strict");
const { assertMockSmokeOrder } = require("../scripts/kiwoom-order-smoke");

assert.doesNotThrow(() => assertMockSmokeOrder({ KIWOOM_ENV: "mock", CONFIRM_MOCK_ORDER: "AAPL-1-USD" }));
assert.throws(() => assertMockSmokeOrder({ KIWOOM_ENV: "live", CONFIRM_MOCK_ORDER: "AAPL-1-USD" }), /모의계좌에서만/);
assert.throws(() => assertMockSmokeOrder({ KIWOOM_ENV: "mock" }), /확인값/);

console.log("kiwoom order smoke safety test OK");
