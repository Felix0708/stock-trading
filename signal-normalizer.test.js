"use strict";

const assert = require("node:assert/strict");
const { normalizeSignal } = require("./signal-normalizer");

const standard = normalizeSignal({ action: "BUY", type: "💰 정석 진입 @SR↩" });
assert.equal(standard.rawType, "💰 정석 진입 @SR↩");
assert.equal(standard.signalCode, "ENTRY_STANDARD");
assert.deepEqual(standard.modifiers, ["SR_FLIP"]);
assert.equal(standard.orderBlocked, false);

assert.equal(normalizeSignal({ action: "CHECK", type: "🚨 과열 경고" }).signalCode, "OVERHEAT_WARNING");
assert.equal(normalizeSignal({ action: "CHECK", type: "⚠️ 과열 경고" }).signalCode, "OVERHEAT_WARNING");

const tp = normalizeSignal({ action: "SELL", type: "🎯 TP3 달성" });
assert.equal(tp.signalCode, "TAKE_PROFIT");
assert.equal(tp.tpLevel, 3);

const mismatched = normalizeSignal({ action: "SELL", type: "💰 정석 진입" });
assert.equal(mismatched.orderBlocked, true);
assert(mismatched.warnings.some((warning) => warning.includes("action 불일치")));

const unknown = normalizeSignal({ action: "BUY", type: "🆕 새 진입 신호" });
assert.equal(unknown.signalCode, "UNKNOWN");
assert.equal(unknown.orderBlocked, true);

const documentedSignals = [
  ["BUY", "💰 정석 진입"], ["BUY", "🚀 돌파 진입"], ["BUY", "⚡ 공격 진입"],
  ["BUY", "🔼 피라미딩 추매"], ["BUY", "📈 모멘텀 BUY"], ["BUY", "PEG Pullback"],
  ["BUY", "PEG Rebreak"], ["SELL", "💸 최종 청산"], ["SELL", "💣 돌파 청산"],
  ["SELL", "🔪 1차 분할청산"], ["SELL", "🔪 2차 분할청산"], ["SELL", "🎯 TP1 달성"],
  ["SELL", "🎯 TP2 달성"], ["SELL", "🚫 진입 무효"], ["SELL", "📉 모멘텀 SELL"],
  ["SELL", "🏁 상승 모멘텀 종료"], ["SELL", "PEG Invalid"], ["CHECK", "🏗 셋업 형성 중"],
  ["CHECK", "🌟 VCP 형성"], ["CHECK", "🥄 부분 익절고려"], ["CHECK", "🏉 급등 후 풀백"],
  ["CHECK", "🚨 과열 경고"], ["CHECK", "📈 박스권 돌파"], ["CHECK", "📉 박스권 이탈"],
  ["CHECK", "PEG Start"], ["CHECK", "PEG Expired"], ["CHECK", "🏁 하락 모멘텀 종료"],
  ["CHECK", "✅ 진입 확정"], ["CHECK", "⛔ 진입 만료"],
];
for (const [action, type] of documentedSignals) {
  const result = normalizeSignal({ action, type });
  assert.equal(result.known, true, type);
  assert.equal(result.orderBlocked, false, type);
}

console.log("signal-normalizer test OK");
