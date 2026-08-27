"use strict";

const fs = require("node:fs");
const { Client, GatewayIntentBits } = require("discord.js");
const { syncAccountPortfolio } = require("./account-portfolio");
const { parseBuyApprovalCommand } = require("./buy-approval");
const { decodeSignalEmbed } = require("./discord-signal-envelope");
const { KiwoomClient } = require("./kiwoom-client");
const { KisClient } = require("./kis-client");
const { enrichInstrumentNames, formatInstrumentLabel } = require("./instrument-names");
const { OrderTracker } = require("./order-tracker");
const {
  domesticSession,
  domesticSessionClock,
  partialExitStage,
  refreshPaperOrder,
  shouldDeferEntry,
  shouldDelayEntry,
  submitPaperOrder,
  trackPaperOrder,
  usSession,
  usSessionClock,
} = require("./paper-order-executor");
const { calculateWebhookPositionPreview, inferPositionProfitable } = require("./position-sizer");
const { formatBrokerStartup, formatDeferredBuy, formatExecutorError, formatOrderStatus, formatTradeJournal, formatUncreatedOrder } = require("./order-discord");

function shouldConsumeMessage(message, config) {
  return message?.author?.bot === true
    && config.sourceChannelIds.has(message.channelId)
    && config.sourceBotIds.has(message.author.id);
}

class SignalReceiptStore {
  constructor(file, defaultAutoTrading = false) {
    this.file = file;
    this.state = file && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { requestIds: [], messageIds: [], pending: {} };
    this.state.pending ||= {};
    this.state.deferred ||= {};
    this.state.partialExits ||= {};
    this.state.autoTrading ??= defaultAutoTrading;
  }

  claim(requestId, messageId) {
    if (!requestId || !messageId || this.state.requestIds.includes(requestId) || this.state.messageIds.includes(messageId)) return false;
    this.state.requestIds.push(requestId);
    this.state.messageIds.push(messageId);
    this.write();
    return true;
  }

