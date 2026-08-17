"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OrderTracker } = require("./order-tracker");
const {
  partialExitQuantity, partialExitRatio,
  submitPaperOrder, trackPaperOrder, submitPaperTestOrder, trackPaperTestOrder,
} = require("./paper-order-executor");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-order-test-"));
const tracker = new OrderTracker(path.join(directory, "orders.json"));
const options = {
  enabled: true,
  symbol: "005930",
  lockFile: path.join(directory, "lock.json"),
  tracker,
  client: {
    placeDomesticMarketOrder: async () => ({ status: "ACCEPTED", orderNo: "00024", side: "BUY", symbol: "005930", orderQuantity: 1 }),
    getDomesticOrderExecutions: async () => [{
      status: "FILLED", orderNo: "00024", side: "BUY", symbol: "005930",
      orderQuantity: 1, filledQuantity: 1, remainingQuantity: 0, fillPrice: 100,
    }],
  },
};
const record = {
  requestId: "request-1",
  payload: { paper_order_test: true, ticker: "005930", exchange: "KRX", action: "BUY" },
  risk: { verdict: "PAPER_ENTRY" },
};

(async () => {
  assert.equal(partialExitQuantity(8, 0.25), 2);
  assert.equal(partialExitQuantity(1, 0.25), 0);
  assert.equal(partialExitRatio({ outcome: { signal: { signalCode: "TAKE_PROFIT", tpLevel: 2 } } }, {}), 0.5);
  assert.equal((await submitPaperTestOrder({ ...record, payload: { ...record.payload, ticker: "000001" } }, options)).status, "BLOCKED");
  const accepted = await submitPaperTestOrder(record, options);
  assert.equal(accepted.orderQuantity, 1);
  assert.equal((await submitPaperTestOrder(record, options)).status, "BLOCKED");
  assert.equal((await trackPaperTestOrder(accepted, { ...options, attempts: 1, delayMs: 0 })).status, "FILLED");

  const autoTracker = new OrderTracker(path.join(directory, "auto-orders.json"));
  const autoRecord = {
    payload: { ticker: "AAPL", exchange: "NASDAQ", action: "BUY", price: 250 },
    risk: { verdict: "PAPER_ADD" },
    positionPreview: { quantity: 4 },
  };
  const overseasClient = {
    placeUsLimitOrder: async ({ side, exchange, symbol, quantity, price }) => ({
      status: "ACCEPTED", orderNo: "282", side, exchange, symbol, orderQuantity: quantity, price,
    }),
    getUsOrderExecutions: async () => [{
      status: "FILLED", orderNo: "282", side: "BUY", symbol: "AAPL",
      orderQuantity: 4, filledQuantity: 4, remainingQuantity: 0, fillPrice: 250,
    }],
  };
  const auto = await submitPaperOrder(autoRecord, {
    enabled: true, environment: "mock", domesticClient: options.client, overseasClient, tracker: autoTracker,
  });
  assert.equal(auto.orderQuantity, 4);
  assert.equal(auto.exchange, "ND");
  assert.equal((await trackPaperOrder(auto, {
    domesticClient: options.client, overseasClient, tracker: autoTracker, attempts: 1, delayMs: 0,
  })).status, "FILLED");
  const domesticAuto = await submitPaperOrder({
    payload: { ticker: "005930", exchange: "KRX", action: "BUY", price: 100000 },
    risk: { verdict: "PAPER_ENTRY" },
    positionPreview: { quantity: 2 },
  }, {
    enabled: true, environment: "mock", domesticClient: options.client, overseasClient, tracker: autoTracker,
  });
  assert.equal(domesticAuto.orderQuantity, 2);
  assert.equal(domesticAuto.market, "KRX");
  const domesticPartial = await submitPaperOrder({
    payload: { ticker: "005930", exchange: "KRX", action: "SELL", type: "🔪 1차 분할청산", price: 100000 },
    outcome: { signal: { signalCode: "EXIT_PARTIAL_1" } },
    risk: { verdict: "PAPER_PARTIAL_EXIT" },
  }, {
    enabled: true,
    environment: "mock",
    domesticClient: {
      ...options.client,
      getDomesticBalance: async () => ({ holdings: [{ code: "A005930", tradableQuantity: 8 }] }),
    },
    tracker: autoTracker,
    partialExit1Ratio: 0.25,
  });
  assert.equal(domesticPartial.orderQuantity, 2);
  assert.equal(domesticPartial.partialExitRatio, 0.25);
  assert.equal((await submitPaperOrder(autoRecord, {
    enabled: true, environment: "live", domesticClient: options.client, overseasClient, tracker: autoTracker,
  })).status, "BLOCKED");
  console.log("paper-order-executor test OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
