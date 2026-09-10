"use strict";

// Read-only broker collection. Transmission is opt-in; never starts Discord or the order executor.
const { KiwoomClient, kiwoomCredentials } = require("../src/brokers/kiwoom-client");
const { KisClient, kisCredentials } = require("../src/brokers/kis-client");
const { enabledBrokerIds, brokerEnvironments } = require("../src/executor/account-executor");
const { evidenceFile, readEvidence, refreshAccountEquity } = require("../src/executor/account-evidence");
const { accountEquitySeries } = require("../src/integrations/account-equity");
const { syncStockBriefingEquity } = require("../src/integrations/stock-briefing");

(async () => {
  const ids = enabledBrokerIds(), environments = brokerEnvironments(ids);
  if (!ids.length) throw Error("사용할 계좌 설정 없음");
  const file = evidenceFile(process.env.ACCOUNT_SIGNAL_RECEIPT_FILE || process.env.KIS_SIGNAL_RECEIPT_FILE || "account-signal-receipts.json");
  for (const id of ids) {
    const environment = environments[id];
    const overseasClient = id === "KIWOOM" ? new KiwoomClient({ ...kiwoomCredentials(environment, "overseas"), environment, timeoutMs: 15000 })
      : new KisClient({ ...kisCredentials(environment), environment, timeoutMs: 15000 });
    try { await refreshAccountEquity({ id, environment, overseasClient }, file); }
    catch (error) { console.error(`${id} 자산 조회 실패: ${error.message}`); process.exitCode = 1; }
  }
  const state = readEvidence(file);
  console.log(JSON.stringify(accountEquitySeries(state).map(series => ({ broker: series.broker, environment: series.account_type,
    currency: series.currency, scope: series.scope, samples: series.points.length, last: series.points.at(-1) })), null, 2));
  if (process.argv.includes("--send")) console.log("자산 전송 결과", await syncStockBriefingEquity(state));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
