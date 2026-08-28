"use strict";

const CONVICTION_MULTIPLIER = { S: 1.3, A: 1.1, B: 1, C: 0.7, D: 0 };

function effectiveStopPrice(record) {
  const payload = record?.payload || {};
  if (Number.isFinite(payload.sl) && payload.sl > 0 && payload.sl < payload.price) return payload.sl;
  if (["PEG_PULLBACK", "PEG_REBREAK"].includes(record?.outcome?.signal?.signalCode)
      && Number.isFinite(payload.momentum_sl) && payload.momentum_sl > 0 && payload.momentum_sl < payload.price) {
    return payload.momentum_sl;
  }
  return null;
}

function inferPositionProfitable(holdings = [], trackedPosition = null, signalPrice = null) {
  const profitLosses = holdings.map((holding) => holding.profitLoss).filter(Number.isFinite);
  if (profitLosses.length) return profitLosses.reduce((sum, value) => sum + value, 0) > 0;
  const purchaseAmount = holdings.reduce((sum, holding) => sum + (Number.isFinite(holding.purchaseAmount) ? holding.purchaseAmount : 0), 0);
  const evaluationAmount = holdings.reduce((sum, holding) => sum + (Number.isFinite(holding.evaluationAmount) ? holding.evaluationAmount : 0), 0);
  if (purchaseAmount > 0 && evaluationAmount > 0) return evaluationAmount > purchaseAmount;
  const profitRate = holdings.find((holding) => Number.isFinite(holding.profitRate))?.profitRate;
  if (Number.isFinite(profitRate)) return profitRate > 0;
  if (Number.isFinite(trackedPosition?.fillPrice) && Number.isFinite(signalPrice)) return signalPrice > trackedPosition.fillPrice;
  return null;
}

