"use strict";
const fs = require("node:fs");
const { OrderTracker } = require("../trading/order-tracker");
const { managedPosition, normalizedSymbol, sameInstrument } = require("../trading/position-ownership");

function trackedOrders(broker, env = process.env) {
  if (broker.accountKind === "isa") return [];
  const file = env[`${broker.id}_ORDER_STATE_FILE`] || `${broker.id === "KIS" ? "kis" : "kiwoom"}-orders.json`;
  // Missing/corrupt history is unknown ownership, never evidence of manual purchase.
  return fs.existsSync(file) ? new OrderTracker(file).list() : null;
}

function holdingSnapshot(broker, market, balances, orders, now = new Date()) {
  const rows = new Map();
  for (const balance of balances) for (const row of balance.holdings) {
    const code = normalizedSymbol(row.code), quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity<0) throw Error("보유 수량 검증 실패");
    if (!quantity) continue;
    const avg = Number(row.purchasePrice) > 0 ? Number(row.purchasePrice) : Number(row.purchaseAmount)/quantity;
    if (!(market==="KR" ? /^\d{6}$/ : /^[A-Z][A-Z0-9.-]{0,9}$/).test(code)
      || typeof row.name!=="string" || !row.name.trim() || row.name.length>50
      || !Number.isFinite(avg) || avg<=0 || avg>1e12 || quantity>1e12) throw Error("보유 종목·매입가 검증 실패");
    const instrument={ticker:code,exchange:market==="KR" ? "KRX" : "NASDAQ"};
    const uncertain=orders?.some(o=>o.environment==="live" && sameInstrument(o,instrument)
      && ["UNKNOWN","SUBMITTING","CANCEL_REQUESTED","PARTIALLY_FILLED"].includes(o.status));
    const managed = orders === null || uncertain ? null : managedPosition(orders,instrument,"live").quantity;
    const h = {stock_code:code,stock_name:row.name,quantity,avg_price:Number(avg.toFixed(8)),
      automated_quantity:managed!==null && managed<=quantity ? managed : null};
    if(rows.has(code) && JSON.stringify(rows.get(code))!==JSON.stringify(h)) throw Error("거래소별 중복 잔고 불일치");
    rows.set(code,h);
  }
  if(rows.size>200) throw Error("잔고 종목 수 초과");
  return {broker:broker.id,account_kind:broker.accountKind || "general",market,collected_at:now.toISOString(),holdings:[...rows.values()]};
}

async function collectLiveHoldings(broker, env = process.env) {
  if(broker.environment!=="live") return [];
  let orders;
  try { orders=trackedOrders(broker,env); } catch { orders=null; }
  const snapshots=[];
  for(const market of broker.accountKind==="isa" ? ["KR"] : ["KR","US"]) {
    try {
      const balances=market==="KR" ? [await broker.domesticClient.getDomesticBalance()]
        : broker.overseasClient.getUsBalances ? await broker.overseasClient.getUsBalances() : [await broker.overseasClient.getUsBalance()];
      snapshots.push(holdingSnapshot(broker,market,balances,orders));
    } catch(error) {
      // Do not clear a failed market, and do not prevent the other market/account from updating.
      console.error(JSON.stringify({event:"live_holdings_failed",broker:broker.id,accountKind:broker.accountKind||"general",market,
        reason:/8050/.test(error.message) ? "ip_not_registered" : "balance_or_history_unverified"}));
    }
  }
  return snapshots;
}
module.exports={holdingSnapshot,collectLiveHoldings};
