"use strict";

const assert = require("node:assert/strict");
const { calculateTradingPerformance, syncAccountPortfolio } = require("../src/executor/account-portfolio");

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
