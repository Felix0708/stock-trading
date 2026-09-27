"use strict";

function shouldFallbackToNextModel(error) {
  const message=String(error?.message || error);
  if (["AI_STOPPED","AI_PERMISSION_DENIED"].includes(error?.code) || /permission|denied|unauth|authentication|login required|invalid.api.key|forbidden|권한/i.test(message)) return false;
  return /429|quota|rate.?limit|resource.?exhaust|too many requests|limit.+(reached|exceeded)|invalid model|not recognized|not supported|unavailable|최종 답변|JSON 응답|stream was interrupted|interrupted|timeout|초과했습니다|econnreset|etimedout|socket hang up|\b50[0234]\b/i.test(message);
}

const CODEX_FALLBACK_MODEL="gpt-6-sol";

function fallbackModelChain(model, fallbackModels) {
  return [...new Set([model,...fallbackModels].filter(value=>value && value!==CODEX_FALLBACK_MODEL)),CODEX_FALLBACK_MODEL];
}

function codexFallbackArgs(imagePaths=[]) {
  return ["exec","--model",CODEX_FALLBACK_MODEL,"--config",'model_reasoning_effort="medium"',
    "--json","--ephemeral","--skip-git-repo-check","--ignore-rules","--ignore-user-config",
    "--disable","shell_tool","--sandbox","read-only","--config",'web_search="live"',
    ...imagePaths.flatMap(file=>["--image",file]),"-"];
}

function parseCodexJsonl(output) {
  let text="",completed=false;
  for(const line of String(output||"").split("\n")) {
    if(!line.trim()) continue;
    let event;
    try { event=JSON.parse(line); } catch { return {text:"",error:"AI JSON 응답 형식 오류"}; }
    if(!event || typeof event!=="object") return {text:"",error:"AI JSON 응답 형식 오류"};
    if(event.type==="error" || event.type==="turn.failed" || event.error) {
      return {text:"",error:String(event.error?.message||event.error||event.message||"AI JSON 응답 오류")};
    }
    if(event.type==="item.completed" && event.item?.type==="agent_message") text=String(event.item.text||"").trim();
    if(event.type==="turn.completed") completed=true;
  }
  return completed&&text?{text}:{text:"",error:"AI JSON 응답에 완료된 최종 답변이 없습니다."};
}

function parseAgyJson(output) {
  const raw=String(output||"").trim();
  let events;
  try { events=[JSON.parse(raw)]; }
  catch { events=raw.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); }
  const parts=v=>typeof v==="string"?v:Array.isArray(v)?v.filter(p=>!p.thought&&(!p.type||p.type==="text")).map(p=>p.text||"").join("\n"):"";
  let answer="";
  for(const event of events) {
    const e=event?.event==="result" ? event.result : event;
    if(!e || typeof e!=="object") continue;
    if(Array.isArray(e.denied_actions) && e.denied_actions.length) return {text:"",error:"AI 자료 조회 도구가 권한 정책으로 차단됐습니다.",code:"AI_PERMISSION_DENIED"};
    if(e.error || e.is_error || e.type==="error" || /error|fail|interrupt|timeout|cancel|incomplete|invalid|waiting|running/i.test(String(e.status||e.subtype||""))) return {text:"",error:String(e.error?.message||e.error||"AI JSON 응답 오류: "+(e.status||e.subtype||"error"))};
    if(e.type && !["result","assistant","message","response","completion"].includes(e.type)) continue;
    if(e.role && e.role!=="assistant") continue;
    if(e.message?.role && e.message.role!=="assistant") continue;
    const candidate=parts(e.response)||parts(e.result)||parts(e.message?.content)||parts(e.content)
      ||parts(e.candidates?.[0]?.content?.parts)||parts(e.choices?.[0]?.message?.content)
      ||(e.type==="assistant"||e.role==="assistant"?parts(e.text):"");
    if(candidate.trim()) answer=candidate.trim();
  }
  return answer?{text:answer}:{text:"",error:"AI JSON 응답에 최종 답변이 없습니다."};
}

