"use strict";

const assert = require("node:assert/strict");
const { createAccountRuntime, SignalReceiptStore } = require("../src/executor/account-executor");
const { encodeSignalEnvelope } = require("../src/discord/discord-signal-envelope");

// 네트워크·자격증명·실주문 없는 실행 경로 회귀검증.
const RealDate = Date;
let clock = new RealDate("2026-09-08T14:00:00Z").getTime();
global.Date = class extends RealDate {
  constructor(value?: any) { super(value === undefined ? clock : value); }
  static now() { return clock; }
} as DateConstructor;

function record(id, action = "BUY") {
  return { requestId: id, receivedAt: new Date().toISOString(),
    payload: { ticker: "TEST", name: "테스트", exchange: "NASDAQ", timeframe: "240", action, price: 100, sl: 90, conviction: "B", daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true },
    outcome: { decision: action === "BUY" ? "ENTRY_CANDIDATE" : "EXIT_IF_FILLED", signal: { signalCode: action === "BUY" ? "ENTRY_STANDARD" : "EXIT_FINAL" } },
    risk: { verdict: action === "BUY" ? "PAPER_ENTRY" : "PAPER_EXIT" } };
}

function fixture(ids = ["KIS"], environment = "mock") {
  const receipts = new SignalReceiptStore(null, true);
  const sent = [];
  let discordFails = false;
  const channel = { isTextBased: () => true, send: async (message) => { if (discordFails) throw new Error("Discord offline"); sent.push(message); return { id: String(sent.length) }; } };
  const brokers = ids.map((id) => {
    const state = { orders: [], requests: [], executions: [], holdings: [], price: 120, failBalance: false, unknown: false, cancels: 0 };
    const tracker = { list: () => state.orders, pending: () => state.orders.filter(o => ["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(o.status)),
      record: (order) => { const previous = state.orders.find(o => o.orderNo === order.orderNo); const saved = { ...previous, ...order }; state.orders = [...state.orders.filter(o => o.orderNo !== order.orderNo), saved]; return saved; } };
    const api = {
      getDomesticBalance: async () => { if (state.failBalance) throw new Error("balance unavailable"); return { estimatedAssets: 100000, holdings: [] }; },
      getUsBalances: async () => [{ holdings: state.holdings }],
      getUsBalance: async () => ({ holdings: state.holdings }),
      getUsCash: async () => ({ usd: 100000 }),
      getUsQuote: async () => ({ currentPrice: state.price }),
      getUsOrderExecutions: async () => state.executions,
      placeUsLimitOrder: async (request) => { state.requests.push(request); if (state.unknown) throw Object.assign(new Error("lost response"), { orderStatusUnknown: true }); return { orderNo: String(state.requests.length), status: "ACCEPTED", symbol: request.symbol, side: request.side }; },
      cancelUsOrder: async () => { state.cancels++; return { status: "CANCEL_REQUESTED", cancellationOrderNo: "c1" }; },
    };
    return { id, label: id, environment, tracker, domesticClient: api, overseasClient: api, state };
  });
  const guild = { channels: { fetch: async () => new Map([["order", channel], ["execution", channel], ["system", channel], ["journal", channel]]) } };
  const runtime = createAccountRuntime({ brokers, receipts, client: { guilds: { fetch: async () => guild } },
    ownerId: "owner", channels: { order: "order", execution: "execution", system: "system", journal: "journal" },
    trusted: { sourceChannelIds: new Set(["signal"]), sourceBotIds: new Set(["source"]) },
    trackingOptions: { attempts: 0 }, enrichNames: async items => items });
  return { runtime, receipts, brokers, sent, failDiscord: value => { discordFails = value; } };
}

function message(r) { return { id: r.requestId, channelId: "signal", author: { id: "source", bot: true }, embeds: [{ footer: { text: encodeSignalEnvelope(r) } }] }; }

(async () => {
  const off = fixture();
  off.receipts.putDeferred("KIS", record("off"), 600000);
  off.receipts.setAutoTrading(false);
  await off.runtime.retryDeferred();
  assert.equal(off.brokers[0].state.requests.length, 0);
  assert.equal(off.receipts.listDeferred().length, 1);
  off.receipts.setAutoTrading(true);
  await off.runtime.retryDeferred();
  const bought = off.brokers[0].state.orders[0];
  assert.equal(bought.limitPrice, 100); // 원신호 상한을 현재가 120으로 올리지 않음
  assert.equal(bought.plannedRisk, bought.orderQuantity * (bought.limitPrice - 90));
  assert.equal(off.receipts.listDeferred().length, 0);

  const mixed = fixture(["KIWOOM", "KIS"]);
  mixed.brokers[0].state.failBalance = true;
  const approval = record("approval"); approval.risk.verdict = "BUY_PENDING_APPROVAL";
  await mixed.runtime.processMessage(message(approval));
  assert.deepEqual(mixed.receipts.findPending().brokerIds, ["KIS"]);
  assert.deepEqual(mixed.receipts.state.inbox.approval.completed, ["KIS"]);
  mixed.brokers[0].state.failBalance = false;
  await mixed.runtime.retryInbox();
  assert.deepEqual(mixed.receipts.findPending().brokerIds.sort(), ["KIS", "KIWOOM"].sort());
  assert.equal(mixed.receipts.state.inbox.approval, undefined);
  await mixed.runtime.processApproval({ author: { id: "owner", bot: false }, channelId: "order", content: "둘다", reply: async () => {} });
  assert.deepEqual(mixed.brokers.map(b => b.state.requests.length), [1, 1]);

  const disconnected = fixture();
  disconnected.failDiscord(true);
  await disconnected.runtime.processMessage(message(record("discord")));
  disconnected.failDiscord(false);
  await disconnected.runtime.processMessage(message(record("discord")));
  assert.equal(disconnected.brokers[0].state.requests.length, 1);
  await disconnected.runtime.reconcileOrders();
  assert(disconnected.brokers[0].state.orders[0].statusMessageId);

  const unknown = fixture(); unknown.brokers[0].state.unknown = true;
  await unknown.runtime.executeOrDefer(unknown.brokers[0], record("lost"));
  await unknown.runtime.executeOrDefer(unknown.brokers[0], record("lost"));
  await unknown.runtime.executeOrDefer(unknown.brokers[0], record("new-same-symbol"));
  assert.equal(unknown.brokers[0].state.requests.length, 1);

  const exit = fixture(); const b = exit.brokers[0];
  b.state.holdings = [{ code: "TEST", quantity: 2, tradableQuantity: 2, evaluationAmount: 200, purchaseAmount: 180 }];
  const pendingBuy = { orderNo: "99", market: "NASDAQ", symbol: "TEST", side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240", fillPrice: 90, orderQuantity: 5, filledQuantity: 2, remainingQuantity: 3, status: "PARTIALLY_FILLED" };
  b.tracker.record(pendingBuy); b.state.executions = [{ ...pendingBuy }];
  await exit.runtime.executeOrDefer(b, record("exit", "SELL"));
  assert.equal(b.state.cancels, 1);
  assert.equal(b.state.requests.length, 0);
  assert.equal(exit.receipts.listDeferred()[0].kind, "VERIFY");
  b.state.executions = [{ ...pendingBuy, remainingQuantity: 0, status: "CANCELLED" }];
  clock += 60001;
  await exit.runtime.retryDeferred();
  assert.equal(b.state.requests.length, 1);
  assert.equal(b.state.requests[0].side, "SELL");
  assert.equal(b.state.requests[0].quantity, 2);

  for (const environment of ["mock", "live"]) {
    for (const id of ["KIWOOM", "KIS"]) {
      const scoped = fixture([id], environment), broker = scoped.brokers[0];
      broker.state.holdings = [{ code: "TEST", quantity: 100, tradableQuantity: 100, evaluationAmount: 10000, purchaseAmount: 9000 }];
      const entry = { orderNo: "owned-entry", requestId: "owned-entry", market: "NASDAQ", symbol: "TEST", side: "BUY", entryType: "PAPER_ENTRY",
        status: "FILLED", filledQuantity: 10, fillPrice: 100, stopPrice: 90, timeframe: "1D", environment, createdAt: "2026-09-01T00:00:00Z", statusMessageId: "done" };
      broker.tracker.record(entry);
      const otherFrame = await scoped.runtime.executeOrDefer(broker, record("other-frame", "SELL"));
      assert.equal(otherFrame.status, "SKIPPED_TIMEFRAME");
      assert.equal(broker.state.requests.length, 0);
      const dailyExit = record("owned-exit", "SELL"); dailyExit.payload.timeframe = "D";
      await scoped.runtime.executeOrDefer(broker, dailyExit);
      assert.equal(broker.state.requests[0].quantity, 10); // 90 manual shares are untouched
      assert.equal(broker.state.orders.find(o => o.requestId === "owned-exit").policyVersion, "2026-09-07-owned-timeframe-v1");
    }
  }
  const unmanaged = fixture();
  unmanaged.brokers[0].state.holdings = [{ code: "TEST", quantity: 100, tradableQuantity: 100 }];
  assert.equal((await unmanaged.runtime.executeOrDefer(unmanaged.brokers[0], record("manual-only", "SELL"))).status, "SKIPPED_UNMANAGED_POSITION");
  assert.equal(unmanaged.brokers[0].state.requests.length, 0);
  const stopAlert = fixture();
  stopAlert.brokers[0].state.holdings = [{ code: "TEST", quantity: 10, tradableQuantity: 10 }];
  stopAlert.brokers[0].tracker.record({ orderNo: "stop-entry", market: "NASDAQ", symbol: "TEST", side: "BUY", entryType: "PAPER_ENTRY", status: "FILLED", filledQuantity: 10, fillPrice: 100, stopPrice: 90, timeframe: "240" });
  stopAlert.brokers[0].state.price = 80;
  await stopAlert.runtime.checkManagedStops();
  assert.equal(stopAlert.brokers[0].state.requests.length, 0);
  assert.match(JSON.stringify(stopAlert.sent), /손절 기준 이탈/);
  stopAlert.brokers[0].state.holdings = [];
  await stopAlert.runtime.checkManagedStops();
  assert.match(JSON.stringify(stopAlert.sent), /보유 기록 대조 필요/);
  const unmatchedEntry = await stopAlert.runtime.executeOrDefer(stopAlert.brokers[0], record("unmatched-entry"));
  assert.equal(unmatchedEntry.status, "BLOCKED");
  assert.equal(stopAlert.brokers[0].state.requests.length, 0);
  const frameReservations = fixture();
  const dayBuy = record("day-reservation"); dayBuy.payload.timeframe = "D";
  frameReservations.receipts.putDeferred("KIS", dayBuy, 600000);
  frameReservations.receipts.rememberExit("KIS", record("four-hour-exit", "SELL"));
  assert.equal(frameReservations.receipts.listDeferred().length, 1);
  const crashExit = record("crash-exit", "SELL"); crashExit.outcome.signal.signalCode = "EXIT_CRASH";
  frameReservations.receipts.rememberExit("KIS", crashExit);
  assert.equal(frameReservations.receipts.listDeferred().length, 0);

  const crashed = fixture();
  crashed.receipts.attempt("KIS", record("crash"), "SUBMITTING");
  await crashed.runtime.executeOrDefer(crashed.brokers[0], record("crash"));
  assert.equal(crashed.brokers[0].state.requests.length, 0);
  const superseded = fixture();
  superseded.receipts.putDeferred("KIS", record("stale-buy"), 600000);
  clock += 1000;
  await superseded.runtime.processMessage(message(record("later-exit", "SELL")));
  assert.equal(superseded.receipts.listDeferred().length, 0);
  assert.equal(superseded.brokers[0].state.requests.length, 0);
  const turningOff = fixture();
  turningOff.brokers[0].overseasClient.getUsQuote = async () => { turningOff.receipts.setAutoTrading(false); return { currentPrice: 110 }; };
  await turningOff.runtime.executeOrDefer(turningOff.brokers[0], record("turn-off-during-quote"));
  assert.equal(turningOff.brokers[0].state.requests.length, 0);
  assert.equal(turningOff.receipts.listDeferred().length, 1);
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-recovery-"));
  try {
    const file = path.join(dir, "receipts.json");
    const before = new SignalReceiptStore(file, true);
    const item = before.receive(record("durable"), "durable-message");
    before.completeBroker(item, "KIWOOM");
    before.attempt("KIS", record("durable"), "SUBMITTING");
    const after = new SignalReceiptStore(file);
    assert.deepEqual(after.state.inbox.durable.completed, ["KIWOOM"]);
    assert.equal(after.attempt("KIS", record("durable")).status, "SUBMITTING");
    assert.equal(after.receive(record("durable"), "different-message"), after.state.inbox.durable);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const switching = fixture();
  switching.brokers[0].environment = "live";
  assert.throws(() => createAccountRuntime({ brokers: switching.brokers, receipts: switching.receipts }), /상태 파일을 분리/);
  console.log("account-runtime test OK: OFF, reprice, broker isolation, Discord recovery, uncertain response, exit after cancellation, crash guard");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.Date = RealDate; });
