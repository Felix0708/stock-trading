"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FIELD_TYPES, validateWebhookPayload } = require("./webhook-schema");

const specification = fs.readFileSync(path.join(__dirname, "docs", "tradingview-webhook-v6.2.md"), "utf8");
const firstJson = specification.match(/```json\s*([\s\S]*?)```/);
assert(firstJson, "기준 문서에서 전체 JSON 예제를 찾지 못했습니다.");

const sample = JSON.parse(firstJson[1]);
assert.equal(Object.keys(FIELD_TYPES).length, 39);
assert.equal(Object.keys(sample).length, 39);
assert.equal(validateWebhookPayload(sample).ok, true);

const missingTicker = { ...sample };
delete missingTicker.ticker;
assert.equal(validateWebhookPayload(missingTicker).ok, false);

const invalidAction = { ...sample, action: "HOLD" };
assert.equal(validateWebhookPayload(invalidAction).ok, false);

const mismatch = validateWebhookPayload({ ...sample, atr_multiple: sample.energy + 1 });
assert(mismatch.warnings.some((warning) => warning.includes("서로 다릅니다")));

console.log("webhook-schema test OK");
