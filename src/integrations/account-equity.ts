"use strict";

const { equityPerformance } = require("../executor/equity-performance");
const { koreanDate } = require("../executor/account-evidence");

function decimal(value, negative = false) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || (!negative && value < 0)) throw Error("자산 전송 금액 오류");
  return value.toFixed(8).replace(/\.?0+$/, "") || "0";
}

function accountEquitySeries(state, calculatedAt = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(calculatedAt))) throw Error("자산 계산 시각 오류");
  const groups = new Map<string, any[]>();
  for (const row of state.equity) {
    if (!row.accountRef) continue; // Legacy history cannot prove the physical account identity.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.accountRef)
      || !["KIWOOM", "KIS"].includes(row.brokerId) || !["mock", "live"].includes(row.environment)
      || !["KIWOOM:domestic:KRW", "KIWOOM:overseas:USD", "KIS:account-total-assets:KRW"].includes(`${row.brokerId}:${row.scope}:${row.currency}`)
      || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) > Date.parse(calculatedAt)) throw Error("자산 전송 계좌·범위·시각 오류");
    const key = [row.accountRef, row.brokerId, row.environment, row.currency, row.scope].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const first = rows[0];
    const daily = new Map<string, any>();
    for (const row of rows) {
      const date = koreanDate(row.at);
      if (!daily.has(date) || Date.parse(daily.get(date).at) < Date.parse(row.at)) daily.set(date, row);
    }
    const samples = [...daily.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const performance = equityPerformance({ ...state, equity: samples }, first.brokerId, first.environment, first.currency,
      { scope: first.scope, accountRef: first.accountRef });
    const curve = new Map<string, number>((performance.curve || []).map(point => [point.at, point.index]));
    return {
      account_ref: first.accountRef, broker: first.brokerId, account_type: first.environment === "mock" ? "paper" : "live",
      currency: first.currency, scope: first.scope, date_timezone: "Asia/Seoul",
      return_method: curve.size ? "daily-sampled-linked-modified-dietz" : null,
      return_base_at: curve.size ? samples[0].at : null,
      points: samples.map(row => ({
        date: koreanDate(row.at).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        valued_at: null, collected_at: row.at, calculated_at: calculatedAt, // Current APIs supply no authoritative valuation timestamp.
        equity: decimal(row.equity), cash: decimal(row.cash, true), stock_value: decimal(row.stockValue),
        return_index: curve.has(row.at) ? decimal(curve.get(row.at)) : null,
        return_status: curve.has(row.at) ? "verified" : performance.status,
        source: row.scope === "domestic" ? "KIWOOM_KR_EQUITY" : row.brokerId === "KIWOOM" ? "KIWOOM_US_EQUITY" : "KIS_ACCOUNT_EQUITY",
      })),
    };
  });
}

module.exports = { accountEquitySeries };
