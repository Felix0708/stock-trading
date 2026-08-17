"use strict";

const fs = require("node:fs");

const PENDING_STATUSES = new Set(["ACCEPTED", "CANCEL_REQUESTED", "PARTIALLY_FILLED"]);

class OrderTracker {
  constructor(file) {
    this.file = file;
  }

  snapshot() {
    if (!fs.existsSync(this.file)) return { revision: 0, orders: {} };
    const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Number.isInteger(state.revision) || !state.orders || typeof state.orders !== "object") {
      throw new Error("kiwoom-orders.json 형식이 올바르지 않습니다.");
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
}

module.exports = { OrderTracker, PENDING_STATUSES };
