"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MOCK_BASE_URL = "https://openapivts.koreainvestment.com:29443";
const LIVE_BASE_URL = "https://openapi.koreainvestment.com:9443";
const US_EXCHANGE: Record<string, string> = { ND: "NASD", NASDAQ: "NASD", NASD: "NASD", NY: "NYSE", NYSE: "NYSE", NA: "AMEX", AMEX: "AMEX", ARCA: "AMEX", NYSEARCA: "AMEX" };

function kisCredentials(environment: string, env: NodeJS.ProcessEnv = process.env) {
  if (!["mock", "live"].includes(environment)) throw new Error("KIS_ENV는 mock 또는 live여야 합니다.");
  const scope = environment.toUpperCase();
  const appKey = env[`KIS_${scope}_APP_KEY`] || env.KOREA_INVESTMENT_APP_KEY;
  const appSecret = env[`KIS_${scope}_APP_SECRET`] || env.KOREA_INVESTMENT_APP_SECRET;
  const accountNo = env[`KIS_${scope}_ACCOUNT_NO`] || env.KIS_ACCOUNT_NO;
  if (!appKey || !appSecret || !accountNo) throw new Error(`한투 ${environment === "live" ? "실계좌" : "모의계좌"} App Key·App Secret·계좌번호가 필요합니다.`);
  return { appKey, appSecret, accountNo };
}

function number(value: unknown) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function status(orderQuantity: number, filledQuantity: number, remainingQuantity: number) {
  if (orderQuantity > 0 && filledQuantity >= orderQuantity) return "FILLED";
  if (remainingQuantity <= 0) return "CANCELLED";
  if (filledQuantity > 0) return "PARTIALLY_FILLED";
  return "ACCEPTED";
}

function uncertainOrderError(message: string) {
  const error: any = new Error(`${message} 주문 처리 여부를 확인할 수 없어 자동 재전송하지 않습니다.`);
  error.orderStatusUnknown = true;
  return error;
}

function transientHttpStatus(status: number) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

class KisClient {
  appKey: string;
  appSecret: string;
  accountNo: string;
  productCode: string;
  environment: string;
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs: number;
  requestIntervalMs: number;
  rateLimitWaitMs: number;
  requestQueue: Promise<any>;
  lastRequestAt: number;
  token: string | null;
  tokenExpiresAt: number;
  tokenCacheFile: string;
  tokenRequest: Promise<string> | null = null;
  tokenRetryAt = 0;
  tokenError: Error | null = null;

  constructor(options: Record<string, any> = {}) {
    const environment = options.environment || "mock";
    if (!["mock", "live"].includes(environment)) throw new Error("KIS_ENV는 mock 또는 live여야 합니다.");
    const baseUrl = environment === "live" ? LIVE_BASE_URL : MOCK_BASE_URL;
    if (options.baseUrl && options.baseUrl !== baseUrl) throw new Error(`한투 ${environment === "live" ? "실계좌" : "모의투자"} 주소가 올바르지 않습니다.`);
    const [accountNo, embeddedProductCode] = String(options.accountNo || "").split("-");
    if (!/^\d{8}$/.test(accountNo)) throw new Error("한투 계좌번호 앞 8자리가 필요합니다.");
    const productCode = String(options.productCode || embeddedProductCode || "01");
    if (!/^\d{2}$/.test(productCode)) throw new Error("한투 계좌 상품코드는 2자리여야 합니다.");
    if (!options.appKey || !options.appSecret) throw new Error("한투 App Key와 App Secret이 필요합니다.");
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.accountNo = accountNo;
    this.productCode = productCode;
    this.environment = environment;
    this.baseUrl = baseUrl;
    this.fetch = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 5_000;
    this.requestIntervalMs = options.requestIntervalMs ?? 1_100;
    this.rateLimitWaitMs = options.rateLimitWaitMs ?? 61_000;
    this.requestQueue = Promise.resolve();
    this.lastRequestAt = 0;
    this.token = null;
    this.tokenExpiresAt = 0;
    const cacheKey = crypto.createHash("sha256").update(`${this.baseUrl}:${this.appKey}`).digest("hex").slice(0, 12);
    this.tokenCacheFile = options.tokenCacheFile === undefined && this.fetch === fetch
      ? path.join(process.cwd(), `.kis-token-${cacheKey}.json`)
      : options.tokenCacheFile || "";
  }

