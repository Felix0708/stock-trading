"use strict";

const { enrichInstrumentNames } = require("../research/instrument-names");
const { formatMyPortfolioMessage } = require("../research/investor-portfolio");

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function orderTime(order) {
  const time = Date.parse(order.resultAt || order.updatedAt || "");
  return Number.isFinite(time) ? time : Number(order.revision || 0);
}

function marketCurrency(order) {
  return order.currency === "KRW" || String(order.market || "").toUpperCase() === "KRX" ? "KRW" : "USD";
}

function positionKey(order) {
  return `${marketCurrency(order)}:${String(order.symbol || "").replace(/^A/, "").toUpperCase()}`;
}

function monthKey(value, timeZone = "Asia/Tokyo") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}`;
}

function summarizeCompletedTrades(trades) {
  const wins = trades.filter((trade) => trade.profitLoss > 0).length;
  const losses = trades.filter((trade) => trade.profitLoss < 0).length;
  const draws = trades.length - wins - losses;
  const decided = wins + losses;
  const currencies = {};
  for (const currency of ["KRW", "USD"]) {
    const selected = trades.filter((trade) => trade.currency === currency);
    const basis = selected.reduce((sum, trade) => sum + trade.costBasis, 0);
    const profitLoss = selected.reduce((sum, trade) => sum + trade.profitLoss, 0);
    currencies[currency] = { count: selected.length, profitLoss, returnRate: basis > 0 ? profitLoss / basis * 100 : null };
  }
  return { count: trades.length, wins, losses, draws, winRate: decided ? wins / decided * 100 : null, currencies };
}

function calculateTradingPerformance(orders, now = new Date()) {
  const positions = new Map();
  const completed = [];
  let excludedFullExits = 0;
  const filled = orders
    .filter((order) => order.status === "FILLED" && positiveNumber(order.filledQuantity) && positiveNumber(order.fillPrice))
    .sort((a, b) => orderTime(a) - orderTime(b));

  for (const order of filled) {
    const key = positionKey(order);
    const quantity = positiveNumber(order.filledQuantity);
    const price = positiveNumber(order.fillPrice);
    if (!quantity || !price) continue;
    if (order.side === "BUY") {
      if (order.entryType === "PAPER_ENTRY") positions.set(key, { quantity: 0, cost: 0, realizedBasis: 0, profitLoss: 0, reliable: true });
      const position = positions.get(key);
      if (position && ["PAPER_ENTRY", "PAPER_ADD"].includes(order.entryType)) {
        position.quantity += quantity;
        position.cost += quantity * price;
      }
      continue;
    }
    if (order.side !== "SELL") continue;

    let position = positions.get(key);
    const brokerAverage = positiveNumber(order.preTradeAverageEntryPrice);
    if (!position && brokerAverage) {
      position = { quantity: positiveNumber(order.preTradePositionQuantity) || quantity, cost: 0, realizedBasis: 0, profitLoss: 0, reliable: true };
      positions.set(key, position);
    }
    if (!position) {
      if (order.fullExit) excludedFullExits += 1;
      continue;
    }

    let average = brokerAverage;
    if (!average && position.quantity >= quantity && position.cost > 0) average = position.cost / position.quantity;
    if (!average) position.reliable = false;
    else {
      const basis = average * quantity;
      position.realizedBasis += basis;
      position.profitLoss += price * quantity - basis;
    }
    if (position.quantity > 0 && position.cost > 0) {
      const trackedAverage = position.cost / position.quantity;
      const removed = Math.min(position.quantity, quantity);
      position.quantity -= removed;
      position.cost = Math.max(0, position.cost - trackedAverage * removed);
    }

    if (order.fullExit) {
      if (position.reliable && position.realizedBasis > 0) completed.push({
        completedAt: order.resultAt || order.updatedAt,
        currency: marketCurrency(order),
        costBasis: position.realizedBasis,
        profitLoss: position.profitLoss,
      });
      else excludedFullExits += 1;
      positions.delete(key);
    }
  }

  const currentMonth = monthKey(now);
  return {
    all: summarizeCompletedTrades(completed),
    month: summarizeCompletedTrades(completed.filter((trade) => monthKey(trade.completedAt) === currentMonth)),
    excludedFullExits,
  };
}

function brokerOrders(broker) {
  const accountKind = broker.environment === "live" ? "실계좌" : "모의계좌";
  return (broker.tracker?.list?.() || []).filter((order) => order.environment
    ? order.environment === broker.environment
    : String(order.brokerLabel || "").includes(accountKind));
}

function tradingPerformanceSnapshot(brokers, updatedAt = new Date().toISOString()) {
  return brokers.map((broker) => {
    const performance = calculateTradingPerformance(brokerOrders(broker), new Date(updatedAt));
    const summary = ({ count, wins, losses, draws, winRate }) => ({ count, wins, losses, draws, win_rate: winRate });
    const realized = Object.fromEntries(["KRW", "USD"].map((currency) => {
      const result = performance.all.currencies[currency];
      return [currency, { count: result.count, profit_loss: result.profitLoss, return_rate: result.returnRate }];
    }));
    return {
      broker: broker.id,
      account_type: broker.environment === "live" ? "live" : "paper",
      all: summary(performance.all),
      month: summary(performance.month),
      realized,
      excluded_full_exits: performance.excludedFullExits,
      updated_at: updatedAt,
    };
  });
}

function percentage(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function money(value, currency) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const amount = Math.abs(value);
  return currency === "KRW"
    ? `${sign}${Math.round(amount).toLocaleString("ko-KR")}원`
    : `${sign}$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function summaryLine(label, summary) {
  return `**${label}** 완료 ${summary.count}건 · ${summary.wins}승 ${summary.losses}패${summary.draws ? ` ${summary.draws}보합` : ""} · 승률 ${percentage(summary.winRate)}`;
}

