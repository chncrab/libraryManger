import type { DB } from "../db";
import type { ReadEntry, ReadStats } from "../../shared/types";
import { seriesDisplay } from "../../shared/seriesText";

/**
 * 阅读时间线与日历的数据。只读，不建表、不加索引、不写库。
 *
 * 落点一律取 read_date（读完那天）。read_start 空着的按当天读完处理，
 * 起止相同，界面不必分辨「没填开始」与「一天读完」这两种，看着都是当天。
 * is_read 不参与筛选，填了日期就算读过，标没标已读不影响它出现在时间线上。
 *
 * 只算小说。漫画那 168 本没有逐本阅读记录，给了日期也是猜的，
 * 所以漫画一概不收，接上来的 media 参数留着不筛，界面传什么都不影响。
 */

/** 时间线收哪些书：小说，且读完那天或开始那天填了其中一个 */
function scope(): { where: string; args: any[] } {
  return {
    where: `b.deleted_at IS NULL AND b.media_type = '小说' AND (b.read_date <> '' OR b.read_start <> '')`,
    args: []
  };
}

/** 起止之间差几天，当天读完算 1 天 */
function spanDays(start: string, end: string): number {
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function splitList(v: unknown): string[] {
  return v ? String(v).split("、").filter(Boolean) : [];
}

/**
 * 全部条目一次给全，不分页。
 * SQL 只负责按结束日期倒序，同一天里的先后在 JS 里按册序与书名定，
 * 与别处一样走 localeCompare，不用 SQL 的字节序。
 */
export function readTimeline(db: DB, _media = ""): ReadEntry[] {
  const { where, args } = scope();
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.read_date, b.read_start, b.rating, b.cover_file, b.updated_at,
              b.media_type, b.series_index, s.name AS series_name, s.zh_name AS series_zh,
              (SELECT group_concat(a.name, '、') FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                 WHERE ba.book_id = b.id) AS authors_text,
              (SELECT r.grade FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL) AS review_grade
       FROM books b
       LEFT JOIN series s ON s.id = b.series_id
       WHERE ${where}
       ORDER BY COALESCE(NULLIF(b.read_date, ''), b.read_start) DESC`
    )
    .all(...args) as any[];

  const list: ReadEntry[] = rows.map((r) => {
    const end = String(r.read_date || "");
    const start = String(r.read_start || "") || end;
    const anchor = end || start;
    const days = spanDays(start, anchor);
    return {
      id: r.id,
      title: r.title,
      authors: splitList(r.authors_text),
      seriesName: r.series_name ? seriesDisplay(r.series_zh, r.series_name) : "",
      seriesIndex: r.series_index == null ? null : Number(r.series_index),
      cover: r.cover_file || "",
      coverV: r.updated_at || "",
      rating: r.rating == null ? null : Number(r.rating),
      start,
      end,
      anchor,
      days,
      span: days > 1,
      reviewGrade: r.review_grade || null
    };
  });

  /* 同一天的按册序、书名，跨年的长空档不影响这里，日期已由 SQL 排好 */
  list.sort((a, b) => {
    if (a.anchor !== b.anchor) return a.anchor < b.anchor ? 1 : -1;
    const ai = a.seriesIndex == null ? 1e9 : a.seriesIndex;
    const bi = b.seriesIndex == null ? 1e9 : b.seriesIndex;
    if (ai !== bi) return ai - bi;
    return a.title.localeCompare(b.title, "zh");
  });
  return list;
}

/** 最长连读：把有日期的天按先后排好，相邻差一天算连着，取最长那段 */
function longestStreak(days: string[]): { days: number; end: string } {
  let best = { days: 0, end: "" };
  let cur = 0;
  let prev = "";
  for (const d of days) {
    const t = Date.parse(d + "T00:00:00Z");
    const p = prev ? Date.parse(prev + "T00:00:00Z") : NaN;
    cur = Number.isFinite(p) && t - p === 86400000 ? cur + 1 : 1;
    if (cur > best.days) best = { days: cur, end: d };
    prev = d;
  }
  return best;
}

/**
 * 顶栏那几个数。按日计数在 SQL 里分组，界面不做遍历聚合，
 * 日历一格要几个数就直接查这张表。
 */
export function readStats(db: DB, _media = ""): ReadStats {
  const { where, args } = scope();
  const base = `FROM books b WHERE ${where}`;

  const total = Number((db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args) as any).n);
  const first = (db.prepare(`SELECT MIN(read_date) AS d ${base} AND read_date <> ''`).get(...args) as any).d || "";
  const last = (db.prepare(`SELECT MAX(read_date) AS d ${base} AND read_date <> ''`).get(...args) as any).d || "";
  const avg = (db.prepare(`SELECT AVG(rating) AS a ${base} AND rating IS NOT NULL AND rating > 0`).get(...args) as any).a;

  const byDay = (
    db.prepare(`SELECT read_date AS day, COUNT(*) AS n ${base} AND read_date <> '' GROUP BY read_date ORDER BY read_date`).all(...args) as any[]
  ).map((r) => ({ day: String(r.day), n: Number(r.n) }));

  const byYearMap = new Map<string, number>();
  for (const r of byDay) {
    const y = r.day.slice(0, 4);
    byYearMap.set(y, (byYearMap.get(y) || 0) + r.n);
  }
  const byYear = [...byYearMap.entries()]
    .map(([y, n]) => ({ year: Number(y), n }))
    .sort((a, b) => b.year - a.year);

  let busiest: { day: string; n: number } | null = null;
  for (const r of byDay) {
    if (!busiest || r.n > busiest.n || (r.n === busiest.n && r.day > busiest.day)) busiest = r;
  }

  const year = String(new Date().getFullYear());
  const yearRead = byYearMap.get(year) || 0;

  /* 标了已读却一个日期都没填，落不到时间轴上，统计条里要报一句。
     只数小说，漫画没日期是常态，不往这上面挂 */
  const noDate = Number(
    (db
      .prepare(
        "SELECT COUNT(*) AS n FROM books b WHERE b.deleted_at IS NULL AND b.media_type = '小说' AND b.is_read = 1 AND b.read_date = '' AND b.read_start = ''"
      )
      .get() as any).n
  );

  return {
    total,
    yearRead,
    byYear,
    byDay,
    first,
    last,
    busiest,
    avgRating: avg == null ? null : Math.round(Number(avg) * 10) / 10,
    streak: longestStreak(byDay.map((d) => d.day)),
    noDate
  };
}