  async accessToken() {
    if (this.tokenRequest) return this.tokenRequest;
    if ((!this.token || Date.now() >= this.tokenExpiresAt) && this.tokenCacheFile && fs.existsSync(this.tokenCacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(this.tokenCacheFile, "utf8"));
        if (Number.isFinite(cached.retryAt)) this.tokenRetryAt = Math.max(this.tokenRetryAt, cached.retryAt);
        if (typeof cached.token === "string" && Number(cached.expiresAt) > Date.now() + 60_000) {
          this.token = cached.token;
          this.tokenExpiresAt = Number(cached.expiresAt);
        }
      } catch {
        // 손상된 캐시는 무시하고 새 토큰을 받습니다.
      }
    }
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (Date.now() < this.tokenRetryAt) {
      throw Object.assign(new Error(this.tokenError?.message || "한투 인증 재발급 대기 · 1분당 1회 제한 보호"), {
        accountVerificationFailed: true, retryAfterMs: this.tokenRetryAt - Date.now(),
      });
    }
    this.tokenRetryAt = Date.now() + 61_000;
    this.tokenRequest = this.issueAccessToken().catch(error => {
      this.tokenRetryAt = Math.max(this.tokenRetryAt, Date.now() + 61_000);
      this.tokenError = error instanceof Error ? error : new Error(String(error));
      this.writeTokenCache();
      throw Object.assign(this.tokenError, { accountVerificationFailed: true, retryAfterMs: this.tokenRetryAt - Date.now() });
    }).finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  writeTokenCache() {
    if (!this.tokenCacheFile) return;
    const temporary = `${this.tokenCacheFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ token: this.token, expiresAt: this.tokenExpiresAt, retryAt: this.tokenRetryAt })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.tokenCacheFile);
  }

  async issueAccessToken() {
    // Preserve issuance cooldown across restarts; a failed authentication is not an order submission.
    this.writeTokenCache();
    let response;
    let text;
    try {
      response = await this.fetch(`${this.baseUrl}/oauth2/tokenP`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", appkey: this.appKey, appsecret: this.appSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new Error(`한투 ${this.environment === "live" ? "실계좌" : "모의"} 인증 통신 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`한투 ${this.environment === "live" ? "실계좌" : "모의"} 인증 응답이 JSON이 아닙니다. (HTTP ${response.status})`);
    }
    if (!response.ok || typeof result?.access_token !== "string" || !result.access_token || number(result.expires_in) <= 60) {
      throw new Error(`한투 ${this.environment === "live" ? "실계좌" : "모의"} 인증 실패: ${result?.error_description || result?.msg1 || `유효한 토큰·유효기간 없음 (HTTP ${response.status})`}`);
    }
    const token: string = result.access_token;
    this.token = token;
    this.tokenExpiresAt = Date.now() + Math.max(60, number(result.expires_in) - 60) * 1_000;
    this.tokenError = null;
    this.writeTokenCache();
    return token;
  }

  async request(path: string, { method = "GET", trId, params, body, retryTransient = method === "GET", canSubmit, trCont = "" }: any = {}): Promise<any> {
    const sharedTrId = ["HHDFS00000300", "FHKST01010100"].includes(trId);
    if (!trId || (!sharedTrId && (this.environment === "mock" ? !trId.startsWith("V") : trId.startsWith("V")))) throw new Error(`한투 ${this.environment === "live" ? "실계좌" : "모의"} TR ID가 올바르지 않습니다.`);
    const queued = this.requestQueue.then(async () => {
      const query = params ? `?${new URLSearchParams(params)}` : "";
      let authorizationRetried = false;
      let rateLimitRetried = false;
      let transientRetried = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const token = await this.accessToken();
        const waitMs = this.requestIntervalMs - (Date.now() - this.lastRequestAt);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.lastRequestAt = Date.now();
        if (canSubmit && !canSubmit()) throw Object.assign(new Error("자동매매 OFF · 주문 송신 중지"), { autoTradingPaused: true });
        let response;
        try {
          response = await this.fetch(`${this.baseUrl}${path}${query}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              appkey: this.appKey,
              appsecret: this.appSecret,
              tr_id: trId,
              custtype: "P",
              ...(trCont ? { tr_cont: trCont } : {}),
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch (error) {
          if (retryTransient && !transientRetried) {
            transientRetried = true;
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          const message = `한투 ${this.environment === "live" ? "실계좌" : "모의"} 통신 실패 [${trId}]: ${error instanceof Error ? error.message : String(error)}.`;
          throw retryTransient ? new Error(message) : uncertainOrderError(message);
        }
        let text;
        try { text = await response.text(); } catch (error) {
          if (retryTransient && !transientRetried) {
            transientRetried = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw retryTransient ? error : uncertainOrderError("한투 주문 응답 본문 수신 중 통신이 끊겼습니다.");
        }
        let result;
        try {
          result = text ? JSON.parse(text) : {};
        } catch {
          if (retryTransient && !transientRetried) {
            transientRetried = true;
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          const message = `한투 ${this.environment === "live" ? "실계좌" : "모의"} 응답이 JSON이 아닙니다 [${trId}] (HTTP ${response.status}).`;
          throw retryTransient ? new Error(message) : uncertainOrderError(message);
        }
        if (!result || typeof result !== "object" || typeof result.rt_cd !== "string" || !result.rt_cd) {
          if (retryTransient && !transientRetried) {
            transientRetried = true;
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          const message = `한투 응답에 처리 결과(rt_cd)가 없습니다 [${trId}] (HTTP ${response.status}).`;
          throw retryTransient ? new Error(message) : uncertainOrderError(message);
        }
        if (!authorizationRetried && result.msg_cd === "EGW00123") {
          authorizationRetried = true;
          this.token = null;
          this.tokenExpiresAt = 0;
          this.writeTokenCache();
          continue;
        }
        if (!rateLimitRetried && result.msg_cd === "EGW00201") {
          rateLimitRetried = true;
          await new Promise((resolve) => setTimeout(resolve, this.rateLimitWaitMs));
          continue;
        }
        // Gateway failures can arrive as HTTP 200 with a normal KIS error body.
        // Match the reported routing message, not every business rejection or an assumed msg_cd.
        const gatewayFailure = result.rt_cd !== "0" && /Gateway\s*라우팅\s*오류/i.test(String(result.msg1 || ""));
        if (retryTransient && !transientRetried && (transientHttpStatus(response.status) || gatewayFailure)) {
          transientRetried = true;
          await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? this.rateLimitWaitMs : 500));
          continue;
        }
        if (!response.ok || result.rt_cd !== "0") {
          const message = `한투 ${this.environment === "live" ? "실계좌" : "모의"} API 실패 [${trId}]: ${result.msg1 || "오류 상세 없음"} (${result.msg_cd || result.rt_cd}, HTTP ${response.status})`;
          throw !retryTransient && (transientHttpStatus(response.status) || gatewayFailure) ? uncertainOrderError(`${message}.`) : new Error(message);
        }
        Object.defineProperty(result, "continuation", { value: ["M", "F"].includes(response.headers.get("tr_cont") || "") });
        return result;
      }
      throw new Error("한투 인증 재시도에 실패했습니다.");
    });
    this.requestQueue = queued.catch(() => {});
    return queued;
  }

  accountParams(extra: Record<string, any> = {}) {
    return { CANO: this.accountNo, ACNT_PRDT_CD: this.productCode, ...extra };
  }

  trId(mock: string, live: string) {
    return this.environment === "live" ? live : mock;
  }

  async getDomesticBalance() {
    const result = await this.request("/uapi/domestic-stock/v1/trading/inquire-balance", {
      trId: this.trId("VTTC8434R", "TTTC8434R"),
      params: this.accountParams({
        AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "02", UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "01",
        CTX_AREA_FK100: "", CTX_AREA_NK100: "",
      }),
    });
    const summary = Array.isArray(result.output2) ? result.output2[0] || {} : result.output2 || {};
    return {
      estimatedAssets: number(summary.nass_amt || summary.tot_evlu_amt),
      totalEvaluation: number(summary.tot_evlu_amt || summary.nass_amt),
      holdings: (result.output1 || []).filter((item: any) => number(item.hldg_qty) > 0).map((item: any) => ({
        code: String(item.pdno || "").replace(/^A/, ""), name: item.prdt_name,
        quantity: number(item.hldg_qty), tradableQuantity: number(item.ord_psbl_qty),
        price: number(item.prpr), evaluationAmount: number(item.evlu_amt), purchaseAmount: number(item.pchs_amt),
        profitLoss: number(item.evlu_pfls_amt), profitRate: number(item.evlu_pfls_rt),
      })),
    };
  }

  async getDomesticCash({ symbol, price }: any) {
    const result = await this.request("/uapi/domestic-stock/v1/trading/inquire-psbl-order", {
      trId: this.trId("VTTC8908R", "TTTC8908R"),
      params: this.accountParams({ PDNO: symbol, ORD_UNPR: String(price || 0), ORD_DVSN: "01", CMA_EVLU_AMT_ICLD_YN: "Y", OVRS_ICLD_YN: "Y" }),
    });
    return { orderableAmount: number(result.output?.nrcvb_buy_amt || result.output?.ord_psbl_cash) };
  }

  async getDomesticQuote({ symbol }: any) {
    if (!/^\d{6}$/.test(symbol)) throw new Error("국내 종목코드가 올바르지 않습니다.");
    const result = await this.request("/uapi/domestic-stock/v1/quotations/inquire-price", {
      trId: "FHKST01010100", params: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol },
    });
    const currentPrice = number(result.output?.stck_prpr);
    if (currentPrice <= 0) throw new Error("한투 국내주식 현재가 응답이 비어 있습니다.");
    return { symbol, currentPrice };
  }

  async placeDomesticMarketOrder({ side, symbol, quantity, price, session = "REGULAR", orderStyle = "MARKET", canSubmit }: any) {
    if (!["BUY", "SELL"].includes(side) || !/^\d{6}$/.test(symbol) || !Number.isInteger(quantity) || quantity < 1) throw new Error("국내 모의주문 값이 올바르지 않습니다.");
    if (!["MARKET", "PROTECTED"].includes(orderStyle)) throw new Error("국내주식 주문방식이 올바르지 않습니다.");
    const orderType = session === "REGULAR" && orderStyle === "PROTECTED" ? "15" : ({ PRE: "05", REGULAR: "01", AFTER_CLOSE: "06", AFTER_SINGLE: "07" } as Record<string, string>)[session];
    if (!orderType) throw new Error("국내주식 주문 가능 시간이 아닙니다.");
    if (session === "AFTER_SINGLE" && (!Number.isFinite(price) || price <= 0)) throw new Error("시간외 단일가 주문 가격이 필요합니다.");
    const result = await this.request("/uapi/domestic-stock/v1/trading/order-cash", {
      method: "POST", trId: side === "BUY" ? this.trId("VTTC0012U", "TTTC0012U") : this.trId("VTTC0011U", "TTTC0011U"),
      canSubmit,
      body: this.accountParams({ PDNO: symbol, ORD_DVSN: orderType, ORD_QTY: String(quantity), ORD_UNPR: session === "AFTER_SINGLE" ? String(price) : "0", EXCG_ID_DVSN_CD: "KRX", SLL_TYPE: "01", CNDT_PRIC: "0" }),
    });
    const orderNo = result.output?.ODNO || result.output?.odno;
    if (!orderNo) throw uncertainOrderError("한투 국내주식 주문 접수 응답에 주문번호가 없습니다.");
    return { orderNo: String(orderNo), symbol, side, status: "ACCEPTED" };
  }

  async getDomesticOrderExecutions({ symbol = "" } = {}) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
    const result = await this.request("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", {
      trId: this.trId("VTTC0081R", "TTTC0081R"),
      params: this.accountParams({ INQR_STRT_DT: today, INQR_END_DT: today, SLL_BUY_DVSN_CD: "00", INQR_DVSN: "00", PDNO: symbol, CCLD_DVSN: "00", ORD_GNO_BRNO: "", ODNO: "", INQR_DVSN_3: "00", INQR_DVSN_1: "", CTX_AREA_FK100: "", CTX_AREA_NK100: "" }),
    });
    return (result.output1 || []).map((item: any) => {
      const orderQuantity = number(item.ord_qty);
      const filledQuantity = number(item.tot_ccld_qty);
      const remainingQuantity = number(item.rmn_qty ?? orderQuantity - filledQuantity);
      return { orderNo: String(item.odno), symbol: String(item.pdno || "").replace(/^A/, ""), orderQuantity, filledQuantity, remainingQuantity, fillPrice: number(item.avg_prvs || item.avg_pric), status: status(orderQuantity, filledQuantity, remainingQuantity) };
    });
  }

  kisExchange(exchange: string) {
    const value = US_EXCHANGE[String(exchange || "").toUpperCase()];
    if (!value) throw new Error(`지원하지 않는 한투 미국 거래소: ${exchange || "없음"}`);
    return value;
  }

  async getUsBalance({ exchange = "ND" }: any = {}) {
    const market = this.kisExchange(exchange);
    const result = await this.request("/uapi/overseas-stock/v1/trading/inquire-balance", {
      trId: this.trId("VTTS3012R", "TTTS3012R"),
      params: this.accountParams({ OVRS_EXCG_CD: market, TR_CRCY_CD: "USD", CTX_AREA_FK200: "", CTX_AREA_NK200: "" }),
    });
    return {
      exchange: market,
      holdings: (result.output1 || []).filter((item: any) => number(item.ovrs_cblc_qty) > 0).map((item: any) => ({
        code: item.ovrs_pdno, name: item.ovrs_item_name, exchange, quantity: number(item.ovrs_cblc_qty),
        tradableQuantity: number(item.ord_psbl_qty ?? item.ovrs_cblc_qty), price: number(item.now_pric2),
        evaluationAmount: number(item.ovrs_stck_evlu_amt), purchaseAmount: number(item.frcr_pchs_amt1),
        profitLoss: number(item.frcr_evlu_pfls_amt), profitRate: number(item.evlu_pfls_rt),
      })),
      summary: Array.isArray(result.output2) ? result.output2[0] || {} : result.output2 || {},
    };
  }

  async getUsBalances(exchanges: string[] = ["ND", "NY", "NA"]) {
    const balances: any[] = [];
    for (const exchange of exchanges) {
      balances.push(await this.getUsBalance({ exchange }));
    }
    return balances;
  }

  async getUsCash({ exchange, symbol, price }: any) {
    const result = await this.request("/uapi/overseas-stock/v1/trading/inquire-psamount", {
      trId: this.trId("VTTS3007R", "TTTS3007R"),
      params: this.accountParams({ OVRS_EXCG_CD: this.kisExchange(exchange), OVRS_ORD_UNPR: String(price), ITEM_CD: symbol }),
    });
    return {
      usd: number(result.output?.ovrs_ord_psbl_amt || result.output?.frcr_ord_psbl_amt1),
      usdExchangeRate: number(result.output?.exrt),
    };
  }

  async getUsdExchangeRate() {
    const result = await this.request("/uapi/overseas-stock/v1/trading/inquire-present-balance", {
      trId: this.trId("VTRP6504R", "CTRP6504R"),
      params: this.accountParams({ WCRC_FRCR_DVSN_CD: "01", NATN_CD: "840", TR_MKET_CD: "00", INQR_DVSN_CD: "00" }),
    });
    const summary = Array.isArray(result.output2) ? result.output2[0] || {} : result.output2 || {};
    const exchangeRate = number(summary.frst_bltn_exrt);
    if (exchangeRate <= 0) throw new Error("한투 USD 환율 응답이 비어 있습니다.");
    return exchangeRate;
  }

  async getUsQuote({ exchange, symbol }: any) {
    const market = ({ NASD: "NAS", NYSE: "NYS", AMEX: "AMS" } as Record<string, string>)[this.kisExchange(exchange)];
    const result = await this.request("/uapi/overseas-price/v1/quotations/price", {
      trId: "HHDFS00000300",
      params: { AUTH: "", EXCD: market, SYMB: symbol },
    });
    const currentPrice = number(result.output?.last);
    if (currentPrice <= 0) throw new Error("한투 미국주식 현재가 응답이 비어 있습니다.");
    return { exchange, symbol, currentPrice, previousClose: number(result.output?.base) };
  }

  async placeUsLimitOrder({ side, exchange, symbol, quantity, price, canSubmit }: any) {
    if (!["BUY", "SELL"].includes(side) || !symbol || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price <= 0) throw new Error("미국 모의주문 값이 올바르지 않습니다.");
    const result = await this.request("/uapi/overseas-stock/v1/trading/order", {
      method: "POST", trId: side === "BUY" ? this.trId("VTTT1002U", "TTTT1002U") : this.trId("VTTT1001U", "TTTT1006U"),
      canSubmit,
      body: this.accountParams({ OVRS_EXCG_CD: this.kisExchange(exchange), PDNO: symbol, ORD_QTY: String(quantity), OVRS_ORD_UNPR: String(price), CTAC_TLNO: "", MGCO_APTM_ODNO: "", SLL_TYPE: "00", ORD_SVR_DVSN_CD: "0", ORD_DVSN: "00" }),
    });
    const orderNo = result.output?.ODNO || result.output?.odno;
    if (!orderNo) throw uncertainOrderError("한투 미국주식 주문 접수 응답에 주문번호가 없습니다.");
    return { orderNo: String(orderNo), symbol, side, status: "ACCEPTED" };
  }

  async getUsOrderExecutions({ exchange = "ND", symbol = "" }: any = {}) {
    const result = await this.request("/uapi/overseas-stock/v1/trading/inquire-ccnl", {
      trId: this.trId("VTTS3035R", "TTTS3035R"),
      params: this.accountParams({ PDNO: symbol, ORD_STRT_DT: "", ORD_END_DT: "", SLL_BUY_DVSN: "00", CCLD_NCCS_DVSN: "00", OVRS_EXCG_CD: this.kisExchange(exchange), SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "", CTX_AREA_FK200: "", CTX_AREA_NK200: "" }),
    });
    return (result.output || result.output1 || []).map((item: any) => {
      const orderQuantity = number(item.ft_ord_qty || item.ord_qty);
      const filledQuantity = number(item.ft_ccld_qty || item.tot_ccld_qty);
      const remainingQuantity = number(item.nccs_qty ?? orderQuantity - filledQuantity);
      return { orderNo: String(item.odno), symbol: item.pdno, orderQuantity, filledQuantity, remainingQuantity, fillPrice: number(item.ft_ccld_unpr3 || item.avg_pric), status: status(orderQuantity, filledQuantity, remainingQuantity) };
    });
  }

  async getUsHistoryPages(path: string, trId: string, params: Record<string, string>, size = 200) {
    const rows: any[] = [], seen = new Set<string>();
    let trCont = "";
    for (let page = 0; page < 100; page += 1) {
      const result = await this.request(path, { trId, params: this.accountParams(params), trCont });
      const items = result.output1 || result.output;
      if (!Array.isArray(items)) throw new Error("한투 이력 목록 형식 오류");
      rows.push(...items);
      if (!result.continuation) return rows;
      const fk = String(result[`ctx_area_fk${size}`] || "").trim(), nk = String(result[`ctx_area_nk${size}`] || "").trim();
      if (!nk || seen.has(`${fk}:${nk}`)) throw new Error("한투 이력 연속조회 중단 · 일부 자료를 전체로 사용하지 않습니다.");
      seen.add(`${fk}:${nk}`);
      params = { ...params, [`CTX_AREA_FK${size}`]: fk, [`CTX_AREA_NK${size}`]: nk };
      trCont = "N";
    }
    throw new Error("한투 이력 조회 페이지 한도 초과");
  }

  async getUsHistoricalExecutions({ date, symbol = "" }: any) {
    if (!/^\d{8}$/.test(date) || (symbol && !/^[A-Z0-9.-]{1,12}$/.test(symbol))) throw new Error("이력 조회 날짜·종목 오류");
    const rows = await this.getUsHistoryPages("/uapi/overseas-stock/v1/trading/inquire-ccnl", this.trId("VTTS3035R", "TTTS3035R"), {
      PDNO: this.environment === "mock" ? "" : symbol || "%", ORD_STRT_DT: date, ORD_END_DT: date, SLL_BUY_DVSN: "00", CCLD_NCCS_DVSN: "00",
      OVRS_EXCG_CD: this.environment === "mock" ? "" : "NASD", SORT_SQN: "DS", ORD_DT: "", ORD_GNO_BRNO: "", ODNO: "", CTX_AREA_FK200: "", CTX_AREA_NK200: "" });
    return rows.map(item => ({ orderNo: String(item.odno), symbol: item.pdno,
      side: item.sll_buy_dvsn_cd === "01" ? "SELL" : item.sll_buy_dvsn_cd === "02" ? "BUY" : "",
      orderQuantity: number(item.ft_ord_qty || item.ord_qty), filledQuantity: number(item.ft_ccld_qty || item.tot_ccld_qty),
      remainingQuantity: number(item.nccs_qty), fillPrice: number(item.ft_ccld_unpr3 || item.avg_pric), date: String(item.ord_dt || ""),
      filledAt: null, source: `KIS:inquire-ccnl:${date}` }));
  }

  async getUsTransactions({ startDate, endDate }: any) {
    if (this.environment !== "live") throw new Error("한투 모의 거래비용 API 미지원 · 증권사 명세서 증빙으로 확인 필요");
    if (![startDate, endDate].every(date => /^\d{8}$/.test(date)) || startDate > endDate) throw new Error("거래내역 조회 범위 오류");
    return this.getUsHistoryPages("/uapi/overseas-stock/v1/trading/inquire-period-trans", "CTOS4001R", {
      ERLM_STRT_DT: startDate, ERLM_END_DT: endDate, OVRS_EXCG_CD: "NASD", PDNO: "", SLL_BUY_DVSN_CD: "00", LOAN_DVSN_CD: "", CTX_AREA_FK100: "", CTX_AREA_NK100: "" }, 100);
  }

  async getAccountEquity() {
    const result = await this.request("/uapi/overseas-stock/v1/trading/inquire-present-balance", { trId: this.trId("VTRP6504R", "CTRP6504R"),
      params: this.accountParams({ WCRC_FRCR_DVSN_CD: "02", NATN_CD: "000", TR_MKET_CD: "00", INQR_DVSN_CD: "00" }) });
    const summary = Array.isArray(result.output3) ? result.output3[0] : result.output3;
    if (!summary || summary.tot_asst_amt === undefined || String(summary.tot_asst_amt).trim() === "") throw new Error("한투 총자산 응답 미확인");
    if (!Number.isFinite(Number(summary.tot_asst_amt)) || Number(summary.tot_asst_amt) < 0) throw new Error("한투 총자산 숫자 오류");
    if (summary.tot_loan_amt === undefined || String(summary.tot_loan_amt).trim() === "" || Number(summary.tot_loan_amt) !== 0) throw new Error("대출 포함 자산은 순자산 명세서로 확인해야 합니다.");
    return { currency: "KRW", equity: Number(summary.tot_asst_amt), source: "KIS:inquire-present-balance:tot_asst_amt", scope: "account-total-assets" };
  }

  async cancelUsOrder({ orderNo, exchange, symbol, quantity }: any) {
    if (!/^\d+$/.test(String(orderNo)) || !symbol || !Number.isInteger(quantity) || quantity < 1) throw new Error("취소 주문값이 올바르지 않습니다.");
    const result = await this.request("/uapi/overseas-stock/v1/trading/order-rvsecncl", {
      method: "POST", trId: this.trId("VTTT1004U", "TTTT1004U"),
      body: this.accountParams({ OVRS_EXCG_CD: this.kisExchange(exchange), PDNO: symbol, ORGN_ODNO: String(orderNo), RVSE_CNCL_DVSN_CD: "02", ORD_QTY: String(quantity), OVRS_ORD_UNPR: "0", MGCO_APTM_ODNO: "", ORD_SVR_DVSN_CD: "0" }),
    });
    const cancellationOrderNo = result.output?.ODNO || result.output?.odno;
    if (!cancellationOrderNo) throw uncertainOrderError("한투 취소 접수 번호가 없습니다.");
    return { status: "CANCEL_REQUESTED", cancellationOrderNo: String(cancellationOrderNo) };
  }

  async cancelDomesticOrder({ orderNo, symbol }: any) {
    // 공식 정정취소가능조회는 실전 전용. 모의 IOC는 종료 확인 후 청산을 재개합니다.
    if (this.environment !== "live") throw new Error("한투 모의 국내 취소가능조회 미지원 · 기존 주문 종료 확인 대기");
    const result = await this.request("/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl", {
      trId: "TTTC0084R", params: this.accountParams({ INQR_DVSN_1: "0", INQR_DVSN_2: "2", CTX_AREA_FK100: "", CTX_AREA_NK100: "" }),
    });
    const row = (result.output || []).find((item: any) => String(item.odno).replace(/^0+/, "") === String(orderNo).replace(/^0+/, "") && item.pdno === symbol);
    if (!row || number(row.psbl_qty) <= 0) throw new Error("국내 매수 잔량 취소가능수량 확인 실패");
    const response = await this.request("/uapi/domestic-stock/v1/trading/order-rvsecncl", {
      method: "POST", trId: "TTTC0013U", body: this.accountParams({ KRX_FWDG_ORD_ORGNO: row.krx_fwdg_ord_orgno, ORGN_ODNO: String(orderNo), ORD_DVSN: row.ord_dvsn_cd || "00", RVSE_CNCL_DVSN_CD: "02", ORD_QTY: String(row.psbl_qty), ORD_UNPR: "0", QTY_ALL_ORD_YN: "Y", EXCG_ID_DVSN_CD: "KRX" }),
    });
    const cancellationOrderNo = response.output?.ODNO || response.output?.odno;
    if (!cancellationOrderNo) throw uncertainOrderError("한투 국내 취소 접수 번호가 없습니다.");
    return { status: "CANCEL_REQUESTED", cancellationOrderNo: String(cancellationOrderNo) };
  }
}

module.exports = { KisClient, LIVE_BASE_URL, MOCK_BASE_URL, US_EXCHANGE, kisCredentials };
