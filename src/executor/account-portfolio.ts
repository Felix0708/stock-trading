"use strict";

const { enrichInstrumentNames } = require("../research/instrument-names");
const { formatMyPortfolioMessage } = require("../research/investor-portfolio");
const { orderTime, normalizedSymbol, normalizedTimeframe } = require("../trading/position-ownership");
const { timeframeLabel } = require("../discord/webhook-discord");
const { SIGNAL_RULES } = require("../signals/signal-normalizer");

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function marketCurrency(order) {
  return order.currency === "KRW" || String(order.market || "").toUpperCase() === "KRX" ? "KRW" : "USD";
}

function positionKey(order) {
  return `${order.environment || "mock"}:${marketCurrency(order)}:${normalizedSymbol(order.symbol)}`;
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

function sigmaBand(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "미확인";
  return value <= 2 ? "≤2" : value <= 2.5 ? "2~2.5" : value <= 3 ? "2.5~3" : value <= 3.5 ? "3~3.5" : ">3.5";
}

function addExecutionCosts(position, order) {
  const costs = order.executionCosts;
  const known = costs && costs.currency === marketCurrency(order) && costs.filledQuantity === order.filledQuantity
    && typeof costs.source === "string" && costs.source.trim()
    && (costs.total !== undefined ? typeof costs.total === "number" && Number.isFinite(costs.total) && costs.total >= 0
      : [costs.fees, costs.taxes].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0));
  position.costsKnown &&= Boolean(known);
  if (known) position.costs += costs.total ?? costs.fees + costs.taxes;
  if (positiveNumber(order.signalPrice) && positiveNumber(order.fillPrice)) {
    position.signalPriceDifference += (order.fillPrice - order.signalPrice) * order.filledQuantity * (order.side === "BUY" ? 1 : -1);
  } else position.signalPriceKnown = false;
}

