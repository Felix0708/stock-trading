"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { writeAccountHealth, readAccountHealth } = require("../src/executor/account-health");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-health-"));
try {
  const now = 200_000;
  const healthy = { discordReady: true, initialized: true, workerAt: now, uncertainOrders: false };
  assert.deepEqual(readAccountHealth(dir, now), { registered: 0, healthy: true });
  writeAccountHealth("example-private-receipts.json", healthy, dir, now);
  assert.deepEqual(readAccountHealth(dir, now), { registered: 1, healthy: true });
  assert.equal(readAccountHealth(dir, now + 45_001).healthy, false);
  for (const failure of [{ discordReady: false }, { initialized: false }, { workerAt: 1 }, { uncertainOrders: true }, { brokerQueriesHealthy: false }]) {
    writeAccountHealth("example-private-receipts.json", { ...healthy, ...failure }, dir, now);
    assert.equal(readAccountHealth(dir, now).healthy, false);
  }
  assert(!JSON.stringify(readAccountHealth(dir, now)).includes("private"));
  writeAccountHealth("example-private-receipts.json", healthy, dir, now);
  assert.equal(readAccountHealth(dir, now - 1).healthy, false);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{broken");
  assert.equal(readAccountHealth(dir, now).healthy, false);
  console.log("account-health test OK: stale, Discord loss, stalled worker, uncertain orders, private data");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
