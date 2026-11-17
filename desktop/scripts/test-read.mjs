/*
 * 服务层自测：阅读时间线与日历那几个数。
 * 跑法 node scripts/test-read.mjs，样本取「我的书库」的副本，不动正式库。
 * 只比自己数一遍的结果，不写死本数与书名；边界另建一个空库现造三本。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

let ok = 0;
let bad = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    ok++;
    console.log("  ok   " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("  FAIL " + name + (extra ? "  " + extra : ""));
    process.exitCode = 1;
  }
};

/* ---- 一、样本库：与手写 SQL 的六个结果对齐 ---- */
const src = path.join(root, "我的书库", "library.db");
if (!fs.existsSync(src)) {
  console.log("缺少样本库 " + src + "，本组测试以本地书库为样本，跳过");
  process.exit(0);
}

const sample = path.join(dataDir, "tr.db");
for (const f of [sample, sample + "-wal", sample + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
fs.copyFileSync(src, sample);
process.env.LIBRARY_DB = sample;

const { openDb } = require("../dist-electron/electron/db/index.js");
const { readTimeline, readStats } = require("../dist-electron/electron/services/readService.js");

const db = openDb(sample);
console.log("[1] 时间线");

const all = readTimeline(db, "");
const withDate = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND media_type = '小说' AND (read_date <> '' OR read_start <> '')"
    )
    .get().n
);
t("条数与库里有日期的小说一致", all.length === withDate, all.length + " / " + withDate);
t("按结束日期从近到远", all.every((e, i) => i === 0 || all[i - 1].anchor >= e.anchor));
t("每条的落点都不空", all.every((e) => e.anchor.length === 10));
t("开始不晚于结束", all.every((e) => !e.end || e.start <= e.end));
t("当天读完的起止相同", all.every((e) => e.span === (e.days > 1)));
t(
  "跨度天数与两个日期对得上",
  all.every((e) => e.days === Math.round((Date.parse(e.end || e.start) - Date.parse(e.start)) / 86400000) + 1),
  all.filter((e) => e.span).length + " 本跨天"
);
t("「全部」与空媒介一个口径", readTimeline(db, "全部").length === all.length && readStats(db, "全部").total === all.length);
const byMedia = readTimeline(db, "小说");
const nMedia = Number(db.prepare("SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND media_type = '小说' AND (read_date <> '' OR read_start <> '')").get().n);
t("按媒介筛的口径一致", byMedia.length === nMedia && byMedia.every((e) => e.anchor), byMedia.length + " / " + nMedia);

/* 时间线只算小说，漫画给了日期也不收 */
const mangaIds = new Set(
  db.prepare("SELECT id FROM books WHERE deleted_at IS NULL AND media_type = '漫画'").all().map((r) => r.id)
);
const mangaDated = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND media_type = '漫画' AND (read_date <> '' OR read_start <> '')"
    )
    .get().n
);
t("漫画一本都不进时间线", all.every((e) => !mangaIds.has(e.id)), "库里有日期的漫画 " + mangaDated + " 本");
t("传什么媒介都是同一批小说", readTimeline(db, "漫画").length === all.length && readStats(db, "漫画").total === all.length);

console.log("[2] 统计");
const s = readStats(db, "");
const dayRows = db
  .prepare(
    "SELECT read_date AS d, COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND media_type = '小说' AND read_date <> '' GROUP BY read_date ORDER BY read_date"
  )
  .all();
t("有日期的本数与按日求和一致", s.total === all.length, s.total + "");
t("按日计数逐天一致", s.byDay.length === dayRows.length && s.byDay.every((r, i) => r.day === dayRows[i].d && r.n === dayRows[i].n), s.byDay.length + " 天");
const yearSum = s.byYear.reduce((a, b) => a + b.n, 0);
t("按年求和等于有日期的本数", yearSum === dayRows.reduce((a, r) => a + r.n, 0), s.byYear.length + " 年");
t("年份从新到旧", s.byYear.every((y, i) => i === 0 || s.byYear[i - 1].year > y.year));
const top = dayRows.slice().sort((a, b) => b.n - a.n || (a.d < b.d ? 1 : -1))[0];
t("最忙的一天对得上", !top || (s.busiest.day === top.d && s.busiest.n === top.n), s.busiest ? s.busiest.day + " " + s.busiest.n + " 本" : "无");
const avgRow = db
  .prepare(
    "SELECT AVG(rating) AS a FROM books WHERE deleted_at IS NULL AND media_type = '小说' AND (read_date <> '' OR read_start <> '') AND rating IS NOT NULL AND rating > 0"
  )
  .get();
