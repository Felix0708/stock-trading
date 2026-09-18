"use strict";
const assert = require("node:assert/strict");
const { currencyTotal, collectKiwoomTotal } = require("../src/brokers/account-equity");
const { assetReaderBrokers } = require("../src/executor/asset-reader");
(async () => {
  const {holdingSnapshot}=require('../src/executor/live-holdings');
  const live={id:'KIS',environment:'live'};
  const balance=[{holdings:[{code:'A005930',name:'삼성전자',quantity:10,purchaseAmount:500000}]}];
  const orders=[{symbol:'005930',market:'KRX',environment:'live',side:'BUY',entryType:'PAPER_ENTRY',filledQuantity:3,fillPrice:50000}];
  assert.equal(holdingSnapshot(live,'KR',balance,orders).holdings[0].automated_quantity,3);
  assert.equal(holdingSnapshot(live,'KR',balance,null).holdings[0].automated_quantity,null);
  assert.equal(holdingSnapshot(live,'KR',balance,[{...orders[0],filledQuantity:11}]).holdings[0].automated_quantity,null);
  assert.equal(holdingSnapshot(live,'KR',[{holdings:[]}],orders).holdings.length,0);
  assert.throws(()=>holdingSnapshot(live,'KR',[{holdings:[{...balance[0].holdings[0],purchaseAmount:undefined}]}],orders));
  const {accountCollectionStatuses}=require('../src/integrations/account-equity');
  assert.equal(accountCollectionStatuses({equityAccounts:{'group:KIWOOM:live:test':'id'},equity:[],equityTotalFailures:{id:{at:new Date().toISOString(),code:'ip_not_registered'}}})[0].code,'ip_not_registered');
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
  const {collectIsaEquity}=require('../src/brokers/isa-equity');
  const {accountEquitySeries}=require('../src/integrations/account-equity');
  const {recordAccountEquity,readEvidence}=require('../src/executor/account-evidence');
  for(const id of ['KIS','KIWOOM']) {
    const config={ISA_BROKER:id,KIS_ISA_APP_KEY:'isa-key',KIS_ISA_APP_SECRET:'isa-secret',KIS_ISA_ACCOUNT_NO:'12345678-01',KIWOOM_ISA_APP_KEY:'isa-key',KIWOOM_ISA_SECRET_KEY:'isa-secret'};
    const isa=assetReaderBrokers(config)[0];assert.equal(isa.accountKind,'isa');assert.equal(isa.environment,'live');
    if(id==='KIS') {
      assert.throws(()=>isa.domesticClient.request('/uapi/domestic-stock/v1/trading/order',{method:'POST'}),/차단/);
      isa.domesticClient.request=async()=>({output2:[{nass_amt:'1000',scts_evlu_amt:'600',prvs_rcdl_excc_amt:'400',dnca_tot_amt:'99999',tot_loan_amt:'0'}],output1:[{pdno:'005930',prdt_name:'삼성전자',hldg_qty:'2',evlu_amt:'600'}]});
    } else {
      assert.throws(()=>isa.domesticClient.post('/api/dostk/ordr',{apiId:'kt10000'}),/차단/);
      assert.throws(()=>isa.domesticClient.post('/api/us/acnt',{apiId:'ust21120'}),/차단/);
      isa.domesticClient.post=async(_p,o)=>o.apiId==='kt00001'?{d2_entra:'400'}:{prsm_dpst_aset_amt:'1000',tot_evlt_amt:'600',tot_loan_amt:'0',tot_crd_loan_amt:'0',tot_crd_ls_amt:'0',acnt_evlt_remn_indv_tot:[{stk_cd:'A005930',stk_nm:'삼성전자',rmnd_qty:'2',evlt_amt:'600'}]};
    }
    const point=await collectIsaEquity(isa);assert.equal(point.equity,1000);assert.equal(point.cash,400);assert.equal(point.isa_holdings.length,1);
    const state=readEvidence('/nonexistent-isa-fixture');recordAccountEquity(state,isa,[point],new Date().toISOString());
    const series=accountEquitySeries(state)[0];assert.equal(series.account_kind,'isa');assert.equal(series.account_type,'live');assert.equal(series.points[0].isa_holdings[0].code,'005930');
    await assert.rejects(collectIsaEquity({...isa,environment:'mock'}));
    if(id==='KIS') {
      isa.domesticClient.request=async()=>({continuation:true,output2:[{}],output1:[]});
      await assert.rejects(collectIsaEquity(isa),/確認|확인/);
      assert.throws(()=>assetReaderBrokers({...config,KIS_LIVE_ACCOUNT_NO:'12345678-01'}),/중복/);
    }
  }
  assert.throws(()=>assetReaderBrokers({ISA_BROKER:'BOTH'}),/한 곳/);
  assert.throws(()=>assetReaderBrokers({ISA_BROKER:'KIS'}),/누락/);
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
