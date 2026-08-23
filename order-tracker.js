"use strict";

const fs = require("node:fs");

const PENDING_STATUSES = new Set(["ACCEPTED", "CANCEL_REQUESTED", "PARTIALLY_FILLED"]);

function tradingDate(value, market) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: market === "KRX" ? "Asia/Seoul" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

class OrderTracker {
  constructor(file) {
    this.file = file;
  }

  snapshot() {
    if (!fs.existsSync(this.file)) return { revision: 0, orders: {} };
    const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Number.isInteger(state.revision) || !state.orders || typeof state.orders !== "object") {
      throw new Error("주문 상태 파일 형식이 올바르지 않습니다.");
    }
    return state;
  }

  record(order) {
    if (!order?.orderNo) throw new Error("주문번호가 필요합니다.");
    if (!order.status) throw new Error("주문상태가 필요합니다.");
    const state = this.snapshot();
    state.revision += 1;
    const orderNo = String(order.orderNo);
    const saved = {
      ...(state.orders[orderNo] || {}),
      ...order,
      orderNo,
      revision: state.revision,
      updatedAt: new Date().toISOString(),
    };
    state.orders[orderNo] = saved;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return saved;
  }

  list() {
    return Object.values(this.snapshot().orders).sort((a, b) => b.revision - a.revision);
  }

  pending() {
    return this.list().filter((order) => PENDING_STATUSES.has(order.status));
  }

  expirePreviousDayOrders(now = new Date()) {
    const state = this.snapshot();
    const expired = [];
    for (const order of Object.values(state.orders)) {
      const updatedAt = new Date(order.updatedAt);
      if (!PENDING_STATUSES.has(order.status) || Number.isNaN(updatedAt.getTime())) continue;
      if (tradingDate(updatedAt, order.market) >= tradingDate(now, order.market)) continue;
      state.revision += 1;
      const saved = {
        ...order,
        status: "EXPIRED",
        remainingQuantity: 0,
        expirationReason: "거래일 종료",
        revision: state.revision,
        updatedAt: now.toISOString(),
      };
      state.orders[String(order.orderNo)] = saved;
      expired.push(saved);
    }
    if (expired.length) this.write(state);
    return expired;
  }

  unnotifiedPending() {
    const state = this.snapshot();
    const pending = Object.values(state.orders).filter((order) => PENDING_STATUSES.has(order.status));
    if (!Array.isArray(state.recoveryNotifiedOrderNos)) {
      state.recoveryNotifiedOrderNos = pending.map((order) => String(order.orderNo));
      this.write(state);
      return [];
    }
    const notified = new Set(state.recoveryNotifiedOrderNos);
    return pending.filter((order) => !notified.has(String(order.orderNo)));
  }

  markRecoveryNotified(orders) {
    const state = this.snapshot();
    const notified = new Set(state.recoveryNotifiedOrderNos || []);
    for (const order of orders) notified.add(String(order.orderNo));
    state.recoveryNotifiedOrderNos = [...notified];
    this.write(state);
  }

  write(state) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { OrderTracker, PENDING_STATUSES };
