"use strict";
const assert = require("node:assert/strict");
const { currencyTotal, collectKiwoomTotal } = require("../src/brokers/account-equity");
const { assetReaderBrokers } = require("../src/executor/asset-reader");
(async () => {
  const at = new Date().toISOString();
  const d = { scope:"domestic",equity:1000,cash:600,stockValue:400,equityProof:{observedAt:at,d0Cash:600,clear:true} };
  const u = { scope:"overseas",equity:100,cash:90,stockValue:10,equityProof:{observedAt:at,wonCash:600,rate:1300,clear:true} };
  const broker = {id:"KIWOOM",environment:"live",selectedCurrencies:true,
    domesticClient:{post:async()=>({acctNo:"1234567890"})},
    overseasClient:{post:async(_p,o)=>o.apiId==="ka00001"?{acctNo:"1234567890"}:{result_list:[{crnc_code:"USD"},
      {crnc_code:"CNY",fx_entr:"600000",evlt_amt:"0"},
      {crnc_code:"JPY",fx_entr:"10000",evlt_amt:"2000",chg_entr:"90000",chg_evlt_amt:"18000"}]}}};
  const total = await collectKiwoomTotal(broker,[d,u]);
  assert.equal(total.equity,239000); assert.equal(total.cash,207600); assert.equal(total.currency_breakdown.length,3);
  assert.equal(total.currency_breakdown[0].cash,600); // Shared KRW cash counted once.
  assert.equal(total.currency_breakdown[2].stock_value,2000);
  assert.throws(()=>currencyTotal([...total.currency_breakdown.slice(0,2),total.currency_breakdown[0]]));
  assert.throws(()=>currencyTotal(total.currency_breakdown.map(r=>({...r,cash:NaN}))));
  const clients = assetReaderBrokers({KIWOOM_LIVE_APP_KEY:"test",KIWOOM_LIVE_SECRET_KEY:"test",
    KIS_LIVE_APP_KEY:"test",KIS_LIVE_APP_SECRET:"test",KIS_LIVE_ACCOUNT_NO:"12345678-01"});
  assert.equal(clients.length,2); assert.ok(clients.every(b=>b.environment==="live"&&b.selectedCurrencies));
  assert.equal(assetReaderBrokers({KIWOOM_DOMESTIC_APP_KEY:"legacy",KOREA_INVESTMENT_APP_KEY:"legacy"}).length,0);
  assert.throws(()=>clients[0].overseasClient.post("/api/us/ordr",{apiId:"ust10000"}),/차단/);
  assert.throws(()=>clients[1].overseasClient.request("/uapi/overseas-stock/v1/trading/order",{method:"POST"}),/차단/);
  assert.throws(()=>clients[1].overseasClient.request("/uapi/overseas-stock/v1/trading/inquire-balance",{method:"POST"}),/차단/);
  const kis = clients[1].overseasClient;
  kis.request = async(path,o) => path.includes('domestic-stock') ? {output1:[{evlu_amt:'400'}],output2:[{scts_evlu_amt:'400'}]}
    : {output1:[{ovrs_pdno:o.params.TR_CRCY_CD==='JPY'?'7203':'TEST',tr_crcy_cd:o.params.TR_CRCY_CD,ovrs_stck_evlu_amt:o.params.TR_CRCY_CD==='JPY'?'2000':'10'}]};
  const present = {output2:[{crcy_cd:'USD',frcr_dncl_amt_2:'90',frst_bltn_exrt:'1300'},
    {crcy_cd:'JPY',frcr_dncl_amt_2:'10000',frst_bltn_exrt:'900',frcr_drwg_psbl_amt_1:'10000',frcr_evlu_amt2:'90000'}]};
  const summary = {cma_evlu_amt:'0',tot_dncl_amt:'600',tot_asst_amt:'239000'};
  const kisTotal = await kis.getSelectedCurrencyEquity(present,summary);
  assert.equal(kisTotal.equity,239000); // Exchange duplication is not double-counted, JPY /100 is verified.
  await assert.rejects(kis.getSelectedCurrencyEquity(present,{...summary,tot_asst_amt:'999999'}),/대조 실패/);
  await assert.rejects(kis.getSelectedCurrencyEquity({output2:present.output2.slice(0,1)},summary),/예수금·환율 미확인/);
  const {equityPerformance}=require('../src/executor/equity-performance');
  assert.equal(equityPerformance({equity:[{brokerId:'KIS',environment:'live',currency:'KRW',scope:'account-total-assets',at:'2026-09-01'},
    {brokerId:'KIS',environment:'live',currency:'KRW',scope:'account-total-assets',at:'2026-09-02',currency_breakdown:[]}]},'KIS','live','KRW').status,'scope_unverified');
  console.log("asset-reader tests passed");
})().catch(e=>{console.error(e);process.exitCode=1});