t("平均分对得上", s.avgRating === (avgRow.a == null ? null : Math.round(avgRow.a * 10) / 10), s.avgRating + "");
t("首尾日期是那两个", s.first === dayRows[0].d && s.last === dayRows[dayRows.length - 1].d, s.first + " 到 " + s.last);
t("今年读完的数与按年表一致", s.yearRead === (s.byYear.find((y) => y.year === new Date().getFullYear())?.n || 0), s.yearRead + " 本");
const noDate = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL AND media_type = '小说' AND is_read = 1 AND read_date = '' AND read_start = ''"
    )
    .get().n
);
t("没日期的小说本数对得上", s.noDate === noDate, s.noDate + " 本");

/* 最长连读自己数一遍 */
const days = dayRows.map((r) => r.d);
let best = 0;
let cur = 0;
let prev = "";
for (const d of days) {
  cur = prev && Date.parse(d) - Date.parse(prev) === 86400000 ? cur + 1 : 1;
  if (cur > best) best = cur;
  prev = d;
}
t("最长连读对得上", s.streak.days === best, s.streak.days + " 天");
t("连读止于有书的那天", !s.streak.end || days.includes(s.streak.end));

/* ---- 二、边界：空库、只有开始没有结束、跨年两天连读、同一天两本 ---- */
console.log("[3] 边界");
const edgeFile = path.join(dataDir, "tr-edge.db");
for (const f of [edgeFile, edgeFile + "-wal", edgeFile + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
/* 上面那个连接是模块级缓存的，同一个进程里再开一个库拿回来还是同一份，
   边界这组直接用驱动按同一套迁移建一个新库 */
const Database = require("better-sqlite3");
const { MIGRATIONS } = require("../dist-electron/electron/db/schema.js");
const edb = new Database(edgeFile);
for (const m of MIGRATIONS) edb.exec(m.sql);

t("空库读出来是空的", readTimeline(edb, "").length === 0 && readStats(edb, "").total === 0);

const ins = edb.prepare(
  "INSERT INTO books (id, title, read_start, read_date, is_read, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);
const now = new Date().toISOString();
ins.run("e1", "跨年前一天", "2020-12-31", "2020-12-31", 1, 8, now, now);
ins.run("e2", "跨年后一天甲", "2021-01-01", "2021-01-01", 1, 6, now, now);
ins.run("e3", "跨年后一天乙", "2020-12-30", "2021-01-01", 1, null, now, now);
ins.run("e4", "只有开始", "2022-03-05", "", 1, null, now, now);
ins.run("e5", "标了已读没日期", "", "", 1, null, now, now);
ins.run("e6", "没读过", "", "", 0, null, now, now);
ins.run("e7", "漫画带日期", "2023-05-01", "2023-05-02", 1, null, now, now);
edb.prepare("UPDATE books SET media_type = '漫画' WHERE id = 'e7'").run();

const et = readTimeline(edb, "");
t("没结束时间的按开始那天落点", et.some((e) => e.id === "e4" && e.anchor === "2022-03-05" && !e.span));
t("标了已读没日期的不进时间线", !et.some((e) => e.id === "e5"));
t("没读过的不进时间线", !et.some((e) => e.id === "e6"));
t("漫画带日期也不进时间线", !et.some((e) => e.id === "e7"));
t("边界库共四条", et.length === 4, et.length + " 条");
const es = readStats(edb, "");
t("跨年那两天算连读", es.streak.days === 2 && es.streak.end === "2021-01-01", es.streak.days + " 天，止于 " + es.streak.end);
t("同一天两本是最忙的一天", es.busiest.day === "2021-01-01" && es.busiest.n === 2, es.busiest.day + " " + es.busiest.n);
t("跨年分在两个年", es.byYear.length === 2 && es.byYear.find((y) => y.year === 2020).n === 1 && es.byYear.find((y) => y.year === 2021).n === 2, JSON.stringify(es.byYear));
t("没填日期的算在 noDate 里", es.noDate === 1, es.noDate + "");
t("均分按有分的两本算", es.avgRating === 7, es.avgRating + "");
edb.close();

console.log("\n通过 " + ok + " 条，失败 " + bad + " 条");
db.close();
