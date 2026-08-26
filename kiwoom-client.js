"use strict";

const MOCK_BASE_URL = "https://mockapi.kiwoom.com";
const LIVE_BASE_URL = "https://api.kiwoom.com";

function toNumber(value, field) {
  const number = Number(String(value ?? "0").replaceAll(",", ""));
  if (!Number.isFinite(number)) throw new Error(`키움 ${field} 값이 숫자가 아닙니다.`);
  return number;
}

function toOptionalNumber(value, field, absolute = false) {
  if (value === undefined || value === null || value === "") return null;
  const number = toNumber(value, field);
  return absolute ? Math.abs(number) : number;
}

class KiwoomClient {
  #appKey;
  #secretKey;
  #fetch;
  #baseUrl;
  #environmentLabel;
  #timeoutMs;
  #token = null;
  #expiresDt = null;

  constructor({ appKey, secretKey, environment = "mock", fetchImpl = fetch, timeoutMs = 5000 } = {}) {
    if (!["mock", "live"].includes(environment)) throw new Error("KIWOOM_ENV는 mock 또는 live여야 합니다.");
    if (!appKey || !secretKey) throw new Error("키움 App Key와 App Secret이 필요합니다.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
      throw new Error("KIWOOM_TIMEOUT_MS는 1000~30000 범위여야 합니다.");
    }
    this.#appKey = appKey;
    this.#secretKey = secretKey;
    this.#fetch = fetchImpl;
    this.#baseUrl = environment === "live" ? LIVE_BASE_URL : MOCK_BASE_URL;
    this.#environmentLabel = environment === "live" ? "실계좌" : "모의투자";
    this.#timeoutMs = timeoutMs;
  }

