"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OrderTracker } = require("../src/trading/order-tracker");
const {
  domesticSession, isDomesticBuySession, isDomesticOrderSession,
  isUsBuySession, isUsMarketClosedError, isUsOrderSession, isUsRegularSession,
  shouldDeferEntry, shouldDeferOrder, shouldDeferUsEntry, shouldDelayEntry, shouldDelayOrder, shouldDelayUsEntry, usSession,
  partialExitQuantity, partialExitRatio, partialExitStage,
  previewTradableQuantity,
  refreshPaperOrder, submitPaperOrder, trackPaperOrder, submitPaperTestOrder, trackPaperTestOrder,
} = require("../src/trading/paper-order-executor");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paper-order-test-"));
const tracker = new OrderTracker(path.join(directory, "orders.json"));
const domesticOrders = [];
const options = {
  enabled: true,
  symbol: "005930",
  lockFile: path.join(directory, "lock.json"),
  tracker,
  client: {
    placeDomesticMarketOrder: async (request) => {
      domesticOrders.push(request);
      return { status: "ACCEPTED", orderNo: "00024", side: request.side, symbol: request.symbol, orderQuantity: request.quantity };
    },
    getDomesticOrderExecutions: async () => [{
      status: "FILLED", orderNo: "00024", side: "BUY", symbol: "005930",
      orderQuantity: 1, filledQuantity: 1, remainingQuantity: 0, fillPrice: 100,
    }],
  },
};
const record = {
  requestId: "request-1",
  payload: { paper_order_test: true, ticker: "005930", exchange: "KRX", action: "BUY" },
  risk: { verdict: "PAPER_ENTRY" },
};