function calculatePositionSize(input = {}) {
  const {
    equity, availableCash = equity, entryPrice, stopPrice, conviction = "B",
    dailySetupStage = "NONE", atrMultiple = null, atrDot = false,
    atrDotThreshold = 7, sbZScore = 0, openPositions = 0, maxOpenPositions = 5,
    currentPositionValue = 0, hasExistingPosition = false, earlyEntry = false,
    capitalOnly = false,
  } = input;
  for (const [name, value] of Object.entries({ equity, availableCash, entryPrice })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name}는 0보다 큰 숫자여야 합니다.`);
  }
  if (!capitalOnly && (!Number.isFinite(stopPrice) || stopPrice <= 0 || stopPrice >= entryPrice)) {
    throw new Error("손절가는 0보다 크고 진입가보다 낮아야 합니다.");
  }
  if (!Number.isInteger(openPositions) || !Number.isInteger(maxOpenPositions) || maxOpenPositions < 1) {
    throw new Error("보유종목 수가 올바르지 않습니다.");
  }
  if (!Number.isFinite(currentPositionValue) || currentPositionValue < 0) {
    throw new Error("기존 보유 평가금액이 올바르지 않습니다.");
  }

  const grade = String(conviction).toUpperCase();
  if (!(grade in CONVICTION_MULTIPLIER)) throw new Error("확신등급은 S, A, B, C, D 중 하나여야 합니다.");
  if (grade === "D") return { blocked: true, reason: "확신등급 D", quantity: 0 };
  if (!hasExistingPosition && openPositions >= maxOpenPositions) {
    return { blocked: true, reason: `최대 ${maxOpenPositions}종목 보유`, quantity: 0 };
  }
  if (atrDot || (Number.isFinite(atrMultiple) && atrMultiple > atrDotThreshold)) {
    return { blocked: true, reason: "ATR 과열", quantity: 0 };
  }
  if (sbZScore > 2.5) return { blocked: true, reason: "Sigma 과열", quantity: 0 };

  const setupMultiplier = dailySetupStage === "COMPLETE" ? 1.3 : 1;
  const qualityMultiplier = Math.min(1.3, CONVICTION_MULTIPLIER[grade] * setupMultiplier);
  let heatMultiplier = 1;
  if (Number.isFinite(atrMultiple) && atrMultiple > atrDotThreshold * 0.7) heatMultiplier *= 0.7;
  if (sbZScore > 2) heatMultiplier *= 0.5;
  else if (sbZScore > 1.5) heatMultiplier *= 0.7;

  const baseRisk = equity * (earlyEntry ? 0.0025 : 0.005);
  const riskBudget = Math.min(equity * 0.01, baseRisk * qualityMultiplier * heatMultiplier);
  const positionLimitRatio = earlyEntry ? 0.1 : 0.2;
  const positionLimit = equity * positionLimitRatio;
  const capitalLimit = Math.min(Math.max(0, positionLimit - currentPositionValue), availableCash);
  const capitalQuantity = Math.floor(capitalLimit / entryPrice);
  if (capitalQuantity < 1) {
    return {
      blocked: true, reason: `한 종목 총 보유금액 ${positionLimitRatio * 100}% 한도 도달`, quantity: 0,
      currentPositionValue, positionLimit, positionLimitRatio, capitalLimit, earlyEntry,
    };
  }
  const quantity = capitalOnly ? capitalQuantity : Math.min(Math.floor(riskBudget / (entryPrice - stopPrice)), capitalQuantity);
  if (quantity < 1) return { blocked: true, reason: "계산된 주문수량이 1주 미만", quantity: 0 };
  return {
    blocked: false,
    reason: "OK",
    quantity,
    baseRisk,
    capitalLimit,
    positionValue: quantity * entryPrice,
    currentPositionValue,
    projectedPositionValue: currentPositionValue + quantity * entryPrice,
    projectedPositionRatio: ((currentPositionValue + quantity * entryPrice) / equity) * 100,
    stopLossAmount: capitalOnly ? null : quantity * (entryPrice - stopPrice),
    riskBudget: capitalOnly ? null : riskBudget,
    capitalOnly,
    qualityMultiplier, positionLimitRatio, earlyEntry,
    heatMultiplier,
  };
}

function calculateWebhookPositionPreview(record, account) {
  const decision = record?.outcome?.decision;
  if (!["ENTRY_CANDIDATE", "ADD_CANDIDATE"].includes(decision)) return null;

  const payload = record.payload || {};
  const stopPrice = effectiveStopPrice(record);
  const capitalOnly = ["PEG_PULLBACK", "PEG_REBREAK"].includes(record?.outcome?.signal?.signalCode) && stopPrice === null;
  const dailyProvided = payload.daily_trend !== undefined
    || payload.daily_ema_aligned !== undefined || payload.daily_above_200ma !== undefined;
  const earlyEntry = capitalOnly || (dailyProvided && (payload.daily_trend !== "BULL"
    || payload.daily_ema_aligned !== true || payload.daily_above_200ma !== true));
  const result = calculatePositionSize({
    equity: account.equity,
    availableCash: account.availableCash,
    entryPrice: payload.price,
    stopPrice,
    conviction: payload.conviction,
    dailySetupStage: payload.daily_setup_stage,
    atrMultiple: payload.atr_multiple,
    atrDot: payload.atr_dot,
    atrDotThreshold: payload.atr_dot_threshold,
    sbZScore: payload.sb_z_score,
    openPositions: account.openPositions,
    maxOpenPositions: account.maxOpenPositions,
    currentPositionValue: account.currentPositionValue,
    hasExistingPosition: account.hasExistingPosition,
    earlyEntry,
    capitalOnly,
  });
  return {
    available: true,
    ...result,
    equity: account.equity,
    availableCash: account.availableCash,
    entryPrice: payload.price,
    stopPrice,
    conviction: payload.conviction,
    currentPositionQuantity: account.currentPositionQuantity || 0,
    hasExistingPosition: Boolean(account.hasExistingPosition),
    positionProfitable: account.positionProfitable ?? null,
    currency: account.currency || "USD",
  };
}

module.exports = { calculatePositionSize, calculateWebhookPositionPreview, effectiveStopPrice, inferPositionProfitable, CONVICTION_MULTIPLIER };
