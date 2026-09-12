"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { KiwoomClient } = require("../src/brokers/kiwoom-client");
const { KisClient } = require("../src/brokers/kis-client");
const { readEvidence, writeEvidence, equityAccountRef, recordAccountEquity, collectAccountEquity, refreshAccountEquity, equityCollectionOpen, collectBrokerEvidence } = require("../src/executor/account-evidence");
const { equityPerformance, importCashFlows } = require("../src/executor/equity-performance");
const { accountEquitySeries } = require("../src/integrations/account-equity");
const { syncStockBriefingEquity } = require("../src/integrations/stock-briefing");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-equity-")), file = path.join(root, "evidence.json");
  const client = new KiwoomClient({ appKey: "private-key", secretKey: "private-secret" });
  const broker = { id: "KIWOOM", environment: "mock", overseasClient: client };
  const collectionAt = new Date("2026-09-11T15:00:00Z");
  for (const [id, environment, time, expected] of [
    ["KIWOOM", "mock", "2026-09-12T04:59:00+09:00", true], // Friday US session, Saturday Korea.
    ["KIWOOM", "mock", "2026-09-12T05:55:00+09:00", true], // Post-close hourly sample.
    ["KIWOOM", "mock", "2026-09-12T06:00:00+09:00", false],
    ["KIWOOM", "mock", "2026-09-12T15:55:00+09:00", false],
    ["KIS", "mock", "2026-09-12T15:55:00+09:00", false],
    ["KIS", "live", "2026-09-13T12:00:00+09:00", false],
    ["KIWOOM", "live", "2026-09-12T08:55:00+09:00", true], // US extended-session valuation.
    ["KIWOOM", "live", "2026-09-12T10:00:00+09:00", false],
    ["KIWOOM", "mock", "2026-12-12T06:55:00+09:00", true], // Winter close + grace.
    ["KIWOOM", "mock", "2026-12-12T07:00:00+09:00", false],
    ["KIWOOM", "mock", "2026-09-07T15:00:00Z", false], // US holiday.
    ["KIS", "mock", "2026-09-07T10:00:00+09:00", true], // Korea still open.
    ["KIWOOM", "mock", "2026-09-07T10:00:00+09:00", false],
    ["KIS", "mock", "2026-09-24T10:00:00+09:00", false], // Korean holiday, US also outside hours.
    ["KIWOOM", "mock", "2026-11-27T18:55:00Z", true], // Early close + grace.
    ["KIWOOM", "mock", "2026-11-27T19:00:00Z", false],
    ["KIWOOM", "mock", "2026-09-14T13:30:00Z", true], // Next open resumes.
    ["KIWOOM", "mock", "2029-09-11T15:00:00Z", false], // Unknown calendar.
  ] as const) assert.equal(equityCollectionOpen({ id, environment }, new Date(time)), expected, `${id} ${environment} ${time}`);
  const state = readEvidence(file), ref = equityAccountRef(state, broker);
  writeEvidence(file, state);
  assert.equal(equityAccountRef(readEvidence(file), broker), ref);
  const rotated = { ...broker, overseasClient: new KiwoomClient({ appKey: "other-key", secretKey: "secret" }) };
  assert.notEqual(equityAccountRef(state, rotated), ref);
  assert.notEqual(equityAccountRef(state, { ...broker, environment: "live" }), ref);
  const kis = (accountNo, appKey) => new KisClient({ appKey, appSecret: "secret", accountNo });
  assert.equal(kis("12345678", "first").accountIdentityKey(), kis("12345678", "rotated").accountIdentityKey());
  assert.notEqual(kis("12345678", "first").accountIdentityKey(), kis("87654321", "first").accountIdentityKey());
  let queries = 0;
  client.post = async (_path, options) => { queries++; return options.apiId === "ust21160"
    ? { d0_usd_fx_entr: "120", d4_usd_fx_entr: "90" } : { crnc_code: "USD", tot_evlt_amt: "10" }; };
  const point = (await collectAccountEquity(broker))[0];
  assert.equal(point.equity, 100); assert.equal(point.cash, 90); assert.equal(point.stockValue, 10);
  const day1 = "2025-08-01T01:00:00.000Z", day2 = "2025-08-02T01:00:00.000Z", day3 = "2025-08-03T01:00:00.000Z";
  recordAccountEquity(state, broker, [point], day1);
  recordAccountEquity(state, broker, [{ ...point, equity: 110 }], "2025-08-01T02:00:00.000Z");
  recordAccountEquity(state, broker, [{ ...point, equity: 80 }], day1);
  assert.equal(state.equity.length, 1); assert.equal(state.equity[0].equity, 110); // Old arrival never overwrites.
  let series = accountEquitySeries(state, day3);
  assert.equal(series[0].points[0].return_status, "insufficient_samples");
  assert.equal(series[0].points[0].return_index, null); assert.equal(series[0].points[0].valued_at, null);
  assert.equal(series[0].points[0].cash, "90"); assert.equal(series[0].points[0].stock_value, "10");
  recordAccountEquity(state, broker, [{ ...point, equity: 160 }], day2);
  assert.equal(accountEquitySeries(state, day3)[0].points[1].return_status, "cash_flows_unverified");
  const input = { source: "complete account statement", cashFlowCoverage: { accountRef: ref, currency: "USD", scope: "overseas", start: day1, end: day3 },
    cashFlows: [{ id: "deposit", amount: 50, at: day2 }] };
  assert.throws(() => importCashFlows(state, { ...input, cashFlowCoverage: { ...input.cashFlowCoverage, accountRef: undefined } }, broker), /accountRef/);
  importCashFlows(state, input, broker);
  series = accountEquitySeries(state, day3);
  assert.deepEqual(series[0].points.map(p => p.return_index), ["1", "1"]); // Deposit is not trading profit.
  recordAccountEquity(state, broker, [{ ...point, equity: 144 }], day3);
  assert.equal(accountEquitySeries(state, day3)[0].points[2].return_index, "0.9");
  const isolated = structuredClone(state);
  recordAccountEquity(isolated, rotated, [{ ...point, equity: 10000 }], day2);
  recordAccountEquity(isolated, broker, [{ ...point, currency: "KRW" }], day2);
  recordAccountEquity(isolated, broker, [{ ...point, scope: "account-total-assets" }], day2);
  assert.equal(isolated.equity.length, 6);
  assert.equal(equityPerformance(isolated, "KIWOOM", "mock", "USD").status, "scope_unverified");
  assert.ok(Math.abs(equityPerformance(isolated, "KIWOOM", "mock", "USD", { scope: "overseas", accountRef: ref }).returnRate + 10) < 1e-8);
  const missing = structuredClone(state); missing.cashFlowCoverage[0].accountRef = "other";
  assert.equal(accountEquitySeries(missing, day3)[0].points[2].return_index, null);
  const legacy = structuredClone(state); legacy.equity.forEach(row => delete row.accountRef);
  assert.deepEqual(accountEquitySeries(legacy, day3), []);
  const empty = structuredClone(state); empty.equity = [{ ...state.equity[0], equity: 0, cash: 0, stockValue: 0 }];
  assert.equal(accountEquitySeries(empty, day3)[0].points[0].equity, "0");
  empty.equity[0].cash = null; empty.equity[0].stockValue = undefined;
  assert.equal(accountEquitySeries(empty, day3)[0].points[0].cash, null);
  empty.equity[0].equity = NaN; assert.throws(() => accountEquitySeries(empty, day3), /금액/);
  const partial = structuredClone(state); partial.cashFlowCoverage[0].end = day2;
  assert.deepEqual(accountEquitySeries(partial, day3)[0].points.map(p => p.return_index), ["1", "1", null]);
  const noLeak = JSON.stringify(accountEquitySeries(state, day3));
  for (const secret of ["private-key", "private-secret", client.accountIdentityKey(), "12345678", "deposit", "complete account statement"]) assert.ok(!noLeak.includes(secret));
  assert.ok(!noLeak.includes("orderNo"));
  const unchanged = fs.readFileSync(file, "utf8"), beforeClosed = queries;
  assert.equal(await refreshAccountEquity(broker, file, new Date("2026-09-12T15:55:00+09:00")), false);
  assert.equal(queries, beforeClosed); assert.equal(fs.readFileSync(file, "utf8"), unchanged);
  let reconciliationQueries = 0;
  const report = await collectBrokerEvidence({ ...broker, tracker: { list: () => [] },
    domesticClient: { getDomesticBalance: async () => { reconciliationQueries++; return { holdings: [] }; } },
    overseasClient: { getUsBalances: async () => { reconciliationQueries++; return [{ holdings: [] }]; },
      getAccountEquity: async () => { throw Error("must not collect holiday equity"); } },
  }, new Date("2026-09-12T15:55:00+09:00"));
  assert.equal(reconciliationQueries, 2); assert.deepEqual(report.equity, []); assert.equal(report.equityError, "");
  const firstCollection = await refreshAccountEquity(broker, file, collectionAt);
  assert.equal(firstCollection, true);
  const after = queries;
  assert.equal(await refreshAccountEquity(broker, file, collectionAt), false); assert.equal(queries, after); // No high-frequency balance polling.
  const older = readEvidence(file); older.equity[0].at = day1; older.equityAttemptedAt[ref] = day1; writeEvidence(file, older);
  client.post = async () => { throw Error("broker offline"); };
  await assert.rejects(refreshAccountEquity(broker, file, collectionAt), /offline/);
  assert.deepEqual(readEvidence(file).equity, older.equity);
  assert.equal(await refreshAccountEquity(broker, file, collectionAt), false); // Failure does not trigger a burst of collection attempts.
  client.post = async () => ({ crnc_code: "USD", d0_usd_fx_entr: "100", d4_usd_fx_entr: "", tot_evlt_amt: "0" });
  await assert.rejects(collectAccountEquity(broker), /미확인/);
  const kisClient = kis("12345678", "a");
  let summary: any = { tot_asst_amt: "1001", tot_loan_amt: "0", tot_dncl_amt: "100", frcr_evlu_tota: "700", evlu_amt_smtl_amt: "200", cma_evlu_amt: "0" };
  kisClient.request = async () => ({ output3: summary });
  assert.equal((await kisClient.getAccountEquity()).cash, 800);
  assert.equal((await kisClient.getAccountEquity()).stockValue, 200);
  summary = { ...summary, frcr_evlu_tota: "650" };
  assert.equal((await kisClient.getAccountEquity()).cash, null); assert.equal((await kisClient.getAccountEquity()).equity, 1001);
  summary = { ...summary, tot_loan_amt: "1" }; await assert.rejects(kisClient.getAccountEquity(), /대출/);
  summary = { ...summary, tot_loan_amt: null }; await assert.rejects(kisClient.getAccountEquity(), /대출/);
  summary = { ...summary, tot_asst_amt: null }; await assert.rejects(kisClient.getAccountEquity(), /미확인/);
  const calls = [], token = `sb_sync_${"a".repeat(43)}`;
  const many = structuredClone(state); many.cashFlowCoverage = []; many.equity = Array.from({ length: 501 }, (_, i) => ({ ...state.equity[0], at: new Date(Date.UTC(2024, 0, i + 1)).toISOString() }));
  const synced = await syncStockBriefingEquity(many, { token, apiUrl: "http://127.0.0.1:3000", fetchImpl: async (url, options) => {
    const data = JSON.parse(options.body); calls.push(data);
    assert.equal(url, "http://127.0.0.1:3000/api/sync/account-equity"); assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ ok: true, synced: data.series[0].points.length }));
  } });
  assert.equal(synced.synced, 501); assert.deepEqual(calls.map(c => c.series[0].points.length), [500, 1]);
  assert.equal(calls[0].series[0].points[0].collected_at, many.equity[0].at);
  await assert.rejects(syncStockBriefingEquity(state, { token, fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 409 }) }), /409/);
  await assert.rejects(syncStockBriefingEquity(state, { token: "bad", fetchImpl: async () => { throw Error("must not fetch"); } }), /TOKEN/);
  assert.equal((await syncStockBriefingEquity(legacy, { token, fetchImpl: async () => { throw Error("must not fetch"); } })).synced, 0);
  console.log("Account equity isolation, cash flows, safe projection, collection and sync: passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
