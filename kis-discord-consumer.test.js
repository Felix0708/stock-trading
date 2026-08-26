"use strict";

const assert = require("node:assert/strict");
const { accountCommand, accountContext, accountPortfolioSyncMinutes, brokerEnvironments, enabledBrokerIds, enforceOwnAccountRules, reconcilePendingBrokerOrders, shouldConsumeMessage, SignalReceiptStore } = require("./kis-discord-consumer");

assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "true" }), ["KIWOOM", "KIS"]);
assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "false" }), ["KIWOOM"]);
assert.deepEqual(enabledBrokerIds({ KIS_CONSUMER_ENABLED: "true" }), ["KIS"]);
assert.deepEqual(enabledBrokerIds({}), []);
assert.deepEqual(brokerEnvironments(["KIWOOM", "KIS"], { KIWOOM_ENV: "mock", KIS_ENV: "live", ACCOUNT_LIVE_TRADING: "true" }), { KIWOOM: "mock", KIS: "live" });
assert.throws(() => brokerEnvironments(["KIWOOM"], { KIWOOM_ENV: "live" }), /ACCOUNT_LIVE_TRADING=true/);
assert.equal(accountPortfolioSyncMinutes({ MY_PORTFOLIO_SYNC_MINUTES: "10" }), 1440);
assert.equal(accountPortfolioSyncMinutes({ ACCOUNT_PORTFOLIO_SYNC_MINUTES: "720", MY_PORTFOLIO_SYNC_MINUTES: "10" }), 720);

assert.equal(accountCommand("계좌 상태 보여줘"), "STATUS");
assert.equal(accountCommand("계좌 상태"), "STATUS");
assert.equal(accountCommand("사용자A 계좌 상태", "사용자A"), "STATUS");
assert.equal(accountCommand("사용자B 계좌 상태", "사용자A"), "");
assert.equal(accountCommand("계좌 최근 주문 보여줘"), "ORDERS");
assert.equal(accountCommand("계좌 명령어 보여줘"), "HELP");
assert.equal(accountCommand("최근 주문 보여줘"), "");
assert.equal(accountCommand("자동매매 켜"), "AUTO_ON");
assert.equal(accountCommand("자동매매 꺼"), "AUTO_OFF");
assert.equal(accountCommand("자동매매 상태"), "AUTO_STATUS");
assert.equal(accountCommand("!account auto on"), "AUTO_ON");
assert.equal(accountCommand("!account auto off"), "AUTO_OFF");
assert.equal(accountCommand("!account auto status"), "AUTO_STATUS");
assert.equal(accountCommand("!계좌 자동매매 켜"), "AUTO_ON");
assert.equal(accountCommand("!계좌 자동매매 꺼"), "AUTO_OFF");
assert.equal(accountCommand("사용자A 자동매매 켜", "사용자A"), "AUTO_ON");
assert.equal(accountCommand("사용자B 자동매매 켜", "사용자A"), "");

const trusted = { sourceChannelIds: new Set(["channel-1"]), sourceBotIds: new Set(["bot-1"]) };
assert.equal(shouldConsumeMessage({ channelId: "channel-1", author: { id: "bot-1", bot: true } }, trusted), true);
assert.equal(shouldConsumeMessage({ channelId: "channel-2", author: { id: "bot-1", bot: true } }, trusted), false);
assert.equal(shouldConsumeMessage({ channelId: "channel-1", author: { id: "human", bot: false } }, trusted), false);

const store = new SignalReceiptStore(null);
assert.equal(store.autoTrading(), false);
store.setAutoTrading(true);
assert.equal(store.autoTrading(), true);
assert.equal(store.claim("request-1", "message-1"), true);
assert.equal(store.claim("request-1", "message-2"), false);
assert.equal(store.claim("request-2", "message-1"), false);
const pending = store.putPending({ payload: { exchange: "NASDAQ", ticker: "PLTR" } }, "approval-1", 60_000);
assert.equal(store.findPending({ ticker: "PLTR" }).key, pending.key);
assert.equal(store.findPending({ messageId: "approval-1" }).key, pending.key);
store.removePending(pending.key);
assert.equal(store.findPending({ ticker: "PLTR" }), null);
const deferred = store.putDeferred("KIWOOM", { requestId: "request-3", payload: { exchange: "NYSE", ticker: "SE" } }, 60_000);
assert.equal(store.listDeferred()[0].key, deferred.key);
store.markDeferredAttempt(deferred.key, "2026-08-26");
assert.equal(store.listDeferred()[0].lastAttemptMarketDate, "2026-08-26");
store.markDeferredFailure(deferred.key, new Error("temporary auth failure"));
assert.equal(store.listDeferred()[0].lastError, "temporary auth failure");
assert.equal(store.listDeferred().length, 1);
store.removeDeferred(deferred.key);
assert.equal(store.listDeferred().length, 0);

const preview = { blocked: false, quantity: 10 };
assert.deepEqual(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ENTRY" } }, { hasExistingPosition: true }, preview),
  { blocked: true, quantity: 0, reason: "해당 계좌에 이미 보유 중 — 중복 진입 차단" },
);
assert.equal(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ADD" } }, { hasExistingPosition: true, positionProfitable: true }, preview),
  preview,
);
assert.equal(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ADD" } }, { hasExistingPosition: true, positionProfitable: false }, preview).blocked,
  true,
);

(async () => {
  const context = await accountContext({
    getDomesticBalance: async () => ({ estimatedAssets: 0, totalEvaluation: 0, holdings: [] }),
    getUsBalances: async () => [{ holdings: [{ code: "SE", quantity: 63, evaluationAmount: 7625.52 }] }],
    getUsCash: async () => ({ usd: 92294.675 }),
  }, { payload: { exchange: "NYSE", ticker: "SE", price: 121.18 } }, 5);
  assert.equal(context.portfolioPositionRatio, 100);

  const changes = await reconcilePendingBrokerOrders({
    tracker: {
      pending: () => [{ orderNo: "1903", market: "NYSE", exchange: "NY", symbol: "SE", status: "ACCEPTED", filledQuantity: 0, remainingQuantity: 63 }],
      record: (order) => order,
    },
    overseasClient: { getUsOrderExecutions: async () => [{ orderNo: "1903", status: "FILLED", filledQuantity: 63, remainingQuantity: 0, fillPrice: 120.95 }] },
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].current.status, "FILLED");
  assert.equal(changes[0].previous.status, "ACCEPTED");
  console.log("kis-discord-consumer test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
