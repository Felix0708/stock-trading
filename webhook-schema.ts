"use strict";

const WEBHOOK_SPEC_VERSION = "6.2";

const FIELD_TYPES = {
  ticker: "string",
  name: "string",
  exchange: "string",
  timeframe: "string",
  action: "string",
  type: "string",
  price: "number",
  sl: "nullable-number",
  rr: "nullable-number",
  desc: "string",
  market: "string",
  ai_summary: "string",
  score: "number",
  status: "string",
  signal: "string",
  conviction: "string",
  momentum: "string",
  momentum_sl: "nullable-number",
  momentum_tp: "nullable-number",
  momentum_bars: "nullable-number",
  energy: "number",
  ema1_dist: "number",
  candle_type: "string",
  candle_strength: "number",
  ema_touch: "string",
  ema_align: "string",
  daily_trend: "string",
  daily_ema_aligned: "boolean",
  daily_rs: "number",
  daily_above_200ma: "boolean",
  daily_setup_stage: "string",
  daily_volume_trend: "string",
  daily_dist_from_high: "number",
  rsi2: "number",
  upper_wick_pct: "number",
  atr_multiple: "nullable-number",
  atr_dot: "boolean",
  atr_dot_threshold: "number",
  sb_z_score: "number",
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function matchesType(value, expected) {
  if (expected === "number") return isFiniteNumber(value);
  if (expected === "nullable-number") return value === null || isFiniteNumber(value);
  return typeof value === expected;
}

function validateWebhookPayload(payload) {
  const errors = [];
  const warnings = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload는 JSON 객체여야 합니다."], warnings };
  }

  for (const [field, expected] of Object.entries(FIELD_TYPES)) {
    if (!Object.hasOwn(payload, field)) errors.push(`필수 필드 누락: ${field}`);
    else if (!matchesType(payload[field], expected)) errors.push(`${field}: ${expected} 타입이어야 합니다.`);
  }

  const enumChecks = {
    action: ["BUY", "SELL", "CHECK"],
    conviction: ["S", "A", "B", "C", "D"],
    daily_trend: ["BULL", "MIXED", "BEAR"],
    daily_setup_stage: ["NONE", "FORMING", "COMPLETE"],
    daily_volume_trend: ["ACCUMULATION", "ACCUM", "DISTRIBUTION", "DISTRIB", "NEUTRAL"],
  };
  for (const [field, allowed] of Object.entries(enumChecks)) {
    if (typeof payload[field] === "string" && !allowed.includes(payload[field])) {
      errors.push(`${field}: 허용되지 않은 값 '${payload[field]}'`);
    }
  }

  for (const field of ["ticker", "timeframe", "type"]) {
    if (typeof payload[field] === "string" && !payload[field].trim()) errors.push(`${field}: 빈 문자열일 수 없습니다.`);
  }
  if (isFiniteNumber(payload.price) && payload.price <= 0) errors.push("price는 0보다 커야 합니다.");
  if (isFiniteNumber(payload.score) && (payload.score < 0 || payload.score > 99)) errors.push("score는 0~99 범위여야 합니다.");
  for (const field of ["candle_strength", "daily_rs", "rsi2", "upper_wick_pct"]) {
    if (isFiniteNumber(payload[field]) && (payload[field] < 0 || payload[field] > 100)) {
      errors.push(`${field}: 0~100 범위여야 합니다.`);
    }
  }

  const extraFields = Object.keys(payload).filter((field) => !Object.hasOwn(FIELD_TYPES, field));
  if (extraFields.length) warnings.push(`명세 외 필드: ${extraFields.join(", ")}`);
  if (isFiniteNumber(payload.energy) && isFiniteNumber(payload.atr_multiple)
      && Math.abs(payload.energy - payload.atr_multiple) > 1e-9) {
    warnings.push("energy와 atr_multiple 값이 서로 다릅니다.");
  }
  if (payload.action === "SELL" && payload.type?.includes("진입 무효")) {
    warnings.push("진입 무효 SELL은 즉시 주문하지 말고 상태 머신에서 처리해야 합니다.");
  }
  if (payload.action === "CHECK" && /(진입 확정|진입 만료)/.test(payload.type || "")) {
    warnings.push("이 CHECK 신호는 기존 진입 상태를 변경하므로 단순 참고 알림이 아닙니다.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  FIELD_TYPES,
  WEBHOOK_SPEC_VERSION,
  validateWebhookPayload,
};
