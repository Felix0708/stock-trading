"use strict";

const { formatInstrumentLabel } = require("../research/instrument-names");
const { normalizeSignal } = require("../signals/signal-normalizer");
const { higherTimeframeContext } = require("../signals/nested-webhook");
const { signalAnalysisKey, timeframe, sepaResearchPrompt, parseSepaResponse } = require("../research/sepa-analysis");

const { SIGNAL_CHANNELS: US_CHANNELS, SIGNAL_MARKETS, signalMarket } = require("../signals/signal-market");
const COLORS = { 관찰: 0xFEE75C, 진입: 0x57F287, 추매: 0x2ECC71, 관리: 0xE67E22, 청산: 0xED4245, 모멘텀: 0x9B59B6, peg: 0x3498DB };
const GRADES = { GO: "진입 가능", HALF: "부분 진입", WAIT: "눌림 대기", NO: "진입 금지", OFF: "판단 없음 (기능 꺼짐)" };
const LIMIT = 72 * 60 * 60_000;
const text = (v, max = 500) => String(v ?? "미확인").replace(/@/g, "＠").slice(0, max);
const number = v => typeof v === "number" && Number.isFinite(v);
const marketPrice = (v, market) => {
  if (!number(v)) return "미제공";
  const n = v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return market?.id === "US" ? `$${n}` : `${n}${market?.currency || " (통화 미확인)"}`;
};
const tf = v => ["D", "1D"].includes(String(v).toUpperCase()) ? "일봉" : ["240", "4H"].includes(String(v).toUpperCase()) ? "4시간봉" : ["W", "1W"].includes(String(v).toUpperCase()) ? "주봉" : text(v);
const code = r => r.outcome?.signal?.signalCode || normalizeSignal(r.payload).signalCode;
const isUsSignal = r => signalMarket(r)?.id === "US";
const validDate = value => Number.isFinite(Date.parse(value));

function tradingViewChartUrl(ticker: any, exchange: any): string | undefined {
  if (!ticker) return undefined;
  const cleanTicker = String(ticker).trim().toUpperCase();
  const cleanEx = String(exchange || "").trim().toUpperCase();
  let tvExchange = cleanEx;
  if (["KRX", "KOSPI", "KOSDAQ"].includes(cleanEx)) {
    tvExchange = "KRX";
  } else if (["TSE", "TSEJP", "JPX"].includes(cleanEx)) {
    tvExchange = "TSE";
  } else if (!cleanEx) {
    tvExchange = "NASDAQ";
  }
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${tvExchange}:${cleanTicker}`)}`;
}

function truncateEmbedToDiscordLimit(embed: any): any {
  if (!embed) return embed;
  if (embed.title && embed.title.length > 256) embed.title = String(embed.title).slice(0, 256);
  if (embed.description && embed.description.length > 4000) embed.description = String(embed.description).slice(0, 4000);
  if (embed.footer?.text && embed.footer.text.length > 2048) embed.footer.text = String(embed.footer.text).slice(0, 2048);
  if (Array.isArray(embed.fields)) {
    for (const f of embed.fields) {
      if (f.name && f.name.length > 256) f.name = String(f.name).slice(0, 256);
      if (f.value && f.value.length > 1024) f.value = String(f.value).slice(0, 1024);
    }
    while (JSON.stringify(embed).length > 5600 && embed.fields.length > 0) {
      embed.fields.pop();
    }
  }
  if (JSON.stringify(embed).length > 5600 && embed.description) {
    const excess = JSON.stringify(embed).length - 5600;
    embed.description = embed.description.slice(0, Math.max(0, embed.description.length - excess - 10));
  }
  return embed;
}

