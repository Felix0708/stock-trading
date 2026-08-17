"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWebhookService } = require("./webhook-server");

const specification = fs.readFileSync(path.join(__dirname, "docs", "tradingview-webhook-v6.2.md"), "utf8");
const firstJson = specification.match(/```json\s*([\s\S]*?)```/);
const sample = JSON.parse(firstJson[1]);

async function run() {
  const processed = [];
  const logFile = path.join(__dirname, `.webhook-server-test-${process.pid}.jsonl`);
  const token = "local-test-token-1234567890";
  const service = createWebhookService({ token, onProcessed: (record) => processed.push(record) });
  try {
    const address = await service.listen(0);
    const origin = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).orders_enabled, false);

    const hidden = await fetch(`${origin}/webhook/wrong-token`, { method: "POST", body: "{}" });
    assert.equal(hidden.status, 404);

    const invalidJson = await fetch(`${origin}${service.webhookPath}`, { method: "POST", body: "{" });
    assert.equal(invalidJson.status, 400);

    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`${origin}${service.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sample),
    })));
    assert(responses.every((response) => response.status === 200));
    assert((await responses[0].json()).orders_enabled === false);

    await service.queue.whenIdle();
    assert.equal(processed.length, 10);
    assert(processed.every((record) => record.validation.ok));
    assert(processed.every((record) => record.outcome.orderCreated === false));
    assert.equal(processed.filter((record) => record.outcome.duplicate).length, 9);

    const invalidSchema = await fetch(`${origin}${service.webhookPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(invalidSchema.status, 200);
    await service.queue.whenIdle();
    assert.equal(processed.at(-1).outcome.decision, "REJECTED_INVALID");
    assert.equal(processed.at(-1).outcome.orderCreated, false);
  } finally {
    await service.close();
  }
  console.log("webhook-server test OK");

  const deliveryService = createWebhookService({ token, logFile, onProcessed: () => {} });
  try {
    const address = await deliveryService.listen(0);
    await fetch(`http://127.0.0.1:${address.port}${deliveryService.webhookPath}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample),
    });
    await deliveryService.queue.whenIdle();
    const requestId = JSON.parse(fs.readFileSync(logFile, "utf8").trim()).requestId;
    assert(fs.readFileSync(`${logFile}.delivered`, "utf8").includes(requestId));
  } finally {
    await deliveryService.close();
    for (const suffix of ["", ".delivered", ".failed"]) fs.rmSync(`${logFile}${suffix}`, { force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
