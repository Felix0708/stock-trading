"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FIELD_TYPES, validateWebhookPayload } = require("../src/signals/webhook-schema");

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "webhook.example.json"), "utf8"));
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
