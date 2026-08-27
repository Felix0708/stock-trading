"use strict";

const { encodeSignalEnvelope, TRANSPORT_URL_PREFIX } = require("./discord-signal-envelope");

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
const ENTRY_DECISIONS = new Set(["ENTRY_CANDIDATE", "ADD_CANDIDATE"]);
const EXIT_DECISIONS = new Set(["EXIT_CANDIDATE", "PARTIAL_EXIT_CANDIDATE", "REVIEW_PARTIAL_EXIT", "EXIT_IF_FILLED"]);
const CONVICTION_ICONS = { S: "🟣", A: "🟢", B: "🟡", C: "🟠", D: "🔴" };
const ORDER_STATUS = {
  ACCEPTED: ["📨", "접수", 0x5865F2],
  PARTIALLY_FILLED: ["⏳", "부분 체결", 0xFEE75C],
  FILLED: ["✅", "체결 완료", 0x57F287],
  CANCEL_REQUESTED: ["🧹", "취소 요청", 0xFEE75C],
  CANCELLED: ["🚫", "취소", 0xED4245],
  REJECTED: ["🛑", "거절", 0xED4245],
};

function isTradeSignal(record) {
  return TRADE_GATE_VERDICTS.has(record.risk?.verdict);
}

function signalKind(record) {
  const decision = record.outcome?.decision;
  const action = record.payload?.action;
  return ENTRY_DECISIONS.has(decision) || action === "BUY"
    ? "진입"
    : EXIT_DECISIONS.has(decision) || action === "SELL" ? "청산" : "관찰";
}

function targetSignalChannels(record) {
  const market = DOMESTIC_EXCHANGES.has(record.payload?.exchange) ? "국장" : "미국";
  const kind = signalKind(record);
  return [
    `${market}-전체신호`,
    `${market}-${kind}신호`,
    ...(encodeSignalEnvelope(record) ? [`${market}-매매신호`] : []),
  ];
}

function targetSignalChannel(record) {
  return targetSignalChannels(record)[1];
}

