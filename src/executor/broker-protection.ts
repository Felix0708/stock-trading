"use strict";
const { randomUUID } = require("node:crypto");
const { managedPosition, sameInstrument } = require("../trading/position-ownership");
const { koreanDate, executionDateMatches } = require("./account-evidence");
const TERMINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED"]);
const brokerStop = order => order.orderStyle === "BROKER_STOP";
const keyFor = (broker, payload) => `${broker.id}:${broker.environment}:${payload.exchange}:${payload.ticker}`;
const numberKey = value => String(value).replace(/^0+/, "");

function protectionReadiness(broker, market) {
  if (broker.id !== "KIWOOM" || !["NASDAQ", "NYSE", "AMEX"].includes(market)) return "이 증권사·시장에는 검증된 STOP API 연계가 없습니다.";
  if (!broker.protectionEnabled) return "증권사 STOP 연계가 꺼져 있습니다. 접수·조회·취소 검증 후 활성화가 필요합니다.";
  return "";
}

function protectionIntent(receipts, broker, payload) {
  return receipts.state.protection?.[keyFor(broker, payload)];
}

function saveIntent(receipts, broker, payload, value) {
  if (!receipts.file) throw Error("보호주문에는 영구 수신 기록 파일이 필요합니다.");
  receipts.state.protection ||= {};
  receipts.state.protection[keyFor(broker, payload)] = value;
  receipts.write();
  return value;
}

function currentProtection(broker, receipts, payload) {
  const intent = protectionIntent(receipts, broker, payload);
  const order = intent && broker.tracker.list().find(o => o.requestId === intent.requestId && brokerStop(o));
  if (order && intent.status !== "ACCEPTED") saveIntent(receipts, broker, payload, { ...intent, status: "ACCEPTED", orderNo: order.orderNo });
  if (intent && !order && ["SUBMITTING", "UNKNOWN"].includes(intent.status)) throw Error("STOP 접수 여부 불명 · 증권사 확인 전 재주문/일반 주문 차단");
  const active = broker.tracker.list().filter(o => brokerStop(o) && sameInstrument(o, payload) && o.environment === broker.environment && !TERMINAL.has(o.status));
  if (active.length > 1) throw Error("같은 종목의 보호주문 여러 건 · 취소/수량 대조 필요");
  return active[0] || order;
}

async function refreshProtection(broker, order) {
  if (!order || TERMINAL.has(order.status)) return order;
  const sameDay = koreanDate(order.createdAt, "America/New_York") === koreanDate(new Date(), "America/New_York");
  let rows;
  if (sameDay) rows = await broker.overseasClient.getUsOrderExecutions({ exchange: order.exchange, symbol: order.symbol });
  else rows = await broker.overseasClient.getUsHistoricalExecutions({ date: koreanDate(order.createdAt, "America/New_York"), exchange: order.exchange, symbol: order.symbol });
  const matches = rows.filter(r => numberKey(r.orderNo) === numberKey(order.orderNo) && r.symbol === order.symbol && r.side === "SELL");
  if (matches.length !== 1) throw Error("보호주문 상태 조회 미확인 · 만료나 취소로 추정하지 않습니다.");
  const row = matches[0];
  if (!executionDateMatches(order, { ...row, date: koreanDate(order.createdAt, "America/New_York"), source: "KIWOOM:ust21150:protection" })) throw Error("STOP 주문 시각 대조 실패");
  if (row.orderQuantity !== order.orderQuantity || !Number.isInteger(row.filledQuantity) || row.filledQuantity < order.filledQuantity
    || !Number.isInteger(row.remainingQuantity) || row.remainingQuantity < 0 || row.filledQuantity + row.remainingQuantity > row.orderQuantity
    || (row.filledQuantity > 0 && !(row.fillPrice > 0)) || row.brokerOrderType !== "35") throw Error("STOP 주문 유형·수량·체결 증빙 불일치");
  const status = row.status || (row.rawStatus?.includes("거부") ? "REJECTED" : row.rawStatus?.includes("취소") ? "CANCELLED"
    : row.filledQuantity === row.orderQuantity ? "FILLED" : row.remainingQuantity === 0 ? "CANCELLED" : row.filledQuantity > 0 ? "PARTIALLY_FILLED" : "ACCEPTED");
  if ((status === "FILLED" && (row.filledQuantity !== row.orderQuantity || row.remainingQuantity !== 0))
    || (status === "CANCELLED" && (row.remainingQuantity !== 0 || !/취소/.test(row.rawStatus || "") || /접수|요청|대기/.test(row.rawStatus)))
    || (status === "REJECTED" && (row.filledQuantity !== 0 || !/거부|거절/.test(row.rawStatus || "")))) throw Error("STOP 종료 증빙 미확인 · 취소 접수를 완료로 간주하지 않습니다.");
  if (!sameDay && !TERMINAL.has(status)) throw Error("지난 거래일 STOP 유효기간 미확인 · 재등록 보류");
  if (!TERMINAL.has(status) && (!Number.isFinite(row.brokerStopPrice) || Math.abs(row.brokerStopPrice - order.stopPrice) > 0.00001)) throw Error("STOP 발동가격 대조 실패");
  return broker.tracker.record({ ...order, status, rawStatus: row.rawStatus, filledQuantity: row.filledQuantity, remainingQuantity: row.remainingQuantity, fillPrice: row.fillPrice,
    protectionVerifiedAt: new Date().toISOString(), ...(sameDay ? {} : { reconciliationEvidence: { source: row.source }, evidenceFilledAt: null }) });
}