  async post(path, { apiId, body = {}, authorization = false } = {}) {
    const headers = { "content-type": "application/json;charset=UTF-8" };
    if (apiId) headers["api-id"] = apiId;
    if (authorization) headers.authorization = `Bearer ${await this.getAccessToken()}`;

    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(`키움 ${this.#environmentLabel} 통신 실패: ${error.message}`);
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`키움 ${this.#environmentLabel} 응답이 JSON이 아닙니다. (HTTP ${response.status})`);
    }
    if (!response.ok || data.return_code !== 0) {
      throw new Error(`키움 ${this.#environmentLabel} 요청 실패: ${data.return_msg || `HTTP ${response.status}`}`);
    }
    return data;
  }

  async authenticate() {
    const data = await this.post("/oauth2/token", {
      body: {
        grant_type: "client_credentials",
        appkey: this.#appKey,
        secretkey: this.#secretKey,
      },
    });
    if (!data.token || !data.expires_dt) throw new Error("키움 토큰 응답에 필수값이 없습니다.");
    this.#token = data.token;
    this.#expiresDt = data.expires_dt;
    return { expiresDt: this.#expiresDt, tokenType: data.token_type || "bearer" };
  }

  async getAccessToken() {
    if (!this.#token) await this.authenticate();
    return this.#token;
  }

  async getDomesticAccountNumber() {
    const data = await this.post("/api/dostk/acnt", {
      apiId: "ka00001",
      authorization: true,
    });
    if (!data.acctNo) throw new Error("키움 계좌번호 응답이 비어 있습니다.");
    return String(data.acctNo);
  }

  async getDomesticBalance() {
    const data = await this.post("/api/dostk/acnt", {
      apiId: "kt00018",
      authorization: true,
      body: { qry_tp: "1", dmst_stex_tp: "KRX" },
    });
    const holdings = Array.isArray(data.acnt_evlt_remn_indv_tot) ? data.acnt_evlt_remn_indv_tot : [];
    return {
      estimatedAssets: toNumber(data.prsm_dpst_aset_amt, "추정예탁자산"),
      totalEvaluation: toNumber(data.tot_evlt_amt, "총평가금액"),
      totalProfitLoss: toNumber(data.tot_evlt_pl, "총평가손익"),
      holdings: holdings.map((item) => ({
        code: String(item.stk_cd || ""),
        name: String(item.stk_nm || ""),
        quantity: toNumber(item.rmnd_qty, "보유수량"),
        tradableQuantity: toNumber(item.trde_able_qty, "매매가능수량"),
        currentPrice: toNumber(item.cur_prc, "현재가"),
        evaluationAmount: toNumber(item.evlt_amt, "평가금액"),
        positionRatio: toNumber(item.poss_rt, "보유비중"),
        purchasePrice: toOptionalNumber(item.pur_pric, "매입가"),
        purchaseAmount: toOptionalNumber(item.pur_amt, "매입금액"),
        profitLoss: toOptionalNumber(item.evltv_prft, "평가손익"),
        profitRate: toOptionalNumber(item.prft_rt, "수익률"),
      })),
    };
  }

  async getDomesticCash() {
    const data = await this.post("/api/dostk/acnt", {
      apiId: "kt00001",
      authorization: true,
      body: { qry_tp: "2" },
    });
    return {
      deposit: toNumber(data.entr, "국내주식 예수금"),
      orderableAmount: toNumber(data.ord_alow_amt, "국내주식 주문가능금액"),
    };
  }

  async getDomesticQuote({ symbol } = {}) {
    symbol = String(symbol || "");
    if (!/^\d{6}$/.test(symbol)) throw new Error("국내주식 종목코드는 6자리 숫자여야 합니다.");
    const data = await this.post("/api/dostk/stkinfo", {
      apiId: "ka10001",
      authorization: true,
      body: { stk_cd: symbol },
    });
    return {
      symbol: String(data.stk_cd || symbol).replace(/^A/, ""),
      name: String(data.stk_nm || ""),
      currentPrice: Math.abs(toNumber(data.cur_prc, "국내주식 현재가")),
      dayOpen: toOptionalNumber(data.open_pric, "국내주식 시가", true),
      dayHigh: toOptionalNumber(data.high_pric, "국내주식 고가", true),
      dayLow: toOptionalNumber(data.low_pric, "국내주식 저가", true),
      changeRate: toOptionalNumber(data.flu_rt, "국내주식 등락률"),
      volume: toOptionalNumber(data.trde_qty, "국내주식 거래량"),
    };
  }

  async getDomesticMarketClose({ date } = {}) {
    date = String(date || "");
    if (!/^\d{8}$/.test(date)) throw new Error("국내장 마감 기준일은 YYYYMMDD 형식이어야 합니다.");
    await this.getAccessToken();
    const markets = [];
    for (const [index, [name, marketType, sectorCode]] of [["KOSPI", "0", "001"], ["KOSDAQ", "1", "101"]].entries()) {
      if (index) await new Promise((resolve) => setTimeout(resolve, 1100));
      const [market, flow] = await Promise.all([
        this.post("/api/dostk/sect", {
          apiId: "ka20001",
          authorization: true,
          body: { mrkt_tp: marketType, inds_cd: sectorCode },
        }),
        this.post("/api/dostk/sect", {
          apiId: "ka10051",
          authorization: true,
          body: { mrkt_tp: marketType, amt_qty_tp: "0", base_dt: date, stex_tp: "3" },
        }),
      ]);
      const flowRow = Array.isArray(flow.inds_netprps) ? flow.inds_netprps[0] : null;
      if (!flowRow) throw new Error(`키움 ${name} 투자자 수급 응답이 비어 있습니다.`);
      markets.push({
        name,
        index: Math.abs(toNumber(market.cur_prc, `${name} 종가`)),
        change: toNumber(market.pred_pre, `${name} 전일대비`),
        changeRate: toNumber(market.flu_rt, `${name} 등락률`),
        turnoverMillionKrw: toNumber(market.trde_prica, `${name} 거래대금`),
        individualNetBuyBillionKrw: toNumber(flowRow.ind_netprps, `${name} 개인 순매수`),
        foreignNetBuyBillionKrw: toNumber(flowRow.frgnr_netprps, `${name} 외국인 순매수`),
        institutionNetBuyBillionKrw: toNumber(flowRow.orgn_netprps, `${name} 기관 순매수`),
      });
    }
    return { date, markets };
  }

  async placeDomesticMarketOrder({ side, symbol, quantity, price, session = "REGULAR" } = {}) {
    side = String(side || "").toUpperCase();
    symbol = String(symbol || "");
    if (!["BUY", "SELL"].includes(side)) throw new Error("국내주식 주문 side는 BUY 또는 SELL이어야 합니다.");
    if (!/^\d{6}$/.test(symbol)) throw new Error("국내주식 종목코드는 6자리 숫자여야 합니다.");
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("국내주식 주문수량은 1 이상의 정수여야 합니다.");
    const orderType = { PRE: "61", REGULAR: "3", AFTER_CLOSE: "81", AFTER_SINGLE: "62" }[session];
    if (!orderType) throw new Error("국내주식 주문 가능 시간이 아닙니다.");
    if (session === "AFTER_SINGLE" && (!Number.isFinite(price) || price <= 0)) throw new Error("시간외 단일가 주문 가격이 필요합니다.");

    const data = await this.post("/api/dostk/ordr", {
      apiId: side === "BUY" ? "kt10000" : "kt10001",
      authorization: true,
      body: {
        dmst_stex_tp: "KRX",
        stk_cd: symbol,
        ord_qty: String(quantity),
        ord_uv: session === "AFTER_SINGLE" ? String(price) : "",
        trde_tp: orderType,
        cond_uv: "",
      },
    });
    if (!data.ord_no) throw new Error("키움 국내주식 주문 접수 응답에 주문번호가 없습니다.");
    return { status: "ACCEPTED", orderNo: String(data.ord_no), side, symbol, orderQuantity: quantity };
  }

  async getDomesticOrderExecutions({ side = "ALL", symbol = "" } = {}) {
    side = String(side).toUpperCase();
    symbol = String(symbol || "");
    if (!["ALL", "BUY", "SELL"].includes(side)) throw new Error("주문조회 side는 ALL, BUY, SELL 중 하나여야 합니다.");
    if (symbol && !/^\d{6}$/.test(symbol)) throw new Error("국내주식 종목코드는 6자리 숫자여야 합니다.");

    const data = await this.post("/api/dostk/acnt", {
      apiId: "ka10076",
      authorization: true,
      body: { stk_cd: symbol, qry_tp: symbol ? "1" : "0", sell_tp: { ALL: "0", SELL: "1", BUY: "2" }[side], ord_no: "", stex_tp: "1" },
    });
    const rows = Array.isArray(data.cntr) ? data.cntr : [];
    return rows.map((item) => {
      const filledQuantity = toNumber(item.cntr_qty, "국내주식 체결수량");
      const remainingQuantity = toNumber(item.oso_qty, "국내주식 미체결수량");
      const rawStatus = String(item.ord_stt || "");
      let status = "ACCEPTED";
      if (rawStatus.includes("거부")) status = "REJECTED";
      else if (rawStatus.includes("취소") && filledQuantity === 0) status = "CANCELLED";
      else if (filledQuantity > 0 && remainingQuantity === 0) status = "FILLED";
      else if (filledQuantity > 0) status = "PARTIALLY_FILLED";
      return {
        orderNo: String(item.ord_no || ""),
        originalOrderNo: String(item.orig_ord_no || ""),
        symbol: String(item.stk_cd || ""),
        side: String(item.io_tp_nm || "").includes("매도") ? "SELL" : "BUY",
        status,
        rawStatus,
        orderQuantity: toNumber(item.ord_qty, "국내주식 주문수량"),
        filledQuantity,
        remainingQuantity,
        fillPrice: toNumber(item.cntr_pric, "국내주식 체결가"),
      };
    });
  }

  async getUsBalance() {
    const data = await this.post("/api/us/acnt", {
      apiId: "ust21070",
      authorization: true,
      body: { stex_tp: "", stk_cd: "" },
    });
    const holdings = Array.isArray(data.result_list) ? data.result_list : [];
    return {
      currency: String(data.crnc_code || "USD"),
      totalEvaluation: toNumber(data.tot_evlt_amt, "미국주식 총평가금액"),
      totalProfitLoss: toNumber(data.tot_pl_amt, "미국주식 총손익"),
      holdings: holdings.map((item) => ({
        code: String(item.stk_cd || ""),
        name: String(item.frgn_stk_nm || ""),
        exchange: String(item.stex_nm || ""),
        quantity: toNumber(item.poss_qty, "미국주식 보유수량"),
        tradableQuantity: toNumber(item.sell_alowq, "미국주식 매도가능수량"),
        currentPrice: toNumber(item.now_pric, "미국주식 현재가"),
        evaluationAmount: toNumber(item.evlt_amt, "미국주식 평가금액"),
        purchasePrice: toOptionalNumber(item.frgn_stk_book_uv, "미국주식 매입가"),
        purchaseAmount: toOptionalNumber(item.frgn_stk_book_amt, "미국주식 매입금액"),
        profitLoss: toOptionalNumber(item.pl_amt, "미국주식 평가손익"),
        profitRate: toOptionalNumber(item.pl_rt, "미국주식 수익률"),
      })),
    };
  }

  async getUsCash() {
    const data = await this.post("/api/us/acnt", {
      apiId: "ust21160",
      authorization: true,
    });
    return {
      usd: toNumber(data.d0_usd_fx_entr, "USD 예수금"),
      krw: toNumber(data.won_entr, "해외계좌 원화 예수금"),
      usdExchangeRate: toNumber(data.usd_exch_rate, "USD 환율"),
    };
  }

  async getUsQuote({ exchange, symbol } = {}) {
    exchange = String(exchange || "").toUpperCase();
    symbol = String(symbol || "").toUpperCase();
    if (!["ND", "NY", "NA"].includes(exchange)) throw new Error("미국주식 거래소는 ND, NY, NA 중 하나여야 합니다.");
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) throw new Error("미국주식 종목코드가 올바르지 않습니다.");
    const data = await this.post("/api/us/mrkcond", {
      apiId: "usa20100",
      authorization: true,
      body: { stex_tp: exchange, stk_cd: symbol },
    });
    return {
      exchange: String(data.stex_tp || exchange),
      symbol: String(data.stk_cd || symbol),
      name: String(data.stk_nm || data.stk_enm || ""),
      currentPrice: Math.abs(toNumber(data.cur_prc, "미국주식 현재가")),
      previousClose: Math.abs(toNumber(data.base_close_pric, "미국주식 전일종가")),
      dayOpen: toOptionalNumber(data.open_pric, "미국주식 시가", true),
      dayHigh: toOptionalNumber(data.high_pric, "미국주식 고가", true),
      dayLow: toOptionalNumber(data.low_pric, "미국주식 저가", true),
      changeRate: toNumber(data.flu_rt, "미국주식 등락률"),
      volume: toNumber(data.acc_trde_qty, "미국주식 누적거래량"),
    };
  }

  async placeUsLimitOrder({ side, exchange, symbol, quantity, price } = {}) {
    side = String(side || "").toUpperCase();
    exchange = String(exchange || "").toUpperCase();
    symbol = String(symbol || "").toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) throw new Error("미국주식 주문 side는 BUY 또는 SELL이어야 합니다.");
    if (!['ND', 'NY', 'NA'].includes(exchange)) throw new Error("미국주식 거래소는 ND, NY, NA 중 하나여야 합니다.");
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) throw new Error("미국주식 종목코드가 올바르지 않습니다.");
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("미국주식 주문수량은 1 이상의 정수여야 합니다.");
    if (!Number.isFinite(price) || price <= 0) throw new Error("미국주식 지정가는 0보다 커야 합니다.");

    const body = {
      stex_tp: exchange,
      stk_cd: symbol,
      ord_qty: String(quantity),
      ord_uv: price < 1 ? price.toFixed(4) : price.toFixed(2),
      trde_tp: "00",
    };
    if (side === "SELL") body.stop_pric = "";
    const data = await this.post("/api/us/ordr", {
      apiId: side === "BUY" ? "ust20000" : "ust20001",
      authorization: true,
      body,
    });
    if (!data.ord_no) throw new Error("키움 주문 접수 응답에 주문번호가 없습니다.");
    return { status: "ACCEPTED", orderNo: String(data.ord_no), side, symbol };
  }

  async cancelUsOrder({ orderNo, exchange, symbol } = {}) {
    orderNo = String(orderNo || "");
    exchange = String(exchange || "").toUpperCase();
    symbol = String(symbol || "").toUpperCase();
    if (!/^\d{1,9}$/.test(orderNo)) throw new Error("취소할 미국주식 주문번호가 올바르지 않습니다.");
    if (!['ND', 'NY', 'NA'].includes(exchange)) throw new Error("미국주식 거래소는 ND, NY, NA 중 하나여야 합니다.");
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) throw new Error("미국주식 종목코드가 올바르지 않습니다.");
    const data = await this.post("/api/us/ordr", {
      apiId: "ust20003",
      authorization: true,
      body: { orig_ord_no: orderNo, stex_tp: exchange, stk_cd: symbol },
    });
    if (!data.ord_no) throw new Error("키움 취소 접수 응답에 주문번호가 없습니다.");
    return { status: "CANCEL_REQUESTED", orderNo, cancellationOrderNo: String(data.ord_no), symbol };
  }

  async getUsOrderExecutions({ side = "ALL", exchange = "", symbol = "" } = {}) {
    side = String(side).toUpperCase();
    exchange = String(exchange).toUpperCase();
    symbol = String(symbol).toUpperCase();
    if (!['ALL', 'BUY', 'SELL'].includes(side)) throw new Error("주문조회 side는 ALL, BUY, SELL 중 하나여야 합니다.");
    if (exchange && !['ND', 'NY', 'NA'].includes(exchange)) throw new Error("미국주식 거래소가 올바르지 않습니다.");
    if (symbol && !/^[A-Z0-9.-]{1,12}$/.test(symbol)) throw new Error("미국주식 종목코드가 올바르지 않습니다.");

    const data = await this.post("/api/us/acnt", {
      apiId: "ust21510",
      authorization: true,
      body: { slby_tp: { ALL: "0", SELL: "1", BUY: "2" }[side], stex_tp: exchange, stk_cd: symbol },
    });
    const rows = data.result_list || data.result_lsit || [];
    if (!Array.isArray(rows)) throw new Error("키움 미국주식 주문체결 목록 형식이 올바르지 않습니다.");
    return rows.map((item) => {
      const filledQuantity = toNumber(item.cntr_qty, "미국주식 체결수량");
      const remainingQuantity = toNumber(item.ord_remnq, "미국주식 주문잔량");
      const rawStatus = String(item.ord_stat || "");
      let status = "ACCEPTED";
      if (rawStatus.includes("거부")) status = "REJECTED";
      else if (rawStatus.includes("취소") && filledQuantity === 0) status = "CANCELLED";
      else if (filledQuantity > 0 && remainingQuantity === 0) status = "FILLED";
      else if (filledQuantity > 0) status = "PARTIALLY_FILLED";
      return {
        orderNo: String(item.ord_no || ""),
        originalOrderNo: String(item.orig_ord_no || ""),
        symbol: String(item.stk_cd || ""),
        side: item.slby_tp === "1" ? "SELL" : "BUY",
        status,
        rawStatus,
        orderQuantity: toNumber(item.ord_qty, "미국주식 주문수량"),
        filledQuantity,
        remainingQuantity,
        fillPrice: toNumber(item.cntr_uv, "미국주식 체결단가"),
      };
    });
  }
}

module.exports = { KiwoomClient, LIVE_BASE_URL, MOCK_BASE_URL };