(async () => {
  assert.equal(isUsMarketClosedError(new Error("키움 모의투자 요청 실패: [20000](RC4058:모의투자 장종료)")), true);
  assert.equal(isUsMarketClosedError(new Error("한투 모의 API 실패 [VTTT1002U]: 모의투자 장종료 입니다.")), true);
  assert.equal(isUsMarketClosedError(new Error("키움 모의투자 요청 실패: 주문가능금액 부족")), false);
  assert.equal(isUsRegularSession(new Date("2026-08-24T13:31:00.000Z")), true);
  assert.equal(isUsRegularSession(new Date("2026-08-22T13:31:00.000Z")), false);
  assert.equal(isUsRegularSession(new Date("2026-08-24T20:00:00.000Z")), false);
  assert.equal(usSession(new Date("2026-08-24T12:00:00.000Z")), "PRE");
  assert.equal(usSession(new Date("2026-08-24T20:00:00.000Z")), "AFTER");
  assert.equal(usSession(new Date("2026-08-25T00:00:00.000Z")), "CLOSED");
  assert.equal(isUsOrderSession(new Date("2026-08-24T12:00:00.000Z")), true);
  assert.equal(isUsOrderSession(new Date("2026-08-24T20:00:00.000Z")), true);
  assert.equal(isUsBuySession(new Date("2026-08-24T12:00:00.000Z")), false);
  assert.equal(isUsBuySession(new Date("2026-08-24T20:00:00.000Z")), true);
  assert.equal(domesticSession(new Date("2026-08-23T23:35:00.000Z")), "PRE");
  assert.equal(domesticSession(new Date("2026-08-24T00:00:00.000Z")), "REGULAR");
  assert.equal(domesticSession(new Date("2026-08-24T06:45:00.000Z")), "AFTER_CLOSE");
  assert.equal(domesticSession(new Date("2026-08-24T07:30:00.000Z")), "AFTER_SINGLE");
  assert.equal(isDomesticOrderSession(new Date("2026-08-23T23:35:00.000Z")), true);
  assert.equal(isDomesticBuySession(new Date("2026-08-23T23:35:00.000Z")), false);
  assert.equal(shouldDelayUsEntry({ payload: { exchange: "NASDAQ", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" } }, new Date("2026-08-24T12:00:00.000Z")), true);
  assert.equal(shouldDelayUsEntry({ payload: { exchange: "NASDAQ", action: "BUY", paper_order_test: true }, risk: { verdict: "PAPER_ENTRY" } }, new Date("2026-08-24T12:00:00.000Z")), false);
  assert.equal(shouldDelayUsEntry({ payload: { exchange: "NASDAQ", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" } }, new Date("2026-08-24T20:00:00.000Z")), false);
  assert.equal(shouldDelayEntry({ payload: { exchange: "KRX", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" } }, new Date("2026-08-23T23:35:00.000Z")), true);
  assert.equal(shouldDelayEntry(record, new Date("2026-08-23T23:35:00.000Z")), false);
  assert.equal(shouldDelayEntry({ payload: { exchange: "KRX", action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, new Date("2026-08-23T23:35:00.000Z")), false);
  assert.equal(shouldDelayOrder({ payload: { exchange: "KRX", action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, new Date("2026-08-24T12:00:00.000Z")), true);
  assert.equal(shouldDelayOrder({ payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, new Date("2026-08-25T00:00:00.000Z")), true);
  assert.equal(shouldDelayOrder({ payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" } }, new Date("2026-08-24T12:00:00.000Z")), false);
  assert.equal(shouldDeferUsEntry({
    payload: { exchange: "NASDAQ", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" },
  }, new Error("[20000](RC4058:모의투자 장종료)")), true);
  assert.equal(shouldDeferUsEntry({
    payload: { exchange: "NYSE", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" },
  }, new Error("한투 모의 API 실패 [VTTT1002U]: 모의투자 장종료 입니다.")), true);
  assert.equal(shouldDeferUsEntry({
    payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" },
  }, new Error("[20000](RC4058:모의투자 장종료)")), false);
  assert.equal(shouldDeferEntry({
    payload: { exchange: "KRX", action: "BUY" }, risk: { verdict: "PAPER_ENTRY" },
  }, new Error("장종료")), true);
  assert.equal(shouldDeferOrder({
    payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" },
  }, new Error("[2000](RC4058:모의투자 장종료)")), true);
  assert.equal(shouldDeferOrder({
    payload: { exchange: "NYSE", action: "SELL" }, risk: { verdict: "PAPER_PARTIAL_EXIT" },
  }, new Error("한투 모의 API 실패 [VTTT1001U]: 모의투자 장종료 입니다.")), true);
  assert.equal(shouldDeferOrder({
    payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_PARTIAL_EXIT" },
  }, new Error("한투 모의 API 실패 [VTTS3012R]: Gateway 라우팅 오류가 발생했습니다.")), true);
  assert.equal(shouldDeferOrder({
    payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" },
  }, new Error("한투 실계좌 API 실패 [TTTS3012R]: Gateway 라우팅 오류가 발생했습니다.")), true);
  assert.equal(shouldDeferOrder({
    payload: { exchange: "NASDAQ", action: "SELL" }, risk: { verdict: "PAPER_EXIT" },
  }, new Error("주문가능수량 부족")), false);
  assert.equal(partialExitQuantity(8, 0.25), 2);
  assert.equal(partialExitQuantity(1, 0.25), 0);
  assert.equal(partialExitRatio({ outcome: { signal: { signalCode: "TAKE_PROFIT", tpLevel: 2 } } }, {}), 0.5);
  assert.equal(partialExitStage({ outcome: { signal: { signalCode: "EXIT_PARTIAL_1" } } }), "TP1");
  assert.equal(partialExitStage({ outcome: { signal: { signalCode: "TAKE_PROFIT", tpLevel: 2 } } }), "TP2");
  assert.equal(previewTradableQuantity({ currentHoldings: [{ code: "SE", tradableQuantity: 63 }] }, "SE"), 63);
  assert.equal(previewTradableQuantity({ currentHoldings: [{ code: "A005930", tradableQuantity: 8 }] }, "005930"), 8);
  assert.equal(previewTradableQuantity(null, "SE"), null);
  assert.equal((await submitPaperTestOrder({ ...record, payload: { ...record.payload, ticker: "000001" } }, options)).status, "BLOCKED");
  const accepted = await submitPaperTestOrder(record, options);
  assert.equal(accepted.orderQuantity, 1);
  assert.equal((await submitPaperTestOrder(record, options)).status, "BLOCKED");
  assert.equal((await trackPaperTestOrder(accepted, { ...options, attempts: 1, delayMs: 0 })).status, "FILLED");

  const autoTracker = new OrderTracker(path.join(directory, "auto-orders.json"));
  const autoRecord = {
    payload: { ticker: "AAPL", exchange: "NASDAQ", action: "BUY", price: 250 },
    risk: { verdict: "PAPER_ADD" },
    positionPreview: {
      quantity: 4, positionValue: 1000, projectedPositionRatio: 12.5,
      positionLimitRatio: 0.2, equity: 8000, totalAccountEquity: 80_000, autoCapital: 8_000, autoCapitalRatio: 0.1,
      currentPositionValue: 0, currency: "USD", stopPrice: 230, stopLossAmount: 80,
      pyramidStage: 1, pyramidRatio: 0.5, initialEntryQuantity: 8,
    },
  };
  const overseasClient = {
    getUsQuote: async () => ({ currentPrice: 240 }),
    placeUsLimitOrder: async ({ side, exchange, symbol, quantity, price }) => ({
      status: "ACCEPTED", orderNo: "000000282", side, exchange, symbol, orderQuantity: quantity, price,
    }),
    getUsOrderExecutions: async () => [{
      status: "FILLED", orderNo: "282", side: "BUY", symbol: "AAPL",
      orderQuantity: 4, filledQuantity: 4, remainingQuantity: 0, fillPrice: 250,
    }],
  };
  assert.deepEqual(await submitPaperOrder({
    payload: { ticker: "META", exchange: "NASDAQ", action: "BUY", price: 613.01 },
    risk: { verdict: "PAPER_ENTRY" },
    positionPreview: { blocked: true, quantity: 0, reason: "Sigma 과열" },
  }, {
    enabled: true, environment: "mock", domesticClient: options.client, overseasClient, tracker: autoTracker,
  }), { status: "BLOCKED", reason: "Sigma 과열" });
  const auto = await submitPaperOrder(autoRecord, {
    enabled: true, environment: "mock", domesticClient: options.client, overseasClient, tracker: autoTracker,
  });
  assert.equal(auto.orderQuantity, 4);
  assert.equal(auto.exchange, "ND");
  assert.equal(auto.plannedInvestment, 1000);
  assert.equal(auto.projectedPositionRatio, 12.5);
  assert.equal(auto.accountEquity, 80000);
  assert.equal(auto.autoCapital, 8000);
  assert.equal(auto.autoCapitalRatio, 0.1);
  assert.equal(auto.stopPrice, 230);
  assert.equal(auto.plannedRisk, 80);
  assert.equal(auto.pyramidStage, 1);
  assert.equal(auto.pyramidRatio, 0.5);
  assert.equal(auto.initialEntryQuantity, 8);
  assert.equal(auto.limitPrice, 241.2);
  assert.equal(auto.referencePrice, 240);
  const usExit = await submitPaperOrder({
    requestId: "sell-se",
    payload: { ticker: "SE", exchange: "NYSE", action: "SELL", price: 113.41 },
    risk: { verdict: "PAPER_EXIT" },
    positionPreview: { currentHoldings: [{ code: "SE", quantity: 63, tradableQuantity: 63 }], hasExistingPosition: true },
  }, {
    enabled: true,
    environment: "mock",
    domesticClient: options.client,
    overseasClient: {
      getUsBalance: async () => { throw new Error("보유 확인 뒤 잔고를 중복 조회하면 안 됨"); },
      placeUsLimitOrder: async ({ side, exchange, symbol, quantity, price }) => ({
        status: "ACCEPTED", orderNo: "000000917", side, exchange, symbol, orderQuantity: quantity, price,
      }),
    },
    tracker: autoTracker,
  });
  assert.equal(usExit.side, "SELL");
  assert.equal(usExit.orderQuantity, 63);
  assert.equal(usExit.fullExit, true);
  assert.equal((await refreshPaperOrder(auto, {
    domesticClient: options.client, overseasClient, tracker: autoTracker,
  })).status, "FILLED");
  assert.equal((await trackPaperOrder(auto, {
    domesticClient: options.client, overseasClient, tracker: autoTracker, attempts: 1, delayMs: 0,
  })).status, "FILLED");
  const regularSession = new Date("2026-08-24T00:00:00.000Z");
  const domesticAuto = await submitPaperOrder({
    payload: { ticker: "005930", exchange: "KRX", action: "BUY", price: 100000 },
    risk: { verdict: "PAPER_ENTRY" },
    positionPreview: { quantity: 2 },
  }, {
    enabled: true, environment: "mock", domesticClient: options.client, overseasClient, tracker: autoTracker, now: regularSession,
  });
  assert.equal(domesticAuto.orderQuantity, 2);
  assert.equal(domesticAuto.market, "KRX");
  assert.equal(domesticAuto.orderStyle, "PROTECTED");
  assert.equal(domesticOrders.at(-1).orderStyle, "PROTECTED");
  const domesticPartial = await submitPaperOrder({
    payload: { ticker: "005930", exchange: "KRX", action: "SELL", type: "🔪 1차 분할청산", price: 100000, koreanName: "삼성전자", englishName: "Samsung Electronics" },
    outcome: { signal: { signalCode: "EXIT_PARTIAL_1" } },
    risk: { verdict: "PAPER_PARTIAL_EXIT" },
  }, {
    enabled: true,
    environment: "mock",
    domesticClient: {
      ...options.client,
      getDomesticBalance: async () => ({ holdings: [{ code: "A005930", tradableQuantity: 8 }] }),
    },
    tracker: autoTracker,
    partialExit1Ratio: 0.25,
    now: regularSession,
  });
  assert.equal(domesticPartial.orderQuantity, 2);
  assert.equal(domesticPartial.partialExitRatio, 0.25);
  assert.equal(domesticPartial.partialExitStage, "TP1");
  assert.equal(domesticPartial.orderStyle, "PROTECTED");
  assert.equal(domesticPartial.marketFallbackAllowed, false);
  assert.equal(domesticPartial.koreanName, "삼성전자");
  assert.equal(domesticPartial.englishName, "Samsung Electronics");
  const domesticCrash = await submitPaperOrder({
    payload: { ticker: "005930", exchange: "KRX", action: "SELL", type: "급락 손절", price: 100000 },
    outcome: { signal: { signalCode: "EXIT_CRASH" } },
    risk: { verdict: "PAPER_EXIT" },
  }, {
    enabled: true,
    environment: "mock",
    domesticClient: {
      ...options.client,
      getDomesticBalance: async () => ({ holdings: [{ code: "A005930", tradableQuantity: 8 }] }),
    },
    tracker: autoTracker,
    now: regularSession,
  });
  assert.equal(domesticCrash.marketFallbackAllowed, true);
  assert.equal((await submitPaperOrder(autoRecord, {
    enabled: true, environment: "live", domesticClient: options.client, overseasClient, tracker: autoTracker,
  })).status, "ACCEPTED");
  console.log("paper-order-executor test OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
