"use strict";

const fs = require("node:fs");
const { Client, GatewayIntentBits } = require("discord.js");
const { parseBuyApprovalCommand } = require("./buy-approval");
const { decodeSignalEnvelope } = require("./discord-signal-envelope");
const { KiwoomClient } = require("./kiwoom-client");
const { KisClient } = require("./kis-client");
const { OrderTracker } = require("./order-tracker");
const { submitPaperOrder, trackPaperOrder } = require("./paper-order-executor");
const { calculateWebhookPositionPreview, inferPositionProfitable } = require("./position-sizer");
const { formatBrokerStartup, formatOrderStatus } = require("./webhook-discord");

function shouldConsumeMessage(message, config) {
  return message?.author?.bot === true
    && config.sourceChannelIds.has(message.channelId)
    && config.sourceBotIds.has(message.author.id);
}

class SignalReceiptStore {
  constructor(file) {
    this.file = file;
    this.state = file && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { requestIds: [], messageIds: [], pending: {} };
    this.state.pending ||= {};
  }

  claim(requestId, messageId) {
    if (!requestId || !messageId || this.state.requestIds.includes(requestId) || this.state.messageIds.includes(messageId)) return false;
    this.state.requestIds.push(requestId);
    this.state.messageIds.push(messageId);
    this.write();
    return true;
  }

