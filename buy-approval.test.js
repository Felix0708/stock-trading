"use strict";

const assert = require("node:assert/strict");
const { createBuyApproval, findBuyApproval, parseBuyApprovalCommand } = require("./buy-approval");

assert.deepEqual(parseBuyApprovalCommand("사줘 KRX:009830"), { matched: true, ticker: "009830" });
assert.deepEqual(parseBuyApprovalCommand("사줘"), { matched: true, ticker: "" });
assert.equal(parseBuyApprovalCommand("사지마").matched, false);

const record = { requestId: "r1", payload: { action: "BUY", exchange: "KRX", ticker: "009830", name: "한화솔루션" } };
const approval = createBuyApproval(record, 60_000, 1_000);
const approvals = { [approval.key]: approval };
assert.equal(findBuyApproval(approvals, "009830", 2_000).status, "PENDING");
assert.equal(findBuyApproval(approvals, "009830", 61_000).status, "EXPIRED");
assert.equal(findBuyApproval(approvals, "005930", 2_000).status, "NOT_FOUND");

console.log("buy-approval test OK");
