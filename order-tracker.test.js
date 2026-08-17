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
  restarted.record({ orderNo: "000000001", status: "FILLED", filledQuantity: 1 });
  assert.equal(new OrderTracker(file).pending().length, 0);
  assert.equal(new OrderTracker(file).list()[0].filledQuantity, 1);
  console.log("order-tracker test OK");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
