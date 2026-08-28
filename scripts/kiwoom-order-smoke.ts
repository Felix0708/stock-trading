"use strict";

const { KiwoomClient, kiwoomCredentials } = require("../src/brokers/kiwoom-client");
const path = require("node:path");
const { OrderTracker } = require("../src/trading/order-tracker");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertMockSmokeOrder(env = process.env) {
  if ((env.KIWOOM_ENV || "mock") !== "mock") throw new Error("이 스모크 시험은 키움 모의계좌에서만 실행할 수 있습니다.");
  if (env.CONFIRM_MOCK_ORDER !== "AAPL-1-USD") throw new Error("모의주문 확인값이 없습니다.");
}

async function main() {
  assertMockSmokeOrder();
  const client = new KiwoomClient({
    ...kiwoomCredentials("mock", "overseas"),
    environment: process.env.KIWOOM_ENV || "mock",
    timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5000),
  });
  const tracker = new OrderTracker(path.resolve(__dirname, "..", "kiwoom-orders.json"));
  const order = await client.placeUsLimitOrder({ side: "BUY", exchange: "ND", symbol: "AAPL", quantity: 1, price: 1 });
  tracker.record({ ...order, orderQuantity: 1, filledQuantity: 0, remainingQuantity: 1, price: 1 });
  console.log(`AAPL 1주 $1 지정가 주문 ${order.status} (주문번호 끝 4자리: ${order.orderNo.slice(-4)})`);

  const before = await client.getUsOrderExecutions({ side: "BUY", exchange: "ND", symbol: "AAPL" });
  const placed = before.find((item) => item.orderNo === order.orderNo);
  if (placed) tracker.record(placed);
  if (placed?.status === "FILLED") throw new Error("예상과 달리 주문이 체결되어 자동 취소를 중단했습니다.");

  const cancellation = await client.cancelUsOrder({ orderNo: order.orderNo, exchange: "ND", symbol: "AAPL" });
  tracker.record(cancellation);
  console.log(`취소 요청 ${cancellation.status} (취소번호 끝 4자리: ${cancellation.cancellationOrderNo.slice(-4)})`);
  await delay(1200);
  const after = await client.getUsOrderExecutions({ side: "BUY", exchange: "ND", symbol: "AAPL" });
  const final = after.find((item) => item.orderNo === order.orderNo || item.originalOrderNo === order.orderNo);
  if (final) tracker.record({ ...final, orderNo: order.orderNo });
  console.log(`최종 조회 상태: ${final?.status || "조회 결과 없음"}`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { assertMockSmokeOrder };
