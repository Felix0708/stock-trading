"use strict";

const assert = require("node:assert/strict");
const {
  extractGroupDiscussionTopic,
  isHelpRequest,
  isAccountExecutorRequest,
  isResetRequest,
  isGroupDiscussionRequest,
  isStopRequest,
  naturalTradeCommand,
  pickResponder,
  resolveGroupDiscussionTopic,
  sessionKey,
} = require("./conversation-router");

const personas = [
  { id: "druckenmiller" },
  { id: "oneil" },
  { id: "minervini" },
  { id: "livermore" },
  { id: "qullamaggie" },
];

// Given an unnamed risk-management question, route it to the relevant persona.
assert.equal(pickResponder({ content: "손절과 포지션 크기는 어떻게 잡아?", personas }), "minervini");

// Given a vague follow-up, keep the last speaker so the conversation continues naturally.
assert.equal(pickResponder({ content: "그럼 언제가 좋아?", lastPersonaId: "livermore", personas }), "livermore");

// Fixed-purpose channels still keep their designated responder.
assert.equal(pickResponder({ content: "오늘 어때?", fixedPersonaId: "druckenmiller", personas }), "druckenmiller");

// Natural stop words work only as standalone commands.
for (const command of ["그만", "멈춰", "대화 그만", "여기까지", "!stop"]) assert.equal(isStopRequest(command), true);
assert.equal(isStopRequest("주가가 멈췄어?"), false);

// Safe conversational commands have natural-language aliases.
assert.equal(isGroupDiscussionRequest("반도체 종목 같이 토론해줘"), true);
assert.equal(isGroupDiscussionRequest("반도체 종목 토론해봐"), true);
assert.equal(extractGroupDiscussionTopic("반도체 종목 같이 토론해줘"), "반도체 종목");
assert.match(
  resolveGroupDiscussionTopic(
    "모두의 의견이 궁금해",
    "사용자: 블룸에너지에 대해서 어떻게 생각해?\n드러켄밀러: 블룸에너지(BE)는 데이터센터 전력 수요 수혜주입니다.",
  ),
  /블룸에너지.*직전 대화의 주제를 이어서 답하세요/s,
);
assert.equal(isGroupDiscussionRequest("!roundtable 반도체 종목"), false);
assert.equal(isResetRequest("대화 새로 시작"), true);
assert.equal(isHelpRequest("도움말 보여줘"), true);
assert.equal(isAccountExecutorRequest("계좌 상태 보여줘"), true);
assert.equal(isAccountExecutorRequest("계좌 상태"), true);
assert.equal(isAccountExecutorRequest("사용자A 계좌 상태"), true);
assert.equal(isAccountExecutorRequest("최근 주문 보여줘"), false);
assert.equal(naturalTradeCommand("매매 상태 보여줘"), "!trade status");
assert.equal(naturalTradeCommand("최근 주문 보여줘"), "!trade orders");
assert.equal(naturalTradeCommand("매매 명령어 보여줘"), "!trade help");
assert.equal(naturalTradeCommand("매매 중지해줘"), "");

// A persona keeps separate Codex memory for each Discord channel.
assert.notEqual(sessionKey("oneil", "channel-a"), sessionKey("oneil", "channel-b"));

console.log("conversation-router test OK");
