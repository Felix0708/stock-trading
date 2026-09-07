"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createWebhookService } = require("../src/signals/webhook-server");

const specification = fs.readFileSync(path.join(__dirname, "..", "docs", "tradingview-webhook-v6.2.md"), "utf8");
const firstJson = specification.match(/```json\s*([\s\S]*?)```/);
const sample = JSON.parse(firstJson[1]);

async function run() {
  const processed = [];
  const logFile = path.join(__dirname, `.webhook-server-test-${process.pid}.jsonl`);
  const token = "local-test-token-1234567890";
  let ready = true;
  const service = createWebhookService({ token, healthCheck: () => ready, onProcessed: (record) => processed.push(record) });
  try {
    const address = await service.listen(0);
    const origin = `http://127.0.0.1:${address.port}`;

    const malformed = await new Promise<string>((resolve, reject) => {
      let data = "";
      const socket = net.connect(address.port, "127.0.0.1", () => {
        socket.end("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
      socket.setTimeout(2000, () => socket.destroy(new Error("Malformed URL test timeout")));
      socket.on("data", chunk => { data += chunk; });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(malformed, /^HTTP\/1\.1 400 /);
    assert.equal(processed.length, 0);

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, queue_size: 0, role: "signal_server" });
    ready = false;
    const degraded = await fetch(`${origin}/health`);
    assert.equal(degraded.status, 503);
    assert.equal((await degraded.json()).ok, false);
    ready = true;

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
    assert.deepEqual(Object.keys(await responses[0].json()).sort(), ["ok", "queued", "request_id"]);

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
    for (const suffix of ["", ".delivered", ".failed", ".expired", ".pending"]) fs.rmSync(`${logFile}${suffix}`, { force: true, recursive: true });
  }

  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "webhook-durable-"));
  const file = path.join(directory, "events.jsonl");
  const recovered = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = createWebhookService({ token, logFile: file, onProcessed: async () => { await gate; throw new Error("simulated publication failure"); } });
  let second;
  try {
    const address = await first.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}${first.webhookPath}`, { method: "POST", body: JSON.stringify(sample) });
    assert.equal(response.status, 200);
    const { request_id: id } = await response.json();
    assert.equal(JSON.parse(fs.readFileSync(`${file}.pending/${id}.json`, "utf8")).requestId, id); // durable before ACK
    release();
    await first.queue.whenIdle();
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 503);
    await first.close();
    fs.appendFileSync(file, '{"requestId":"incomplete');
    fs.writeFileSync(`${file}.delivered`, "partial-delivery-id");
    // Simulate termination between durable intake and processing: there is no processed row for this ID.
    fs.writeFileSync(`${file}.pending/raw-intake.json`, JSON.stringify({ requestId: "raw-intake", receivedAt: new Date().toISOString(), payload: { ...sample, ticker: "RECOVERY" } }));
    fs.writeFileSync(`${file}.pending/expired-intake.json`, JSON.stringify({ requestId: "expired-intake", receivedAt: "2020-01-01T00:00:00Z", payload: sample }));
    second = createWebhookService({ token, logFile: file, onProcessed: (record, options) => { recovered.push({ record, options }); } });
    await second.listen(0);
    await second.queue.whenIdle();
    assert.deepEqual(recovered.map(item => item.record.requestId), [id, "raw-intake"]);
    assert.equal(recovered[0].record.outcome.duplicate, false); // original outcome survives, not re-applied
    assert(recovered.every(item => item.options.recovered));
    second.recover(); await second.queue.whenIdle();
    assert.equal(recovered.length, 2);
    assert.equal(fs.readdirSync(`${file}.pending`).length, 0);
    const backups = fs.readdirSync(directory).filter(name => name.includes(".incomplete-"));
    assert.equal(backups.length, 2);
    assert(backups.some(name => fs.readFileSync(path.join(directory, name), "utf8") === '{"requestId":"incomplete'));
    assert.match(fs.readFileSync(`${file}.expired`, "utf8"), /expired-intake/);
    // Storage failure must never ACK success or publish the event.
    fs.rmdirSync(`${file}.pending`);
    const failed = await fetch(`http://127.0.0.1:${second.server.address().port}${second.webhookPath}`, { method: "POST", body: JSON.stringify(sample) });
    assert.equal(failed.status, 503);
    assert.equal(recovered.length, 2);
  } finally {
    release(); await first.close(); await second?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("webhook durable intake/recovery/expiry/storage-failure test OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