function signalCardComponents(record: any) {
  const p = record?.payload || {};
  const tvUrl = tradingViewChartUrl(p.ticker, p.exchange);
  const components: any[] = [];

  if (tvUrl) {
    components.push({
      type: 2, // Button
      style: 5, // Link
      label: "📈 트레이딩뷰 차트",
      url: tvUrl
    });
  }

  if (p.ticker) {
    const market = signalMarket(record);
    const mId = market?.id || "US";
    components.push({
      type: 2, // Button
      style: 1, // Primary
      label: "🔍 SEPA 상세 분석",
      custom_id: `sepa_req:${mId}:${p.ticker}:${signalAnalysisKey(record)}`
    });
  }

  if (!components.length) return [];
  return [{
    type: 1, // ActionRow
    components
  }];
}

function signalCategory(record) {
  const c = code(record);
  if (c.startsWith("MOMENTUM_")) return "모멘텀";
  if (c.startsWith("PEG_")) return "peg";
  if (c.startsWith("ADD_")) return "추매";
  if (["EXIT_PARTIAL_1", "EXIT_PARTIAL_2", "TAKE_PROFIT", "TAKE_PROFIT_CONSIDER", "OVERHEAT_WARNING", "RANGE_BREAKDOWN", "CHANNEL_EXIT_HOLD"].includes(c)) return "관리";
  if (["EXIT_FINAL", "EXIT_BREAKOUT", "EXIT_CRASH", "ENTRY_INVALIDATED"].includes(c)) return "청산";
  if (["ENTRY_STANDARD", "ENTRY_BREAKOUT", "ENTRY_AGGRESSIVE", "PULLBACK_TIMING"].includes(c)) return "진입";
  return "관찰";
}


const positive = v => number(v) && v > 0;
const shown = v => number(v) ? v.toFixed(2).replace(/\.?0+$/, "") : "미제공";
const yesNo = v => v === true ? "예" : v === false ? "아니오" : "미제공";

// Display facts come from the normalized v7 blocks. Never fill absent facts with example values.
function signalFacts(record) {
  const p = record.payload || {}, s = p.indicator_stock || {}, m = p.indicator_market || {};
  const h = higherTimeframeContext(p), pos = p.indicator_position || {};
  const energy = s.energy ?? p.energy ?? p.atr_multiple;
  const limit = s.energy_limit ?? p.atr_dot_threshold;
  const entry = positive(p.trigger_price) ? p.trigger_price : positive(p.price) ? p.price : null;
  const rr = positive(entry) && positive(p.sl) && positive(p.tp1) && p.sl < entry && p.tp1 > entry
    ? (p.tp1 - entry) / (entry - p.sl) : positive(p.rr) ? p.rr : null;
  return {p,s,m,h,pos,entry,rr,energy,limit,
    overheat: number(energy) && positive(limit) ? energy > limit : null,
    fundamental: p.indicator_setup?.fundamental,
    gain: positive(pos.entry) && positive(p.price) ? (p.price / pos.entry - 1) * 100 : null};
}

function strategyChecks(record) {
  const {p,s,h,overheat,energy,limit} = signalFacts(record);
  const mark = v => v === null ? "⬜" : v ? "🟩" : "🟥";
  // Partial rule checks, not four independent AI analyses or a full SEPA template.
  const trend = h.trend === "BULL" && typeof h.above200 === "boolean" ? h.above200
    : h.trend === "BEAR" ? false : null;
  const volume = number(s.rs_rating) && number(s.rel_vol) ? s.rs_rating >= 70 && s.rel_vol >= 1 : null;
  const upper = typeof h.aligned === "boolean" && typeof h.above200 === "boolean" ? h.aligned && h.above200 : null;
  return [
    mark(trend) + " 미너비니식 추세 일부: 상위 " + text(h.trend) + " · 200선 위 " + yesNo(h.above200),
    mark(volume) + " 오닐식 RS·거래량 일부: 지표 RS " + shown(s.rs_rating) + " · 거래량 " + shown(s.rel_vol) + "배",
    mark(overheat === null ? null : !overheat) + " 쿨라메기식 과열 일부: 에너지 " + shown(energy) + " / 기준 " + shown(limit),
    mark(upper) + " 리버모어식 상위 추세 일부: " + tf(h.timeframe) + " 정배열 " + yesNo(h.aligned),
  ].join("\n");
}

