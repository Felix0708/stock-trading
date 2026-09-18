"use strict";

const assert = require("node:assert/strict");
const { calculateTradingPerformance, harmonizePortfolioNames, syncAccountPortfolio, tradingPerformanceSnapshot, strategyComparison, formatStrategyComparisonMessage, sigmaBand } = require("../src/executor/account-portfolio");
const { evaluateExecution } = require("../src/executor/trade-evaluation");

const emptyBroker = (id, label): any => ({
  id, label, environment: id === "KIS" ? "live" : "mock",
  tracker: { list: () => [] },
  domesticClient: { getDomesticBalance: async () => ({ estimatedAssets: 100_000, holdings: [] }) },
  overseasClient: {
    getUsBalances: async () => [{ holdings: [] }],
    getUsBalance: async () => ({ totalEvaluation: 0, holdings: [] }),
    getUsCash: async () => ({ usd: 10_000 }),
  },
});

(async () => {
  let editedPayload;
  const oldMessage = {
    embeds: [{ title: "나의 포트폴리오" }],
    edit: async (payload) => { editedPayload = payload; return { id: "portfolio-1" }; },
  };
  let performancePayload;
  const oldPerformanceMessage = {
    embeds: [{ title: "자동매매 누적 성과" }],
    edit: async (payload) => { performancePayload = payload; return { id: "performance-1" }; },
  };
  const channel = {
    messages: { fetch: async () => new Map([["portfolio-1", oldMessage], ["performance-1", oldPerformanceMessage]]) },
    send: async () => { throw new Error("기존 포트폴리오 카드를 새 메시지로 만들면 안 됩니다."); },
  };
  const result = await syncAccountPortfolio(channel, [emptyBroker("KIWOOM", "키움"), emptyBroker("KIS", "한투")], "2026-08-26T00:00:00.000Z");
  assert.equal(result.message.id, "portfolio-1");
  assert.equal(result.accounts.length, 2);
  assert.deepEqual([...result.succeededBrokerIds], ["KIWOOM", "KIS"]);
  assert.match(editedPayload.embeds[0].description, /키움 모의계좌/);
  assert.match(editedPayload.embeds[0].description, /한투 실계좌/);
  assert.match(performancePayload.embeds[0].description, /역대.*완료 0건/);
  assert.equal(result.performance.length, 2);
  assert.deepEqual(result.performance[0].all, { count: 0, wins: 0, losses: 0, draws: 0, win_rate: null });
  const harmonized = harmonizePortfolioNames([
    { domestic: { holdingPositions: [] }, overseas: { holdingPositions: [{ code: "DELL", name: "델 테크놀로지스", koreanName: "델 테크놀로지스" }] } },
    { domestic: { holdingPositions: [] }, overseas: { holdingPositions: [{ code: "DELL", name: "Dell Technologies Inc", englishName: "Dell Technologies Inc" }] } },
  ]);
  assert.deepEqual(harmonized.map((account) => account.overseas.holdingPositions[0].koreanName), ["델 테크놀로지스", "델 테크놀로지스"]);

  const performance = calculateTradingPerformance([
    { revision: 1, status: "FILLED", side: "BUY", entryType: "PAPER_ENTRY", market: "NASDAQ", symbol: "AAPL", currency: "USD", filledQuantity: 10, fillPrice: 100, updatedAt: "2026-08-01T00:00:00.000Z" },
    { revision: 2, status: "FILLED", side: "SELL", fullExit: false, market: "NASDAQ", symbol: "AAPL", currency: "USD", filledQuantity: 2, fillPrice: 120, preTradeAverageEntryPrice: 100, updatedAt: "2026-08-02T00:00:00.000Z" },
    { revision: 3, status: "FILLED", side: "SELL", fullExit: true, market: "NASDAQ", symbol: "AAPL", currency: "USD", filledQuantity: 8, fillPrice: 90, preTradeAverageEntryPrice: 100, updatedAt: "2026-08-03T00:00:00.000Z" },
    { revision: 4, status: "FILLED", side: "SELL", fullExit: true, market: "KRX", symbol: "005930", currency: "KRW", filledQuantity: 1, fillPrice: 80_000, updatedAt: "2026-08-04T00:00:00.000Z" },
  ], new Date("2026-08-10T00:00:00.000Z"));
  assert.equal(performance.all.count, 1);
  assert.equal(performance.all.losses, 1);
  assert.equal(performance.all.currencies.USD.profitLoss, -40);
  assert.equal(performance.all.currencies.USD.returnRate, -4);
  assert.equal(performance.month.count, 1);
  assert.equal(performance.excludedFullExits, 1);
  assert.equal(performance.completed[0].netProfitLoss, null);
  assert.deepEqual([2, 2.01, 2.5, 2.51, 3, 3.01, 3.5, 3.51, undefined].map(sigmaBand), ["≤2", "2~2.5", "2~2.5", "2.5~3", "2.5~3", "3~3.5", "3~3.5", ">3.5", "미확인"]);
  const cost = quantity => ({ fees: 1, taxes: 0, currency: "USD", filledQuantity: quantity, source: "broker-statement-test" });
  const strategyOrders = [
    { environment: "mock", side: "BUY", entryType: "PAPER_ENTRY", market: "NASDAQ", symbol: "TEST", status: "FILLED", filledQuantity: 10, fillPrice: 100, signalPrice: 99,
      timeframe: "4H", signalCode: "ENTRY_STANDARD", sizingContext: { sigmaZ: 2.5 }, policyVersion: "test-v1", executionCosts: cost(10), createdAt: "2026-09-01T00:00:00Z" },
    { environment: "mock", side: "SELL", market: "NASDAQ", symbol: "TEST", status: "CANCELLED", filledQuantity: 2, fillPrice: 120, signalPrice: 118, executionCosts: cost(2), createdAt: "2026-09-02T00:00:00Z" },
    { environment: "mock", side: "SELL", market: "NASDAQ", symbol: "TEST", status: "FILLED", filledQuantity: 8, fillPrice: 90, signalPrice: 95, executionCosts: cost(8), createdAt: "2026-09-03T00:00:00Z" },
  ].map((order, index) => ({ ...order, policyHash: "a".repeat(64),
    createdAt: `2026-09-0${index + 1}T14:00:01Z`, signalReceivedAt: `2026-09-0${index + 1}T14:00:00Z`,
    orderRequestedAt: `2026-09-0${index + 1}T14:00:01Z`, orderAcceptedAt: `2026-09-0${index + 1}T14:00:02Z`,
    lastFillAt: `2026-09-0${index + 1}T14:00:03Z` }));
  const comparisonBroker = { ...emptyBroker("KIWOOM", "키움"), tracker: { list: () => strategyOrders } };
  const comparison = strategyComparison(comparisonBroker, { blocked: { record: { payload: { timeframe: "D", sb_z_score: 3.6 }, outcome: { signal: { signalCode: "ENTRY_MOMENTUM" } } }, progress: { KIWOOM: { status: "BLOCKED", reason: "Sigma 과열" } } } });
  assert.equal(comparison.groups.length, 4);
  assert.equal(comparison.groups[0].label, "240");
  assert.equal(comparison.groups[0].profitLoss, -40);
  assert.equal(comparison.groups[0].netProfitLoss, -43);
  assert.equal(comparison.groups[0].signalPriceDifference, 46); // already in actual P/L, do not subtract again
  assert.equal(comparison.groups[0].realizedDrawdown, 40);
  assert.equal(comparison.blocked[0].count, 1);
  assert.equal(comparison.groups[0].count, 1); // blocked signals are never fictional trades
  const cohorts = ["a".repeat(64), "b".repeat(64)].flatMap(policyHash => strategyOrders.map(order => ({ ...order,
    symbol: policyHash, policyHash })));
  const cohortBroker = { ...comparisonBroker, tracker: { list: () => cohorts } };
  const cohortGroups = strategyComparison(cohortBroker).groups.filter(group => group.dimension === "timeframe");
  assert.equal(cohortGroups.length, 2, "same named policy but different settings must not merge");
  assert.deepEqual(cohortGroups.map(group => group.count), [1, 1]);
  assert.equal(cohortGroups[0].averageNetLoss, -43);
  assert.equal(cohortGroups[0].averageNetWin, null);
  const mixed = strategyOrders.map((order, index) => ({ ...order, policyHash: index ? "new" : "old" }));
  assert.equal(calculateTradingPerformance(mixed).all.count, 1);
  assert.equal(strategyComparison({ ...comparisonBroker, tracker: { list: () => mixed } }).operational.length, 1);
  strategyOrders[0].executionCosts.filledQuantity = 9; // stale cost evidence after another fill
  assert.equal(strategyComparison(comparisonBroker).groups[0].netProfitLoss, null);
  const comparisonCard = formatStrategyComparisonMessage([comparisonBroker, comparisonBroker]);
  assert(JSON.stringify(comparisonCard).length < 6000);
  assert.match(JSON.stringify(comparisonCard), /비용 미확인을 0원으로 보지 않음/);
  assert.match(comparisonCard.embeds[0].fields[1].value, /^4시간봉/);
  assert.match(comparisonCard.embeds[0].fields[2].value, /^정석 진입/);
  const incidentOrders = strategyOrders.map(order => ({ ...order, evaluationIssues: ["운영 장애 증빙 test-incident"] }));
  const incidentBroker = { ...comparisonBroker, tracker: { list: () => incidentOrders } };
  assert.equal(calculateTradingPerformance(incidentOrders).all.count, 1, "actual outcomes remain in total performance");
  assert.equal(calculateTradingPerformance(incidentOrders).all.currencies.USD.profitLoss, calculateTradingPerformance(strategyOrders).all.currencies.USD.profitLoss);
  const separated = strategyComparison(incidentBroker);
  assert.equal(separated.groups.length, 0, "operationally affected trades are not clean strategy evidence");
  assert.equal(separated.operational.length, 1);
  assert.deepEqual(separated.operational[0].evaluationIssues, ["운영 장애 증빙 test-incident"]);
  assert.match(JSON.stringify(formatStrategyComparisonMessage([incidentBroker])), /실제 손익·전체 승률에는 포함/);
  assert.match(comparisonCard.embeds[0].fields[1].value, /실현손익 낙폭 \$40/);
  assert.equal(comparison.evaluation.eligible_count, 1);
  assert.equal(comparison.evaluation.cohorts[0].win_rate, 0);
  assert.equal(comparison.evaluation.cohorts[0].net_profit_loss, -43);
  const beforeAudit = JSON.stringify(strategyOrders);
  const delayedOrders = strategyOrders.map((order, index) => index ? order : ({ ...order,
    signalReceivedAt: "2026-08-31T20:00:00Z", orderRequestedAt: "2026-09-01T13:30:00Z",
    orderAcceptedAt: "2026-09-01T13:30:01Z", lastFillAt: "2026-09-01T13:30:03Z" }));
  const delayed = calculateTradingPerformance(delayedOrders);
  assert.equal(delayed.all.currencies.USD.profitLoss, -40, "classification never adjusts actual P/L");
  assert.deepEqual(delayed.completed[0].evaluationCategories, ["MOCK_SESSION_LIMIT"]);
  assert.equal(delayed.evaluation.excluded_count, 1);
  assert.equal(delayed.evaluation.reason_counts.MOCK_SESSION_LIMIT, 1);
  assert.equal(delayed.completed[0].executions[0].signalToRequestMs, 17.5 * 3600_000);
  assert.equal(delayed.completed[0].executions[0].fillTimeSource, "LOCAL_OBSERVATION");
  const favorable = calculateTradingPerformance(delayedOrders.map(o => ({ ...o, fillPrice: o.side === "BUY" ? 80 : 120 })));
  assert.equal(favorable.all.wins, 1);
  assert.equal(favorable.evaluation.eligible_count, 0, "favorable delayed trades are excluded equally");
  const legacy = calculateTradingPerformance(strategyOrders.map(o => ({ ...o, policyHash: null, orderRequestedAt: null })));
  assert.equal(legacy.all.count, 1);
  assert.equal(legacy.evaluation.reason_counts.DATA_INSUFFICIENT, 1, "count trades, not partial fills");
  const noFillTime = evaluateExecution({ ...strategyOrders[0], lastFillAt: null, updatedAt: "2026-09-01T14:00:03Z" });
  assert(noFillTime.categories.includes("DATA_INSUFFICIENT"));
  assert.equal(noFillTime.timing.fillObservedAt, null, "updatedAt is not fill evidence");
  const fillWait = evaluateExecution({ ...strategyOrders[0], lastFillAt: "2026-09-01T15:00:00Z" });
  assert.deepEqual(fillWait.categories, ["EXECUTION_DELAY_UNATTRIBUTED"]);
  assert.equal(fillWait.timing.signalToRequestMs, 1000);
  assert(fillWait.timing.acceptanceToFillMs > 300000);
  const korea = evaluateExecution({ ...strategyOrders[0], market: "KRX", symbol: "005930" });
  assert(!korea.categories.includes("MOCK_SESSION_LIMIT"), "do not impose US sessions on domestic orders");
  const live = evaluateExecution({ ...delayedOrders[0], environment: "live" });
  assert(!live.categories.includes("MOCK_SESSION_LIMIT"));
  const incident = evaluateExecution(strategyOrders[0], { record: { receivedAt: strategyOrders[0].signalReceivedAt,
    payload: { ticker: "TEST", action: "BUY" } }, progressHistory: [
      { brokerId: "KIWOOM", updatedAt: Date.parse(strategyOrders[0].orderRequestedAt), reason: "계좌 조회 실패", status: "DEFER_REQUIRED" },
      { brokerId: "KIS", updatedAt: Date.parse(strategyOrders[0].orderRequestedAt), reason: "승인", status: "APPROVAL" },
    ] }, { id: "KIWOOM" });
  assert.deepEqual(incident.categories, ["SYSTEM_INCIDENT"]);
  assert.equal(JSON.stringify(strategyOrders), beforeAudit, "read-only audit never modifies order history");
  const evaluationSnapshot = tradingPerformanceSnapshot([{ ...comparisonBroker, tracker: { list: () => delayedOrders } }])[0];
  assert.equal(evaluationSnapshot.evaluation.total_count, evaluationSnapshot.all.count);
  assert.equal(evaluationSnapshot.evaluation.cohorts.length, 0);
  const snapshot = tradingPerformanceSnapshot([{ ...emptyBroker("KIWOOM", "키움"), tracker: { list: () => [
    { environment: "mock", revision: 1, status: "FILLED", side: "SELL", fullExit: true, market: "KRX", symbol: "005930", filledQuantity: 1, fillPrice: 80_000, preTradeAverageEntryPrice: 70_000, updatedAt: "2026-08-04T00:00:00.000Z" },
  ] } }], "2026-08-10T00:00:00.000Z");
  assert.equal(snapshot[0].broker, "KIWOOM");
  assert.equal(snapshot[0].account_type, "paper");
  assert.equal(snapshot[0].all.win_rate, 100);
  assert.equal(snapshot[0].realized.KRW.profit_loss, 10_000);
  const draw = tradingPerformanceSnapshot([{ ...emptyBroker("KIS", "한투"), tracker: { list: () => [
    { environment: "live", status: "FILLED", side: "SELL", fullExit: true, market: "NASDAQ", symbol: "AAPL", filledQuantity: 1, fillPrice: 100, preTradeAverageEntryPrice: 100 },
  ] } }], "2026-08-10T00:00:00.000Z")[0];
  assert.equal(draw.all.count, 1);
  assert.equal(draw.all.draws, 1);
  assert.equal(draw.all.win_rate, null);

  const mixedBroker = emptyBroker("KIWOOM", "키움");
  mixedBroker.tracker.list = () => [
    { environment: "live", status: "FILLED", side: "SELL", fullExit: true, market: "KRX", symbol: "005930", filledQuantity: 1, fillPrice: 80_000, preTradeAverageEntryPrice: 70_000 },
    { environment: "mock", status: "FILLED", side: "SELL", fullExit: true, market: "KRX", symbol: "000660", filledQuantity: 1, fillPrice: 200_000, preTradeAverageEntryPrice: 100_000 },
  ];
  await syncAccountPortfolio(channel, [mixedBroker], "2026-08-26T00:00:00.000Z");
  assert.match(performancePayload.embeds[0].description, /\+100,000원/);
  assert.doesNotMatch(performancePayload.embeds[0].description, /\+10,000원/);

  const kisHoldingBroker = emptyBroker("KIS", "한투");
  kisHoldingBroker.overseasClient.getUsBalances = async () => [{ holdings: [{
    code: "SE", name: "Sea Limited", koreanName: "씨", englishName: "Sea Limited", exchange: "ND",
    quantity: 63, currentPrice: 120, evaluationAmount: 800,
  }] }];
  let cashQuery;
  kisHoldingBroker.overseasClient.getUsCash = async (query) => { cashQuery = query; return { usd: 9200 }; };
  await syncAccountPortfolio(channel, [kisHoldingBroker], "2026-08-26T00:00:00.000Z");
  assert.deepEqual(cashQuery, { exchange: "ND", symbol: "SE", price: 120 });
  assert.match(editedPayload.embeds[0].description, /63주 · 평단 확인 불가 · 평가 \$800 · 8\.0%/);

  const failedKiwoom = emptyBroker("KIWOOM", "키움");
  failedKiwoom.domesticClient.getDomesticBalance = async () => { throw new Error("Token invalid"); };
  const partial = await syncAccountPortfolio(channel, [failedKiwoom, emptyBroker("KIS", "한투")], "2026-08-26T00:00:00.000Z");
  assert.deepEqual([...partial.succeededBrokerIds], ["KIS"]);
  assert.equal(partial.failures[0].label, "키움");
  assert.match(editedPayload.embeds[0].footer.text, /조회 실패: 키움/);
  console.log("account portfolio test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
