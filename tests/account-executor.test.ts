"use strict";

const assert = require("node:assert/strict");
const { accountCommand, accountContext, accountPortfolioSyncMinutes, accountRiskPolicy, accountSymbol, applyPyramidSizing, approvalText, approvedEntryVerdict, brokerEnvironments, buyApprovalRequiredForBroker, discordMessagePayload, enabledBrokerIds, enforceOpenRiskLimit, enforceOwnAccountRules, errorReportDue, invalidationExitReason, liveAutoBuyEligible, momentumExitRecommendation, orderNeedsPortfolioSync, orderNeedsResultReport, orderStatusUnknown, pyramidPlan, readOnlySignalAllowed, reconcilePendingBrokerOrders, requiresExistingPosition, shouldConsumeMessage, SignalReceiptStore, skippedNoPosition, trackedPortfolio, verificationDelayMs } = require("../src/executor/account-executor");
const { calculateWebhookPositionPreview } = require("../src/trading/position-sizer");

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
assert.deepEqual(accountRiskPolicy({}), { autoCapitalRatio: 0.1, maxOpenRiskRatio: 0.015 });
assert.throws(() => accountRiskPolicy({ ACCOUNT_AUTO_CAP_RATIO: "0" }), /ACCOUNT_AUTO_CAP_RATIO/);
assert.throws(() => accountRiskPolicy({ ACCOUNT_MAX_OPEN_RISK_RATIO: "1.1" }), /ACCOUNT_MAX_OPEN_RISK_RATIO/);
assert.equal(accountSymbol("A005930"), "005930");
assert.equal(accountSymbol("AAPL"), "AAPL");
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
assert.equal(orderStatusUnknown({ orderStatusUnknown: true }), true);
assert.equal(orderStatusUnknown(new Error("일반 오류")), false);

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
assert.equal(store.listDeferred()[0].kind, "ORDER");
store.markDeferredAttempt(deferred.key, "2026-08-26");
assert.equal(store.listDeferred()[0].lastAttemptMarketDate, "2026-08-26");
store.markDeferredFailure(deferred.key, new Error("temporary auth failure"));
assert.equal(store.listDeferred()[0].lastError, "temporary auth failure");
assert.equal(store.listDeferred().length, 1);
store.removeDeferred(deferred.key);
assert.equal(store.listDeferred().length, 0);
const verification = store.putDeferred("KIS", { requestId: "request-verify", payload: { exchange: "NASDAQ", ticker: "ABCL" } }, 60_000, { kind: "VERIFY", now: 1_000 });
assert.equal(store.markVerificationFailure(verification.key, new Error("gateway"), 1_000).nextAttemptAt, 61_000);
assert.equal(store.markVerificationFailure(verification.key, new Error("gateway"), 61_000).nextAttemptAt, 361_000);
assert.equal(store.markVerificationFailure(verification.key, new Error("gateway"), 361_000).nextAttemptAt, 1_261_000);
store.markDeferredOrder(verification.key);
assert.equal(store.listDeferred()[0].kind, "ORDER");
store.removeDeferred(verification.key);
assert.equal(verificationDelayMs(1), 60_000);
assert.equal(verificationDelayMs(2), 300_000);
assert.equal(verificationDelayMs(3), 900_000);
assert.equal(verificationDelayMs(9), 900_000);
const invalidationRecord = { payload: { exchange: "NYSE", ticker: "SE" } };
const invalidation = store.putInvalidation("KIS", invalidationRecord, 100, 1_000);
assert.equal(store.listInvalidations()[0].entryPrice, 100);
assert.match(invalidation.guardRequestId, /^entry-invalidation-KIS-/);
assert.equal(invalidationExitReason(invalidation, 97, 2_000), "진입가 대비 3% 이상 하락");
assert.equal(invalidationExitReason(invalidation, 99, invalidation.expiresAt), "진입 무효 확인 30분 초과");
assert.equal(invalidationExitReason(invalidation, 99, 2_000), "");
assert.equal(store.clearInvalidations(invalidationRecord), 1);
assert.equal(store.listInvalidations().length, 0);

