"use strict";
const assert = require("node:assert/strict");
const { signalCard, signalCategory, digestCards, recentSignals, sepaSnapshot, sepaResearchPrompt, isSepaEligibleSignal, parseSepaResponse:parseRawSepaResponse, formatSepaCards, performanceCards, signalCardComponents, tradingViewChartUrl, truncateEmbedToDiscordLimit, US_CHANNELS } = require("../src/discord/us-signal-cards");
const verifiedEvidence=[{url:"https://example.test/synthetic",text:"Synthetic revenue grew 25 percent in the quarter.",retrievedAt:"2026-09-18T00:00:00Z"}];
const verifiedTechnical={template:Array(7).fill(true),url:"https://example.test/daily",asOf:"2026-09-18T00:00:00Z",retrievedAt:"2026-09-18T00:00:00Z"};
function parseSepaResponse(raw,record,now) {return parseRawSepaResponse(raw,record,now,verifiedEvidence,verifiedTechnical);}
const { formatWebhookRecord, targetSignalChannels } = require("../src/discord/webhook-discord");
const { decodeSignalEmbed } = require("../src/discord/discord-signal-envelope");
const { shouldReviewSignal } = require("../src/ai/signal-review");
const { SIGNAL_MARKETS, marketChannelName, signalMarket, matchesSignalChannel } = require("../src/signals/signal-market");
const { marketDate } = require("../src/discord/us-signal-cards");
const { TradeController } = require("../src/trading/trade-controller");
const now = Date.parse("2026-09-18T21:00:00Z");
function record(type = "정석 진입", action = "BUY", changes: any = {}) {
  return { requestId: `synthetic-${type}`, receivedAt: new Date(now).toISOString(), validation: { ok: true }, outcome: { decision: "ENTRY_CANDIDATE" }, risk: { verdict: "PAPER_ENTRY" },
    payload: { schema_ver: "5.0", ticker: "TEST", name: "합성 테스트", exchange: "NASDAQ", timeframe: "240", bar_time: now - 14400000,
      type, action, price: 100, sl: 95, tp1: 110, tp2: 115, rr: 2, conviction: "A", grade: "GO", htf: "D", htf_trend: "BULL",
      atr_multiple: 9, atr_dot_threshold: 8, atr_dot: false, indicator_stock: { rs_rating: 80, adx: 30, rel_vol: 1.2 }, indicator_market:{htf_rs:80}, ...changes } };
}
const types = [
  ["셋업 형성 중", "CHECK", "관찰"], ["VCP 형성", "CHECK", "관찰"], ["정석 진입", "BUY", "진입"], ["돌파 진입", "BUY", "진입"],
  ["눌림 진입", "BUY", "진입"], ["피라미딩 추매", "BUY", "추매"], ["강한 눌림목", "BUY", "추매"],
  ["1차 분할청산", "SELL", "관리"], ["2차 분할청산", "SELL", "관리"], ["TP1 달성", "SELL", "관리"], ["TP2 달성", "SELL", "관리"],
  ["부분 익절고려", "CHECK", "관리"], ["과열 경고", "CHECK", "관리"], ["박스권 이탈", "CHECK", "관리"],
  ["최종 청산", "SELL", "청산"], ["돌파 청산", "SELL", "청산"],
  ["모멘텀 BUY", "BUY", "모멘텀"], ["모멘텀 SELL", "SELL", "모멘텀"], ["상승 모멘텀 종료", "SELL", "모멘텀"], ["하락 모멘텀 종료", "CHECK", "모멘텀"],
  ["PEG Start", "CHECK", "peg"], ["PEG Pullback", "BUY", "peg"], ["PEG Rebreak", "BUY", "peg"], ["PEG Invalid", "SELL", "peg"], ["PEG Expired", "CHECK", "peg"],
];
for (const [type, action, expected] of types) {
  const r = record(type, action), original = JSON.stringify(r);
  assert.equal(signalCategory(r), expected);
  const card = signalCard(r);
  assert.equal(card.author, undefined);
  assert.equal(decodeSignalEmbed(card), null);
  assert.equal(JSON.stringify(r), original); // presentation must not mutate execution data
  assert.equal(targetSignalChannels(r)[0], `미국-${expected}`);
  const formatted = formatWebhookRecord(r);
  assert.equal(decodeSignalEmbed(formatted.transportEmbed).requestId, r.requestId);
}
assert.equal(US_CHANNELS.length, 12);
assert.equal(new Set(US_CHANNELS).size, 12);
assert.match(JSON.stringify(signalCard(record())), /과열/);
assert.match(JSON.stringify(signalCard(record("정석 진입", "BUY", { grade: "OFF" }))), /판단 없음/);
assert.match(JSON.stringify(signalCard(record("하락 모멘텀 종료", "CHECK"))), /모멘텀 매도 자리가 닫힙니다/);
assert(!signalCard(record("상승 모멘텀 종료", "SELL")).fields.some(f => /목표|손절/.test(f.value)));
const snapshot = JSON.stringify(sepaSnapshot(record()));
assert.match(snapshot, /종합 등급 미산정/); assert.match(snapshot, /0점이 아닙니다/);
const secretRecord = { ...record(), positionPreview: { accountNumber: "PRIVATE_SENTINEL" }, risk: { reason: "PRIVATE_SENTINEL" } };
assert(!sepaResearchPrompt(secretRecord).includes("PRIVATE_SENTINEL"));
assert(!JSON.stringify(signalCard(secretRecord)).includes("PRIVATE_SENTINEL"));
assert(shouldReviewSignal(record()));
const r = record(), day = record("돌파 진입", "BUY", { timeframe: "D" });
const other = record("정석 진입", "BUY", { ticker: "OTHER" });
const rows = [r, { ...r }, day, other, { ...r, receivedAt: "2020-01-01T00:00:00Z" }, { ...r, outcome: { duplicate: true } }, record("정석 진입", "BUY", { exchange: "TSE" }), record("정석 진입", "BUY", { paper_order_test: true }), { ...r, validation: { ok: false } }];
assert.equal(recentSignals(rows, now).length, 3);
assert.match(digestCards(rows, "D", now)[0].description, /수신 신호 1건/);
assert.match(digestCards(rows, "240", now)[0].description, /수신 신호 2건/);
assert.match(digestCards(rows, "DAILY_4H", now)[0].description, /수신 신호 2건/);
assert.match(digestCards(rows, "DAILY_4H", now)[0].footer.text, /4H 당일 종합/);
assert.match(digestCards([day], "DAILY_4H", now)[0].description, /수신 신호 1건/);
assert.match(digestCards([day], "DAILY_4H", now)[0].footer.text, /1D/);
assert.match(digestCards([], "240", now)[0].description, /신호가 없습니다/);
const delayed = { ...record("VCP 형성", "CHECK", { bar_time: now - 28800000 }), receivedAt: new Date(now + 1).toISOString() };
assert.match(digestCards([r, delayed], "240", now + 1)[0].title, /4H 리포트/);
const lots = Array.from({ length: 120 }, (_, i) => record("정석 진입", "BUY", { ticker: `T${i}` }));
const cards = digestCards(lots, "240", now);
assert.match(cards[0].description, /120건/);
assert(cards.filter(c => c.title.includes("진입")).length > 1);
for (let i = 0; i < 120; i++) assert(cards.some(c => c.description?.includes(`T${i}`)));
for (const card of [...cards, signalCard(record("x".repeat(9000), "BUY", { desc: "x".repeat(9000), ai_summary: "x".repeat(9000), signal: "x".repeat(9000) }))]) {
  assert(card.title.length <= 256);
  assert((card.description || "").length <= 4096);
  assert((card.fields || []).every(f => f.value.length <= 1024));
  const total = [card.title, card.description, card.footer?.text, ...(card.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean).join("").length;
  assert(total <= 6000);
}
const mixed = SIGNAL_MARKETS.map(m => record("정석 진입", "BUY", { exchange: m.exchanges[0], timeframe: "D" }));
for (const market of SIGNAL_MARKETS) {
  const entry = mixed.find(r => signalMarket(r).id === market.id);
  const formatted = formatWebhookRecord(entry);
  assert.equal(formatted.targetCategory, market.category);
  assert.equal(formatted.targetChannel, `${market.prefix}-진입`);
  assert.equal(formatted.embed.author, undefined);
  assert.match(JSON.stringify(formatted.embed), market.id === "US" ? /\$100/ : new RegExp(`100${market.currency}`));
  assert.match(JSON.stringify(sepaSnapshot(entry)), market.id === "US" ? /\$100/ : new RegExp(`100${market.currency}`));
  assert(sepaResearchPrompt(entry).startsWith(`${market.label} 주식`));
  assert.equal(recentSignals(mixed, now, market).length, 1);
  assert(digestCards(mixed, "D", now, market)[0].footer.text.startsWith(market.label));
  assert.match(digestCards(mixed, "D", now, market)[0].description, /수신 신호 1건/);
  const channel = { name: marketChannelName(market, "진입"), parent: { name: market.category }, isTextBased: () => true };
  assert(matchesSignalChannel(channel, channel.name, market.category));
  assert(!matchesSignalChannel(channel, channel.name, "잘못된 카테고리"));
  assert.equal(shouldReviewSignal(entry), true);
  if (market.id !== "JP") assert.equal(decodeSignalEmbed(formatted.transportEmbed).requestId, entry.requestId);
  else {
    assert.deepEqual(formatted.targetChannels, ["일본-진입", "일본-매매신호"]);
    assert.match(formatted.transportEmbed.description, /100엔/);
    for (const schema_ver of [undefined, "5.0"]) for (const side of ["BUY", "SELL"]) {
      const r = { ...entry, payload: { ...entry.payload, action: side, schema_ver }, outcome: { decision: side === "BUY" ? "ENTRY_CANDIDATE" : "EXIT_CANDIDATE" } };
      r.risk = new TradeController({ initialMode: "PAPER_AUTO", accountNeutral: true }).evaluate(r);
      assert.equal(r.risk.verdict, "BLOCKED_EXCHANGE");
      assert.equal(formatWebhookRecord(r).channel, "signal");
      assert.equal(decodeSignalEmbed(formatWebhookRecord(r).transportEmbed).risk.verdict, "BLOCKED_EXCHANGE");
      assert.equal(formatWebhookRecord(r).targetChannels.at(-1), "일본-매매신호");
    }
    const observe = { ...entry, payload: { ...entry.payload, action: "CHECK", type: "셋업 형성 중" }, outcome: { decision: "INFO_ONLY" }, risk: { verdict: "BLOCKED_EXCHANGE" } };
    assert.deepEqual(formatWebhookRecord(observe).targetChannels, ["일본-관찰"]);
  }
}
assert.equal(new Set(SIGNAL_MARKETS.flatMap(m => US_CHANNELS.map(n => marketChannelName(m, n)))).size, 36);
const boundary = Date.parse("2026-09-21T00:30:00Z");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[0]), "2026-09-20");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[1]), "2026-09-21");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[2]), "2026-09-21");
// SEPA Eligibility tests
assert.equal(isSepaEligibleSignal(record("정석 진입", "BUY")), true);
assert.equal(isSepaEligibleSignal(record("돌파 진입", "BUY")), true);
assert.equal(isSepaEligibleSignal(record("피라미딩 추매", "BUY")), true);
assert.equal(isSepaEligibleSignal(record("모멘텀 BUY", "BUY")), true);
assert.equal(isSepaEligibleSignal(record("PEG Rebreak", "BUY")), true);
assert.equal(isSepaEligibleSignal(record("박스권 돌파", "CHECK")), true);
assert.equal(isSepaEligibleSignal(record("VCP 형성", "CHECK")), true);
assert.equal(isSepaEligibleSignal(record("셋업 형성 중", "CHECK")), false);
assert.equal(isSepaEligibleSignal(record("과열 경고", "CHECK")), false);
assert.equal(isSepaEligibleSignal(record("박스권 이탈", "CHECK")), false);
assert.equal(isSepaEligibleSignal(record("1차 분할청산", "SELL")), false);
assert.equal(isSepaEligibleSignal(record("상승 모멘텀 종료", "SELL")), false);
assert.equal(isSepaEligibleSignal(record("최종 청산", "SELL")), false);


