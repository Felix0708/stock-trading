"use strict";
// Explicit opt-in live smoke: public information only; no .env, account, Discord, order or database access.
const {spawn}=require("node:child_process");
const path=require("node:path");
const {readPublic,evidenceText,loadDailyTechnicals}=require("../src/research/public-evidence");
const {runAgyModels,parseAgyJson,safeAiError}=require("../src/ai/agy-runner");
const {briefingPrompt,completeBriefing}=require("../src/ai/briefing-output");

async function main() {
  if(!process.argv.includes("--live-public")) throw Error("Use --live-public to opt in to public HTTP and AI quota use");
  const technical=await loadDailyTechnicals({payload:{ticker:"MSFT",exchange:"NASDAQ"}});
  console.log("public-daily: OK");
  const source=await readPublic("https://www.federalreserve.gov/aboutthefed.htm");
  const evidence={...source,text:evidenceText(source.text)};
  console.log("public-source: OK");
  const env=Object.fromEntries(["PATH","HOME","TMPDIR","LANG","LC_ALL","SHELL","TERM","USER","LOGNAME","AGY_HOME","SSL_CERT_FILE","HTTPS_PROXY","HTTP_PROXY","NO_PROXY"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const models=[];
  const generate=prompt=>runAgyModels({models:["Gemini 3.8 Flash (Medium)","Claude Opus 4.6 (Thinking)"],timeoutMs:90000,totalTimeoutMs:120000,parseOutput:parseAgyJson,
    launch:(model,timeout)=>{models.push(model);console.log("model-start: "+model);return spawn("agy",["--model",model,"--mode","plan","--disable-slash-commands","--output-format","json","--print-timeout",`${Math.ceil(timeout/1000)}s`,"--print",prompt],
      {cwd:path.resolve(__dirname,"../.codex-chat"),env,stdio:["ignore","pipe","pipe"]});}});
  // Use the substantive paragraph, not twenty kilobytes of navigation boilerplate.
  const start=evidence.text.indexOf("The Federal Reserve System");
  const excerpt=evidence.text.slice(Math.max(0,start),Math.max(0,start)+3500);
  const raw=await generate(briefingPrompt("공개자료 경로 점검용입니다. 시장 전망을 만들지 말고 연준의 역할에 대한 간단한 사실 한 개와 해석을 작성하세요. 아래는 서버에서 방금 읽은 실제 자료입니다. 숫자 없는 원문 한 문장을 정확히 quote로 쓰고 한국어로 설명하세요. asOf는 오늘 날짜(자료 조회 기준)입니다. 도구·웹 검색 없이 아래 자료만 사용하세요.\n"+JSON.stringify({url:source.url,text:excerpt})));
  console.log("model-response: OK");
  const result=await completeBriefing(raw,{fetchSources:async()=>[evidence],rewrite:generate});
  console.log(JSON.stringify({publicDailyData:true,dailyConditions:technical.template.length,sourceFetched:true,groundedBriefing:result.includes("4. 결론"),models,discordSent:false,ordersSubmitted:false}));
}
main().catch(error=>{console.error(safeAiError(error));process.exitCode=1;});
