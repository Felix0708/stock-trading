"use strict";

const { setTimeout: delay } = require("node:timers/promises");

type Order = { orderNo: string | number; status: string; market: string; symbol: string; exchange?: string; side?: string; orderQuantity: number; filledQuantity?: number; remainingQuantity?: number; fillPrice?: number; activeOrderNo?: string | number; activeOrderQuantity?: number; priorFilledQuantity?: number; priorFilledValue?: number; marketFallbackAllowed?: boolean; orderStyle?: string; [key: string]: any };
type Fill = { quantity: number; price: number };
type TrackingOptions = { domesticClient: any; overseasClient: any; tracker: { record(order: Order): Order }; attempts?: number; delayMs?: number; protectionDelayMs?: number; protectionQueryAttempts?: number };

function normalizedOrderNo(value: unknown) {
  return String(value).replace(/^0+(?=\d)/, "");
}

async function currentExecution(order: Order, options: TrackingOptions): Promise<Order | undefined> {
  const client = order.market === "KRX" ? options.domesticClient : options.overseasClient;
  const rows = order.market === "KRX"
    ? await client.getDomesticOrderExecutions({ symbol: order.symbol })
    : await client.getUsOrderExecutions({ exchange: order.exchange, symbol: order.symbol });
  return rows.find((item: Order) => normalizedOrderNo(item.orderNo) === normalizedOrderNo(order.activeOrderNo || order.orderNo));
}

async function refreshPaperOrder(order: Order, options: TrackingOptions): Promise<Order> {
  const current = await currentExecution(order, options);
  if (!current) return order;
  if (order.activeOrderNo) {
    const activeQuantity = Math.min(order.activeOrderQuantity || 0, Math.max(0, Number(current.filledQuantity) || 0));
    const filledQuantity = (order.priorFilledQuantity || 0) + activeQuantity;
    const filledValue = (order.priorFilledValue || 0) + activeQuantity * (Number(current.fillPrice) || 0);
    current.filledQuantity = filledQuantity;
    current.remainingQuantity = Math.max(0, order.orderQuantity - filledQuantity);
    current.fillPrice = filledQuantity ? filledValue / filledQuantity : 0;
    if (current.remainingQuantity === 0) current.status = "FILLED";
  }
  const changed = ["status", "filledQuantity", "remainingQuantity", "fillPrice"]
    .some((key) => current[key] !== undefined && current[key] !== order[key]);
  return changed ? options.tracker.record({ ...order, ...current, orderNo: order.orderNo }) : order;
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
    if (!current || Number(current.remainingQuantity) > 0) return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, fills.length ? "PARTIALLY_FILLED" : "ACCEPTED"));
    const quantity = Math.min(active.orderQuantity, Math.max(0, Number(current.filledQuantity) || 0));
    if (quantity) fills.push({ quantity, price: Number(current.fillPrice) || 0 });
    const remaining = order.orderQuantity - fills.reduce((sum, fill) => sum + fill.quantity, 0);
    if (remaining <= 0) return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "FILLED"));
    const retryProtected = attempt + 1 < protectedAttempts;
    if (!retryProtected && !order.marketFallbackAllowed) {
      return options.tracker.record(aggregate(order, fills, brokerOrderNos, false, "CANCELLED"));
    }
    const orderStyle = retryProtected ? "PROTECTED" : "MARKET";
    active = { ...await options.domesticClient.placeDomesticMarketOrder({ side: order.side, symbol: order.symbol, quantity: remaining, session: "REGULAR", orderStyle }), market: "KRX" };
    brokerOrderNos.push(active.orderNo);
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
