"use strict";

// Wire schema 5.0 (reference v7). Keep the legacy internal contract at one boundary.
const BLOCK_FIELDS = {
  symbol: { string: "ticker name exchange tf htf market preset" },
  signal: { string: "action type desc grade grade_why conviction", number: "price max_stop conviction_score", nullable: "sl rr trigger_price tp1 tp2", boolean: "sl_wide" },
  verdict: { string: "smart traffic", number: "stage power direction score tech_fire tech_vol tech_base checks_ok checks_total" },
  market: { string: "why sector htf_align htf_trend htf_volume", number: "htf_rs htf_dist_high", nullable: "sector_chg", boolean: "bad leader demoted htf_head htf_tail htf_above200" },
  stock: { string: "ema_align ema_touch candle", number: "rs_rating rel_vol adx di_plus di_minus ema1_dist ema1_len atr_pct sl_atr_pct energy energy_limit candle_strength close_range sb_z", nullable: "res_dist", boolean: "rs_line_high overheat wick_demoted" },
  setup: { string: "contraction stage signals fundamental", number: "signals_n" },
  position: { string: "exit_strategy", number: "trim_n pyramid", nullable: "entry avg bars trail_sl", boolean: "held tp1_hit tp2_hit" },
  exit: { number: "depth_atr", boolean: "weak no_trend" },
  momentum: { string: "status", nullable: "sl tp bars" },
};

function validateNestedWebhook(payload) {
  const errors = [], warnings = [];
  if (payload.schema_ver !== "5.0") errors.push("지원하지 않는 schema_ver");
  if (!Number.isSafeInteger(payload.bar_time) || payload.bar_time <= 0) errors.push("bar_time: 양의 ms epoch 정수 필요");
  for (const [block, groups] of Object.entries(BLOCK_FIELDS)) {
    const value = payload[block];
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${block}: 객체 필요`); continue; }
    for (const [type, names] of Object.entries(groups)) {
      for (const key of names.split(" ")) {
        const v = value[key];
        const valid = type === "nullable" ? v === null || (typeof v === "number" && Number.isFinite(v))
          : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type;
        if (!valid) errors.push(`${block}.${key}: ${type} 타입 필요`);
      }
    }
  }
  for (const [block, field, allowed] of [
    ["signal", "action", ["BUY", "SELL", "CHECK"]],
    ["signal", "grade", ["GO", "HALF", "WAIT", "NO", "OFF"]],
    ["signal", "conviction", ["S", "A", "B", "C", "D"]],
    ["market", "htf_trend", ["BULL", "MIXED", "BEAR"]],
    ["market", "htf_volume", ["ACCUMULATION", "DISTRIBUTION", "NEUTRAL"]],
    ["setup", "stage", ["NONE", "FORMING", "COMPLETE"]],
    ["momentum", "status", ["없음", "BUY", "SELL"]],
  ] as [string, string, string[]][]) {
    if (!allowed.includes(payload[block]?.[field])) errors.push(`${block}.${field}: 허용되지 않은 값`);
  }
  for (const key of ["ticker", "tf", "htf"]) if (typeof payload.symbol?.[key] !== "string" || !payload.symbol[key].trim()) errors.push(`symbol.${key}: 문자열 필요`);
  if (typeof payload.signal?.type !== "string" || !payload.signal.type.trim()) errors.push("signal.type: 문자열 필요");
  if (!(payload.signal?.price > 0)) errors.push("signal.price: 양수 필요");
  if (!(payload.stock?.energy_limit > 0)) errors.push("stock.energy_limit: 양수 필요");
  for (const [block, key] of [["signal", "conviction_score"], ["stock", "candle_strength"], ["stock", "close_range"], ["stock", "rs_rating"], ["market", "htf_rs"]]) {
    const v = payload[block]?.[key];
    if (typeof v === "number" && (v < 0 || v > 100)) errors.push(`${block}.${key}: 0~100 필요`);
  }
  if (!payload.symbol?.exchange) warnings.push("거래소 미포함: 주문 불가, 지표 거래소 포함 설정 확인");
  return { ok: errors.length === 0, errors, warnings };
}

function normalizeWebhookPayload(payload) {
  // Idempotent for recovered records; never promote an invalid wire payload.
  if (!payload?.symbol || payload.schema_ver !== "5.0") return payload;
  const { symbol: s, signal: g, verdict: v, market: m, stock: t, setup: u, position, exit, momentum: p } = payload;
  return {
    schema_ver: payload.schema_ver, bar_time: payload.bar_time,
    ticker: s.ticker.trim().toUpperCase(), name: s.name,
    exchange: ["KOSPI", "KOSDAQ"].includes(s.exchange.trim().toUpperCase()) ? "KRX" : s.exchange.trim().toUpperCase(),
    timeframe: s.tf, htf: s.htf, market: s.market, preset: s.preset,
    ...g, ai_summary: v.smart, score: v.score, status: v.traffic,
    signal: u.signals, signals_n: u.signals_n, setup_stage: u.stage,
    momentum: p.status, momentum_sl: p.sl, momentum_tp: p.tp, momentum_bars: p.bars,
    energy: t.energy, ema1_dist: t.ema1_dist, candle_type: t.candle, candle_strength: t.candle_strength,
    ema_touch: t.ema_touch, ema_align: t.ema_align,
    htf_trend: m.htf_trend, htf_ema_aligned: m.htf_align === "정배열", htf_above_200ma: m.htf_above200,
    atr_multiple: t.energy, atr_dot: t.overheat, atr_dot_threshold: t.energy_limit, sb_z_score: t.sb_z,
    // Display-only evidence. Broker holdings and fills remain the only ownership ledger.
    indicator_position: position, indicator_exit: exit,
    indicator_market: m, indicator_stock: t, indicator_verdict: v, indicator_setup: u,
  };
}

function higherTimeframeContext(payload) {
  return payload?.schema_ver === "5.0"
    ? { timeframe: payload.htf, trend: payload.htf_trend, aligned: payload.htf_ema_aligned, above200: payload.htf_above_200ma }
    : { timeframe: "D", trend: payload?.daily_trend, aligned: payload?.daily_ema_aligned, above200: payload?.daily_above_200ma };
}

function executionGradeBlock(payload) {
  if (payload?.schema_ver !== "5.0" || payload.action !== "BUY") return "";
  if (payload.grade === "WAIT") return "실행 등급 WAIT · 눌림 대기, 새 진입 신호 필요";
  if (payload.grade === "NO") return "실행 등급 NO · 진입 금지";
  if (payload.grade === "OFF") return "실행 등급 OFF · 판단 없음, 자동 진입 보류";
  if (!["GO", "HALF"].includes(payload.grade)) return "실행 등급 누락 또는 오류";
  return "";
}

function entryReferencePrice(record) {
  const p = record.payload || {};
  const signalPrice = record.originalSignalPrice ?? p.price;
  return p.schema_ver === "5.0" && record.outcome?.decision === "ENTRY_CANDIDATE"
    && typeof p.trigger_price === "number" && Number.isFinite(p.trigger_price) && p.trigger_price > 0
    ? Math.min(signalPrice, p.trigger_price) : signalPrice;
}

module.exports = { BLOCK_FIELDS, validateNestedWebhook, normalizeWebhookPayload, higherTimeframeContext, executionGradeBlock, entryReferencePrice };
