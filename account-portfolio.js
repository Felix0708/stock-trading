"use strict";

const { enrichInstrumentNames } = require("./instrument-names");
const { formatMyPortfolioMessage } = require("./investor-portfolio");

async function brokerPortfolio(broker) {
  const domesticClient = broker.domesticClient || broker;
  const overseasClient = broker.overseasClient || broker;
  const [domestic, usBalances] = await Promise.all([
    domesticClient.getDomesticBalance(),
    overseasClient.getUsBalances ? overseasClient.getUsBalances() : overseasClient.getUsBalance().then((balance) => [balance]),
  ]);
  const usHoldings = [...new Map(usBalances.flatMap((balance) => balance.holdings).map((holding) => [holding.code, holding])).values()];
  const firstUsHolding = usHoldings[0];
  const usCash = firstUsHolding && overseasClient.getUsCash
    ? await overseasClient.getUsCash({
      exchange: firstUsHolding.exchange,
      symbol: firstUsHolding.code,
      price: firstUsHolding.currentPrice || firstUsHolding.price,
    })
    : { usd: 0 };
  const [domesticHoldings, overseasHoldings] = await Promise.all([
    enrichInstrumentNames(domestic.holdings.map((holding) => ({ ...holding, exchange: "KRX", ticker: holding.code }))),
    enrichInstrumentNames(usHoldings.map((holding) => ({ ...holding, exchange: holding.exchange || "NASDAQ", ticker: holding.code }))),
  ]);
  return {
    id: broker.id,
    label: broker.label,
    environment: broker.environment || "mock",
    domestic: {
      equity: domestic.estimatedAssets || domestic.totalEvaluation || domesticHoldings.reduce((sum, holding) => sum + holding.evaluationAmount, 0),
      holdingPositions: domesticHoldings,
    },
    overseas: {
      equity: Number(usCash.usd || 0) + overseasHoldings.reduce((sum, holding) => sum + holding.evaluationAmount, 0),
      holdingPositions: overseasHoldings,
    },
  };
}

async function syncAccountPortfolio(channel, brokers, updatedAt = new Date().toISOString()) {
  const settled = await Promise.allSettled(brokers.map(brokerPortfolio));
  const accounts = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const failures = settled.flatMap((result, index) => result.status === "rejected"
    ? [{ id: brokers[index].id, label: brokers[index].label, reason: result.reason }]
    : []);
  if (!accounts.length) throw failures[0].reason;
  const payload = formatMyPortfolioMessage({ accounts, updatedAt });
  if (failures.length) {
    payload.embeds[0].color = 0xf59f00;
    payload.embeds[0].footer.text += ` · 조회 실패: ${failures.map((failure) => failure.label).join("·")}`;
  }
  const recent = await channel.messages.fetch({ limit: 100 });
  const existing = [...recent.values()].find((message) => message.embeds?.some((embed) => embed.title === "나의 포트폴리오"));
  const message = existing ? await existing.edit(payload) : await channel.send(payload);
  return { message, succeededBrokerIds: new Set(accounts.map((account) => account.id)), failures };
}

module.exports = { brokerPortfolio, syncAccountPortfolio };
