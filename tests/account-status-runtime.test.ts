const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createAccountRuntime, SignalReceiptStore } = require("../src/executor/account-executor");
const { writeEvidence } = require("../src/executor/account-evidence");

(async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"status-isolation-"));
  const oldFetch=global.fetch,oldToken=process.env.STOCK_BRIEFING_TOKEN;
  try {
    process.env.STOCK_BRIEFING_TOKEN="sb_sync_"+"a".repeat(43);
    const receipts=new SignalReceiptStore(path.join(dir,"receipts.json"),true);
    const ref="11111111-1111-4111-8111-111111111111";
    writeEvidence(receipts.file+".evidence.json",{version:1,brokers:{},adjustments:[],cashFlows:[],cashFlowCoverage:[],equityAccounts:{"KIS:mock:identity":ref},equity:[
      {accountRef:ref,brokerId:"KIS",environment:"mock",currency:"KRW",scope:"account-total-assets",at:"2026-09-18T00:00:00Z",equity:100,cash:null,stockValue:null},
    ]});
    const runtime=createAccountRuntime({brokers:[],receipts,channels:{system:"system"},client:{guilds:{fetch:async()=>{throw Error("Discord offline");}}}});
    const calls=[];
    let releaseStatus;
    const paused=new Promise(resolve=>{releaseStatus=resolve;});
    global.fetch=async(url)=>{
      calls.push(String(url));
      if(String(url).endsWith("/account-status")){await paused;return Response.json({error:"unavailable"},{status:502});}
      return Response.json({ok:true,synced:1});
    };
    const first=runtime.requestEquitySync();
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(calls.some(url=>url.endsWith("/account-equity")),"blocked diagnostic must not delay financial sync");
    assert.equal(runtime.requestEquitySync(),first,"keep one job until both requests settle");
    releaseStatus();await first;
    assert.ok(receipts.state.briefingEquitySync.batches);
    assert.ok(receipts.state.equityOutages["briefing-account-status"]);
    assert.equal(receipts.state.equityOutages["briefing-equity-sync"],undefined,"Discord diagnostic failure is not an equity failure");
    console.log("account-status runtime: PASS (concurrent delivery, failure isolation, single flight)");
  } finally {
    global.fetch=oldFetch;
    if(oldToken===undefined)delete process.env.STOCK_BRIEFING_TOKEN;else process.env.STOCK_BRIEFING_TOKEN=oldToken;
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
