"use strict";

type SignalPayload = { timeframe?: string; sl?: number | null; momentum_sl?: number | null; price: number; conviction?: string; daily_setup_stage?: string; atr_multiple?: number | null; atr_dot?: boolean; atr_dot_threshold?: number; sb_z_score?: number; daily_trend?: string; daily_ema_aligned?: boolean; daily_above_200ma?: boolean };
type SignalRecord = { payload: SignalPayload; outcome?: { decision?: string; signal?: { signalCode?: string } } };
type Holding = { profitLoss?: number; purchaseAmount?: number; evaluationAmount?: number; profitRate?: number };
type TrackedPosition = { fillPrice?: number };
type PositionSizeInput = { equity: number; availableCash?: number; entryPrice: number; stopPrice?: number | null; conviction?: string; dailySetupStage?: string; atrMultiple?: number | null; atrDot?: boolean; atrDotThreshold?: number; sbZScore?: number; openPositions?: number; maxOpenPositions?: number; currentPositionValue?: number; hasExistingPosition?: boolean; earlyEntry?: boolean; capitalOnly?: boolean };
type AccountSizingContext = { equity: number; availableCash: number; openPositions: number; maxOpenPositions: number; currentPositionValue: number; currentPositionQuantity?: number; hasExistingPosition?: boolean; positionProfitable?: boolean | null; currency?: string; totalAccountEquity?: number | null; autoCapital?: number | null; autoCapitalRatio?: number; currentOpenRisk?: number | null; maxOpenRisk?: number | null; maxOpenRiskRatio?: number };

const CONVICTION_MULTIPLIER: Record<string, number> = { S: 1.3, A: 1.1, B: 1, C: 0.7, D: 0 };

function isDailyTimeframe(value: unknown) {
  return ["D", "1D", "DAY", "1DAY"].includes(String(value || "").trim().toUpperCase());
}

function effectiveStopPrice(record: SignalRecord) {
  const payload: SignalPayload = record?.payload || ({} as SignalPayload);
  const signalCode = record?.outcome?.signal?.signalCode || "";
  if (typeof payload.sl === "number" && Number.isFinite(payload.sl) && payload.sl > 0 && payload.sl < payload.price) return payload.sl;
  if (["PEG_PULLBACK", "PEG_REBREAK"].includes(signalCode)
      && typeof payload.momentum_sl === "number" && Number.isFinite(payload.momentum_sl)
      && payload.momentum_sl > 0 && payload.momentum_sl < payload.price) {
    return payload.momentum_sl;
  }
  return null;
}

/**
 * @param {Holding[]} holdings
 * @param {TrackedPosition | null} trackedPosition
 * @param {number | null} signalPrice
 */
function inferPositionProfitable(holdings: Holding[] = [], trackedPosition: TrackedPosition | null = null, signalPrice: number | null = null) {
  const profitLosses = holdings.flatMap((holding) => typeof holding.profitLoss === "number" && Number.isFinite(holding.profitLoss) ? [holding.profitLoss] : []);
  if (profitLosses.length) return profitLosses.reduce((sum, value) => sum + value, 0) > 0;
  const purchaseAmount = holdings.reduce((sum, holding) => sum + (typeof holding.purchaseAmount === "number" && Number.isFinite(holding.purchaseAmount) ? holding.purchaseAmount : 0), 0);
  const evaluationAmount = holdings.reduce((sum, holding) => sum + (typeof holding.evaluationAmount === "number" && Number.isFinite(holding.evaluationAmount) ? holding.evaluationAmount : 0), 0);
  if (purchaseAmount > 0 && evaluationAmount > 0) return evaluationAmount > purchaseAmount;
  const profitRate = holdings.find((holding) => typeof holding.profitRate === "number" && Number.isFinite(holding.profitRate))?.profitRate;
  if (typeof profitRate === "number" && Number.isFinite(profitRate)) return profitRate > 0;
  if (typeof trackedPosition?.fillPrice === "number" && Number.isFinite(trackedPosition.fillPrice)
      && typeof signalPrice === "number" && Number.isFinite(signalPrice)) return signalPrice > trackedPosition.fillPrice;
  return null;
}

function calculatePositionSize(input: PositionSizeInput = {} as PositionSizeInput) {
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
  const validStopPrice = typeof stopPrice === "number" ? stopPrice : Number.NaN;
  if (!capitalOnly && (!Number.isFinite(validStopPrice) || validStopPrice <= 0 || validStopPrice >= entryPrice)) {
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
  if (atrDot || (typeof atrMultiple === "number" && Number.isFinite(atrMultiple) && atrMultiple > atrDotThreshold)) {
    return { blocked: true, reason: "ATR 과열", quantity: 0 };
  }
  if (sbZScore > 3.5) return { blocked: true, reason: "Sigma 극심한 과열", quantity: 0 };

  const setupMultiplier = dailySetupStage === "COMPLETE" ? 1.3 : 1;
  const qualityMultiplier = Math.min(1.3, CONVICTION_MULTIPLIER[grade] * setupMultiplier);
  let heatMultiplier = 1;
  if (typeof atrMultiple === "number" && Number.isFinite(atrMultiple) && atrMultiple > atrDotThreshold * 0.7) heatMultiplier *= 0.7;
  if (sbZScore > 3) heatMultiplier *= 0.25;
  else if (sbZScore > 2.5) heatMultiplier *= 0.5;
  else if (sbZScore > 2) heatMultiplier *= 0.7;

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
  const quantity = capitalOnly ? capitalQuantity : Math.min(Math.floor(riskBudget / (entryPrice - validStopPrice)), capitalQuantity);
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
    stopLossAmount: capitalOnly ? null : quantity * (entryPrice - validStopPrice),
    riskBudget: capitalOnly ? null : riskBudget,
    capitalOnly,
    qualityMultiplier, positionLimitRatio, earlyEntry,
    heatMultiplier,
  };
}

/**
 * @param {SignalRecord} record
 * @param {AccountSizingContext} account
 */
function calculateWebhookPositionPreview(record: SignalRecord, account: AccountSizingContext) {
  const decision = record?.outcome?.decision;
  if (!["ENTRY_CANDIDATE", "ADD_CANDIDATE"].includes(decision || "")) return null;

  const payload: SignalPayload = record.payload || ({} as SignalPayload);
  const stopPrice = effectiveStopPrice(record);
  const capitalOnly = ["PEG_PULLBACK", "PEG_REBREAK"].includes(record?.outcome?.signal?.signalCode || "") && stopPrice === null;
  const dailyProvided = payload.daily_trend !== undefined
    || payload.daily_ema_aligned !== undefined || payload.daily_above_200ma !== undefined;
  const earlyEntry = capitalOnly || isDailyTimeframe(payload.timeframe) || (dailyProvided && (payload.daily_trend !== "BULL"
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
    totalAccountEquity: account.totalAccountEquity,
    autoCapital: account.autoCapital,
    autoCapitalRatio: account.autoCapitalRatio,
    currentOpenRisk: account.currentOpenRisk,
    maxOpenRisk: account.maxOpenRisk,
    maxOpenRiskRatio: account.maxOpenRiskRatio,
  };
}

module.exports = { calculatePositionSize, calculateWebhookPositionPreview, effectiveStopPrice, inferPositionProfitable, isDailyTimeframe, CONVICTION_MULTIPLIER };
