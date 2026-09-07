"use strict";

const { formatInstrumentLabel } = require("../research/instrument-names");
const { normalizedTimeframe } = require("../trading/position-ownership");
const { nextOrderCheck, domesticSessionClock, usSessionClock } = require("../trading/paper-order-executor");
const { tradingDay } = require("../trading/market-calendar");

const STATUS = { RECEIVED: "신호 수신 · 계좌 확인 중", PROCESSING: "계좌·주문 조건 확인 중", APPROVAL: "BUY 승인 대기",
  ACCEPTED: "주문 접수", PARTIALLY_FILLED: "부분 체결", FILLED: "체결 완료", CANCEL_REQUESTED: "취소 확인 중",
  CANCELLED: "취소 완료", EXPIRED: "만료", REJECTED: "증권사 거절", BLOCKED: "조건 미충족 · 주문 안 함",
  UNKNOWN: "접수 여부 미확인 · 재주문 차단", SUBMITTING: "주문 전송 중", DEFER_REQUIRED: "재확인 대기",
  SKIPPED_NO_POSITION: "미보유 · 주문 대상 아님", SKIPPED_EXISTING_POSITION: "기존 보유 · 중복 진입 안 함",
  SKIPPED_TIMEFRAME: "진입 시간봉과 다름 · 주문 대상 아님", SKIPPED_UNMANAGED_POSITION: "자동매매 보유분 없음",
  NO_ACTION: "관찰 신호 · 주문 대상 아님" };

function lifecycleBrokerState(entry, broker, receipts, now = Date.now()) {
  const record = entry.record;
  const progress = entry.progress[broker.id] || { status: receipts.state.inbox[record.requestId] ? "RECEIVED" : "NO_ACTION", reason: "" };
  const order = broker.tracker.list().find(order => order.requestId === record.requestId);
  if (order) return { ...progress, ...order, status: order.status, next: ["ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED"].includes(order.status) ? "30초 주기로 체결 확인" : "", reason: "" };
  const attempt = receipts.state.attempts[`${broker.id}:${record.requestId}`];
  if (attempt?.status === "SUBMITTING" && broker.submitting?.has(`${broker.id}:${record.requestId}`)) return { status: "SUBMITTING", reason: "증권사 응답 대기 · 아직 접수 확정 아님" };
  if (["SUBMITTING", "UNKNOWN"].includes(attempt?.status)) return { status: "UNKNOWN", reason: "증권사 접수 여부 대조 필요 · 자동 재주문 안 함" };
  const deferred = receipts.state.deferred[`${broker.id}:${record.requestId}`];
  if (deferred) {
    if (deferred.expiresAt <= now) return { status: "EXPIRED", reason: "예약 유효시간 종료 · 새 신호 필요" };
    if (!receipts.autoTrading()) return { status: "DEFER_REQUIRED", reason: "자동매매 OFF · 자동 재시도 일시정지" };
    const due = deferred.nextAttemptAt < Number.MAX_SAFE_INTEGER ? Math.max(now, deferred.nextAttemptAt || now) : now;
    const afterSession = deferred.lastAttemptMarketDate && deferred.orderRetrySessionKey !== deferred.lastAttemptMarketDate ? deferred.lastAttemptMarketDate : "";
    const next = deferred.kind === "VERIFY" ? due : nextOrderCheck(record, new Date(due), afterSession);
    const clock = record.payload.exchange === "KRX" ? domesticSessionClock(new Date(now)) : usSessionClock(new Date(now));
    const day = tradingDay(record.payload.exchange, clock.date, clock.weekday);
    return { status: "DEFER_REQUIRED", reason: deferred.kind === "VERIFY" ? "잔고·이전 주문 종료 재확인" : day.reason || "주문 가능 세션·증권사 접수 재확인",
      next: next && next < deferred.expiresAt ? `<t:${Math.ceil(next / 1000)}:F> 이후 (15초 주기)` : "유효시간 내 확인 가능한 거래 일정 없음", expiresAt: deferred.expiresAt };
  }
  const pending: any = Object.values(receipts.state.pending).find((item: any) => item.record.requestId === record.requestId && item.brokerIds?.includes(broker.id));
  if (pending) return pending.expiresAt > now ? { status: "APPROVAL", reason: pending.previews?.[broker.id]?.preview?.reason || record.risk?.reason,
    orderQuantity: pending.previews?.[broker.id]?.preview?.quantity, preview: pending.previews?.[broker.id]?.preview, expiresAt: pending.expiresAt }
    : { status: "EXPIRED", reason: "BUY 승인 유효시간 종료" };
  const inbox = receipts.state.inbox[record.requestId];
  if (inbox && !inbox.completed.includes(broker.id) && inbox.expiresAt <= now) return { status: "EXPIRED", reason: "계좌 확인 유효시간 종료" };
  return progress;
}

