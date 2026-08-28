"use strict";

const { KiwoomClient } = require("./kiwoom-client");

async function main() {
  const environment = process.env.KIWOOM_ENV || "mock";
  const environmentLabel = environment === "live" ? "실계좌" : "모의투자";
  const domestic = new KiwoomClient({
    appKey: process.env.KIWOOM_DOMESTIC_APP_KEY,
    secretKey: process.env.KIWOOM_DOMESTIC_SECRET_KEY,
    environment,
    timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5000),
  });
  const overseas = new KiwoomClient({
    appKey: process.env.KIWOOM_OVERSEAS_APP_KEY,
    secretKey: process.env.KIWOOM_OVERSEAS_SECRET_KEY,
    environment,
    timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5000),
  });
  await domestic.getAccessToken();
  const accountNumber = await domestic.getDomesticAccountNumber();
  const balance = await domestic.getDomesticBalance();
  console.log(`국내 ${environmentLabel} 인증 성공 (24시간 토큰 캐시 재사용)`);
  console.log(`${environmentLabel} 조회 성공 (${accountNumber.length}자리, 번호 비공개)`);
  console.log(`추정예탁자산: ${balance.estimatedAssets.toLocaleString("ko-KR")}원`);
  console.log(`보유종목: ${balance.holdings.length}개`);

  await overseas.getAccessToken();
  const usBalance = await overseas.getUsBalance();
  const usCash = await overseas.getUsCash();
  console.log(`해외 ${environmentLabel} 인증 성공 (24시간 토큰 캐시 재사용)`);
  console.log(`USD 예수금: $${usCash.usd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  console.log(`미국주식 보유종목: ${usBalance.holdings.length}개`);
  console.log("주문 요청은 전송하지 않았습니다.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
