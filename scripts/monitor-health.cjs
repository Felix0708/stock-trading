"use strict";

// Runs on GitHub, never loads account credentials and never calls an order endpoint.
const marker = "<!-- stock-trading-external-health -->";
async function probe(url, fetcher = fetch) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.pathname !== "/health" || target.search || target.username || target.password) throw Error();
    const response = await fetcher(target, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "ngrok-skip-browser-warning": "monitor" } });
    const body = await response.json();
    return response.status === 200 && body.ok === true;
  } catch { return false; }
}

async function monitor(env = process.env, fetcher = fetch) {
  for (const key of ["MONITOR_HEALTH_URL", "MONITOR_DISCORD_WEBHOOK", "GITHUB_TOKEN", "GITHUB_REPOSITORY"]) if (!env[key]) throw Error(`Missing ${key}`);
  const hook = new URL(env.MONITOR_DISCORD_WEBHOOK);
  if (hook.origin !== "https://discord.com" || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(hook.pathname)) throw Error("Invalid monitor notification endpoint");
  async function notify(content) {
    const response = await fetcher(`${hook.origin}${hook.pathname}?wait=true`, { method: "POST", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
    if (!response.ok) throw Error(`Monitor notification HTTP ${response.status}`);
  }
  if (env.MONITOR_NOTIFY_TEST === "true") {
    await notify("🧪 GitHub 외부 감시 알림 전달 테스트입니다. 실제 장애가 아닙니다. 서버 상태를 5분 간격으로 점검하고 장애·복구 때만 알립니다. 예약 실행은 지연될 수 있으며 주문은 실행하지 않습니다.");
    console.log("Monitor test notification delivered"); return;
  }
  async function github(endpoint, method = "GET", body) {
    const response = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${endpoint}`, {
      method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error(`GitHub monitor state HTTP ${response.status}`);
    return response.json();
  }
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await github(`/issues?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw Error("Invalid monitor state response");
    issues.push(...rows);
    if (rows.length < 100) break;
    if (page === 10) throw Error("Monitor state pagination limit");
  }
  const incident = issues.find(row => !row.pull_request && row.user?.login === "github-actions[bot]" && row.body?.startsWith(marker));
  const healthy = await probe(env.MONITOR_HEALTH_URL, fetcher);
  if (healthy && !incident) { console.log("External health: OK"); return; }
  let issue = incident;
  if (!healthy && !issue) issue = await github("/issues", "POST", { title: "운영 서버 외부 상태 점검 실패", body: `${marker}\n서버·터널·Discord 또는 주문 실행기 상태 점검에 실패했습니다. 계좌 정보는 수집하지 않습니다.\n알림: 대기` });
  if (healthy || !issue.body?.includes("알림: 전송 완료")) {
    const content = healthy ? "✅ 외부 상태 점검: 서버와 주문 실행기 연결이 복구됐습니다."
      : "🚨 외부 상태 점검 실패: Mac·인터넷·터널·신호 서버·주문 실행기 연결을 확인해 주세요. 이 감시는 주문을 실행하거나 손절을 대신하지 않습니다.";
    await notify(content);
    await github(`/issues/${issue.number}`, "PATCH", { ...(healthy ? { state: "closed", state_reason: "completed" } : {}), body: `${marker}\n상태: ${healthy ? "복구" : "점검 실패"}\n알림: 전송 완료\n확인: ${new Date().toISOString()}` });
  }
  console.log(healthy ? "External health: recovered" : "External health: incident open");
}

if (require.main === module) monitor().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { probe, monitor, marker };
