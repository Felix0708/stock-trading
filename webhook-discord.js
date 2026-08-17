"use strict";

const DECISION_LABELS = {
  ENTRY_CANDIDATE: "진입 검토",
  ADD_CANDIDATE: "추가매수 검토",
  WAIT_FOR_CONFIRMATION: "확정/만료 대기 — 즉시 매도 금지",
  KEEP_IF_FILLED: "체결됐다면 유지",
  EXIT_IF_FILLED: "체결됐다면 청산 검토",
  EXIT_CANDIDATE: "청산 검토",
  PARTIAL_EXIT_CANDIDATE: "부분청산 검토",
  REVIEW_PARTIAL_EXIT: "부분청산 비율 검토",
  INFO_ONLY: "참고 정보",
  BLOCKED: "차단",
  REJECTED_INVALID: "명세 오류로 차단",
};

const TRADE_GATE_VERDICTS = new Set([
  "BUY_PENDING_APPROVAL",
  "PAPER_ENTRY",
  "PAPER_ADD",
  "PAPER_PARTIAL_EXIT",
  "PAPER_EXIT",
]);
const DOMESTIC_EXCHANGES = new Set(["KRX", "KOSPI", "KOSDAQ"]);

function isTradeSignal(record) {
  return TRADE_GATE_VERDICTS.has(record.risk?.verdict);
}

function targetSignalChannel(record) {
  const market = DOMESTIC_EXCHANGES.has(record.payload?.exchange) ? "국장" : "미국";
  const kind = isTradeSignal(record) ? "매매" : "관찰";
  return `${market}-${kind}신호`;
}

function display(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function money(value, currency = "USD") {
  if (currency === "KRW") return `${Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}원`;
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function positionPreviewLines(preview) {
  if (!preview) return [];
  if (!preview.available) return [`**자동 수량 미리보기**: 대기 — ${display(preview.reason)}`];
  if (preview.blocked) return [`**자동 수량 미리보기**: 🛑 차단 — ${display(preview.reason)}`];
  return [
    `**모의계좌**: 평가액 ${money(preview.equity, preview.currency)} / 가용 현금 ${money(preview.availableCash, preview.currency)}`,
    `**자동 수량 미리보기**: **${preview.quantity}주** / 예상 투자금 ${money(preview.positionValue, preview.currency)}`,
    ...(Number.isFinite(preview.projectedPositionRatio)
      ? [`**주문 후 종목 비중**: ${preview.projectedPositionRatio.toFixed(2)}% / 최대 ${(preview.positionLimitRatio ?? 0.2) * 100}%`]
      : []),
    `**예상 위험**: 손절 시 ${money(preview.stopLossAmount, preview.currency)} / 적용 한도 ${money(preview.riskBudget, preview.currency)}`,
  ];
}

function payloadLines(payload) {
  return [
    "**TradingView 원본 지표 전체값**",
    ...Object.entries(payload).map(([key, value]) => `\`${key}\`: ${JSON.stringify(value) ?? "undefined"}`),
  ];
}

function formatWebhookRecord(record) {
  const payload = record.payload || {};
  const outcome = record.outcome || {};
  const signal = outcome.signal || {};
  const risk = record.risk || {};
  const identity = `${display(payload.name)} (${display(payload.ticker)})`;
  const orderLine = !record.orderAttempt
    ? "**주문**: 🔒 생성 안 됨"
    : record.orderAttempt.status === "ACCEPTED"
      ? `**주문**: 📨 키움 모의계좌 ${display(record.orderAttempt.side)} ${display(record.orderAttempt.orderQuantity)}주 접수 · 끝 4자리 ${String(record.orderAttempt.orderNo).slice(-4)}`
      : `**주문**: 🛑 ${display(record.orderAttempt.status)} — ${display(record.orderAttempt.reason)}`;

  if (!record.validation?.ok || outcome.decision === "REJECTED_INVALID" || outcome.decision === "BLOCKED") {
    const reasons = [...(record.validation?.errors || []), ...(outcome.warnings || [])].slice(0, 8);
    return {
      channel: "system",
      text: [
        "🛑 **TradingView 웹훅 차단**",
        `**종목**: ${identity}`,
        `**원본 신호**: ${display(payload.type)}`,
        `**사유**: ${reasons.join(" / ") || "알 수 없는 신호"}`,
        "**주문**: 🔒 생성 안 됨",
        ...payloadLines(payload),
        `\`request_id: ${record.requestId}\``,
      ].join("\n"),
    };
  }

  if (outcome.duplicate) {
    return {
      channel: "system",
      text: [
        `♻️ **중복 신호 무시** — ${identity}`,
        `${display(payload.type)} · ${display(payload.price)} · ${display(payload.timeframe)}`,
        "주문 생성 안 됨",
        ...payloadLines(payload),
      ].join("\n"),
    };
  }

  return {
    channel: "signal",
    targetChannel: targetSignalChannel(record),
    text: [
      isTradeSignal(record)
        ? "🚨 **TradingView 매매 신호**"
        : "📡 **TradingView 관찰 신호**",
      `**종목**: ${identity} / ${display(payload.exchange)}`,
      `**원본 신호**: ${display(payload.type)}`,
      `**내부 코드**: \`${display(signal.signalCode)}\`${signal.modifiers?.length ? ` / ${signal.modifiers.join(", ")}` : ""}`,
      `**구분·가격**: ${display(payload.action)} / ${display(payload.price)} / ${display(payload.timeframe)}`,
      `**손절·손익비**: ${display(payload.sl)} / ${display(payload.rr)}`,
      `**확신·점수**: ${display(payload.conviction)} / ${display(payload.score)}`,
      `**판정**: ${DECISION_LABELS[outcome.decision] || display(outcome.decision)}`,
      `**자동매매 게이트**: \`${display(risk.verdict)}\` — ${display(risk.reason)}`,
      `**모의 보유**: ${display(risk.openCount)}/${display(risk.maxOpenPositions)}`,
      ...positionPreviewLines(record.positionPreview),
      orderLine,
      ...payloadLines(payload),
      `\`request_id: ${record.requestId}\``,
    ].join("\n"),
  };
}

function formatOrderStatus(order) {
  const icons = {
    ACCEPTED: "📨", PARTIALLY_FILLED: "⏳", FILLED: "✅",
    CANCEL_REQUESTED: "🧹", CANCELLED: "🚫", REJECTED: "🛑",
  };
  const identity = order.name ? `${order.name} (${display(order.symbol)})` : display(order.symbol);
  return {
    channel: "system",
    text: [
      `${icons[order.status] || "ℹ️"} **키움 모의주문 상태**`,
      `**종목**: ${identity} / ${display(order.side)}`,
      `**상태**: \`${display(order.status)}\``,
      `**수량**: 주문 ${display(order.orderQuantity)} / 체결 ${display(order.filledQuantity)} / 잔량 ${display(order.remainingQuantity)}`,
      order.fillPrice ? `**체결가**: ${display(order.fillPrice)}` : null,
      `**주문번호**: 끝 4자리 ${String(order.orderNo || "").slice(-4) || "-"}`,
    ].filter(Boolean).join("\n"),
  };
}

module.exports = { formatWebhookRecord, formatOrderStatus, positionPreviewLines, targetSignalChannel };
