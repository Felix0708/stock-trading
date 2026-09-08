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

  // Exercise the real compiler/cache flow without requiring Swift or PDFKit in CI.
  const checkout = path.join(root, "Stock-Trading");
  const cache = path.join(checkout, ".research-cache");
  const binary = path.join(cache, "pdf-ocr");
  const pdfs = path.join(checkout, "pdfs");
  fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(cache, "swift-cache"), { recursive: true });
  fs.mkdirSync(pdfs);
  fs.writeFileSync(path.join(checkout, "scripts", "pdf-ocr.swift"), "fixture");
  fs.writeFileSync(path.join(cache, "swift-cache", "old-path.pcm"), "stale lowercase checkout path");
  fs.writeFileSync(path.join(pdfs, "report.pdf"), "fixture");
  const moduleCaches = [];
  let failCompile = false;
  const isolated = { exports: {} as any };
  require("node:vm").runInNewContext(fs.readFileSync(require.resolve("../src/research/recent-research"), "utf8"), {
    __dirname: path.join(checkout, "src", "research"),
    module: isolated,
    process: { env: {} },
    require: (name) => name === "node:child_process" ? { spawnSync: (command, args) => {
      if (command === "/usr/bin/swiftc") {
        const modules = args[args.indexOf("-module-cache-path") + 1];
        moduleCaches.push(modules);
        assert.equal(fs.existsSync(modules), false);
        assert.equal(path.basename(modules), "modules");
        assert.ok(path.basename(path.dirname(modules)).startsWith("swift-build-"));
        if (failCompile) return { status: 1, stderr: "compiler unavailable" };
        fs.writeFileSync(args[args.indexOf("-o") + 1], "compiled binary");
        return { status: 0 };
      }
      assert.equal(command, binary);
      return { status: 0, stdout: "--- page 1 ---\n확인된 PDF 본문" };
    } } : require(name),
  });
  const readPdf = (maxPages) => isolated.exports.loadRecentResearch({ directory: pdfs, maxPages, maxImages: 0 });
  assert.equal(readPdf(5).files[0].readable, true);
  assert.equal(readPdf(5).files[0].readable, true);
  assert.equal(moduleCaches.length, 1, "successful text cache should be reused");
  fs.utimesSync(binary, new Date(0), new Date(0));
  failCompile = true;
  assert.equal(readPdf(6).files[0].readable, false);
  assert.equal(fs.readFileSync(binary, "utf8"), "compiled binary", "failed compile must preserve the old binary");
  failCompile = false;
  assert.equal(readPdf(6).files[0].readable, true, "failed extraction must remain retryable");
  assert.equal(new Set(moduleCaches).size, 3, "each compile needs a fresh module cache");
  for (const modules of moduleCaches) assert.equal(fs.existsSync(path.dirname(modules)), false);
  assert.equal(fs.existsSync(path.join(cache, "swift-cache", "old-path.pcm")), true, "legacy cache is left untouched");
  console.log("recent-research test OK");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
