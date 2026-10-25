/** 把已有库里的「系列书评」从未匹配池挂回对应系列。用法：node scripts/attach-series-reviews.mjs [--dry] */
import Database from "better-sqlite3";
import path from "node:path";
import { planSeriesMatches, applySeriesMatches } from "./series-match.mjs";

const DB = process.env.LIBRARY_DB || path.join(process.env.APPDATA || process.cwd(), "藏书库", "library.db");
const dry = process.argv.includes("--dry");

const db = new Database(DB);
db.pragma("foreign_keys = ON");
const orphans = db.prepare("SELECT id, name, md, file_name FROM orphan_reviews WHERE deleted_at IS NULL").all();
const series = db.prepare("SELECT id, name, display_name, media_type FROM series").all();
const plan = planSeriesMatches(orphans, series);

console.log("库", DB);
console.log("未匹配", orphans.length, "篇 | 系统系列", series.length, "个 | 可挂靠", plan.length, "篇");
for (const p of plan) console.log("  挂", p.name, "→ 系列#" + p.seriesId, p.seriesName);
if (dry) {
  console.log("--dry 只看不写");
} else {
  const done = applySeriesMatches(db, plan);
  console.log("已搬", done.length, "篇为系列书评");
}
db.close();
