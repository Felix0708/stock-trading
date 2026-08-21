"use strict";

const fs = require("node:fs");

const TRADING_MODES = new Set(["OFF", "SHADOW", "PAPER_AUTO"]);
const ENTRY_DECISIONS = new Set(["ENTRY_CANDIDATE", "ADD_CANDIDATE"]);
const FULL_EXIT_DECISIONS = new Set(["EXIT_CANDIDATE", "EXIT_IF_FILLED"]);

function positionKey(payload) {
  return `${payload.exchange || "UNKNOWN"}:${payload.ticker}`;
}

function partialExitKey(outcome) {
  return `${outcome?.signal?.signalCode || "UNKNOWN"}:${outcome?.signal?.tpLevel || ""}`;
}

class TradeController {
  constructor(options = {}) {
    this.maxOpenPositions = options.maxOpenPositions ?? 5;
    this.buyApprovalRequired = Boolean(options.buyApprovalRequired);
    this.earlyEntryApprovalEnabled = Boolean(options.earlyEntryApprovalEnabled);
    this.stateFile = options.stateFile || null;
    this.decisionLogFile = options.decisionLogFile || null;
    if (!Number.isInteger(this.maxOpenPositions) || this.maxOpenPositions < 1) {
      throw new Error("maxOpenPositions는 1 이상의 정수여야 합니다.");
    }
    this.state = this.loadState(options.initialMode || "SHADOW");
  }

