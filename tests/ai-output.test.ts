"use strict";
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {runAgyModels,parseAgyJson,parseCodexJsonl,codexFallbackArgs,CODEX_FALLBACK_MODEL,fallbackModelChain,shouldFallbackToNextModel}=require("../src/ai/agy-runner");
const {briefingPrompt,validateBriefing}=require("../src/ai/briefing-output");

for(const raw of ["","{}","plain output",JSON.stringify({type:"tool_result",content:"not final"}),JSON.stringify({summary:"progress"})]) assert.equal(parseAgyJson(raw).text,"");
assert.equal(parseAgyJson(JSON.stringify({response:"answer"})).text,"answer");
assert.equal(parseAgyJson('{"type":"assistant","text":"partial"}\n{"error":"stream was interrupted"}').text,"");
assert.equal(parseAgyJson('{"status":"interrupted","response":"partial, not final"}').text,"");
assert.equal(parseAgyJson('{"status":"SUCCESS","response":"unverified answer","denied_actions":[{"action":"read_url(example.test)"}]}').code,"AI_PERMISSION_DENIED");
assert.equal(parseAgyJson('{"event":"result","result":{"status":"SUCCESS","response":"valid final"}}').text,"valid final");
assert.equal(parseAgyJson('{"response":"answer"}\n{"type":"tool_result","content":"later tool"}').text,"answer");
const codexAnswer='{"type":"item.completed","item":{"type":"agent_message","text":"Sol answer"}}\n{"type":"turn.completed","usage":{}}';
assert.equal(parseCodexJsonl(codexAnswer).text,"Sol answer");
assert.equal(CODEX_FALLBACK_MODEL,"gpt-6-sol");
for(const bad of ["",'{}',codexAnswer.split("\n")[0],codexAnswer+'\n{"type":"turn.failed","error":{"message":"quota exceeded"}}','{"type":"item.completed","item":{"type":"command_execution","text":"not an answer"}}\n{"type":"turn.completed"}']) assert.equal(parseCodexJsonl(bad).text,"");
assert.deepEqual(fallbackModelChain("Gemini",["Opus","Gemini",CODEX_FALLBACK_MODEL,"Opus"]),["Gemini","Opus",CODEX_FALLBACK_MODEL]);
assert.deepEqual(codexFallbackArgs(["/tmp/synthetic.png"]),["exec","--model",CODEX_FALLBACK_MODEL,"--config",'model_reasoning_effort="medium"',"--json","--ephemeral","--skip-git-repo-check","--ignore-rules","--ignore-user-config","--disable","shell_tool","--sandbox","read-only","--config",'web_search="live"',"--image","/tmp/synthetic.png","-"]);
assert.equal(shouldFallbackToNextModel(Error("authentication denied: quota lookup unavailable")),false);
assert.equal(shouldFallbackToNextModel(Object.assign(Error("timeout"),{code:"AI_PERMISSION_DENIED"})),false);
assert.equal(shouldFallbackToNextModel(Error("503 Service Unavailable")),true);
const brief="1. 확인된 사실\n자료 2026-09-27 [출처](https://example.test/source)\n2. 해석\n조건부 상승 해석\n3. 반대 근거·위험\n금리 상승 때 무효\n4. 결론\n조건을 확인하며 관찰합니다.";
assert.equal(validateBriefing(brief),brief);
assert(validateBriefing(brief.replace("https://example.test/source","https://example.test/source?date=2026-09-27")));
for(const bad of ["",brief+"\n어떻게 보십니까?",brief+"<@123>",brief.replace("https://example.test/source","출처 없음"),"출처 https://example.test"]) assert.throws(()=>validateBriefing(bad));
assert.match(briefingPrompt("synthetic topic"),/토론·대화 요청이 아닙니다/);

async function main() {
  const started=[],finished=[],children=[];
  const fake=()=>{const c:any=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{setTimeout(()=>c.emit("close",143),1);};children.push(c);return c;};
  const chain=fallbackModelChain("Gemini",["Opus"]),attempts=[];
  assert.equal(await runAgyModels({models:chain,timeoutMs:100,
    parseOutput:(output,model)=>model===CODEX_FALLBACK_MODEL?parseCodexJsonl(output):parseAgyJson(output),
    launch:model=>{attempts.push(model);const c=fake();setTimeout(()=>{
      if(model===CODEX_FALLBACK_MODEL) {c.stdout.emit("data",codexAnswer);c.emit("close",0);}
      else {c.stderr.emit("data","429 quota exceeded");c.emit("close",1);}
    },1);return c;}}),"Sol answer");
  assert.deepEqual(attempts,chain);
  attempts.length=0;
  assert.equal(await runAgyModels({models:chain,timeoutMs:100,launch:model=>{
    attempts.push(model);const c=fake();setTimeout(()=>{c.stdout.emit("data",'{"response":"primary answer"}');c.emit("close",0);},1);return c;
  }}),"primary answer");
  assert.deepEqual(attempts,["Gemini"]);
  await assert.rejects(runAgyModels({models:chain,timeoutMs:100,launch:()=>{
    const c=fake();setTimeout(()=>{c.stderr.emit("data","quota exceeded");c.emit("close",1);},1);return c;
  }}),/quota exceeded/);
  const result=await runAgyModels({models:["Gemini","Opus"],timeoutMs:20,
    launch:model=>{started.push(model);const c=fake();if(model==="Opus")setTimeout(()=>{c.stdout.emit("data",'{"response":"fallback success"}');c.emit("close",0);},7);return c;},
    onFinish:c=>finished.push(c)});
  assert.equal(result,"fallback success");assert.deepEqual(started,["Gemini","Opus"]);assert.equal(finished.length,2);
  // A final-model timeout must remain a failure even if its process later emits valid output.
  await assert.rejects(runAgyModels({models:["Opus"],timeoutMs:5,launch:()=>fake()}),/초과/);
  let count=0;
  await assert.rejects(runAgyModels({models:["Gemini","Opus"],timeoutMs:30,launch:()=>{
    count++;const c=fake();setTimeout(()=>{c.stderr.emit("data","authentication denied");c.emit("close",1);},1);return c;}}),/authentication/);
  assert.equal(count,1);
  count=0;
  await assert.rejects(runAgyModels({models:["Gemini","Opus"],timeoutMs:30,launch:()=>{
    count++;const c=fake();setTimeout(()=>{c.stdout.emit("data",'{"status":"SUCCESS","response":"","denied_actions":[{"action":"read_url"}]}');c.emit("close",0);},1);return c;}}),e=>e.code==="AI_PERMISSION_DENIED");
  assert.equal(count,1);
  count=0;
  const blank=await runAgyModels({models:["Gemini","Opus"],timeoutMs:30,launch:()=>{
    count++;const n=count,c=fake();setTimeout(()=>{c.stdout.emit("data",n===1?"{}":'{"response":"nonempty"}');c.emit("close",0);},1);return c;}});
  assert.equal(blank,"nonempty");assert.equal(count,2);
  let stopped=false;count=0;
  await assert.rejects(runAgyModels({models:["Gemini","Opus"],timeoutMs:30,isStopped:()=>stopped,launch:()=>{
    count++;const c=fake();setTimeout(()=>{stopped=true;c.emit("close",143);},1);return c;}}),e=>e.code==="AI_STOPPED");
  assert.equal(count,1);
  console.log("ai-output OK: empty/error/tool output, briefing validation, timeout/late-close fallback, stop, nonretryable errors");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
