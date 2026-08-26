"use strict";

const { enrichInstrumentNames, formatMyPortfolioMessage } = require("./investor-portfolio");

async function brokerPortfolio(broker) {
  const domesticClient = broker.domesticClient || broker;
  const overseasClient = broker.overseasClient || broker;
  const [domestic, usBalances, usCash] = await Promise.all([
    domesticClient.getDomesticBalance(),
    overseasClient.getUsBalances ? overseasClient.getUsBalances() : overseasClient.getUsBalance().then((balance) => [balance]),
    broker.id === "KIWOOM" && overseasClient.getUsCash ? overseasClient.getUsCash() : { usd: 0 },
  ]);
  const usHoldings = [...new Map(usBalances.flatMap((balance) => balance.holdings).map((holding) => [holding.code, holding])).values()];
  const [domesticHoldings, overseasHoldings] = await Promise.all([
    enrichInstrumentNames(domestic.holdings.map((holding) => ({ ...holding, exchange: "KRX", ticker: holding.code }))),
    enrichInstrumentNames(usHoldings.map((holding) => ({ ...holding, exchange: holding.exchange || "NASDAQ", ticker: holding.code }))),
  ]);
  return {
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
  const accounts = await Promise.all(brokers.map(brokerPortfolio));
  const payload = formatMyPortfolioMessage({ accounts, updatedAt });
  const recent = await channel.messages.fetch({ limit: 100 });
  const existing = [...recent.values()].find((message) => message.embeds?.some((embed) => embed.title === "나의 포트폴리오"));
  return existing ? existing.edit(payload) : channel.send(payload);
}

module.exports = { brokerPortfolio, syncAccountPortfolio };
