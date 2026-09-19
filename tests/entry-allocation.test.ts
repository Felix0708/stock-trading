"use strict";
const assert = require("node:assert/strict");
const { chooseAccount, allocationRisk, capAllocatedPreview } = require("../src/executor/entry-allocation");
const now = Date.now(), record = { requestId: "new", receivedAt: new Date(now).toISOString(), payload: { exchange: "NASDAQ", ticker: "X", price: 100, timeframe: "240" }, outcome: { decision: "ENTRY_CANDIDATE" } };
function snapshot(id, cash = 10000) {
  const orders = [];
  return { broker: { id, label: id, environment: "mock", tracker: { list: () => orders } },
    account: { equity: 10000, availableCash: cash, openPositions: 0, domesticHoldings: [], usHoldings: [] },
    preview: { quantity: 20, entryPrice: 100, stopPrice: 90, equity: 10000, positionLimitRatio: 0.2, currentPositionValue: 0 } };
}
const receipts = { state: { attempts: {}, exits: {}, pending: {} }, listDeferred: () => [] };
const a = snapshot("A", 2000), b = snapshot("B", 9000), snapshots = [a, b];
assert.equal(chooseAccount(record, snapshots, {}).brokerId, "B");
const oldRoute = { old: { requestId: "old", symbol: "US:X", brokerId: "A", at: now - 1000, timeframe: "240" } };
assert.equal(chooseAccount(record, snapshots, oldRoute).brokerId, "B", "allocation without an order is not entry");
assert.equal(chooseAccount(record, [b], oldRoute).brokerId, "", "missing previous broker evidence must not unlock entry");
for (const status of ["ACCEPTED", "PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "UNKNOWN", "CANCELED"]) {
  a.broker.tracker.list().push({ requestId: "old", status });
  assert.equal(chooseAccount(record, snapshots, oldRoute).brokerId, "", status);
  a.broker.tracker.list().pop();
}
receipts.state.pending['old'] = { record: { ...record, requestId: "old", payload: { ...record.payload, action: "BUY" } }, expiresAt: now + 60000 };
assert.match(allocationRisk(record, snapshots, receipts).reason, /승인 대기/);
receipts.state.pending['old'].expiresAt = now - 1;
assert.equal(allocationRisk(record, snapshots, receipts).blocked, false);
delete receipts.state.pending['old'];
for (const status of ["SUBMITTING", "UNKNOWN"]) {
  receipts.state.attempts["A:old"] = { status };
  assert.equal(allocationRisk(record, snapshots, receipts).retryable, true, status);
}
delete receipts.state.attempts["A:old"];
oldRoute.old.at = now - 14400001;
assert.equal(chooseAccount(record, snapshots, oldRoute).brokerId, "B");
let totals = allocationRisk(record, snapshots, receipts);
assert.equal(totals.equity, 20000); assert.equal(totals.riskLimit, undefined);
// Aggregate risk above the former 1.5% does not override indicator-SL position sizing.
for (const risk of [250, 308, 1000]) assert.equal(capAllocatedPreview(a.preview, { ...totals, risk }).quantity, 20);
assert.equal(capAllocatedPreview(a.preview, { ...totals, exposure: 3900 }).quantity, 1);
assert.equal(capAllocatedPreview({ ...a.preview, stopPrice: null, capitalOnly: true }, totals).blocked, true);
const orders = a.broker.tracker.list();
orders.push({ requestId: "old", orderNo: "1", symbol: "X", market: "NASDAQ", side: "BUY", entryType: "PAPER_ENTRY", environment: "mock", status: "FILLED", filledQuantity: 10, fillPrice: 100, stopPrice: 90, timeframe: "240", createdAt: new Date(now - 14400001).toISOString() });
a.account.usHoldings.push({ code: "X", quantity: 10, evaluationAmount: 1000 });
totals = allocationRisk(record, snapshots, receipts);
assert.equal(totals.blocked, false); assert.equal(totals.risk, 100); assert.equal(totals.exposure, 1000);
a.account.usHoldings[0].evaluationAmount = 890;
assert.match(allocationRisk(record, snapshots, receipts).reason, /손절 이탈/);
a.account.usHoldings[0].evaluationAmount = 1000;
receipts.state.exits['A:NASDAQ:X:240'] = now - 1000;
assert.match(allocationRisk(record, snapshots, receipts).reason, /청산/);
delete receipts.state.exits['A:NASDAQ:X:240'];
orders.push({ market: "NYSE", symbol: "Y", status: "ACCEPTED", side: "BUY", orderQuantity: 10, remainingQuantity: 5, plannedInvestment: 1000, plannedRisk: 100 });
assert.equal(allocationRisk(record, snapshots, receipts).risk, 150);
orders[1].symbol = "X";
assert.match(allocationRisk(record, snapshots, receipts).reason, /미체결/);
orders[1].status = "UNKNOWN";
assert.match(allocationRisk(record, snapshots, receipts).reason, /접수 여부/);
orders.pop(); a.account.usHoldings[0].quantity = 11;
assert.match(allocationRisk(record, snapshots, receipts).reason, /수량/);
assert.equal(allocationRisk(record, [snapshot("single")], receipts).equity, 10000);
console.log("entry-allocation tests OK");

// Bounded stale limit BUYs reserve their full remaining commitment; never invent expiry.
const reserveAccount = snapshot("R", 1000);
const stale = { orderNo: "r1", market: "NASDAQ", exchange: "ND", symbol: "OTHER", side: "BUY", environment: "mock",
  status: "ACCEPTED", reconciliationRequired: true, orderQuantity: 4, filledQuantity: 0, remainingQuantity: 4,
  limitPrice: 100, stopPrice: 90, plannedInvestment: 400, plannedRisk: 40, marketFallbackAllowed: false };
reserveAccount.broker.tracker.list().push(stale);
const reservedTotals = allocationRisk(record, [reserveAccount], receipts);
assert.equal(reservedTotals.blocked, false);
assert.equal(reservedTotals.reservedCash.R, 400);
assert.equal(reservedTotals.risk, 40);
assert.equal(capAllocatedPreview(reserveAccount.preview, reservedTotals, { cash: 400, availableCash: 1000 }).quantity, 6);
assert.equal(capAllocatedPreview(reserveAccount.preview, reservedTotals, { cash: 400, availableCash: 300 }).retryable, true);
for (const change of [{ status: "UNKNOWN" }, { orderNo: "" }, { limitPrice: null }, { stopPrice: 101 }, { activeOrderNo: "r2" }, { remainingQuantity: -1 }, { filledQuantity: 1 }, { environment: "live" }, { side: "SELL" }, { market: "KRX" }, { marketFallbackAllowed: true }]) {
  reserveAccount.broker.tracker.list()[0] = { ...stale, ...change };
  assert.equal(allocationRisk(record, [reserveAccount], receipts).retryable, true, JSON.stringify(change));
}
reserveAccount.broker.tracker.list()[0] = { ...stale, symbol: "X" };
assert.equal(allocationRisk(record, [reserveAccount], receipts).retryable, true);
reserveAccount.broker.tracker.list()[0] = stale;
reserveAccount.account.usHoldings.push({ code: "OTHER", quantity: 1, evaluationAmount: 100 });
assert.equal(allocationRisk(record, [reserveAccount], receipts).retryable, true); // Unrecorded fill cannot be counted twice or guessed.
reserveAccount.account.usHoldings.length = 0;
Object.assign(stale, { status: "PARTIALLY_FILLED", filledQuantity: 1, remainingQuantity: 3, fillPrice: 100, entryType: "PAPER_ENTRY", timeframe: "240", createdAt: new Date(now - 20000000).toISOString() });
reserveAccount.account.usHoldings.push({ code: "OTHER", quantity: 1, evaluationAmount: 100 });
const partialReserve = allocationRisk(record, [reserveAccount], receipts);
assert.equal(partialReserve.reservedCash.R, 300);
assert.equal(partialReserve.risk, 40); // 10 held risk + 30 unresolved risk, not 50.
