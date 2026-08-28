"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function assertSecondStartIsSkipped(script, lockName) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stock-trading-start-"));
  const envFile = path.join(directory, "empty.env");
  fs.writeFileSync(envFile, "\n");
  const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const lock = spawnSync("/usr/bin/shlock", ["-f", path.join(directory, lockName), "-p", String(running.pid)]);
    assert.equal(lock.status, 0, `${script} test could not acquire its fixture lock`);
    const result = spawnSync("sh", [script, envFile], { cwd: __dirname, encoding: "utf8", env: { ...process.env, TMPDIR: directory } });
    assert.equal(result.status, 0, `${script} did not skip an already-running instance: ${result.stderr}`);
    assert.match(result.stdout, /이미 실행 중/);
  } finally {
    running.kill();
    fs.rmSync(directory, { recursive: true });
  }
}

(async () => {
  await assertSecondStartIsSkipped("start-signal.sh", "stock-trading-signal.lock");
  await assertSecondStartIsSkipped("start-executor.sh", "stock-trading-executor.lock");
  console.log("start single-instance test OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
