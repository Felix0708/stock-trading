"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadOrCreateWebhookToken } = require("./webhook-server");

async function main() {
  const specification = fs.readFileSync(path.join(__dirname, "docs", "tradingview-webhook-v6.2.md"), "utf8");
  const firstJson = specification.match(/```json\s*([\s\S]*?)```/);
  const payload = {
    ...JSON.parse(firstJson[1]),
    name: "자동매매 종단간 테스트 (Apple)",
    desc: "계좌 실행기까지 도달하지만 주문은 만들지 않는 연동 테스트",
    paper_order_test: true,
  };
  const token = loadOrCreateWebhookToken(path.join(__dirname, ".webhook-token"));
  const host = process.env.WEBHOOK_HOST || "127.0.0.1";
  const port = Number(process.env.WEBHOOK_PORT || 8787);
  const origin = process.env.WEBHOOK_ORIGIN || `http://${host}:${port}`;
  const response = await fetch(`${origin}/webhook/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`테스트 웹훅 실패: HTTP ${response.status}`);
  console.log(`주문 없는 종단간 테스트 완료: HTTP ${response.status}, request_id=${result.request_id}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
