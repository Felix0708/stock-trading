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

function isGroupDiscussionRequest(content) {
  const text = String(content || "").trim();
  return /(?:같이\s*)?토론(?:해\s*(?:줘|봐)|하자)[.!?]*$/i.test(text)
    || isGroupOpinionRequest(content);
}

function isGroupOpinionRequest(content) {
  const text = normalize(content);
  if (/(?:다|모두|전부)(?:말(?:해|하(?:라|렴|세요|자))|답해|얘기해|한마디)/.test(text)) return true;
  if (/^(?:다른|나머지)(?:사람|분|애)들?(?:은|는|도)?$/.test(text)) return true;
  return /(?:모두(?:들)?|다들|여러분|전부|전원|각자|(?:다른|나머지)(?:사람|분|애)들?|의견안(?:낸|말한|준)(?:사람|분))/.test(text)
    && /(?:의견|생각|답|말|얘기|한마디|들어보|어때)/.test(text);
}

function isRemainingGroupRequest(content) {
  return /(?:(?:다른|나머지)(?:사람|분|애)들?|의견안(?:낸|말한|준)(?:사람|분))/.test(normalize(content));
}

function extractGroupDiscussionTopic(content) {
  return String(content || "")
    .trim()
    .replace(/(?:같이\s*)?토론(?:해\s*(?:줘|봐)|하자)[.!?]*$/i, "")
    .trim();
}

function resolveGroupDiscussionTopic(content, recentContext = "") {
  const topic = isGroupDiscussionRequest(content)
    ? extractGroupDiscussionTopic(content)
    : String(content || "").trim();
  const contextualFollowUp = isGroupOpinionRequest(content);
  if (!contextualFollowUp || !String(recentContext).trim()) return topic;
  return `최근 Discord 채널 대화:\n${String(recentContext).trim()}\n\n현재 요청:\n${topic}\n\n직전 대화의 주제를 이어서 답하세요. 새 주제로 바꾸지 마세요.`;
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
  extractGroupDiscussionTopic,
  isAccountExecutorRequest,
  isHelpRequest,
  isResetRequest,
  isGroupDiscussionRequest,
  isRemainingGroupRequest,
  isStopRequest,
  naturalTradeCommand,
  pickResponder,
  resolveGroupDiscussionTopic,
  sessionKey,
};
