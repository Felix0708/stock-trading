"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ensureProtection, releaseProtection, currentProtection, protectionReadiness } = require("../src/executor/broker-protection");
const { OrderTracker } = require("../src/trading/order-tracker");
const { KiwoomClient } = require("../src/brokers/kiwoom-client");
const { managedPosition } = require("../src/trading/position-ownership");
const { SignalReceiptStore, pendingSymbolOrder, orderNeedsResultReport } = require("../src/executor/account-executor");

const payload = { ticker: "TEST", exchange: "NASDAQ", timeframe: "240", action: "SELL" };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-stop-test-"));
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "case-"));
  const receipts = new SignalReceiptStore(path.join(dir, "receipts.json"), true);
  const tracker = new OrderTracker(path.join(dir, "orders.json"));
  tracker.record({ orderNo: "entry", requestId: "entry", status: "FILLED", side: "BUY", symbol: "TEST", market: "NASDAQ", environment: "mock",
    entryType: "PAPER_ENTRY", timeframe: "240", orderQuantity: 5, filledQuantity: 5, fillPrice: 100, stopPrice: 90, createdAt: new Date(Date.now() - 10000).toISOString() });
  const state = { sends: 0, cancels: 0, quantity: 5, free: 5, price: 100, fail: false, cancelFills: 0, rows: [] as any[] };
  const api = {
    getUsBalances: async () => [{ holdings: [{ code: "TEST", quantity: state.quantity, tradableQuantity: state.free }] }],
    getUsQuote: async () => ({ currentPrice: state.price }),
    getUsOrderExecutions: async () => structuredClone(state.rows),
    getUsHistoricalExecutions: async () => structuredClone(state.rows),
    placeUsStopOrder: async request => {
      state.sends++;
      if (state.fail) throw Object.assign(Error("lost ACK"), { orderStatusUnknown: true });
      const row = { orderNo: String(state.sends), side: "SELL", symbol: "TEST", status: "ACCEPTED", orderQuantity: request.quantity,
        filledQuantity: 0, remainingQuantity: request.quantity, fillPrice: 0, brokerOrderType: "35", brokerStopPrice: request.stopPrice,
        orderTime: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date()) };
      state.rows.push(row);
      return { orderNo: row.orderNo, status: "ACCEPTED", symbol: "TEST", side: "SELL" };
    },
    cancelUsOrder: async request => {
      state.cancels++;
      if (state.cancelFills) {
        const row = state.rows.find(r => r.orderNo === request.orderNo);
        Object.assign(row, { filledQuantity: state.cancelFills, remainingQuantity: 0, fillPrice: 89, status: "CANCELLED", rawStatus: "취소완료" });
        state.quantity -= state.cancelFills; state.free = state.quantity;
      }
      return { status: "CANCEL_REQUESTED", cancellationOrderNo: "cancel-1" };
    },
  };
  const broker = { id: "KIWOOM", label: "키움", environment: "mock", protectionEnabled: true, tracker, overseasClient: api };
  return { broker, receipts, state };
}

