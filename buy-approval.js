"use strict";

function parseBuyApprovalCommand(content) {
  const match = String(content || "").trim().match(/^사줘(?:\s+([A-Z0-9._:-]+))?$/i);
  return match ? { matched: true, ticker: String(match[1] || "").split(":").pop().toUpperCase() } : { matched: false, ticker: "" };
}

function createBuyApproval(record, ttlMs, now = Date.now()) {
  const payload = record?.payload || {};
  if (payload.action !== "BUY" || !payload.ticker) throw new Error("BUY 신호와 종목코드가 필요합니다.");
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("승인 유효시간이 올바르지 않습니다.");
  return {
    key: `${payload.exchange || "UNKNOWN"}:${payload.ticker}`,
    ticker: String(payload.ticker).toUpperCase(),
    name: payload.name || "",
    createdAt: now,
    expiresAt: now + ttlMs,
    record,
  };
}

function findBuyApproval(approvals, ticker, now = Date.now()) {
  const matches = Object.values(approvals || {})
    .filter((item) => item.ticker === String(ticker || "").toUpperCase())
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!matches.length) return { status: "NOT_FOUND", approval: null };
  return matches[0].expiresAt <= now
    ? { status: "EXPIRED", approval: matches[0] }
    : { status: "PENDING", approval: matches[0] };
}

module.exports = { createBuyApproval, findBuyApproval, parseBuyApprovalCommand };