function calculateTradingPerformance(orders, now = new Date()) {
  const positions = new Map();
  const completed = [];
  let excludedFullExits = 0;
  const filled = orders
    .filter((order) => positiveNumber(order.filledQuantity))
    .sort((a, b) => orderTime(a) - orderTime(b));

  for (const order of filled) {
    const key = positionKey(order);
    const quantity = positiveNumber(order.filledQuantity);
    const price = positiveNumber(order.fillPrice);
    if (!quantity) continue;
    if (order.side === "BUY") {
      if (order.entryType === "PAPER_ENTRY" && !positions.has(key)) positions.set(key, {
        quantity: 0, cost: 0, realizedBasis: 0, profitLoss: 0, reliable: true,
        costs: 0, costsKnown: true, signalPriceDifference: 0, signalPriceKnown: true,
        timeframe: normalizedTimeframe(order.timeframe) || "미확인", signalCode: order.signalCode || "미확인",
        sigmaBand: sigmaBand(order.sizingContext?.sigmaZ), policyVersion: order.policyVersion || "legacy", entryRequestId: order.requestId,
        evaluationIssues: [],
      });
      const position = positions.get(key);
      if (position && ["PAPER_ENTRY", "PAPER_ADD"].includes(order.entryType)) {
        position.quantity += quantity;
        position.cost += quantity * (price || 0);
        if (!price) position.reliable = false;
        addExecutionCosts(position, order);
        position.evaluationIssues.push(...(order.evaluationIssues || []));
        if (normalizedTimeframe(order.timeframe) !== position.timeframe) position.timeframe = "혼합·미확인";
        if ((order.policyVersion || "legacy") !== position.policyVersion) position.policyVersion = "혼합";
      }
      continue;
    }
    if (order.side !== "SELL") continue;

    let position = positions.get(key);
    const brokerAverage = positiveNumber(order.preTradeAverageEntryPrice);
    if (!position && brokerAverage) {
      const held = positiveNumber(order.preTradePositionQuantity) || positiveNumber(order.orderQuantity) || quantity;
      position = { quantity: held, cost: held * brokerAverage, realizedBasis: 0, profitLoss: 0, reliable: true,
        costs: 0, costsKnown: false, signalPriceDifference: 0, signalPriceKnown: false,
        timeframe: "미확인", signalCode: "미확인", sigmaBand: "미확인", policyVersion: "legacy", evaluationIssues: [] };
      positions.set(key, position);
    }
    if (!position) {
      if (order.fullExit) excludedFullExits += 1;
      continue;
    }
    addExecutionCosts(position, order);
    position.evaluationIssues.push(...(order.evaluationIssues || []));

    // Reconstructed strategy cost takes precedence over an account average that may include manual holdings.
    const average = position.quantity >= quantity && position.cost > 0 ? position.cost / position.quantity : brokerAverage;
    if (!average || !price || quantity > position.quantity) position.reliable = false;
    else {
      const basis = average * quantity;
      position.realizedBasis += basis;
      position.profitLoss += (price || 0) * quantity - basis;
    }
    if (position.quantity > 0) {
      const trackedAverage = position.cost / position.quantity;
      const removed = Math.min(position.quantity, quantity);
      position.quantity -= removed;
      position.cost = Math.max(0, position.cost - trackedAverage * removed);
    }

    // A full-exit intent or FILLED order does not mean the entire position has closed.
    if (position.quantity === 0) {
      if (position.reliable && position.realizedBasis > 0) completed.push({
        completedAt: order.reconciliationEvidence ? order.evidenceFilledAt : order.lastFillAt || order.resultAt || order.createdAt || order.updatedAt,
        currency: marketCurrency(order),
        costBasis: position.realizedBasis,
        profitLoss: position.profitLoss,
        netProfitLoss: position.costsKnown ? position.profitLoss - position.costs : null,
        costs: position.costsKnown ? position.costs : null,
        signalPriceDifference: position.signalPriceKnown ? position.signalPriceDifference : null,
        timeframe: position.timeframe, signalCode: position.signalCode, sigmaBand: position.sigmaBand,
        policyVersion: position.policyVersion, entryRequestId: position.entryRequestId,
        symbol: normalizedSymbol(order.symbol), evaluationIssues: [...new Set(position.evaluationIssues)],
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
    completed,
  };
}

function strategyComparison(broker, signals = {}) {
  const performance = calculateTradingPerformance(brokerOrders(broker));
  const operational = performance.completed.filter(trade => trade.evaluationIssues.length);
  const eligible = performance.completed.filter(trade => !trade.evaluationIssues.length);
  const dimensions = ["timeframe", "signalCode", "sigmaBand", "policyVersion"];
  const groups = [];
  for (const dimension of dimensions) {
    for (const currency of ["USD", "KRW"]) {
      for (const label of new Set(eligible.filter(trade => trade.currency === currency).map(trade => trade[dimension]))) {
        const trades = eligible.filter(trade => trade.currency === currency && trade[dimension] === label)
          .sort((a, b) => Date.parse(a.completedAt || "") - Date.parse(b.completedAt || ""));
        const summary = summarizeCompletedTrades(trades);
        let balance = 0, peak = 0, realizedDrawdown = 0;
        for (const trade of trades) { balance += trade.profitLoss; peak = Math.max(peak, balance); realizedDrawdown = Math.max(realizedDrawdown, peak - balance); }
        const netKnown = trades.filter(trade => trade.netProfitLoss !== null);
        const netProfitLoss = netKnown.length === trades.length ? netKnown.reduce((sum, trade) => sum + trade.netProfitLoss, 0) : null;
        const netSummary = summarizeCompletedTrades(netKnown.map(trade => ({ ...trade, profitLoss: trade.netProfitLoss })));
        groups.push({ dimension, label, currency, count: trades.length, winRate: summary.winRate,
          profitLoss: balance, returnRate: summary.currencies[currency].returnRate,
          realizedDrawdown: trades.every(trade => Number.isFinite(Date.parse(trade.completedAt))) ? realizedDrawdown : null,
          netProfitLoss, netWinRate: netProfitLoss === null ? null : netSummary.winRate,
          netReturnRate: netProfitLoss === null ? null : netSummary.currencies[currency].returnRate,
          unknownCosts: trades.length - netKnown.length,
          signalPriceDifference: trades.every(trade => trade.signalPriceDifference !== null) ? trades.reduce((sum, trade) => sum + trade.signalPriceDifference, 0) : null });
      }
    }
  }
  const blocked = new Map();
  for (const entry of Object.values(signals) as any[]) {
    const progress = entry.progress?.[broker.id];
    if (progress?.status !== "BLOCKED") continue;
    const key = [normalizedTimeframe(entry.record.payload?.timeframe) || "미확인", entry.record.outcome?.signal?.signalCode || "미확인",
      sigmaBand(entry.record.payload?.sb_z_score), entry.record.policyVersion || "legacy", progress.reason || "사유 미확인"].join(" · ");
    blocked.set(key, (blocked.get(key) || 0) + 1);
  }
  return { groups, operational, blocked: [...blocked].map(([label, count]) => ({ label, count })), excludedFullExits: performance.excludedFullExits };
}

function formatStrategyComparisonMessage(brokers, signals = {}) {
  const dimensions = { timeframe: "시간봉", signalCode: "진입 신호", sigmaBand: "Sigma", policyVersion: "정책" };
  return { embeds: brokers.map(broker => {
    const comparison = strategyComparison(broker, signals);
    const fields = Object.entries(dimensions).map(([dimension, label]) => ({ name: label, value: comparison.groups
      .filter(group => group.dimension === dimension).map(group =>
        `${dimension === "timeframe" ? timeframeLabel(group.label) : dimension === "signalCode" ? SIGNAL_RULES.find(([, code]) => code === group.label)?.[0] || group.label : group.label === "legacy" ? "과거 정책 미확인" : group.label} · ${group.currency} · ${group.count}건 · 승률 ${percentage(group.winRate)}\n손익 ${money(group.profitLoss, group.currency)} (${percentage(group.returnRate)}) · 실현손익 낙폭 ${group.realizedDrawdown === null ? "시각 미확인" : money(group.realizedDrawdown, group.currency).replace(/^\+/, "")}\n비용 차감 ${group.netProfitLoss === null ? `미확인 ${group.unknownCosts}건` : `${money(group.netProfitLoss, group.currency)} (${percentage(group.netReturnRate)})`}`
      ).join("\n") || "비교할 최종청산 표본 없음" }));
    fields.push({ name: "차단 신호 (가상 수익에 합산하지 않음)", value: comparison.blocked.map(row => `${row.label}: ${row.count}건`).join("\n") || "계좌별 차단 기록 없음" });
    if (comparison.operational.length) fields.push({ name: "운영 장애·보유 중 정책 변경 (전략 비교만 제외)",
      value: comparison.operational.map(trade => `${trade.symbol} · ${money(trade.profitLoss, trade.currency)} · ${trade.evaluationIssues.join(" / ")}`).join("\n")
        + "\n실제 손익·전체 승률에는 포함. 장애가 없었을 때의 수익을 가정하지 않습니다." });
    return { title: "자동매매 전략 비교", description: `${broker.label} ${broker.environment === "live" ? "실계좌" : "모의계좌"} · 최초 진입 기준 분류 · 승률·수익률은 비용 전`,
      color: 0x5865f2, fields: fields.map(field => ({ ...field, value: field.value.length > 480 ? `${field.value.slice(0, 400)}\n…전체: !account performance` : field.value })),
      footer: { text: "실현손익 낙폭 ≠ 계좌 MDD · 비용 미확인을 0원으로 보지 않음 · 실제 체결가 사용" } };
  }), allowedMentions: { parse: [] } };
}

function brokerOrders(broker) {
  const accountKind = broker.environment === "live" ? "실계좌" : "모의계좌";
  return (broker.tracker?.list?.() || []).filter((order) => order.environment
    ? order.environment === broker.environment
    : String(order.brokerLabel || "").includes(accountKind));
}

function harmonizePortfolioNames(accounts) {
  const names = new Map();
  for (const account of accounts) {
    for (const [market, holdings] of [["KR", account.domestic?.holdingPositions || []], ["US", account.overseas?.holdingPositions || []]]) {
      for (const holding of holdings) {
        const key = `${market}:${String(holding.code || holding.ticker || "").replace(/^A(?=\d{6}$)/, "").toUpperCase()}`;
        const current = names.get(key) || {};
        const fallback = String(holding.name || "").trim();
        current.koreanName ||= String(holding.koreanName || (/[가-힣]/.test(fallback) ? fallback : "")).trim();
        current.englishName ||= String(holding.englishName || (fallback && !/[가-힣]/.test(fallback) ? fallback : "")).trim();
        names.set(key, current);
      }
    }
  }
  return accounts.map((account) => ({
    ...account,
    ...Object.fromEntries([["domestic", "KR"], ["overseas", "US"]].map(([section, market]) => [section, {
      ...account[section],
      holdingPositions: (account[section]?.holdingPositions || []).map((holding) => ({
        ...holding,
        ...names.get(`${market}:${String(holding.code || holding.ticker || "").replace(/^A(?=\d{6}$)/, "").toUpperCase()}`),
      })),
    }])),
  }));
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
  const accounts = harmonizePortfolioNames(settled.filter((result) => result.status === "fulfilled").map((result) => result.value));
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
  harmonizePortfolioNames,
  syncAccountPortfolio,
  tradingPerformanceSnapshot,
  strategyComparison,
  formatStrategyComparisonMessage,
  sigmaBand,
};
