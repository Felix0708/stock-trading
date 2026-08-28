"use strict";

const assert = require("node:assert/strict");
const { KiwoomClient } = require("./kiwoom-client");
const { domesticSession } = require("./paper-order-executor");

const dueAt = new Date(process.env.LIQUIDATE_AT || "");
const expiresAt = new Date(process.env.LIQUIDATE_EXPIRES_AT || "");

function phase(now, due, expires) {
  if (Number.isNaN(due.getTime()) || Number.isNaN(expires.getTime()) || due >= expires) return "INVALID";
  if (now < due) return "WAIT";
  if (now > expires) return "EXPIRED";
  return "EXECUTE";
}

async function liquidate() {
  if (process.env.KIWOOM_ENV !== "mock") throw new Error("안전 차단: 키움 모의환경만 전량청산할 수 있습니다.");
  const symbol = String(process.env.LIQUIDATE_SYMBOL || "");
  if (!/^\d{6}$/.test(symbol)) throw new Error("LIQUIDATE_SYMBOL에 매도할 국내 종목코드 6자리가 필요합니다.");

  const client = new KiwoomClient({
    appKey: process.env.KIWOOM_DOMESTIC_APP_KEY,
    secretKey: process.env.KIWOOM_DOMESTIC_SECRET_KEY,
    environment: process.env.KIWOOM_ENV,
  });
  const balance = await client.getDomesticBalance();
  const holding = balance.holdings.find((item) => item.code.replace(/^A/, "") === symbol && item.tradableQuantity > 0);
  if (!holding) throw new Error(`${symbol} 매도 가능 보유수량이 없습니다.`);
  const orders = await client.getDomesticOrderExecutions({ side: "SELL", symbol });
  const pending = orders.find((order) => ["ACCEPTED", "PARTIALLY_FILLED"].includes(order.status) && order.remainingQuantity > 0);
  if (pending) {
    console.log(`${holding.name}(${symbol}) 기존 매도 미체결 ${pending.remainingQuantity}주 — 중복 주문 생략 · 주문번호 ${pending.orderNo}`);
    return;
  }
  const session = domesticSession();
  if (session === "CLOSED") throw new Error("현재 국내주식 주문 가능 시간이 아닙니다.");
  const quote = await client.getDomesticQuote({ symbol });
  const order = await client.placeDomesticMarketOrder({
    side: "SELL", symbol, quantity: holding.tradableQuantity, price: quote.currentPrice, session,
  });
  console.log(`${holding.name}(${symbol}) ${holding.tradableQuantity}주 전량 매도 접수 · ${session} · 주문번호 ${order.orderNo}`);
}

async function main() {
  const currentPhase = phase(new Date(), dueAt, expiresAt);
  if (currentPhase === "INVALID") throw new Error("LIQUIDATE_AT/LIQUIDATE_EXPIRES_AT 시간이 올바르지 않습니다.");
  if (currentPhase === "EXPIRED") throw new Error("전량청산 실행 가능 시간이 지났습니다.");
  if (currentPhase === "WAIT") {
    console.log(`키움 국내 모의계좌 전량청산 대기 · 실행 ${dueAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} KST`);
    setTimeout(main, Math.min(dueAt.getTime() - Date.now(), 60_000));
    return;
  }
  await liquidate();
}

if (process.argv.includes("--self-check")) {
  const due = new Date("2026-08-26T00:00:00Z");
  const expires = new Date("2026-08-26T06:30:00Z");
  assert.equal(phase(new Date("2026-08-25T23:59:59Z"), due, expires), "WAIT");
  assert.equal(phase(due, due, expires), "EXECUTE");
  assert.equal(phase(new Date("2026-08-26T06:30:01Z"), due, expires), "EXPIRED");
  console.log("전량청산 시간·안전 경계 확인 완료");
} else {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