function formatLifecycleCard(entry, brokers, receipts, now = Date.now()) {
  const states = brokers.map(broker => ({ broker, state: lifecycleBrokerState(entry, broker, receipts, now) }));
  const approval = states.some(({ state }) => state.status === "APPROVAL");
  const fields = states.map(({ broker, state }) => ({ name: `${broker.label} ${broker.environment === "live" ? "실계좌" : "모의계좌"}`,
      value: [STATUS[state.status] || state.status, state.reason,
        Number.isFinite(state.orderQuantity) ? `수량 ${state.orderQuantity}주${Number.isFinite(state.filledQuantity) ? ` · 체결 ${state.filledQuantity}주 · 잔량 ${state.remainingQuantity ?? "확인 중"}주` : " (승인 시 재계산)"}` : "",
        state.limitPrice > 0 ? `지정가 ${state.limitPrice} · ${state.fillPrice > 0 ? `체결 평단 ${state.fillPrice}` : "미체결"}` : "",
        state.preview?.capitalOnly ? "⚠️ PEG 손절가 없음 · 위험금액 계산 불가 · 종목 최대 10% 한도" : "",
        Number.isFinite(state.preview?.positionValue) ? `예상 투입 ${state.preview.positionValue.toFixed(2)} ${state.preview.currency} · 비중 ${state.preview.projectedPositionRatio?.toFixed(2)}% / 한도 ${(state.preview.positionLimitRatio * 100).toFixed(0)}%` : "",
        Number.isFinite(state.preview?.autoCapitalRatio) ? `실계좌 자동운용 ${(state.preview.autoCapitalRatio * 100).toFixed(0)}% · 동시 손절위험 한도 ${(state.preview.maxOpenRiskRatio * 100).toFixed(1)}%` : "",
        state.next ? `다음 확인: ${state.next}` : "",
        state.expiresAt ? `유효기한: <t:${Math.floor(state.expiresAt / 1000)}:F>` : "",
      ].filter(Boolean).join("\n").slice(0, 1024) }));
  if (approval) fields.push({ name: "이 카드에 답장", value: "`둘다` / `키움만` / `한투만` / `안 사` · 승인 가능 계좌에만 적용" });
  const timeframe = normalizedTimeframe(entry.record.payload.timeframe);
  return { embeds: [{ title: "신호별 주문 진행", color: approval ? 0xf59f00 : 0x5865f2,
    description: `${formatInstrumentLabel(entry.record.payload)}\n${entry.record.payload.action} · ${timeframe === "1D" ? "일봉" : timeframe === "240" ? "4시간봉" : entry.record.payload.timeframe} · ${entry.record.outcome?.signal?.signalCode || "신호"}`,
    fields,
    footer: { text: `신호 ${entry.record.requestId} · 접수와 체결은 다릅니다` },
  }], allowedMentions: { parse: [] } };
}

module.exports = { lifecycleBrokerState, formatLifecycleCard };
