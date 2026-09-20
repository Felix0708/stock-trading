"use strict";

const assert = require("node:assert/strict");
require("./entry-allocation.test");
const { createAccountRuntime, SignalReceiptStore, queueSignalRecheck } = require("../src/executor/account-executor");
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

function fixture(ids = ["KIS"], environment = "mock", readOnly = false, entryAllocation = false) {
  const receipts = new SignalReceiptStore(null, true);
  const sent = [];
  const messages = new Map();
  let discordFails = false;
  const channel = { id: "order", isTextBased: () => true, messages: { fetch: async id => {
    if (discordFails) throw new Error("Discord offline");
    if (typeof id !== "string") return messages;
    if (!messages.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    return messages.get(id);
  } }, send: async (message) => {
    if (discordFails) throw new Error("Discord offline");
    sent.push(message); const id = String(sent.length);
    const saved = { id, embeds: message.embeds, edit: async payload => { if (discordFails) throw new Error("Discord offline"); saved.embeds = payload.embeds; return saved; } };
    messages.set(id, saved); return saved;
  } };
  const brokers = ids.map((id) => {
    const state = { orders: [], requests: [], executions: [], holdings: [], price: 120, failBalance: false, unknown: false, cancels: 0 };
    const tracker = { list: () => state.orders, pending: () => state.orders.filter(o => ["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(o.status)),
      record: (order) => { const previous = state.orders.find(o => o.orderNo === order.orderNo); const saved = { ...previous, ...order,
        createdAt: previous?.createdAt || order.createdAt || new Date().toISOString() }; state.orders = [...state.orders.filter(o => o.orderNo !== order.orderNo), saved]; return saved; } };
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
    return { id, label: id, environment, protectionEnabled: false, tracker, domesticClient: api, overseasClient: api, state };
  });
  const guild = { channels: { fetch: async () => new Map(["order", "execution", "system", "journal"]
    .map(id => [id, id === "order" ? channel : { ...channel, id, name: id }])) } };
  const channels: Record<string, string> = { order: "order", execution: "execution", system: "system", journal: "journal" };
  const runtime = createAccountRuntime({ brokers, receipts, client: { guilds: { fetch: async () => guild } },
    ownerId: "owner", targetGuildId: "guild", channels, readOnly, entryAllocation,
    trusted: { sourceChannelIds: new Set(["signal"]), sourceBotIds: new Set(["source"]) },
    trackingOptions: { attempts: 0 }, enrichNames: async items => items });
  return { runtime, receipts, brokers, sent, messages, channels, channel, guild, failDiscord: value => { discordFails = value; } };
}

function message(r) { return { id: r.requestId, channelId: "signal", author: { id: "source", bot: true }, embeds: [{ footer: { text: encodeSignalEnvelope(r) } }] }; }

(async () => {
  // Both mock broker routes must keep the nested-schema guard after transport and repricing.
  for (const brokerId of ["KIS", "KIWOOM"]) {
    let fullQuantity = 0;
    for (const grade of ["GO", "HALF", "WAIT", "NO", "OFF"]) {
      const f = fixture([brokerId]);
      const r: any = record(`nested-${brokerId}-${grade}`);
      Object.assign(r.payload, { schema_ver: "5.0", bar_time: clock, grade, trigger_price: 99,
        htf: "D", htf_trend: "BULL", htf_ema_aligned: true, htf_above_200ma: true,
        atr_multiple: 2, atr_dot: false, atr_dot_threshold: 8, setup_stage: "NONE" });
      for (const key of ["daily_trend", "daily_ema_aligned", "daily_above_200ma"]) delete r.payload[key];
      await f.runtime.processMessage(message(r));
      const saved = f.receipts.state.signals[r.requestId].record.payload;
      assert.equal(saved.grade, grade); assert.equal(saved.trigger_price, 99);
      const requests = f.brokers[0].state.requests;
      if (["GO", "HALF"].includes(grade)) {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].price, 99, "trigger caps the entry, even after current-price refresh");
        if (grade === "GO") fullQuantity = requests[0].quantity;
        else assert.equal(requests[0].quantity, Math.floor(fullQuantity / 2));
      } else assert.equal(requests.length, 0, "execution grade cannot be bypassed by a forwarded PAPER_ENTRY verdict");
    }
  }
  for (const allocation of [false, true]) for (const brokerId of ["KIS", "KIWOOM"]) {
    const capped = fixture([brokerId], "mock", false, allocation);
    for (let i = 0; i < 6; i++) {
      const candidate = record(`cap-${i}`);
      candidate.payload.ticker = `T${i}`;
      await capped.runtime.execute(capped.brokers[0], candidate);
    }
    assert.equal(capped.brokers[0].state.requests.length, 6, "mock entries are not capped at five, including accepted unfilled buys");
    for (const order of capped.brokers[0].state.orders) Object.assign(order, { status: "FILLED", filledQuantity: order.orderQuantity, remainingQuantity: 0, fillPrice: 100 });
    const balanceLag = record("balance-lag");
    balanceLag.payload.ticker = "LAG";
    await capped.runtime.execute(capped.brokers[0], balanceLag);
    assert.equal(capped.brokers[0].state.requests.length, allocation ? 6 : 7,
      "no mock count cap; allocation still blocks mismatched broker balances and ledger fills");
  }
  const falling = fixture();
  let quotes = 0;
  falling.brokers[0].overseasClient.getUsQuote = async () => ({ currentPrice: ++quotes === 1 ? 100 : 80 });
  const invalidated = await falling.runtime.execute(falling.brokers[0], record("final-quote-cross"));
  assert.equal(quotes, 2);
  assert.equal(invalidated.status, "BLOCKED");
  assert.equal(falling.brokers[0].state.requests.length, 0, "final quote below stop must never place a buy");

  const bounded = fixture();
  const deadline = { ...record("hard-deadline"), executionDeadline: clock + 60000 };
  const queued = bounded.receipts.putDeferred("KIS", deadline, 5 * 86400000);
  assert.equal(queued.expiresAt, deadline.executionDeadline);
  queued.expiresAt = clock + 5 * 86400000; // simulate an old persisted queue
  clock += 120000;
  await bounded.runtime.retryDeferred();
  assert.equal(bounded.receipts.listDeferred().length, 0);
  assert.equal(bounded.brokers[0].state.requests.length, 0);
  const daytime = clock;
  clock = new RealDate("2026-09-08T21:00:00Z").getTime();
  const closed = fixture();
  await closed.runtime.processMessage(message(record("next-session")));
  const sessionPlan = closed.receipts.listDeferred()[0];
  assert.equal(sessionPlan.record.executionDeadlineKind, "SESSION");
  assert.equal(sessionPlan.expiresAt, clock + 5 * 86400000, "fresh closed-session signal retains its intended plan lifetime");
  clock = daytime;

  // A deliberate owner request, not automatic policy-block replay, can queue a weekend review.
  {
    const priorClock = clock;
    clock = new RealDate("2026-09-19T01:00:00Z").getTime();
    const requested = fixture(["KIS"], "mock", false, true), b = requested.brokers[0];
    const r: any = { ...record("owner-review"), validation: { ok: true } };
    r.receivedAt = "2026-09-18T20:01:00Z";
    requested.receipts.signal(r, "KIS", { status: "NO_ACTION", reason: "최대 5종목 한도" });
    requested.receipts.state.entryAllocations = { [r.requestId]: { brokerId: "", reason: "최대 5종목 한도" } };
    const unsubmitted = record("expired-daily-allocation");
    unsubmitted.payload.timeframe = "D";
    unsubmitted.receivedAt = new Date(Date.parse(r.receivedAt) - 21.5 * 3600000).toISOString();
    unsubmitted.risk.verdict = "BUY_PENDING_APPROVAL";
    const expiredApproval = requested.receipts.putPending(unsubmitted, "old-approval", -1, ["KIS"]);
    requested.receipts.state.entryAllocations[unsubmitted.requestId] = { requestId: unsubmitted.requestId,
      brokerId: "KIS", symbol: "US:TEST", at: Date.parse(unsubmitted.receivedAt), timeframe: "D" };
    assert.equal(queueSignalRecheck(requested.receipts, b, r), null);
    assert.equal(queueSignalRecheck(requested.receipts, { ...b, environment: "live" }, r, new Date(), { ownerRequested: true }), null);
    const plan = queueSignalRecheck(requested.receipts, b, r, new Date(), { ownerRequested: true });
    assert.equal(new Date(plan.nextAttemptAt).toISOString(), "2026-09-21T13:30:00.000Z");
    assert.equal(plan.record.receivedAt, r.receivedAt);
    assert.equal(plan.record.reviewRequestedAt, new Date().toISOString());
    assert.equal(requested.receipts.state.entryAllocations[r.requestId], undefined);
    assert.equal(queueSignalRecheck(requested.receipts, b, r, new Date(), { ownerRequested: true }), null, "do not extend an existing reservation");
    await requested.runtime.retryDeferred();
    assert.equal(b.state.requests.length, 0, "no weekend order");
    clock = plan.nextAttemptAt;
    await requested.runtime.retryDeferred();
    assert.equal(b.state.requests.length, 1, "recalculate allocation and sizing at Monday open");
    assert.ok(requested.receipts.state.entryAllocations[unsubmitted.requestId], "preserve old allocation history");
    assert.equal(b.state.orders.some(o => o.requestId === unsubmitted.requestId), false, "expired approval itself is never executed");
    assert.ok(expiredApproval.expiresAt < clock);
    await requested.runtime.retryDeferred();
    assert.equal(b.state.requests.length, 1, "no duplicate order");
    for (const guard of ["declined", "approvalClosed", "unknown", "submitted", "invalid", "old", "superseded"]) {
      const denied = fixture(), db = denied.brokers[0];
      const candidate: any = { ...record(`owner-denied-${guard}`), validation: { ok: true } };
      denied.receipts.signal(candidate, "KIS", { status: "NO_ACTION" });
      if (["declined", "approvalClosed"].includes(guard)) denied.receipts.state.signals[candidate.requestId][guard] = true;
      if (guard === "unknown") denied.receipts.attempt("KIS", candidate, "UNKNOWN");
      if (guard === "submitted") db.state.orders.push({ requestId: candidate.requestId, status: "ACCEPTED" });
      if (guard === "invalid") candidate.validation.ok = false;
      if (guard === "old") candidate.receivedAt = new Date(clock - 6 * 86400_000).toISOString();
      if (guard === "superseded") denied.receipts.rememberExit("KIS", { ...candidate, payload: { ...candidate.payload, action: "SELL" }, risk: { verdict: "PAPER_EXIT" } });
      assert.equal(queueSignalRecheck(denied.receipts, db, candidate, new Date(), { ownerRequested: true }), null, guard);
    }
    clock = priorClock;
  }

  // Transient pre-order failures survive intake expiry without bypassing policy.
  {
    const startClock = clock;
    const delayed = fixture();
    delayed.brokers[0].state.failBalance = true;
    await delayed.runtime.processMessage(message(record("review-buy")));
    clock += 31 * 60_000;
    await delayed.runtime.retryInbox();
    const plan = delayed.receipts.listDeferred()[0];
    assert.equal(plan.kind, "REVIEW");
    assert.ok(plan.nextAttemptAt > clock);
    const restart = fixture();
    restart.receipts.state = structuredClone(delayed.receipts.state);
    await restart.runtime.retryDeferred();
    assert.equal(restart.brokers[0].state.requests.length, 0, "no pre-session submission after restart");
    clock = plan.nextAttemptAt;
    await restart.runtime.retryDeferred();
    assert.equal(restart.brokers[0].state.requests.length, 1);
    await restart.runtime.retryDeferred();
    assert.equal(restart.brokers[0].state.requests.length, 1, "no duplicate submission");

    clock = startClock;
    const approvalReview = fixture();
    const needsApproval = record("review-approval");
    needsApproval.risk.verdict = "BUY_PENDING_APPROVAL";
    approvalReview.brokers[0].state.failBalance = true;
    await approvalReview.runtime.processMessage(message(needsApproval));
    clock += 31 * 60_000;
    await approvalReview.runtime.retryInbox();
    clock = approvalReview.receipts.listDeferred()[0].nextAttemptAt;
    approvalReview.brokers[0].state.failBalance = false;
    await approvalReview.runtime.retryDeferred();
    assert.equal(approvalReview.brokers[0].state.requests.length, 0, "review is not user BUY approval");
    assert.equal(Object.keys(approvalReview.receipts.state.pending).length, 1);

    clock = startClock;
    for (const signalCode of ["EXIT_FINAL", "TAKE_PROFIT", "EXIT_PARTIAL_1"]) {
      const sellReview = fixture(["KIWOOM", "KIS"]);
      for (const b of sellReview.brokers) {
        b.state.orders.push({ orderNo: `entry-${b.id}`, requestId: `position-${b.id}`, symbol: "TEST", market: "NASDAQ",
          side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240", status: "FILLED", orderQuantity: 10,
          filledQuantity: 10, remainingQuantity: 0, fillPrice: 100, createdAt: new Date(clock - 60_000).toISOString() });
        b.state.holdings = [{ code: "TEST", quantity: 10, evaluationAmount: 1200, purchaseAmount: 1000 }];
        b.state.failBalance = true;
        b.overseasClient.getUsBalances = async () => {
          if (b.state.failBalance) throw new Error("balance unavailable");
          return [{ holdings: b.state.holdings }];
        };
        b.overseasClient.getUsBalance = async () => (await b.overseasClient.getUsBalances())[0];
      }
      const sell = record(`review-${signalCode}`, "SELL");
      sell.outcome.signal = { signalCode, tpLevel: 1 } as any;
      sell.risk.verdict = signalCode === "EXIT_FINAL" ? "PAPER_EXIT" : "PAPER_PARTIAL_EXIT";
      await sellReview.runtime.processMessage(message(sell));
      clock += 31 * 60_000;
      await sellReview.runtime.retryInbox();
      assert.equal(sellReview.receipts.listDeferred().length, 2, signalCode);
      assert.notEqual(sellReview.receipts.listDeferred()[0].record.reviewPositionEntryRequestId,
        sellReview.receipts.listDeferred()[1].record.reviewPositionEntryRequestId);
      clock = sellReview.receipts.listDeferred()[0].nextAttemptAt;
      await sellReview.runtime.retryDeferred(); // Still failing: durable inbox transfer.
      clock += 31 * 60_000;
      await sellReview.runtime.retryInbox();
      assert.equal(sellReview.receipts.listDeferred().length, 2, "failed sell review must remain queued");
      for (const b of sellReview.brokers) b.state.failBalance = false;
      // Replacement position in one account must not receive the old exit.
      sellReview.brokers[0].state.orders[0].requestId = "replacement-position";
      clock = sellReview.receipts.listDeferred()[0].nextAttemptAt;
      await sellReview.runtime.retryDeferred();
      assert.equal(sellReview.brokers[0].state.requests.length, 0);
      assert.equal(sellReview.brokers[1].state.requests.length, 1);
      assert.equal(sellReview.brokers[1].state.requests[0].side, "SELL");
      clock = startClock;
    }
    const guarded = fixture();
    const rejected = record("review-guard");
    guarded.receipts.signal(rejected, "KIS", { status: "DEFER_REQUIRED" });
    guarded.receipts.attempt("KIS", rejected, "UNKNOWN");
    assert.equal(queueSignalRecheck(guarded.receipts, guarded.brokers[0], rejected), null);
    delete guarded.receipts.state.attempts["KIS:review-guard"];
    (rejected as any).executionDeadlineKind = "APPROVAL";
    assert.equal(queueSignalRecheck(guarded.receipts, guarded.brokers[0], rejected), null);
    delete (rejected as any).executionDeadlineKind;
    guarded.receipts.signal(rejected).declined = true;
    assert.equal(queueSignalRecheck(guarded.receipts, guarded.brokers[0], rejected), null);
    guarded.receipts.signal(rejected).declined = false;
    assert.equal(queueSignalRecheck(guarded.receipts, { ...guarded.brokers[0], environment: "live" }, rejected), null);
    clock += 6 * 86400_000;
    assert.equal(queueSignalRecheck(guarded.receipts, guarded.brokers[0], rejected), null, "old buys are not renewed indefinitely");
    clock = startClock;

    const priority = fixture();
    const pb = priority.brokers[0];
    pb.state.orders.push({ orderNo: "owned", requestId: "owned-position", symbol: "HOLD", market: "NASDAQ",
      side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240", status: "FILLED", orderQuantity: 10,
      filledQuantity: 10, remainingQuantity: 0, fillPrice: 100, createdAt: new Date(clock - 60000).toISOString() });
    pb.state.holdings = [{ code: "HOLD", quantity: 10, evaluationAmount: 1200, purchaseAmount: 1000 }];
    const firstBuy = record("priority-buy"), laterSell = record("priority-sell", "SELL");
    laterSell.payload.ticker = "HOLD";
    for (const r of [firstBuy, laterSell]) {
      priority.receipts.signal(r, "KIS", { status: "DEFER_REQUIRED" });
      assert.ok(queueSignalRecheck(priority.receipts, pb, r));
    }
    const { lifecycleBrokerState: reviewCard } = require("../src/executor/signal-lifecycle");
    const card = reviewCard(priority.receipts.state.signals[firstBuy.requestId], pb, priority.receipts);
    assert.match(card.reason, /재검토/);
    assert.match(card.next, /<t:/);
    clock = priority.receipts.listDeferred()[0].nextAttemptAt;
    await priority.runtime.retryInbox();
    assert.deepEqual(pb.state.requests.map(r => r.side), ["SELL", "BUY"], "exit review precedes entry review");
    clock = startClock;
  }

  const portfolio = fixture();
  portfolio.channels.portfolio = "order";
  portfolio.brokers[0].state.failBalance = true;
  await portfolio.runtime.requestPortfolioSync();
  assert.equal(portfolio.receipts.state.portfolioRetry.nextAttemptAt, clock + 60000);
  await portfolio.runtime.requestPortfolioSync();
  assert.equal(portfolio.receipts.state.portfolioRetry.attempts, 1, "coalesced retry respects backoff");
  const resumedPortfolio = fixture();
  resumedPortfolio.channels.portfolio = "order";
  resumedPortfolio.receipts.state = structuredClone(portfolio.receipts.state);
  clock += 60000;
  await resumedPortfolio.runtime.requestPortfolioSync();
  assert.equal(resumedPortfolio.receipts.state.portfolioRetry, undefined, "persisted retry clears only after successful sync");
  assert.equal(resumedPortfolio.receipts.state.equityOutages["portfolio-sync"], undefined);

  const allocated = fixture(["KIWOOM", "KIS"], "mock", false, true);
  const buy = record("allocated-one");
  await allocated.runtime.processMessage(message(buy));
  assert.equal(allocated.brokers.reduce((n, b) => n + b.state.requests.length, 0), 1);
  const route = allocated.receipts.state.entryAllocations[buy.requestId];
  assert.ok(route.brokerId);
  const other = allocated.brokers.find(b => b.id !== route.brokerId);
  assert.equal((await allocated.runtime.execute(other, structuredClone(buy), { manual: true })).status, "NO_ACTION");
  const chosen = allocated.brokers.find(b => b.id === route.brokerId);
  const entryOrder = chosen.state.orders[0];
  Object.assign(entryOrder, { status: "FILLED", filledQuantity: entryOrder.orderQuantity, remainingQuantity: 0, fillPrice: 100 });
  chosen.state.holdings = [{ code: "TEST", quantity: entryOrder.orderQuantity, evaluationAmount: entryOrder.orderQuantity * 100, purchaseAmount: entryOrder.orderQuantity * 100 }];
  const routeClock = clock;
  clock += 14400001;
  await allocated.runtime.processMessage(message(record("later-independent-entry")));
  assert.equal(other.state.requests.length, 1);
  const restart = fixture(["KIWOOM", "KIS"], "mock", false, true);
  restart.receipts.state = JSON.parse(JSON.stringify(allocated.receipts.state));
  assert.equal((await restart.runtime.execute(restart.brokers.find(b => b.id !== route.brokerId), structuredClone(buy), { manual: true })).status, "NO_ACTION");
  assert.equal(restart.brokers.reduce((n, b) => n + b.state.requests.length, 0), 0);
  clock = routeClock;
  // A different owner has a different ledger and independently allocates the same signal.
  const independent = fixture(["KIS"], "mock", false, true);
  await independent.runtime.processMessage(message(buy));
  assert.equal(independent.brokers[0].state.requests.length, 1);
  const concurrent = fixture(["KIWOOM", "KIS"], "mock", false, true);
  await Promise.all([concurrent.runtime.processMessage(message(record("race-a"))), concurrent.runtime.processMessage(message(record("race-b")))]);
  assert.equal(concurrent.brokers.reduce((n, b) => n + b.state.requests.length, 0), 1);
  const routeOutage = fixture(["KIWOOM", "KIS"], "mock", false, true);
  routeOutage.brokers[0].state.failBalance = true;
  await routeOutage.runtime.processMessage(message(record("route-outage")));
  assert.equal(routeOutage.brokers.reduce((n, b) => n + b.state.requests.length, 0), 0);
  assert.ok(routeOutage.receipts.state.inbox['route-outage']);
  assert.equal(routeOutage.receipts.listDeferred().length, 0);
  // An unresolved unrelated order is a temporary wait, not a consumed BUY signal.
  const waiting = fixture(["KIS"], "mock", false, true);
  waiting.brokers[0].state.orders.push({ orderNo: "old", symbol: "OTHER", market: "NASDAQ", side: "BUY", status: "ACCEPTED", reconciliationRequired: true });
  const waitSignal = record("verification-wait");
  await waiting.runtime.processMessage(message(waitSignal));
  assert.ok(waiting.receipts.state.inbox[waitSignal.requestId]);
  assert.equal(waiting.brokers[0].state.requests.length, 0);
  assert.equal(waiting.receipts.state.signals[waitSignal.requestId].progress.KIS.status, "DEFER_REQUIRED");
  const originalDeadline = waiting.receipts.state.inbox[waitSignal.requestId].expiresAt;
  waiting.brokers[0].state.orders.length = 0; // Test-only: broker evidence fixture has resolved the old order.
  await waiting.runtime.retryInbox();
  await waiting.runtime.retryInbox();
  assert.equal(waiting.brokers[0].state.requests.length, 1);
  assert.equal(waiting.receipts.state.inbox[waitSignal.requestId], undefined);
  const expiredWait = fixture(["KIS"], "mock", false, true);
  expiredWait.brokers[0].state.orders.push({ orderNo: "old", symbol: "OTHER", market: "NASDAQ", status: "UNKNOWN" });
  await expiredWait.runtime.processMessage(message(record("expired-wait")));
  const expiredClock = clock;
  clock = originalDeadline + 1;
  expiredWait.brokers[0].state.orders.length = 0;
  await expiredWait.runtime.retryInbox();
  assert.equal(expiredWait.brokers[0].state.requests.length, 0);
  assert.equal(expiredWait.receipts.state.signals['expired-wait'].progress.KIS.status, "DEFER_REQUIRED");
  assert.equal(expiredWait.receipts.listDeferred()[0].kind, "REVIEW");
  assert.ok(expiredWait.receipts.listDeferred()[0].nextAttemptAt > clock);
  clock = expiredClock;
  const approvalWait = fixture(["KIS"], "mock", false, true);
  approvalWait.receipts.setAutoTrading(false);
  approvalWait.brokers[0].state.orders.push({ orderNo: "old", symbol: "OTHER", market: "NASDAQ", status: "UNKNOWN" });
  await approvalWait.runtime.processMessage(message(record("approval-wait")));
  assert.ok(approvalWait.receipts.state.inbox['approval-wait']);
  assert.equal(Object.keys(approvalWait.receipts.state.pending).length, 0);
  approvalWait.brokers[0].state.orders.length = 0;
  await approvalWait.runtime.retryInbox();
  assert.equal(Object.keys(approvalWait.receipts.state.pending).length, 1);
  assert.equal(approvalWait.brokers[0].state.requests.length, 0);
  // Waiting survives restart without extending the original deadline.
  const restoredWait = fixture(["KIS"], "mock", false, true);
  restoredWait.receipts.state = JSON.parse(JSON.stringify(routeOutage.receipts.state));
  const restoredDeadline = restoredWait.receipts.state.inbox['route-outage'].expiresAt;
  await restoredWait.runtime.retryInbox();
  assert.equal(restoredWait.brokers[0].state.requests.length, 1);
  assert.equal(restoredDeadline, routeOutage.receipts.state.inbox['route-outage'].expiresAt);
  const boundedWait = fixture(["KIS"], "mock", false, true);
  boundedWait.brokers[0].state.orders.push({ orderNo: "old", symbol: "OTHER", market: "NASDAQ", side: "BUY", environment: "mock",
    status: "ACCEPTED", reconciliationRequired: true, orderQuantity: 4, filledQuantity: 0, remainingQuantity: 4,
    limitPrice: 100, stopPrice: 90, plannedInvestment: 400, plannedRisk: 40, marketFallbackAllowed: false });
  await boundedWait.runtime.processMessage(message(record("bounded-other-symbol")));
  assert.equal(boundedWait.brokers[0].state.requests.length, 1);
  assert.equal(boundedWait.brokers[0].state.orders.find(o => o.orderNo === "old").status, "ACCEPTED");
  const approvalRoute = fixture(["KIWOOM", "KIS"], "mock", false, true);
  approvalRoute.receipts.setAutoTrading(false);
  await approvalRoute.runtime.processMessage(message(record("route-approval")));
  const onlyPending: any = Object.values(approvalRoute.receipts.state.pending)[0];
  assert.equal(onlyPending.brokerIds.length, 1);
  await approvalRoute.runtime.processApproval({ author: { id: "owner", bot: false }, guildId: "guild", channelId: "order", content: "둘다", reply: async () => {} });
  assert.equal(approvalRoute.brokers.reduce((n, b) => n + b.state.requests.length, 0), 1);
  const beforeRouteClock = clock;
  clock = new RealDate("2026-09-08T22:00:00Z").getTime();
  const closedWait = fixture(["KIS"], "mock", false, true);
  closedWait.brokers[0].state.orders.push({ orderNo: "old", symbol: "OTHER", market: "NASDAQ", status: "UNKNOWN" });
  await closedWait.runtime.processMessage(message(record("closed-verification")));
  assert.ok(closedWait.receipts.state.inbox['closed-verification']);
  assert.equal(closedWait.receipts.listDeferred().length, 0); // Not promoted to a multi-day market reservation.
  const reserved = fixture(["KIWOOM", "KIS"], "mock", false, true);
  await reserved.runtime.processMessage(message(record("route-closed")));
  assert.equal(reserved.receipts.listDeferred().length, 1);
  assert.equal(reserved.brokers.reduce((n, b) => n + b.state.requests.length, 0), 0);
  clock = beforeRouteClock;
  const initialClock = clock;
  const equityAlerts = fixture(["KIWOOM", "KIS"]);
  await equityAlerts.runtime.reportEquityStatus(equityAlerts.brokers[0], new Error("점검 중"));
  clock += 3600_000;
  await equityAlerts.runtime.reportEquityStatus(equityAlerts.brokers[0], new Error("다른 응답 오류"));
  assert.equal(equityAlerts.sent.length, 1);
  assert.equal(equityAlerts.receipts.state.equityOutages['KIWOOM:mock'].notified, true);
  // Restoring the persisted incident must not replay the same notification.
  const restoredEquity = fixture(["KIWOOM"]);
  restoredEquity.receipts.state.equityOutages = JSON.parse(JSON.stringify(equityAlerts.receipts.state.equityOutages));
  await restoredEquity.runtime.reportEquityStatus(restoredEquity.brokers[0], new Error("still down"));
  assert.equal(restoredEquity.sent.length, 0);
  await restoredEquity.runtime.reportEquityStatus(restoredEquity.brokers[0]);
  await restoredEquity.runtime.reportEquityStatus(restoredEquity.brokers[0]);
  assert.equal(restoredEquity.sent.length, 1); assert.equal(Object.keys(restoredEquity.receipts.state.equityOutages).length, 0);
  await equityAlerts.runtime.reportEquityStatus(equityAlerts.brokers[1], new Error("independent failure"));
  assert.equal(equityAlerts.sent.length, 2);
  const failedAlert = fixture(); failedAlert.failDiscord(true);
  await assert.rejects(failedAlert.runtime.reportEquityStatus(failedAlert.brokers[0], new Error("down")), /Discord/);
  failedAlert.failDiscord(false);
  await failedAlert.runtime.reportEquityStatus(failedAlert.brokers[0], new Error("down"));
  assert.equal(failedAlert.sent.length, 1);
  await equityAlerts.runtime.reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화", new Error("502"));
  const syncRestart = fixture();
  syncRestart.receipts.state.equityOutages = structuredClone(equityAlerts.receipts.state.equityOutages);
  clock += 86400_000;
  await syncRestart.runtime.reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화", new Error("504"));
  assert.equal(syncRestart.sent.length, 0);
  await syncRestart.runtime.reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화");
  await syncRestart.runtime.reportDataStatus("briefing-equity-sync", "Stock-Briefing 계좌 자산 동기화");
  assert.equal(syncRestart.sent.length, 1);
  assert.ok(syncRestart.receipts.state.equityOutages["KIWOOM:mock"]); // Independent broker outage stays open.
  clock = initialClock;
  clock = new RealDate("2026-09-08T20:00:32Z").getTime(); // 05:00 KST: mock closed, live aftermarket open.
  const sessions = fixture(["KIWOOM", "KIS"]);
  const partial = record("session-partial", "SELL");
  partial.risk.verdict = "PAPER_PARTIAL_EXIT";
  partial.outcome.signal.signalCode = "EXIT_PARTIAL_1";
  for (const broker of sessions.brokers) {
    broker.state.holdings = [{ code: "TEST", quantity: 122, tradableQuantity: 122, evaluationAmount: 12200, purchaseAmount: 12200 }];
    broker.tracker.record({ orderNo: "initial", market: "NASDAQ", symbol: "TEST", environment: "mock", side: "BUY",
      entryType: "PAPER_ENTRY", timeframe: "240", status: "FILLED", filledQuantity: 122, fillPrice: 100,
      createdAt: new Date(clock - 86400000).toISOString() });
    await sessions.runtime.executeOrDefer(broker, structuredClone(partial));
    // Existing legacy AFTER retries survive unchanged, but no longer bypass account hours.
    sessions.receipts.markMarketTransitionFailure(`${broker.id}:${partial.requestId}`, "2026-09-08:AFTER", new Error("장종료"));
  }
  const { lifecycleBrokerState } = require("../src/executor/signal-lifecycle");
  for (const time of ["2026-09-08T21:00:00Z", "2026-09-09T00:54:00Z", "2026-09-09T08:00:00Z", "2026-09-09T13:29:59Z"]) {
    clock = new RealDate(time).getTime();
    await sessions.runtime.retryDeferred();
    assert.equal(sessions.receipts.listDeferred().length, 2);
    for (const broker of sessions.brokers) {
      assert.equal(broker.state.requests.length, 0);
      const state = lifecycleBrokerState({ record: partial, progress: {} }, broker, sessions.receipts);
      assert.match(state.reason, /모의계좌 정규장/);
      assert.match(state.next, new RegExp(String(new RealDate("2026-09-09T13:30:00Z").getTime() / 1000)));
    }
  }
  clock = new RealDate("2026-09-09T13:30:00Z").getTime();
  await sessions.runtime.retryDeferred();
  await sessions.runtime.retryDeferred();
  assert.equal(sessions.receipts.listDeferred().length, 0);
  for (const broker of sessions.brokers) {
    assert.equal(broker.state.requests.length, 1);
    assert.equal(broker.state.requests[0].quantity, 30);
    assert.equal(broker.state.requests[0].side, "SELL");
  }
  clock = new RealDate("2026-09-08T20:00:32Z").getTime();
  const liveSessions = fixture(["KIWOOM", "KIS"], "live");
  for (const broker of liveSessions.brokers) {
    broker.state.holdings = sessions.brokers[0].state.holdings;
    broker.tracker.record({ ...sessions.brokers[0].state.orders.find(o => o.orderNo === "initial"), environment: "live" });
    await liveSessions.runtime.executeOrDefer(broker, structuredClone(partial));
    assert.equal(broker.state.requests.length, 1);
    assert.equal(broker.state.requests[0].quantity, 30);
  }
  // A broker queue crosses the close after preview: final pre-HTTP guard retains the order, never UNKNOWN.
  for (const id of ["KIWOOM", "KIS"]) {
    clock = new RealDate("2026-09-08T19:59:59Z").getTime();
    const crossing = fixture([id]), broker = crossing.brokers[0];
    const place = broker.overseasClient.placeUsLimitOrder;
    broker.overseasClient.placeUsLimitOrder = async request => {
      clock = new RealDate("2026-09-08T20:00:00Z").getTime();
      request.canSubmit();
      return place(request);
    };
    await crossing.runtime.executeOrDefer(broker, record("cross-close"));
    assert.equal(broker.state.requests.length, 0);
    assert.equal(crossing.receipts.listDeferred().length, 1);
    assert.equal(crossing.receipts.attempt(id, record("cross-close")).status, "RETRYABLE");
  }
  clock = initialClock;
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
  const ownerMessage = { author: { id: "owner", bot: false }, guildId: "guild", channelId: "order", content: "둘다", reply: async () => {} };
  for (const invalid of [{ guildId: "other" }, { guildId: undefined }, { author: { id: "other", bot: false } }, { author: { id: "owner", bot: true } }, { channelId: "other", channel: { name: "order" } }]) {
    assert.equal(await mixed.runtime.processApproval({ ...ownerMessage, ...invalid }), false);
    assert.equal(await mixed.runtime.processOwnerCommand({ ...ownerMessage, ...invalid, content: "!account auto off" }), false);
    assert.equal(mixed.receipts.autoTrading(), true);
    assert.equal(mixed.brokers.reduce((sum, broker) => sum + broker.state.requests.length, 0), 0);
  }
  await mixed.runtime.processOwnerCommand({ ...ownerMessage, content: "!account auto off" });
  assert.equal(mixed.receipts.autoTrading(), false);
  await mixed.runtime.processOwnerCommand({ ...ownerMessage, content: "!account auto on" });
  assert.equal(mixed.receipts.autoTrading(), true);
  await mixed.runtime.processApproval(ownerMessage);
  assert.deepEqual(mixed.brokers.map(b => b.state.requests.length), [1, 1]);
  assert.equal(mixed.sent.filter(item => item.embeds?.[0]?.title === "신호별 주문 진행").length, 1);
  const lifecycle = mixed.messages.get(mixed.receipts.state.signals.approval.messageId);
  assert(lifecycle.embeds[0].fields.every(field => /주문 접수/.test(field.value)));

  const named = fixture();
  named.channels.order = "named-orders";
  Object.assign(named.channel, { name: "named-orders" });
  const namedCommand = { ...ownerMessage, channel: { name: "named-orders" }, content: "!account auto off" };
  assert.equal(await named.runtime.processOwnerCommand(namedCommand), true);
  assert.equal(named.receipts.autoTrading(), false);
  const available = await named.guild.channels.fetch();
  available.set("duplicate", { ...named.channel, id: "duplicate" });
  named.guild.channels.fetch = async () => available;
  await assert.rejects(named.runtime.processOwnerCommand({ ...namedCommand, content: "!account auto on" }), /기록 채널을 찾을 수 없습니다/);
  assert.equal(named.receipts.autoTrading(), false);

  const isolated = fixture(["KIWOOM", "KIS"]);
  let releaseBalance;
  const balanceGate = new Promise(resolve => { releaseBalance = resolve; });
  isolated.brokers[1].domesticClient.getDomesticBalance = async () => { await balanceGate; return { estimatedAssets: 100000, holdings: [] }; };
  const firstJob = isolated.runtime.processMessage(message(record("slow-kis")));
  for (let i = 0; i < 20 && isolated.brokers[0].state.requests.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(isolated.brokers[0].state.requests.length, 1);
  assert.equal(isolated.brokers[1].state.requests.length, 0);
  let replied = false;
  await isolated.runtime.processOwnerCommand({ author: { id: "owner", bot: false }, guildId: "guild", channelId: "order", content: "!account status", reply: async () => { replied = true; } });
  assert(replied);
  const secondSignal = record("next-kiwoom"); secondSignal.payload.ticker = "SECOND";
  const secondJob = isolated.runtime.processMessage(message(secondSignal));
  for (let i = 0; i < 20 && isolated.brokers[0].state.requests.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(isolated.brokers[0].state.requests.length, 2); // not held behind the first signal's KIS response
  releaseBalance(); await Promise.all([firstJob, secondJob]);
  assert.equal(isolated.brokers[1].state.requests.length, 2);

  const crossing = fixture(["KIWOOM", "KIS"]);
  let releasePreview;
  const previewGate = new Promise(resolve => { releasePreview = resolve; });
  crossing.brokers[1].domesticClient.getDomesticBalance = async () => { await previewGate; return { estimatedAssets: 100000, holdings: [] }; };
  const older = record("older-approval"); older.risk.verdict = "BUY_PENDING_APPROVAL";
  const oldJob = crossing.runtime.processMessage(message(older));
  for (let i = 0; i < 20 && !crossing.receipts.findPending(); i++) await new Promise(resolve => setImmediate(resolve));
  clock++;
  const newer = record("newer-approval"); newer.risk.verdict = "BUY_PENDING_APPROVAL";
  const newJob = crossing.runtime.processMessage(message(newer));
  releasePreview(); await Promise.all([oldJob, newJob]);
  assert.equal(Object.keys(crossing.receipts.state.pending).length, 2); // completion order cannot replace another signal's approval
  assert.equal(crossing.receipts.findPending(), null); // reply to the exact card when ambiguous

  const interruptedBuy = fixture();
  let releaseQuote;
  const quoteGate = new Promise(resolve => { releaseQuote = resolve; });
  interruptedBuy.brokers[0].overseasClient.getUsQuote = async () => { await quoteGate; return { currentPrice: 100 }; };
  const buying = interruptedBuy.runtime.processMessage(message(record("waiting-buy")));
  await new Promise(resolve => setImmediate(resolve));
  clock++;
  const exiting = interruptedBuy.runtime.processMessage(message(record("incoming-exit", "SELL")));
  releaseQuote(); await Promise.all([buying, exiting]);
  assert.equal(interruptedBuy.brokers[0].state.requests.length, 0); // new exit seen while a broker request was in flight

  const restoredAck = fixture();
  restoredAck.receipts.attempt("KIS", record("acknowledged"), "SUBMITTING");
  restoredAck.brokers[0].tracker.record({ requestId: "acknowledged", orderNo: "known-ack", status: "FILLED", market: "NASDAQ", symbol: "TEST", filledQuantity: 1, fillPrice: 100 });
  await restoredAck.runtime.reconcileOrders();
  assert.equal(restoredAck.receipts.attempt("KIS", record("acknowledged")).status, "ACCEPTED");

  const disconnected = fixture();
  disconnected.failDiscord(true);
  await disconnected.runtime.processMessage(message(record("discord")));
  disconnected.failDiscord(false);
  await disconnected.runtime.processMessage(message(record("discord")));
  assert.equal(disconnected.brokers[0].state.requests.length, 1);
  await disconnected.runtime.reconcileOrders();
  await disconnected.runtime.refreshLifecycleCards();
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

  const protectedExit = fixture(["KIWOOM"]), pb = protectedExit.brokers[0];
  pb.protectionEnabled = true;
  pb.state.holdings = [{ code: "TEST", quantity: 5, tradableQuantity: 0, evaluationAmount: 500, purchaseAmount: 500 }];
  pb.tracker.record({ orderNo: "owned", requestId: "owned", market: "NASDAQ", symbol: "TEST", side: "BUY", entryType: "PAPER_ENTRY", environment: "mock",
    timeframe: "240", status: "FILLED", filledQuantity: 5, fillPrice: 100, stopPrice: 90, createdAt: new Date(clock - 10000).toISOString() });
  const stop = { orderNo: "stop1", requestId: "protection", market: "NASDAQ", symbol: "TEST", exchange: "ND", side: "SELL", environment: "mock",
    timeframe: "240", status: "ACCEPTED", orderQuantity: 5, filledQuantity: 0, remainingQuantity: 5, fillPrice: 0, stopPrice: 90,
    orderStyle: "BROKER_STOP", createdAt: new Date(clock).toISOString(), brokerOrderType: "35", brokerStopPrice: 90,
    orderTime: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(clock)) };
  pb.tracker.record(stop); pb.state.executions = [{ ...stop }];
  await protectedExit.runtime.executeOrDefer(pb, record("protected-exit", "SELL"));
  assert.equal(pb.state.cancels, 1); assert.equal(pb.state.requests.length, 0);
  pb.state.executions = [{ ...stop, status: "CANCELLED", rawStatus: "취소완료", filledQuantity: 2, remainingQuantity: 0, fillPrice: 89 }];
  pb.state.holdings = [{ code: "TEST", quantity: 3, tradableQuantity: 3, evaluationAmount: 300, purchaseAmount: 300 }];
  clock += 60001; await protectedExit.runtime.retryDeferred();
  assert.equal(pb.state.requests.length, 1); assert.equal(pb.state.requests[0].quantity, 3);

  const uncertainStop = fixture(["KIWOOM"]), ub = uncertainStop.brokers[0];
  ub.tracker.record({ ...stop }); ub.state.holdings = [{ code: "TEST", quantity: 5, tradableQuantity: 5 }];
  ub.tracker.record({ ...pb.tracker.list().find(o => o.orderNo === "owned") });
  await uncertainStop.runtime.executeOrDefer(ub, record("unknown-stop-exit", "SELL"));
  assert.equal(uncertainStop.receipts.listDeferred()[0].kind, "VERIFY");
  assert.equal(ub.state.requests.length, 0); assert.equal(ub.state.cancels, 0);
  for (const id of ["KIWOOM", "KIS"]) {
    const live = fixture([id], "live");
    const result = await live.runtime.executeOrDefer(live.brokers[0], record("unprotected-live-buy"));
    assert.equal(result.status, "BLOCKED"); assert.equal(live.brokers[0].state.requests.length, 0);
  }

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
      assert.equal(broker.state.orders.find(o => o.requestId === "owned-exit").policyVersion, require("../src/trading/policy-study").POLICY_VERSION);
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

  for (const id of ["KIWOOM", "KIS"]) {
    const guarded = fixture([id]), broker = guarded.brokers[0];
    const entry = { ...stopAlert.brokers[0].tracker.list()[0], requestId: "guarded-entry",
      environment: "mock", createdAt: new Date(clock - 10000).toISOString(), policyVersion: "legacy" };
    broker.tracker.record(entry);
    broker.state.holdings = [{ code: "TEST", quantity: 100, tradableQuantity: 100 }];
    broker.state.price = 80;
    await guarded.runtime.checkManagedStops();
    await guarded.runtime.checkManagedStops();
    assert.equal(broker.state.requests.length, 1, "a pending stop cannot be submitted twice");
    assert.equal(broker.state.requests[0].quantity, 10, "manual holdings must remain untouched");
    const exit = broker.tracker.list().find(o => o.source === "LOCAL_STOP_GUARD");
    assert.equal(exit.positionEntryRequestId, "guarded-entry");
    assert.equal(exit.signalCode, "EXIT_CRASH");
    assert.match(exit.evaluationIssues.join(), /정책 변경/);
    broker.tracker.record({ ...exit, status: "CANCELLED", remainingQuantity: 0, filledQuantity: 2, fillPrice: 80 });
    broker.state.holdings[0].quantity = broker.state.holdings[0].tradableQuantity = 98;
    await guarded.runtime.checkManagedStops();
    assert.equal(broker.state.requests.length, 2);
    assert.equal(broker.state.requests[1].quantity, 8, "only confirmed remaining managed shares are retried");

    for (const mode of ["live", "readonly", "paused", "closed", "unknown", "rebound", "pending-exit"]) {
      const locked = fixture([id], mode === "live" ? "live" : "mock", mode === "readonly"), b = locked.brokers[0];
      b.tracker.record({ ...entry, environment: b.environment }); b.state.holdings = [{ code: "TEST", quantity: 10, tradableQuantity: 10 }]; b.state.price = 80;
      if (mode === "paused") locked.receipts.setAutoTrading(false);
      if (mode === "unknown") b.state.unknown = true;
      if (mode === "pending-exit") b.tracker.record({ orderNo: "older-sell", symbol: "TEST", market: "NASDAQ", side: "SELL", status: "ACCEPTED", environment: "mock", filledQuantity: 0 });
      if (mode === "rebound") { let reads = 0; b.overseasClient.getUsQuote = async () => ({ currentPrice: ++reads === 1 ? 80 : 95 }); }
      const savedClock = clock;
      if (mode === "closed") clock = new RealDate("2026-09-08T20:00:01Z").getTime();
      await locked.runtime.checkManagedStops();
      await locked.runtime.checkManagedStops();
      await locked.runtime.retryDeferred();
      clock = savedClock;
      assert.equal(b.state.requests.length, mode === "unknown" ? 1 : 0, `${id}: ${mode} must not produce a duplicate/unauthorized sell`);
    }
  }

  const monitor = fixture(["KIS", "KIWOOM"]);
  for (const broker of monitor.brokers) {
    broker.state.holdings = ["TEST", "SECOND"].map(code => ({ code, quantity: 10, tradableQuantity: 10 }));
    for (const symbol of ["TEST", "SECOND"]) broker.tracker.record({ ...stopAlert.brokers[0].tracker.list()[0], orderNo: symbol, symbol });
  }
  let outage = "유효하지 않은 AppKey입니다.";
  const kisApi = monitor.brokers[0].overseasClient;
  const goodBalance = kisApi.getUsBalance;
  kisApi.getUsBalance = async () => { throw new Error(outage); };
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.length, 0); // Record immediately, but a single failed sweep is not a Discord incident.
  kisApi.getUsBalance = goodBalance;
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.length, 0); // Quiet recovery must not produce an orphan recovery notification.

  kisApi.getUsBalance = async () => { throw new Error(outage); };
  await monitor.runtime.checkManagedStops();
  outage = "1분당 1회";
  clock += 59_999;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.length, 0);
  clock++;
  monitor.failDiscord(true);
  await monitor.runtime.checkManagedStops();
  monitor.failDiscord(false);
  await monitor.runtime.checkManagedStops();
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 장애/.test(x.content || "")).length, 1);
  assert(monitor.sent.every(x => !(x.content || "").includes("KIWOOM"))); // Healthy broker stays independent.
  assert(!monitor.sent.some(x => /복구/.test(x.content || "") && (x.content || "").startsWith("✅")));
  kisApi.getUsBalance = goodBalance;
  const goodQuote = kisApi.getUsQuote;
  kisApi.getUsQuote = async ({ symbol }: any = {}) => { if (symbol === "SECOND") throw new Error("quote offline"); return { currentPrice: 120 }; };
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => (x.content || "").startsWith("✅")).length, 0); // Partial recovery is not recovery.
  kisApi.getUsQuote = goodQuote;
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  clock += 29_999;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => (x.content || "").startsWith("✅")).length, 0);
  clock++;
  monitor.failDiscord(true);
  await monitor.runtime.checkManagedStops();
  monitor.failDiscord(false);
  await monitor.runtime.checkManagedStops();
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 복구/.test(x.content || "")).length, 1);

  // Alternating failure/success must eventually alert, never announce unstable recovery.
  kisApi.getUsBalance = async () => { throw new Error(outage); };
  await monitor.runtime.checkManagedStops();
  kisApi.getUsBalance = goodBalance;
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  kisApi.getUsBalance = async () => { throw new Error(outage); };
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 장애/.test(x.content || "")).length, 2);
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 복구/.test(x.content || "")).length, 1);
  clock += 30 * 60_000;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 장애/.test(x.content || "")).length, 3); // Persistent outages retain reminders.
  kisApi.getUsBalance = goodBalance;
  await monitor.runtime.checkManagedStops();
  monitor.brokers[0].state.holdings = []; // An ownership mismatch cannot count as a second healthy sweep.
  clock += 30_000;
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 복구/.test(x.content || "")).length, 1);
  monitor.brokers[0].state.orders = []; // All managed positions gone: no remaining monitor target.
  await monitor.runtime.checkManagedStops();
  assert.equal(monitor.sent.filter(x => /손절 감시 조회 장애 해제/.test(x.content || "")).length, 1);

  const savedClock = clock, closeRecovery = fixture(["KIS"]), closeBroker = closeRecovery.brokers[0];
  closeBroker.state.holdings = [{ code: "TEST", quantity: 10, tradableQuantity: 10 }];
  closeBroker.tracker.record({ ...stopAlert.brokers[0].tracker.list()[0], symbol: "TEST" });
  const readBalance = closeBroker.overseasClient.getUsBalance;
  clock = new RealDate("2026-09-10T19:58:00Z").getTime();
  closeBroker.overseasClient.getUsBalance = async () => { throw Error("network down"); };
  await closeRecovery.runtime.checkManagedStops(); clock += 60000;
  await closeRecovery.runtime.checkManagedStops();
  let recoveryReads = 0;
  closeBroker.overseasClient.getUsBalance = async () => { recoveryReads++; return readBalance(); };
  clock = new RealDate("2026-09-10T20:01:00Z").getTime();
  await closeRecovery.runtime.checkManagedStops(); clock += 30000;
  await closeRecovery.runtime.checkManagedStops();
  assert.equal(closeRecovery.sent.filter(x => /조회 복구/.test(x.content || "")).length, 1);
  const recoveredReads = recoveryReads;
  await closeRecovery.runtime.checkManagedStops();
  assert.equal(recoveryReads, recoveredReads, "healthy closed accounts must stop recovery probes");
  assert.equal(closeBroker.state.requests.length, 0, "closed recovery must never submit orders");
  clock = savedClock;
  assert(monitor.brokers.every(b => b.state.requests.length === 0));
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
  const briefingToken = process.env.STOCK_BRIEFING_TOKEN;
  try {
    delete process.env.STOCK_BRIEFING_TOKEN;
    clock = new RealDate("2026-09-08T14:00:00Z").getTime();
    const localEquity = fixture();
    localEquity.receipts.file = path.join(dir, "local-equity.json");
    let equityQueries = 0;
    Object.assign(localEquity.brokers[0].overseasClient, { accountIdentityKey: () => "a".repeat(64), getAccountEquity: async () => {
      equityQueries++;
      return { scope: "account-total-assets", currency: "KRW", equity: 100, source: "test" };
    } });
    await localEquity.runtime.reportEquityStatus(localEquity.brokers[0], new Error("test outage"));
    await localEquity.runtime.requestEquitySync();
    assert.equal(equityQueries, 1, "unlinked accounts must still collect local equity");
    assert.equal(JSON.parse(fs.readFileSync(localEquity.receipts.file + ".evidence.json", "utf8")).equity.length, 1);
    assert.deepEqual(localEquity.receipts.state.equityOutages, {}, "successful local collection clears its outage");
    assert.equal(localEquity.receipts.state.briefingEquitySync, undefined, "no external sync without a token");
    await localEquity.runtime.requestEquitySync();
    assert.equal(equityQueries, 1, "retain hourly collection limit");
    const file = path.join(dir, "receipts.json");
    const before = new SignalReceiptStore(file, true);
    const item = before.receive(record("durable"), "durable-message");
    before.completeBroker(item, "KIWOOM");
    before.attempt("KIS", record("durable"), "SUBMITTING");
    const after = new SignalReceiptStore(file);
    assert.deepEqual(after.state.inbox.durable.completed, ["KIWOOM"]);
    assert.equal(after.attempt("KIS", record("durable")).status, "SUBMITTING");
    assert.equal(after.receive(record("durable"), "different-message"), after.state.inbox.durable);
  } finally {
    if (briefingToken === undefined) delete process.env.STOCK_BRIEFING_TOKEN;
    else process.env.STOCK_BRIEFING_TOKEN = briefingToken;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const switching = fixture();
  switching.brokers[0].environment = "live";
  assert.throws(() => createAccountRuntime({ brokers: switching.brokers, receipts: switching.receipts }), /상태 파일을 분리/);
  console.log("account-runtime test OK: OFF, reprice, broker isolation, Discord recovery, uncertain response, exit after cancellation, crash guard");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.Date = RealDate; });
