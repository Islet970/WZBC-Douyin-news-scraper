#!/usr/bin/env node

/**
 * 抖音主页视频爬虫
 *
 * 流程：
 * 1. 打开目标抖音主页。
 * 2. 等你处理验证码/登录。
 * 3. 从当前网页开始滚动，并监听作品接口。
 * 4. 跳过置顶视频，只保存发布时间属于 2026 年 4 月的视频标题和 via。
 * 5. 一旦遇到第一个非 2026 年 4 月的非置顶视频，就停止爬取。
 *
 * 运行：
 *   node douyin_scraper.js
 *   node douyin_scraper.js --max-scrolls 200
 */

const fs = require("fs");
const path = require("path");

const PROFILE_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAnqfUZ9I36MTOExGSvYX0RpBDJuQ4IIvrreOF3DzhefQ";
const OUTPUT_DIR = __dirname;
const TARGET_YEAR = 2026;
const TARGET_MONTH = 3;
const FALLBACK_PLAYWRIGHT =
  "C:\\Users\\Voidkongbai\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules\\playwright";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { headless: args.includes("--headless"), maxScrolls: 120 };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--max-scrolls" && args[i + 1]) {
      options.maxScrolls = Number(args[i + 1]);
      i += 1;
    }
  }

  return options;
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    return require(FALLBACK_PLAYWRIGHT);
  }
}

function waitForEnter(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${message}\n`);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function fileTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function truncateChars(value, maxChars) {
  return Array.from(String(value ?? "")).slice(0, maxChars).join("");
}

function normalizeTimestamp(value) {
  if (value == null || value === "") return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;

  return number > 10_000_000_000 ? number : number * 1000;
}

function findPublishTimestamp(item, depth = 0, seen = new Set()) {
  if (!item || typeof item !== "object" || depth > 4 || seen.has(item)) return null;
  seen.add(item);

  const directKeys = [
    "create_time",
    "createTime",
    "publish_time",
    "publishTime",
    "create_time_ms",
    "createTimeMs",
  ];

  for (const key of directKeys) {
    const timestamp = normalizeTimestamp(item[key]);
    if (timestamp) return timestamp;
  }

  for (const [key, value] of Object.entries(item)) {
    const k = key.toLowerCase();
    if ((k.includes("create") || k.includes("publish")) && k.includes("time")) {
      const timestamp = normalizeTimestamp(value);
      if (timestamp) return timestamp;
    }
  }

  for (const value of Object.values(item)) {
    const timestamp = findPublishTimestamp(value, depth + 1, seen);
    if (timestamp) return timestamp;
  }

  return null;
}

function getPublishDate(item) {
  const timestamp = findPublishTimestamp(item);
  return timestamp ? new Date(timestamp) : null;
}

function isTargetMonth(item) {
  const date = getPublishDate(item);
  if (!date) return false;

  return date.getFullYear() === TARGET_YEAR && date.getMonth() + 1 === TARGET_MONTH;
}

// -1 = 早于目标月份, 0 = 目标月份内, 1 = 晚于目标月份, null = 无法判断
function compareToTargetMonth(item) {
  const date = getPublishDate(item);
  if (!date) return null;
  const targetStart = new Date(TARGET_YEAR, TARGET_MONTH - 1, 1);
  const targetEnd = new Date(TARGET_YEAR, TARGET_MONTH, 1);
  if (date >= targetStart && date < targetEnd) return 0;
  return date < targetStart ? -1 : 1;
}

// 判断接口中的视频是否置顶。"\u7f6e\u9876" 是“置顶”，避免源码编码问题。
function isPinned(item) {
  const flags = [item.is_top, item.isTop, item.is_pinned, item.isPinned, item.top, item.stick_top, item.stickTop];
  if (flags.some((v) => v === true || v === 1 || v === "1")) return true;

  const text = [item.label_text, item.labelText, item.corner_mark, item.cornerMark, item.video_tag, item.videoTag, item.tag]
    .flat()
    .filter(Boolean)
    .join(" ");
  return text.includes("\u7f6e\u9876");
}

// via 字段位置不固定，所以递归查找 via、video_via、videoVia 或 xxx_via。
function findVia(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return "";
  seen.add(value);

  for (const [key, next] of Object.entries(value)) {
    const k = key.toLowerCase();
    if (k === "via" || k === "video_via" || k === "videovia" || k.endsWith("_via")) {
      if (["string", "number", "boolean"].includes(typeof next)) return String(next);
    }
  }

  for (const next of Object.values(value)) {
    const found = findVia(next, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

// 从接口 JSON 中提取作品列表。通常字段名是 aweme_list。
function extractAwemeList(payload) {
  const lists = [];

  function walk(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === "object" && ("aweme_id" in item || "awemeId" in item))) {
        lists.push(value);
      }
      value.forEach((item) => walk(item, depth + 1, seen));
      return;
    }

    for (const [key, next] of Object.entries(value)) {
      if ((key === "aweme_list" || key === "awemeList") && Array.isArray(next)) lists.push(next);
      walk(next, depth + 1, seen);
    }
  }

  walk(payload);
  return lists.flat();
}

function normalizeVideo(item) {
  const awemeId = String(item.aweme_id ?? item.awemeId ?? item.id ?? "");
  const title = String(item.desc ?? item.title ?? item.share_info?.share_title ?? "").trim();
  return {
    title,
    via: truncateChars(findVia(item), 10),
    aweme_id: awemeId,
    url: awemeId ? `https://www.douyin.com/video/${awemeId}` : "",
  };
}