async function releaseProtection(broker, receipts, payload, canSubmit) {
  let order = currentProtection(broker, receipts, payload);
  if (!order || TERMINAL.has(order.status)) return true;
  order = await refreshProtection(broker, order);
  if (TERMINAL.has(order.status)) return true;
  if (!canSubmit()) return false;
  if (order.cancelSubmitted) return false; // Lost cancel acknowledgement is reconciled, never assumed successful.
  broker.tracker.record({ ...order, cancelSubmitted: true, status: "CANCEL_REQUESTED" });
  try {
    const result = await broker.overseasClient.cancelUsOrder({ orderNo: order.orderNo, exchange: order.exchange, symbol: order.symbol, quantity: order.remainingQuantity, canSubmit });
    order = broker.tracker.record({ ...order, ...result, orderNo: order.orderNo, status: "CANCEL_REQUESTED", cancelSubmitted: true });
  } catch (error) {
    broker.tracker.record({ ...order, cancelSubmitted: error.orderStatusUnknown === true, status: "CANCEL_REQUESTED" });
    throw error;
  }
  order = await refreshProtection(broker, order);
  return TERMINAL.has(order.status); // Cancel acceptance is not cancel completion.
}

async function ensureProtection(broker, receipts, payload, canSubmit) {
  const reason = protectionReadiness(broker, payload.exchange);
  if (reason) return { status: "UNPROTECTED", reason };
  let order = currentProtection(broker, receipts, payload);
  if (order && !TERMINAL.has(order.status)) order = await refreshProtection(broker, order);
  const owned = managedPosition(broker.tracker.list(), payload, broker.environment);
  const wantedStop = owned.stopPrice < 1 ? Number(owned.stopPrice.toFixed(4)) : Number(owned.stopPrice.toFixed(2));
  if (order && !TERMINAL.has(order.status)) {
    if (!order.cancelSubmitted && order.remainingQuantity === owned.quantity && order.stopPrice === wantedStop && order.protectionEntryId === owned.entryRequestId) {
      return { status: "PROTECTED", order }; // Broker-confirmed, only for the current observed session.
    }
    if (!await releaseProtection(broker, receipts, payload, canSubmit)) return { status: "CANCEL_PENDING" };
    return { status: "RESIZE_PENDING" }; // Re-read balances and ownership next pass, after cancellation settles.
  }
  if (!owned.quantity) return { status: "NO_POSITION" };
  if (receipts.listDeferred().some(item => item.brokerId === broker.id && item.expiresAt > Date.now()
    && sameInstrument({ symbol: item.record.payload.ticker, market: item.record.payload.exchange }, payload)
    && (item.record.payload.action === "SELL" || item.record.risk?.verdict === "PAPER_ADD"))) return { status: "ORDER_PENDING" };
  const previousIntent = protectionIntent(receipts, broker, payload);
  if (previousIntent?.status === "REJECTED" && Date.now() - Date.parse(previousIntent.createdAt) < 3600_000) return { status: "REJECTED_COOLDOWN" };
  if (!owned.entryRequestId || !owned.timeframe || !(wantedStop > 0)) throw Error("보호 대상 진입·시간봉·손절가 증빙 없음");
  if (broker.tracker.pending().some(o => !brokerStop(o) && sameInstrument(o, payload)
    && !(o.side === "BUY" && ["ACCEPTED", "PARTIALLY_FILLED"].includes(o.status)))) return { status: "ORDER_PENDING" };
  if (!canSubmit()) return { status: "PAUSED" };
  const exchange = ({ NASDAQ: "ND", NYSE: "NY", AMEX: "NA" })[payload.exchange];
  const balances = broker.overseasClient.getUsBalances ? await broker.overseasClient.getUsBalances() : [await broker.overseasClient.getUsBalance()];
  const holdings = balances.flatMap(b => b.holdings).filter(h => h.code === payload.ticker);
  const holding = holdings[0];
  if (holdings.length !== 1 || !Number.isInteger(holding.quantity) || holding.quantity < owned.quantity
    || !Number.isInteger(holding.tradableQuantity) || holding.tradableQuantity < owned.quantity) throw Error("보호주문 수량과 실제 매도가능 잔고 대조 필요");
  const quote = await broker.overseasClient.getUsQuote({ exchange, symbol: payload.ticker });
  if (!Number.isFinite(quote.currentPrice) || quote.currentPrice <= wantedStop) throw Error("이미 손절가 이하 또는 시세 미확인 · STOP을 즉시 체결되는 주문으로 바꾸지 않습니다.");
  if (!canSubmit()) return { status: "PAUSED" };
  const intent = { requestId: `protect-${randomUUID()}`, status: "SUBMITTING", quantity: owned.quantity, stopPrice: wantedStop,
    entryRequestId: owned.entryRequestId, createdAt: new Date().toISOString() };
  saveIntent(receipts, broker, payload, intent); // Durable intent before broker submission.
  let accepted;
  try {
    accepted = await broker.overseasClient.placeUsStopOrder({ exchange, symbol: payload.ticker, quantity: owned.quantity, stopPrice: wantedStop, canSubmit });
    order = broker.tracker.record({ ...accepted, requestId: intent.requestId, orderStyle: "BROKER_STOP", orderStrategy: "증권사 STOP 시장가 · 가격 보장 없음 · 유효기간 조회 필요",
      environment: broker.environment, brokerLabel: `${broker.label || broker.id} ${broker.environment === "live" ? "실계좌" : "모의계좌"}`, source: "BROKER_PROTECTION", executorReportable: true, market: payload.exchange, exchange,
      name: payload.name, koreanName: payload.koreanName, timeframe: owned.timeframe, createdAt: intent.createdAt, fullExit: true,
      protectionEntryId: owned.entryRequestId, orderQuantity: owned.quantity, filledQuantity: 0, remainingQuantity: owned.quantity, stopPrice: wantedStop });
  } catch (error) {
    // A saved real order survives receipt-write failure; an unsaved response is treated as unknown.
    saveIntent(receipts, broker, payload, { ...intent, status: accepted || error.orderStatusUnknown ? "UNKNOWN" : "REJECTED" });
    throw error;
  }
  saveIntent(receipts, broker, payload, { ...intent, status: "ACCEPTED", orderNo: order.orderNo });
  return { status: "ACCEPTED_UNVERIFIED", order: await refreshProtection(broker, order) };
}

module.exports = { brokerStop, protectionReadiness, protectionIntent, currentProtection, refreshProtection, releaseProtection, ensureProtection };