function display(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function money(value, currency = "USD") {
  if (currency === "KRW") return `${Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}원`;
  return `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function clip(value, max) {
  const text = display(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function signalPrice(value, exchange) {
  if (!Number.isFinite(value)) return display(value);
  return DOMESTIC_EXCHANGES.has(exchange)
    ? `${value.toLocaleString("ko-KR")}원`
    : `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

function signalEmbed(record, identity, orderLine) {
  const payload = record.payload || {};
  const risk = record.risk || {};
  const status = [payload.status, payload.ema_align].filter(Boolean).join(" · ") || "-";
  const preview = record.positionPreview;
  const sizing = preview?.available && !preview.blocked
    ? `\n수량 ${display(preview.quantity)}주 · 예상 ${money(preview.positionValue, preview.currency)}`
    : preview?.blocked ? `\n수량 차단 · ${display(preview.reason)}` : "";
  const envelope = encodeSignalEnvelope(record);
  const fields = [
    { name: "상태", value: clip(status, 512) },
    { name: "AI 평가", value: clip(payload.ai_summary, 1024) },
    { name: "설명", value: clip(payload.desc, 1024) },
    {
      name: "정보",
      value: clip([payload.market, payload.exchange, payload.timeframe && `${payload.timeframe}분봉`].filter(Boolean).join(" · "), 512),
    },
    {
      name: "자동매매",
      value: clip(`\`${display(risk.verdict)}\` · ${display(risk.reason)}${sizing}\n${orderLine.replaceAll("**", "")}`, 1024),
    },
  ].filter((field) => field.value !== "-");
  return {
    color: isTradeSignal(record) ? 0x57F287 : payload.action === "SELL" ? 0xED4245 : 0xFEE75C,
    title: clip(`${CONVICTION_ICONS[payload.conviction] || "⚪"} ${display(payload.conviction)} · ${display(payload.type)}`, 256),
    description: clip([
      `**${identity} · ${display(payload.exchange)}**`,
      `${signalPrice(payload.price, payload.exchange)} · SL ${signalPrice(payload.sl, payload.exchange)} · R/R ${display(payload.rr)}`,
    ].join("\n"), 1024),
    fields,
    ...(envelope ? { author: { name: "자동주문 연동", url: `${TRANSPORT_URL_PREFIX}${envelope}` } } : {}),
    ...(record.receivedAt ? { timestamp: record.receivedAt } : {}),
  };
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
  const brokerLabel = record.orderAttempt?.brokerLabel || "키움 모의계좌";
  const orderLine = !record.orderAttempt
    ? "**주문**: 🔒 생성 안 됨"
    : record.orderAttempt.status === "ACCEPTED"
      ? `**주문**: 📨 ${brokerLabel} ${display(record.orderAttempt.side)} ${display(record.orderAttempt.orderQuantity)}주 접수 · 끝 4자리 ${String(record.orderAttempt.orderNo).slice(-4)}`
      : `**주문**: 🛑 ${display(record.orderAttempt.status)} — ${display(record.orderAttempt.reason)}`;

  if (!record.validation?.ok || outcome.decision === "REJECTED_INVALID" || outcome.decision === "BLOCKED") {
    const reasons = [...(record.validation?.errors || []), ...(outcome.warnings || [])].slice(0, 3);
    return {
      channel: "system",
      text: [
        "🛑 **TradingView 웹훅 차단**",
        `**종목**: ${identity}`,
        `**원본 신호**: ${display(payload.type)}`,
        `**사유**: ${reasons.join(" / ") || "알 수 없는 신호"}`,
        "**주문**: 🔒 생성 안 됨",
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
    targetChannels: targetSignalChannels(record),
    embed: signalEmbed(record, identity, orderLine),
    text: [
      `📡 **TradingView ${signalKind(record)} 신호**`,
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
  const [icon, label, color] = ORDER_STATUS[order.status] || ["ℹ️", display(order.status), 0x5865F2];
  const identity = order.name ? `${order.name} (${display(order.symbol)})` : display(order.symbol);
  const brokerLabel = order.brokerLabel || "키움 모의계좌";
  const currency = order.currency || (DOMESTIC_EXCHANGES.has(order.market) ? "KRW" : "USD");
  const fillPrice = Number(order.fillPrice);
  const filledValue = Number.isFinite(fillPrice) && fillPrice > 0 && order.filledQuantity > 0
    ? fillPrice * order.filledQuantity : null;
  const positionRatio = Number.isFinite(order.positionRatio) ? order.positionRatio : null;
  const plannedLine = Number.isFinite(order.plannedInvestment)
    ? `예상 투입 ${money(order.plannedInvestment, currency)}${Number.isFinite(order.projectedPositionRatio) ? ` · 주문 후 예상 계좌 비중 ${order.projectedPositionRatio.toFixed(2)}% / 최대 ${(order.positionLimitRatio ?? 0.2) * 100}%` : ""}`
    : null;
  const filledLine = filledValue
    ? `실제 투입 ${money(filledValue, currency)}${Number.isFinite(positionRatio) ? ` · 체결 후 계좌 비중 ${positionRatio.toFixed(2)}%` : ""}`
    : null;
  const statusReason = order.reason || order.expirationReason
    || (["REJECTED", "CANCELLED"].includes(order.status) ? order.rawStatus : "");
  return {
    channel: "system",
    embed: {
      color,
      title: `${icon} ${display(order.side)} · ${label}`,
      description: `**${identity}**`,
      fields: [
        { name: "수량", value: `주문 ${display(order.orderQuantity)}주 · 체결 ${display(order.filledQuantity)}주 · 잔량 ${display(order.remainingQuantity)}주` },
        ...(fillPrice > 0 ? [{ name: "체결가", value: money(fillPrice, currency), inline: true }] : []),
        ...(filledLine ? [{ name: "실제 투입·비중", value: filledLine, inline: false }] : plannedLine ? [{ name: "예상 투입·비중", value: plannedLine, inline: false }] : []),
        ...(statusReason ? [{ name: "사유", value: clip(statusReason, 1024) }] : []),
        { name: "주문번호", value: `끝 4자리 ${String(order.orderNo || "").slice(-4) || "-"}`, inline: true },
      ],
      footer: { text: brokerLabel },
      ...(order.resultAt || order.updatedAt ? { timestamp: order.resultAt || order.updatedAt } : {}),
    },
    text: [
      `${icon} **${brokerLabel} 주문 상태**`,
      `**종목**: ${identity} / ${display(order.side)}`,
      `**상태**: \`${display(order.status)}\``,
      `**수량**: 주문 ${display(order.orderQuantity)} / 체결 ${display(order.filledQuantity)} / 잔량 ${display(order.remainingQuantity)}`,
      fillPrice > 0 ? `**체결가**: ${money(fillPrice, currency)}` : null,
      filledLine ? `**실제 투입**: ${money(filledValue, currency)}${Number.isFinite(positionRatio) ? ` / **체결 후 계좌 비중**: ${positionRatio.toFixed(2)}%` : ""}` : null,
      !filledLine && plannedLine ? `**예상 투입**: ${money(order.plannedInvestment, currency)}${Number.isFinite(order.projectedPositionRatio) ? ` / **주문 후 예상 계좌 비중**: ${order.projectedPositionRatio.toFixed(2)}% / 최대 ${(order.positionLimitRatio ?? 0.2) * 100}%` : ""}` : null,
      statusReason ? `**사유**: ${statusReason}` : null,
      `**주문번호**: 끝 4자리 ${String(order.orderNo || "").slice(-4) || "-"}`,
    ].filter(Boolean).join("\n"),
  };
}

function formatTradeJournal(order) {
  const formatted = formatOrderStatus(order);
  const brokerLabel = order.brokerLabel || "키움 모의계좌";
  return {
    ...formatted,
    channel: "journal",
    text: formatted.text.replace(`${brokerLabel} 주문 상태`, `${brokerLabel} 매매 기록`),
    embed: {
      ...formatted.embed,
      color: 0x5865F2,
      title: `📘 ${display(order.side)} · 매매 기록`,
      footer: { text: `${brokerLabel} 체결 기준` },
    },
  };
}

function formatBuyApproval(record, approval, ttlMinutes) {
  const payload = record.payload || {};
  const earlyEntry = record.positionPreview?.earlyEntry === true;
  return {
    channel: "system",
    embed: {
      color: 0xFEE75C,
      title: `⏳ BUY 승인 대기 · ${display(payload.conviction)}`,
      description: `**${display(approval.name || approval.ticker)} (${display(approval.ticker)}) · ${display(payload.exchange)}**\n${signalPrice(payload.price, payload.exchange)} · SL ${signalPrice(payload.sl, payload.exchange)} · R/R ${display(payload.rr)}`,
      fields: [
        { name: "신호", value: clip(payload.type, 1024) },
        { name: "규모", value: earlyEntry ? "소액 진입 · 위험 0.25% · 종목 최대 10%" : "일반 진입 · 종목 총 최대 20%" },
        { name: "승인", value: `\`사줘 ${display(approval.ticker)}\` · ${display(ttlMinutes)}분 안에 입력` },
      ],
      footer: { text: "승인 전에는 주문이 생성되지 않습니다" },
      ...(record.receivedAt ? { timestamp: record.receivedAt } : {}),
    },
    text: `BUY 승인 대기 · ${display(approval.name || approval.ticker)} (${display(approval.ticker)})`,
  };
}

function formatDailyJournal(date, entries, brokerLabel = "키움 모의계좌") {
  return {
    channel: "system",
    embed: {
      color: 0x5865F2,
      title: `📘 ${date} 모의매매 일지`,
      description: clip(entries.join("\n") || "체결 내역 없음", 4096),
      footer: { text: `${brokerLabel} 체결 기준` },
    },
    text: `${date} 모의매매 일지`,
  };
}

function formatDeferredBuy(record, brokerLabel, environment = "mock") {
  const payload = record.payload || {};
  const market = payload.exchange === "KRX" ? "국내" : "미국";
  return {
    channel: "order",
    event: "DEFERRED_BUY",
    text: [
      `⏰ **${brokerLabel} ${market} ${environment === "live" ? "실계좌" : "모의"} 매수 예약**`,
      `**종목**: ${display(payload.name)} (${display(payload.ticker)})`,
      "프리장·장 종료 시간에는 주문하지 않고, 다음 정규장 또는 애프터장에 계좌를 다시 확인합니다.",
    ].join("\n"),
  };
}

function formatExecutorError(title, error, record) {
  const payload = record?.payload;
  return {
    channel: "system",
    event: "EXECUTOR_ERROR",
    text: [
      `🛑 **${title}**`,
      ...(payload ? [`**종목**: ${display(payload.name)} (${display(payload.ticker)})`] : []),
      `**사유**: ${display(error?.message || error)}`,
      ...(payload ? ["**주문**: 🔒 생성 안 됨"] : []),
    ].join("\n"),
  };
}

function formatUncreatedOrder(brokerLabel, record, { title, reason }) {
  const payload = record?.payload || {};
  const identity = payload.name ? `${payload.name} (${display(payload.ticker)})` : display(payload.ticker);
  return {
    channel: "execution",
    event: "ORDER_NOT_CREATED",
    embed: {
      color: 0xED4245,
      title: `🛑 ${brokerLabel} ${title}`,
      description: `**${identity}**`,
      fields: [
        { name: "구분", value: display(payload.action), inline: true },
        { name: "사유", value: clip(reason, 1024) },
      ],
      footer: { text: "주문 생성 안 됨" },
      ...(record?.receivedAt ? { timestamp: record.receivedAt } : {}),
    },
    text: `${brokerLabel} ${title} · ${identity} · ${reason}`,
  };
}

function formatBrokerStartup(service, botTag, detail, safety = "실계좌 차단") {
  return `✅ ${service} 연결 · ${botTag}\n${detail} · ${safety}`;
}

module.exports = {
  formatBrokerStartup,
  formatBuyApproval,
  formatDailyJournal,
  formatDeferredBuy,
  formatExecutorError,
  formatUncreatedOrder,
  formatOrderStatus,
  formatTradeJournal,
  formatWebhookRecord,
  positionPreviewLines,
  targetSignalChannel,
  targetSignalChannels,
};