// Regression: no historical example defaults or implied AI consensus when data is absent.
const empty=record("정석 진입","BUY",{price:null,trigger_price:null,sl:null,tp1:null,tp2:null,rr:null,conviction:null,
  htf_trend:null,indicator_stock:{},indicator_market:{},atr_multiple:null,atr_dot_threshold:null});
const emptyResult=signalCard(empty);
const emptyCard=JSON.stringify({description:emptyResult.description,fields:emptyResult.fields});
for(const fake of ["62점","68점","Stage 2","결격 없음","4/6","기관 매집","+20.0%","0.00"]) assert(!emptyCard.includes(fake),fake);
assert.match(emptyCard,/규칙 기반 부분 점검/);
assert(!JSON.stringify(digestCards([empty],"240",now)).includes("IT서비스"));
assert(!JSON.stringify(digestCards([empty],"240",now)).includes("지수가 약합니다"));
const {normalizeWebhookPayload,BLOCK_FIELDS}=require("../src/signals/nested-webhook");
const wire:any={schema_ver:"5.1",bar_time:now-14400000};
for(const [block,groups] of Object.entries(BLOCK_FIELDS)) {
  wire[block]={};
  for(const [kind,names] of Object.entries(groups)) for(const key of String(names).split(" "))
    wire[block][key]=kind==="string"?"":kind==="boolean"?false:kind==="nullable"?null:0;
}
Object.assign(wire.symbol,{ticker:"TEST",name:"합성",exchange:"NASDAQ",tf:"D",htf:"W"});
Object.assign(wire.signal,{type:"정석 진입",action:"BUY",price:100,sl:90,tp1:130,trigger_price:100,conviction:"A",grade:"GO"});
Object.assign(wire.stock,{energy:9,energy_limit:12,overheat:true,rs_rating:80,rel_vol:1.5,adx:27});
Object.assign(wire.market,{htf_trend:"BULL",htf_align:"정배열",htf_above200:true,htf_volume:"ACCUMULATION"});
wire.setup.fundamental="실적 성장 근거 테스트";
const mapped={...record(),payload:normalizeWebhookPayload(wire)};
const mappedCard=JSON.stringify(signalCard(mapped));
assert.match(mappedCard,/주봉/);assert.match(mappedCard,/실적 성장 근거 테스트/);
assert.match(mappedCard,/사용자 기준 이하/); // does not trust display toggle
assert.match(mappedCard,/손익비  3/);
wire.stock.energy_limit=8;wire.stock.overheat=false;
assert.match(JSON.stringify(signalCard({...mapped,payload:normalizeWebhookPayload(wire)})),/사용자 기준 초과/);

