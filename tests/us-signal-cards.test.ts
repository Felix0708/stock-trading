"use strict";
const assert = require("node:assert/strict");
const { signalCard, signalCategory, digestCards, recentSignals, sepaSnapshot, sepaResearchPrompt, US_CHANNELS } = require("../src/discord/us-signal-cards");
const { formatWebhookRecord, targetSignalChannels } = require("../src/discord/webhook-discord");
const { decodeSignalEmbed } = require("../src/discord/discord-signal-envelope");
const { shouldReviewSignal } = require("../src/ai/signal-review");
const { SIGNAL_MARKETS, marketChannelName, signalMarket, matchesSignalChannel } = require("../src/signals/signal-market");
const { marketDate } = require("../src/discord/us-signal-cards");
const { TradeController } = require("../src/trading/trade-controller");
const now = Date.parse("2026-09-18T21:00:00Z");
function record(type = "정석 진입", action = "BUY", changes: any = {}) {
  return { requestId: `synthetic-${type}`, receivedAt: new Date(now).toISOString(), validation: { ok: true }, outcome: { decision: "ENTRY_CANDIDATE" }, risk: { verdict: "PAPER_ENTRY" },
    payload: { schema_ver: "5.0", ticker: "TEST", name: "합성 테스트", exchange: "NASDAQ", timeframe: "240", bar_time: now - 14400000,
      type, action, price: 100, sl: 95, tp1: 110, tp2: 115, rr: 2, conviction: "A", grade: "GO", htf: "D", htf_trend: "BULL",
      atr_multiple: 9, atr_dot_threshold: 8, atr_dot: false, indicator_stock: { rs_rating: 80, adx: 30, rel_vol: 1.2 }, ...changes } };
}
const types = [
  ["셋업 형성 중", "CHECK", "관찰"], ["VCP 형성", "CHECK", "관찰"], ["정석 진입", "BUY", "진입"], ["돌파 진입", "BUY", "진입"],
  ["눌림 진입", "BUY", "진입"], ["피라미딩 추매", "BUY", "추매"], ["강한 눌림목", "BUY", "추매"],
  ["1차 분할청산", "SELL", "관리"], ["2차 분할청산", "SELL", "관리"], ["TP1 달성", "SELL", "관리"], ["TP2 달성", "SELL", "관리"],
  ["부분 익절고려", "CHECK", "관리"], ["과열 경고", "CHECK", "관리"], ["박스권 이탈", "CHECK", "관리"],
  ["최종 청산", "SELL", "청산"], ["돌파 청산", "SELL", "청산"],
  ["모멘텀 BUY", "BUY", "모멘텀"], ["모멘텀 SELL", "SELL", "모멘텀"], ["상승 모멘텀 종료", "SELL", "모멘텀"], ["하락 모멘텀 종료", "CHECK", "모멘텀"],
  ["PEG Start", "CHECK", "peg"], ["PEG Pullback", "BUY", "peg"], ["PEG Rebreak", "BUY", "peg"], ["PEG Invalid", "SELL", "peg"], ["PEG Expired", "CHECK", "peg"],
];
for (const [type, action, expected] of types) {
  const r = record(type, action), original = JSON.stringify(r);
  assert.equal(signalCategory(r), expected);
  const card = signalCard(r);
  assert.equal(card.author, undefined);
  assert.equal(decodeSignalEmbed(card), null);
  assert.equal(JSON.stringify(r), original); // presentation must not mutate execution data
  assert.equal(targetSignalChannels(r)[0], `미국-${expected}`);
  const formatted = formatWebhookRecord(r);
  assert.equal(decodeSignalEmbed(formatted.transportEmbed).requestId, r.requestId);
}
assert.equal(US_CHANNELS.length, 10);
assert.equal(new Set(US_CHANNELS).size, 10);
assert.match(JSON.stringify(signalCard(record())), /과열/);
assert.match(JSON.stringify(signalCard(record("정석 진입", "BUY", { grade: "OFF" }))), /판단 없음/);
assert.match(JSON.stringify(signalCard(record("하락 모멘텀 종료", "CHECK"))), /새 매수 신호가 아닙니다/);
assert(!signalCard(record("상승 모멘텀 종료", "SELL")).fields.some(f => /목표|손절/.test(f.value)));
const snapshot = JSON.stringify(sepaSnapshot(record()));
assert.match(snapshot, /종합 등급 미산정/); assert.match(snapshot, /0점이 아닙니다/);
const secretRecord = { ...record(), positionPreview: { accountNumber: "PRIVATE_SENTINEL" }, risk: { reason: "PRIVATE_SENTINEL" } };
assert(!sepaResearchPrompt(secretRecord).includes("PRIVATE_SENTINEL"));
assert(!JSON.stringify(signalCard(secretRecord)).includes("PRIVATE_SENTINEL"));
assert(shouldReviewSignal(record()));
const r = record(), day = record("돌파 진입", "BUY", { timeframe: "D" });
const other = record("정석 진입", "BUY", { ticker: "OTHER" });
const rows = [r, { ...r }, day, other, { ...r, receivedAt: "2020-01-01T00:00:00Z" }, { ...r, outcome: { duplicate: true } }, record("정석 진입", "BUY", { exchange: "TSE" }), record("정석 진입", "BUY", { paper_order_test: true }), { ...r, validation: { ok: false } }];
assert.equal(recentSignals(rows, now).length, 3);
assert.match(digestCards(rows, "D", now)[0].description, /수신 신호 1건/);
assert.match(digestCards(rows, "240", now)[0].description, /수신 신호 2건/);
assert.match(digestCards([], "240", now)[0].description, /신호가 없습니다/);
const delayed = { ...record("VCP 형성", "CHECK", { bar_time: now - 28800000 }), receivedAt: new Date(now + 1).toISOString() };
assert.match(digestCards([r, delayed], "240", now + 1)[0].title, /17:00:00/);
const lots = Array.from({ length: 120 }, (_, i) => record("정석 진입", "BUY", { ticker: `T${i}` }));
const cards = digestCards(lots, "240", now);
assert.match(cards[0].description, /120건/);
assert(cards.filter(c => c.title.startsWith("진입")).length > 1);
for (let i = 0; i < 120; i++) assert(cards.some(c => c.description?.includes(`(T${i})`)));
for (const card of [...cards, signalCard(record("x".repeat(9000), "BUY", { desc: "x".repeat(9000), ai_summary: "x".repeat(9000), signal: "x".repeat(9000) }))]) {
  assert(card.title.length <= 256);
  assert((card.description || "").length <= 4096);
  assert((card.fields || []).every(f => f.value.length <= 1024));
  const total = [card.title, card.description, card.footer?.text, ...(card.fields || []).flatMap(f => [f.name, f.value])].filter(Boolean).join("").length;
  assert(total <= 6000);
}
const mixed = SIGNAL_MARKETS.map(m => record("정석 진입", "BUY", { exchange: m.exchanges[0], timeframe: "D" }));
for (const market of SIGNAL_MARKETS) {
  const entry = mixed.find(r => signalMarket(r).id === market.id);
  const formatted = formatWebhookRecord(entry);
  assert.equal(formatted.targetCategory, market.category);
  assert.equal(formatted.targetChannel, `${market.prefix}-진입`);
  assert.equal(formatted.embed.author, undefined);
  assert.match(JSON.stringify(formatted.embed), market.id === "US" ? /\$100/ : new RegExp(`100${market.currency}`));
  assert.match(JSON.stringify(sepaSnapshot(entry)), market.id === "US" ? /\$100/ : new RegExp(`100${market.currency}`));
  assert(sepaResearchPrompt(entry).startsWith(`${market.label} 주식`));
  assert.equal(recentSignals(mixed, now, market).length, 1);
  assert(digestCards(mixed, "D", now, market)[0].footer.text.startsWith(market.label));
  assert.match(digestCards(mixed, "D", now, market)[0].description, /수신 신호 1건/);
  const channel = { name: marketChannelName(market, "진입"), parent: { name: market.category }, isTextBased: () => true };
  assert(matchesSignalChannel(channel, channel.name, market.category));
  assert(!matchesSignalChannel(channel, channel.name, "잘못된 카테고리"));
  assert.equal(shouldReviewSignal(entry), true);
  if (market.transport) assert.equal(decodeSignalEmbed(formatted.transportEmbed).requestId, entry.requestId);
  else {
    assert.equal(formatted.transportEmbed, undefined);
    assert.deepEqual(formatted.targetChannels, ["일본-진입"]);
    for (const schema_ver of [undefined, "5.0"]) for (const side of ["BUY", "SELL"]) {
      const r = { ...entry, payload: { ...entry.payload, action: side, schema_ver }, outcome: { decision: side === "BUY" ? "ENTRY_CANDIDATE" : "EXIT_CANDIDATE" } };
      r.risk = new TradeController({ initialMode: "PAPER_AUTO", accountNeutral: true }).evaluate(r);
      assert.equal(r.risk.verdict, "BLOCKED_EXCHANGE");
      assert.equal(formatWebhookRecord(r).channel, "signal");
      assert.equal(formatWebhookRecord(r).transportEmbed, undefined);
    }
  }
}
assert.equal(new Set(SIGNAL_MARKETS.flatMap(m => US_CHANNELS.map(n => marketChannelName(m, n)))).size, 30);
const boundary = Date.parse("2026-09-21T00:30:00Z");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[0]), "2026-09-20");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[1]), "2026-09-21");
assert.equal(marketDate(boundary, SIGNAL_MARKETS[2]), "2026-09-21");
assert.equal(formatWebhookRecord(record("정석 진입", "BUY", { exchange: "UNKNOWN" })).channel, "system");
console.log("signal-cards test OK: 3 markets, prefixed routing, currency, dates, transport isolation, recent reports, pagination, privacy");