function signalCard(record) {
  const {p,s,m,h,pos,entry,rr,energy,limit,overheat,gain,fundamental} = signalFacts(record);
  const category = signalCategory(record), c = code(record), market = signalMarket(record);
  const price = v => marketPrice(v, market);
  const ended = ["MOMENTUM_UP_ENDED","MOMENTUM_DOWN_ENDED","PEG_INVALID","PEG_EXPIRED"].includes(c);
  const plan = ["신호가  " + price(p.price)];
  if (!ended) {
    plan.push("트리거  " + price(p.trigger_price), "손절    " + price(p.sl), "목표 1  " + price(p.tp1), "목표 2  " + price(p.tp2), "손익비  " + shown(rr));
  }
  if (positive(pos.entry)) plan.push("지표 진입  " + price(pos.entry));
  if (positive(pos.avg)) plan.push("지표 평단  " + price(pos.avg));
  if (gain !== null) plan.push("진입 대비  " + gain.toFixed(2) + "%");
  const notice = c === "MOMENTUM_DOWN_ENDED" ? "모멘텀 매도 자리가 닫힙니다. 새 매수 신호를 뜻하지 않습니다."
    : c === "MOMENTUM_UP_ENDED" ? "상승 모멘텀 종료입니다. 실제 보유 여부나 주문 체결을 뜻하지 않습니다."
    : c === "TAKE_PROFIT_CONSIDER" ? "부분 익절고려 · 즉시 전량청산 지시가 아닙니다."
    : c === "PULLBACK_TIMING" ? "실시간 눌림 타점 · 봉 마감 확정 진입과 구분합니다."
    : "수신된 지표 신호이며 실제 주문·체결 상태와 별개입니다.";
  const v = p.indicator_verdict || {};
  const gate = number(v.checks_ok) && positive(v.checks_total) && v.checks_ok <= v.checks_total
    ? v.checks_ok + "/" + v.checks_total : "미제공";
  const fields = [
    {name:"지표 판단", value:"확신 " + text(p.conviction) + " · 실행 " + (GRADES[p.grade] || "미제공") + "\n" + text(p.grade_why || p.desc || notice,800)},
    {name:"방향 → 강도 → 과열",value:[
      "상위봉 " + tf(h.timeframe) + " · " + text(h.trend) + " · 정배열 " + yesNo(h.aligned),
      "매수·매도 압력 " + (number(s.di_plus) && number(s.di_minus) ? (s.di_plus-s.di_minus).toFixed(1) + " (DI+−DI−)" : "미제공"),
      "추세 강도 ADX " + shown(s.adx) + " · 에너지 " + shown(energy) + " / 기준 " + shown(limit),
      overheat === null ? "과열 판정: 기준 데이터 미제공" : overheat ? "과열: 에너지가 사용자 기준 초과" : "과열: 사용자 기준 이하",
      "거래량 " + shown(s.rel_vol) + "배 · 상위봉 거래량 " + text(m.htf_volume),
    ].join("\n")},
    {name:"4가지 전략 체크 · 규칙 기반 부분 점검", value:strategyChecks(record) + "\n독립 AI 의견이나 전체 전략 합격 판정이 아닙니다."},
    {name:"셋업·펀더멘털 · 지표 제공",value:"셋업 " + text(p.indicator_setup?.stage ?? p.setup_stage) + " · 조건 " + gate
      + "\n" + text(fundamental,600) + "\nSEPA 종합 등급은 버튼에서 외부 자료를 조회한 뒤 별도 산정합니다."},
  ];
  if (p.ai_summary) fields.push({name:"SMART 평가 · 지표 제공",value:text(p.ai_summary,800)});
  if (category === "모멘텀" && !ended) fields.push({name:"모멘텀 전용 기준",value:"상태 " + text(p.momentum) + " · SL " + price(p.momentum_sl) + " · TP " + price(p.momentum_tp)});
  if (["관리","청산","추매"].includes(category)) fields.push({name:"지표 포지션 · 계좌와 별개",value:"보유 " + yesNo(pos.held) + " · 보유 봉 " + shown(pos.bars) + " · 분할 " + shown(pos.trim_n) + " · 추매 " + shown(pos.pyramid)
    + "\n트레일링 " + price(pos.trail_sl) + " · 청산 방식 " + text(pos.exit_strategy)});
  return truncateEmbedToDiscordLimit({
    color:COLORS[category], title:text(category + " · " + p.type + " · " + formatInstrumentLabel(p),256),
    description:"**" + text(p.ticker,30) + " · " + tf(p.timeframe) + "**\n" + notice + "\n\u0060\u0060\u0060text\n" + plan.join("\n") + "\n\u0060\u0060\u0060",
    fields, footer:{text:"지표 수신 시점 기준 · 지표 RS는 IBD 등급 아님 · 계좌 보유·체결 정보 아님"},
    ...(validDate(record.receivedAt) ? {timestamp:record.receivedAt} : {})
  });
}

