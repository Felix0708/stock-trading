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

  const queue = createAsyncQueue(async (event) => {
    const validation = validateWebhookPayload(event.payload);
    const outcome = validation.ok
      ? stateMachine.handle(event.payload, event.receivedAt)
      : {
          decision: "REJECTED_INVALID",
          duplicate: false,
          orderCreated: false,
          warnings: validation.errors,
        };
    const record = { ...event, validation, outcome };
    if (logFile) await fs.promises.appendFile(logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      await onProcessed(record);
      if (logFile) await fs.promises.appendFile(`${logFile}.delivered`, `${record.requestId}\n`, { mode: 0o600 });
    } catch (error) {
      if (logFile) await fs.promises.appendFile(`${logFile}.failed`, `${JSON.stringify({
        requestId: record.requestId,
        failedAt: new Date().toISOString(),
        error: error.message,
      })}\n`, { mode: 0o600 });
      throw error;
    }
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, queue_size: queue.size, role: "signal_server" });
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
      queue.enqueue({ requestId, receivedAt, payload });
      sendJson(response, 200, { ok: true, queued: true, request_id: requestId });
    });
  });

  return {
    queue,
    server,
    stateMachine,
    webhookPath,
    listen(port = 8787, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
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
