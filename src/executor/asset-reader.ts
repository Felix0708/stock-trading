"use strict";

// Deliberately separate from the order runtime: no Discord, signals, or order tracker.
const { KiwoomClient, kiwoomCredentials } = require("../brokers/kiwoom-client");
const { KisClient, kisCredentials } = require("../brokers/kis-client");
const { refreshAccountEquity, readEvidence } = require("./account-evidence");
const { syncStockBriefingEquity, syncStockBriefingAccountStatus } = require("../integrations/stock-briefing");

function assetReaderBrokers(env = process.env) {
  const brokers = [];
  for (const environment of ["mock", "live"]) for (const id of ["KIWOOM", "KIS"]) {
    const scope = environment.toUpperCase();
    // Live lookup must never fall back to mock/legacy credentials.
    if (id === "KIWOOM" ? !env[`KIWOOM_${scope}_APP_KEY`] && !env[`KIWOOM_${scope}_DOMESTIC_APP_KEY`]
      : !env[`KIS_${scope}_APP_KEY`]) continue;
    let domesticClient, overseasClient;
    if (id === "KIWOOM") {
      const make = (market) => {
        const credentials = kiwoomCredentials(environment, market, env);
        if (environment === "live" && (!env.KIWOOM_LIVE_SECRET_KEY && !env[`KIWOOM_LIVE_${market.toUpperCase()}_SECRET_KEY`])) throw Error("실계좌 조회용 키 누락");
        const client = new KiwoomClient({ ...credentials, environment, timeoutMs: 15000 });
        const post = client.post.bind(client);
        client.post = (path, options) => {
          if (!(["ka00001", "kt00001", "kt00018"].includes(options.apiId) && path === "/api/dostk/acnt")
            && !(["ust21070", "ust21120", "ust21160"].includes(options.apiId) && path === "/api/us/acnt")) throw Error("잔고 조회 전용 · 다른 API 차단");
          return post(path,options);
        };
        return client;
      };
      domesticClient = make("domestic"); overseasClient = make("overseas");
    } else {
      if (environment === "live" && (!env.KIS_LIVE_APP_SECRET || !env.KIS_LIVE_ACCOUNT_NO)) throw Error("한투 실계좌 조회용 설정 누락");
      const client = new KisClient({ ...kisCredentials(environment,env), environment, timeoutMs:30000 });
      const request = client.request.bind(client);
      client.request = (path, options) => {
        if ((options.method && options.method !== "GET") || !["/uapi/domestic-stock/v1/trading/inquire-balance",
          "/uapi/overseas-stock/v1/trading/inquire-present-balance", "/uapi/overseas-stock/v1/trading/inquire-balance"].includes(path)) throw Error("잔고 조회 전용 · 다른 API 차단");
        return request(path,options);
      };
      domesticClient = overseasClient = client;
    }
    brokers.push({id,environment,domesticClient,overseasClient,selectedCurrencies:true});
  }
  return brokers;
}

async function refreshAssetReader(brokers, file, send = false, force = false) {
  const outcomes = [];
  for (const broker of brokers) {
    try { const changed = await refreshAccountEquity(broker,file,new Date(),force); outcomes.push({broker:broker.id,environment:broker.environment,changed}); }
    catch (error) { outcomes.push({broker:broker.id,environment:broker.environment,error:error instanceof Error && /8050/.test(error.message) ? "접속 IP 등록 필요" : "잔고 조회 실패"}); }
  }
  if (send) {
    const state = readEvidence(file);
    await syncStockBriefingEquity(state);
    await syncStockBriefingAccountStatus(state);
  }
  return outcomes;
}
module.exports = { assetReaderBrokers, refreshAssetReader };
