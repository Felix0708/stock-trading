"use strict";

function normalizedSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "");
}

function positionMarket(value) {
  return ["KRX", "KOSPI", "KOSDAQ"].includes(String(value || "").toUpperCase()) ? "KRX" : "US";
}

function normalizedTimeframe(value) {
  const frame = String(value || "").trim().toUpperCase();
  if (["D", "1D", "DAY", "1DAY"].includes(frame)) return "1D";
  if (["240", "4H", "4HR"].includes(frame)) return "240";
  return "";
}

function orderTime(order) {
  const time = Date.parse(order.createdAt || order.resultAt || order.updatedAt || "");
  return Number.isFinite(time) ? time : Number(order.revision || 0);
}

function sameInstrument(order, payload) {
  return normalizedSymbol(order.symbol) === normalizedSymbol(payload.ticker)
    && positionMarket(order.market) === positionMarket(payload.exchange);
}

function sameTimeframe(left, right) {
  const frame = normalizedTimeframe(left);
  return Boolean(frame) && frame === normalizedTimeframe(right);
}

function emergencyExit(record) {
  return record.payload?.action === "SELL" && record.outcome?.signal?.signalCode === "EXIT_CRASH";
}

// ponytail: one strategy owns each broker/symbol; separate lots only if concurrent strategies are introduced.
function managedPosition(orders, payload, environment = "mock") {
  let position = { quantity: 0, timeframe: "", entryAt: 0, entryRequestId: "", stopPrice: 0, averagePrice: 0 };
  const relevant = orders.filter(order => sameInstrument(order, payload) && (order.environment || "mock") === environment)
    .sort((a, b) => orderTime(a) - orderTime(b));
  for (const order of relevant) {
    const quantity = Number(order.filledQuantity || 0);
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    if ((order.side === "BUY" || !order.side) && ["PAPER_ENTRY", "PAPER_ADD"].includes(order.entryType)) {
      if (!position.quantity) position = { quantity: 0, timeframe: normalizedTimeframe(order.timeframe),
        entryAt: orderTime(order), entryRequestId: order.requestId || "", stopPrice: 0, averagePrice: 0 };
      else if (!sameTimeframe(position.timeframe, order.timeframe)) position.timeframe = "";
      const price = Number(order.fillPrice);
      position.averagePrice = price > 0 && (position.quantity === 0 || position.averagePrice > 0)
        ? (position.quantity * position.averagePrice + quantity * price) / (position.quantity + quantity) : 0;
      position.quantity += quantity;
      // Keep the entry stop unless a later valid add tightens it. This is a risk reference, not a broker stop order.
      if (Number(order.stopPrice) > 0) position.stopPrice = Math.max(position.stopPrice, Number(order.stopPrice));
    } else if (order.side === "SELL" || (!order.side && order.fullExit)) {
      position.quantity = Math.max(0, position.quantity - quantity);
    }
  }
  return position;
}

function scopePositionPreview(record, preview, orders, environment) {
  if (!preview || preview.blocked) return preview;
  const existingRequired = record.payload?.action === "SELL" || record.risk?.verdict === "PAPER_ADD";
  if (!existingRequired && record.risk?.verdict !== "PAPER_ENTRY") return preview;
  const position = managedPosition(orders, record.payload, environment);
  const scoped = { ...preview, managedQuantity: position.quantity, entryTimeframe: position.timeframe,
    managedEntryRequestId: position.entryRequestId };
  if (!position.quantity) return existingRequired
    ? { ...scoped, blocked: true, quantity: 0, skipStatus: "SKIPPED_UNMANAGED_POSITION", reason: "자동매매 관리 보유분 없음 · 수동 보유분 보호" } : preview;
  if (!Number.isInteger(preview.currentPositionQuantity) || Number(preview.currentPositionQuantity) < position.quantity) {
    return { ...scoped, blocked: true, quantity: 0, reason: "자동매매 기록보다 실제 보유량이 적음 · 수동 매매/잔고 대조 필요" };
  }
  if (!existingRequired) return { ...scoped, blocked: true, quantity: 0, reason: "자동매매 관리 보유분 존재 · 중복 진입 차단" };
  if (!emergencyExit(record) && !position.timeframe) {
    return { ...scoped, blocked: true, quantity: 0, reason: "진입 시간봉 기록 없음 또는 혼합 · 원본 대조 필요" };
  }
  if (!emergencyExit(record) && !sameTimeframe(position.timeframe, record.payload.timeframe)) {
    return { ...scoped, blocked: true, quantity: 0, skipStatus: "SKIPPED_TIMEFRAME", reason: "진입 기준 시간봉과 다른 신호 · 주문 없음" };
  }
  const receivedAt = Date.parse(record.receivedAt || "");
  if (Number.isFinite(receivedAt) && receivedAt < position.entryAt) {
    return { ...scoped, blocked: true, quantity: 0, skipStatus: "SKIPPED_OLD_POSITION_SIGNAL", reason: "현재 포지션 진입 이전 신호 · 주문 없음" };
  }
  if (record.payload.action !== "SELL") return scoped;
  return { ...scoped, quantity: position.quantity,
    currentPositionQuantity: position.quantity,
    averageEntryPrice: position.averagePrice || preview.averageEntryPrice,
    currentHoldings: (preview.currentHoldings || []).map(holding => ({ ...holding,
      quantity: position.quantity, tradableQuantity: Math.min(position.quantity, Number(holding.tradableQuantity ?? holding.quantity)) })) };
}

function restoreOrderSignalMetadata(orders, records) {
  const byRequest = new Map(records.map(record => [record.requestId, record]));
  return orders.flatMap(order => {
    if (!order.requestId) return [];
    const record: any = byRequest.get(order.requestId);
    if (!record?.validation?.ok || !sameInstrument(order, record.payload) || order.side !== record.payload.action
      || !normalizedTimeframe(record.payload.timeframe) || !Number.isFinite(Date.parse(record.receivedAt))) return [];
    const entryType = record.outcome?.decision === "ENTRY_CANDIDATE" ? "PAPER_ENTRY"
      : record.outcome?.decision === "ADD_CANDIDATE" ? "PAPER_ADD" : null;
    const metadata = { timeframe: order.timeframe || normalizedTimeframe(record.payload.timeframe),
      createdAt: order.createdAt || record.receivedAt,
      ...((!order.timeframe || !order.createdAt) && ["FILLED", "CANCELLED", "EXPIRED", "REJECTED"].includes(order.status) && !order.resultAt && order.updatedAt
        ? { resultAt: order.updatedAt } : {}),
      ...(!order.signalCode && record.outcome?.signal?.signalCode ? { signalCode: record.outcome.signal.signalCode } : {}),
      ...(!Number.isFinite(order.sizingContext?.sigmaZ) && Number.isFinite(record.payload.sb_z_score)
        ? { sizingContext: { ...order.sizingContext, sigmaZ: record.payload.sb_z_score } } : {}),
      ...(order.side === "BUY" && entryType ? { entryType: order.entryType || entryType } : {}) };
    return Object.entries(metadata).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(order[key])) ? [{ ...order, ...metadata }] : [];
  });
}

module.exports = { normalizedSymbol, normalizedTimeframe, positionMarket, orderTime, sameInstrument,
  sameTimeframe, emergencyExit, managedPosition, scopePositionPreview, restoreOrderSignalMetadata };
