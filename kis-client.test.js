"use strict";

const assert = require("node:assert/strict");
const { KisClient, MOCK_BASE_URL } = require("./kis-client");

const calls = [];
let activeRequests = 0;
let maxActiveRequests = 0;
async function fakeFetch(url, options) {
  calls.push({ url, options });
  if (url.endsWith("/oauth2/tokenP")) {
    return new Response(JSON.stringify({ access_token: "token", token_type: "Bearer", expires_in: 86400 }));
  }
  const trId = options.headers.tr_id;
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  await new Promise((resolve) => setImmediate(resolve));
  activeRequests -= 1;
  if (trId === "VTTC8434R") return new Response(JSON.stringify({ rt_cd: "0", output1: [{ pdno: "005930", prdt_name: "삼성전자", hldg_qty: "3", ord_psbl_qty: "3", prpr: "80000", evlu_amt: "240000", pchs_amt: "210000", evlu_pfls_amt: "30000", evlu_pfls_rt: "14.28" }], output2: [{ nass_amt: "500000000", tot_evlu_amt: "500000000" }] }));
  if (trId === "VTTC8908R") return new Response(JSON.stringify({ rt_cd: "0", output: { nrcvb_buy_amt: "400000000" } }));
  if (["VTTC0012U", "VTTC0011U"].includes(trId)) return new Response(JSON.stringify({ rt_cd: "0", output: { ODNO: "1234" } }));
  if (trId === "VTTS3012R") return new Response(JSON.stringify({ rt_cd: "0", output1: [{ ovrs_pdno: "AAPL", ovrs_item_name: "Apple", ovrs_cblc_qty: "2", ord_psbl_qty: "2", now_pric2: "250", ovrs_stck_evlu_amt: "500", frcr_pchs_amt1: "400", frcr_evlu_pfls_amt: "100", evlu_pfls_rt: "25" }], output2: [] }));
  if (trId === "VTTS3007R") return new Response(JSON.stringify({ rt_cd: "0", output: { ovrs_ord_psbl_amt: "100000" } }));
  if (["VTTT1002U", "VTTT1001U"].includes(trId)) return new Response(JSON.stringify({ rt_cd: "0", output: { ODNO: "5678" } }));
  throw new Error(`unexpected ${trId}`);
}

(async () => {
  assert.throws(() => new KisClient({ appKey: "a", appSecret: "b", accountNo: "12345678", environment: "live" }), /모의투자/);
  assert.throws(() => new KisClient({ appKey: "a", appSecret: "b", accountNo: "123", environment: "mock" }), /8자리/);
  const client = new KisClient({ appKey: "a", appSecret: "b", accountNo: "12345678", productCode: "01", fetchImpl: fakeFetch, requestIntervalMs: 0 });
  assert.equal((await client.getDomesticBalance()).holdings[0].name, "삼성전자");
  assert.equal((await client.getDomesticCash({ symbol: "005930", price: 80000 })).orderableAmount, 400000000);
  assert.equal((await client.placeDomesticMarketOrder({ side: "BUY", symbol: "005930", quantity: 1 })).orderNo, "1234");
  assert.equal((await client.getUsBalance({ exchange: "ND" })).holdings[0].code, "AAPL");
  assert.equal((await client.getUsBalances(["ND", "NY"])).length, 2);
  await Promise.all([client.getUsBalance({ exchange: "ND" }), client.getUsBalance({ exchange: "NY" })]);
  assert.equal(maxActiveRequests, 1);
  assert.equal((await client.getUsCash({ exchange: "ND", symbol: "AAPL", price: 250 })).usd, 100000);
  assert.equal((await client.placeUsLimitOrder({ side: "SELL", exchange: "ND", symbol: "AAPL", quantity: 1, price: 250 })).orderNo, "5678");
  assert(calls.every((call) => call.url.startsWith(MOCK_BASE_URL)));
  assert.deepEqual(calls.filter((call) => !call.url.endsWith("tokenP")).map((call) => call.options.headers.tr_id), [
    "VTTC8434R", "VTTC8908R", "VTTC0012U", "VTTS3012R", "VTTS3012R", "VTTS3012R", "VTTS3012R", "VTTS3012R", "VTTS3007R", "VTTT1001U",
  ]);
  console.log("kis-client test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
