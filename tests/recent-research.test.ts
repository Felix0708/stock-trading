"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hasResearchBody, markdownImagePaths, recentPdfFiles, loadRecentResearch } = require("../src/research/recent-research");
const { markdownForDay } = require("../src/research/telegram-collector");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "recent-research-"));
try {
  const now = Date.now();
  const newest = path.join(root, "newest.pdf");
  const older = path.join(root, "older.pdf");
  const ignored = path.join(root, "ignored.txt");
  const markdown = path.join(root, "telegram.md");
  const image = path.join(root, "chart image.jpg");
  fs.writeFileSync(newest, "new");
  fs.writeFileSync(older, "old");
  fs.writeFileSync(ignored, "text");
  fs.writeFileSync(image, "image");
  fs.writeFileSync(markdown, "![Telegram 원본 이미지](<chart image.jpg>)");
  fs.utimesSync(newest, new Date(now - 1_000), new Date(now - 1_000));
  fs.utimesSync(older, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));
  fs.utimesSync(markdown, new Date(now - 500), new Date(now - 500));
  const files = recentPdfFiles({ directory: root, now, lookbackDays: 7, maxFiles: 3 });
  assert.deepEqual(files.map((item) => path.basename(item.file)), ["telegram.md", "newest.pdf", "older.pdf"]);
  assert.deepEqual(markdownImagePaths(markdown), [fs.realpathSync(image)]);
  assert.equal(hasResearchBody("\n--- page 1 ---\n"), false);
  assert.equal(hasResearchBody("\n--- page 1 ---\nSTM 본문"), true);
  const remaining = recentPdfFiles({
    directory: root,
    now,
    lookbackDays: 7,
    maxFiles: 3,
    reviewedIds: [files[0].id],
  });
  assert.deepEqual(remaining.map((item) => path.basename(item.file)), ["newest.pdf", "older.pdf"]);
  const research = path.join(root, "research");
  fs.mkdirSync(research);
  const inside = path.join(research, "allowed.jpg");
  fs.writeFileSync(inside, "test image");
  fs.symlinkSync(image, path.join(research, "escape.jpg"));
  fs.mkdirSync(path.join(research, "directory.jpg"));
  const collected = path.join(research, "telegram.md");
  fs.writeFileSync(collected, markdownForDay({ title: "fixture", channelId: "fixture", targetDate: "2026-09-07", timeZone: "Asia/Seoul", messages: [{ date: new Date(), message: [
    "![valid](<allowed.jpg>)", "![outside](<../chart image.jpg>)", `![absolute outside](<${image}>)`,
    "![symlink](<escape.jpg>)", "![directory](<directory.jpg>)", "![missing](<missing.jpg>)",
  ].join("\n") }] }));
  assert.deepEqual(loadRecentResearch({ directory: research }).images, [fs.realpathSync(inside)]);
  console.log("recent-research test OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
