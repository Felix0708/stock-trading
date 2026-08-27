"use strict";

const assert = require("node:assert/strict");
const { accountCommand, accountContext, accountPortfolioSyncMinutes, applyPyramidSizing, approvalText, brokerEnvironments, buyApprovalRequiredForBroker, discordMessagePayload, enabledBrokerIds, enforceOwnAccountRules, errorReportDue, liveAutoBuyEligible, orderNeedsPortfolioSync, orderNeedsResultReport, pyramidPlan, readOnlySignalAllowed, reconcilePendingBrokerOrders, shouldConsumeMessage, SignalReceiptStore } = require("./kis-discord-consumer");

assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "true" }), ["KIWOOM", "KIS"]);
assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "false" }), ["KIWOOM"]);
assert.deepEqual(enabledBrokerIds({ KIS_CONSUMER_ENABLED: "true" }), ["KIS"]);
assert.deepEqual(enabledBrokerIds({}), []);
assert.deepEqual(brokerEnvironments(["KIWOOM", "KIS"], { KIWOOM_ENV: "mock", KIS_ENV: "live", ACCOUNT_LIVE_TRADING: "true" }), { KIWOOM: "mock", KIS: "live" });
assert.deepEqual(brokerEnvironments(["KIWOOM"], { KIWOOM_ENV: "live", ACCOUNT_READ_ONLY: "true" }), { KIWOOM: "live" });
assert.throws(() => brokerEnvironments(["KIWOOM"], { KIWOOM_ENV: "live" }), /ACCOUNT_LIVE_TRADING=true/);
assert.equal(readOnlySignalAllowed({ payload: { paper_order_test: true } }, true), true);
assert.equal(readOnlySignalAllowed({ payload: { paper_order_test: false } }, true), false);
assert.equal(readOnlySignalAllowed({ payload: {} }, false), true);
assert.equal(accountPortfolioSyncMinutes({ MY_PORTFOLIO_SYNC_MINUTES: "10" }), 1440);
assert.equal(accountPortfolioSyncMinutes({ ACCOUNT_PORTFOLIO_SYNC_MINUTES: "720", MY_PORTFOLIO_SYNC_MINUTES: "10" }), 720);
assert.deepEqual(discordMessagePayload({ text: "중복되면 안 됨", embed: { title: "카드" } }), { embeds: [{ title: "카드" }] });
assert.deepEqual(discordMessagePayload({ text: "텍스트만" }), { content: "텍스트만" });
assert.equal(orderNeedsResultReport({ status: "FILLED", source: "USER_SCHEDULED_EXIT" }), false);
assert.equal(orderNeedsResultReport({ status: "FILLED", source: "USER_SCHEDULED_EXIT", executorReportable: true }), true);
assert.equal(orderNeedsResultReport({ status: "FILLED", source: "USER_SCHEDULED_EXIT", executorReportable: true, filledQuantity: 127, executionReportedStatus: "FILLED", journalReportedStatus: "FILLED", portfolioSyncedFilledQuantity: 127 }), false);
assert.equal(orderNeedsResultReport({ status: "ACCEPTED", source: "USER_SCHEDULED_EXIT" }), false);
assert.equal(orderNeedsPortfolioSync({ status: "FILLED", filledQuantity: 63 }), true);
assert.equal(orderNeedsPortfolioSync({ status: "FILLED", filledQuantity: 63, portfolioSyncedFilledQuantity: 63 }), false);
assert.equal(orderNeedsPortfolioSync({ status: "REJECTED", filledQuantity: 0 }), false);
assert.equal(errorReportDue(undefined, 100_000), true);
assert.equal(errorReportDue(90_000, 100_000), false);
assert.equal(errorReportDue(0, 30 * 60_000), true);

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
const pending = store.putPending({ payload: { exchange: "NASDAQ", ticker: "PLTR" } }, "approval-1", 60_000, ["KIS"]);
assert.deepEqual(pending.brokerIds, ["KIS"]);
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

const strongBuy = { payload: { action: "BUY", conviction: "A", daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true } };
const mixedBuy = { payload: { ...strongBuy.payload, daily_trend: "MIXED", daily_ema_aligned: false } };
assert.equal(liveAutoBuyEligible(strongBuy), true);
assert.equal(liveAutoBuyEligible({ payload: { ...strongBuy.payload, conviction: "B" } }), false);
assert.equal(liveAutoBuyEligible(mixedBuy), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "mock" }, mixedBuy, true), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "live" }, strongBuy, true), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "live" }, mixedBuy, true), true);
assert.equal(buyApprovalRequiredForBroker({ environment: "mock" }, strongBuy, false), true);

