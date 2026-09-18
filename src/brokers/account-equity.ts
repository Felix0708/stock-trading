"use strict";

function equityNumber(value) {
  if (value == null || String(value).trim() === "") throw Error("자산 상세 숫자 미확인");
  const n = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) throw Error("자산 상세 숫자 오류");
  return n;
}

// Exactly the requested currencies; other wallets are not part of this subtotal.
function currencyTotal(rows) {
  if (!Array.isArray(rows) || rows.length !== 3 || new Set(rows.map(r => r.currency)).size !== 3
    || rows.some(r => !["KRW", "USD", "JPY"].includes(r.currency)
      || ["cash", "stock_value", "cash_krw", "stock_value_krw"].some(k => typeof r[k] !== "number" || !Number.isFinite(r[k]) || Math.abs(r[k]) > Number.MAX_SAFE_INTEGER)
      || r.stock_value < 0 || r.stock_value_krw < 0
      || (r.currency === "KRW" && (r.cash !== r.cash_krw || r.stock_value !== r.stock_value_krw)))) throw Error("3개 통화 자산 형식 오류");
  const cash = rows.reduce((s,r) => s + r.cash_krw, 0), stockValue = rows.reduce((s,r) => s + r.stock_value_krw, 0);
  if (!Number.isFinite(cash + stockValue) || cash + stockValue < 0 || Math.abs(cash + stockValue) > Number.MAX_SAFE_INTEGER) throw Error("3개 통화 합계 오류");
  return { currency: "KRW", scope: "account-total-assets", equity: cash + stockValue, cash, stockValue, currency_breakdown: rows };
}

function equityBreakdown({ equity, domestic, us, cash, rate, fxSource, source, cashScope, observedAt = new Date().toISOString() }) {
  if (![equity, domestic, us, cash, rate].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER)
    || equity < 0 || domestic < 0 || us < 0 || rate <= 0 || Math.abs(us * rate) > Number.MAX_SAFE_INTEGER
    || Math.abs(domestic + us * rate + cash - equity) > 2) throw Error("총자산과 국내·미국·현금 상세 대조 불일치");
  return { status: "verified", domestic_stock_value_krw: domestic, us_stock_value_usd: us,
    us_stock_value_krw: us * rate, cash_krw: cash, usd_krw_rate: rate,
    fx_source: fxSource, observed_at: observedAt, source, cash_scope: cashScope };
}

// Aggregate only fresh, explicitly linked observations. Never infer shared cash from equal balances.
async function collectKiwoomTotal(broker, points) {
  const domestic = points.find(p => p.scope === "domestic"), us = points.find(p => p.scope === "overseas");
  if (!domestic?.equityProof || !us?.equityProof || domestic.cash == null || domestic.stockValue == null
    || us.cash == null || us.stockValue == null) throw Error("총자산 합산에 필요한 국내·미국 동시 관측 미확인");
  const d = domestic.equityProof, u = us.equityProof;
  if ([d, u].some(p => !Number.isFinite(Date.parse(p.observedAt)) || Date.now() - Date.parse(p.observedAt) > 120_000
    || Date.parse(p.observedAt) > Date.now())) throw Error("자산 상세 관측 시간 초과");
  if (!d.clear || !u.clear || !(u.rate > 0)) throw Error("원화대용·미수·환율 확인 전 총자산 합산 보류");
  const identities = [];
  for (const client of [broker.domesticClient, broker.overseasClient]) {
    const result = await client.post("/api/dostk/acnt", { apiId: "ka00001", authorization: true });
    if (!/^\d{10}$/.test(result.acctNo || "") || result.pagination?.more) throw Error("연결 계좌 현금 중복 확인 실패");
    identities.push(result.acctNo); // Kept in memory only; never included in evidence or sync.
  }
  const currencies = await broker.overseasClient.post("/api/us/acnt", {
    apiId: "ust21120", authorization: true, body: { cmsn_incl_tp: "1", exrt_tp: "0" },
  });
  if (currencies.pagination?.more || !Array.isArray(currencies.result_list)
    || currencies.result_list.filter(r => r.crnc_code === "USD").length !== 1
    || currencies.result_list.some(r => !r.crnc_code)) throw Error("미국 외 통화·자산 범위 확인 전 합산 보류");
  if (!broker.selectedCurrencies && currencies.result_list.some(r => r.crnc_code !== "USD" && (equityNumber(r.fx_entr) !== 0 || equityNumber(r.evlt_amt) !== 0))) {
    throw Object.assign(Error("USD 외 통화 잔액·자산이 있어 전체 총자산 합산 보류"), { code: "other_currency_assets" });
  }
  const same = identities[0] === identities[1];
  if (!same && broker.environment !== "mock") throw Error("서로 다른 실계좌의 전체 자산 범위 확인 전 합산 보류");
  if (same && Math.abs(d.d0Cash - u.wonCash) > 2) throw Error("동일 계좌 원화예수금 대조 불일치");
  const extraCash = same ? 0 : u.wonCash;
  if (broker.selectedCurrencies) {
    const yen = currencies.result_list.filter(r => r.crnc_code === "JPY");
    if (yen.length > 1) throw Error("엔화 중복 응답");
    const j = yen[0];
    // Use the broker's converted JPY amounts, never assume a 1-yen vs 100-yen FX unit.
    return { ...currencyTotal([
      { currency: "KRW", cash: domestic.cash + extraCash, stock_value: domestic.stockValue, cash_krw: domestic.cash + extraCash, stock_value_krw: domestic.stockValue },
      { currency: "USD", cash: us.cash, stock_value: us.stockValue, cash_krw: us.cash * u.rate, stock_value_krw: us.stockValue * u.rate },
      { currency: "JPY", cash: j ? equityNumber(j.fx_entr) : 0, stock_value: j ? equityNumber(j.evlt_amt) : 0,
        cash_krw: j ? equityNumber(j.chg_entr) : 0, stock_value_krw: j ? equityNumber(j.chg_evlt_amt) : 0 },
    ]), source: "KIWOOM:linked-accounts:v1" };
  }
  const cash = domestic.cash + extraCash + us.cash * u.rate;
  const equity = domestic.equity + extraCash + us.equity * u.rate;
  if ([d, u].some(p => Date.now() - Date.parse(p.observedAt) > 120_000)) throw Error("자산 상세 관측 시간 초과");
  return { currency: "KRW", scope: "account-total-assets", equity, cash,
    stockValue: domestic.stockValue + us.stockValue * u.rate, source: "KIWOOM:linked-accounts:v1",
    breakdown: equityBreakdown({ equity, domestic: domestic.stockValue, us: us.stockValue, cash, rate: u.rate,
      fxSource: "KIWOOM_USD_SELL", source: "KIWOOM_LINKED_V1", cashScope: same ? "same-account" : "separate-accounts", observedAt: u.observedAt }) };
}

module.exports = { equityNumber, equityBreakdown, collectKiwoomTotal, currencyTotal };
