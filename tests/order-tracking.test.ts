"use strict";

const assert = require("node:assert/strict");
const { refreshPaperOrder, trackPaperOrder } = require("../src/trading/order-tracking");

(async () => {
  const base = { orderNo: "77", symbol: "TEST", side: "BUY", market: "NASDAQ", status: "PARTIALLY_FILLED",
    orderQuantity: 10, filledQuantity: 5, remainingQuantity: 5, fillPrice: 100 };
  let writes = 0;
  for (const changes of [
    { filledQuantity: 1, remainingQuantity: 9 }, { symbol: "OTHER" }, { side: "SELL" },
    { orderQuantity: 99 }, { filledQuantity: 11 }, { filledQuantity: 5.5 }, { fillPrice: 0 },
    { status: "FILLED" }, { remainingQuantity: -1 }, { date: "19990101" },
  ]) {
    await assert.rejects(refreshPaperOrder(base, { tracker: { record: o => { writes++; return o; } },
      overseasClient: { getUsOrderExecutions: async () => [{ ...base, ...changes }] } }), /증빙 충돌/);
  }
  await assert.rejects(refreshPaperOrder(base, { tracker: { record: o => { writes++; return o; } },
    overseasClient: { getUsOrderExecutions: async () => [base, base] } }), /중복/);
  assert.equal(writes, 0, "conflicting responses never overwrite the ledger");
  const yesterday = { ...base, market: "KRX", symbol: "005930", createdAt: "2026-01-01T00:00:00Z" };
  await assert.rejects(refreshPaperOrder(yesterday, { tracker: { record: o => o },
    domesticClient: { getDomesticOrderExecutions: async () => [{ ...yesterday, status: "FILLED", filledQuantity: 10, remainingQuantity: 0 }] } }), /증빙 충돌/);
  const dated = await refreshPaperOrder(yesterday, { tracker: { record: o => o }, domesticClient: {
    getDomesticOrderExecutions: async ({ date }) => {
      assert.equal(date, "20260101");
      return [{ ...yesterday, date, status: "FILLED", filledQuantity: 10, remainingQuantity: 0 }];
    } } });
  assert.equal(dated.filledQuantity, 10);
  const placed = [];
  const executions = {
    "1001": { orderNo: "1001", orderQuantity: 8, filledQuantity: 3, remainingQuantity: 0, fillPrice: 100, status: "PARTIALLY_FILLED" },
    "1002": { orderNo: "1002", orderQuantity: 5, filledQuantity: 2, remainingQuantity: 0, fillPrice: 99.5, status: "PARTIALLY_FILLED" },
    "1003": { orderNo: "1003", orderQuantity: 3, filledQuantity: 3, remainingQuantity: 0, fillPrice: 99, status: "FILLED" },
  };
  const recorded = [];
  const tracker = { record: (order) => { recorded.push(order); return order; } };
  const domesticClient = {
    getDomesticOrderExecutions: async () => Object.values(executions).map(row => ({ ...row, symbol: "005930", side: row.orderNo.startsWith("400") ? "BUY" : "SELL" })),
    placeDomesticMarketOrder: async (request) => {
      placed.push(request);
      return { ...request, orderNo: String(1001 + placed.length), status: "ACCEPTED", orderQuantity: request.quantity };
    },
  };

  const completed = await trackPaperOrder({
    orderNo: "1001", side: "SELL", symbol: "005930", market: "KRX", status: "ACCEPTED",
    orderQuantity: 8, filledQuantity: 0, remainingQuantity: 8, orderStyle: "PROTECTED", marketFallbackAllowed: true,
  }, { domesticClient, tracker, attempts: 1, delayMs: 0, protectionDelayMs: 0 });

  assert.equal(completed.status, "FILLED");
  assert.equal(completed.filledQuantity, 8);
  assert.equal(completed.remainingQuantity, 0);
  assert.equal(completed.fillPrice, 99.5);
  assert.deepEqual(completed.brokerOrderNos, ["1001", "1002", "1003"]);
  assert.equal(completed.marketFallback, true);
  assert.deepEqual(placed.map(({ quantity, orderStyle }) => [quantity, orderStyle]), [[5, "PROTECTED"], [3, "MARKET"]]);
  assert.equal(recorded.length, 5); // 재주문 송신 전/접수 후에도 내구성 있게 저장

  placed.length = 0;
  recorded.length = 0;
  const immediate = await trackPaperOrder({
    orderNo: "1003", side: "SELL", symbol: "005930", market: "KRX", status: "ACCEPTED",
    orderQuantity: 3, filledQuantity: 0, remainingQuantity: 3, orderStyle: "PROTECTED",
  }, { domesticClient, tracker, attempts: 1, delayMs: 0, protectionDelayMs: 0 });
  assert.equal(immediate.status, "FILLED");
  assert.deepEqual(placed, []);

  Object.assign(executions, {
    "2001": { orderNo: "2001", orderQuantity: 5, filledQuantity: 2, remainingQuantity: 0, fillPrice: 100, status: "PARTIALLY_FILLED" },
    "2002": { orderNo: "2002", orderQuantity: 3, filledQuantity: 1, remainingQuantity: 0, fillPrice: 99, status: "PARTIALLY_FILLED" },
    "2003": { orderNo: "2003", orderQuantity: 2, filledQuantity: 0, remainingQuantity: 2, fillPrice: 0, status: "ACCEPTED" },
  });
  const pendingClient = {
    getDomesticOrderExecutions: domesticClient.getDomesticOrderExecutions,
    placeDomesticMarketOrder: async (request) => ({ ...request, orderNo: request.orderStyle === "PROTECTED" ? "2002" : "2003", status: "ACCEPTED", orderQuantity: request.quantity }),
  };
  const pending = await trackPaperOrder({
    orderNo: "2001", side: "SELL", symbol: "005930", market: "KRX", status: "ACCEPTED",
    orderQuantity: 5, filledQuantity: 0, remainingQuantity: 5, orderStyle: "PROTECTED", marketFallbackAllowed: true,
  }, { domesticClient: pendingClient, tracker, attempts: 1, delayMs: 0, protectionDelayMs: 0 });
  executions["2003"] = { ...executions["2003"], filledQuantity: 2, remainingQuantity: 0, fillPrice: 98, status: "FILLED" };
  const reconciled = await refreshPaperOrder(pending, { domesticClient: pendingClient, tracker });
  assert.equal(reconciled.orderNo, "2001");
  assert.equal(reconciled.status, "FILLED");
  assert.equal(reconciled.filledQuantity, 5);
  assert.equal(reconciled.fillPrice, 99);

  Object.assign(executions, {
    "3001": { orderNo: "3001", orderQuantity: 5, filledQuantity: 2, remainingQuantity: 0, fillPrice: 100, status: "PARTIALLY_FILLED" },
    "3002": { orderNo: "3002", orderQuantity: 3, filledQuantity: 1, remainingQuantity: 0, fillPrice: 99, status: "PARTIALLY_FILLED" },
  });
  const protectedOnly = await trackPaperOrder({
    orderNo: "3001", side: "SELL", symbol: "005930", market: "KRX", status: "ACCEPTED",
    orderQuantity: 5, filledQuantity: 0, remainingQuantity: 5, orderStyle: "PROTECTED", marketFallbackAllowed: false,
  }, {
    domesticClient: {
      getDomesticOrderExecutions: domesticClient.getDomesticOrderExecutions,
      placeDomesticMarketOrder: async (request) => ({ ...request, orderNo: "3002", status: "ACCEPTED", orderQuantity: request.quantity }),
    },
    tracker, attempts: 1, delayMs: 0, protectionDelayMs: 0,
  });
  assert.equal(protectedOnly.status, "CANCELLED");
  assert.equal(protectedOnly.filledQuantity, 3);
  assert.equal(protectedOnly.remainingQuantity, 2);
  assert.equal(protectedOnly.marketFallback, false);

  Object.assign(executions, {
    "4001": { orderNo: "4001", orderQuantity: 5, filledQuantity: 2, remainingQuantity: 0, fillPrice: 101, status: "PARTIALLY_FILLED" },
    "4002": { orderNo: "4002", orderQuantity: 3, filledQuantity: 0, remainingQuantity: 0, fillPrice: 0, status: "CANCELLED" },
  });
  const buyRetries = [];
  const protectedBuy = await trackPaperOrder({
    orderNo: "4001", side: "BUY", symbol: "005930", market: "KRX", status: "ACCEPTED",
    orderQuantity: 5, filledQuantity: 0, remainingQuantity: 5, orderStyle: "PROTECTED", marketFallbackAllowed: false,
  }, {
    domesticClient: {
      getDomesticOrderExecutions: domesticClient.getDomesticOrderExecutions,
      placeDomesticMarketOrder: async (request) => {
        buyRetries.push(request);
        return { ...request, orderNo: "4002", status: "ACCEPTED", orderQuantity: request.quantity };
      },
    },
    tracker, attempts: 1, delayMs: 0, protectionDelayMs: 0,
  });
  assert.equal(protectedBuy.status, "CANCELLED");
  assert.equal(protectedBuy.filledQuantity, 2);
  assert.deepEqual(buyRetries.map(({ side, quantity, orderStyle }) => [side, quantity, orderStyle]), [["BUY", 3, "PROTECTED"]]);

  let delayedRows = [{ orderNo: "5001", orderQuantity: 5, filledQuantity: 2, remainingQuantity: 0, fillPrice: 100, status: "CANCELLED" }];
  const delayedClient = {
    getDomesticOrderExecutions: async () => delayedRows.map(row => ({ ...row, symbol: "005930", side: "BUY" })),
    placeDomesticMarketOrder: async () => ({ orderNo: "5002", orderQuantity: 3, status: "ACCEPTED" }),
  };
  const delayed = await trackPaperOrder({ orderNo: "5001", symbol: "005930", side: "BUY", market: "KRX", orderQuantity: 5, status: "ACCEPTED", orderStyle: "PROTECTED" },
    { domesticClient: delayedClient, tracker, protectionDelayMs: 0, protectionQueryAttempts: 1 });
  assert.equal(delayed.activeOrderNo, "5002");
  delayedRows.push({ orderNo: "5002", orderQuantity: 3, filledQuantity: 3, remainingQuantity: 0, fillPrice: 101, status: "FILLED" });
  const recovered = await refreshPaperOrder(delayed, { domesticClient: delayedClient, tracker });
  assert.equal(recovered.filledQuantity, 5);
  assert.equal(recovered.orderQuantity, 5);
  assert.equal(recovered.status, "FILLED");
  assert.equal(recovered.fillPrice, 100.6);
  console.log("order-tracking test OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
