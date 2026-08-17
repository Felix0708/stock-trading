"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");

const ROOT = __dirname;
const SESSION_FILE = path.join(ROOT, ".telegram-session");

function zonedDate(value, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

function messageDate(message) {
  if (message.date instanceof Date) return message.date;
  const value = Number(message.date || 0);
  return new Date(value < 10_000_000_000 ? value * 1000 : value);
}

function chooseLatestChannel(dialogs, match) {
  const needle = match.trim().toLocaleLowerCase("ko-KR");
  return dialogs
    .filter((dialog) => dialog.isChannel && String(dialog.title || dialog.name || "").toLocaleLowerCase("ko-KR").includes(needle))
    .sort((left, right) => Number(right.date || right.message?.date || 0) - Number(left.date || left.message?.date || 0))[0] || null;
}

function messagesForDate(messages, targetDate, timeZone) {
  return messages
    .filter((message) => String(message.message || "").trim() && zonedDate(messageDate(message), timeZone) === targetDate)
    .sort((left, right) => messageDate(left) - messageDate(right));
}

function markdownForDay({ title, channelId, targetDate, timeZone, messages, collectedAt = new Date() }) {
  const time = new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const blocks = messages.map((message) => {
    const text = String(message.message || "").trim();
    const body = text ? text.split("\n").map((line) => `> ${line}`).join("\n") : "> *(캡션 없음)*";
    return `## ${time.format(messageDate(message))}\n\n${body}`;
  });
  return [
    `# ${targetDate} ${title}`,
    "",
    `- 원본 채널: ${title}`,
    `- 채널 ID: ${channelId}`,
    `- 시간대: ${timeZone}`,
    `- 마지막 수집 대상 시각: ${collectedAt.toISOString()}`,
    "- 수집 범위: 운영자에게 허락받은 채널의 본문·캡션·링크",
    "- 자동 생성 파일: 원문 사실 확인용 자료이며 투자 판단이나 주문 명령이 아님",
    "",
    ...blocks,
    "",
  ].join("\n");
}

function config() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  if (!Number.isInteger(apiId) || apiId < 1 || !apiHash) {
    throw new Error("TELEGRAM_API_ID와 TELEGRAM_API_HASH를 .env에 입력하세요.");
  }
  return {
    apiId,
    apiHash,
    match: process.env.TELEGRAM_CHANNEL_MATCH || "무니인사이트",
    timeZone: process.env.TELEGRAM_TIMEZONE || "Asia/Seoul",
    outputDirectory: process.env.TELEGRAM_OUTPUT_DIR,
  };
}

function clientFromSession(session = "") {
  const { apiId, apiHash } = config();
  return new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
}

async function hiddenQuestion(input, prompt) {
  const original = input._writeToOutput;
  input._writeToOutput = function maskedOutput(value) {
    this.output.write(value.includes(prompt) ? value : "*");
  };
  try {
    const answer = await input.question(prompt);
    input.output.write("\n");
    return answer;
  } finally {
    input._writeToOutput = original;
  }
}

async function connectSavedClient() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error("먼저 npm run telegram:login을 실행하세요.");
  const client = clientFromSession(fs.readFileSync(SESSION_FILE, "utf8").trim());
  await client.connect();
  if (!await client.checkAuthorization()) {
    await client.disconnect();
    throw new Error("텔레그램 로그인이 만료되었습니다. npm run telegram:login을 다시 실행하세요.");
  }
  return client;
}

async function login() {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  const client = clientFromSession(fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "");
  try {
    await client.start({
      phoneNumber: () => input.question("전화번호(+82...): "),
      phoneCode: () => hiddenQuestion(input, "Telegram 앱으로 받은 인증 코드: "),
      password: () => hiddenQuestion(input, "Telegram 2단계 인증 비밀번호: "),
      onError: (error) => { console.error(`인증 오류: ${error.message}`); },
    });
    fs.writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });
    console.log("텔레그램 로그인 저장 완료. 인증 세션은 .telegram-session에만 보관됩니다.");
  } finally {
    input.close();
    await client.disconnect();
  }
}

async function matchingChannels() {
  const { match } = config();
  const client = await connectSavedClient();
  try {
    const dialogs = await client.getDialogs({ limit: 500 });
    return dialogs
      .filter((dialog) => dialog.isChannel && String(dialog.title || dialog.name || "").includes(match))
      .map((dialog) => ({ title: dialog.title || dialog.name, id: dialog.id?.toString(), date: dialog.date }));
  } finally {
    await client.disconnect();
  }
}

async function collectTelegramDay(targetDate) {
  const settings = config();
  if (!settings.outputDirectory) throw new Error("TELEGRAM_OUTPUT_DIR를 .env에 입력하세요.");
  const client = await connectSavedClient();
  try {
    const dialogs = await client.getDialogs({ limit: 500 });
    const dialog = chooseLatestChannel(dialogs, settings.match);
    if (!dialog) throw new Error(`제목에 '${settings.match}'가 포함된 텔레그램 채널을 찾지 못했습니다.`);

    const recent = [];
    for await (const message of client.iterMessages(dialog.inputEntity, { limit: 1000 })) {
      const date = zonedDate(messageDate(message), settings.timeZone);
      if (date < targetDate) break;
      if (date === targetDate) recent.push(message);
    }
    const messages = messagesForDate(recent, targetDate, settings.timeZone);
    if (!messages.length) return { title: dialog.title || dialog.name, messages: 0, file: null };

    fs.mkdirSync(settings.outputDirectory, { recursive: true });
    const safeTitle = String(dialog.title || dialog.name).replace(/[\\/:*?"<>|]/g, "-");
    const file = path.join(settings.outputDirectory, `${targetDate}_${safeTitle}.md`);
    const content = markdownForDay({
      title: dialog.title || dialog.name,
      channelId: dialog.id?.toString() || "unknown",
      targetDate,
      timeZone: settings.timeZone,
      messages,
      collectedAt: messageDate(messages.at(-1)),
    });
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) {
      return { title: dialog.title || dialog.name, messages: messages.length, file, unchanged: true };
    }
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { title: dialog.title || dialog.name, messages: messages.length, file };
  } finally {
    await client.disconnect();
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "login") return login();
  if (command === "list") {
    const channels = await matchingChannels();
    if (!channels.length) console.log("일치하는 채널이 없습니다.");
    else channels.forEach((channel) => console.log(`${channel.title} (${channel.id})`));
    return;
  }
  if (command === "collect") {
    const settings = config();
    const date = process.argv[3] || previousDate(zonedDate(new Date(), settings.timeZone));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("날짜는 YYYY-MM-DD 형식이어야 합니다.");
    const result = await collectTelegramDay(date);
    console.log(result.file ? `${result.messages}개 저장: ${result.file}` : `${result.title}: ${date} 메시지 없음`);
    return;
  }
  throw new Error("사용법: telegram-collector.js login|list|collect [YYYY-MM-DD]");
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {
  chooseLatestChannel,
  collectTelegramDay,
  markdownForDay,
  messageDate,
  messagesForDate,
  previousDate,
  zonedDate,
};
