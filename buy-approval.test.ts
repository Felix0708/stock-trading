"use strict";

const assert = require("node:assert/strict");
const { createBuyApproval, findBuyApproval, parseBuyApprovalCommand } = require("./buy-approval");

assert.deepEqual(parseBuyApprovalCommand("사줘 KRX:009830"), {
  matched: true, ambiguous: false, action: "BUY", brokers: ["KIWOOM", "KIS"], ticker: "009830",
});
assert.deepEqual(parseBuyApprovalCommand("둘다"), {
  matched: true, ambiguous: false, action: "BUY", brokers: ["KIWOOM", "KIS"], ticker: "",
});
assert.deepEqual(parseBuyApprovalCommand("키움"), {
  matched: true, ambiguous: false, action: "BUY", brokers: ["KIWOOM"], ticker: "",
});
assert.deepEqual(parseBuyApprovalCommand("한투만 PLTR"), {
  matched: true, ambiguous: false, action: "BUY", brokers: ["KIS"], ticker: "PLTR",
});
assert.deepEqual(parseBuyApprovalCommand("둘다 ㄴㄴ"), {
  matched: true, ambiguous: false, action: "CANCEL", brokers: ["KIWOOM", "KIS"], ticker: "",
});
assert.equal(parseBuyApprovalCommand("안 살래").action, "CANCEL");
assert.equal(parseBuyApprovalCommand("취소 KRX:009830").ticker, "009830");
assert.equal(parseBuyApprovalCommand("키움 이렇게 보내거나").matched, false);
assert.equal(parseBuyApprovalCommand("키움 사줘 한투는 안 사").ambiguous, true);

const record = { requestId: "r1", payload: { action: "BUY", exchange: "KRX", ticker: "009830", name: "한화솔루션" } };
const approval = createBuyApproval(record, 60_000, 1_000);
const approvals = { [approval.key]: approval };
assert.equal(findBuyApproval(approvals, "009830", 2_000).status, "PENDING");
assert.equal(findBuyApproval(approvals, "009830", 61_000).status, "EXPIRED");
assert.equal(findBuyApproval(approvals, "005930", 2_000).status, "NOT_FOUND");

console.log("buy-approval test OK");