// Exact identity and analysis response validation.
const {AXES,signalAnalysisKey,selectSepaRecord,createSepaService:rawCreateSepaService,handleSepaButton}=require("../src/research/sepa-analysis");
const createSepaService=options=>rawCreateSepaService({fetchSources:async()=>verifiedEvidence,loadTechnicals:async()=>verifiedTechnical,...options});
const cid=signalCardComponents(r)[0].components.find(c=>c.custom_id).custom_id;
assert.equal(selectSepaRecord([day,other,r],cid),r);
assert.throws(()=>selectSepaRecord([day,other],cid));
assert.throws(()=>selectSepaRecord([r],"sepa_req:US:TEST"));
assert.notEqual(signalAnalysisKey(r),signalAnalysisKey(day));
assert.notEqual(signalAnalysisKey(r),signalAnalysisKey(record("정석 진입","BUY",{exchange:"NYSE"})));
assert.notEqual(signalAnalysisKey(r),signalAnalysisKey(record("정석 진입","BUY",{bar_time:now})));
const complete=()=>{
  const external=["source1"];
  return {ticker:"TEST",exchange:"NASDAQ",thesis:"합성 근거와 반대 조건",stage:"Stage 2",
    template:Array.from({length:8},()=>({pass:true,sourceIds:external})),
    axes:Object.fromEntries(Object.entries(AXES).map(([k,max])=>[k,{score:max,reason:k+" 합성 자료",sourceIds:external}])),
    sources:[{id:"source1",url:"https://example.test/synthetic",title:"합성 출처",asOf:"2026-09-18",quote:verifiedEvidence[0].text}],insights:[]};
};
for(const malformed of ["","{}","null","not json",JSON.stringify({...complete(),ticker:"OTHER"})]) {
  assert.throws(()=>parseSepaResponse(malformed,r,now));
}
const parsed=parseSepaResponse(complete(),r,now);
assert.equal(parsed.score,100);assert.equal(parsed.grade,"S");
const both=formatSepaCards(parsed,r);
assert.equal(both.length,2);assert(JSON.stringify(both).length<6000);
assert.throws(()=>formatSepaCards(parsed,day));
const partial=complete();delete partial.axes.fundamental;
const incomplete=parseSepaResponse(partial,r,now);
assert.equal(incomplete.score,null);assert.equal(incomplete.grade,null);assert.equal(incomplete.complete,false);
assert(!JSON.stringify(formatSepaCards(incomplete,r)).includes("S · 100"));
const fakeSource=complete();fakeSource.sources[0].url="http://example.test/no-tls";
assert.equal(parseSepaResponse(fakeSource,r,now).complete,false);
const noTemplate=complete();noTemplate.template[0].sourceIds=["signal"];
assert.equal(parseRawSepaResponse(noTemplate,r,now,verifiedEvidence,null).scores.trend.score,null);
const future=complete();future.sources[0].asOf="2099-01-01";
assert.equal(parseSepaResponse(future,r,now).score,null);
const failed=complete();failed.template[0].pass=false;
const failedTechnical={...verifiedTechnical,template:[false,...Array(6).fill(true)]};
assert.equal(parseRawSepaResponse(failed,r,now,verifiedEvidence,failedTechnical).grade,"불합격");
assert.equal(parseRawSepaResponse(failed,r,now,verifiedEvidence,failedTechnical).stage,null);
assert.equal(parseRawSepaResponse(complete(),r,now).complete,false,"model-provided sources alone never prove research");
const invented=complete();invented.sources[0].quote="Invented quarterly revenue grew 999 percent.";
assert.equal(parseSepaResponse(invented,r,now).complete,false);

