"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { validateWebhookPayload, normalizeWebhookPayload } = require("../src/signals/webhook-schema");
const { BLOCK_FIELDS, entryReferencePrice } = require("../src/signals/nested-webhook");
const { SignalStateMachine } = require("../src/signals/signal-state-machine");
const { TradeController } = require("../src/trading/trade-controller");
const { calculateWebhookPositionPreview, effectiveStopPrice } = require("../src/trading/position-sizer");
const { encodeSignalEnvelope, decodeSignalEnvelope } = require("../src/discord/discord-signal-envelope");
const { formatWebhookRecord } = require("../src/discord/webhook-discord");
const { createWebhookService } = require("../src/signals/webhook-server");

// Synthetic values only. No vendor example or account data in this check.
function fixture() {
  const p: any = { schema_ver: "5.0", bar_time: 1789000000000 };
  for (const [block, groups] of Object.entries(BLOCK_FIELDS)) {
    p[block] = {};
    for (const [type, names] of Object.entries(groups)) for (const key of (names as string).split(" ")) {
      p[block][key] = type === "string" ? "test" : type === "boolean" ? false : type === "nullable" ? null : 1;
    }
  }
  Object.assign(p.symbol, { ticker: "TEST", exchange: "NASDAQ", tf: "240", htf: "D", market: "display only" });
  Object.assign(p.signal, { action: "BUY", type: "💰 정석 진입", price: 100, sl: 95, grade: "GO", conviction: "B", trigger_price: 99 });
  Object.assign(p.market, { htf_trend: "BULL", htf_align: "정배열", htf_above200: true, htf_volume: "NEUTRAL" });
  Object.assign(p.stock, { energy: 2, energy_limit: 8, sb_z: 1 });
  p.setup.stage = "NONE"; p.setup.signals_n = 0; p.setup.signals = "Sigma:과열";
  p.momentum.status = "없음";
  return p;
}
const wire = fixture(), valid = validateWebhookPayload(wire);
assert.equal(valid.ok, true, JSON.stringify(valid.errors));
assert.equal(Object.values(BLOCK_FIELDS).reduce((n, groups) => n + Object.values(groups).reduce((m: number, names: string) => m + names.split(" ").length, 0), 2), 92);
for (const field of ["tf", "ticker", "htf"]) for (const value of [null, false, 123, ""]) {
  const bad = structuredClone(wire); bad.symbol[field] = value;
  assert.equal(validateWebhookPayload(bad).ok, false);
}
for (const block of Object.keys(BLOCK_FIELDS)) {
  const bad = structuredClone(wire); delete bad[block]; assert.equal(validateWebhookPayload(bad).ok, false);
}
assert.equal(validateWebhookPayload({ ...wire, schema_ver: "6.0" }).ok, false);
assert.equal(validateWebhookPayload({ ...wire, bar_time: "1789000000000" }).ok, false);
const p = normalizeWebhookPayload(wire);
assert.equal(p.timeframe, "240"); assert.equal(p.market, "display only");
assert.equal(p.daily_trend, undefined); assert.equal(p.rsi2, undefined);
assert.equal(p.signals_n, 0); assert.equal(p.momentum, "없음");
assert.deepEqual(normalizeWebhookPayload(p), p);
const now = new Date("2026-09-20T12:00:00Z");
const machine = new SignalStateMachine();
const outcome = machine.handle(p, now);
assert.equal(outcome.decision, "ENTRY_CANDIDATE");
assert.equal(machine.handle({ ...p, price: 102 }, new Date(+now + 10000)).duplicate, true);
const restarted = new SignalStateMachine(machine.snapshot());
assert.equal(restarted.handle(p, new Date(+now + 86400000)).duplicate, true);
assert.equal(restarted.handle({ ...p, timeframe: "D", htf: "W" }, new Date(+now + 11000)).duplicate, false);
assert.equal(restarted.handle({ ...p, exchange: "NYSE" }, new Date(+now + 11000)).duplicate, false);
assert.equal(restarted.handle({ ...p, type: "진입 확정", action: "CHECK" }, new Date(+now + 12000)).decision, "KEEP_IF_FILLED");
for (const type of ["눌림 진입", "PEG Pullback", "PEG Rebreak"]) assert.equal(new SignalStateMachine().handle({ ...p, type }, now).decision, "INFO_ONLY");
assert.equal(new SignalStateMachine().handle({ ...p, action: "CHECK", type: "눌림 만료" }, now).decision, "INFO_ONLY");
const controller = new TradeController({ accountNeutral: true, initialMode: "PAPER_AUTO" });
const account = { equity: 100000, availableCash: 100000, currentPositionValue: 0, openPositions: 0, maxOpenPositions: 5 };
const record = { requestId: "synthetic-nested", receivedAt: now.toISOString(), payload: p, validation: valid, outcome, risk: {} as any };
record.risk = controller.evaluate(record);
assert.equal(record.risk.verdict, "PAPER_ENTRY");
const go = calculateWebhookPositionPreview(record, account);
const half = calculateWebhookPositionPreview({ ...record, payload: { ...p, grade: "HALF" } }, account);
assert.equal(half.quantity, Math.floor(go.quantity / 2));
assert.equal(half.executionScale, 0.5);
for (const grade of ["WAIT", "NO", "OFF", undefined]) {
  const r = { ...record, payload: { ...p, grade } };
  assert.equal(controller.evaluate(r).verdict, "BLOCKED_EXECUTION_GRADE");
  assert.equal(calculateWebhookPositionPreview(r, account).blocked, true);
}
assert.equal(controller.evaluate({ ...record, payload: { ...p, exchange: "" } }).verdict, "BLOCKED_EXCHANGE");
assert.equal(controller.evaluate({ ...record, payload: { ...p, timeframe: "15" } }).verdict, "BLOCKED_TIMEFRAME");
const sell = { ...record, payload: { ...p, action: "SELL", type: "최종 청산", grade: "NO", indicator_position: { held: false } }, outcome: { decision: "EXIT_CANDIDATE" } };
assert.equal(controller.evaluate(sell).verdict, "PAPER_EXIT");
assert.equal(controller.status().openCount, 0);
assert.equal(calculateWebhookPositionPreview({ ...record, payload: { ...p, atr_multiple: 9, atr_dot: false } }, account).blocked, true);
assert.equal(calculateWebhookPositionPreview({ ...record, payload: { ...p, atr_multiple: 9, atr_dot_threshold: 12 } }, account).blocked, false);
const transported = decodeSignalEnvelope(encodeSignalEnvelope(record));
assert.equal(transported.payload.grade, "GO"); assert.equal(transported.payload.htf, "D");
assert.equal(transported.payload.trigger_price, 99); assert.equal(transported.payload.bar_time, wire.bar_time);
assert.equal(transported.payload.indicator_position, undefined);
assert.equal(calculateWebhookPositionPreview(transported, account).quantity, go.quantity);
assert.equal(entryReferencePrice(record), 99);
assert.equal(entryReferencePrice({ ...record, outcome: { decision: "ADD_CANDIDATE" } }), 100);
assert.equal(effectiveStopPrice({ ...record, payload: { ...p, momentum_sl: 94 }, outcome: { signal: { signalCode: "MOMENTUM_BUY" } } }), 94);
const daily = { ...record, payload: { ...p, timeframe: "D", htf: "W" } };
assert(formatWebhookRecord(daily).embed.fields.some(f => f.name === "상위봉" && f.value.includes("주봉")));
assert.equal(normalizeWebhookPayload({ ...wire, symbol: { ...wire.symbol, exchange: "KOSDAQ", ticker: "123456" } }).exchange, "KRX");