const strongBuy = { payload: { action: "BUY", conviction: "A", daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true } };
const mixedBuy = { payload: { ...strongBuy.payload, daily_trend: "MIXED", daily_ema_aligned: false } };
assert.equal(liveAutoBuyEligible(strongBuy), true);
assert.equal(liveAutoBuyEligible({ payload: { ...strongBuy.payload, conviction: "B" } }), false);
assert.equal(liveAutoBuyEligible(mixedBuy), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "mock" }, mixedBuy, true), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "live" }, strongBuy, true), false);
assert.equal(buyApprovalRequiredForBroker({ environment: "live" }, mixedBuy, true), true);
assert.equal(buyApprovalRequiredForBroker({ environment: "mock" }, strongBuy, false), true);
assert.equal(approvedEntryVerdict({ outcome: { decision: "ENTRY_CANDIDATE" } }), "PAPER_ENTRY");
assert.equal(approvedEntryVerdict({ outcome: { decision: "ADD_CANDIDATE" } }), "PAPER_ADD");
assert.equal(requiresExistingPosition({ payload: { action: "BUY" }, risk: { verdict: "PAPER_ENTRY" } }), false);
assert.equal(requiresExistingPosition({ payload: { action: "BUY" }, risk: { verdict: "PAPER_ADD" } }), true);
assert.equal(requiresExistingPosition({ payload: { action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }), true);
assert.equal(requiresExistingPosition({ payload: { action: "SELL" }, risk: { verdict: "PAPER_PARTIAL_EXIT" } }), true);
assert.deepEqual(skippedNoPosition({ payload: { action: "BUY" }, risk: { verdict: "PAPER_ADD" } }, { hasExistingPosition: false }), { status: "SKIPPED_NO_POSITION", reason: "해당 계좌 미보유" });
assert.deepEqual(skippedNoPosition({ payload: { action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, { hasExistingPosition: false }), { status: "SKIPPED_NO_POSITION", reason: "해당 계좌 미보유" });
assert.equal(skippedNoPosition({ payload: { action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, { hasExistingPosition: true }), null);
assert.equal(skippedNoPosition({ payload: { action: "BUY" }, risk: { verdict: "PAPER_ENTRY" } }, { hasExistingPosition: false }), null);

assert.deepEqual(momentumExitRecommendation({
  hasExistingPosition: true, currentPositionQuantity: 10, positionProfitRate: 3.2,
}, { price: 100, momentum_tp: null, daily_trend: "BULL" }), {
  label: "수익 중", range: [0.2, 0.3], ratio: 0.2, quantity: 2, profitRate: 3.2,
});
assert.equal(momentumExitRecommendation({
  hasExistingPosition: true, currentPositionQuantity: 10, positionProfitRate: -2,
}, { price: 100, momentum_tp: null, daily_trend: "BEAR" }).quantity, 5);
assert.equal(momentumExitRecommendation({ hasExistingPosition: false, currentPositionQuantity: 0 }, {}), null);

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
assert.equal(applyPyramidSizing(pyramidRecord, {
  blocked: false, quantity: 8, currentPositionValue: 960, equity: 10_000, entryPrice: 120, stopPrice: 110,
  positionValue: 960, projectedPositionValue: 1920, projectedPositionRatio: 19.2, stopLossAmount: 80,
}, [initialEntry]).stopLossAmount, 40);

assert.deepEqual(trackedPortfolio([
  { revision: 1, market: "KRX", symbol: "005930", entryType: "PAPER_ENTRY", status: "FILLED", filledQuantity: 5, stopPrice: 90_000 },
  { revision: 2, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ENTRY", status: "FILLED", filledQuantity: 10, stopPrice: 90 },
  { revision: 3, market: "KRX", symbol: "000660", entryType: "PAPER_ENTRY", status: "ACCEPTED", orderQuantity: 2, remainingQuantity: 2, plannedInvestment: 200_000, plannedRisk: 10_000 },
], [
  { code: "005930", quantity: 5, evaluationAmount: 550_000, purchaseAmount: 500_000 },
], [
  { code: "AAPL", quantity: 10, evaluationAmount: 1_100, purchaseAmount: 1_000 },
], 1250), { deployedKrw: 2_125_000, openRiskKrw: 185_000, hasUsExposure: true });
assert.deepEqual(trackedPortfolio([
  { revision: 1, market: "NASDAQ", symbol: "AAPL", entryType: "PAPER_ENTRY", status: "FILLED", filledQuantity: 10, stopPrice: 90 },
  { revision: 2, market: "NASDAQ", symbol: "AAPL", fullExit: true, status: "FILLED", filledQuantity: 10 },
  { revision: 3, market: "KRX", symbol: "000660", entryType: "PAPER_ENTRY", status: "PARTIALLY_FILLED", orderQuantity: 4, filledQuantity: 2, remainingQuantity: 2, plannedInvestment: 400_000, plannedRisk: 40_000 },
], [], [], 1250), { deployedKrw: 200_000, openRiskKrw: 20_000, hasUsExposure: false });
assert.equal(enforceOpenRiskLimit({
  blocked: false, capitalOnly: false, currentOpenRisk: 60_000, stopLossAmount: 20_000,
  maxOpenRisk: 75_000, maxOpenRiskRatio: 0.015, quantity: 2,
}).blocked, true);
assert.equal(enforceOpenRiskLimit({
  blocked: false, capitalOnly: false, currentOpenRisk: 50_000, stopLossAmount: 20_000,
  maxOpenRisk: 75_000, maxOpenRiskRatio: 0.015, quantity: 2,
}).blocked, false);

(async () => {
  const context = await accountContext({
    getDomesticBalance: async () => ({ estimatedAssets: 0, totalEvaluation: 0, holdings: [] }),
    getUsBalances: async () => [{ holdings: [{ code: "SE", quantity: 63, evaluationAmount: 7625.52 }] }],
    getUsCash: async () => ({ usd: 92294.675 }),
  }, { payload: { exchange: "NYSE", ticker: "SE", price: 121.18 } }, 5);
  assert.equal(context.accountPositionRatio, 7625.52 / (92294.675 + 7625.52) * 100);
  assert.equal(context.autoCapital, null);

  const liveDomestic = await accountContext({
    getDomesticBalance: async () => ({ estimatedAssets: 50_000_000, totalEvaluation: 50_000_000, holdings: [] }),
    getUsBalances: async () => [{ holdings: [] }],
    getDomesticCash: async () => ({ orderableAmount: 40_000_000 }),
  }, { payload: { exchange: "KRX", ticker: "005930", price: 100_000 } }, 5, {
    orders: [], riskPolicy: accountRiskPolicy({}),
  });
  assert.equal(liveDomestic.totalAccountEquity, 50_000_000);
  assert.equal(liveDomestic.autoCapital, 5_000_000);
  assert.equal(liveDomestic.availableCash, 5_000_000);
  assert.equal(liveDomestic.maxOpenRisk, 75_000);
  const livePreview = calculateWebhookPositionPreview({
    payload: { price: 100_000, sl: 99_999, conviction: "B", daily_trend: "BULL", daily_ema_aligned: true, daily_above_200ma: true },
    outcome: { decision: "ENTRY_CANDIDATE", signal: { signalCode: "ENTRY_STANDARD" } },
  }, liveDomestic);
  assert.equal(livePreview.positionValue, 1_000_000);
  assert.equal(livePreview.projectedPositionRatio, 20);

  const liveUs = await accountContext({
    getDomesticBalance: async () => ({ estimatedAssets: 50_000_000, totalEvaluation: 50_000_000, holdings: [] }),
    getUsBalances: async () => [{ holdings: [] }],
    getUsCash: async () => ({ usd: 10_000 }),
    getUsdExchangeRate: async () => 1250,
  }, { payload: { exchange: "NASDAQ", ticker: "AAPL", price: 100 } }, 5, {
    orders: [], riskPolicy: accountRiskPolicy({}),
  });
  assert.equal(liveUs.totalAccountEquity, 40_000);
  assert.equal(liveUs.autoCapital, 4_000);
  assert.equal(liveUs.availableCash, 4_000);

  const approval = approvalText({ payload: { ticker: "SE", name: "Sea Limited" } }, {
    KIS: { label: "한투", preview: { blocked: false, quantity: 4, currency: "USD", positionValue: 484.72, projectedPositionRatio: 7.64, positionLimitRatio: 0.2, pyramidStage: 1, pyramidRatio: 0.5, initialEntryQuantity: 8 } },
  }, ["KIS"]);
  assert.match(approval, /주문 후 계좌 비중 7\.64% \/ 최대 20%/);
  assert.match(approval, /`한투만` \/ `안 사`/);
  assert.doesNotMatch(approval, /둘다/);
  assert.match(approval, /피라미딩 1차\(최초 8주의 50%\)/);
  assert.match(approvalText({ payload: { ticker: "SE", name: "Sea Limited" } }, {
    KIS: { label: "한투", preview: { blocked: false, capitalOnly: true, quantity: 8, currency: "USD", positionValue: 800, projectedPositionRatio: 10, positionLimitRatio: 0.1 } },
  }, ["KIS"]), /PEG 손절가 없음/);
  assert.match(approvalText({ payload: { ticker: "AAPL", name: "Apple" } }, {
    KIS: { label: "한투", preview: { blocked: false, quantity: 2, currency: "USD", positionValue: 200, projectedPositionRatio: 5, positionLimitRatio: 0.2, totalAccountEquity: 40_000, autoCapital: 4_000, autoCapitalRatio: 0.1, maxOpenRiskRatio: 0.015 } },
  }, ["KIS"]), /실계좌 안전한도.*자동운용 10%.*동시 손절위험 최대 1\.5%/);

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
  console.log("account-executor test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
