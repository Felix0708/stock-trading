"use strict";

// Daily sampled, cash-flow-adjusted Modified Dietz returns. Not intraday or tick-level MDD.
function equityPerformance(state, brokerId, environment, currency, selection: any = {}) {
  const snapshots = state.equity.filter(row => row.brokerId === brokerId && row.environment === environment && row.currency === currency
    && (selection.scope === undefined || row.scope === selection.scope)
    && (selection.accountRef === undefined || row.accountRef === selection.accountRef))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const curve = [];
  const missing = (reason, status = "invalid_data") => ({ brokerId, environment, currency, samples: snapshots.length,
    returnRate: null, maxDrawdownRate: null, reason, status, curve: curve.length > 1 ? curve : [] });
  if (new Set(snapshots.map(row => `${row.accountRef || "legacy"}:${row.scope}`)).size > 1) return missing("계좌·평가 범위별 조회 필요", "scope_unverified");
  if (snapshots.length < 2) return missing("총자산 스냅샷 2개 이상 필요", "insufficient_samples");
  let index = 1, peak = 1, drawdown = 0;
  curve.push({ at: snapshots[0].at, index });
  for (let i = 1; i < snapshots.length; i++) {
    const a = snapshots[i - 1], b = snapshots[i], start = Date.parse(a.at), end = Date.parse(b.at);
    if (!(a.equity > 0) || !Number.isFinite(a.equity) || !(b.equity >= 0) || !Number.isFinite(b.equity) || !(end > start) || a.scope !== b.scope) return missing("평가 범위·시간·총자산 확인 필요");
    const covered = state.cashFlowCoverage.some(row => row.brokerId === brokerId && row.environment === environment && row.currency === currency
      && row.scope === a.scope && row.accountRef === a.accountRef && row.source && Date.parse(row.start) <= start && Date.parse(row.end) >= end);
    if (!covered) return missing("해당 기간 입출금 전체 내역 증빙 필요 (입출금 없음도 확인 대상)", "cash_flows_unverified");
    const flows = state.cashFlows.filter(row => row.brokerId === brokerId && row.environment === environment && row.currency === currency
      && row.scope === a.scope && row.accountRef === a.accountRef && Date.parse(row.at) > start && Date.parse(row.at) <= end);
    if (flows.some(row => !Number.isFinite(row.amount) || !row.source) || new Set(flows.map(row => row.id)).size !== flows.length) return missing("입출금 금액·중복 증빙 확인 필요");
    const net = flows.reduce((sum, row) => sum + row.amount, 0);
    const denominator = a.equity + flows.reduce((sum, row) => sum + row.amount * (end - Date.parse(row.at)) / (end - start), 0);
    if (!(denominator > 0)) return missing("입출금 조정 투자원금이 0 이하");
    const factor = 1 + (b.equity - a.equity - net) / denominator;
    if (factor < 0 || !Number.isFinite(index * factor)) return missing("기간 수익률 검증 필요");
    index *= factor; peak = Math.max(peak, index); drawdown = Math.max(drawdown, (peak - index) / peak);
    curve.push({ at: b.at, index });
  }
  return { brokerId, environment, currency, samples: snapshots.length, returnRate: (index - 1) * 100, maxDrawdownRate: drawdown * 100,
    status: "verified", method: "daily-sampled-linked-modified-dietz", curve, reason: "미실현 평가 포함 · 입출금 조정 · 일별 표본 낙폭 (장중 MDD 아님)" };
}

function importCashFlows(state, input, broker) {
  const proof = input.cashFlowCoverage;
  if (!proof) return;
  if (broker.overseasClient?.accountIdentityKey) {
    const { equityAccountRef } = require("./account-evidence");
    if (proof.accountRef !== equityAccountRef(state, broker)) throw Error("입출금 증빙의 accountRef가 현재 계좌와 일치해야 합니다.");
  }
  if (!["KRW", "USD"].includes(proof.currency) || !["overseas", "account-total-assets"].includes(proof.scope)
    || !Number.isFinite(Date.parse(proof.start)) || !Number.isFinite(Date.parse(proof.end)) || Date.parse(proof.end) <= Date.parse(proof.start)
    || Date.parse(proof.end) > Date.now() || !Array.isArray(input.cashFlows) || input.cashFlows.length > 5000) throw Error("입출금 전체 증빙 범위 오류");
  const rows = input.cashFlows.map(row => {
    if (typeof row.id !== "string" || !row.id || row.id.length > 100 || !Number.isFinite(row.amount)
      || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) < Date.parse(proof.start) || Date.parse(row.at) > Date.parse(proof.end)) throw Error("입출금 증빙값 오류");
    return { ...row, brokerId: broker.id, environment: broker.environment, currency: proof.currency, scope: proof.scope, accountRef: proof.accountRef, source: input.source };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error("중복 입출금 ID");
  // Replace an explicitly complete interval, including legitimate empty statements.
  state.cashFlows = state.cashFlows.filter(row => !(row.brokerId === broker.id && row.environment === broker.environment && row.currency === proof.currency
    && row.scope === proof.scope && row.accountRef === proof.accountRef && Date.parse(row.at) >= Date.parse(proof.start) && Date.parse(row.at) <= Date.parse(proof.end))).concat(rows);
  state.cashFlowCoverage.push({ ...proof, brokerId: broker.id, environment: broker.environment, source: input.source });
}
module.exports = { equityPerformance, importCashFlows };
