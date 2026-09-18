"use strict";
const { assetReaderBrokers, refreshAssetReader } = require("../src/executor/asset-reader");
const fs = require("node:fs");
const { readEvidence, writeEvidence, evidenceFile } = require("../src/executor/account-evidence");
const brokers = assetReaderBrokers();
const file = ".runtime/selected-currency.evidence.json";
if (!fs.existsSync(file)) {
  const state = readEvidence(file);
  const previous = evidenceFile(process.env.ACCOUNT_SIGNAL_RECEIPT_FILE || process.env.KIS_SIGNAL_RECEIPT_FILE || "account-signal-receipts.json");
  // Reuse opaque identity mappings only. No shared mutable state with the order process.
  state.equityAccounts = readEvidence(previous).equityAccounts || {};
  writeEvidence(file,state);
}
const send = process.argv.includes("--send"), watch = process.argv.includes("--watch");
async function run(force = false) {
  try { console.log(JSON.stringify(await refreshAssetReader(brokers,file,send,force))); }
  catch { console.error("잔고 수신/웹 전송 실패 · 기존 기록 유지"); if (!watch) process.exitCode = 1; }
}
(async () => {
  await run(!watch);
  if (watch) setInterval(() => void run(), 60 * 60_000);
})();
