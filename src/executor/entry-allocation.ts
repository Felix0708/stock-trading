"use strict";

const { normalizedSymbol, normalizedTimeframe, managedPosition } = require("../trading/position-ownership");
const pending = new Set(["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN"]);
const market = value => ["KRX", "KOSPI", "KOSDAQ"].includes(String(value).toUpperCase()) ? "KRX" : "US";
const symbolKey = payload => `${market(payload.exchange)}:${normalizedSymbol(payload.ticker)}`;
const frameMs = value => normalizedTimeframe(value) === "1D" ? 86400000 : normalizedTimeframe(value) === "240" ? 14400000 : Infinity;
const same = (order, payload) => symbolKey({ exchange: order.market, ticker: order.symbol }) === symbolKey(payload);
const blocked = reason => ({ blocked: true, quantity: 0, reason });
const verificationWait = (reason, order?) => ({ ...blocked(reason), retryable: true,
  reasonCode: "ORDER_VERIFICATION_PENDING", blockingSymbol: order?.symbol || null });

function uncertainBuyReserve(order, broker, payload) {
  if (broker.environment !== "mock" || order.environment !== "mock" || same(order, payload)
    || market(order.market) !== market(payload.exchange) || order.side !== "BUY"
    || !["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(order.status)
    || !order.orderNo || order.activeOrderNo || order.retrySubmissionPending || order.priorFilledQuantity
    || order.orderStyle === "BROKER_STOP" || order.marketFallbackAllowed
    || ![order.orderQuantity, order.filledQuantity, order.remainingQuantity].every(Number.isInteger)
    || order.filledQuantity < 0 || order.remainingQuantity <= 0
    || order.orderQuantity !== order.filledQuantity + order.remainingQuantity
    || ![order.limitPrice, order.stopPrice, order.plannedInvestment, order.plannedRisk].every(v => Number.isFinite(v) && v > 0)
    || order.stopPrice >= order.limitPrice) return null;
  return { cash: order.remainingQuantity * order.limitPrice,
    risk: Math.max(order.plannedRisk * order.remainingQuantity / order.orderQuantity,
      order.remainingQuantity * (order.limitPrice - order.stopPrice)) };
}

function allocatedBuy(record) {
  return record.payload?.action === "BUY" && record.payload?.paper_order_test !== true
    && ["PAPER_ENTRY", "PAPER_ADD", "BUY_PENDING_APPROVAL"].includes(record.risk?.verdict);
}

// One owner/runtime only. KRW and USD market budgets are never added together.
function allocationRisk(record, snapshots, receipts) {
  const p = record.payload, at = Date.parse(record.receivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(frameMs(p.timeframe))) return blocked("계좌 배정 기준 확인 필요");
  let equity = 0, exposure = 0, risk = 0;
  const reservedCash = {}, reservedPositions = {};
  for (const { broker, account } of snapshots) {
    if (!(Number.isFinite(account.equity) && account.equity > 0)) return blocked("합산 계좌 자산 확인 필요");
    equity += account.equity;
    const orders = broker.tracker.list();
    if (orders.some(o => o.status === "UNKNOWN")
      || Object.entries(receipts.state.attempts).some(([key, a]: [string, any]) => key.startsWith(`${broker.id}:`) && ["UNKNOWN", "SUBMITTING"].includes(a.status))) {
      return verificationWait("다른 계좌 포함 주문 접수 여부 확인 필요 · 매수 우회 금지", orders.find(o => o.status === "UNKNOWN"));
    }
    const reserves = new Map();
    for (const order of orders.filter(o => o.reconciliationRequired)) {
      const reserve = uncertainBuyReserve(order, broker, p);
      if (!reserve) return verificationWait(`${order.symbol} 주문 종료·최대 위험 확인 필요 · 매수 대기`, order);
      reserves.set(order, reserve);
      reservedCash[broker.id] = (reservedCash[broker.id] || 0) + reserve.cash;
    }
    const holdings = market(p.exchange) === "KRX" ? account.domesticHoldings : account.usHoldings;
    reservedPositions[broker.id] = new Set([...reserves.keys()].filter(o => !holdings.some(h => normalizedSymbol(h.code) === normalizedSymbol(o.symbol) && h.quantity > 0)).map(o => normalizedSymbol(o.symbol))).size;
    for (const ticker of new Set(orders.filter(o => market(o.market) === market(p.exchange)).map(o => normalizedSymbol(o.symbol)))) {
      const owned = managedPosition(orders, { exchange: p.exchange, ticker }, broker.environment);
      const quantity = holdings.filter(h => normalizedSymbol(h.code) === ticker).reduce((n, h) => n + h.quantity, 0);
      if (owned.quantity !== quantity) return verificationWait("자동매매 기록과 실제 잔고 수량 불일치 · 합산 위험 확인 필요");
    }
    for (const h of holdings) {
      if (!(h.quantity > 0)) continue;
      const owned = managedPosition(orders, { exchange: p.exchange, ticker: h.code }, broker.environment);
      if (!(owned.quantity === h.quantity && owned.stopPrice > 0 && owned.averagePrice > 0 && h.evaluationAmount > 0)) return verificationWait("보유분 수량·손절 기준 미확인 · 합산 위험 확인 필요");
      const current = normalizedSymbol(h.code) === normalizedSymbol(p.ticker);
      const price = h.evaluationAmount / h.quantity;
      if (price <= owned.stopPrice || (current && p.price <= owned.stopPrice)) return blocked("기존 보유분 손절 이탈 · 다른 계좌 매수 우회 금지");
      risk += h.quantity * Math.max(price - owned.stopPrice, owned.averagePrice - owned.stopPrice, 0);
      if (current) {
        exposure += h.evaluationAmount;
        const exitPrefix = `${broker.id}:`;
        const exitPending = Object.entries(receipts.state.exits).some(([key, time]) => {
          const [id, exchange, ticker, frame] = key.split(":");
          return key.startsWith(exitPrefix) && symbolKey({ exchange, ticker }) === symbolKey(p)
            && (!frame || frame === "ALL" || normalizedTimeframe(frame) === owned.timeframe) && Number(time) >= owned.entryAt;
        });
        if (exitPending) return blocked("기존 보유분 청산 신호 처리 확인 필요 · 재진입 보류");
        if (record.outcome?.decision !== "ADD_CANDIDATE" && at - owned.entryAt < Math.max(frameMs(p.timeframe), frameMs(owned.timeframe))) return blocked("별도 재진입은 기존 진입 후 최소 한 봉 간격 필요");
      }
    }
    for (const o of orders.filter(o => pending.has(o.status) && market(o.market) === market(p.exchange))) {
      if (same(o, p) && !(o.orderStyle === "BROKER_STOP" && o.status === "ACCEPTED" && !o.cancelSubmitted)) return verificationWait("동일 종목 미체결 주문 확인 중 · 계좌 간 중복 매수 방지", o);
      if (o.side !== "BUY") continue;
      if (!(o.orderQuantity > 0 && Number.isFinite(o.remainingQuantity) && o.remainingQuantity >= 0 && o.plannedInvestment > 0 && o.plannedRisk > 0)) return blocked("미체결 매수의 금액·손절 위험 확인 필요");
      risk += reserves.get(o)?.risk ?? o.plannedRisk * o.remainingQuantity / o.orderQuantity;
    }
  }
  const waiting = [...receipts.listDeferred(), ...Object.values(receipts.state.pending) as any[]];
  if (waiting.some(item => item.record?.requestId !== record.requestId && item.expiresAt > Date.now()
    && item.record?.payload?.action === "BUY" && symbolKey(item.record.payload) === symbolKey(p))) return blocked("동일 종목의 기존 예약·승인 대기 먼저 처리");
  return { blocked: false, equity, exposure, risk, reservedCash, reservedPositions };
}

function chooseAccount(record, snapshots, routes) {
  const at = Date.parse(record.receivedAt), key = symbolKey(record.payload);
  const previous = Object.values(routes).filter((r: any) => r.symbol === key && r.brokerId && r.requestId !== record.requestId) as any[];
  if (record.outcome?.decision !== "ADD_CANDIDATE" && previous.some(r => at - r.at < Math.max(frameMs(record.payload.timeframe), frameMs(r.timeframe)))) return { brokerId: "", reason: "같은 구간의 진입 신호 · 최소 한 봉 간격 후 새 신호 필요" };
  const candidates = snapshots.filter(s => !s.preview?.blocked && s.preview?.quantity > 0);
  candidates.sort((a, b) => b.account.availableCash / b.account.equity - a.account.availableCash / a.account.equity
    || a.account.openPositions - b.account.openPositions || a.broker.id.localeCompare(b.broker.id));
  const selected = candidates[0];
  return { brokerId: selected?.broker.id || "", reason: selected ? `단일 계좌 배정: ${selected.broker.label} · 현금 여유 비율 우선`
    : `진입 가능 계좌 없음 · ${snapshots.map(s => `${s.broker.label}: ${s.preview?.reason || "수량 없음"}`).join(" / ")}` };
}

function capAllocatedPreview(preview, totals, cashReservation = { cash: 0, availableCash: 0 }) {
  if (totals.blocked) return { ...preview, ...totals };
  if (!preview || preview.blocked) return preview;
  const perShareRisk = preview.entryPrice - preview.stopPrice;
  if (preview.capitalOnly || !(preview.stopPrice > 0 && perShareRisk > 0)) return { ...preview, ...blocked("유효한 손절가 없어 합산 매수 위험 계산 불가") };
  // ponytail: broker orderable cash may already exclude this commitment. Subtracting again
  // is deliberately conservative until the API proves its cash-reservation scope.
  const cashCap = cashReservation.cash > 0
    ? Number.isFinite(cashReservation.availableCash) ? Math.max(0, Math.floor((cashReservation.availableCash - cashReservation.cash) / preview.entryPrice)) : 0
    : Infinity;
  const quantity = Math.max(0, Math.min(preview.quantity, cashCap,
    Math.floor((totals.equity * preview.positionLimitRatio - totals.exposure) / preview.entryPrice)));
  if (!quantity && cashReservation.cash > 0) return { ...preview, ...verificationWait("미확인 주문 최대 자금 확보 후 매수 가능 수량 없음") };
  if (!quantity) return { ...preview, ...blocked("소유자 합산 종목 비중 한도 초과") };
  return { ...preview, quantity, positionValue: quantity * preview.entryPrice, stopLossAmount: quantity * perShareRisk,
    projectedPositionValue: (preview.currentPositionValue || 0) + quantity * preview.entryPrice,
    projectedPositionRatio: ((preview.currentPositionValue || 0) + quantity * preview.entryPrice) / preview.equity * 100,
    allocationSummary: `${Object.keys(totals.reservedCash || {}).length ? "미확인 주문 최대 자금·위험 확보 · " : ""}합산 종목 비중 ${((totals.exposure + quantity * preview.entryPrice) / totals.equity * 100).toFixed(1)}% · 참고용 합산 손절위험 ${((totals.risk + quantity * perShareRisk) / totals.equity * 100).toFixed(2)}% (별도 차단 한도 없음)` };
}

module.exports = { allocatedBuy, allocationRisk, chooseAccount, capAllocatedPreview, symbolKey };
