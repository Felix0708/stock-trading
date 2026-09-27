"use strict";
const assert=require("node:assert/strict");
const {researchUrl,evidenceText,readPublic,loadDailyTechnicals,dailyTechnicals}=require("../src/research/public-evidence");
const {renderGroundedBriefing,completeBriefing}=require("../src/ai/briefing-output");
const {safeAiError,runAgyModels}=require("../src/ai/agy-runner");
const {EventEmitter}=require("node:events");
const now=Date.parse("2026-09-25T23:00:00Z"),url="https://www.federalreserve.gov/synthetic.htm";
const quote="The synthetic rate remained at 4.25% for this reporting period.";
const evidence=[{url,text:quote,retrievedAt:new Date(now).toISOString()}];
const brief=()=>({facts:[{url,quote,text:"합성 금리는 4.25%로 유지됐습니다.",asOf:"2026-09-25"}],interpretation:"변화 없는 금리로 해석합니다.",risks:"다음 발표에서 달라질 수 있습니다.",conclusion:"추가 발표를 확인합니다."});
for(const bad of ["https://127.0.0.1/x","http://sec.gov/x","https://sec.gov.evil.test/x","https://user:pass@sec.gov/x","https://sec.gov:8443/x"]) assert.throws(()=>researchUrl(bad));
assert.equal(researchUrl(url),url);
assert.equal(evidenceText('<script>bad()</script><b>A&amp;B</b>  25%'),"A&B 25%");
assert.match(renderGroundedBriefing(brief(),evidence,"",now),/4.25%/);
assert.throws(()=>renderGroundedBriefing(brief(),[],"",now));
const fake=brief();fake.facts[0].text="금리 999%";assert.throws(()=>renderGroundedBriefing(fake,evidence,"",now));
const fakeQuote=brief();fakeQuote.facts[0].quote="Invented statement about the interest rate.";assert.throws(()=>renderGroundedBriefing(fakeQuote,evidence,"",now));
const inventedInterpretation=brief();inventedInterpretation.interpretation="성장률 100%";assert.throws(()=>renderGroundedBriefing(inventedInterpretation,evidence,"",now));
const data={chart:{result:[{meta:{symbol:"TEST"},timestamp:Array.from({length:300},(_,i)=>now/1000-(299-i)*86400),
  indicators:{quote:[{close:Array.from({length:300},(_,i)=>100+i),high:Array.from({length:300},(_,i)=>101+i),low:Array.from({length:300},(_,i)=>99+i)}]}}]}};
assert.deepEqual(dailyTechnicals(data,"TEST",now).template,Array(7).fill(true));
assert.throws(()=>dailyTechnicals(data,"OTHER",now));
assert.throws(()=>dailyTechnicals(data,"TEST",now+9*86400000));
assert(!safeAiError(Error("secret=PRIVATE_SENTINEL /private/token")).includes("PRIVATE_SENTINEL"));

async function main() {
  let requested=[];
  const result=await loadDailyTechnicals({payload:{ticker:"TEST",exchange:"NASDAQ"}},{now,fetchImpl:async address=>{
    requested.push(address);return requested.length===1?new Response(null,{status:429}):Response.json(data);
  }});
  assert.equal(requested.length,2);assert.equal(result.ma50,374.5);
  let redirects=0;
  await assert.rejects(readPublic(url,{fetchImpl:async()=>{redirects++;return new Response(null,{status:302,headers:{location:"http://127.0.0.1/secret"}});}}));
  assert.equal(redirects,1);
  let rewrites=0;
  const recovered=await completeBriefing(JSON.stringify(fake),{now:()=>now,fetchSources:async()=>evidence,rewrite:async()=>{rewrites++;return JSON.stringify(brief());}});
  assert.equal(rewrites,1);assert.match(recovered,/4.25%/);assert(!recovered.includes("999%"));
  // An abort releases the process, never launches another provider, and does not publish late output.
  const controller=new AbortController();let launches=0,kills=0;
  const promise=runAgyModels({models:["first","second"],timeoutMs:1000,signal:controller.signal,launch:()=>{
    launches++;const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=()=>{kills++;setTimeout(()=>child.emit("close",143),0);};return child;
  }});
  controller.abort(Object.assign(Error("synthetic timeout"),{code:"AI_TIMEOUT"}));
  await assert.rejects(promise);assert.equal(launches,1);assert.equal(kills,1);
  console.log("research evidence OK: actual-source quotes, numeric grounding, daily calculations, endpoint recovery, SSRF guard, briefing repair, process cancellation");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
