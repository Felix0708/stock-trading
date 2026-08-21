"use strict";

const { normalizeSignal } = require("./signal-normalizer");

const ENTRY_CODES = new Set([
  "ENTRY_STANDARD",
  "ENTRY_BREAKOUT",
  "ENTRY_AGGRESSIVE",
  "MOMENTUM_BUY",
  "PEG_PULLBACK",
  "PEG_REBREAK",
]);
const FULL_EXIT_CODES = new Set([
  "EXIT_FINAL",
  "EXIT_BREAKOUT",
  "EXIT_CRASH",
  "MOMENTUM_SELL",
  "PEG_INVALIDATED",
]);
const PARTIAL_EXIT_CODES = new Set([
  "EXIT_PARTIAL_1",
  "EXIT_PARTIAL_2",
  "TAKE_PROFIT",
]);

function instrumentKey(payload) {
  return `${payload.exchange || "UNKNOWN"}:${payload.ticker}:${payload.timeframe}`;
}

function signalFingerprint(payload, normalized) {
  return JSON.stringify([
    instrumentKey(payload),
    normalized.signalCode,
    normalized.tpLevel,
    payload.action,
    payload.price,
    payload.sl,
    payload.rr,
  ]);
}

class SignalStateMachine {
  constructor(snapshot = {}, options = {}) {
    this.deduplicationMs = options.deduplicationMs ?? 5_000;
    this.instruments = new Map(Object.entries(snapshot.instruments || {}));
    this.recentFingerprints = new Map();
  }

  handle(payload, receivedAt = new Date()) {
    const timestamp = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error("receivedAt이 올바른 시각이 아닙니다.");

    const normalized = normalizeSignal(payload);
    const key = instrumentKey(payload);
    const fingerprint = signalFingerprint(payload, normalized);
    const previousTime = this.recentFingerprints.get(fingerprint);
    if (previousTime !== undefined && timestamp.getTime() - previousTime >= 0
        && timestamp.getTime() - previousTime <= this.deduplicationMs) {
      return this.result(key, normalized, "DUPLICATE_IGNORED", [], true);
    }
    this.recentFingerprints.set(fingerprint, timestamp.getTime());
    this.pruneFingerprints(timestamp.getTime());

    const current = this.instruments.get(key) || { status: "IDLE" };
    const warnings = [...normalized.warnings];
    let status = current.status;
    let decision = "INFO_ONLY";

    if (normalized.orderBlocked) {
      decision = "BLOCKED";
    } else if (ENTRY_CODES.has(normalized.signalCode)) {
      status = "ENTRY_SIGNALLED";
      decision = "ENTRY_CANDIDATE";
    } else if (["ADD_PYRAMID", "ADD_STRONG_PULLBACK"].includes(normalized.signalCode)) {
      decision = "ADD_CANDIDATE";
    } else if (normalized.signalCode === "ENTRY_INVALIDATED") {
      if (!["ENTRY_SIGNALLED", "ENTRY_CONFIRMED", "ENTRY_INVALID_PENDING"].includes(current.status)) {
        warnings.push("선행 진입 신호를 현재 상태에서 찾지 못했습니다. 재시작 또는 신호 누락 여부를 확인해야 합니다.");
      }
      status = "ENTRY_INVALID_PENDING";
      decision = "WAIT_FOR_CONFIRMATION";
    } else if (normalized.signalCode === "ENTRY_CONFIRMED") {
      status = "ENTRY_CONFIRMED";
      decision = "KEEP_IF_FILLED";
    } else if (normalized.signalCode === "ENTRY_EXPIRED") {
      status = "ENTRY_EXPIRED";
      decision = "EXIT_IF_FILLED";
    } else if (FULL_EXIT_CODES.has(normalized.signalCode)) {
      status = "EXIT_SIGNALLED";
      decision = "EXIT_CANDIDATE";
    } else if (PARTIAL_EXIT_CODES.has(normalized.signalCode)) {
      decision = "PARTIAL_EXIT_CANDIDATE";
    } else if (normalized.signalCode === "MOMENTUM_UP_ENDED") {
      decision = "REVIEW_PARTIAL_EXIT";
    }

    const next = {
      ...current,
      status,
      lastSignalCode: normalized.signalCode,
      lastRawType: normalized.rawType,
      lastPrice: payload.price,
      updatedAt: timestamp.toISOString(),
    };
    if (decision === "ENTRY_CANDIDATE") {
      next.entrySignalPrice = payload.price;
      next.entrySignalAt = timestamp.toISOString();
    }
    if (status === "ENTRY_INVALID_PENDING") next.invalidatedAt = timestamp.toISOString();
    this.instruments.set(key, next);

    return this.result(key, normalized, decision, warnings, false);
  }

  result(key, normalized, decision, warnings, duplicate) {
    return {
      key,
      state: this.instruments.get(key) || { status: "IDLE" },
      signal: normalized,
      decision,
      duplicate,
      orderCreated: false,
      warnings,
    };
  }

  pruneFingerprints(nowMs) {
    for (const [fingerprint, timestamp] of this.recentFingerprints) {
      if (nowMs - timestamp > this.deduplicationMs) this.recentFingerprints.delete(fingerprint);
    }
  }

  snapshot() {
    return { instruments: Object.fromEntries(this.instruments) };
  }
}

module.exports = {
  SignalStateMachine,
  instrumentKey,
};
