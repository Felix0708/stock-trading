"use strict";

const SIGNAL_RULES = [
  ["정석 진입", "ENTRY_STANDARD", "BUY"],
  ["돌파 진입", "ENTRY_BREAKOUT", "BUY"],
  ["공격 진입", "ENTRY_AGGRESSIVE", "BUY"],
  ["피라미딩 추매", "ADD_PYRAMID", "BUY"],
  ["모멘텀 BUY", "MOMENTUM_BUY", "BUY"],
  ["PEG Pullback", "PEG_PULLBACK", "BUY"],
  ["PEG Rebreak", "PEG_REBREAK", "BUY"],
  ["최종 청산", "EXIT_FINAL", "SELL"],
  ["돌파 청산", "EXIT_BREAKOUT", "SELL"],
  ["1차 분할청산", "EXIT_PARTIAL_1", "SELL"],
  ["2차 분할청산", "EXIT_PARTIAL_2", "SELL"],
  ["진입 무효", "ENTRY_INVALIDATED", "SELL"],
  ["모멘텀 SELL", "MOMENTUM_SELL", "SELL"],
  ["상승 모멘텀 종료", "MOMENTUM_UP_ENDED", "SELL"],
  ["PEG Invalid", "PEG_INVALIDATED", "SELL"],
  ["셋업 형성 중", "SETUP_FORMING", "CHECK"],
  ["VCP 형성", "VCP_FORMING", "CHECK"],
  ["부분 익절고려", "TAKE_PROFIT_CONSIDER", "CHECK"],
  ["급등 후 풀백", "POST_SURGE_PULLBACK", "CHECK"],
  ["과열 경고", "OVERHEAT_WARNING", "CHECK"],
  ["박스권 돌파", "RANGE_BREAKOUT", "CHECK"],
  ["박스권 이탈", "RANGE_BREAKDOWN", "CHECK"],
  ["PEG Start", "PEG_STARTED", "CHECK"],
  ["PEG Expired", "PEG_EXPIRED", "CHECK"],
  ["하락 모멘텀 종료", "MOMENTUM_DOWN_ENDED", "CHECK"],
  ["진입 확정", "ENTRY_CONFIRMED", "CHECK"],
  ["진입 만료", "ENTRY_EXPIRED", "CHECK"],
];

function normalizeType(rawType) {
  return String(rawType || "").normalize("NFKC").replaceAll("\uFE0F", "").trim();
}

function normalizeSignal(payload) {
  const rawType = typeof payload?.type === "string" ? payload.type : "";
  const normalizedType = normalizeType(rawType);
  const srFlip = normalizedType.includes("@SR↩");
  const tpMatch = normalizedType.match(/TP(\d+)\s*달성/i);
  const warnings = [];
  let signalCode = "UNKNOWN";
  let expectedAction = null;
  let tpLevel = null;

  if (tpMatch) {
    signalCode = "TAKE_PROFIT";
    expectedAction = "SELL";
    tpLevel = Number(tpMatch[1]);
  } else {
    const rule = SIGNAL_RULES.find(([label]) => normalizedType.toLowerCase().includes(label.toLowerCase()));
    if (rule) [, signalCode, expectedAction] = rule;
  }

  if (signalCode === "UNKNOWN") warnings.push(`알 수 없는 type: ${rawType || "(빈값)"}`);
  if (expectedAction && payload.action !== expectedAction) {
    warnings.push(`action 불일치: ${signalCode}는 ${expectedAction}, 수신값은 ${payload.action}`);
  }

  return {
    rawType,
    signalCode,
    expectedAction,
    modifiers: srFlip ? ["SR_FLIP"] : [],
    tpLevel,
    known: signalCode !== "UNKNOWN",
    orderBlocked: signalCode === "UNKNOWN" || (expectedAction && payload.action !== expectedAction),
    warnings,
  };
}

module.exports = {
  SIGNAL_RULES,
  normalizeSignal,
  normalizeType,
};