function formatTradingPerformanceMessage(brokers, updatedAt) {
  const description = brokers.flatMap((broker, index) => {
    const accountKind = broker.environment === "live" ? "실계좌" : "모의계좌";
    const performance = calculateTradingPerformance(brokerOrders(broker));
    const results = ["KRW", "USD"].flatMap((currency) => {
      const result = performance.all.currencies[currency];
      if (!result.count) return [];
      return [`${currency === "KRW" ? "국내" : "미국"} · 실현손익 ${money(result.profitLoss, currency)} · 실현수익률 ${percentage(result.returnRate)}`];
    });
    return [
      ...(index ? [""] : []),
      `**${broker.label} ${accountKind}**`,
      summaryLine("역대", performance.all),
      summaryLine("이번 달", performance.month),
      ...results,
      ...(performance.excludedFullExits ? [`과거 원가 미확인 청산 ${performance.excludedFullExits}건 제외`] : []),
    ];
  }).join("\n");
  return {
    embeds: [{
      color: 0x5865f2,
      title: "자동매매 누적 성과",
      description,
      footer: { text: `최종청산 완료 기준 · 수수료·세금 제외 · ${String(updatedAt || "").slice(0, 16).replace("T", " ")} UTC` },
    }],
    allowedMentions: { parse: [] },
  };
}

async function brokerPortfolio(broker) {
  const domesticClient = broker.domesticClient || broker;
  const overseasClient = broker.overseasClient || broker;
  const [domestic, usBalances] = await Promise.all([
    domesticClient.getDomesticBalance(),
    overseasClient.getUsBalances ? overseasClient.getUsBalances() : overseasClient.getUsBalance().then((balance) => [balance]),
  ]);
  const usHoldings: any[] = [...new Map<string, any>(usBalances.flatMap((balance: any) => balance.holdings).map((holding: any) => [holding.code, holding])).values()];
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
  const performancePayload = formatTradingPerformanceMessage(brokers, updatedAt);
  const existingPerformance = [...recent.values()].find((candidate) => candidate.embeds?.some((embed) => embed.title === "자동매매 누적 성과"));
  const performanceMessage = existingPerformance ? await existingPerformance.edit(performancePayload) : await channel.send(performancePayload);
  return {
    message,
    performanceMessage,
    accounts,
    performance: tradingPerformanceSnapshot(brokers, updatedAt),
    succeededBrokerIds: new Set(accounts.map((account) => account.id)),
    failures,
  };
}

module.exports = {
  brokerPortfolio,
  calculateTradingPerformance,
  formatTradingPerformanceMessage,
  syncAccountPortfolio,
  tradingPerformanceSnapshot,
};
