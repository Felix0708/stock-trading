"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

// This parent owns the launcher's single-instance lock and stays in the same iTerm.
function runService(args, retryDelays = [5000, 15000, 30000, 60000]) {
  let child, timer, stopping = false, failures = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
    if (child) child.kill(signal);
    else process.exit(0);
  });
  function start() {
    const started = Date.now();
    child = spawn(process.execPath, ["--require", path.join(__dirname, "network-failure.cjs"), ...args], {
      stdio: "inherit", env: { ...process.env, STOCK_TRADING_SUPERVISED: "1" },
    });
    child.on("error", error => { console.error("실행 시작 실패:", error.message); });
    child.on("close", (code, signal) => {
      child = null;
      if (stopping || signal || code !== 75) { process.exitCode = stopping ? 0 : code || (signal ? 1 : 0); return; }
      if (Date.now() - started > 300000) failures = 0;
      const ms = retryDelays[Math.min(failures++, retryDelays.length - 1)];
      console.error(`[${new Date().toISOString()}] 연결 재시도 ${ms / 1000}초 후 · Ctrl+C로 종료`);
      timer = setTimeout(start, ms);
    });
  }
  start();
}

if (require.main === module) runService(process.argv.slice(2));
module.exports = { runService };