function validSignals(records, now, market, windowMs) {
  const seen = new Set();
  return records.filter(r => r.validation?.ok === true && !r.outcome?.duplicate
    && !["BLOCKED","REJECTED_INVALID"].includes(r.outcome?.decision) && r.payload?.paper_order_test !== true
    && signalMarket(r)?.id === market.id && validDate(r.receivedAt)
    && now-Date.parse(r.receivedAt) >= 0 && now-Date.parse(r.receivedAt) <= windowMs)
    .sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt)).filter(r=>{
      const key=signalAnalysisKey(r);
      if(seen.has(key)) return false;
      seen.add(key); return true;
    });
}
function recentSignals(records, now=Date.now(), market=SIGNAL_MARKETS[0]) {
  return validSignals(records,now,market,LIMIT);
}

function digestCards(records, period, now=Date.now(), market=SIGNAL_MARKETS[0]) {
  const daily = period === "D" || period === "DAILY_4H";
  const all = recentSignals(records,now,market);
  let matching=all.filter(r=>timeframe(r.payload.timeframe)===(period==="D" ? "1D" : "240"));
  if(period==="DAILY_4H" && !matching.length) matching=all.filter(r=>timeframe(r.payload.timeframe)==="1D");
  const label = period==="240" ? "4H 리포트" : "오늘의 시그널";
  if(!matching.length) return [{color:0x5865F2,title:label,description:"최근 72시간에 수신한 해당 시간봉의 유효 신호가 없습니다. 시장 전체에 신호가 없다는 뜻은 아닙니다.",footer:{text:market.label+" · 실제 수신분만 집계"}}];
  const newest=matching.reduce((a,b)=>(b.payload.bar_time || Date.parse(b.receivedAt))>(a.payload.bar_time || Date.parse(a.receivedAt)) ? b:a);
  const group=reportGroup(newest,period), selected=matching.filter(r=>reportGroup(r,period)===group);
  const four=timeframe(newest.payload.timeframe)==="240";
  const foot=market.label+" · "+(period==="DAILY_4H" && four ? "4H 당일 종합" : four ? "4H" : "1D")+" · 수신 신호 통계, 실거래 성과 아님";
  const sectors=new Map();
  for(const r of selected) { const sector=r.payload.indicator_market?.sector; if(sector) sectors.set(sector,(sectors.get(sector)||0)+1); }
  const known=selected.filter(r=>["BULL","MIXED","BEAR"].includes(signalFacts(r).h.trend));
  const hot=selected.map(signalFacts).filter(f=>f.overheat!==null);
  const exits=selected.filter(r=>signalCategory(r)==="청산");
  const measured=exits.map(signalFacts).filter(f=>f.gain!==null);
  const cards:any[]=[{
    color:0x5865F2,title:label+" · "+text(group,160),
    description:"**수신 신호 "+selected.length+"건 · "+new Set(selected.map(r=>r.payload.exchange+":"+r.payload.ticker)).size+"종목**\n"
      +Object.keys(COLORS).map(c=>c+" "+selected.filter(r=>signalCategory(r)===c).length).join(" · ")
      +"\n상위 상승 추세 "+known.filter(r=>signalFacts(r).h.trend==="BULL").length+"/"+known.length+"건 (자료 있는 신호만)"
      +"\n과열 "+hot.filter(f=>f.overheat).length+"/"+hot.length+"건 (사용자별 기준)"
      +"\n청산 진입대비: 이익 "+measured.filter(f=>f.gain>0).length+" · 손실 "+measured.filter(f=>f.gain<0).length+" · 본전 "+measured.filter(f=>f.gain===0).length+" · 계산 제외 "+(exits.length-measured.length)
      +"\n수신 종목 섹터: "+([...sectors].map(([s,n])=>text(s,60)+" "+n+"건").join(" · ") || "자료 없음")
      +"\n수신 표본만으로 지수 강약·기관 수급·뉴스 호재를 추정하지 않습니다.",
    footer:{text:foot}
  }];
  for(const category of Object.keys(COLORS)) {
    const lines=selected.filter(r=>signalCategory(r)===category).map(r=>{
      const {p,h,overheat}=signalFacts(r);
      return "**"+text(p.ticker,25)+"** · "+text(p.type,70)+" · 확신 "+text(p.conviction,5)
        +" / "+(GRADES[p.grade]||"판단 미제공")+" · "+marketPrice(p.price,market)
        +"\n상위 "+tf(h.timeframe)+" "+text(h.trend,20)+" · "+(overheat===null ? "과열 자료 없음" : overheat ? "과열 기준 초과" : "과열 기준 이하");
    });
    let page="",index=1;
    const push=()=>{ if(page) cards.push({color:COLORS[category],title:label+" · "+category+" · "+index++,description:page,footer:{text:foot}}); };
    for(const line of lines) {if(page.length+line.length>3200) {push();page="";} page+=(page ? "\n\n":"")+line;}
    push();
  }
  return cards.map(truncateEmbedToDiscordLimit);
}