  putPending(record, messageId, ttlMs, brokerIds) {
    const key = `${record.payload.exchange}:${record.payload.ticker}`;
    this.state.pending[key] = { key, record, messageId, brokerIds, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
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

  putDeferred(brokerId, record, ttlMs) {
    const key = `${brokerId}:${record.requestId}`;
    this.state.deferred[key] = {
      key, brokerId, record, queuedAt: Date.now(), expiresAt: Date.now() + ttlMs, lastAttemptMarketDate: "",
    };
    this.write();
    return this.state.deferred[key];
  }

  listDeferred() {
    return Object.values(this.state.deferred);
  }

  markDeferredAttempt(key, marketDate) {
    if (!this.state.deferred[key]) return;
    this.state.deferred[key].lastAttemptMarketDate = marketDate;
    this.write();
  }

  markDeferredFailure(key, error) {
    if (!this.state.deferred[key]) return;
    this.state.deferred[key].lastError = String(error?.message || error);
    this.state.deferred[key].lastFailedAt = new Date().toISOString();
    this.write();
  }

  removeDeferred(key) {
    delete this.state.deferred[key];
    this.write();
  }

  partialExitKey(brokerId, market, symbol, stage) {
    return [brokerId, market, symbol, stage].map((value) => String(value || "").toUpperCase()).join(":");
  }

  partialExitBlocked(brokerId, record) {
    const stage = partialExitStage(record);
    if (!stage) return false;
    return Boolean(this.state.partialExits[this.partialExitKey(brokerId, record.payload.exchange, record.payload.ticker, stage)]);
  }

  reservePartialExit(brokerId, order) {
    if (!order.partialExitStage) return;
    const key = this.partialExitKey(brokerId, order.market, order.symbol, order.partialExitStage);
    this.state.partialExits[key] = { status: "PENDING", orderNo: order.orderNo };
    this.write();
  }

  reconcileTradeStage(brokerId, order) {
    if (order.fullExit && order.status === "FILLED") {
      this.resetPartialExits(brokerId, order.market, order.symbol);
      return;
    }
    if (!order.partialExitStage) return;
    const key = this.partialExitKey(brokerId, order.market, order.symbol, order.partialExitStage);
    if (Number(order.filledQuantity || 0) > 0) this.state.partialExits[key] = { status: "EXECUTED", orderNo: order.orderNo };
    else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(order.status)) delete this.state.partialExits[key];
    else return;
    this.write();
  }

  resetPartialExits(brokerId, market, symbol) {
    const prefix = this.partialExitKey(brokerId, market, symbol, "");
    for (const key of Object.keys(this.state.partialExits)) {
      if (key.startsWith(prefix)) delete this.state.partialExits[key];
    }
    this.write();
  }

  autoTrading() {
    return this.state.autoTrading === true;
  }

  setAutoTrading(enabled) {
    this.state.autoTrading = enabled;
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

function brokerEnvironments(brokerIds, env = process.env) {
  const environments = Object.fromEntries(brokerIds.map((id) => [id, env[`${id}_ENV`] || "mock"]));
  if (Object.values(environments).some((environment) => !["mock", "live"].includes(environment))) throw new Error("계좌 환경은 mock 또는 live여야 합니다.");
  if (Object.values(environments).includes("live") && env.ACCOUNT_LIVE_TRADING !== "true") throw new Error("실계좌는 ACCOUNT_LIVE_TRADING=true로 명시적으로 잠금을 해제해야 합니다.");
  return environments;
}

function accountPortfolioSyncMinutes(env = process.env) {
  const minutes = Number(env.ACCOUNT_PORTFOLIO_SYNC_MINUTES || 1440);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("ACCOUNT_PORTFOLIO_SYNC_MINUTES는 1~1440 범위여야 합니다.");
  return minutes;
}

function discordMessagePayload(message) {
  return message.embed ? { embeds: [message.embed] } : { content: message.text || String(message) };
}

function orderNeedsResultReport(order) {
  if (order.source !== "USER_SCHEDULED_EXIT" || order.executorReportable !== true || order.status === "ACCEPTED") return false;
  return order.executionReportedStatus !== order.status
    || (order.status === "FILLED" && order.journalReportedStatus !== order.status);
}

function orderNeedsPortfolioSync(order) {
  return ["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(order.status)
    && Number(order.filledQuantity || 0) > Number(order.portfolioSyncedFilledQuantity || 0);
}

function errorReportDue(previousAt, now = Date.now(), cooldownMs = 30 * 60_000) {
  return !Number.isFinite(previousAt) || now - previousAt >= cooldownMs;
}

function liveAutoBuyEligible(record) {
  const payload = record?.payload || {};
  return payload.action === "BUY"
    && ["A", "S"].includes(payload.conviction)
    && payload.daily_trend === "BULL"
    && payload.daily_ema_aligned === true
    && payload.daily_above_200ma === true;
}

function buyApprovalRequiredForBroker(broker, record, autoTrading) {
  if (!autoTrading) return true;
  return broker.environment === "live" && !liveAutoBuyEligible(record);
}

function accountCommand(content, executorName = "") {
  const text = String(content || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["!account", "!account help", "!계좌", "!계좌 도움말"].includes(text)) return "HELP";
  if (["!account status", "!계좌 상태", "주문 실행기 상태 보여줘", "주문 실행기 상태 확인"].includes(text)) return "STATUS";
  if (["!account orders", "!계좌 주문"].includes(text)) return "ORDERS";
  const bangAuto = text.match(/^!(?:account|계좌)\s+(?:auto|자동매매)\s+(on|off|status|켜|꺼|상태)$/);
  if (bangAuto) {
    if (["on", "켜"].includes(bangAuto[1])) return "AUTO_ON";
    if (["off", "꺼"].includes(bangAuto[1])) return "AUTO_OFF";
    return "AUTO_STATUS";
  }

  const compact = text.replace(/\s+/g, "");
  const auto = compact.match(/^(.+?)?자동매매(켜|켜줘|시작|시작해|꺼|꺼줘|중지|중지해|상태)(?:보여줘|알려줘|확인)?$/);
  if (auto) {
    const requestedName = auto[1] || "";
    const ownName = String(executorName || "").toLowerCase().replace(/\s+/g, "").replace(/계좌$/, "");
    if (requestedName && !["내", "현재"].includes(requestedName) && ownName && requestedName !== ownName) return "";
    if (["켜", "켜줘", "시작", "시작해"].includes(auto[2])) return "AUTO_ON";
    if (["꺼", "꺼줘", "중지", "중지해"].includes(auto[2])) return "AUTO_OFF";
    return "AUTO_STATUS";
  }
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
  const currentPositionValue = current.reduce((sum, holding) => sum + holding.evaluationAmount, 0);
  return {
    equity, availableCash: cash, currency: market === "KRX" ? "KRW" : "USD",
    openPositions: domestic.holdings.length + usHoldings.length,
    maxOpenPositions,
    currentPositionValue,
    accountPositionRatio: equity > 0 ? currentPositionValue / equity * 100 : 0,
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

async function reconcilePendingBrokerOrders(broker) {
  const changes = [];
  for (const previous of broker.tracker.pending()) {
    const current = await refreshPaperOrder(previous, broker);
    if (["status", "filledQuantity", "remainingQuantity", "fillPrice"].some((key) => current[key] !== previous[key])) {
      changes.push({ previous, current });
    }
  }
  return changes;
}

async function holdingLines(account) {
  const rows = await enrichInstrumentNames([
    ...account.domesticHoldings.map((item) => ({ ...item, exchange: "KRX", ticker: item.code })),
    ...account.usHoldings.map((item) => ({ ...item, exchange: item.exchange, ticker: item.code })),
  ]);
  return rows.length
    ? rows.map((item) => `${formatInstrumentLabel(item)} · ${item.quantity}주`).join("\n")
    : "보유 종목 없음";
}

function approvalText(record, previews, brokerIds = Object.keys(previews)) {
  const lines = Object.values(previews).map(({ label, preview }) => preview.blocked
    ? `**${label}**: 불가 · ${preview.reason}`
    : `**${label}**: ${preview.quantity}주 · 예상 ${preview.currency === "KRW" ? `${Math.round(preview.positionValue).toLocaleString("ko-KR")}원` : `$${preview.positionValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} · 주문 후 계좌 비중 ${preview.projectedPositionRatio.toFixed(2)}% / 최대 ${preview.positionLimitRatio * 100}%`);
  const commands = brokerIds.length === 2
    ? "`사줘`·`둘다` / `키움만` / `한투만` / `안 사`"
    : `${brokerIds[0] === "KIWOOM" ? "`키움만`" : "`한투만`"} / \`안 사\``;
  return [
    "⏳ **BUY 승인 대기**",
    `**종목**: ${formatInstrumentLabel(record.payload)}`,
    ...lines,
    commands,
  ].join("\n");
}

async function start() {
  const brokerIds = enabledBrokerIds();
  if (!brokerIds.length) throw new Error("ACCOUNT_EXECUTOR_ENABLED=true와 사용할 증권사 설정이 필요합니다.");
  const environments = brokerEnvironments(brokerIds);
  const sourceChannelIds = csv(process.env.ACCOUNT_SOURCE_CHANNEL_IDS || process.env.KIS_SOURCE_CHANNEL_IDS);
  const sourceBotIds = csv(process.env.ACCOUNT_SOURCE_BOT_IDS || process.env.KIS_SOURCE_BOT_IDS);
  if (!sourceChannelIds.size || !sourceBotIds.size) throw new Error("신뢰할 Discord 원본 채널 ID와 봇 ID가 필요합니다.");
  const executorName = process.env.ACCOUNT_EXECUTOR_NAME || "기본 사용자";
  const accountLabel = executorName.endsWith("계좌") ? executorName : `${executorName} 계좌`;
  const receipts = new SignalReceiptStore(
    process.env.ACCOUNT_SIGNAL_RECEIPT_FILE || process.env.KIS_SIGNAL_RECEIPT_FILE || "account-signal-receipts.json",
    process.env.ACCOUNT_AUTO_TRADING === "true",
  );
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
  const deferredTtlMs = 5 * 24 * 60 * 60_000;
  const portfolioSyncMinutes = accountPortfolioSyncMinutes();
  const brokers = [];
  const errorReports = new Map();
  if (brokerIds.includes("KIWOOM")) {
    brokers.push({
      id: "KIWOOM", label: "키움", environment: environments.KIWOOM,
      domesticClient: new KiwoomClient({ appKey: process.env.KIWOOM_DOMESTIC_APP_KEY, secretKey: process.env.KIWOOM_DOMESTIC_SECRET_KEY, environment: environments.KIWOOM, timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      overseasClient: new KiwoomClient({ appKey: process.env.KIWOOM_OVERSEAS_APP_KEY, secretKey: process.env.KIWOOM_OVERSEAS_SECRET_KEY, environment: environments.KIWOOM, timeoutMs: Number(process.env.KIWOOM_TIMEOUT_MS || 5_000) }),
      tracker: new OrderTracker(process.env.KIWOOM_ORDER_STATE_FILE || "kiwoom-orders.json"),
    });
  }
  if (brokerIds.includes("KIS")) {
    const account = accountNumber(process.env.KIS_ACCOUNT_NO);
    const kis = new KisClient({
      appKey: process.env.KOREA_INVESTMENT_APP_KEY,
      appSecret: process.env.KOREA_INVESTMENT_APP_SECRET,
      ...account,
      environment: environments.KIS,
      timeoutMs: Number(process.env.KIS_TIMEOUT_MS || 5_000),
    });
    brokers.push({ id: "KIS", label: "한투", environment: environments.KIS, domesticClient: kis, overseasClient: kis, tracker: new OrderTracker(process.env.KIS_ORDER_STATE_FILE || "kis-orders.json") });
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
    return channel.send(discordMessagePayload(message));
  }

  const brokerAccountLabel = (broker) => `${broker.label} ${broker.environment === "live" ? "실계좌" : "모의계좌"}`;
  const accountSummary = () => brokers.map(brokerAccountLabel).join(" + ");

  async function reportError(title, error, record) {
    const reportKey = [title, error?.message || error, record?.payload?.ticker || record?.symbol || ""].join("\n");
    if (!errorReportDue(errorReports.get(reportKey))) return;
    try {
      await send(channels.system, formatExecutorError(title, error, record));
      errorReports.set(reportKey, Date.now());
    } catch (reportingError) {
      console.error(`${title}: ${error.message}; Discord 오류: ${reportingError.message}`);
    }
  }

  async function syncPortfolio() {
    return syncAccountPortfolio(await targetChannel(channels.portfolio), brokers);
  }

  async function previewFor(broker, record) {
    const ownAccount = await accountContext(broker, record, maxOpenPositions);
    const preview = enforceOwnAccountRules(record, ownAccount, calculateWebhookPositionPreview(record, ownAccount));
    return { label: broker.label, preview };
  }

  async function withPortfolioMetrics(broker, order) {
    const account = await accountContext(broker, { payload: {
      exchange: order.market, ticker: order.symbol, price: order.fillPrice || order.signalPrice,
    } }, maxOpenPositions);
    return broker.tracker.record({
      ...order,
      accountEquity: account.equity,
      positionValueAfterFill: account.currentPositionValue,
      positionRatio: account.accountPositionRatio,
      currency: account.currency,
    });
  }

  async function reportOrderResult(broker, order) {
    let reported = { ...order, resultAt: order.resultAt || order.updatedAt };
    receipts.reconcileTradeStage(broker.id, reported);
    if (reported.executionReportedStatus !== reported.status) {
      await send(channels.execution, formatOrderStatus(reported));
      reported = broker.tracker.record({ ...reported, executionReportedStatus: reported.status });
    }
    if (reported.status === "FILLED" && reported.journalReportedStatus !== reported.status) {
      await send(channels.journal, formatTradeJournal(reported));
      reported = broker.tracker.record({ ...reported, journalReportedStatus: reported.status });
    }
    return reported;
  }

  async function execute(broker, record) {
    record.positionPreview = (await previewFor(broker, record)).preview;
    if (record.payload?.paper_order_test === true) {
      await send(channels.order, { text: `✅ **${brokerAccountLabel(broker)} 자동매매 연동 테스트 통과**\n**종목**: ${formatInstrumentLabel(record.payload)}\n계좌 조회 정상 · 주문 생성 없음` });
      return null;
    }
    const stage = partialExitStage(record);
    if (stage && receipts.partialExitBlocked(broker.id, record)) {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "부분청산 중복 차단",
        reason: `${stage}은 현재 포지션에서 이미 실행 또는 주문 대기 중`,
      }));
      return null;
    }
    let order = await submitPaperOrder(record, {
      enabled: true, environment: broker.environment,
      domesticClient: broker.domesticClient, overseasClient: broker.overseasClient,
      tracker: broker.tracker, brokerLabel: brokerAccountLabel(broker),
      partialExit1Ratio: Number(process.env.PARTIAL_EXIT_1_RATIO || 0.25),
      partialExit2Ratio: Number(process.env.PARTIAL_EXIT_2_RATIO || 0.5),
    });
    if (!order || order.status === "BLOCKED") {
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 차단",
        reason: order?.reason || record.positionPreview?.reason || "주문 조건 불충족",
      }));
      return null;
    }
    if (order.entryType === "PAPER_ENTRY") receipts.resetPartialExits(broker.id, order.market, order.symbol);
    if (order.partialExitStage) receipts.reservePartialExit(broker.id, order);
    const statusMessage = await send(channels.order, formatOrderStatus(order));
    order = broker.tracker.record({ ...order, statusMessageId: statusMessage.id });
    let final = await trackPaperOrder(order, { domesticClient: broker.domesticClient, overseasClient: broker.overseasClient, tracker: broker.tracker, attempts: 5, delayMs: 2_000 });
    receipts.reconcileTradeStage(broker.id, final);
    if (final.status !== order.status || final.filledQuantity !== order.filledQuantity) {
      if (final.filledQuantity > order.filledQuantity) {
        final = await withPortfolioMetrics(broker, final).catch(async (error) => {
          await reportError(`${broker.label} 체결 비중 조회 실패`, error, record);
          return final;
        });
      }
      final = await reportOrderResult(broker, final);
    }
    if (orderNeedsPortfolioSync(final)) {
      try {
        await syncPortfolio();
        final = broker.tracker.record({ ...final, portfolioSyncedFilledQuantity: final.filledQuantity });
      } catch (error) {
        await reportError("포트폴리오 주문 후 갱신 실패", error);
      }
    }
    return final;
  }

  async function reconcileOrders() {
    let portfolioChanged = false;
    for (const broker of brokers) {
      let changes;
      try {
        changes = await reconcilePendingBrokerOrders(broker);
      } catch (error) {
        await reportError(`${broker.label} 미완료 주문 체결 조회 실패`, error);
        continue;
      }
      for (const { previous, current } of changes) {
        let reported = current;
        if (current.filledQuantity > previous.filledQuantity) {
          try {
            reported = await withPortfolioMetrics(broker, current);
          } catch (error) {
            await reportError(`${broker.label} 체결 비중 조회 실패`, error, { payload: current });
          }
        }
        reported = await reportOrderResult(broker, reported);
        if (orderNeedsPortfolioSync(reported)) portfolioChanged = true;
      }
      for (const order of broker.tracker.list().filter(orderNeedsResultReport)) {
        let reported = order;
        if (order.filledQuantity > 0 && !Number.isFinite(order.positionRatio)) {
          reported = await withPortfolioMetrics(broker, order).catch(async (error) => {
            await reportError(`${broker.label} 체결 비중 조회 실패`, error, { payload: order });
            return order;
          });
        }
        reported = await reportOrderResult(broker, reported);
        if (orderNeedsPortfolioSync(reported)) portfolioChanged = true;
      }
      if (broker.tracker.list().some(orderNeedsPortfolioSync)) portfolioChanged = true;
    }
    if (portfolioChanged) {
      try {
        await syncPortfolio();
        for (const broker of brokers) {
          for (const order of broker.tracker.list().filter(orderNeedsPortfolioSync)) {
            broker.tracker.record({ ...order, portfolioSyncedFilledQuantity: order.filledQuantity });
          }
        }
      } catch (error) {
        await reportError("포트폴리오 체결 후 갱신 실패", error);
      }
    }
    return portfolioChanged;
  }

  async function executeOrDefer(broker, record, { retry = false } = {}) {
    if (!retry && shouldDelayEntry(record)) {
      receipts.putDeferred(broker.id, record, deferredTtlMs);
      await send(channels.order, formatDeferredBuy(record, broker.label, broker.environment));
      return null;
    }
    try {
      return await execute(broker, record);
    } catch (error) {
      if (shouldDeferEntry(record, error)) {
        if (!retry) {
          receipts.putDeferred(broker.id, record, deferredTtlMs);
          await send(channels.order, formatDeferredBuy(record, broker.label, broker.environment));
        }
        return null;
      }
      const action = record.payload.action === "BUY" ? "매수" : "매도";
      await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
        title: "주문 실패",
        reason: "계좌 조회 또는 주문 요청 실패",
      }));
      await reportError(`${broker.label} 자동 ${action} 실패`, error, record);
      return null;
    }
  }

