"use strict";

const { equityPerformance } = require("../executor/equity-performance");
const { koreanDate } = require("../executor/account-evidence");
const { equityBreakdown } = require("../brokers/account-equity");

function serializeBreakdown(row) {
  const b = row.breakdown;
  if (!b) return {};
  if (row.scope !== "account-total-assets" || row.currency !== "KRW" || b.status !== "verified"
    || typeof b.us_stock_value_krw !== "number" || !Number.isFinite(b.us_stock_value_krw)
    || !Number.isFinite(Date.parse(b.observed_at)) || Date.parse(b.observed_at) > Date.parse(row.at)
    || Date.parse(row.at) - Date.parse(b.observed_at) > 120_000
    || (row.brokerId === "KIWOOM" ? b.source !== "KIWOOM_LINKED_V1" || b.fx_source !== "KIWOOM_USD_SELL" || !["same-account", "separate-accounts"].includes(b.cash_scope)
      : b.source !== "KIS_RECONCILED_V1" || b.fx_source !== "KIS_USD_FIRST" || b.cash_scope !== "account")) throw Error("총자산 상세 출처·시각 오류");
  equityBreakdown({ equity: row.equity, domestic: b.domestic_stock_value_krw, us: b.us_stock_value_usd, cash: b.cash_krw,
    rate: b.usd_krw_rate, fxSource: b.fx_source, source: b.source, cashScope: b.cash_scope, observedAt: b.observed_at });
  if (Math.abs(b.us_stock_value_usd * b.usd_krw_rate - b.us_stock_value_krw) > 2
    || (row.cash != null && Math.abs(row.cash - b.cash_krw) > 2)
    || (row.stockValue != null && Math.abs(row.stockValue - b.domestic_stock_value_krw - b.us_stock_value_krw) > 2)) throw Error("총자산 상세 정합 오류");
  return { breakdown: { status: "verified", domestic_stock_value_krw: decimal(b.domestic_stock_value_krw),
    us_stock_value_usd: decimal(b.us_stock_value_usd), us_stock_value_krw: decimal(b.us_stock_value_krw), cash_krw: decimal(b.cash_krw, true),
    usd_krw_rate: decimal(b.usd_krw_rate), fx_source: b.fx_source, observed_at: b.observed_at, source: b.source, cash_scope: b.cash_scope } };
}

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
      || !["KIWOOM:domestic:KRW", "KIWOOM:overseas:USD", "KIWOOM:account-total-assets:KRW", "KIS:account-total-assets:KRW"].includes(`${row.brokerId}:${row.scope}:${row.currency}`)
      || (row.accountGroupRef != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.accountGroupRef))
      || (row.brokerId === "KIWOOM" && row.scope === "account-total-assets" && (!row.breakdown || !row.accountGroupRef || row.source !== "KIWOOM:linked-accounts:v1"))
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
    const groupRefs = [...new Set(samples.map(row => row.accountGroupRef).filter(Boolean))];
    const performance = equityPerformance({ ...state, equity: samples }, first.brokerId, first.environment, first.currency,
      { scope: first.scope, accountRef: first.accountRef });
    const curve = new Map<string, number>((performance.curve || []).map(point => [point.at, point.index]));
    return {
      account_ref: first.accountRef, broker: first.brokerId, account_type: first.environment === "mock" ? "paper" : "live",
      currency: first.currency, scope: first.scope, date_timezone: "Asia/Seoul",
      ...(groupRefs.length === 1 ? { account_group_ref: groupRefs[0] } : {}), // A changed linked account never relabels the old history.
      return_method: curve.size ? "daily-sampled-linked-modified-dietz" : null,
      return_base_at: curve.size ? samples[0].at : null,
      points: samples.map(row => ({
        date: koreanDate(row.at).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        valued_at: null, collected_at: row.at, calculated_at: calculatedAt, // Current APIs supply no authoritative valuation timestamp.
        equity: decimal(row.equity), cash: decimal(row.cash, true), stock_value: decimal(row.stockValue),
        return_index: curve.has(row.at) ? decimal(curve.get(row.at)) : null,
        return_status: curve.has(row.at) ? "verified" : performance.status,
        source: row.brokerId === "KIS" ? "KIS_ACCOUNT_EQUITY" : row.scope === "domestic" ? "KIWOOM_KR_EQUITY"
          : row.scope === "overseas" ? "KIWOOM_US_EQUITY" : "KIWOOM_ACCOUNT_EQUITY",
        ...serializeBreakdown(row),
      })),
    };
  });
}

module.exports = { accountEquitySeries };
