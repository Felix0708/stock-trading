"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { reconciliationPlan, settlementCosts, collectBrokerEvidence, applyEvidence, validateStatement, readEvidence, writeEvidence } = require("../src/executor/account-evidence");
const { equityPerformance, importCashFlows } = require("../src/executor/equity-performance");
const { recordAlertReceipt, confirmAlert, applyAlertSnapshot, alertEvidenceSummary } = require("../src/signals/alert-evidence");
const { policyFingerprint, assertLivePolicy, recordForwardStudy } = require("../src/trading/policy-study");
const { KiwoomClient } = require("../src/brokers/kiwoom-client");
const { KisClient } = require("../src/brokers/kis-client");
const { OrderTracker } = require("../src/trading/order-tracker");
const { probe, monitor, marker } = require("../scripts/monitor-health.cjs");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stock-evidence-test-"));
  const tracker = new OrderTracker(path.join(root, "orders.json"));
  const order = tracker.record({ orderNo: "007016", requestId: "old-exit", status: "EXPIRED", symbol: "SE", side: "SELL", market: "NYSE", environment: "mock", createdAt: "2026-08-17T17:30:20Z", orderQuantity: 51, filledQuantity: 0 });
  const row = { orderNo: "7016", symbol: "SE", side: "SELL", date: "20260818", orderQuantity: 51, filledQuantity: 51, remainingQuantity: 0, fillPrice: 130, filledAt: "2026-08-18T03:30:21+09:00", source: "test broker statement" };
  assert.equal(reconciliationPlan([order], [], "mock").updates.length, 0);
  assert.equal(reconciliationPlan([order], [{ ...row, date: "20260819" }], "mock").updates.length, 0);
  for (const bad of [{ ...row, filledQuantity: 52 }, { ...row, remainingQuantity: 1 }, { ...row, fillPrice: 0 }]) assert.equal(reconciliationPlan([order], [bad], "mock").updates.length, 0);
  assert.equal(reconciliationPlan([order], [row, row], "mock").conflicts.length, 1);
  assert.equal(reconciliationPlan([order], [row], "live").updates.length, 0);
  assert.equal(reconciliationPlan([{ ...order, orderStyle: "BROKER_STOP" }], [row], "mock").updates.length, 0); // Stricter protection manager owns STOP state.
  const usDateRow = { ...row, date: "20260817", orderTime: "02:30:21", filledAt: null, source: "KIWOOM:ust21150:20260817" };
  const dateFix = reconciliationPlan([order], [usDateRow], "mock").updates[0];
  assert.equal(dateFix.filledQuantity, 51); assert.equal(dateFix.evidenceFilledAt, null); assert.equal(dateFix.historicalFillDate, null);
  assert.equal(dateFix.expirationReason, null); assert.equal(dateFix.resultAt, null);
  assert.equal(reconciliationPlan([order], [{ ...usDateRow, orderTime: "04:30:21" }], "mock").updates.length, 0);
  assert.equal(reconciliationPlan([order], [{ ...usDateRow, date: "20260816" }], "mock").updates.length, 0);
  const broker = { id: "KIWOOM", environment: "mock", tracker };
  const report = { brokerId: "KIWOOM", environment: "mock", capturedAt: "2026-09-07T00:00:00Z", reconciliation: reconciliationPlan([order], [row], "mock"), costs: { updates: [] } };
  const file = path.join(root, "evidence.json");
  assert.equal(applyEvidence(broker, report, file), 1);
  assert.equal(tracker.list()[0].filledQuantity, 51);
  assert.equal(tracker.list()[0].lastFillAt, row.filledAt);
  assert.equal(readEvidence(file).adjustments.length, 1);
  assert.throws(() => applyEvidence(broker, report, file), /다시 조회/);
  assert.throws(() => applyEvidence({ ...broker, environment: "live" }, report, file), /환경/);
  assert.equal(validateStatement({ version: 1, brokerId: "KIWOOM", environment: "mock", source: "statement 20260818", executions: [row] }, broker).length, 1);
  assert.throws(() => validateStatement({ version: 1, brokerId: "KIS", environment: "mock", source: "statement 20260818", executions: [row] }, broker));
  const trade = { ...order, filledQuantity: 51, fillPrice: 130 };
  const transaction = { stk_cd: "SE", deal_dt: "20260818", rmrk_nm: "매도", deal_qty: "51", uv_exrt: "130", crnc_code: "USD", fc_cmsn: "1", fc_deal_tax: "0.1", deal_no: "abc" };
  assert.equal(settlementCosts("KIWOOM", [transaction], [trade]).updates[0].executionCosts.total, 1.1);
  assert.equal(settlementCosts("KIWOOM", [{ ...transaction, fc_deal_tax: "" }], [trade]).updates.length, 0);
  assert.equal(settlementCosts("KIWOOM", [transaction, { ...transaction, deal_no: "def" }], [trade]).updates.length, 0);
  assert.equal(settlementCosts("KIWOOM", [transaction], [trade, { ...trade, orderNo: "9" }]).updates.length, 0);
  const kisSettlement = { pdno: "SE", trad_dt: "20260818", sll_buy_dvsn_cd: "01", ccld_qty: "51", ft_ccld_unpr2: "130", crcy_cd: "USD", dmst_frcr_fee1: "1", frcr_fee1: "0.1", tr_frcr_amt2: "6630", frcr_excc_amt_1: "6628.7" };
  assert.ok(Math.abs(settlementCosts("KIS", [kisSettlement], [trade]).updates[0].executionCosts.total - 1.3) < 1e-8);

  // A later failed page/exchange must never turn a partial statement into a complete one.
  const historyScopes = [], transactionScopes = [];
  const api = { getDomesticBalance: async () => ({ holdings: [] }), getUsBalances: async () => [{ holdings: [] }],
    getUsHistoricalExecutions: async (scope): Promise<any[]> => { historyScopes.push(scope); throw Error("unavailable history"); },
    getUsTransactions: async (scope) => { transactionScopes.push(scope); if (scope.exchange === "NY") throw Error("unavailable page"); return [transaction]; },
    getUsEquityHistory: async () => { throw Error("unsupported equity"); } };
  const mismatch = { ...broker, tracker: { list: () => [{ ...trade, side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240" }] }, domesticClient: api, overseasClient: api };
  const collected = await collectBrokerEvidence(mismatch);
  assert.equal(collected.historyErrors.length, 1); assert.deepEqual(collected.executions, []); assert.deepEqual(collected.transactions, []);
  assert.equal(collected.remainingDiscrepancies[0].managedQuantity, 51);
  assert.equal(historyScopes[0].symbol, "SE"); assert.equal(transactionScopes[0].symbol, "SE");
  historyScopes.length = 0; transactionScopes.length = 0;
  api.getUsHistoricalExecutions = async (scope) => { historyScopes.push(scope); return []; };
  const twoSymbols = { ...mismatch, tracker: { list: () => [
    { ...trade, symbol: "ZETA", market: "NASDAQ", side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240" },
    ...mismatch.tracker.list(), { ...trade, orderNo: "other", symbol: "BE", market: "NYSE", side: "BUY", entryType: "PAPER_ENTRY", timeframe: "240" }] } };
  const partial = await collectBrokerEvidence(twoSymbols);
  assert.deepEqual(historyScopes.map(s => s.symbol), ["ZETA", "ZETA", "SE", "SE", "BE", "BE"]); // KST and US dates, each ticker.
  assert.deepEqual(transactionScopes.map(s => s.symbol), ["ZETA", "SE"]);
  assert.deepEqual(partial.transactions, []); // Discard the first symbol's rows when the next fails.

  const kis = new KisClient({ appKey: "a", appSecret: "b", accountNo: "12345678", requestIntervalMs: 0 });
  const pages = []; kis.request = async (_path, options) => { pages.push(options); return pages.length === 1
    ? { output1: [{ n: 1 }], continuation: true, ctx_area_fk200: "first", ctx_area_nk200: "next" } : { output1: [{ n: 2 }], continuation: false }; };
  assert.equal((await kis.getUsHistoryPages("test", "id", {})).length, 2); assert.equal(pages[1].trCont, "N"); assert.equal(pages[1].params.CTX_AREA_NK200, "next");
  kis.request = async () => ({ output1: [], continuation: true, ctx_area_fk200: "first", ctx_area_nk200: "same" });
  await assert.rejects(kis.getUsHistoryPages("test", "id", {}), /연속조회/);
  await assert.rejects(kis.getUsTransactions({ startDate: "20260801", endDate: "20260802" }), /모의/);
  const kiwoom = new KiwoomClient({ appKey: "a", secretKey: "b" });
  const kwPages = []; kiwoom.post = async (_path, options) => { kwPages.push(options); return { result_list: [kwPages.length], pagination: { more: kwPages.length === 1, next: "next" } }; };
  assert.deepEqual(await kiwoom.getUsAccountHistory("ust21100", {}), [1, 2]); assert.equal(kwPages[1].continuation, "next");
  kiwoom.post = async () => ({ result_list: [], pagination: { more: true, next: "" } });
  await assert.rejects(kiwoom.getUsAccountHistory("ust21100", {}), /연속조회/);

  const state = { equity: [100, 150, 135].map((equity, i) => ({ brokerId: "KIS", environment: "mock", currency: "USD", scope: "overseas", at: `2026-08-0${i + 1}T00:00:00Z`, equity })), cashFlows: [], cashFlowCoverage: [] };
  assert.equal(equityPerformance(state, "KIS", "mock", "USD").returnRate, null);
  importCashFlows(state, { source: "complete statement", cashFlowCoverage: { currency: "USD", scope: "overseas", start: "2026-08-01T00:00:00Z", end: "2026-08-03T00:00:00Z" }, cashFlows: [{ id: "deposit", at: "2026-08-02T00:00:00Z", amount: 50 }] }, { id: "KIS", environment: "mock" });
  const perf = equityPerformance(state, "KIS", "mock", "USD");
  assert.ok(Math.abs(perf.returnRate + 10) < 1e-8); assert.ok(Math.abs(perf.maxDrawdownRate - 10) < 1e-8);
  assert.equal(equityPerformance(state, "KIS", "live", "USD").returnRate, null);

  const alertEvidence = {}, items = [{ exchange: "NASDAQ", ticker: "NVDA" }], now = new Date("2026-09-07T00:00:00Z");
  assert.equal(alertEvidenceSummary(items, alertEvidence, now).verified, 0);
  confirmAlert(alertEvidence, "!alerts verify NASDAQ:NVDA 240 test-id 2026-09-20", now);
  assert.equal(alertEvidenceSummary(items, alertEvidence, now).verified, 1);
  assert.equal(alertEvidenceSummary(items, alertEvidence, new Date("2026-09-15T00:00:00Z")).verified, 0);
  recordAlertReceipt(alertEvidence, { validation: { ok: true }, receivedAt: now.toISOString(), requestId: "r", payload: { ...items[0], timeframe: "1D" } });
  assert.equal(alertEvidenceSummary(items, alertEvidence, now).verified, 1); // Receipt does not prove currently active.
  applyAlertSnapshot(alertEvidence, items, { capturedAt: now.toISOString(), source: "TradingView alert manager visible UI", rows: [{ ticker: "NVDA", timeframe: "1D", status: "Active" }] }, now);
  assert.equal(alertEvidenceSummary(items, alertEvidence, now).verified, 2);
  const hash = policyFingerprint({}); assert.equal(hash.length, 64); assert.throws(() => assertLivePolicy({ KIS: "live" }, false, hash, {}));
  assertLivePolicy({ KIS: "mock" }, false, hash, {}); assertLivePolicy({ KIS: "live" }, false, hash, { ACCOUNT_APPROVED_POLICY_HASH: hash });
  const studyFile = path.join(root, "forward.json"), at = new Date().toISOString();
  const signal = { requestId: "future-1", receivedAt: at, validation: { ok: true }, payload: { ticker: "NVDA", exchange: "NASDAQ", timeframe: "240", action: "BUY", price: 100, sb_z_score: 3 }, outcome: { decision: "ENTRY_CANDIDATE" }, risk: { verdict: "PAPER_ENTRY" } };
  assert.equal(recordForwardStudy(studyFile, signal, { recovered: true }), false);
  assert.equal(recordForwardStudy(studyFile, signal), true); assert.equal(recordForwardStudy(studyFile, signal), false);
  const study = JSON.parse(fs.readFileSync(studyFile)); assert.equal(study.observations[0].comparison.liveSigmaCeiling25, false); assert.equal(study.observations[0].comparison.mockSigmaCeiling35, true);

  assert.equal(await probe("https://example.com/health", async () => new Response('{"ok":true}')), true);
  assert.equal(await probe("https://example.com/health", async () => new Response('{"ok":false}')), false);
  assert.equal(await probe("https://example.com/order", () => { throw Error("must not fetch"); }), false);
  let incident = null, sent = 0, healthy = false;
  const env = { MONITOR_HEALTH_URL: "https://example.com/health", MONITOR_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/123/test", GITHUB_TOKEN: "test", GITHUB_REPOSITORY: "test/repo" };
  const mockFetch = async (url, opts: any = {}) => {
    url = String(url);
    if (url === env.MONITOR_HEALTH_URL) return new Response(JSON.stringify({ ok: healthy }));
    if (url.startsWith("https://discord.com/")) { sent++; return new Response('{}'); }
    if (!opts.method || opts.method === "GET") return new Response(JSON.stringify(incident && incident.state !== "closed" ? [incident] : []));
    const data = JSON.parse(opts.body);
    if (opts.method === "POST") incident = { ...data, number: 1, user: { login: "github-actions[bot]" } };
    else Object.assign(incident, data);
    return new Response(JSON.stringify(incident));
  };
  await monitor(env, mockFetch); assert.equal(sent, 1); assert.ok(incident.body.startsWith(marker));
  await monitor(env, mockFetch); assert.equal(sent, 1); healthy = true;
  await monitor(env, mockFetch); assert.equal(sent, 2); assert.equal(incident.state, "closed");
  await monitor(env, mockFetch); assert.equal(sent, 2);
  fs.rmSync(root, { recursive: true }); // Own isolated, generated fixture only.
  console.log("operating evidence tests OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
