"use strict";

const { KisClient } = require("../src/brokers/kis-client");

function account(value) {
  const match = String(value || "").match(/^(\d{8})(?:-(\d{2}))?$/);
  if (!match) throw new Error("KIS_ACCOUNT_NO는 12345678-01 형식이어야 합니다.");
  return { accountNo: match[1], productCode: match[2] || process.env.KIS_ACCOUNT_PRODUCT_CODE || "01" };
}

(async () => {
  const environment = process.env.KIS_ENV || "mock";
  const environmentLabel = environment === "live" ? "실계좌" : "모의계좌";
  const client = new KisClient({
    appKey: process.env.KOREA_INVESTMENT_APP_KEY,
    appSecret: process.env.KOREA_INVESTMENT_APP_SECRET,
    ...account(process.env.KIS_ACCOUNT_NO),
    environment,
  });
  const domestic = await client.getDomesticBalance();
  const overseas = await client.getUsBalances();
  const us = [...new Map(overseas.flatMap((item) => item.holdings).map((item) => [item.code, item])).values()];
  console.log(`한투 ${environmentLabel} 인증/조회 정상 · 국내 ${domestic.holdings.length}종목 · 미국 ${us.length}종목 · 주문 전송 없음`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
