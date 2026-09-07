"use strict";
const { spawnSync } = require("node:child_process");
const { probe } = require("./monitor-health.cjs");
async function setup() {
  const channelId = process.argv[2], repo = process.argv[3];
  if (!/^\d{16,22}$/.test(channelId || "") || !/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw Error("채널 ID와 소유 저장소를 지정하세요.");
  const token = process.env.DISCORD_TOKEN_DRUCKENMILLER;
  if (!token || !process.env.NGROK_PUBLIC_URL) throw Error("로컬 신호 서버 설정이 필요합니다.");
  const healthUrl = new URL("/health", process.env.NGROK_PUBLIC_URL).href;
  if (!await probe(healthUrl)) throw Error("현재 외부 상태 점검 실패 · 알림 연결 전에 서버를 확인하세요.");
  async function discord(route, method = "GET", body) {
    const response = await fetch(`https://discord.com/api/v10${route}`, { method, signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`Discord 설정 HTTP ${response.status}: ${route}`);
    return response.json();
  }
  const me = await discord("/users/@me"), channel = await discord(`/channels/${channelId}`);
  if (channel.type !== 0) throw Error("텍스트 상태 채널이 아닙니다.");
  const hooks = await discord(`/channels/${channelId}/webhooks`);
  const name = "Stock-Trading external health";
  const hook = hooks.find(h => h.name === name && h.user?.id === me.id && h.token)
    || await discord(`/channels/${channelId}/webhooks`, "POST", { name });
  if (!hook.token) throw Error("알림 전용 자격정보를 만들지 못했습니다.");
  for (const [name, value] of Object.entries({ MONITOR_HEALTH_URL: healthUrl, MONITOR_DISCORD_WEBHOOK: `https://discord.com/api/webhooks/${hook.id}/${hook.token}` })) {
    const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], { input: value, encoding: "utf8" });
    if (result.status !== 0) throw Error(`GitHub ${name} 저장 실패 (비밀값은 출력하지 않음)`);
    console.log(`${name}: configured`);
  }
  const response = await fetch(`https://discord.com/api/webhooks/${hook.id}/${hook.token}?wait=true`, { method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "🧪 외부 감시 알림 연결 테스트입니다. GitHub가 서버 /health를 점검하고 장애·복구 때만 알립니다. 예약 실행은 지연될 수 있으며 주문은 실행하지 않습니다.", allowed_mentions: { parse: [] } }) });
  if (!response.ok) throw Error(`알림 전달 테스트 HTTP ${response.status}`);
  const delivered = await response.json();
  console.log(`Notification delivered: ${delivered.id}; channel: ${channel.name}`);
}
setup().catch(error => { console.error(error.message); process.exitCode = 1; });
