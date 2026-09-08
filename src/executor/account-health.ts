"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function writeAccountHealth(receiptFile, status, directory = ".runtime", now = Date.now()) {
  if (!receiptFile) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = crypto.createHash("sha256").update(path.resolve(receiptFile)).digest("hex").slice(0, 16);
  const file = path.join(directory, `executor-${id}.health.json`);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ updatedAt: now, ...status }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readAccountHealth(directory = ".runtime", now = Date.now()) {
  if (!fs.existsSync(directory)) return { registered: 0, healthy: true };
  const files = fs.readdirSync(directory).filter(file => /^executor-[a-f0-9]{16}\.health\.json$/.test(file));
  const healthy = files.every(file => {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      return Number.isFinite(state.updatedAt) && now >= state.updatedAt && now - state.updatedAt <= 45_000
        && state.discordReady === true && state.initialized === true && state.uncertainOrders === false
        && state.brokerQueriesHealthy !== false
        && Number.isFinite(state.workerAt) && now >= state.workerAt && now - state.workerAt <= 180_000;
    } catch { return false; }
  });
  // Public health reveals no account names, balances, paths, tokens or order identifiers.
  return { registered: files.length, healthy };
}

module.exports = { writeAccountHealth, readAccountHealth };