  async function retryDeferred(now = new Date()) {
    for (const deferred of receipts.listDeferred()) {
      if (deferred.expiresAt <= now.getTime()) {
        receipts.removeDeferred(deferred.key);
        await send(channels.order, { text: `⌛ **매수 예약 만료**\n${formatInstrumentLabel(deferred.record.payload)}` });
        continue;
      }
      const record = structuredClone(deferred.record);
      if (shouldDelayEntry(record, now)) continue;
      const domestic = record.payload.exchange === "KRX";
      const clock = domestic ? domesticSessionClock(now) : usSessionClock(now);
      const attemptKey = `${clock.date}:${domestic ? domesticSession(now) : usSession(now)}`;
      if (deferred.lastAttemptMarketDate === attemptKey) continue;
      receipts.markDeferredAttempt(deferred.key, attemptKey);
      const broker = brokers.find((item) => item.id === deferred.brokerId);
      if (!broker) {
        receipts.removeDeferred(deferred.key);
        continue;
      }
      try {
        const quoteClient = domestic ? broker.domesticClient : broker.overseasClient;
        if (domestic && quoteClient?.getDomesticQuote) {
          const quote = await quoteClient.getDomesticQuote({ symbol: record.payload.ticker });
          record.payload.price = quote.currentPrice;
          if (quote.name) record.payload.name = quote.name;
        } else if (quoteClient) {
          const quote = await quoteClient.getUsQuote({ exchange: signalExchange(record.payload.exchange), symbol: record.payload.ticker });
          record.payload.price = quote.currentPrice;
          if (quote.name) record.payload.name = quote.name;
        }
        await execute(broker, record);
        receipts.removeDeferred(deferred.key);
      } catch (error) {
        if (shouldDeferEntry(record, error)) continue;
        receipts.markDeferredFailure(deferred.key, error);
        await send(channels.execution, formatUncreatedOrder(brokerAccountLabel(broker), record, {
          title: "예약 매수 실패",
          reason: "계좌 조회 또는 주문 요청 실패",
        }));
        await reportError(`${broker.label} 예약 매수 재시도 실패`, error, record);
      }
    }
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
      await send(channels.execution, formatUncreatedOrder(accountSummary(), pending.record, {
        title: "사용자 BUY 승인 거부",
        reason: "사용자가 BUY 승인을 거부했습니다.",
      }));
      await message.reply(`BUY 승인을 거부했습니다: ${formatInstrumentLabel(pending.record.payload)}`);
      return true;
    }
    const allowedBrokerIds = pending.brokerIds || command.brokers;
    const selected = brokers.filter((broker) => command.brokers.includes(broker.id) && allowedBrokerIds.includes(broker.id));
    if (!selected.length) {
      await message.reply("선택한 증권사 실행기가 연결되어 있지 않습니다.");
      return true;
    }
    receipts.removePending(pending.key);
    for (const broker of selected) {
      try {
        await executeOrDefer(broker, structuredClone(pending.record));
      } catch (error) {
        await reportError(`${broker.label} 승인 주문 실패`, error, pending.record);
      }
    }
    return true;
  }

  async function processMessage(message) {
    if (!shouldConsumeMessage(message, trusted)) return;
    const record = decodeSignalEmbed(message.embeds?.[0]);
    if (!record) return;
    if (Date.now() - new Date(record.receivedAt).getTime() > maxAgeMs) return;
    if (!receipts.claim(record.requestId, message.id)) return;

    try {
      record.source = "DISCORD_SIGNAL";
      [record.payload] = await enrichInstrumentNames([record.payload]);
      const entry = ["PAPER_ENTRY", "PAPER_ADD"].includes(record.risk?.verdict) && record.payload.action === "BUY";
      const approvalBrokers = entry ? brokers.filter((broker) => buyApprovalRequiredForBroker(broker, record, receipts.autoTrading())) : [];
      if (approvalBrokers.length) {
        const previews = Object.fromEntries(await Promise.all(approvalBrokers.map(async (broker) => [broker.id, await previewFor(broker, structuredClone(record))])));
        const channel = await targetChannel(channels.order);
        const brokerIds = approvalBrokers.map((broker) => broker.id);
        const approval = await channel.send(approvalText(record, previews, brokerIds));
        receipts.putPending(record, approval.id, approvalTtlMs, brokerIds);
      }
      if (!entry && !receipts.autoTrading()) {
        await send(channels.system, { text: `⏸️ **${accountLabel} 자동매매 OFF**\n**종목**: ${formatInstrumentLabel(record.payload)}\n신호는 수신했지만 주문하지 않았습니다.` });
        return;
      }
      for (const broker of brokers.filter((item) => !approvalBrokers.includes(item))) {
        try {
          await executeOrDefer(broker, structuredClone(record));
        } catch (error) {
          await reportError(`${broker.label} 자동 주문 실패`, error, record);
        }
      }
    } catch (error) {
      await reportError(`${accountLabel} 주문 실행기 처리 실패`, error, record);
    }
  }

  async function processOwnerCommand(message) {
    if (message.author.bot || message.author.id !== ownerId) return false;
    if (![channels.system, channels.order].includes(message.channelId) && ![channels.system, channels.order].includes(message.channel?.name)) return false;
    const command = accountCommand(message.content, executorName);
    if (!command) return false;
    if (command === "HELP") {
      await message.reply(["🧾 **계좌 주문 실행기 명령어**", "`!account status`", "`!account orders`", "`!account auto on` / `!account auto off` / `!account auto status`", "수동 BUY 승인: `사줘`·`둘다` / `키움만` / `한투만` / `안 사`"].join("\n"));
    } else if (command === "STATUS") {
      await message.reply([`🧭 **${accountLabel} 주문 실행기 상태**`, `증권사: ${accountSummary()}`, `신뢰 채널: ${sourceChannelIds.size}개`, `자동매매: ${receipts.autoTrading() ? "ON" : "OFF"}`, `실계좌: ${brokers.some((broker) => broker.environment === "live") ? "활성 · 강한 BUY 자동, 축소 BUY 승인" : "지원 · 현재 잠금"}`].join("\n"));
    } else if (["AUTO_ON", "AUTO_OFF", "AUTO_STATUS"].includes(command)) {
      if (command !== "AUTO_STATUS") receipts.setAutoTrading(command === "AUTO_ON");
      await message.reply(`🤖 **${accountLabel} 자동매매 ${receipts.autoTrading() ? "ON" : "OFF"}**\n${receipts.autoTrading() ? "모의계좌는 BUY를 자동 주문하고, 실계좌는 강한 BUY만 자동·축소 BUY는 승인 후 주문합니다." : "신호는 수신하지만 자동 주문하지 않습니다."}\n실계좌 기능은 지원하며 현재 계좌 설정의 잠금 상태를 따릅니다.`);
    } else {
      const orders = brokers.flatMap((broker) => broker.tracker.list().slice(0, 5).map((order) => `${broker.label} · ${order.name || order.symbol} (${order.symbol}) · ${order.side} · ${order.status}`)).slice(0, 10);
      await message.reply(["📋 **계좌별 최근 주문**", ...(orders.length ? orders : ["저장된 주문 없음"])].join("\n"));
    }
    return true;
  }

  client.on("messageCreate", (message) => {
    queue = queue.then(async () => {
      if (await processOwnerCommand(message)) return;
      if (await processApproval(message)) return;
      await processMessage(message);
    }).catch((error) => reportError("Discord 메시지 처리 실패", error));
  });
  client.once("clientReady", async () => {
    console.log([
      `\n✅ ${accountLabel} 주문 실행기 준비 완료`,
      `Discord: ${client.user.tag}`,
      `계좌: ${accountSummary()} · 실계좌 기능 지원`,
      `수신: 매매신호 채널 ${sourceChannelIds.size}개`,
      `처리: 공통 신호 → 계좌별 수량 계산 → ${receipts.autoTrading() ? "자동 주문" : "BUY 승인"}`,
    ].join("\n"));
    await send(channels.system, { text: formatBrokerStartup(
      `${accountLabel} 주문 실행기`,
      client.user.tag,
      `${accountSummary()} · 신뢰 채널 ${sourceChannelIds.size}개 · 자동매매 ${receipts.autoTrading() ? "ON" : "OFF"}`,
      brokers.some((broker) => broker.environment === "live") ? "실계좌 활성 · 강한 BUY 자동, 축소 BUY 승인" : "실계좌 지원 · 현재 잠금",
    ) });
    const reconciled = await reconcileOrders().catch(async (error) => {
      await reportError("미완료 주문 시작 조회 실패", error);
      return false;
    });
    if (!reconciled) await syncPortfolio().catch((error) => reportError("포트폴리오 시작 갱신 실패", error));
    setInterval(() => {
      queue = queue.then(() => syncPortfolio()).catch((error) => reportError("포트폴리오 일일 갱신 실패", error));
    }, portfolioSyncMinutes * 60_000).unref();
    for (const channelId of sourceChannelIds) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;
      const recent = [...(await channel.messages.fetch({ limit: 50 })).values()].reverse();
      for (const message of recent) queue = queue.then(() => processMessage(message));
    }
    setInterval(() => {
      queue = queue.then(() => retryDeferred()).catch((error) => reportError("미국 예약 주문 재시도 실패", error));
    }, 15_000).unref();
    setInterval(() => {
      queue = queue.then(() => reconcileOrders()).catch((error) => reportError("미완료 주문 체결 조회 실패", error));
    }, 30_000).unref();
  });
  await client.login(process.env.ACCOUNT_DISCORD_TOKEN || process.env.KIS_DISCORD_TOKEN || process.env.DISCORD_TOKEN_DRUCKENMILLER);
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { SignalReceiptStore, accountCommand, accountContext, accountPortfolioSyncMinutes, approvalText, brokerEnvironments, buyApprovalRequiredForBroker, discordMessagePayload, enabledBrokerIds, enforceOwnAccountRules, errorReportDue, liveAutoBuyEligible, orderNeedsPortfolioSync, orderNeedsResultReport, reconcilePendingBrokerOrders, shouldConsumeMessage, signalExchange, start };
