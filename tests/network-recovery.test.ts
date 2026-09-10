"use strict";
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { networkFailure } = require("../scripts/network-failure.cjs");

async function main() {
  assert.equal(networkFailure(Object.assign(new Error("DNS"), { code: "ENOTFOUND" })), true);
  assert.equal(networkFailure(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), true);
  assert.equal(networkFailure(new Error("invalid config")), false);
  assert.equal(networkFailure(new Error("Opening handshake has timed out")), false);
  const wsError = new Error("Opening handshake has timed out");
  wsError.stack += "\n at /node_modules/ws/lib/websocket.js:890:7";
  assert.equal(networkFailure(wsError), true);
  const guard = path.resolve(__dirname, "../scripts/network-failure.cjs");
  for (const [message, code, expected] of [["DNS", "ENOTFOUND", 75], ["bad config", "INVALID", 1]]) {
    const result = spawnSync(process.execPath, ["--require", guard, "-e", `throw Object.assign(new Error(${JSON.stringify(message)}), {code:${JSON.stringify(code)}})`], {
      env: { ...process.env, STOCK_TRADING_SUPERVISED: "1" }, encoding: "utf8",
    });
    assert.equal(result.status, expected);
  }
  const runner = path.resolve(__dirname, "../scripts/run-service.cjs");
  const stop = spawnSync(process.execPath, [runner, "-e", "process.exit(1)"], { timeout: 3000 });
  assert.equal(stop.status, 1, "programming error must not restart");
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(runner)}).runService(['-e', 'process.exit(75)'], [20])`], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "", stopped = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.stderr.on("data", data => {
    text += data;
    if (!stopped && text.split("연결 재시도").length >= 3) { stopped = true; child.kill("SIGINT"); }
  });
  const exitCode = await new Promise(resolve => child.on("close", resolve));
  clearTimeout(timer);
  assert.equal(exitCode, 0, "manual stop must stop supervisor, including backoff");
  assert.equal(stopped, true, "network failure must restart");
  console.log("network recovery test OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
