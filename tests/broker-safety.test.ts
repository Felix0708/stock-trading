"use strict";
const assert = require("node:assert/strict");
const { KisClient } = require("../src/brokers/kis-client");
const { KiwoomClient } = require("../src/brokers/kiwoom-client");

(async () => {
  const calls = [];
  const kis = new KisClient({ appKey: "test", appSecret: "test", accountNo: "12345678", requestIntervalMs: 0, fetchImpl: async (url, options) => {
    if (url.endsWith("tokenP")) return new Response(JSON.stringify({ access_token: "fake", expires_in: 86400 }));
    calls.push({ url, ...options });
    const output = url.includes("inquire-ccnl") ? [{ odno: "1", pdno: "TEST", ft_ord_qty: "5", ft_ccld_qty: "2", nccs_qty: 0 }]
      : url.includes("inquire-price") ? { stck_prpr: "100" } : { ODNO: "123" };
    return new Response(JSON.stringify({ rt_cd: "0", output }));
  } });
  assert.equal((await kis.getDomesticQuote({ symbol: "005930" })).currentPrice, 100);
  const partial = (await kis.getUsOrderExecutions())[0];
  assert.equal(partial.status, "CANCELLED"); assert.equal(partial.filledQuantity, 2); assert.equal(partial.remainingQuantity, 0);
  await kis.cancelUsOrder({ orderNo: "1", exchange: "ND", symbol: "TEST", quantity: 3 });
  const cancel = calls.at(-1);
  assert.equal(cancel.headers.tr_id, "VTTT1004U");
  assert.equal(JSON.parse(cancel.body).RVSE_CNCL_DVSN_CD, "02");
  assert.equal(JSON.parse(cancel.body).ORD_QTY, "3");
  await assert.rejects(kis.cancelDomesticOrder({ orderNo: "1", symbol: "005930" }), /미지원/);

  for (const kind of ["kis", "kiwoom"]) {
    for (const failure of ["missing-id", "body-disconnected"]) {
      let posts = 0;
      const fetchImpl = async (url) => {
        if (url.endsWith("tokenP")) return new Response(JSON.stringify({ access_token: "fake", expires_in: 86400 }));
        if (url.endsWith("/token")) return new Response(JSON.stringify({ return_code: 0, token: "fake", expires_dt: "20990101000000" }));
        posts++;
        if (failure === "body-disconnected") return { ok: true, status: 200, text: async () => { throw new Error("body read failed"); } };
        return new Response(JSON.stringify(kind === "kis" ? { rt_cd: "0", output: {} } : { return_code: 0 }));
      };
      const client = kind === "kis" ? new KisClient({ appKey: "test", appSecret: "test", accountNo: "12345678", fetchImpl, requestIntervalMs: 0 })
        : new KiwoomClient({ appKey: "test", secretKey: "test", fetchImpl });
      await assert.rejects(client.placeUsLimitOrder({ side: "BUY", exchange: "ND", symbol: "TEST", quantity: 1, price: 100 }), e => e.orderStatusUnknown === true);
      assert.equal(posts, 1);
      await assert.rejects(client.placeUsLimitOrder({ side: "BUY", exchange: "ND", symbol: "TEST", quantity: 1, price: 100, canSubmit: () => false }), e => e.autoTradingPaused === true);
      assert.equal(posts, 1);
    }
  }
  console.log("broker-safety test OK: cancellation, partial fill, unknown acknowledgements");
})().catch(error => { console.error(error); process.exitCode = 1; });
