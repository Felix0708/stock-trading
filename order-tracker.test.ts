"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OrderTracker } = require("./order-tracker");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "order-tracker-"));
const file = path.join(directory, "orders.json");
try {
  const first = new OrderTracker(file);
  first.record({ orderNo: "000000001", symbol: "AAPL", status: "ACCEPTED" });
  assert.equal(first.pending().length, 1);
  const restarted = new OrderTracker(file);
  assert.equal(restarted.list()[0].symbol, "AAPL");
  const staleState = JSON.parse(fs.readFileSync(file, "utf8"));
  staleState.orders["000000001"].market = "NASDAQ";
  staleState.orders["000000001"].updatedAt = "2026-08-17T17:30:00.000Z";
  fs.writeFileSync(file, `${JSON.stringify(staleState, null, 2)}\n`);
  const expired = restarted.expirePreviousDayOrders(new Date("2026-08-19T07:00:00.000Z"));
  assert.deepEqual(expired.map((order) => order.status), ["EXPIRED"]);
  assert.equal(restarted.pending().length, 0);
  assert.deepEqual(restarted.unnotifiedPending(), []);
  restarted.record({ orderNo: "000000002", symbol: "MSFT", status: "ACCEPTED" });
  const newlyRecovered = restarted.unnotifiedPending();
  assert.deepEqual(newlyRecovered.map((order) => order.symbol), ["MSFT"]);
  restarted.markRecoveryNotified(newlyRecovered);
  assert.deepEqual(new OrderTracker(file).unnotifiedPending(), []);
  restarted.record({ orderNo: "000000002", status: "FILLED", filledQuantity: 1 });
  restarted.record({ orderNo: "000000001", status: "FILLED", filledQuantity: 1 });
  assert.equal(new OrderTracker(file).pending().length, 0);
  assert.equal(new OrderTracker(file).list()[0].filledQuantity, 1);
  console.log("order-tracker test OK");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
