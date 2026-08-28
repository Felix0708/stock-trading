"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");

const PREFIX = "LAZY_SIGNAL_V1:";
const TRANSPORT_URL_PREFIX = "https://discord.com/#";
const ALLOWED_VERDICTS = new Set([
  "BUY_PENDING_APPROVAL", "PAPER_ENTRY", "PAPER_ADD", "PAPER_PARTIAL_EXIT", "PAPER_EXIT",
  "WAIT", "KEEP", "REVIEW_PARTIAL_EXIT",
]);
const PAYLOAD_FIELDS = [
  "ticker", "name", "exchange", "timeframe", "action", "type", "price", "sl", "rr", "conviction",
  "momentum_sl", "momentum_tp",
  "daily_above_200ma", "daily_trend", "daily_ema_aligned", "daily_setup_stage",
  "atr_multiple", "atr_dot", "atr_dot_threshold", "sb_z_score", "paper_order_test",
];

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function encodeSignalEnvelope(record) {
  if (!ALLOWED_VERDICTS.has(record?.risk?.verdict)) return null;
  const value = {
    requestId: record.requestId,
    receivedAt: record.receivedAt,
    payload: Object.fromEntries(PAYLOAD_FIELDS.filter((key) => record.payload?.[key] !== undefined).map((key) => [key, record.payload[key]])),
    outcome: {
      decision: record.outcome?.decision,
      signal: record.outcome?.signal,
      state: record.outcome?.state && {
        entrySignalPrice: record.outcome.state.entrySignalPrice,
        entrySignalAt: record.outcome.state.entrySignalAt,
      },
    },
    risk: { verdict: record.risk?.verdict, reason: record.risk?.reason },
  };
  const body = zlib.deflateRawSync(JSON.stringify(value)).toString("base64url");
  const encoded = `${PREFIX}${body}.${checksum(body)}`;
  if (`${TRANSPORT_URL_PREFIX}${encoded}`.length > 2_048) throw new Error("Discord 신호 봉투가 전송 한도를 초과했습니다.");
  return encoded;
}

function decodeSignalEnvelope(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  try {
    const [body, signature, extra] = value.slice(PREFIX.length).split(".");
    if (!body || !signature || extra || signature !== checksum(body)) throw new Error("checksum");
    const inflated = zlib.inflateRawSync(Buffer.from(body, "base64url"), { maxOutputLength: 65_536 }).toString("utf8");
    const decoded = JSON.parse(inflated);
    if (!decoded?.requestId || !decoded?.payload?.ticker || !decoded?.payload?.exchange || !decoded?.payload?.action) {
      throw new Error("required fields");
    }
    if (!ALLOWED_VERDICTS.has(decoded?.risk?.verdict)) throw new Error("verdict");
    return decoded;
  } catch (error) {
    throw new Error("Discord 신호 봉투가 손상되었거나 올바르지 않습니다.", { cause: error });
  }
}

function decodeSignalEmbed(embed) {
  const url = embed?.author?.url;
  const encoded = typeof url === "string" && url.startsWith(TRANSPORT_URL_PREFIX)
    ? url.slice(TRANSPORT_URL_PREFIX.length)
    : embed?.footer?.text;
  return decodeSignalEnvelope(encoded);
}

module.exports = { decodeSignalEmbed, decodeSignalEnvelope, encodeSignalEnvelope, PREFIX, TRANSPORT_URL_PREFIX };
