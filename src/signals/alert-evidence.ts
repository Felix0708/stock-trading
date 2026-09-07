"use strict";
const { normalizedTimeframe, normalizedSymbol } = require("../trading/position-ownership");

function alertKey(payload) { return `${String(payload.exchange).toUpperCase()}:${normalizedSymbol(payload.ticker)}:${normalizedTimeframe(payload.timeframe)}`; }
function recordAlertReceipt(evidence, record) {
  if (!record.validation?.ok || !normalizedTimeframe(record.payload?.timeframe) || !Number.isFinite(Date.parse(record.receivedAt))) return false;
  const key = alertKey(record.payload), previous = evidence[key] || {};
  if (Date.parse(previous.lastReceivedAt || "") >= Date.parse(record.receivedAt)) return false;
  evidence[key] = { ...previous, lastReceivedAt: record.receivedAt, requestId: record.requestId };
  return true;
}
function confirmAlert(evidence, input, now = new Date()) {
  const match = String(input).match(/^!alerts verify ([A-Z]+):([A-Z0-9.-]{1,12}) (240|4H|1D|D) ([\w-]{1,80}) (\d{4}-\d{2}-\d{2}|never)$/);
  if (!match) throw Error("형식: !alerts verify NASDAQ:NVDA 240 알람ID 만료일(YYYY-MM-DD 또는 never)");
  const [, exchange, ticker, timeframe, alertId, expires] = match;
  const expiresAt = expires === "never" ? null : `${expires}T23:59:59+09:00`;
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) throw Error("미래 만료일을 입력하세요.");
  const key = alertKey({ exchange, ticker, timeframe });
  evidence[key] = { ...evidence[key], alertId, verifiedAt: now.toISOString(), active: true, expiresAt, expiryKnown: true, source: "owner-confirmed-active-alert" };
  return key;
}
function applyAlertSnapshot(evidence, items, snapshot, now = new Date()) {
  const age = now.getTime() - Date.parse(snapshot?.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 7 * 86400_000 || !Array.isArray(snapshot.rows) || snapshot.rows.length > 2000
    || snapshot.source !== "TradingView alert manager visible UI") throw Error("알람 화면 증빙 형식·날짜 오류");
  let applied = 0;
  for (const row of snapshot.rows) {
    const matches = items.filter(item => item.ticker === row.ticker);
    if (matches.length !== 1 || !normalizedTimeframe(row.timeframe) || !["Active", "Stopped", "Expired"].includes(row.status)) continue;
    const key = alertKey({ ...matches[0], timeframe: row.timeframe });
    if (Date.parse(evidence[key]?.verifiedAt || "") >= Date.parse(snapshot.capturedAt)) continue;
    evidence[key] = { ...evidence[key], verifiedAt: snapshot.capturedAt, active: row.status === "Active", source: snapshot.source, expiresAt: null, expiryKnown: false };
    applied++;
  }
  return applied;
}
function alertEvidenceSummary(items, evidence = {}, now = new Date()) {
  const rows = items.flatMap(item => ["240", "1D"].map(timeframe => {
    const key = alertKey({ ...item, timeframe }), proof = evidence[key] || {};
    const age = now.getTime() - Date.parse(proof.verifiedAt || "");
    const verified = proof.active !== false && age >= 0 && age <= 7 * 86400_000 && (!proof.expiresAt || Date.parse(proof.expiresAt) > now.getTime());
    return { key, ...proof, status: verified ? "활성 확인" : proof.expiresAt && Date.parse(proof.expiresAt) <= now.getTime() ? "만료" : "확인 필요" };
  }));
  return { rows, verified: rows.filter(row => row.status === "활성 확인").length, received: rows.filter(row => row.lastReceivedAt).length };
}
module.exports = { alertKey, recordAlertReceipt, confirmAlert, applyAlertSnapshot, alertEvidenceSummary };