// One owner per attempt: timeout, error and late close cannot settle the next model's result.
async function runAgyModels({models,launch,timeoutMs,totalTimeoutMs=timeoutMs,signal=undefined as AbortSignal|undefined,parseOutput=(output,_model)=>parseAgyJson(output),isStopped=()=>false,onStart=(_child)=>{},onFinish=(_child)=>{}}) {
  const deadline=Date.now()+totalTimeoutMs;
  for(let index=0;index<models.length;index++) {
    if(signal?.aborted) throw signal.reason;
    const remaining=deadline-Date.now();
    if(remaining<=0) throw Object.assign(Error("AI 요청 전체 시간이 초과했습니다."),{code:"AI_TIMEOUT"});
    // Reserve a turn for fallbacks instead of spending the entire budget on the first provider.
    const attemptMs=Math.max(1,Math.min(timeoutMs,Math.floor(remaining/(models.length-index))));
    if(isStopped()) throw Object.assign(Error("AI 응답이 중지되었습니다."),{code:"AI_STOPPED"});
    try {
      return await new Promise<string>((resolve,reject)=>{
        const child=launch(models[index],attemptMs);
        onStart(child);
        let out="",err="",settled=false,killTimer;
        const finish=(error,value="")=>{
          if(settled) return false;
          settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);onFinish(child);
          if(error) reject(error);else resolve(value);
          return true;
        };
        const terminate=(error)=>{
          if(finish(error)) {
            child.kill("SIGTERM");
            killTimer=setTimeout(()=>child.kill("SIGKILL"),2000);
            killTimer.unref();
          }
        };
        const abort=()=>terminate(signal.reason);
        const timer=setTimeout(()=>terminate(Object.assign(Error("AI 응답 시간이 초과했습니다."),{code:"AI_TIMEOUT"})),attemptMs);
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted) abort();
        child.stdout.on("data",chunk=>{out+=chunk;});
        child.stderr.on("data",chunk=>{err=(err+chunk).slice(-4000);});
        child.on("error",error=>finish(error));
        child.on("close",code=>{
          clearTimeout(killTimer);
          if(settled) return;
          if(isStopped()) return finish(Object.assign(Error("AI 응답이 중지되었습니다."),{code:"AI_STOPPED"}));
          let result;
          try { result=parseOutput(out,models[index]); }
          catch { return finish(Error("AI JSON 응답 형식 오류")); }
          if(code!==0) return finish(Object.assign(Error([result.error,err.trim()].filter(Boolean).join("\n")||"AI CLI 종료 코드 "+code),{code:result.code}));
          finish(result.text?null:Object.assign(Error(result.error),{code:result.code}),result.text);
        });
      });
    } catch(error) {
      if(signal?.aborted || error.code==="AI_STOPPED" || isStopped() || index===models.length-1 || !shouldFallbackToNextModel(error)) throw error;
    }
  }
  throw Error("사용 가능한 AI 모델이 없습니다.");
}

function safeAiError(error) {
  const message=String(error?.message||"");
  if(error?.code==="AI_PERMISSION_DENIED" || /permission|denied|authentication|login|권한/i.test(message)) return "AI 자료 조회 권한 또는 로그인 상태를 확인해야 합니다.";
  if(/quota|429|rate.?limit/i.test(message)) return "사용 가능한 AI 모델의 이용 한도에 도달했습니다.";
  if(error?.code==="AI_TIMEOUT" || /timeout|초과했습니다/i.test(message)) return "AI 요청의 전체 처리시간을 초과했습니다.";
  if(/invalid model|not recognized|not supported/i.test(message)) return "AI 모델 실행 설정을 확인해야 합니다.";
  return "AI 결과를 완성하지 못했습니다. 실행·응답 검증 경로를 확인해야 합니다.";
}
module.exports={safeAiError,parseAgyJson,parseCodexJsonl,codexFallbackArgs,CODEX_FALLBACK_MODEL,fallbackModelChain,shouldFallbackToNextModel,runAgyModels};
