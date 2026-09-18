const assert=require('node:assert/strict');
const {recordedTaxSnapshot}=require('../src/executor/account-portfolio');
const {syncStockBriefingTax}=require('../src/integrations/stock-briefing');
const order={environment:'live',side:'SELL',currency:'USD',filledQuantity:2,fillPrice:150,preTradeAverageEntryPrice:100,createdAt:'2026-09-01T00:00:00Z',lastFillAt:'2026-09-01T01:00:00Z'};
const broker=(environment,orders)=>({id:'KIWOOM',environment,tracker:{list:()=>orders}});
(async()=>{
  const rows=recordedTaxSnapshot([broker('live',[
    order,{...order,filledQuantity:1,fillPrice:80}, // Partial sells contribute +100 and -20.
    {...order,side:'BUY'}, {...order,environment:'mock'}, {...order,currency:'KRW'},
    {...order,lastFillAt:'2025-09-01T01:00:00Z'},
    {...order,preTradeAverageEntryPrice:null}, {...order,lastFillAt:null},
    {...order,createdAt:'2025-12-31T01:00:00Z'},
  ]),broker('mock',[{...order,environment:'mock'}])],'2026-09-18T03:00:00Z');
  assert.equal(rows.length,1);assert.equal(rows[0].sell_count,2);assert.equal(rows[0].profit_loss,80);assert.equal(rows[0].missing_count,3);
  assert.deepEqual(recordedTaxSnapshot([broker('mock',[order])]),[]);
  const options={token:'sb_sync_'+'a'.repeat(43),apiUrl:'https://example.com',fetchImpl:async(url,init)=>{
    assert.equal(url,'https://example.com/api/sync/tax-estimate');assert.equal(JSON.parse(init.body).records[0].account_type,'live');return Response.json({ok:true,synced:1});
  }};
  assert.equal(await syncStockBriefingTax(rows,options),1);
  await assert.rejects(syncStockBriefingTax([{...rows[0],account_type:'paper'}],options));
  await assert.rejects(syncStockBriefingTax(rows,{...options,fetchImpl:async()=>Response.json({ok:true,synced:null})}));
  console.log('recorded tax: live only, partial sells, missing evidence, year boundaries and sync PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
