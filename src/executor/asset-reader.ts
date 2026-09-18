"use strict";

// Deliberately separate from the order runtime: no Discord, signals, or order tracker.
const { KiwoomClient, kiwoomCredentials } = require("../brokers/kiwoom-client");
const { KisClient, kisCredentials } = require("../brokers/kis-client");
const { refreshAccountEquity, readEvidence, equityCollectionOpen } = require("./account-evidence");
const { syncStockBriefingEquity, syncStockBriefingAccountStatus, syncBrokerHoldings } = require("../integrations/stock-briefing");
const { collectLiveHoldings } = require("./live-holdings");

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
          if (path === "/oauth2/token" && !options.apiId) return post(path,options);
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
  if (env.ISA_BROKER) {
    if (!["KIS", "KIWOOM"].includes(env.ISA_BROKER)) throw Error("ISA_BROKER는 KIS 또는 KIWOOM 한 곳만 지정하세요.");
    const id = env.ISA_BROKER;
    const appKey = env[`${id}_ISA_APP_KEY`], appSecret = env[`${id}_ISA_${id === "KIS" ? "APP_SECRET" : "SECRET_KEY"}`];
    if (!appKey || !appSecret || (id === "KIS" && !/^\d{8}-\d{2}$/.test(env.KIS_ISA_ACCOUNT_NO || ""))) throw Error("ISA 전용 키·계좌 설정 누락");
    if (id === "KIS" ? env.KIS_ISA_ACCOUNT_NO === env.KIS_LIVE_ACCOUNT_NO : [env.KIWOOM_LIVE_APP_KEY,env.KIWOOM_LIVE_DOMESTIC_APP_KEY].includes(appKey)) throw Error("일반계좌와 ISA를 중복 연결할 수 없습니다.");
    const client = id === "KIS"
      ? new KisClient({ appKey, appSecret, accountNo: env.KIS_ISA_ACCOUNT_NO, environment:"live", timeoutMs:30000 })
      : new KiwoomClient({ appKey, secretKey:appSecret, environment:"live", timeoutMs:15000 });
    if (id === "KIS") {
      const request = client.request.bind(client);
      client.request = (path, options) => {
        if (path !== "/uapi/domestic-stock/v1/trading/inquire-balance" || (options.method && options.method !== "GET")) throw Error("ISA 잔고 조회 전용 · 다른 API 차단");
        return request(path,options);
      };
    } else {
      const post = client.post.bind(client);
      client.post = (path,options) => {
        if (path === "/oauth2/token" && !options.apiId) return post(path,options);
        if (path !== "/api/dostk/acnt" || !["ka00001","kt00001","kt00018"].includes(options.apiId)) throw Error("ISA 잔고 조회 전용 · 다른 API 차단");
        return post(path,options);
      };
    }
    brokers.push({id,environment:"live",accountKind:"isa",domesticClient:client,overseasClient:client,selectedCurrencies:false});
  }
  return brokers;
}

async function refreshAssetReader(brokers, file, send = false, force = false) {
  const outcomes = [];
  const snapshots = [];
  for (const broker of brokers) {
    try { const changed = await refreshAccountEquity(broker,file,new Date(),force); outcomes.push({broker:broker.id,environment:broker.environment,accountKind:broker.accountKind || "general",changed}); }
    catch (error) { outcomes.push({broker:broker.id,environment:broker.environment,error:error instanceof Error && /8050/.test(error.message) ? "접속 IP 등록 필요" : "잔고 조회 실패"}); }
    if (send && broker.environment === "live" && (force || equityCollectionOpen(broker,new Date()))) snapshots.push(...await collectLiveHoldings(broker));
  }
  if (send) {
    const state = readEvidence(file);
    const sent=await Promise.allSettled([syncStockBriefingEquity(state),syncStockBriefingAccountStatus(state),syncBrokerHoldings(snapshots)]);
    if(sent.some(r=>r.status==="rejected")) throw Error("잔고·자산·상태 중 일부 웹 수신 미확인 · 기존 기록 유지");
  }
  return outcomes;
}
module.exports = { assetReaderBrokers, refreshAssetReader };