// These are signal-price observations, not fills or position-weighted portfolio returns.
function performanceCards(records, period="WEEK", now=Date.now(), market=SIGNAL_MARKETS[0]) {
  const days=period==="WEEK" ? 7:30, matching=validSignals(records,now,market,days*86400000);
  const groups=[...new Set(matching.map(r=>timeframe(r.payload.timeframe)))];
  if(!groups.length) return [{color:0x5865F2,title:market.prefix+" "+(period==="WEEK"?"주간":"월간")+" 성과",description:"해당 기간 유효 신호가 없습니다."}];
  return groups.map(group=>{
    const selected=matching.filter(r=>timeframe(r.payload.timeframe)===group);
    const exits=selected.filter(r=>["EXIT_FINAL","EXIT_BREAKOUT","EXIT_CRASH"].includes(code(r)));
    const stats=exits.flatMap(r=>{const f=signalFacts(r);return f.gain===null?[]:[{ticker:f.p.ticker,gain:f.gain}];});
    const wins=stats.filter(s=>s.gain>0),losses=stats.filter(s=>s.gain<0),even=stats.length-wins.length-losses.length;
    const denominator=wins.length+losses.length;
    const avg=a=>a.length?a.reduce((n,s)=>n+s.gain,0)/a.length:null;
    const aw=avg(wins),al=avg(losses);
    return truncateEmbedToDiscordLimit({
      color:0x5865F2,title:market.prefix+" "+(period==="WEEK"?"주간":"월간")+" 신호 성과 · "+tf(group),
      description:"최근 "+days+"일 · 수신 "+selected.length+"건\n최종청산 "+exits.length+"건 · 계산 가능 "+stats.length+"건"
        +"\n승률 "+(denominator?(wins.length/denominator*100).toFixed(1)+"%":"산정 불가")+" ("+wins.length+"/"+denominator+" · 본전 제외)"
        +"\n이익 "+wins.length+" · 손실 "+losses.length+" · 본전 "+even+" · 진입가 누락 등 계산 제외 "+(exits.length-stats.length)
        +"\n평균 이익 "+(aw===null?"산정 불가":aw.toFixed(2)+"%")+" · 평균 손실 "+(al===null?"산정 불가":al.toFixed(2)+"%")
        +"\n평균 손익비 "+(aw!==null&&al!==null?(aw/Math.abs(al)).toFixed(2):"산정 불가")
        +"\n지표 position.entry와 청산 신호가의 단순 비교입니다. 분할매도·추매·수수료·환율을 반영한 거래 전체 수익률이 아닙니다."
        +"\n부분청산·익절고려·진입무효는 최종청산 승패에 합산하지 않습니다.",
      fields:stats.length?[{name:"진입 대비 관측 예시 (최대 10건)",value:stats.slice(0,10).map(s=>text(s.ticker,30)+" "+s.gain.toFixed(2)+"%").join("\n")}]:[],
      footer:{text:"시간봉별 분리 · 중복·테스트 제외 · 실제 계좌 체결 및 자산 수익률과 별개"}
    });
  });
}

