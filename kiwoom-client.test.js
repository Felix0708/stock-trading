"use strict";

const assert = require("node:assert/strict");
const { KiwoomClient, MOCK_BASE_URL } = require("./kiwoom-client");

const calls = [];
async function fakeFetch(url, options) {
  calls.push({ url, options });
  if (url.endsWith("/oauth2/token")) {
    return new Response(JSON.stringify({
      expires_dt: "20260810010000",
      token_type: "bearer",
      token: "test-access-token",
      return_code: 0,
      return_msg: "정상적으로 처리되었습니다",
    }));
  }
  if (options.headers["api-id"] === "kt00018") {
    return new Response(JSON.stringify({
      prsm_dpst_aset_amt: "+000000500000000",
      tot_evlt_amt: "000000000000000",
      tot_evlt_pl: "000000000000000",
      acnt_evlt_remn_indv_tot: [{
        stk_cd: "A005930", stk_nm: "삼성전자", rmnd_qty: "3", trde_able_qty: "3",
        cur_prc: "100000", evlt_amt: "300000", poss_rt: "0.06",
      }],
      return_code: 0,
      return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "kt00001") {
    return new Response(JSON.stringify({
      entr: "000000500000000", ord_alow_amt: "000000400000000", return_code: 0, return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "ka10001") {
    return new Response(JSON.stringify({
      stk_cd: "005930", stk_nm: "삼성전자", cur_prc: "+100000", open_pric: "+99000",
      high_pric: "+101000", low_pric: "+98000", flu_rt: "+1.01", trde_qty: "123456",
      return_code: 0, return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "ka20001") {
    const { mrkt_tp } = JSON.parse(options.body);
    return new Response(JSON.stringify(mrkt_tp === "0" ? {
      cur_prc: "-6869.83", pred_pre: "-108.11", flu_rt: "-1.55", trde_prica: "29644769",
      return_code: 0, return_msg: "",
    } : {
      cur_prc: "+1354.72", pred_pre: "+12.34", flu_rt: "+0.92", trde_prica: "10456789",
      return_code: 0, return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "ka10051") {
    const { mrkt_tp } = JSON.parse(options.body);
    return new Response(JSON.stringify({
      inds_netprps: [mrkt_tp === "0" ? {
        inds_nm: "종합(KOSPI)", ind_netprps: "+11890", frgnr_netprps: "+515", orgn_netprps: "-11875",
      } : {
        inds_nm: "종합(KOSDAQ)", ind_netprps: "-1420", frgnr_netprps: "+830", orgn_netprps: "+610",
      }],
      return_code: 0, return_msg: "",
    }));
  }
  if (["kt10000", "kt10001"].includes(options.headers["api-id"])) {
    return new Response(JSON.stringify({ ord_no: "00024", return_code: 0, return_msg: "주문 접수" }));
  }
  if (options.headers["api-id"] === "ka10076") {
    return new Response(JSON.stringify({
      cntr: [{
        ord_no: "00024", orig_ord_no: "00000", stk_cd: "005930", io_tp_nm: "+매수",
        ord_qty: "1", cntr_qty: "1", oso_qty: "0", cntr_pric: "100000", ord_stt: "체결",
      }],
      return_code: 0,
      return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "ust21070") {
    return new Response(JSON.stringify({
      crnc_code: "USD",
      tot_evlt_amt: "0.0000",
      tot_pl_amt: "0.0000",
      result_list: [{
        stk_cd: "AAPL", frgn_stk_nm: "Apple", stex_nm: "NASDAQ", poss_qty: "2", sell_alowq: "2",
        now_pric: "250.0000", evlt_amt: "500.0000",
      }],
      return_code: 0,
      return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "ust21160") {
    return new Response(JSON.stringify({
      won_entr: "000000000000000",
      d0_usd_fx_entr: "100000.000",
      usd_exch_rate: "1,507.70",
      return_code: 0,
      return_msg: "",
    }));
  }
  if (options.headers["api-id"] === "usa20100") {
    return new Response(JSON.stringify({
      stex_tp: "NY", stk_cd: "DELL", stk_nm: "Dell Technologies", cur_prc: "459.1200",
      base_close_pric: "468.1700", open_pric: "462.0000", high_pric: "465.0000", low_pric: "455.5000",
      flu_rt: "-1.93", acc_trde_qty: "123456", return_code: 0, return_msg: "",
    }));
  }
  if (["ust20000", "ust20001"].includes(options.headers["api-id"])) {
    return new Response(JSON.stringify({ ord_no: "000000282", return_code: 0, return_msg: "주문 접수" }));
  }
  if (options.headers["api-id"] === "ust20003") {
    return new Response(JSON.stringify({ ord_no: "000000285", cncl_ord_qty: "1", return_code: 0, return_msg: "취소 접수" }));
  }
  if (options.headers["api-id"] === "ust21510") {
    return new Response(JSON.stringify({
      result_list: [{
        ord_no: "000000282",
        orig_ord_no: "000000000",
        stk_cd: "AAPL",
        slby_tp: "2",
        ord_qty: "000000000001",
        cntr_qty: "000000000001",
        ord_remnq: "000000000000",
        cntr_uv: "250.0000",
        ord_stat: "체결",
      }],
      return_code: 0,
      return_msg: "",
    }));
  }
  return new Response(JSON.stringify({ acctNo: "1234567890", return_code: 0, return_msg: "" }));
}

(async () => {
  assert.throws(() => new KiwoomClient(), /App Key/);
  assert.throws(() => new KiwoomClient({ appKey: "a", secretKey: "b", environment: "live" }), /모의투자/);

  const client = new KiwoomClient({ appKey: "app-key", secretKey: "secret-key", fetchImpl: fakeFetch });
  assert.equal(await client.getDomesticAccountNumber(), "1234567890");
  assert.deepEqual(await client.getDomesticBalance(), {
    estimatedAssets: 500000000,
    totalEvaluation: 0,
    totalProfitLoss: 0,
    holdings: [{
      code: "A005930", name: "삼성전자", quantity: 3, tradableQuantity: 3,
      currentPrice: 100000, evaluationAmount: 300000, positionRatio: 0.06,
    }],
  });
  assert.deepEqual(await client.getDomesticCash(), { deposit: 500000000, orderableAmount: 400000000 });
  assert.deepEqual(await client.getDomesticQuote({ symbol: "005930" }), {
    symbol: "005930", name: "삼성전자", currentPrice: 100000,
    dayOpen: 99000, dayHigh: 101000, dayLow: 98000, changeRate: 1.01, volume: 123456,
  });
  assert.deepEqual(await client.placeDomesticMarketOrder({ side: "BUY", symbol: "005930", quantity: 1 }), {
    status: "ACCEPTED", orderNo: "00024", side: "BUY", symbol: "005930", orderQuantity: 1,
  });
  assert.deepEqual(await client.placeDomesticMarketOrder({ side: "SELL", symbol: "005930", quantity: 1 }), {
    status: "ACCEPTED", orderNo: "00024", side: "SELL", symbol: "005930", orderQuantity: 1,
  });
  assert.deepEqual(await client.getDomesticOrderExecutions({ symbol: "005930" }), [{
    orderNo: "00024", originalOrderNo: "00000", symbol: "005930", side: "BUY",
    status: "FILLED", rawStatus: "체결", orderQuantity: 1, filledQuantity: 1,
    remainingQuantity: 0, fillPrice: 100000,
  }]);
  assert.deepEqual(await client.getUsBalance(), {
    currency: "USD",
    totalEvaluation: 0,
    totalProfitLoss: 0,
    holdings: [{
      code: "AAPL", name: "Apple", exchange: "NASDAQ", quantity: 2, tradableQuantity: 2,
      currentPrice: 250, evaluationAmount: 500,
    }],
  });
  assert.deepEqual(await client.getUsCash(), { usd: 100000, krw: 0, usdExchangeRate: 1507.7 });
  assert.deepEqual(await client.getUsQuote({ exchange: "NY", symbol: "DELL" }), {
    exchange: "NY", symbol: "DELL", name: "Dell Technologies", currentPrice: 459.12,
    previousClose: 468.17, dayOpen: 462, dayHigh: 465, dayLow: 455.5,
    changeRate: -1.93, volume: 123456,
  });
  await assert.rejects(() => client.placeUsLimitOrder({ side: "BUY", exchange: "XX", symbol: "AAPL", quantity: 1, price: 250 }), /거래소/);
  assert.deepEqual(await client.placeUsLimitOrder({ side: "BUY", exchange: "ND", symbol: "AAPL", quantity: 1, price: 0.5 }), {
    status: "ACCEPTED", orderNo: "000000282", side: "BUY", symbol: "AAPL",
  });
  assert.deepEqual(await client.placeUsLimitOrder({ side: "SELL", exchange: "ND", symbol: "AAPL", quantity: 1, price: 260 }), {
    status: "ACCEPTED", orderNo: "000000282", side: "SELL", symbol: "AAPL",
  });
  assert.deepEqual(await client.getUsOrderExecutions({ symbol: "AAPL" }), [{
    orderNo: "000000282",
    originalOrderNo: "000000000",
    symbol: "AAPL",
    side: "BUY",
    status: "FILLED",
    rawStatus: "체결",
    orderQuantity: 1,
    filledQuantity: 1,
    remainingQuantity: 0,
    fillPrice: 250,
  }]);
  assert.deepEqual(await client.cancelUsOrder({ orderNo: "000000282", exchange: "ND", symbol: "AAPL" }), {
    status: "CANCEL_REQUESTED", orderNo: "000000282", cancellationOrderNo: "000000285", symbol: "AAPL",
  });
  assert.deepEqual(await client.getDomesticMarketClose({ date: "20260818" }), {
    date: "20260818",
    markets: [{
      name: "KOSPI", index: 6869.83, change: -108.11, changeRate: -1.55,
      turnoverMillionKrw: 29644769, individualNetBuyBillionKrw: 11890,
      foreignNetBuyBillionKrw: 515, institutionNetBuyBillionKrw: -11875,
    }, {
      name: "KOSDAQ", index: 1354.72, change: 12.34, changeRate: 0.92,
      turnoverMillionKrw: 10456789, individualNetBuyBillionKrw: -1420,
      foreignNetBuyBillionKrw: 830, institutionNetBuyBillionKrw: 610,
    }],
  });
  assert.equal(calls.length, 19);
  assert.equal(calls[0].url, `${MOCK_BASE_URL}/oauth2/token`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    grant_type: "client_credentials",
    appkey: "app-key",
    secretkey: "secret-key",
  });
  assert.equal(calls[1].url, `${MOCK_BASE_URL}/api/dostk/acnt`);
  assert.equal(calls[1].options.headers["api-id"], "ka00001");
  assert.equal(calls[1].options.headers.authorization, "Bearer test-access-token");
  assert.equal(calls[2].options.headers["api-id"], "kt00018");
  assert.deepEqual(JSON.parse(calls[2].options.body), { qry_tp: "1", dmst_stex_tp: "KRX" });
  assert.equal(calls[3].options.headers["api-id"], "kt00001");
  assert.deepEqual(JSON.parse(calls[3].options.body), { qry_tp: "2" });
  assert.equal(calls[4].options.headers["api-id"], "ka10001");
  assert.deepEqual(JSON.parse(calls[4].options.body), { stk_cd: "005930" });
  assert.equal(calls[5].options.headers["api-id"], "kt10000");
  assert.deepEqual(JSON.parse(calls[5].options.body), { dmst_stex_tp: "KRX", stk_cd: "005930", ord_qty: "1", ord_uv: "", trde_tp: "3", cond_uv: "" });
  assert.equal(calls[6].options.headers["api-id"], "kt10001");
  assert.equal(calls[7].options.headers["api-id"], "ka10076");
  assert.deepEqual(JSON.parse(calls[7].options.body), { stk_cd: "005930", qry_tp: "1", sell_tp: "0", ord_no: "", stex_tp: "1" });
  assert.equal(calls[8].options.headers["api-id"], "ust21070");
  assert.deepEqual(JSON.parse(calls[8].options.body), { stex_tp: "", stk_cd: "" });
  assert.equal(calls[9].options.headers["api-id"], "ust21160");
  assert.equal(calls[10].options.headers["api-id"], "usa20100");
  assert.deepEqual(JSON.parse(calls[10].options.body), { stex_tp: "NY", stk_cd: "DELL" });
  assert.equal(calls[11].options.headers["api-id"], "ust20000");
  assert.deepEqual(JSON.parse(calls[11].options.body), { stex_tp: "ND", stk_cd: "AAPL", ord_qty: "1", ord_uv: "0.5000", trde_tp: "00" });
  assert.equal(calls[12].options.headers["api-id"], "ust20001");
  assert.deepEqual(JSON.parse(calls[12].options.body), { stex_tp: "ND", stk_cd: "AAPL", ord_qty: "1", ord_uv: "260.00", trde_tp: "00", stop_pric: "" });
  assert.equal(calls[13].options.headers["api-id"], "ust21510");
  assert.equal(calls[14].options.headers["api-id"], "ust20003");
  assert.deepEqual(JSON.parse(calls[14].options.body), { orig_ord_no: "000000282", stex_tp: "ND", stk_cd: "AAPL" });
  assert.equal(calls[15].options.headers["api-id"], "ka20001");
  assert.deepEqual(JSON.parse(calls[15].options.body), { mrkt_tp: "0", inds_cd: "001" });
  assert.equal(calls[16].options.headers["api-id"], "ka10051");
  assert.equal(calls[17].options.headers["api-id"], "ka20001");
  assert.deepEqual(JSON.parse(calls[17].options.body), { mrkt_tp: "1", inds_cd: "101" });
  assert.equal(calls[18].options.headers["api-id"], "ka10051");
  console.log("kiwoom-client test OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
