"use strict";

const { formatInstrumentLabel } = require("../research/instrument-names");

const DOMESTIC_EXCHANGES = new Set(["KRX", "KOSPI", "KOSDAQ"]);
const ORDER_STATUS = {
  ACCEPTED: ["📨", "접수", 0x5865F2],
  PARTIALLY_FILLED: ["⏳", "부분 체결", 0xFEE75C],
  FILLED: ["✅", "체결 완료", 0x57F287],
  CANCEL_REQUESTED: ["🧹", "취소 요청", 0xFEE75C],
  CANCELLED: ["🚫", "취소", 0xED4245],
  REJECTED: ["🛑", "거절", 0xED4245],
};

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

function formatOrderStatus(order) {
  const [icon, label, color] = ORDER_STATUS[order.status] || ["ℹ️", display(order.status), 0x5865F2];
  const identity = formatInstrumentLabel({ ...order, ticker: order.symbol });
  const brokerLabel = order.brokerLabel || "키움 모의계좌";
  const currency = order.currency || (DOMESTIC_EXCHANGES.has(order.market) ? "KRW" : "USD");
  const fillPrice = Number(order.fillPrice);
  const filledValue = Number.isFinite(fillPrice) && fillPrice > 0 && order.filledQuantity > 0
    ? fillPrice * order.filledQuantity : null;
  const positionRatio = Number.isFinite(order.positionRatio) ? order.positionRatio : null;
  const plannedRatioLabel = Number.isFinite(order.autoCapital) ? "자동운용금 비중" : "계좌 비중";
  const limitPrice = order.side === "BUY" && Number.isFinite(order.limitPrice) ? order.limitPrice : null;
  const plannedLine = Number.isFinite(order.plannedInvestment)
    ? `예상 투입 ${money(order.plannedInvestment, currency)}${Number.isFinite(order.projectedPositionRatio) ? ` · 주문 후 예상 ${plannedRatioLabel} ${order.projectedPositionRatio.toFixed(2)}% / 최대 ${(order.positionLimitRatio ?? 0.2) * 100}%` : ""}`
    : null;
  const filledLine = filledValue
    ? `실제 투입 ${money(filledValue, currency)}${Number.isFinite(positionRatio) ? ` · 체결 후 계좌 비중 ${positionRatio.toFixed(2)}%` : ""}`
    : null;
  const statusReason = order.reason || order.expirationReason
    || (["REJECTED", "CANCELLED"].includes(order.status) ? order.rawStatus : "");
  const pyramidLine = order.pyramidStage
    ? `피라미딩 ${order.pyramidStage}차 · 최초 진입 ${order.initialEntryQuantity}주의 ${order.pyramidRatio * 100}%`
    : null;
  return {
    channel: "system",
    embed: {
      color,
      title: `${icon} ${display(order.side)} · ${label}`,
      description: `**${identity}**`,
      fields: [
        { name: "수량", value: `주문 ${display(order.orderQuantity)}주 · 체결 ${display(order.filledQuantity)}주 · 잔량 ${display(order.remainingQuantity)}주` },
        ...(pyramidLine ? [{ name: "피라미딩", value: pyramidLine }] : []),
        ...(order.orderStrategy ? [{ name: "주문 방식", value: clip(order.orderStrategy, 1024) }] : []),
        ...(limitPrice ? [{ name: "매수 상한가", value: money(limitPrice, currency), inline: true }] : []),
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
      pyramidLine ? `**피라미딩**: ${pyramidLine}` : null,
      order.orderStrategy ? `**주문 방식**: ${order.orderStrategy}` : null,
      limitPrice ? `**매수 상한가**: ${money(limitPrice, currency)}` : null,
      fillPrice > 0 ? `**체결가**: ${money(fillPrice, currency)}` : null,
      filledLine ? `**실제 투입**: ${money(filledValue, currency)}${Number.isFinite(positionRatio) ? ` / **체결 후 계좌 비중**: ${positionRatio.toFixed(2)}%` : ""}` : null,
      !filledLine && plannedLine ? `**예상 투입**: ${money(order.plannedInvestment, currency)}${Number.isFinite(order.projectedPositionRatio) ? ` / **주문 후 예상 ${plannedRatioLabel}**: ${order.projectedPositionRatio.toFixed(2)}% / 최대 ${(order.positionLimitRatio ?? 0.2) * 100}%` : ""}` : null,
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
  const identity = formatInstrumentLabel({ ...payload, ...approval });
  return {
    channel: "system",
    embed: {
      color: 0xFEE75C,
      title: `⏳ BUY 승인 대기 · ${display(payload.conviction)}`,
      description: `**${identity} · ${display(payload.exchange)}**\n${signalPrice(payload.price, payload.exchange)} · SL ${signalPrice(payload.sl, payload.exchange)} · R/R ${display(payload.rr)}`,
      fields: [
        { name: "신호", value: clip(payload.type, 1024) },
        { name: "규모", value: earlyEntry ? "소액 진입 · 위험 0.25% · 종목 최대 10%" : "일반 진입 · 종목 총 최대 20%" },
        { name: "승인", value: `\`사줘 ${display(approval.ticker)}\` · ${display(ttlMinutes)}분 안에 입력` },
      ],
      footer: { text: "승인 전에는 주문이 생성되지 않습니다" },
      ...(record.receivedAt ? { timestamp: record.receivedAt } : {}),
    },
    text: `BUY 승인 대기 · ${identity}`,
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

function formatDeferredOrder(record, brokerLabel, environment = "mock") {
  const payload = record.payload || {};
  const market = payload.exchange === "KRX" ? "국내" : "미국";
  const action = payload.action === "SELL" ? "매도" : "매수";
  return {
    channel: "order",
    event: action === "매도" ? "DEFERRED_SELL" : "DEFERRED_BUY",
    text: [
      `⏰ **${brokerLabel} ${market} ${environment === "live" ? "실계좌" : "모의"} ${action} 예약**`,
      `**종목**: ${formatInstrumentLabel(payload)}`,
      `${action === "매수" ? "주문 가능 시간" : "매도 가능 시간"}에 현재가와 계좌 보유·주문 가능 수량을 다시 확인한 뒤 자동으로 재시도합니다.`,
    ].join("\n"),
  };
}

function formatExecutorError(title, error, record = null) {
  const payload = record?.payload;
  return {
    channel: "system",
    event: "EXECUTOR_ERROR",
    text: [
      `🛑 **${title}**`,
      ...(payload ? [`**종목**: ${formatInstrumentLabel(payload)}`] : []),
      `**사유**: ${display(error?.message || error)}`,
      ...(payload ? ["**주문**: 🔒 생성 안 됨"] : []),
    ].join("\n"),
  };
}

function formatUncreatedOrder(brokerLabel, record, { title, reason }) {
  const payload = record?.payload || {};
  const identity = formatInstrumentLabel(payload);
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
  formatDeferredOrder,
  formatExecutorError,
  formatOrderStatus,
  formatTradeJournal,
  formatUncreatedOrder,
};