function formatSepaCards(data, record) {
  if(!record || data?.version!==3 || data.key!==signalAnalysisKey(record)) throw Error("SEPA 분석과 신호가 일치하지 않습니다.");
  const labels={trend:"추세",fundamental:"펀더멘털",catalyst:"촉매",supply:"수급",timing:"타이밍"};
  const color=!data.complete?0x95A5A6:data.grade==="S"?0x9B59B6:data.grade==="A"?0x2ECC71:data.grade==="불합격"?0xED4245:0xF1C40F;
  const title=text(data.name+" ("+data.ticker+")",100);
  const summary={
    color,title:"🎯 SEPA 분석 — "+title,
    fields:[
      {name:"종합 등급 · 자체 분석 기준",value:data.complete?data.grade+" · "+data.score+"/100 · "+(data.stage||"국면 미확정"):"근거 확보 후 산정 · 부족한 축: "+data.missing.map(k=>labels[k]).join(", ")},
      {name:"핵심 논거",value:text(data.thesis,600)},
      {name:"5축 점수",value:Object.entries(labels).map(([k,label])=>label+" "+(data.scores[k].score===null?"근거 부족":data.scores[k].score+"/"+data.scores[k].max)).join("\n")},
      {name:"추세 템플릿 8조건",value:data.template.map((t,i)=>(i+1)+": "+(t.pass===null?"근거 부족":t.pass?"Pass":"Fail")).join(" · ")},
      {name:"계산 기준",value:"조건 1~7: 서버 조회 일봉 원자료로 계산\n조건 8: 지표의 일봉 RS · IBD 등급 아님"},
      {name:"시점 구분",value:"신호 수신 "+data.signalAt+"\n분석 작성 "+data.analyzedAt+"\n현재 조사와 과거 신호를 결합한 참고 분석이며 당시 검증 완료를 의미하지 않습니다."},
    ],footer:{text:"공식 SEPA 등급 아님 · 출처가 있는 AI 분석도 투자 결과를 보장하지 않습니다."}
  };
  const detail={
    color,title:"📜 풀 리포트 — "+title,
    description:Object.entries(labels).map(([k,label])=>"**"+label+"**\n"+text(data.report[k+"Detail"],240)).join("\n\n")
      +"\n\n**출처 · 자료 기준일**\n"+data.sources.slice(0,8).map(s=>"["+text(s.title,45)+"]("+s.url.slice(0,200)+") · "+s.asOf).join("\n")
      +"\n\n**추가 해석**\n"+data.insights.slice(0,3).map(s=>text(s,150)).join("\n"),
    footer:{text:"출처 확인 여부·자료의 시차를 함께 검토하세요. 누락은 0점 또는 불합격이 아닙니다."}
  };
  // Two embeds share Discord's 6000-character message budget.
  detail.description=detail.description.slice(0,Math.max(0,5500-JSON.stringify(summary).length));
  return [summary,detail].map(truncateEmbedToDiscordLimit);
}
function marketDate(ms, market = SIGNAL_MARKETS[0]) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: market.zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function reportGroup(record, period) {
  const p = record.payload, bar = Number.isSafeInteger(p.bar_time) && p.bar_time > 0 ? p.bar_time : null;
  if (period === "D" || period === "DAILY_4H") return marketDate(bar ?? Date.parse(record.receivedAt), signalMarket(record));
  return bar ? `봉 시작 ${new Date(bar).toISOString()}` : `봉 시각 미제공 · 수신 구간 ${new Date(Math.floor(Date.parse(record.receivedAt) / 14400000) * 14400000).toISOString()}`;
}