async function roundtrip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-webhook-test-")), logFile = path.join(dir, "events.jsonl");
  const records = [], token = "synthetic-test-token-only";
  let service = createWebhookService({ token, logFile, onProcessed: r => records.push(r) });
  try {
    let address = await service.listen(0);
    let url = `http://127.0.0.1:${address.port}${service.webhookPath}`;
    assert.equal((await fetch(url, { method: "POST", body: '{"symbol":{"name":"broken"quote"}}' })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(wire) })).status, 200);
    await service.queue.whenIdle();
    assert.equal(records.at(-1).payload.ticker, "TEST");
    assert.equal(records.at(-1).outcome.decision, "ENTRY_CANDIDATE");
    await service.close();
    service = createWebhookService({ token, logFile, onProcessed: r => records.push(r) });
    address = await service.listen(0); url = `http://127.0.0.1:${address.port}${service.webhookPath}`;
    await fetch(url, { method: "POST", body: JSON.stringify({ ...wire, signal: { ...wire.signal, price: 101 } }) });
    await service.queue.whenIdle();
    assert.equal(records.at(-1).outcome.duplicate, true);
    const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "../docs/webhook.example.json"), "utf8"));
    await fetch(url, { method: "POST", body: JSON.stringify(legacy) });
    await service.queue.whenIdle();
    assert.equal(records.at(-1).validation.ok, true);
    assert.equal(records.at(-1).payload.schema_ver, undefined);
  } finally { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
roundtrip().then(() => console.log("nested-webhook migration checks OK")).catch(e => { console.error(e); process.exitCode = 1; });
