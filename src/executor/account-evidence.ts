"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { managedPosition, sameInstrument, normalizedSymbol } = require("../trading/position-ownership");

function evidenceNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function koreanDate(value, timeZone = "Asia/Seoul") {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time).replaceAll("-", "");
}

function executionDateMatches(order, row) {
  const date = koreanDate(order.createdAt);
  if (!String(row.source).startsWith("KIWOOM:ust21150:")) return row.date === date;
  if (![date, koreanDate(order.createdAt, "America/New_York")].includes(row.date) || !/^\d\d:\d\d:\d\d$/.test(row.orderTime || "")) return false;
  // Kiwoom mock history uses the US trading date but returns the order clock in KST.
  // Require the original order clock too: order numbers can be reused on another day.
  const time = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${row.orderTime}+09:00`);
  return Math.abs(time - Date.parse(order.createdAt)) < 120_000;
}

function evidenceFile(receiptFile) { return `${receiptFile}.evidence.json`; }
function orderKey(order) { return order.storageKey || [order.orderNo, order.requestId, order.environment || "mock", order.symbol].join(":"); }
function readEvidence(file) {
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, brokers: {}, adjustments: [], equity: [], cashFlows: [], cashFlowCoverage: [] };
  if (state.version !== 1 || !state.brokers || ["adjustments", "equity", "cashFlows", "cashFlowCoverage"].some(key => !Array.isArray(state[key]))) throw Error("증빙 파일 형식 오류 · 원본 복구 필요");
  return state;
}
function writeEvidence(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(`${file}.tmp`, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(`${file}.tmp`, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function equityAccountRef(state, broker) {
  const identity = broker.overseasClient?.accountIdentityKey?.();
  if (!/^[a-f0-9]{64}$/.test(identity || "")) throw Error("자산 계좌 식별 미확인");
  const key = `${broker.id}:${broker.environment}:${identity}`;
  state.equityAccounts ||= {};
  return state.equityAccounts[key] ||= randomUUID();
}

async function collectAccountEquity(broker) {
  const client = broker.overseasClient;
  const points = [await client.getAccountEquity()];
  if (points.some(row => !row || !["KRW", "USD"].includes(row.currency) || !["overseas", "account-total-assets"].includes(row.scope)
      || !Number.isFinite(row.equity) || row.equity < 0
      || (row.stockValue != null && (!Number.isFinite(row.stockValue) || row.stockValue < 0))
      || (row.cash != null && !Number.isFinite(row.cash)))) throw Error("계좌 자산 범위·금액 응답 미확인");
  return points;
}

function recordAccountEquity(state, broker, points, at) {
  if (!points.length) return;
  if (!Number.isFinite(Date.parse(at))) throw Error("자산 수집 시각 오류");
  const accountRef = equityAccountRef(state, broker);
  for (const point of points) {
    const snapshot = { ...point, at, accountRef, brokerId: broker.id, environment: broker.environment };
    const index = state.equity.findIndex(row => row.brokerId === broker.id && row.environment === broker.environment
      && row.accountRef === accountRef && row.currency === point.currency && row.scope === point.scope && koreanDate(row.at) === koreanDate(at));
    if (index < 0) state.equity.push(snapshot);
    else if (Date.parse(state.equity[index].at) < Date.parse(at)) state.equity[index] = snapshot;
  }
}

async function refreshAccountEquity(broker, file, now = new Date()) {
  const before = readEvidence(file), accountRef = equityAccountRef(before, broker);
  const latest = before.equity.filter(row => row.accountRef === accountRef).reduce((at, row) => Math.max(at, Date.parse(row.at) || 0), 0);
  before.equityAttemptedAt ||= {};
  const attempted = Date.parse(before.equityAttemptedAt[accountRef] || "") || 0;
  if (now.getTime() - Math.max(latest, attempted) < 60 * 60_000) return false;
  before.equityAttemptedAt[accountRef] = now.toISOString();
  writeEvidence(file, before); // Identity and attempt persist before the asynchronous broker request.
  const points = await collectAccountEquity(broker);
  const state = readEvidence(file); // Other account collection may have completed during the request.
  recordAccountEquity(state, broker, points, new Date().toISOString());
  writeEvidence(file, state);
  return true;
}

function reconciliationPlan(orders, rows, environment) {
  const updates = [], conflicts = [];
  for (const order of orders.filter(item => (item.environment || "mock") === environment && item.market !== "KRX" && item.orderStyle !== "BROKER_STOP")) {
    const matching = rows.filter(row => String(row.orderNo).replace(/^0+/, "") === String(order.orderNo).replace(/^0+/, "")
      && normalizedSymbol(row.symbol) === normalizedSymbol(order.symbol) && executionDateMatches(order, row) && row.side === order.side);
    if (!matching.length) continue;
    if (matching.length !== 1) { conflicts.push({ symbol: order.symbol, reason: "같은 주문의 증빙이 여러 개입니다." }); continue; }
    const row = matching[0];
    if (order.activeOrderNo || order.priorFilledQuantity || row.orderQuantity !== order.orderQuantity
      || !Number.isInteger(row.filledQuantity) || row.filledQuantity < Number(order.filledQuantity || 0)
      || row.filledQuantity > row.orderQuantity || !Number.isInteger(row.remainingQuantity) || row.remainingQuantity < 0
      || row.filledQuantity + row.remainingQuantity > row.orderQuantity
      || (row.filledQuantity > 0 && !(row.fillPrice > 0))) {
      conflicts.push({ symbol: order.symbol, reason: "수량·가격·정정주문 증빙 대조 필요" }); continue;
    }
    const changed = row.filledQuantity !== Number(order.filledQuantity || 0)
      || (row.filledQuantity > 0 && Math.abs(row.fillPrice - Number(order.fillPrice || 0)) > 0.00001)
      || (row.remainingQuantity === 0 && ["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN"].includes(order.status));
    const costChanged = row.executionCosts && JSON.stringify(row.executionCosts) !== JSON.stringify(order.executionCosts);
    if (!changed && !costChanged) continue;
    // Corrections require broker evidence, never a difference between two balance numbers.
    if (row.remainingQuantity > 0) { conflicts.push({ symbol: order.symbol, reason: "과거 주문 잔량 종료 여부 미확인" }); continue; }
    updates.push({ ...order, ...(costChanged ? { executionCosts: row.executionCosts } : {}), ...(changed ? { filledQuantity: row.filledQuantity, remainingQuantity: 0, fillPrice: row.fillPrice,
      status: row.filledQuantity === row.orderQuantity ? "FILLED" : "CANCELLED",
      reconciliationRequired: false, expirationReason: null, rawStatus: row.rawStatus || "증권사 과거 체결 증빙 확인", resultAt: row.filledAt || null,
      evidenceFilledAt: row.filledAt || null, historicalFillDate: row.filledAt ? koreanDate(row.filledAt) : String(row.source).startsWith("KIWOOM:") ? null : row.date,
      historicalQueryDate: row.date,
      reconciliationEvidence: { source: row.source, capturedAt: new Date().toISOString(),
        digest: createHash("sha256").update(JSON.stringify(row)).digest("hex"), previousFilledQuantity: order.filledQuantity, previousStatus: order.status } } : {}) });
  }
  return { updates, conflicts };
}

function holdingDiscrepancies(orders, holdings, environment) {
  const symbols = new Map(orders.filter(o => o.entryType && (o.environment || "mock") === environment).map(o => [`${o.market}:${o.symbol}`, o]));
  return [...symbols.values() as Iterable<any>].flatMap(order => {
    const payload = { ticker: order.symbol, exchange: order.market };
    const owned = managedPosition(orders, payload, environment);
    const actual = holdings.filter(h => sameInstrument({ symbol: h.code, market: h.market }, payload)).reduce((sum, h) => sum + h.quantity, 0);
    return actual < owned.quantity ? [{ symbol: order.symbol, market: order.market, managedQuantity: owned.quantity, actualQuantity: actual,
      difference: owned.quantity - actual, reason: "누락 체결·수동 매매·권리변동 증빙 대조 필요" }] : [];
  });
}

function settlementCosts(brokerId, transactions, orders) {
  const updates = [], unmatched = [];
  const seen = new Set();
  for (const row of transactions) {
    const symbol = brokerId === "KIWOOM" ? row.stk_cd : row.pdno;
    if (!symbol) continue;
    const date = brokerId === "KIWOOM" ? row.deal_dt : row.trad_dt;
    const side = brokerId === "KIWOOM" ? /매도/.test(row.rmrk_nm) ? "SELL" : /매수/.test(row.rmrk_nm) ? "BUY" : ""
      : row.sll_buy_dvsn_cd === "01" ? "SELL" : row.sll_buy_dvsn_cd === "02" ? "BUY" : "";
    if (!side) continue;
    const quantity = evidenceNumber(brokerId === "KIWOOM" ? row.deal_qty : row.ccld_qty);
    const price = evidenceNumber(brokerId === "KIWOOM" ? row.uv_exrt : row.ft_ccld_unpr2 || row.ovrs_stck_ccld_unpr);
    const currency = brokerId === "KIWOOM" ? row.crnc_code : row.crcy_cd;
    const fees = brokerId === "KIWOOM" ? evidenceNumber(row.fc_cmsn)
      : [row.dmst_frcr_fee1, row.frcr_fee1].every(v => evidenceNumber(v) !== null) ? evidenceNumber(row.dmst_frcr_fee1) + evidenceNumber(row.frcr_fee1) : null;
    const taxes = brokerId === "KIWOOM" ? evidenceNumber(row.fc_deal_tax) : null;
    const gross = evidenceNumber(row.tr_frcr_amt2), net = evidenceNumber(row.frcr_excc_amt_1);
    const total = brokerId === "KIS" && gross !== null && net !== null && price > 0 && quantity > 0 && Math.abs(gross - quantity * price) < 0.02
      ? (side === "BUY" ? net - gross : gross - net) : fees !== null && taxes !== null ? fees + taxes : null;
    const matches = orders.filter(o => o.market !== "KRX" && normalizedSymbol(o.symbol) === normalizedSymbol(symbol) && o.side === side
      && koreanDate(o.createdAt) === date && o.filledQuantity === quantity && Math.abs(Number(o.fillPrice) - price) < 0.0001);
    // A daily aggregated statement is applied only when it identifies exactly one stored fill.
    if (matches.length !== 1 || currency !== "USD" || fees === null || fees < 0 || total === null || total < fees - 0.00001 || !(quantity > 0) || !(price > 0)) {
      unmatched.push({ symbol, date, side, reason: "정산행과 체결의 유일한 연결 또는 전체 비용 증빙 필요" }); continue;
    }
    const source = `${brokerId}:${brokerId === "KIWOOM" ? "ust21100" : "inquire-period-trans"}:${date}:${row.deal_no || createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 16)}`;
    const executionCosts = { fees, taxes, total, currency, filledQuantity: quantity, source };
    const key = orderKey(matches[0]);
    if (seen.has(key)) { unmatched.push({ symbol, date, side, reason: "하나의 주문에 여러 정산행이 연결됨" }); continue; }
    seen.add(key);
    if (JSON.stringify(matches[0].executionCosts) !== JSON.stringify(executionCosts)) updates.push({ ...matches[0], executionCosts });
  }
  return { updates: updates.filter(order => !unmatched.some(row => row.symbol === order.symbol && row.date === koreanDate(order.createdAt) && row.side === order.side)), unmatched };
}

async function collectBrokerEvidence(broker, now = new Date()) {
  const orders = broker.tracker.list().filter(o => (o.environment || "mock") === broker.environment);
  const overseas = broker.overseasClient;
  const [domestic, usBalances] = await Promise.all([broker.domesticClient.getDomesticBalance(),
    overseas.getUsBalances ? overseas.getUsBalances() : overseas.getUsBalance().then(row => [row])]);
  const holdings = [...domestic.holdings.map(h => ({ ...h, market: "KRX" })),
    ...new Map(usBalances.flatMap(b => b.holdings).map(h => [h.code, { ...h, market: "US" }])).values() as Iterable<any>];
  const discrepancies = holdingDiscrepancies(orders, holdings, broker.environment);
  const affected = new Set(discrepancies.map(row => row.symbol));
  const targets = [...new Map(orders.filter(o => o.market !== "KRX" && affected.has(o.symbol)).flatMap(o => {
    const dates = broker.id === "KIWOOM" ? [koreanDate(o.createdAt), koreanDate(o.createdAt, "America/New_York")] : [koreanDate(o.createdAt)];
    return [...new Set(dates)].map(date => {
    const target = { date, exchange: o.exchange || ({ NASDAQ: "ND", NYSE: "NY", AMEX: "NA" })[o.market],
      ...(broker.id === "KIWOOM" ? { symbol: normalizedSymbol(o.symbol) } : {}) };
    return [`${target.date}:${target.exchange}:${target.symbol || ""}`, target];
    });
  })).values()] as any[];
  const executions = [], historyErrors = [];
  for (const target of targets) {
    try { executions.push(...await overseas.getUsHistoricalExecutions(target)); }
    catch (error) { historyErrors.push({ ...target, reason: error.message }); break; }
  }
  if (historyErrors.length) executions.length = 0;
  const reconciliation = reconciliationPlan(orders, executions, broker.environment);
  const corrected = orders.map(o => reconciliation.updates.find(u => orderKey(u) === orderKey(o)) || o);
  const historyStart = orders.filter(o => o.market !== "KRX").map(o => koreanDate(o.createdAt)).filter(Boolean).sort()[0] || koreanDate(now);
  let transactions = [], transactionError = "";
  try {
    // Kiwoom mock rejects an empty ticker despite the history documentation's all-symbol option.
    const scopes = broker.id === "KIWOOM" ? [...new Map<string, { symbol: string; exchange: string }>(orders.filter(o => o.market !== "KRX").map(o => {
      const scope = { symbol: normalizedSymbol(o.symbol), exchange: o.exchange || ({ NASDAQ: "ND", NYSE: "NY", AMEX: "NA" })[o.market] };
      return [`${scope.exchange}:${scope.symbol}`, scope];
    })).values()] : [{}];
    for (const scope of scopes) transactions.push(...await overseas.getUsTransactions({ startDate: historyStart, endDate: koreanDate(now), ...scope }));
    transactions = [...new Map(transactions.map(row => [JSON.stringify(row), row])).values()];
  }
  catch (error) { transactions = []; transactionError = error.message; }
  const costs = settlementCosts(broker.id, transactions, corrected);
  let equity = [], equityError = "";
  try {
    equity = await collectAccountEquity(broker);
  } catch (error) { equity = []; equityError = error.message; }
  return { capturedAt: now.toISOString(), equityCapturedAt: new Date().toISOString(), brokerId: broker.id, environment: broker.environment,
    discrepancies, remainingDiscrepancies: holdingDiscrepancies(corrected, holdings, broker.environment),
    executions, historyErrors, transactions, transactionError, reconciliation, costs, equity, equityError };
}

function applyEvidence(broker, report, file) {
  if (report.brokerId !== broker.id || report.environment !== broker.environment) throw Error("증빙 계좌 환경 불일치");
  const state = readEvidence(file);
  const updates = new Map();
  for (const order of [...report.reconciliation.updates, ...report.costs.updates]) updates.set(orderKey(order), { ...updates.get(orderKey(order)), ...order });
  for (const [key, proposal] of updates as Iterable<[string, any]>) {
    const current = broker.tracker.list().find(order => orderKey(order) === key);
    // No await between this revision check and the write: reporting cannot interleave a stale snapshot.
    if (!current || current.revision !== proposal.revision) throw Error("대조 중 주문 기록 변경 · 다시 조회 필요");
    const entry = { brokerId: broker.id, environment: broker.environment, at: new Date().toISOString(), before: current, after: proposal };
    state.adjustments.push(entry);
    writeEvidence(file, state); // Evidence durable before updating the ledger; never fabricate a broker submission.
    broker.tracker.record({ ...current, ...proposal });
  }
  state.brokers[`${broker.id}:${broker.environment}`] = report;
  recordAccountEquity(state, broker, report.equity || [], report.equityCapturedAt || report.capturedAt);
  writeEvidence(file, state);
  return updates.size;
}

function validateStatement(input, broker) {
  if (input?.version !== 1 || input.brokerId !== broker.id || input.environment !== broker.environment
    || typeof input.source !== "string" || input.source.trim().length < 8 || input.source.length > 300
    || !Array.isArray(input.executions) || input.executions.length > 500) throw Error("명세서 형식·계좌·출처 오류");
  return input.executions.map(row => {
    if (!/^\d{1,20}$/.test(String(row.orderNo)) || !/^[A-Z0-9.-]{1,12}$/.test(row.symbol)
      || !/^\d{8}$/.test(row.date) || !["BUY", "SELL"].includes(row.side)
      || ![row.orderQuantity, row.filledQuantity, row.remainingQuantity].every(Number.isInteger)
      || row.orderQuantity < 1 || row.filledQuantity < 0 || row.remainingQuantity !== 0 || row.filledQuantity > row.orderQuantity
      || typeof row.fillPrice !== "number" || !Number.isFinite(row.fillPrice) || row.fillPrice <= 0
      || (row.filledAt && (koreanDate(row.filledAt) !== row.date || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(row.filledAt)))) throw Error("명세서 체결값 오류");
    const source = `owner-statement:${input.source}`;
    const costs = row.executionCosts;
    if (costs && (costs.currency !== "USD" || ![costs.fees, costs.taxes].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      || row.filledQuantity <= 0)) throw Error("명세서 거래비용 증빙 오류");
    return { ...row, filledAt: row.filledAt || null, source,
      ...(costs ? { executionCosts: { fees: costs.fees, taxes: costs.taxes, total: costs.fees + costs.taxes, currency: costs.currency, filledQuantity: row.filledQuantity, source } } : {}) };
  });
}

module.exports = { evidenceNumber, koreanDate, executionDateMatches, evidenceFile, orderKey, readEvidence, writeEvidence, reconciliationPlan, holdingDiscrepancies, settlementCosts, collectBrokerEvidence, applyEvidence, validateStatement, equityAccountRef, collectAccountEquity, recordAccountEquity, refreshAccountEquity };
