"use strict";

// Same public research scope as the bot. Never fetch model-supplied arbitrary hosts or forward credentials.
const RESEARCH_HOSTS = ["sec.gov","nasdaq.com","nyse.com","federalreserve.gov","bls.gov","bea.gov","treasury.gov","stlouisfed.org","reuters.com","finance.yahoo.com","dart.fss.or.kr","krx.co.kr","bok.or.kr","kosis.kr","jpx.co.jp","boj.or.jp","edinet-fsa.go.jp","e-stat.go.jp"];
function researchUrl(value) {
  const url=new URL(value);
  if(url.protocol!=="https:" || url.username || url.password || url.port || url.href.length>2000
    || !RESEARCH_HOSTS.some(host=>url.hostname===host || url.hostname.endsWith("."+host))) throw Error("공개 자료 조회 범위 밖 주소");
  return url.href;
}
function evidenceText(text) {
  return String(text||"").replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi," ").replace(/<[^>]+>/g," ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==="x"?parseInt(n.slice(1),16):Number(n);return code<=0x10ffff?String.fromCodePoint(code):" ";})
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/g,s=>({"&nbsp;":" ","&amp;":"&","&quot;":"\"","&apos;":"'","&lt;":"<","&gt;":">"}[s]))
    .replace(/\s+/g," ").trim();
}
function sourceContext(evidence,sources=[]) {
  return evidence.slice(0,8).map(e=>{
    const quote=evidenceText(sources.find(s=>s.url===e.url)?.quote);
    const index=quote.length>=20?e.text.indexOf(quote):-1;
    const start=index<0?0:Math.max(0,index-600);
    return {url:e.url,text:e.text.slice(start,start+4000)};
  });
}
async function readPublic(url,{fetchImpl=fetch,signal=undefined as AbortSignal|undefined}={}) {
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
  for(let redirects=0;redirects<4;redirects++) {
    url=researchUrl(url);
    const response=await fetchImpl(url,{redirect:"manual",signal:bounded,headers:{"User-Agent":"Mozilla/5.0","Accept":"text/html,application/json,text/plain"}});
    if([301,302,303,307,308].includes(response.status)) {
      const next=response.headers.get("location");await response.body?.cancel();
      if(!next) throw Error("공개 자료 이동 주소 누락");
      url=new URL(next,url).href;continue;
    }
    if(!response.ok) {await response.body?.cancel();throw Error("공개 자료 HTTP "+response.status);}
    if(!/text\/(html|plain)|application\/json/.test(response.headers.get("content-type")||"")) {await response.body?.cancel();throw Error("공개 자료 형식 미지원");}
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;if(size>2_000_000) throw Error("공개 자료 크기 초과");chunks.push(Buffer.from(chunk));}
    return {url,text:Buffer.concat(chunks).toString("utf8"),retrievedAt:new Date().toISOString()};
  }
  throw Error("공개 자료 이동 횟수 초과");
}
async function collectSources(sources,options={}) {
  const found=[];
  // Bounded small groups, rather than a burst of requests to a filing provider.
  const unique=[...new Set((Array.isArray(sources)?sources:[]).map(s=>s?.url).filter(u=>typeof u==="string"))].slice(0,8);
  for(let i=0;i<unique.length;i+=2) await Promise.all(unique.slice(i,i+2).map(async url=>{
    try {const result=await readPublic(url,options);found.push({...result,url:researchUrl(url),text:evidenceText(result.text).slice(0,120000)});}
    catch { /* The caller retries research using the successfully fetched evidence. */ }
  }));
  return found;
}
function yahooSymbol(record) {
  const p=record.payload||{},ticker=String(p.ticker||"").toUpperCase();
  if(["NASDAQ","NYSE","AMEX","BATS","ARCA"].includes(p.exchange) && /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return ticker.replace(".","-");
  if(["KRX","KOSPI","KOSDAQ"].includes(p.exchange) && /^\d{6}$/.test(ticker)) return ticker+(p.exchange==="KOSDAQ"?".KQ":".KS");
  if(["TSE","TSE_DLY","TYO","JPX"].includes(p.exchange) && /^[0-9A-Z]{4,5}$/.test(ticker)) return ticker+".T";
  throw Error("일봉 조회 종목 식별 불가");
}
function dailyTechnicals(data,symbol,now=Date.now()) {
  const r=data?.chart?.result?.[0],q=r?.indicators?.quote?.[0];
  if(!r || r.meta?.symbol!==symbol || !Array.isArray(r.timestamp) || !q) throw Error("일봉 응답 종목 불일치");
  const session=r.meta.currentTradingPeriod?.regular;
  const rows=r.timestamp.map((t,i)=>({t,close:q.close?.[i],high:q.high?.[i],low:q.low?.[i],volume:q.volume?.[i]}))
    .filter(b=>Number.isFinite(b.t) && b.t*1000<=now && !(session && now<session.end*1000 && b.t>=session.start)
      && [b.close,b.high,b.low].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)
      && b.high>=b.low && b.close<=b.high && b.close>=b.low);
  if(rows.length<252 || rows.some((r,i)=>i>0&&r.t<=rows[i-1].t) || now-rows.at(-1).t*1000>7*86400000) throw Error("일봉 기간 부족 또는 오래된 자료");
  const mean=(n,offset=0)=>rows.slice(rows.length-offset-n,rows.length-offset).reduce((sum,r)=>sum+r.close,0)/n;
  const price=rows.at(-1).close,ma50=mean(50),ma150=mean(150),ma200=mean(200);
  const year=rows.filter(r=>r.t>=rows.at(-1).t-365*86400);
  const low52=Math.min(...year.map(r=>r.low)),high52=Math.max(...year.map(r=>r.high));
  const rising=Array.from({length:21},(_,i)=>mean(200,i)>mean(200,i+1)).every(Boolean);
  return {symbol,asOf:new Date(rows.at(-1).t*1000).toISOString(),price,ma50,ma150,ma200,low52,high52,
    template:[price>ma150&&price>ma200,ma150>ma200,rising,ma50>ma150&&ma50>ma200,price>ma50,price>=low52*1.3,price>=high52*.75],
    basis:"Yahoo split-adjusted daily OHLC; completed sessions; 52-week calendar range; 200SMA rising across 21 sessions"};
}
async function loadDailyTechnicals(record,options:any={}) {
  const primary=yahooSymbol(record);
  // KRX alone does not distinguish KOSPI from KOSDAQ; verify either response's exact symbol.
  const symbols=record.payload?.exchange==="KRX"?[primary,primary.replace(/\.KS$/,".KQ")]:[primary];
  for(const symbol of symbols) for(const host of ["query2.finance.yahoo.com","query1.finance.yahoo.com"]) {
    try {
      const source=await readPublic(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`,options);
      const technical=dailyTechnicals(JSON.parse(source.text),symbol,options.now??Date.now());
      return {...technical,url:source.url,retrievedAt:source.retrievedAt};
    } catch(error) {if(options.signal?.aborted) throw error;}
  }
  throw Error("일봉 원자료 조회를 완료하지 못했습니다.");
}
module.exports={RESEARCH_HOSTS,researchUrl,evidenceText,sourceContext,readPublic,collectSources,dailyTechnicals,loadDailyTechnicals};