function sepaSnapshot(record) {
  const price = v => marketPrice(v, signalMarket(record));
  const p = record.payload, s = p.indicator_stock || {}, m = p.indicator_market || {};
  return { color: 0x5865F2, title: `SEPA 사전점검 · ${text(formatInstrumentLabel(p), 180)}`,
    description: "**종합 등급 미산정**\n지표에서 확인한 자료입니다. 추세 템플릿 8개 조건과 실적·촉매·수급의 완전한 검증 결과가 아닙니다.",
    fields: [
      { name: "추세 · 지표 제공", value: `${text(p.ema_align)}\n상위봉 ${tf(p.htf || "미제공")} · ${text(p.htf_trend || p.daily_trend)}` },
      { name: "상대강도 · 지표 제공", value: `종목 RS ${text(s.rs_rating)} · 상위봉 RS ${text(m.htf_rs ?? p.daily_rs)}\nIBD RS 등급과 동일하다고 가정하지 않습니다.` },
      { name: "타이밍 · 지표 제공", value: `확신 ${text(p.conviction)} / 실행 ${GRADES[p.grade] || "미제공"}\n신호가 ${price(p.price)} · 손절 ${price(p.sl)} · 손익비 ${text(p.rr)}` },
      { name: "추가 확인 필요", value: "50·150·200일선 원자료, 52주 고저, 분기 매출·EPS와 가속 여부, 촉매, 수급. 미확인은 불합격이나 0점이 아닙니다." },
    ], footer: { text: "수신 시점 자료 · 주문과 별개 · AI 상세 분석은 별도 카드" }, ...(validDate(record.receivedAt) ? { timestamp: record.receivedAt } : {}) };
}

function isSepaEligibleSignal(record) {
  const p = record.payload || {};
  const c = code(record);
  const cat = signalCategory(record);

  // Exclude explicit exits, warnings, breakdowns, and momentum exits
  if (cat === "관리" || cat === "청산") return false;
  if (c === "MOMENTUM_UP_ENDED" || c === "MOMENTUM_DOWN_ENDED" || c === "MOMENTUM_SELL") return false;
  if (p.action === "SELL") return false;
  if (c === "OVERHEAT_WARNING" || c === "RANGE_BREAKDOWN" || c === "PULLBACK_EXPIRED") return false;

  // Eligible BUY / Entry signals
  if (cat === "진입" || cat === "추매" || cat === "peg") return true;
  if (c === "MOMENTUM_BUY") return true;
  if (p.action === "BUY") return true;

  // Key breakout / setup completion in watchlist
  if (c === "RANGE_BREAKOUT" || c === "VCP_FORMING") return true;
  const raw = String(p.type || "");
  if (raw.includes("돌파") || raw.includes("VCP")) return true;

  return false;
}


module.exports = { US_CHANNELS, isUsSignal, signalCategory, signalCard, recentSignals, digestCards,
  sepaSnapshot, sepaResearchPrompt, isSepaEligibleSignal, parseSepaResponse, formatSepaCards,
  performanceCards, signalCardComponents, tradingViewChartUrl, truncateEmbedToDiscordLimit, marketDate,
  signalFacts, strategyChecks };