  loadState(initialMode) {
    if (!TRADING_MODES.has(initialMode)) throw new Error(`지원하지 않는 매매 모드: ${initialMode}`);
    if (!this.stateFile || !fs.existsSync(this.stateFile)) {
      return { mode: initialMode, halted: false, positions: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    if (!TRADING_MODES.has(parsed.mode)) throw new Error("trading-state.json의 mode가 올바르지 않습니다.");
    return { mode: parsed.mode, halted: Boolean(parsed.halted), positions: parsed.positions || {} };
  }

  saveState() {
    if (!this.stateFile) return;
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  setMode(mode) {
    if (!TRADING_MODES.has(mode)) throw new Error(`지원하지 않는 매매 모드: ${mode}`);
    this.state.mode = mode;
    this.saveState();
    return this.status();
  }

  setHalted(halted) {
    this.state.halted = Boolean(halted);
    this.saveState();
    return this.status();
  }

  status() {
    return {
      mode: this.state.mode,
      halted: this.state.halted,
      maxOpenPositions: this.maxOpenPositions,
      openCount: Object.keys(this.state.positions).length,
      positions: Object.values(this.state.positions),
      liveOrdersEnabled: false,
    };
  }

  evaluate(record) {
    const payload = record.payload || {};
    const outcome = record.outcome || {};
    const key = positionKey(payload);
    const existing = this.state.positions[key];
    const decision = outcome.decision;
    let verdict = "NO_ACTION";
    let reason = "주문 대상이 아닌 신호";

    if (!record.validation?.ok || ["BLOCKED", "REJECTED_INVALID"].includes(decision)) {
      verdict = "BLOCKED_INVALID_SIGNAL";
      reason = "명세 또는 신호 검증 실패";
    } else if (ENTRY_DECISIONS.has(decision) && record.positionPreview?.blocked) {
      verdict = "BLOCKED_POSITION_SIZE";
      reason = record.positionPreview.reason || "주문 수량 계산 차단";
    } else if (ENTRY_DECISIONS.has(decision)) {
      ({ verdict, reason } = this.evaluateEntry(record, key, existing));
    } else if (FULL_EXIT_DECISIONS.has(decision)) {
      if (this.state.mode === "OFF") {
        verdict = "BLOCKED_MODE_OFF";
        reason = "매매 모드 OFF";
      } else if (!existing) {
        verdict = "NO_POSITION";
        reason = "모의 포지션 없음 — 실제 잔고 확인 필요";
      } else {
        if (this.state.mode === "PAPER_AUTO") {
          verdict = "PAPER_EXIT";
          reason = "키움 모의 청산 주문 대기";
        } else {
          delete this.state.positions[key];
          verdict = "SHADOW_EXIT";
          reason = "모의 포지션 청산 반영";
        }
      }
    } else if (decision === "PARTIAL_EXIT_CANDIDATE") {
      const stage = partialExitKey(outcome);
      if (this.state.mode === "OFF") {
        verdict = "BLOCKED_MODE_OFF";
        reason = "매매 모드 OFF";
      } else if (!existing) {
        verdict = "NO_POSITION";
        reason = "모의 포지션 없음 — 실제 잔고 확인 필요";
      } else if (existing.pendingPartialExit === stage || existing.partialExitSignals?.includes(stage)) {
        verdict = "BLOCKED_PARTIAL_DUPLICATE";
        reason = "같은 부분청산 단계가 이미 대기 또는 체결됨";
      } else {
        verdict = this.state.mode === "PAPER_AUTO" ? "PAPER_PARTIAL_EXIT" : "SHADOW_PARTIAL_EXIT";
        reason = this.state.mode === "PAPER_AUTO" ? "키움 모의 부분청산 주문 대기" : "부분청산 신호 기록 — 주문 없음";
        if (this.state.mode === "PAPER_AUTO") existing.pendingPartialExit = stage;
        else existing.partialExitSignals = [...(existing.partialExitSignals || []), stage];
      }
    } else if (decision === "REVIEW_PARTIAL_EXIT") {
      verdict = existing ? "REVIEW_PARTIAL_EXIT" : "NO_POSITION";
      reason = existing ? "수익 상태에 따른 차등 비율 검토 필요" : "모의 포지션 없음 — 실제 잔고 확인 필요";
    } else if (decision === "WAIT_FOR_CONFIRMATION") {
      verdict = "WAIT";
      reason = "진입 무효 — 즉시 청산하지 않고 확정/만료 대기";
    } else if (decision === "KEEP_IF_FILLED") {
      verdict = existing ? "KEEP" : "NO_POSITION";
      reason = existing ? "진입 확정 — 모의 포지션 유지" : "모의 포지션 없음 — 실제 체결 확인 필요";
    }

    this.saveState();
    const result = {
      verdict,
      reason,
      mode: this.state.mode,
      halted: this.state.halted,
      maxOpenPositions: this.maxOpenPositions,
      openCount: Object.keys(this.state.positions).length,
      positionKey: key,
      liveOrderCreated: false,
    };
    if (this.decisionLogFile) {
      fs.appendFileSync(this.decisionLogFile, `${JSON.stringify({
        at: new Date().toISOString(), requestId: record.requestId, ticker: payload.ticker,
        signalCode: outcome.signal?.signalCode, ...result,
      })}\n`, { mode: 0o600 });
    }
    return result;
  }

  evaluateEntry(record, key, existing) {
    const payload = record.payload;
    const decision = record.outcome.decision;
    if (this.state.mode === "OFF") return { verdict: "BLOCKED_MODE_OFF", reason: "매매 모드 OFF" };
    if (this.state.halted) return { verdict: "BLOCKED_HALTED", reason: "신규 진입 중지 상태" };
    if (payload.conviction === "D") return { verdict: "BLOCKED_CONVICTION_D", reason: "Webhook v6.2 conviction D 매수 차단" };
    if (!Number.isFinite(payload.sl) || payload.sl <= 0 || payload.sl >= payload.price) {
      return { verdict: "BLOCKED_INVALID_STOP", reason: "유효한 손절가가 없어 자동 진입 차단" };
    }
    if (!["BULL", "MIXED", "BEAR"].includes(payload.daily_trend)
        || typeof payload.daily_ema_aligned !== "boolean"
        || typeof payload.daily_above_200ma !== "boolean") {
      return { verdict: "BLOCKED_DAILY_DATA", reason: "일봉 필터 데이터 누락 또는 형식 오류" };
    }
    if (payload.daily_trend === "BEAR") {
      return { verdict: "BLOCKED_DAILY_BEAR", reason: "일봉 하락 추세 — BUY 차단" };
    }
    if (!payload.daily_above_200ma) {
      return { verdict: "BLOCKED_DAILY_200MA", reason: "일봉 200일선 아래 — BUY 차단" };
    }
    if (existing?.pendingOrder) return { verdict: "BLOCKED_PENDING_ORDER", reason: "이전 진입 주문 체결 확인 중" };
    if ((existing || record.positionPreview?.hasExistingPosition) && record.positionPreview?.positionProfitable !== true) {
      return record.positionPreview?.positionProfitable === false
        ? { verdict: "BLOCKED_ADD_NOT_PROFITABLE", reason: "손실 또는 본전 포지션 추가매수 차단" }
        : { verdict: "BLOCKED_ADD_PROFIT_UNKNOWN", reason: "기존 포지션 수익 여부를 확인할 수 없어 추가매수 차단" };
    }
    if (payload.daily_trend !== "BULL" || !payload.daily_ema_aligned) {
      if (!this.earlyEntryApprovalEnabled || this.state.mode !== "PAPER_AUTO") {
        return { verdict: "REVIEW_DAILY_CONFIRMATION", reason: "일봉 강세·정배열 미확정 — 주문 없이 검토" };
      }
      if (record.buyApproved !== true) {
        return { verdict: "BUY_PENDING_APPROVAL", reason: "일봉 초기 신호 — 소액 진입 사용자 승인 대기" };
      }
    }
    const approvalPending = this.buyApprovalRequired && this.state.mode === "PAPER_AUTO" && record.buyApproved !== true;
    if (decision === "ADD_CANDIDATE") {
      if (!existing && !record.positionPreview?.hasExistingPosition) {
        return { verdict: "BLOCKED_NO_POSITION", reason: "기존 포지션 없이 추가매수 불가" };
      }
      if (approvalPending) return { verdict: "BUY_PENDING_APPROVAL", reason: "사용자 BUY 승인 대기" };
      if (existing) {
        existing.addSignals = (existing.addSignals || 0) + 1;
        existing.updatedAt = record.receivedAt;
        existing.pendingOrder = this.state.mode === "PAPER_AUTO";
      } else {
        this.state.positions[key] = {
          key, ticker: payload.ticker, name: payload.name, exchange: payload.exchange,
          entrySignalPrice: payload.price, stopPrice: payload.sl, openedAt: record.receivedAt,
          mode: this.state.mode, quantity: record.positionPreview.currentPositionQuantity,
          pendingOrder: this.state.mode === "PAPER_AUTO",
        };
      }
      return {
        verdict: this.state.mode === "PAPER_AUTO" ? "PAPER_ADD" : "SHADOW_ADD",
        reason: "한 종목 총 20% 한도 내 추가매수",
      };
    }
    if (existing || record.positionPreview?.hasExistingPosition) {
      if (approvalPending) return { verdict: "BUY_PENDING_APPROVAL", reason: "기존 보유 비중 재확인 후 사용자 BUY 승인 대기" };
      if (!existing) {
        this.state.positions[key] = {
          key, ticker: payload.ticker, name: payload.name, exchange: payload.exchange,
          entrySignalPrice: payload.price, stopPrice: payload.sl, openedAt: record.receivedAt,
          mode: this.state.mode, quantity: record.positionPreview.currentPositionQuantity,
          pendingOrder: this.state.mode === "PAPER_AUTO",
        };
      } else {
        existing.pendingOrder = this.state.mode === "PAPER_AUTO";
      }
      return {
        verdict: this.state.mode === "PAPER_AUTO" ? "PAPER_ADD" : "SHADOW_ADD",
        reason: "기존 보유 확인 — 한 종목 총 20% 한도 내 추가매수",
      };
    }
    if (Object.keys(this.state.positions).length >= this.maxOpenPositions) {
      return { verdict: "BLOCKED_MAX_POSITIONS", reason: `동시 보유 종목 한도 ${this.maxOpenPositions}개 도달` };
    }
    if (approvalPending) return { verdict: "BUY_PENDING_APPROVAL", reason: "사용자 BUY 승인 대기" };

    this.state.positions[key] = {
      key,
      ticker: payload.ticker,
      name: payload.name,
      exchange: payload.exchange,
      entrySignalPrice: payload.price,
      stopPrice: payload.sl,
      openedAt: record.receivedAt,
      mode: this.state.mode,
      quantity: null,
      pendingOrder: this.state.mode === "PAPER_AUTO",
    };
    return {
      verdict: this.state.mode === "PAPER_AUTO" ? "PAPER_ENTRY" : "SHADOW_ENTRY",
      reason: this.state.mode === "PAPER_AUTO" ? "키움 모의 진입 주문 대기" : "모의 포지션 슬롯 생성 — 주문 없음",
    };
  }

  reconcileOrder(record, order) {
    const key = positionKey(record.payload || {});
    const position = this.state.positions[key];
    const entry = ENTRY_DECISIONS.has(record.outcome?.decision);
    const exit = FULL_EXIT_DECISIONS.has(record.outcome?.decision);
    const partialExit = record.outcome?.decision === "PARTIAL_EXIT_CANDIDATE";
    if (entry && ["CANCELLED", "REJECTED"].includes(order.status)) {
      if (record.risk?.verdict === "PAPER_ADD" && position) position.pendingOrder = false;
      else delete this.state.positions[key];
    }
    if (entry && position && order.status === "FILLED") {
      const previousQuantity = Number(position.quantity) || 0;
      const previousPrice = Number(position.fillPrice);
      position.quantity = previousQuantity + order.filledQuantity;
      position.pendingOrder = false;
      position.orderNo = order.orderNo;
      position.fillPrice = previousQuantity > 0 && Number.isFinite(previousPrice)
        ? ((previousPrice * previousQuantity) + (order.fillPrice * order.filledQuantity)) / position.quantity
        : order.fillPrice;
      position.updatedAt = order.updatedAt;
    }
    if (exit && order.status === "FILLED") delete this.state.positions[key];
    if (partialExit && position) {
      if (["CANCELLED", "REJECTED"].includes(order.status)) delete position.pendingPartialExit;
      if (order.status === "FILLED") {
        const stage = partialExitKey(record.outcome);
        if (Number.isInteger(position.quantity)) position.quantity = Math.max(0, position.quantity - order.filledQuantity);
        position.partialExitSignals = [...new Set([...(position.partialExitSignals || []), stage])];
        delete position.pendingPartialExit;
        position.updatedAt = order.updatedAt;
        if (position.quantity === 0) delete this.state.positions[key];
      }
    }
    this.saveState();
  }
}

module.exports = {
  TradeController,
  TRADING_MODES,
  partialExitKey,
  positionKey,
};
