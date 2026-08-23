"use strict";

const assert = require("node:assert/strict");
const { accountCommand, enabledBrokerIds, enforceOwnAccountRules, shouldConsumeMessage, SignalReceiptStore } = require("./kis-discord-consumer");

assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "true" }), ["KIWOOM", "KIS"]);
assert.deepEqual(enabledBrokerIds({ ACCOUNT_EXECUTOR_ENABLED: "true", EXECUTOR_KIWOOM_ENABLED: "true", EXECUTOR_KIS_ENABLED: "false" }), ["KIWOOM"]);
assert.deepEqual(enabledBrokerIds({ KIS_CONSUMER_ENABLED: "true" }), ["KIS"]);
assert.deepEqual(enabledBrokerIds({}), []);

assert.equal(accountCommand("계좌 상태 보여줘"), "STATUS");
assert.equal(accountCommand("계좌 상태"), "STATUS");
assert.equal(accountCommand("사용자A 계좌 상태", "사용자A"), "STATUS");
assert.equal(accountCommand("사용자B 계좌 상태", "사용자A"), "");
assert.equal(accountCommand("계좌 최근 주문 보여줘"), "ORDERS");
assert.equal(accountCommand("계좌 명령어 보여줘"), "HELP");
assert.equal(accountCommand("최근 주문 보여줘"), "");

const trusted = { sourceChannelIds: new Set(["channel-1"]), sourceBotIds: new Set(["bot-1"]) };
assert.equal(shouldConsumeMessage({ channelId: "channel-1", author: { id: "bot-1", bot: true } }, trusted), true);
assert.equal(shouldConsumeMessage({ channelId: "channel-2", author: { id: "bot-1", bot: true } }, trusted), false);
assert.equal(shouldConsumeMessage({ channelId: "channel-1", author: { id: "human", bot: false } }, trusted), false);

const store = new SignalReceiptStore(null);
assert.equal(store.claim("request-1", "message-1"), true);
assert.equal(store.claim("request-1", "message-2"), false);
assert.equal(store.claim("request-2", "message-1"), false);
const pending = store.putPending({ payload: { exchange: "NASDAQ", ticker: "PLTR" } }, "approval-1", 60_000);
assert.equal(store.findPending({ ticker: "PLTR" }).key, pending.key);
assert.equal(store.findPending({ messageId: "approval-1" }).key, pending.key);
store.removePending(pending.key);
assert.equal(store.findPending({ ticker: "PLTR" }), null);

const preview = { blocked: false, quantity: 10 };
assert.deepEqual(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ENTRY" } }, { hasExistingPosition: true }, preview),
  { blocked: true, quantity: 0, reason: "해당 계좌에 이미 보유 중 — 중복 진입 차단" },
);
assert.equal(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ADD" } }, { hasExistingPosition: true, positionProfitable: true }, preview),
  preview,
);
assert.equal(
  enforceOwnAccountRules({ risk: { verdict: "PAPER_ADD" } }, { hasExistingPosition: true, positionProfitable: false }, preview).blocked,
  true,
);

console.log("kis-discord-consumer test OK");
