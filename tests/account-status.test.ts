const assert = require("node:assert/strict");
const { accountCollectionStatuses } = require("../src/integrations/account-equity");
const { syncStockBriefingAccountStatus } = require("../src/integrations/stock-briefing");
const { collectKiwoomTotal } = require("../src/brokers/account-equity");

(async () => {
  const ref = "11111111-1111-4111-8111-111111111111", at = "2026-09-18T00:00:00Z";
  const state = {equityAccounts:{"group:KIWOOM:mock:private-identity":ref},equity:[
    {accountRef:"partial",accountGroupRef:ref,brokerId:"KIWOOM",environment:"mock",at,scope:"domestic",equity:123},
    {accountRef:ref,brokerId:"KIWOOM",environment:"mock",at,scope:"account-total-assets",equity:456},
  ],equityTotalFailures:{}};
  assert.equal(accountCollectionStatuses(state)[0].code,"total_verified");
  state.equityTotalFailures[ref] = {at:"2026-09-18T01:00:00Z",code:"other_currency_assets",reason:"private broker message"};
  const statuses=accountCollectionStatuses(state);
  assert.equal(statuses[0].code,"other_currency_assets");
  assert.doesNotMatch(JSON.stringify(statuses),/private|equity|123|456/);
  assert.equal(accountCollectionStatuses({...state,equityTotalFailures:{[ref]:{at:"2026-09-17T00:00:00Z",code:"other_currency_assets"}}})[0].code,"total_verified");
  const token="sb_sync_"+"a".repeat(43);
  await syncStockBriefingAccountStatus(state,{token,fetchImpl:async(url,options)=>{
    assert.match(url,/\/api\/sync\/account-status$/);assert.equal(options.redirect,"error");
    assert.deepEqual(JSON.parse(options.body),{version:1,statuses});return Response.json({ok:true,synced:1});
  }});
  await assert.rejects(syncStockBriefingAccountStatus(state,{token,fetchImpl:async()=>Response.json({ok:true,synced:2})}),/전송 실패/);
  const now=new Date().toISOString();
  const client={post:async(_path,options)=>options.apiId==="ka00001" ? {acctNo:"1234567890"} : {result_list:[
    {crnc_code:"USD",fx_entr:"10",evlt_amt:"0"},{crnc_code:"CNY",fx_entr:"1",evlt_amt:"0"},
  ]}};
  const points=[{scope:"domestic",cash:1,stockValue:0,equityProof:{observedAt:now,clear:true}},
    {scope:"overseas",cash:10,stockValue:0,equityProof:{observedAt:now,clear:true,rate:1300}}];
  await assert.rejects(collectKiwoomTotal({domesticClient:client,overseasClient:client,environment:"mock"},points),error=>error.code==="other_currency_assets");
  console.log("account-status: PASS (privacy, freshness, acknowledgement, non-USD guard)");
})();
