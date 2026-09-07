"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { SignalStateMachine } = require("./signal-state-machine");
const { validateWebhookPayload } = require("./webhook-schema");

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadOrCreateWebhookToken(tokenFile = path.resolve(".webhook-token")) {
  const configured = (process.env.WEBHOOK_PATH_TOKEN || "").trim();
  if (configured) {
    if (configured.length < 16) throw new Error("WEBHOOK_PATH_TOKEN은 16자 이상이어야 합니다.");
    return configured;
  }
  if (fs.existsSync(tokenFile)) {
    const saved = fs.readFileSync(tokenFile, "utf8").trim();
    if (saved.length < 16) throw new Error(".webhook-token 파일의 값이 너무 짧습니다.");
    return saved;
  }
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, `${generated}\n`, { mode: 0o600, flag: "wx" });
  return generated;
}

function createAsyncQueue(processor) {
  const items = [];
  const idleWaiters = [];
  let running = false;

  async function drain() {
    while (items.length) {
      const item = items.shift();
      try {
        await processor(item);
      } catch (error) {
        console.error("웹훅 백그라운드 처리 실패:", error);
      }
    }
    running = false;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  return {
    enqueue(item) {
      items.push(item);
      if (!running) {
        running = true;
        setImmediate(drain);
      }
    },
    whenIdle() {
      if (!running && !items.length) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get size() {
      return items.length;
    },
  };
}

function createWebhookService(options: any = {}) {
  const token = options.token || "";
  if (token.length < 16) throw new Error("WEBHOOK_PATH_TOKEN은 16자 이상이어야 합니다.");

  const maxBodyBytes = options.maxBodyBytes || 64 * 1024;
  const stateMachine = options.stateMachine || new SignalStateMachine();
  const logFile = options.logFile || null;
  const onProcessed = options.onProcessed || (() => {});
  const webhookPath = `/webhook/${encodeURIComponent(token)}`;
  const inboxDirectory = logFile ? `${logFile}.pending` : null;
  const processed = new Map();
  const logged = new Set();
  const delivered = new Set();
  const queued = new Set();
  const failures = new Set();
  const expired = new Set();
  let storageFailed = false;
  const interruptedAppends = new Set();
  let retryTimer;
  function syncDirectory(directory) {
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function appendDurably(file, value) {
    if (interruptedAppends.has(file)) { committedLines(file); interruptedAppends.delete(file); }
    const fd = fs.openSync(file, "a", 0o600);
    try { fs.writeFileSync(fd, `${value}\n`); fs.fsyncSync(fd); }
    catch (error) { interruptedAppends.add(file); throw error; }
    finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
  }
  function committedLines(file) {
    if (!fs.existsSync(file)) return [];
    const data = fs.readFileSync(file);
    const end = data.lastIndexOf(10) + 1;
    if (end < data.length) {
      // Power loss may interrupt an append. Keep its exact bytes before removing only the incomplete tail.
      const backup = `${file}.incomplete-${crypto.randomUUID()}`;
      const saved = fs.openSync(backup, "wx", 0o600);
      try { fs.writeFileSync(saved, data.subarray(end)); fs.fsyncSync(saved); } finally { fs.closeSync(saved); }
      syncDirectory(path.dirname(file));
      const fd = fs.openSync(file, "r+");
      try { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      console.error("웹훅 로그의 미완성 마지막 행을 별도 보관하고 수신 원본에서 복구합니다.");
    }
    return data.subarray(0, end).toString("utf8").split(/\r?\n/).filter(Boolean);
  }
  function saveIntake(event) {
    if (!inboxDirectory) return;
    const file = path.join(inboxDirectory, `${event.requestId}.json`);
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(event)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    syncDirectory(inboxDirectory);
  }
  function removeIntake(requestId) {
    if (!inboxDirectory || !/^[a-zA-Z0-9-]+$/.test(requestId)) return;
    const file = path.join(inboxDirectory, `${requestId}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); syncDirectory(inboxDirectory); }
  }
  if (logFile && fs.existsSync(logFile)) {
    for (const line of committedLines(logFile)) {
      const record = JSON.parse(line);
      if (processed.has(record.requestId)) continue;
      processed.set(record.requestId, record);
      logged.add(record.requestId);
    }
  }
  if (logFile) {
    for (const id of committedLines(`${logFile}.delivered`)) delivered.add(id);
    for (const id of committedLines(`${logFile}.expired`)) expired.add(id);
  }
  if (inboxDirectory) {
    fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
    syncDirectory(path.dirname(inboxDirectory));
  }
  function intakeEvents() {
    if (!inboxDirectory) return [];
    return fs.readdirSync(inboxDirectory).filter(file => /^[a-zA-Z0-9-]+\.json$/.test(file)).map(file => {
      const event = JSON.parse(fs.readFileSync(path.join(inboxDirectory, file), "utf8"));
      if (file !== `${event.requestId}.json` || !Number.isFinite(Date.parse(event.receivedAt))) throw new Error("웹훅 수신 원본 대조 필요");
      return event;
    });
  }
  const history = new Map(processed);
  for (const event of intakeEvents()) if (!history.has(event.requestId)) history.set(event.requestId, event);
  for (const record of [...history.values() as Iterable<any>].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) {
    // Replay pure indicator state chronologically, including intake saved before a failed result-log write.
    const validation = record.validation || validateWebhookPayload(record.payload);
    const outcome = validation.ok ? stateMachine.handle(record.payload, record.receivedAt)
      : { decision: "REJECTED_INVALID", duplicate: false, orderCreated: false, warnings: validation.errors };
    if (!processed.has(record.requestId)) processed.set(record.requestId, { ...record, validation, outcome });
  }

  const queue = createAsyncQueue(async (event) => {
    try {
      if (delivered.has(event.requestId)) { removeIntake(event.requestId); failures.delete(event.requestId); return; }
      let record: any = processed.get(event.requestId);
      if (!record) {
        const validation = validateWebhookPayload(event.payload);
        const outcome = validation.ok ? stateMachine.handle(event.payload, event.receivedAt)
          : { decision: "REJECTED_INVALID", duplicate: false, orderCreated: false, warnings: validation.errors };
        record = { requestId: event.requestId, receivedAt: event.receivedAt, payload: event.payload, validation, outcome };
        // Keep the computed outcome even if disk I/O fails; never mutate the indicator twice on retry.
        processed.set(event.requestId, record);
      }
      if (!logged.has(record.requestId)) {
        if (logFile) appendDurably(logFile, JSON.stringify(record));
        logged.add(record.requestId);
      }
      await onProcessed(record, { recovered: event.recovered === true });
      if (logFile) appendDurably(`${logFile}.delivered`, record.requestId);
      delivered.add(record.requestId);
      failures.delete(record.requestId);
      removeIntake(record.requestId);
    } catch (error) {
      failures.add(event.requestId);
      if (logFile) await fs.promises.appendFile(`${logFile}.failed`, `${JSON.stringify({
        requestId: event.requestId,
        failedAt: new Date().toISOString(),
        error: error.message,
      })}\n`, { mode: 0o600 });
      throw error;
    } finally { queued.delete(event.requestId); }
  });
  function enqueue(event) {
    if (queued.has(event.requestId)) return;
    queued.add(event.requestId);
    queue.enqueue(event);
  }
  function recover() {
    if (!inboxDirectory) return;
    const pending = new Map();
    for (const record of processed.values() as Iterable<any>) {
      if (!delivered.has(record.requestId) && !expired.has(record.requestId)) pending.set(record.requestId, record);
    }
    for (const event of intakeEvents()) {
      if (delivered.has(event.requestId) || expired.has(event.requestId)) { removeIntake(event.requestId); failures.delete(event.requestId); }
      else pending.set(event.requestId, event);
    }
    for (const event of [...pending.values() as Iterable<any>].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))) {
      if (queued.has(event.requestId)) continue;
      if (Date.now() - Date.parse(event.receivedAt) > (options.recoveryMaxAgeMs ?? 24 * 60 * 60_000)) {
        appendDurably(`${logFile}.expired`, event.requestId);
        expired.add(event.requestId);
        failures.delete(event.requestId);
        removeIntake(event.requestId);
        continue;
      }
      enqueue({ ...event, recovered: true });
    }
  }

  const server = http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url, "http://localhost"); }
    catch {
      sendJson(response, 400, { ok: false, error: "invalid_url" });
      request.resume();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      let healthy = true;
      try { healthy = !storageFailed && failures.size === 0 && (options.healthCheck ? options.healthCheck() === true : true); } catch { healthy = false; }
      sendJson(response, healthy ? 200 : 503, { ok: healthy, queue_size: queue.size, role: "signal_server" });
      return;
    }
    if (request.method !== "POST" || !secureEqual(url.pathname, webhookPath)) {
      sendJson(response, 404, { ok: false });
      request.resume();
      return;
    }

    const declaredLength = Number(request.headers["content-length"] || 0);
    if (declaredLength > maxBodyBytes) {
      sendJson(response, 413, { ok: false, error: "payload_too_large" });
      request.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        if (!response.headersSent) sendJson(response, 413, { ok: false, error: "payload_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid_json" });
        return;
      }

      const requestId = crypto.randomUUID();
      const receivedAt = new Date().toISOString();
      const event = { requestId, receivedAt, payload };
      try { saveIntake(event); storageFailed = false; } catch (error) {
        storageFailed = true;
        console.error("웹훅 수신 원본 저장 실패:", error.message);
        sendJson(response, 503, { ok: false, error: "intake_storage_unavailable" });
        return;
      }
      enqueue(event);
      sendJson(response, 200, { ok: true, queued: true, request_id: requestId });
    });
  });

  return {
    queue,
    server,
    stateMachine,
    webhookPath,
    recover,
    listen(port = 8787, host = "127.0.0.1") {
      recover();
      retryTimer = setInterval(() => { try { recover(); } catch (error) { storageFailed = true; console.error("웹훅 복구 실패:", error.message); } }, 30_000);
      retryTimer.unref();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      clearInterval(retryTimer);
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function main() {
  const token = loadOrCreateWebhookToken();
  const port = Number(process.env.WEBHOOK_PORT || 8787);
  const host = process.env.WEBHOOK_HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WEBHOOK_PORT가 올바르지 않습니다.");

  const service = createWebhookService({
    token,
    logFile: path.resolve(process.env.WEBHOOK_LOG_FILE || "webhook-events.jsonl"),
  });
  await service.listen(port, host);
  console.log(`주문 차단 웹훅 수신기 실행: http://${host}:${port}/webhook/<secret>`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {
  createAsyncQueue,
  createWebhookService,
  loadOrCreateWebhookToken,
};
