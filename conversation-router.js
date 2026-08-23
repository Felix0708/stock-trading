"use strict";

const TOPIC_KEYWORDS = {
  druckenmiller: ["시장", "거시", "금리", "환율", "유동성", "채권", "지수", "달러", "원유", "정책"],
  oneil: ["실적", "매출", "이익", "eps", "성장", "기관", "베이스", "캔슬림", "canslim"],
  minervini: ["손절", "리스크", "포지션", "변동성", "진입점", "vcp", "수축"],
  livermore: ["심리", "인내", "추세", "피라미딩", "불타기", "물타기", "전환점"],
  qullamaggie: ["모멘텀", "돌파", "갭", "에피소딕", "파라볼릭", "강한종목"],
};

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[.!?。！？]+$/g, "");
}

function isStopRequest(content) {
  return ["그만", "그만해", "멈춰", "대화그만", "토론그만", "여기까지", "!stop", "!중지"].includes(normalize(content));
}

function isRoundtableRequest(content) {
  const text = String(content || "").trim();
  return /^!roundtable(?:\s|$)/i.test(text) || /(?:같이\s*)?토론(?:해\s*줘|하자)[.!?]*$/i.test(text);
}

function extractRoundtableTopic(content) {
  return String(content || "")
    .trim()
    .replace(/^!roundtable\s*/i, "")
    .replace(/(?:같이\s*)?토론(?:해\s*줘|하자)[.!?]*$/i, "")
    .trim();
}

function isResetRequest(content) {
  return ["!reset", "대화새로시작", "대화초기화", "기억초기화"].includes(normalize(content));
}

function isHelpRequest(content) {
  return ["도움말", "도움말보여줘", "사용법", "사용법알려줘", "명령어", "명령어알려줘"].includes(normalize(content));
}

function isAccountExecutorRequest(content) {
  const text = normalize(content);
  return text.startsWith("!account")
    || text.startsWith("!계좌")
    || /^(?:[가-힣a-z0-9_-]+)?계좌(?:명령어|도움말|상태|최근주문|주문내역)(?:보여줘|알려줘|확인)?$/.test(text)
    || ["주문실행기상태보여줘", "주문실행기상태확인"].includes(text);
}

function naturalTradeCommand(content) {
  const text = normalize(content);
  if (["매매상태", "자동매매상태", "매매상태보여줘", "매매상태알려줘", "자동매매상태보여줘"].includes(text)) return "!trade status";
  if (["최근주문", "최근주문보여줘", "주문내역", "주문내역보여줘"].includes(text)) return "!trade orders";
  if (["매매도움말", "매매명령어", "매매명령어보여줘", "매매사용법"].includes(text)) return "!trade help";
  return "";
}

function sessionKey(personaId, channelId = "global") {
  return `${personaId}:${channelId}`;
}

function pickResponder({ content, fixedPersonaId = "", lastPersonaId = "", personas = [] }) {
  const available = new Set(personas.map((persona) => persona.id));
  if (fixedPersonaId && available.has(fixedPersonaId)) return fixedPersonaId;

  const text = normalize(content);
  let selected = "";
  let selectedScore = 0;
  for (const [personaId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (!available.has(personaId)) continue;
    const score = keywords.reduce((total, keyword) => total + Number(text.includes(keyword)), 0);
    if (score > selectedScore) {
      selected = personaId;
      selectedScore = score;
    }
  }
  if (selected) return selected;
  if (lastPersonaId && available.has(lastPersonaId)) return lastPersonaId;
  return available.has("druckenmiller") ? "druckenmiller" : personas[0]?.id || "";
}

module.exports = {
  extractRoundtableTopic,
  isAccountExecutorRequest,
  isHelpRequest,
  isResetRequest,
  isRoundtableRequest,
  isStopRequest,
  naturalTradeCommand,
  pickResponder,
  sessionKey,
};
