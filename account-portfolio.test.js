"use strict";

const assert = require("node:assert/strict");
const { syncAccountPortfolio } = require("./account-portfolio");

const emptyBroker = (id, label) => ({
  id, label, environment: id === "KIS" ? "live" : "mock",
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
  const channel = {
    messages: { fetch: async () => new Map([["portfolio-1", oldMessage]]) },
    send: async () => { throw new Error("기존 포트폴리오 카드를 새 메시지로 만들면 안 됩니다."); },
  };
  const result = await syncAccountPortfolio(channel, [emptyBroker("KIWOOM", "키움"), emptyBroker("KIS", "한투")], "2026-08-26T00:00:00.000Z");
  assert.equal(result.id, "portfolio-1");
  assert.match(editedPayload.embeds[0].description, /키움 모의계좌/);
  assert.match(editedPayload.embeds[0].description, /한투 실계좌/);
  console.log("account portfolio test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
