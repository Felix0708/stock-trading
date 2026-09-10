"use strict";

// Exit, never continue an interrupted order operation after an uncaught error.
function networkFailure(error) {
  if (!error || typeof error !== "object") return false;
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(error.code)) return true;
  if (error.message === "Opening handshake has timed out" && /[/\\]ws[/\\]lib[/\\]websocket\.js/.test(error.stack || "")) return true;
  return error.cause ? networkFailure(error.cause)
    : Array.isArray(error.errors) && error.errors.length > 0 && error.errors.every(networkFailure);
}

function fatal(error) {
  const retry = networkFailure(error);
  console.error(`[${new Date().toISOString()}] ${retry ? "네트워크 연결 실패 · 현재 작업을 종료하고 같은 터미널에서 재연결합니다." : "실행 오류 · 자동 재시작하지 않습니다."}`);
  console.error(String(error?.stack || error).replace(/https?:\/\/\S+/g, "<url>"));
  process.exit(retry ? 75 : 1);
}

if (process.env.STOCK_TRADING_SUPERVISED === "1") process.on("uncaughtException", fatal);
module.exports = { networkFailure, fatal };