const tp1 = { payload: { exchange: "NYSE", ticker: "SE" }, outcome: { signal: { signalCode: "EXIT_PARTIAL_1" } } };
assert.equal(store.partialExitBlocked("KIS", tp1), false);
store.reservePartialExit("KIS", { market: "NYSE", symbol: "SE", partialExitStage: "TP1", orderNo: "3001" });
assert.equal(store.partialExitBlocked("KIS", tp1), true);
store.reconcileTradeStage("KIS", { market: "NYSE", symbol: "SE", partialExitStage: "TP1", orderNo: "3001", status: "CANCELLED", filledQuantity: 0 });
assert.equal(store.partialExitBlocked("KIS", tp1), false);
store.reservePartialExit("KIS", { market: "NYSE", symbol: "SE", partialExitStage: "TP1", orderNo: "3002" });
store.reconcileTradeStage("KIS", { market: "NYSE", symbol: "SE", partialExitStage: "TP1", orderNo: "3002", status: "CANCELLED", filledQuantity: 2 });
assert.equal(store.partialExitBlocked("KIS", tp1), true);
store.resetPartialExits("KIS", "NYSE", "SE");
assert.equal(store.partialExitBlocked("KIS", tp1), false);

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
assert.equal(orderNeedsPortfolioSync({ status: "CANCELLED", filledQuantity: 2, portfolioSyncedFilledQuantity: 0 }), true);

const pyramidRecord = { payload: { exchange: "NASDAQ", ticker: "AAPL", price: 120 }, risk: { verdict: "PAPER_ADD" } };
const initialEntry = { revision: 1, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ENTRY", status: "FILLED", filledQuantity: 8 };
assert.match(pyramidPlan([], pyramidRecord).reason, /최초 진입 체결수량/);
assert.deepEqual(pyramidPlan([initialEntry], pyramidRecord), { blocked: false, stage: 1, ratio: 0.5, quantity: 4, initialEntryQuantity: 8 });
assert.match(pyramidPlan([{ ...initialEntry, status: "PARTIALLY_FILLED", filledQuantity: 4 }], pyramidRecord).reason, /최초 진입 주문 체결 완료 확인 중/);
assert.match(pyramidPlan([initialEntry, { revision: 2, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ADD", status: "ACCEPTED", filledQuantity: 0 }], pyramidRecord).reason, /체결 확인 중/);
assert.deepEqual(pyramidPlan([initialEntry, { revision: 2, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ADD", status: "FILLED", filledQuantity: 4 }], pyramidRecord), { blocked: false, stage: 2, ratio: 0.25, quantity: 2, initialEntryQuantity: 8 });
assert.match(pyramidPlan([initialEntry,
  { revision: 2, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ADD", status: "FILLED", filledQuantity: 4 },
  { revision: 3, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ADD", status: "FILLED", filledQuantity: 2 },
], pyramidRecord).reason, /2차까지 실행 완료/);
assert.match(pyramidPlan([initialEntry, { revision: 2, market: "NASDAQ", symbol: "AAPL", fullExit: true, status: "FILLED", filledQuantity: 14 }], pyramidRecord).reason, /최초 진입 체결수량/);
assert.deepEqual(pyramidPlan([initialEntry, { revision: 2, market: "NASDAQ", symbol: "AAPL", fullExit: true, status: "PARTIALLY_FILLED", filledQuantity: 4 }], pyramidRecord), { blocked: false, stage: 1, ratio: 0.5, quantity: 4, initialEntryQuantity: 8 });
const pyramidSizing = applyPyramidSizing(pyramidRecord, {
  blocked: false, quantity: 3, currentPositionValue: 960, equity: 10_000, positionValue: 360, projectedPositionValue: 1320, projectedPositionRatio: 13.2,
}, [initialEntry]);
assert.deepEqual({ ...pyramidSizing, projectedPositionRatio: 13.2 }, {
  blocked: false, quantity: 3, currentPositionValue: 960, equity: 10_000, positionValue: 360, projectedPositionValue: 1320, projectedPositionRatio: 13.2,
  pyramidStage: 1, pyramidRatio: 0.5, initialEntryQuantity: 8,
});
assert.ok(Math.abs(pyramidSizing.projectedPositionRatio - 13.2) < 1e-9);

(async () => {
  const context = await accountContext({
    getDomesticBalance: async () => ({ estimatedAssets: 0, totalEvaluation: 0, holdings: [] }),
    getUsBalances: async () => [{ holdings: [{ code: "SE", quantity: 63, evaluationAmount: 7625.52 }] }],
    getUsCash: async () => ({ usd: 92294.675 }),
  }, { payload: { exchange: "NYSE", ticker: "SE", price: 121.18 } }, 5);
  assert.equal(context.accountPositionRatio, 7625.52 / (92294.675 + 7625.52) * 100);

  const approval = approvalText({ payload: { ticker: "SE", name: "Sea Limited" } }, {
    KIS: { label: "한투", preview: { blocked: false, quantity: 4, currency: "USD", positionValue: 484.72, projectedPositionRatio: 7.64, positionLimitRatio: 0.2, pyramidStage: 1, pyramidRatio: 0.5, initialEntryQuantity: 8 } },
  }, ["KIS"]);
  assert.match(approval, /주문 후 계좌 비중 7\.64% \/ 최대 20%/);
  assert.match(approval, /`한투만` \/ `안 사`/);
  assert.doesNotMatch(approval, /둘다/);
  assert.match(approval, /피라미딩 1차\(최초 8주의 50%\)/);

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
