"use strict";

function parseBuyApprovalCommand(content) {
  const raw = String(content || "").trim();
  const none = { matched: false, ambiguous: false, action: "", brokers: [], ticker: "" };
  if (!raw || raw.length > 48) return none;

  const tickerMatch = raw.match(/(?:^|\s)([A-Z0-9._-]+(?::[A-Z0-9._-]+)?)$/i);
  const ticker = tickerMatch ? tickerMatch[1].split(":").pop().toUpperCase() : "";
  const command = (tickerMatch ? raw.slice(0, tickerMatch.index) : raw).trim().replace(/\s+/g, " ");
  const result = (action, brokers) => ({ matched: true, ambiguous: false, action, brokers, ticker });

  const cancel = /^(?:안\s*사(?:줘|지마|지\s*말자|도\s*돼|도돼)?|안\s*살래|사지마|취소|둘\s*다\s*(?:ㄴㄴ|안\s*사|취소)|모두\s*취소|전부\s*취소)$/;
  const all = /^(?:사\s*줘|둘\s*다(?:\s*사\s*줘)?|모두\s*사\s*줘|전부\s*사\s*줘|양쪽(?:\s*사\s*줘)?)$/;
  const kiwoom = /^(?:키움(?:만|으로)?|키움(?:에서|으로)?\s*사\s*줘|한투\s*말고\s*키움)$/;
  const kis = /^(?:한투(?:만|로)?|한투(?:에서|로)?\s*사\s*줘|키움\s*말고\s*한투)$/;
  if (cancel.test(command)) return result("CANCEL", ["KIWOOM", "KIS"]);
  if (all.test(command)) return result("BUY", ["KIWOOM", "KIS"]);
  if (kiwoom.test(command)) return result("BUY", ["KIWOOM"]);
  if (kis.test(command)) return result("BUY", ["KIS"]);

  const mentionsBroker = /키움|한투|둘\s*다/.test(command);
  const mentionsAction = /사\s*줘|안\s*사|사지마|취소|ㄴㄴ/.test(command);
  if (mentionsBroker && mentionsAction) {
    return { matched: true, ambiguous: true, action: "AMBIGUOUS", brokers: [], ticker };
  }
  return none;
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
  const matches = Object.values<any>(approvals || {})
    .filter((item) => item.ticker === String(ticker || "").toUpperCase())
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!matches.length) return { status: "NOT_FOUND", approval: null };
  return matches[0].expiresAt <= now
    ? { status: "EXPIRED", approval: matches[0] }
    : { status: "PENDING", approval: matches[0] };
}

module.exports = { createBuyApproval, findBuyApproval, parseBuyApprovalCommand };