async function main() {
  const options = parseArgs();
  const { chromium } = loadPlaywright();
  const rowsById = new Map();
  const userDataDir = path.join(OUTPUT_DIR, ".douyin_browser_profile");

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless,
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] || (await context.newPage());
  let hasMore = true;
  let startedCollecting = false;
  let reachedNonTargetMonth = false;
  let resolveNextResponse = null;

  // Listen to the current page's post API and filter videos by publish time.
  page.on("response", async (response) => {
    if (reachedNonTargetMonth) return;
    if (!response.url().includes("/aweme/v1/web/aweme/post/")) return;

    try {
      const payload = await response.json();
      if (payload.has_more === 0 || payload.has_more === false) hasMore = false;

      for (const item of extractAwemeList(payload)) {
        if (isPinned(item)) continue;

        const date = getPublishDate(item);
        if (!date) {
          const row = normalizeVideo(item);
          console.warn(`视频 ${row.aweme_id || row.title || "unknown"} 缺少可识别发布时间，已跳过。`);
          continue;
        }

        const cmp = compareToTargetMonth(item);
        if (cmp === 0) {
          if (!startedCollecting) {
            startedCollecting = true;
            console.log(`进入目标月份（${TARGET_YEAR}-${String(TARGET_MONTH).padStart(2, "0")}），开始统计。`);
          }
          const row = normalizeVideo(item);
          if (row.aweme_id && row.title) rowsById.set(row.aweme_id, row);
        } else if (cmp === -1 && startedCollecting) {
          const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
          reachedNonTargetMonth = true;
          hasMore = false;
          console.log(`遇到非目标月份视频（${label}），停止继续爬取。`);
          break;
        }
      }

      if (startedCollecting) {
        console.log(`已捕获 ${rowsById.size} 条非置顶视频。`);
      }
    } catch (error) {
      console.warn(`接口解析失败：${error.message}`);
    }

    if (resolveNextResponse) {
      resolveNextResponse();
      resolveNextResponse = null;
    }
  });

  const startTime = Date.now();

  console.log(`输出目录：${OUTPUT_DIR}`);
  console.log("正在打开抖音主页。如出现验证码或登录页，请先在 Chrome 中手动完成。");
  await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForEnter("看到作品列表后，回到此命令行窗口按 Enter，脚本会直接监听当前网页作品并开始滚动。");

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  for (let i = 0; i < options.maxScrolls && hasMore && !reachedNonTargetMonth; i += 1) {
    const nextResponse = new Promise((resolve) => { resolveNextResponse = resolve; });
    await page.mouse.wheel(0, 1800);
    await Promise.race([nextResponse, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  await page.waitForTimeout(2000);
  await context.close();

  const rows = Array.from(rowsById.values());
  const stamp = fileTimestamp();
  const csvPath = path.join(OUTPUT_DIR, `douyin_videos_2026_04_${stamp}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `douyin_videos_2026_04_${stamp}.json`);
  const csv = [
    ["title", "via", "aweme_id", "url"].join(","),
    ...rows.map((row) => [row.title, row.via, row.aweme_id, row.url].map(csvEscape).join(",")),
  ].join("\r\n");

  fs.writeFileSync(csvPath, `\ufeff${csv}`, "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), "utf8");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`完成，共保存 ${rows.length} 条，耗时 ${elapsed} 秒。`);
  console.log(`CSV：${csvPath}`);
  console.log(`JSON：${jsonPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