  putPending(record, messageId, ttlMs) {
    const key = `${record.payload.exchange}:${record.payload.ticker}`;
    this.state.pending[key] = { key, record, messageId, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
    this.write();
    return this.state.pending[key];
  }

  findPending({ ticker = "", messageId = "", now = Date.now() } = {}) {
    const rows = Object.values(this.state.pending)
      .filter((item) => item.expiresAt > now)
      .filter((item) => !ticker || item.record.payload.ticker === ticker)
      .filter((item) => !messageId || item.messageId === messageId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return rows.length === 1 ? rows[0] : null;
  }

  removePending(key) {
    delete this.state.pending[key];
    this.write();
  }

  write() {
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function csv(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function enabledBrokerIds(env = process.env) {
  const enabled = env.ACCOUNT_EXECUTOR_ENABLED === "true" || env.KIS_CONSUMER_ENABLED === "true";
  if (!enabled) return [];
  return [env.EXECUTOR_KIWOOM_ENABLED === "true" ? "KIWOOM" : "", env.EXECUTOR_KIS_ENABLED !== "false" ? "KIS" : ""].filter(Boolean);
}

function accountCommand(content, executorName = "") {
  const text = String(content || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["!account", "!account help", "!계좌", "!계좌 도움말"].includes(text)) return "HELP";
  if (["!account status", "!계좌 상태", "주문 실행기 상태 보여줘", "주문 실행기 상태 확인"].includes(text)) return "STATUS";
  if (["!account orders", "!계좌 주문"].includes(text)) return "ORDERS";

  const compact = text.replace(/\s+/g, "");
  const match = compact.match(/^(.+?)?계좌(명령어|도움말|상태|최근주문|주문내역)(?:보여줘|알려줘|확인)?$/);
  if (!match) return "";
  const requestedName = match[1] || "";
  const ownName = String(executorName || "").toLowerCase().replace(/\s+/g, "").replace(/계좌$/, "");
  if (requestedName && !["내", "현재"].includes(requestedName) && ownName && requestedName !== ownName) return "";
  if (["명령어", "도움말"].includes(match[2])) return "HELP";
  if (match[2] === "상태") return "STATUS";
  if (["최근주문", "주문내역"].includes(match[2])) return "ORDERS";
  return "";
}

function accountNumber(value) {
  const match = String(value || "").match(/^(\d{8})(?:-(\d{2}))?$/);
  if (!match) throw new Error("KIS_ACCOUNT_NO는 12345678-01 형식이어야 합니다.");
  return { accountNo: match[1], productCode: match[2] || process.env.KIS_ACCOUNT_PRODUCT_CODE || "01" };
}

function signalExchange(exchange) {
  const value = String(exchange || "").toUpperCase();
  if (["KRX", "KOSPI", "KOSDAQ"].includes(value)) return "KRX";
  if (["NASDAQ", "NASD", "ND"].includes(value)) return "ND";
  if (["NYSE", "NY"].includes(value)) return "NY";
  if (["AMEX", "ARCA", "NYSEARCA", "NA"].includes(value)) return "NA";
  throw new Error(`지원하지 않는 거래소: ${exchange || "없음"}`);
}

async function accountContext(clients, record, maxOpenPositions) {
  const domesticClient = clients.domesticClient || clients;
  const overseasClient = clients.overseasClient || clients;
  const domestic = await domesticClient.getDomesticBalance();
  const usBalances = overseasClient.getUsBalances
    ? await overseasClient.getUsBalances()
    : [await overseasClient.getUsBalance()];
  const usHoldings = [...new Map(usBalances.flatMap((balance) => balance.holdings).map((holding) => [holding.code, holding])).values()];
  const market = signalExchange(record.payload.exchange);
  const holdings = market === "KRX" ? domestic.holdings : usHoldings;
  const current = holdings.filter((holding) => holding.code === record.payload.ticker);
  const cash = market === "KRX"
    ? (await domesticClient.getDomesticCash({ symbol: record.payload.ticker, price: record.payload.price })).orderableAmount
    : (await overseasClient.getUsCash({ exchange: market, symbol: record.payload.ticker, price: record.payload.price })).usd;
  const evaluation = holdings.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  const equity = market === "KRX" ? domestic.estimatedAssets || domestic.totalEvaluation : cash + evaluation;
  return {
    equity, availableCash: cash, currency: market === "KRX" ? "KRW" : "USD",
    openPositions: domestic.holdings.length + usHoldings.length,
    maxOpenPositions,
    currentPositionValue: current.reduce((sum, holding) => sum + holding.evaluationAmount, 0),
    currentPositionQuantity: current.reduce((sum, holding) => sum + holding.quantity, 0),
    hasExistingPosition: current.length > 0,
    positionProfitable: inferPositionProfitable(current, null, record.payload.price),
    domesticHoldings: domestic.holdings,
    usHoldings,
  };
}

function enforceOwnAccountRules(record, account, preview) {
  if (!["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict)) return preview;
  if (record.risk.verdict === "PAPER_ENTRY" && account.hasExistingPosition) {
    return { ...preview, blocked: true, quantity: 0, reason: "해당 계좌에 이미 보유 중 — 중복 진입 차단" };
  }
  if (record.risk.verdict === "PAPER_ADD" && (!account.hasExistingPosition || account.positionProfitable !== true)) {
    return { ...preview, blocked: true, quantity: 0, reason: "해당 계좌에 수익 중인 기존 포지션이 없어 추가매수 차단" };
  }
  return preview;
}

function holdingLines(account) {
  const rows = [
    ...account.domesticHoldings.map((item) => `${item.name || item.code} (${item.code}) · ${item.quantity}주`),
    ...account.usHoldings.map((item) => `${item.name || item.code} (${item.code}) · ${item.quantity}주`),
  ];
  return rows.length ? rows.join("\n") : "보유 종목 없음";
}

function approvalText(record, previews) {
  const lines = Object.values(previews).map(({ label, preview }) => preview.blocked
    ? `**${label}**: 불가 · ${preview.reason}`
    : `**${label}**: ${preview.quantity}주 · 예상 ${preview.currency === "KRW" ? `${Math.round(preview.positionValue).toLocaleString("ko-KR")}원` : `$${preview.positionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}`);
  return [
    "⏳ **BUY 승인 대기**",
    `**종목**: ${record.payload.name} (${record.payload.ticker})`,
    ...lines,
    "`사줘`·`둘다` / `키움만` / `한투만` / `안 사`",
  ].join("\n");
}

async function start() {
  const brokerIds = enabledBrokerIds();
  if (!brokerIds.length) throw new Error("ACCOUNT_EXECUTOR_ENABLED=true와 사용할 증권사 설정이 필요합니다.");
  if (brokerIds.includes("KIS") && (process.env.KIS_ENV || "mock") !== "mock") throw new Error("한투 실행기는 모의투자만 허용합니다.");
  if (brokerIds.includes("KIWOOM") && (process.env.KIWOOM_ENV || "mock") !== "mock") throw new Error("키움 실행기는 모의투자만 허용합니다.");
  const sourceChannelIds = csv(process.env.ACCOUNT_SOURCE_CHANNEL_IDS || process.env.KIS_SOURCE_CHANNEL_IDS);
  const sourceBotIds = csv(process.env.ACCOUNT_SOURCE_BOT_IDS || process.env.KIS_SOURCE_BOT_IDS);
  if (!sourceChannelIds.size || !sourceBotIds.size) throw new Error("신뢰할 Discord 원본 채널 ID와 봇 ID가 필요합니다.");
  const executorName = process.env.ACCOUNT_EXECUTOR_NAME || "기본 사용자";
  const accountLabel = executorName.endsWith("계좌") ? executorName : `${executorName} 계좌`;
  const receipts = new SignalReceiptStore(process.env.ACCOUNT_SIGNAL_RECEIPT_FILE || process.env.KIS_SIGNAL_RECEIPT_FILE || "account-signal-receipts.json");
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const trusted = { sourceChannelIds, sourceBotIds };
  const targetGuildId = process.env.ACCOUNT_TARGET_GUILD_ID || process.env.KIS_TARGET_GUILD_ID;
  const channels = {
    order: process.env.ACCOUNT_ORDER_CHANNEL || process.env.KIS_ORDER_CHANNEL,
    execution: process.env.ACCOUNT_EXECUTION_CHANNEL || process.env.KIS_EXECUTION_CHANNEL,
    journal: process.env.ACCOUNT_JOURNAL_CHANNEL || process.env.KIS_JOURNAL_CHANNEL,
    portfolio: process.env.ACCOUNT_PORTFOLIO_CHANNEL || process.env.KIS_PORTFOLIO_CHANNEL,
    system: process.env.ACCOUNT_SYSTEM_CHANNEL || process.env.KIS_SYSTEM_CHANNEL,
  };
  const maxAgeMs = Number(process.env.KIS_SIGNAL_MAX_AGE_MINUTES || 30) * 60_000;
  const maxOpenPositions = Number(process.env.MAX_OPEN_POSITIONS || 5);
  const ownerId = process.env.EXECUTOR_OWNER_ID || process.env.DISCORD_OWNER_ID;
  if (!ownerId) throw new Error("EXECUTOR_OWNER_ID 또는 DISCORD_OWNER_ID가 필요합니다.");
  const approvalTtlMs = Number(process.env.BUY_APPROVAL_TTL_MINUTES || 30) * 60_000;
  const brokers = [];
  if (brokerIds.includes("KIWOOM")) {
    brokers.push({
      id: "KIWOOM", label: "키움",
      domesticClient: new KiwoomClient({ appKey: process.env.KIWOOM_DOMESTIC_APP_KEY, secretKey: process.env.KIWOOM_DOMESTIC_SECRET_KEY, environment: "mock", timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      overseasClient: new KiwoomClient({ appKey: process.env.KIWOOM_OVERSEAS_APP_KEY, secretKey: process.env.KIWOOM_OVERSEAS_SECRET_KEY, environment: "mock", timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      tracker: new OrderTracker(process.env.KIWOOM_ORDER_STATE_FILE || "kiwoom-orders.json"),
    });
  }
  if (brokerIds.includes("KIS")) {
    const account = accountNumber(process.env.KIS_ACCOUNT_NO);
    const kis = new KisClient({
      appKey: process.env.KOREA_INVESTMENT_APP_KEY,
      appSecret: process.env.KOREA_INVESTMENT_APP_SECRET,
      ...account,
      environment: process.env.KIS_ENV || "mock",
      timeoutMs: Number(process.env.KIS_TIMEOUT_MS || 5_000),
    });
    brokers.push({ id: "KIS", label: "한투", domesticClient: kis, overseasClient: kis, tracker: new OrderTracker(process.env.KIS_ORDER_STATE_FILE || "kis-orders.json") });
  }
  let queue = Promise.resolve();

  async function targetChannel(configured) {
    const guild = await client.guilds.fetch(targetGuildId);
    const available = await guild.channels.fetch();
    const channel = available.get(configured) || available.find((item) => item?.name === configured);
    if (!channel?.isTextBased()) throw new Error(`Discord 기록 채널을 찾을 수 없습니다: ${configured || "미설정"}`);
    return channel;
  }

  async function send(channelName, message) {
    const channel = await targetChannel(channelName);
    await channel.send(message.embed ? { content: message.text, embeds: [message.embed] } : { content: message.text || String(message) });
  }

  async function previewFor(broker, record) {
    const ownAccount = await accountContext(broker, record, maxOpenPositions);
    const preview = enforceOwnAccountRules(record, ownAccount, calculateWebhookPositionPreview(record, ownAccount));
    return { label: broker.label, preview };
  }

  async function execute(broker, record) {
    record.positionPreview = (await previewFor(broker, record)).preview;
    const order = await submitPaperOrder(record, {
      enabled: true, environment: "mock",
      domesticClient: broker.domesticClient, overseasClient: broker.overseasClient,
      tracker: broker.tracker, brokerLabel: `${broker.label} 모의계좌`,
      partialExit1Ratio: Number(process.env.PARTIAL_EXIT_1_RATIO || 0.25),
      partialExit2Ratio: Number(process.env.PARTIAL_EXIT_2_RATIO || 0.5),
    });
    if (!order || order.status === "BLOCKED") {
      await send(channels.order, { text: `🛑 **${broker.label} 모의주문 차단**\n**종목**: ${record.payload.name} (${record.payload.ticker})\n**사유**: ${order?.reason || record.positionPreview?.reason || "주문 조건 불충족"}` });
      return null;
    }
    await send(channels.order, formatOrderStatus(order));
    const final = await trackPaperOrder(order, { domesticClient: broker.domesticClient, overseasClient: broker.overseasClient, tracker: broker.tracker, attempts: 5, delayMs: 2_000 });
    if (final.status !== order.status || final.filledQuantity !== order.filledQuantity) await send(channels.execution, formatOrderStatus(final));
    if (["FILLED", "PARTIALLY_FILLED"].includes(final.status)) {
      await send(channels.journal, { text: `📘 **${broker.label} 모의매매 기록**\n${final.side} · ${final.name || final.symbol} (${final.symbol}) · ${final.filledQuantity}주 @ ${final.fillPrice || "확인 중"}` });
      await send(channels.portfolio, { text: `📚 **${broker.label} 모의 포트폴리오**\n${holdingLines(await accountContext(broker, record, maxOpenPositions))}` });
    }
    return final;
  }

  async function processApproval(message) {
    if (message.author.bot || message.author.id !== ownerId) return false;
    const approvalChannel = channels.order;
    if (message.channelId !== approvalChannel && message.channel?.name !== approvalChannel) return false;
    const command = parseBuyApprovalCommand(message.content);
    if (!command.matched) return false;
    if (command.ambiguous) {
      await message.reply("계좌 선택이 애매합니다. `둘다`, `키움만`, `한투만`, `안 사` 중 하나로 말해 주세요.");
      return true;
    }
    const pending = receipts.findPending({ ticker: command.ticker, messageId: message.reference?.messageId || "" })
      || (!command.ticker && !message.reference?.messageId ? receipts.findPending() : null);
    if (!pending) {
      await message.reply("승인할 BUY가 하나로 특정되지 않습니다. 승인 대기 메시지에 답장하거나 종목코드를 함께 적어 주세요.");
      return true;
    }
    if (command.action === "CANCEL") {
      receipts.removePending(pending.key);
      await message.reply(`취소했습니다: ${pending.record.payload.name} (${pending.record.payload.ticker})`);
      return true;
    }
    const selected = brokers.filter((broker) => command.brokers.includes(broker.id));
    if (!selected.length) {
      await message.reply("선택한 증권사 실행기가 연결되어 있지 않습니다.");
      return true;
    }
    receipts.removePending(pending.key);
    for (const broker of selected) {
      try {
        await execute(broker, structuredClone(pending.record));
      } catch (error) {
        await send(channels.system, { text: `🛑 **${broker.label} 승인 주문 실패**\n${error.message}` });
      }
    }
    return true;
  }

  async function processMessage(message) {
    if (!shouldConsumeMessage(message, trusted)) return;
    const footer = message.embeds?.[0]?.footer?.text;
    const record = decodeSignalEnvelope(footer);
    if (!record) return;
    if (Date.now() - new Date(record.receivedAt).getTime() > maxAgeMs) return;
    if (!receipts.claim(record.requestId, message.id)) return;

    try {
      record.source = "DISCORD_SIGNAL";
      const entry = ["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict) && record.payload.action === "BUY";
      if (entry) {
        const previews = Object.fromEntries(await Promise.all(brokers.map(async (broker) => [broker.id, await previewFor(broker, structuredClone(record))])));
        const channel = await targetChannel(channels.order);
        const approval = await channel.send(approvalText(record, previews));
        receipts.putPending(record, approval.id, approvalTtlMs);
        return;
      }
      for (const broker of brokers) {
        try {
          await execute(broker, structuredClone(record));
        } catch (error) {
          await send(channels.system, { text: `🛑 **${broker.label} 자동 청산 실패**\n${error.message}` });
        }
      }
    } catch (error) {
      await send(channels.system, { text: `🛑 **${accountLabel} 주문 실행기 처리 실패**\n${error.message}\n\`request_id: ${record.requestId}\`` });
    }
  }

  async function processOwnerCommand(message) {
    if (message.author.bot || message.author.id !== ownerId) return false;
    if (![channels.system, channels.order].includes(message.channelId) && ![channels.system, channels.order].includes(message.channel?.name)) return false;
    const command = accountCommand(message.content, executorName);
    if (!command) return false;
    if (command === "HELP") {
      await message.reply(["🧾 **계좌 주문 실행기 명령어**", "`계좌 상태 보여줘`", "`계좌 최근 주문 보여줘`", "BUY 승인: `사줘`·`둘다` / `키움만` / `한투만` / `안 사`"].join("\n"));
    } else if (command === "STATUS") {
      await message.reply([`🧭 **${accountLabel} 주문 실행기 상태**`, `증권사: ${brokers.map((broker) => `${broker.label} 모의`).join(" + ")}`, `신뢰 채널: ${sourceChannelIds.size}개`, "BUY: 사용자 승인 후 주문", "SELL: 신호 수신 시 자동 처리", "실계좌: 🔒 차단"].join("\n"));
    } else {
      const orders = brokers.flatMap((broker) => broker.tracker.list().slice(0, 5).map((order) => `${broker.label} · ${order.name || order.symbol} (${order.symbol}) · ${order.side} · ${order.status}`)).slice(0, 10);
      await message.reply(["📋 **계좌별 최근 모의주문**", ...(orders.length ? orders : ["저장된 주문 없음"])].join("\n"));
    }
    return true;
  }

  client.on("messageCreate", (message) => {
    queue = queue.then(async () => {
      if (await processOwnerCommand(message)) return;
      if (await processApproval(message)) return;
      await processMessage(message);
    }).catch((error) => console.error(error));
  });
  client.once("clientReady", async () => {
    console.log([
      `\n✅ ${accountLabel} 주문 실행기 준비 완료`,
      `Discord: ${client.user.tag}`,
      `계좌: ${brokers.map((broker) => `${broker.label} 모의`).join(" + ")} · 실계좌 주문 차단`,
      `수신: 매매신호 채널 ${sourceChannelIds.size}개`,
      "처리: 공통 신호 → 계좌별 수량 계산 → BUY 승인 → 모의주문",
    ].join("\n"));
    await send(channels.system, { text: formatBrokerStartup(
      `${accountLabel} 주문 실행기`,
      client.user.tag,
      `${brokers.map((broker) => `${broker.label} 모의`).join(" + ")} · 신뢰 채널 ${sourceChannelIds.size}개 · BUY 승인 후 계좌별 주문`,
    ) });
    for (const channelId of sourceChannelIds) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;
      const recent = [...(await channel.messages.fetch({ limit: 50 })).values()].reverse();
      for (const message of recent) queue = queue.then(() => processMessage(message));
    }
  });
  await client.login(process.env.ACCOUNT_DISCORD_TOKEN || process.env.KIS_DISCORD_TOKEN || process.env.DISCORD_TOKEN_DRUCKENMILLER);
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { SignalReceiptStore, accountCommand, accountContext, enabledBrokerIds, enforceOwnAccountRules, shouldConsumeMessage, signalExchange, start };