(async () => {
  assert(protectionReadiness({ id: "KIS", protectionEnabled: true }, "NASDAQ"));
  assert(protectionReadiness({ id: "KIWOOM", protectionEnabled: false }, "NASDAQ"));
  const f = fixture();
  await ensureProtection(f.broker, f.receipts, payload, () => true);
  assert.equal(f.state.sends, 1);
  assert.equal(orderNeedsResultReport(currentProtection(f.broker, f.receipts, payload)), true);
  assert.equal((await ensureProtection(f.broker, f.receipts, payload, () => true)).status, "PROTECTED");
  assert.equal(f.state.sends, 1); // No duplicate protection on restart/recheck.
  const restored = new SignalReceiptStore(f.receipts.file);
  await ensureProtection(f.broker, restored, payload, () => true); assert.equal(f.state.sends, 1);
  assert.equal(pendingSymbolOrder(f.broker.tracker.list(), { payload }), null);
  assert.equal(await releaseProtection(f.broker, restored, payload, () => true), false); // Accepted cancellation still pending.
  assert.equal(await releaseProtection(f.broker, restored, payload, () => true), false); assert.equal(f.state.cancels, 1);
  f.state.rows[0].status = "CANCELLED"; f.state.rows[0].remainingQuantity = 0; f.state.rows[0].rawStatus = "취소완료";
  assert.equal(await releaseProtection(f.broker, restored, payload, () => true), true);
  await ensureProtection(f.broker, restored, payload, () => false); assert.equal(f.state.sends, 1);
  await ensureProtection(f.broker, restored, payload, () => true); assert.equal(f.state.sends, 2);

  const lost = fixture(); lost.state.fail = true;
  await assert.rejects(ensureProtection(lost.broker, lost.receipts, payload, () => true), /lost ACK/);
  await assert.rejects(ensureProtection(lost.broker, new SignalReceiptStore(lost.receipts.file), payload, () => true), /접수 여부/);
  assert.equal(lost.state.sends, 1);

  const unknownRow = fixture(); await ensureProtection(unknownRow.broker, unknownRow.receipts, payload, () => true);
  unknownRow.state.rows.length = 0;
  await assert.rejects(releaseProtection(unknownRow.broker, unknownRow.receipts, payload, () => true), /미확인/);
  assert.equal(unknownRow.state.cancels, 0);
  const stopOrder = currentProtection(unknownRow.broker, unknownRow.receipts, payload);
  unknownRow.broker.tracker.record({ ...stopOrder, updatedAt: "2026-01-01T00:00:00Z" });
  assert.equal(unknownRow.broker.tracker.expirePreviousDayOrders().length, 0);

  const concurrent = fixture(); await ensureProtection(concurrent.broker, concurrent.receipts, payload, () => true);
  concurrent.state.cancelFills = 2;
  assert.equal(await releaseProtection(concurrent.broker, concurrent.receipts, payload, () => true), true);
  assert.equal(managedPosition(concurrent.broker.tracker.list(), payload).quantity, 3);
  const handoff = concurrent.receipts.putDeferred("KIWOOM", { requestId: "sell-after-stop", payload, risk: { verdict: "PAPER_EXIT" } }, 60000, { kind: "VERIFY" });
  assert.equal((await ensureProtection(concurrent.broker, concurrent.receipts, payload, () => true)).status, "ORDER_PENDING");
  assert.equal(concurrent.state.sends, 1); // The manager must not rearm while an exit is waiting for cancellation.
  concurrent.receipts.removeDeferred(handoff.key);
  await ensureProtection(concurrent.broker, concurrent.receipts, payload, () => true);
  assert.equal(concurrent.state.rows.at(-1).orderQuantity, 3);

  const partial = fixture();
  partial.broker.tracker.record({ ...partial.broker.tracker.list()[0], status: "PARTIALLY_FILLED", orderQuantity: 10, remainingQuantity: 5 });
  await ensureProtection(partial.broker, partial.receipts, payload, () => true);
  assert.equal(partial.state.rows[0].orderQuantity, 5); // Protect confirmed partial buys too, never their unfilled remainder.

  const wrong = fixture(); await ensureProtection(wrong.broker, wrong.receipts, payload, () => true);
  wrong.state.rows[0].brokerOrderType = "00";
  await assert.rejects(ensureProtection(wrong.broker, wrong.receipts, payload, () => true), /유형/);
  wrong.state.rows[0].brokerOrderType = "35";
  wrong.state.rows[0].status = "CANCELLED"; wrong.state.rows[0].remainingQuantity = 0; wrong.state.rows[0].rawStatus = "취소접수";
  await assert.rejects(releaseProtection(wrong.broker, wrong.receipts, payload, () => true), /종료 증빙/);
  assert.equal(wrong.state.cancels, 0);
  wrong.state.rows[0].remainingQuantity = null;
  await assert.rejects(releaseProtection(wrong.broker, wrong.receipts, payload, () => true), /수량/);
  const low = fixture(); low.state.free = 4;
  await assert.rejects(ensureProtection(low.broker, low.receipts, payload, () => true), /매도가능/); assert.equal(low.state.sends, 0);
  low.state.free = 5; low.state.price = 89;
  await assert.rejects(ensureProtection(low.broker, low.receipts, payload, () => true), /손절가/); assert.equal(low.state.sends, 0);

  const calls = [];
  const client = new KiwoomClient({ appKey: "fake", secretKey: "fake", fetchImpl: async (url, options) => {
    if (url.endsWith("/token")) return new Response(JSON.stringify({ return_code: 0, token: "fake", expires_dt: "20990101000000" }));
    calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ return_code: 0, ord_no: "1" }));
  } });
  await client.placeUsStopOrder({ exchange: "ND", symbol: "TEST", quantity: 2, stopPrice: 90, canSubmit: () => true });
  assert.deepEqual(calls[0], { stex_tp: "ND", stk_cd: "TEST", ord_qty: "2", ord_uv: "", stop_pric: "90.00", trde_tp: "35" });
  await assert.rejects(client.placeUsStopOrder({ exchange: "ND", symbol: "TEST", quantity: 2, stopPrice: 90, canSubmit: () => false }));
  assert.equal(calls.length, 1);
  client.post = async () => ({ result_list: [{ frgn_trde_tp: "35", ord_qty: "2", cntr_qty: "0", ord_remnq: "" }], pagination: { more: false } });
  assert.equal((await client.getUsOrderExecutions())[0].remainingQuantity, null); // Missing is not zero/cancelled.
  console.log("broker protection tests OK: native STOP, persistence, cancel/fill race, uncertainty, ownership, no guessed expiry");
})().finally(() => fs.rmSync(root, { recursive: true })).catch(error => { console.error(error); process.exitCode = 1; });
