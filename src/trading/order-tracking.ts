"use strict";

const { setTimeout: delay } = require("node:timers/promises");

type Order = { orderNo: string | number; status: string; market: string; symbol: string; exchange?: string; side?: string; orderQuantity: number; filledQuantity?: number; remainingQuantity?: number; fillPrice?: number; activeOrderNo?: string | number; activeOrderQuantity?: number; priorFilledQuantity?: number; priorFilledValue?: number; marketFallbackAllowed?: boolean; orderStyle?: string; [key: string]: any };
type Fill = { quantity: number; price: number };
type TrackingOptions = { domesticClient: any; overseasClient: any; tracker: { record(order: Order): Order }; canSubmit?: () => boolean; attempts?: number; delayMs?: number; protectionDelayMs?: number; protectionQueryAttempts?: number };

function normalizedOrderNo(value: unknown) {
  return String(value).replace(/^0+(?=\d)/, "");
}

async function currentExecution(order: Order, options: TrackingOptions): Promise<Order | undefined> {
  const client = order.market === "KRX" ? options.domesticClient : options.overseasClient;
  const day = (value: string | number) => new Intl.DateTimeFormat("en-CA", { timeZone: order.market === "KRX" ? "Asia/Seoul" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)).replaceAll("-", "");
  const today = day(Date.now());
  const date = order.createdAt ? day(order.createdAt) : today;
  // Overseas history has its own date/time proof in reconciliationPlan. Never use
  // a current-day order number to settle/cancel an older order from another caller.
  if (date !== today && order.market !== "KRX") throw new Error("과거 주문은 날짜별 증빙 대조 필요");
  const rows = order.market === "KRX"
    ? await client.getDomesticOrderExecutions({ symbol: order.symbol, date })
    : await client.getUsOrderExecutions({ exchange: order.exchange, symbol: order.symbol, date });
  if (!Array.isArray(rows)) throw new Error("체결 목록 형식 오류");
  const matches = rows.filter((item: Order) => normalizedOrderNo(item.orderNo) === normalizedOrderNo(order.activeOrderNo || order.orderNo));
  if (!matches.length) {
    if (date !== today) throw new Error("과거 날짜의 일치 주문 증빙 없음");
    return undefined;
  }
  if (matches.length !== 1) throw new Error("체결 주문번호 중복 · 증빙 확인 필요");
  const found = matches[0];
  const normalize = (value: unknown) => String(value || "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "");
  const quantity = order.activeOrderNo ? order.activeOrderQuantity ?? NaN : order.orderQuantity;
  const previousFilled = (order.filledQuantity || 0) - (order.activeOrderNo ? order.priorFilledQuantity || 0 : 0);
  if (normalize(found.symbol) !== normalize(order.symbol) || found.side !== order.side
    || (found.date && found.date !== date) || (date !== today && found.date !== date)
    || found.orderQuantity !== quantity
    || ![found.orderQuantity, found.filledQuantity, found.remainingQuantity].every(Number.isInteger)
    || found.filledQuantity < previousFilled || found.filledQuantity < 0 || found.remainingQuantity < 0
    || found.filledQuantity + found.remainingQuantity > quantity
    || (found.filledQuantity > 0 && !(Number.isFinite(found.fillPrice) && found.fillPrice > 0))
    || !["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(found.status)
    || (found.status === "FILLED" && (found.filledQuantity !== quantity || found.remainingQuantity !== 0))
    || (["FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(order.status) && found.status !== order.status)
    || (["CANCELLED", "REJECTED", "EXPIRED"].includes(found.status) && found.remainingQuantity !== 0)
    || (found.status === "CANCELLED" && /취소/.test(found.rawStatus || "") && /접수|요청|대기/.test(found.rawStatus || ""))
    || (found.status === "ACCEPTED" && found.filledQuantity !== 0)) {
    throw new Error("체결 증빙 충돌 · 날짜·종목·방향·수량 확인 필요");
  }
  // Only execution facts may update the ledger, never the broker's identity fields.
  return { ...order, status: order.status === "CANCEL_REQUESTED" && ["ACCEPTED", "PARTIALLY_FILLED"].includes(found.status) ? "CANCEL_REQUESTED" : found.status, filledQuantity: found.filledQuantity,
    remainingQuantity: found.remainingQuantity, fillPrice: found.fillPrice };
}

async function refreshPaperOrder(order: Order, options: TrackingOptions): Promise<Order> {
  if (order.status === "UNKNOWN") return order; // 재주문 응답 유실은 자동 추정하지 않습니다.
  const current = await currentExecution(order, options);
  const at = new Date().toISOString();
  const check = { lastAttemptAt: at, lastSuccessAt: at, reasonCode: current ? "MATCHED" : "NOT_FOUND" };
  if (!current) return options.tracker.record({ ...order, orderCheck: check });
  if (order.activeOrderNo) {
    const activeQuantity = Math.min(order.activeOrderQuantity || 0, Math.max(0, Number(current.filledQuantity) || 0));
    const filledQuantity = (order.priorFilledQuantity || 0) + activeQuantity;
    const filledValue = (order.priorFilledValue || 0) + activeQuantity * (Number(current.fillPrice) || 0);
    current.filledQuantity = filledQuantity;
    current.remainingQuantity = Math.max(0, order.orderQuantity - filledQuantity);
    current.fillPrice = filledQuantity ? filledValue / filledQuantity : 0;
    if (current.remainingQuantity === 0) current.status = "FILLED";
  }
  return options.tracker.record({ ...order, ...current, orderQuantity: order.orderQuantity, orderNo: order.orderNo,
    reconciliationRequired: false, orderCheck: check });
}

async function trackOrdinaryOrder(order: Order, options: TrackingOptions): Promise<Order> {
  for (let attempt = 0; attempt < (options.attempts ?? 15); attempt += 1) {
    order = await refreshPaperOrder(order, options);
    if (["FILLED", "CANCELLED", "REJECTED"].includes(order.status)) return order;
    await delay(options.delayMs ?? 1000);
  }
  return order;
}

async function pollOrder(order: Order, options: TrackingOptions): Promise<Order> {
  for (let attempt = 0; attempt < (options.attempts ?? 15); attempt += 1) {
    const current = await currentExecution(order, options);
    if (current) order = { ...order, ...current, orderNo: order.orderNo };
    if (["FILLED", "CANCELLED", "REJECTED"].includes(order.status)) return order;
    await delay(options.delayMs ?? 1000);
  }
  return order;
}

async function waitForIocResult(order: Order, options: TrackingOptions): Promise<Order | null> {
  await delay(options.protectionDelayMs ?? 3000);
  for (let attempt = 0; attempt < (options.protectionQueryAttempts ?? 3); attempt += 1) {
    const current = await currentExecution(order, options);
    if (current) return current;
    if (attempt + 1 < (options.protectionQueryAttempts ?? 3)) await delay(options.delayMs ?? 1000);
  }
  return null;
}

function aggregate(base: Order, fills: Fill[], brokerOrderNos: Array<string | number>, marketFallback: boolean, status: string, tracking: Partial<Order> = {}): Order {
  const filledQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const filledValue = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
  return {
    ...base,
    status,
    filledQuantity,
    remainingQuantity: Math.max(0, base.orderQuantity - filledQuantity),
    fillPrice: filledQuantity ? filledValue / filledQuantity : 0,
    brokerOrderNos,
    marketFallback,
    orderStrategy: marketFallback ? "최유리 IOC 2회 후 시장가" : "최유리 IOC 최대 2회",
    ...tracking,
  };
}

async function trackProtectedDomesticOrder(order: Order, options: TrackingOptions): Promise<Order> {
  let active = order;
  const fills: Fill[] = [];
  const brokerOrderNos = [order.orderNo];
  const protectedAttempts = 2;

  for (let attempt = 0; attempt < protectedAttempts; attempt += 1) {
    const current = await waitForIocResult(active, options);
    const priorFilledQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
    const priorFilledValue = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
    const tracking = { activeOrderNo: active.orderNo, activeOrderQuantity: active.orderQuantity, priorFilledQuantity, priorFilledValue };
    const quantity = Math.min(active.orderQuantity, Math.max(0, Number(current?.filledQuantity) || 0));
    if (quantity) fills.push({ quantity, price: Number(current?.fillPrice) || 0 });
    if (!current || Number(current.remainingQuantity) > 0) return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, fills.length ? "PARTIALLY_FILLED" : "ACCEPTED", tracking));
    const remaining = order.orderQuantity - fills.reduce((sum, fill) => sum + fill.quantity, 0);
    if (remaining <= 0) return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "FILLED"));
    const retryProtected = attempt + 1 < protectedAttempts;
    if (!retryProtected && !order.marketFallbackAllowed) {
      return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "CANCELLED"));
    }
    const orderStyle = retryProtected ? "PROTECTED" : "MARKET";
    if (options.canSubmit && !options.canSubmit()) return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "CANCELLED"));
    // 송신 전에 저장: 재주문 도중 재시작해도 첫 주문을 근거로 중복 주문하지 않습니다.
    options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "UNKNOWN", { retrySubmissionPending: true }));
    try {
      active = { ...await options.domesticClient.placeDomesticMarketOrder({ side: order.side, symbol: order.symbol, quantity: remaining, session: "REGULAR", orderStyle, ...(options.canSubmit ? { canSubmit: options.canSubmit } : {}) }), market: "KRX", symbol: order.symbol, side: order.side, orderQuantity: remaining };
    } catch (error) {
      const uncertain = (error as any)?.orderStatusUnknown === true;
      options.tracker.record(aggregate(order, fills, brokerOrderNos, false, uncertain ? "UNKNOWN" : "CANCELLED", { retrySubmissionPending: uncertain }));
      throw error;
    }
    brokerOrderNos.push(active.orderNo);
    options.tracker.record(aggregate(order, fills, brokerOrderNos, orderStyle === "MARKET", "ACCEPTED", {
      retrySubmissionPending: false, activeOrderNo: active.orderNo, activeOrderQuantity: remaining,
      priorFilledQuantity: fills.reduce((sum, fill) => sum + fill.quantity, 0),
      priorFilledValue: fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0),
    }));
    if (orderStyle === "MARKET") {
      const priorFilledQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
      const priorFilledValue = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
      const currentMarket = await pollOrder({ ...active, market: "KRX", filledQuantity: 0, remainingQuantity: remaining }, options);
      const marketQuantity = Math.min(remaining, Math.max(0, Number(currentMarket.filledQuantity) || 0));
      if (marketQuantity) fills.push({ quantity: marketQuantity, price: Number(currentMarket.fillPrice) || 0 });
      const status = fills.reduce((sum, fill) => sum + fill.quantity, 0) >= order.orderQuantity ? "FILLED" : currentMarket.status;
      return options.tracker.record(aggregate(order, fills, brokerOrderNos, true, status, {
        activeOrderNo: active.orderNo,
        activeOrderQuantity: remaining,
        priorFilledQuantity,
        priorFilledValue,
      }));
    }
  }
  return order;
}

async function trackPaperOrder(order: Order, options: TrackingOptions): Promise<Order> {
  return order.market === "KRX" && order.orderStyle === "PROTECTED"
    ? trackProtectedDomesticOrder(order, options)
    : trackOrdinaryOrder(order, options);
}

module.exports = { refreshPaperOrder, trackPaperOrder };
