"use strict";
const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
const { normalizedTimeframe } = require("./position-ownership");
const POLICY_VERSION = "2026-09-07-owned-timeframe-v1";
function policyFingerprint(env = process.env) {
  const hash = createHash("sha256");
  for (const file of ["position-sizer.ts", "position-ownership.ts", "trade-controller.ts", "paper-order-executor.ts", "../executor/account-executor.ts", "../signals/signal-state-machine.ts"]) {
    hash.update(file); hash.update(fs.readFileSync(path.join(__dirname, file)));
  }
  for (const key of ["ACCOUNT_AUTO_CAP_RATIO", "ACCOUNT_MAX_OPEN_RISK_RATIO", "MAX_OPEN_POSITIONS", "PARTIAL_EXIT_1_RATIO", "PARTIAL_EXIT_2_RATIO", "BUY_APPROVAL_TTL_MINUTES"]) hash.update(`${key}=${env[key] || "default"}\n`);
  return hash.digest("hex");
}
function assertLivePolicy(environments, readOnly, hash, env = process.env) {
  if (!readOnly && Object.values(environments).includes("live") && env.ACCOUNT_APPROVED_POLICY_HASH !== hash) throw Error(`실계좌 정책 검토·고정 필요: ACCOUNT_APPROVED_POLICY_HASH=${hash}`);
}

function recordForwardStudy(file, record, options = {}) {
  const p = record.payload || {}, time = Date.parse(record.receivedAt), now = Date.now();
  if ((options as any).recovered || !record.validation?.ok || !normalizedTimeframe(p.timeframe) || !(p.price > 0)
    || !Number.isFinite(time) || time > now || now - time > 30 * 60_000) return false;
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, startedAt: new Date().toISOString(), observations: [] };
  if (time < Date.parse(state.startedAt) - 30_000 || state.observations.some(row => row.requestId === record.requestId)) return false;
  const key = `${p.exchange}:${p.ticker}:${normalizedTimeframe(p.timeframe)}`;
  // Next same-timeframe observed signal, not a fictitious fill or a fixed-horizon return.
  for (const row of state.observations.filter(row => row.key === key && !row.nextObservation && Date.parse(row.at) < time)) {
    row.nextObservation = { at: record.receivedAt, price: p.price, priceChangePct: (p.price / row.price - 1) * 100 };
  }
  if (p.action === "BUY" && ["ENTRY_CANDIDATE", "ADD_CANDIDATE"].includes(record.outcome?.decision)) {
    const sigma = typeof p.sb_z_score === "number" && Number.isFinite(p.sb_z_score) ? p.sb_z_score : null;
    state.observations.push({ requestId: record.requestId, key, at: record.receivedAt, price: p.price, sigma,
      commonVerdict: record.risk?.verdict, policyVersion: POLICY_VERSION, policyHash: (options as any).policyHash,
      comparison: { liveSigmaCeiling25: sigma === null ? null : sigma <= 2.5, mockSigmaCeiling35: sigma === null ? null : sigma <= 3.5 },
      note: "Sigma 필터만 비교. 다른 게이트·현금·체결·부분매매는 평가하지 않음. 실제 승률/수익률이 아님." });
  }
  // ponytail: JSON forward observations; archive completed observations if rewrite size becomes material.
  const temporary = `${file}.tmp`, fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  return true;
}
module.exports = { POLICY_VERSION, policyFingerprint, assertLivePolicy, recordForwardStudy };