// Missing entries are excluded, not converted to 0%; dedup and timeframe separation.
const exit=(ticker,price,entry,timeframe="240")=>record("최종 청산","SELL",{ticker,price,timeframe,indicator_position:{entry}});
const a=exit("GAIN",110,100), b=exit("LOSS",90,100), c=exit("EVEN",100,100), d=exit("UNKNOWN",100,null);
const perf=performanceCards([a,{...a,requestId:"retry"},b,c,d,exit("DAY",120,100,"D"),
  record("부분 익절고려","CHECK",{indicator_position:{entry:20}}),
  {...exit("TEST_ONLY",900,1),payload:{...exit("TEST_ONLY",900,1).payload,paper_order_test:true}}],"WEEK",now);
assert.equal(perf.length,2);
assert.match(perf[0].description,/최종청산 4건 · 계산 가능 3건/);
assert.match(perf[0].description,/승률 50.0% \(1\/2/);
assert.match(perf[0].description,/본전 1 · 진입가 누락 등 계산 제외 1/);
assert.match(perf[1].title,/일봉/);
assert.match(performanceCards([d],"WEEK",now)[0].description,/승률 산정 불가/);
assert.equal(performanceCards([record("진입 무효","SELL",{indicator_position:{entry:90}})],"WEEK",now)[0].description.includes("최종청산 0건"),true);
assert.equal(tradingViewChartUrl("005930","KRX"),"https://www.tradingview.com/chart/?symbol=KRX%3A005930");

async function checkAsync() {
  const cache=new Map();let calls=0;
  const get=createSepaService({now:()=>now,readCache:k=>cache.get(k),writeCache:(k,v)=>cache.set(k,v),
    analyze:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,3));return complete();}});
  const results=await Promise.all([get(r),get(r)]);
  assert.equal(calls,1);assert.equal(results[0],results[1]);await get(r);assert.equal(calls,1);
  let repaired=0;
  const repair=createSepaService({now:()=>now,readCache:()=>null,writeCache:()=>{},
    analyze:async()=>++repaired===1?"{}":complete()});
  assert.equal((await repair(r)).complete,true);assert.equal(repaired,2);
  let sourceAttempts=0;
  const sourceRecovery=createSepaService({now:()=>now,readCache:()=>null,writeCache:()=>{},analyze:async()=>complete(),
    fetchSources:async()=>++sourceAttempts===1?[]:verifiedEvidence});
  assert.equal((await sourceRecovery(r)).complete,true);assert.equal(sourceAttempts,2,"failed source lookup recovers into a complete report");
  let attempts=0,writes=0;
  const bad=createSepaService({now:()=>now,readCache:()=>null,writeCache:()=>writes++,analyze:async()=>{attempts++;return "{}";}});
  await assert.rejects(bad(r));assert.equal(attempts,2);assert.equal(writes,0);
  let cancelled=false;
  const slow=createSepaService({timeoutMs:5,readCache:()=>null,writeCache:()=>writes++,analyze:(_prompt,_record,context)=>new Promise(()=>{context.signal.addEventListener("abort",()=>{cancelled=true;});})});
  await assert.rejects(slow(r),e=>e.code==="AI_TIMEOUT");assert.equal(writes,0);assert.equal(cancelled,true);

  function click(customId=cid) {
    const outputs:any[]=[];
    return {customId,channelId:"synthetic-channel",deferred:false,isButton:()=>true,outputs,
      async deferReply(){this.deferred=true;},async editReply(v){outputs.push(v);},async reply(v){outputs.push(v);}};
  }
  const ok=click();await handleSepaButton(ok,{loadRecords:()=>[day,r],getAnalysis:get,formatCards:formatSepaCards});
  assert.equal(ok.outputs[0].embeds.length,2);
  assert.equal(calls,1);
  const invalid=click("sepa_req:JP:TEST:"+signalAnalysisKey(r));
  await handleSepaButton(invalid,{loadRecords:()=>[r],getAnalysis:()=>{throw Error("must not run");},formatCards:formatSepaCards});
  assert(!invalid.outputs[0].embeds.length);
  const failure=click();
  await handleSepaButton(failure,{loadRecords:()=>[r],getAnalysis:()=>{throw Error("PRIVATE_SENTINEL");},formatCards:formatSepaCards});
  assert(!JSON.stringify(failure.outputs).includes("PRIVATE_SENTINEL"));
  assert.match(failure.outputs[0].content,/임의 점수/);
  console.log("us-signal-cards OK: 25 types, 3 markets, missing data, 120-row pagination, exact SEPA buttons, retry/cache, performance cohorts");
}
checkAsync().catch(error=>{console.error(error);process.exitCode=1;});
