"use strict";
const { equityNumber } = require("./account-equity");

// ISA is a separately configured live domestic account, never an overseas wallet.
async function collectIsaEquity(broker) {
  if (broker.environment !== "live" || broker.accountKind !== "isa") throw Error("ISA 실계좌 설정 필요");
  const client = broker.domesticClient;
  let equity, cash, stockValue, rows;
  if (broker.id === "KIS") {
    const result = await client.request("/uapi/domestic-stock/v1/trading/inquire-balance", {
      trId: "TTTC8434R", params: client.accountParams({ AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "02", UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "01", CTX_AREA_FK100: "", CTX_AREA_NK100: "" }),
    });
    const summary = Array.isArray(result.output2) ? result.output2[0] : result.output2;
    if (!summary || result.continuation || !Array.isArray(result.output1) || equityNumber(summary.tot_loan_amt) !== 0) throw Error("ISA 전체 잔고·대출 확인 실패");
    equity = equityNumber(summary.nass_amt);
    stockValue = equityNumber(summary.scts_evlu_amt);
    cash = equityNumber(summary.prvs_rcdl_excc_amt); // D+2 cash, not today's unsettled deposit.
    rows = result.output1.map(r => ({ code: r.pdno, name: r.prdt_name, quantity: equityNumber(r.hldg_qty), value: equityNumber(r.evlu_amt) }));
  } else if (broker.id === "KIWOOM") {
    const result = await client.post("/api/dostk/acnt", { apiId: "kt00018", authorization: true, body: { qry_tp: "1", dmst_stex_tp: "KRX" } });
    if (result.pagination?.more || !Array.isArray(result.acnt_evlt_remn_indv_tot)
      || ["tot_loan_amt", "tot_crd_loan_amt", "tot_crd_ls_amt"].some(k => equityNumber(result[k]) !== 0)) throw Error("ISA 전체 잔고·대출 확인 실패");
    const deposit = await client.post("/api/dostk/acnt", { apiId: "kt00001", authorization: true, body: { qry_tp: "3" } });
    if (deposit.pagination?.more) throw Error("ISA 예수금 조회 미완료");
    equity = equityNumber(result.prsm_dpst_aset_amt); stockValue = equityNumber(result.tot_evlt_amt); cash = equityNumber(deposit.d2_entra);
    rows = result.acnt_evlt_remn_indv_tot.map(r => ({ code: String(r.stk_cd).replace(/^A/, ""), name: r.stk_nm, quantity: equityNumber(r.rmnd_qty), value: equityNumber(r.evlt_amt) }));
  } else throw Error("ISA 증권사 설정 오류");
  if (equity < 0 || stockValue < 0 || Math.abs(cash + stockValue - equity) > 2 || rows.length > 200
    || rows.some(r => !/^\d{6}$/.test(r.code) || typeof r.name !== "string" || !r.name.trim() || r.name.length > 100
      || !Number.isSafeInteger(r.quantity) || r.quantity < 0 || r.value < 0)
    || new Set(rows.map(r => r.code)).size !== rows.length
    || Math.abs(rows.reduce((sum,r) => sum + r.value,0) - stockValue) > 2) throw Error("ISA 총자산·현금·보유종목 대조 실패");
  return { currency: "KRW", scope: "account-total-assets", equity, cash, stockValue, accountKind: "isa",
    isa_holdings: rows.filter(r => r.quantity > 0).map(r => ({ code:r.code, name:r.name, quantity:String(r.quantity), value:String(r.value) })),
    source: `${broker.id}:isa:domestic` };
}
module.exports = { collectIsaEquity };
