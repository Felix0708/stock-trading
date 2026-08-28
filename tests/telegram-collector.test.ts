"use strict";

const assert = require("node:assert/strict");
const {
  chooseLatestChannel,
  markdownForDay,
  messagesForDate,
  previousDate,
  zonedDate,
} = require("../src/research/telegram-collector");

const dialogs = [
  { isChannel: true, title: "뉴스시황 6.15~7.15", date: 100, id: 1 },
  { isChannel: true, title: "뉴스시황 7.15~8.15", date: 200, id: 2 },
  { isChannel: true, title: "다른 채널", date: 300, id: 3 },
];
assert.equal(chooseLatestChannel(dialogs, "뉴스시황").id, 2);
assert.equal(previousDate("2026-03-01"), "2026-02-28");
assert.equal(zonedDate(new Date("2026-08-08T15:30:00Z"), "Asia/Seoul"), "2026-08-09");

const messages = [
  { date: Date.parse("2026-08-08T14:00:00Z") / 1000, message: "전날" },
  { date: Date.parse("2026-08-09T01:00:00Z") / 1000, message: "오늘 링크 https://example.com", localImages: ["assets/2026-08-09/chart.jpg"] },
  { id: 3, date: Date.parse("2026-08-09T02:00:00Z") / 1000, message: "", photo: {}, localImages: ["assets/2026-08-09/3.jpg"] },
];
const selected = messagesForDate(messages, "2026-08-09", "Asia/Seoul");
assert.equal(selected.length, 1);
const markdown = markdownForDay({
  title: "뉴스시황 7.15~8.15",
  channelId: "123",
  targetDate: "2026-08-09",
  timeZone: "Asia/Seoul",
  messages: selected,
});
assert.match(markdown, /오늘 링크 https:\/\/example\.com/);
assert.doesNotMatch(markdown, /Telegram 원본 이미지/);
assert.match(markdown, /뉴스·시황 채널/);
console.log("telegram-collector tests OK");
