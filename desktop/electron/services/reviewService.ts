import type { DB } from "../db";
import type { ReviewRow } from "../../shared/types";
import { seriesAuthor, seriesLabel, seriesTitle } from "./seriesService";

const BASE = `
SELECT r.id, r.book_id AS bookId, r.series_id AS seriesId, r.grade, r.md, r.file_name AS fileName,
       COALESCE(r.happened_at, r.updated_at) AS happenedAt,
       r.updated_at AS updatedAt,
       COALESCE(b.title, s.name, r.name, '') AS title,
       s.name AS seriesName,
       (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id = r.book_id ORDER BY ba.ord LIMIT 1) AS author
  FROM reviews r
  LEFT JOIN books b ON b.id = r.book_id
  LEFT JOIN series s ON s.id = r.series_id`;

function shape(rows: any[], kind: ReviewRow["kind"]): ReviewRow[] {
  return rows.map((r) => ({
    ...r,
    kind,
    seriesLabel: r.seriesName ? seriesLabel(r.seriesName) : undefined,
    author: r.author || ""
  }));
}

export function listReviews(db: DB): ReviewRow[] {
  const bookReviews = shape(
    db.prepare(`${BASE} WHERE r.deleted_at IS NULL AND r.book_id IS NOT NULL ORDER BY happenedAt DESC`).all(),
    "book"
  );

  /* 挂在系列上的总评，和单本书评同一张表，靠 series_id 区分 */
  const seriesReviews = shape(
    db.prepare(`${BASE} WHERE r.deleted_at IS NULL AND r.book_id IS NULL AND r.series_id IS NOT NULL ORDER BY happenedAt DESC`).all(),
    "series"
  );

  /* 新建时还没挂靠的草稿，既不属某本书也不属某个系列 */
  const drafts = shape(
    db.prepare(`${BASE} WHERE r.deleted_at IS NULL AND r.book_id IS NULL AND r.series_id IS NULL ORDER BY happenedAt DESC`).all(),
    "draft"
  );

  const orphans = (db
    .prepare(
      `SELECT id, NULL AS bookId, NULL AS seriesId, grade, md, file_name AS fileName,
              COALESCE(happened_at, updated_at) AS happenedAt,
              updated_at AS updatedAt,
              name, title_guess,
              CASE WHEN title_guess <> '' THEN title_guess ELSE name END AS title
         FROM orphan_reviews WHERE deleted_at IS NULL
        ORDER BY happenedAt DESC`
    )
    .all() as any[]).map((r) => ({ ...r, title: cleanLabel(r), kind: "orphan" as const }));

  return [...bookReviews, ...seriesReviews, ...drafts, ...orphans];
}

export function counts(db: DB): { books: number; reviews: number; orphans: number } {
  const one = (sql: string) => (db.prepare(sql).get() as any).n as number;
  return {
    books: one("SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL"),
    reviews: one("SELECT COUNT(*) AS n FROM reviews WHERE deleted_at IS NULL"),
    orphans: one("SELECT COUNT(*) AS n FROM orphan_reviews WHERE deleted_at IS NULL")
  };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * 未匹配书评的名字是当初那个文件的文件名，有的带着 demo 导出的 32 位哈希尾巴，
 * 直接拿来当文件名会生成「未匹配-《某某》 846d16….md」这种看不懂的东西。
 */
export function cleanLabel(o: { title_guess?: string; name?: string }): string {
  let s = String(o.title_guess || o.name || "书评");
  s = s
    .replace(/\.md$/i, "")
    .replace(/^未匹配[-_\s]*/, "")
    .replace(/[\s_-]+[0-9a-f]{16,}$/i, "")
    .trim();
  return s || "书评";
}

export interface ReviewInput {
  bookId?: string | null;
  seriesId?: number | null;
  name?: string;
  grade?: string;
  md?: string;
  happenedAt?: string;
}

export interface ReviewPatch {
  grade?: string;
  md?: string;
  happenedAt?: string;
  name?: string;
}

export interface RvResult {
  ok: boolean;
  id?: number;
  msg?: string;
}

function bookHasReview(db: DB, bookId: string, exceptId = 0): boolean {
  return !!db.prepare("SELECT 1 FROM reviews WHERE book_id = ? AND deleted_at IS NULL AND id <> ?").get(bookId, exceptId);
}

function seriesHasReview(db: DB, seriesId: number, exceptId = 0): boolean {
  return !!db
    .prepare("SELECT 1 FROM reviews WHERE series_id = ? AND deleted_at IS NULL AND id <> ?")
    .get(seriesId, exceptId);
}

/** 新建书评。bookId 与 seriesId 二选一，都不给就是挂在空处的草稿，先写正文再关联 */
export function createReview(db: DB, p: ReviewInput): RvResult {
  if (p.bookId && bookHasReview(db, p.bookId)) return { ok: false, msg: "这本书已经有书评了，直接改那一篇就行" };
  if (p.seriesId && seriesHasReview(db, p.seriesId)) return { ok: false, msg: "这个系列已经有总评了，直接改那一篇就行" };
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO reviews (book_id, series_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', 'app', ?, ?)`
    )
    .run(p.bookId || null, p.seriesId || null, p.name || "", p.md || "", p.grade || "normal", p.happenedAt || t, t, t);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/**
 * 改正文、评分、日期。未匹配书评在另一张表里，id 与 reviews 各从 1 起，
 * 不分表就按 id 写会把正文写到另一本书的书评上，所以 kind 必须由调用方交代清楚。
 */
export function updateReview(db: DB, kind: string, id: number, p: ReviewPatch): RvResult {
  const table = kind === "orphan" ? "orphan_reviews" : "reviews";
  const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!cur) return { ok: false, msg: kind === "orphan" ? "这条未匹配书评不在库里" : "这篇书评不在库里" };
  const sets: string[] = [];
  const vals: any[] = [];
  if (p.md !== undefined) (sets.push("md = ?"), vals.push(String(p.md)));
  if (p.grade !== undefined) (sets.push("grade = ?"), vals.push(String(p.grade)));
  if (p.happenedAt !== undefined) (sets.push("happened_at = ?"), vals.push(String(p.happenedAt)));
  if (p.name !== undefined) (sets.push("name = ?"), vals.push(String(p.name)));
  if (!sets.length) return { ok: true, id };
  sets.push("updated_at = ?");
  vals.push(now());
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return { ok: true, id };
}

export function deleteReview(db: DB, id: number): RvResult {
  const info = db.prepare("UPDATE reviews SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now(), now(), id);
  return info.changes ? { ok: true, id } : { ok: false, msg: "这篇书评不在库里" };
}

/**
 * 删未匹配书评。它和 reviews 是两张表，id 各从 1 起，
 * 拿同一套删除接口按 id 硬删会删到另一篇不相干的书评，所以单独开一个。
 */
export function deleteOrphan(db: DB, id: number): RvResult {
  const info = db
    .prepare("UPDATE orphan_reviews SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .run(now(), now(), id);
  return info.changes ? { ok: true, id } : { ok: false, msg: "这条未匹配书评不在库里" };
}

/** 未匹配的关联到某本书：正文搬进 reviews，原来那条打上删除标记，不做两份 */
export function associateOrphan(db: DB, orphanId: number, bookId: string): RvResult {
  const o = db.prepare("SELECT * FROM orphan_reviews WHERE id = ? AND deleted_at IS NULL").get(orphanId) as any;
  if (!o) return { ok: false, msg: "这条未匹配书评找不到了" };
  const bk = db.prepare("SELECT id FROM books WHERE id = ? AND deleted_at IS NULL").get(bookId) as any;
  if (!bk) return { ok: false, msg: "目标书不存在" };
  if (bookHasReview(db, bookId)) return { ok: false, msg: "这本书已经有书评了" };

  const t = now();
  const run = db.transaction(() => {
    /* file_name 不继承：未匹配那份的名字是按原始文件来的，挂上书之后要按书名重新起，
       继承了就会一直叫「未匹配-某某.md」，看起来像没改过名 */
    const info = db
      .prepare(
        `INSERT INTO reviews (book_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 'import', ?, ?)`
      )
      .run(bookId, cleanLabel(o), o.md || "", o.grade || "normal", o.happened_at || t, t, t);
    db.prepare("UPDATE orphan_reviews SET deleted_at = ?, updated_at = ? WHERE id = ?").run(t, t, orphanId);
    return Number(info.lastInsertRowid);
  });
  const id = run();
  return { ok: true, id };
}

/** 未匹配那条变成系列总评。系列名才是归属，原来的书名留给正文 */
export function associateOrphanToSeries(db: DB, orphanId: number, seriesId: number): RvResult {
  const o = db.prepare("SELECT * FROM orphan_reviews WHERE id = ? AND deleted_at IS NULL").get(orphanId) as any;
  if (!o) return { ok: false, msg: "这条未匹配书评找不到了" };
  const s = db.prepare("SELECT id FROM series WHERE id = ?").get(seriesId) as any;
  if (!s) return { ok: false, msg: "目标系列不存在" };
  if (seriesHasReview(db, seriesId)) return { ok: false, msg: "这个系列已经有总评了" };

  const t = now();
  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO reviews (series_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 'import', ?, ?)`
      )
      .run(seriesId, cleanLabel(o), o.md || "", o.grade || "normal", o.happened_at || t, t, t);
    db.prepare("UPDATE orphan_reviews SET deleted_at = ?, updated_at = ? WHERE id = ?").run(t, t, orphanId);
    return Number(info.lastInsertRowid);
  });
  const id = run();
  return { ok: true, id };
}

/** 把已有书评换到另一本书上 */
export function moveReview(db: DB, id: number, bookId: string): RvResult {
  const cur = db.prepare("SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  if (!cur) return { ok: false, msg: "这篇书评不在库里" };
  if (bookHasReview(db, bookId, id)) return { ok: false, msg: "目标书已经有书评了" };
  db.prepare("UPDATE reviews SET book_id = ?, series_id = NULL, updated_at = ? WHERE id = ?").run(bookId, now(), id);
  return { ok: true, id };
}

/** 书评搬到系列上，变成整个系列的总评。一稿只挂一处，来源那份随之转入系列 */
export function moveReviewToSeries(db: DB, id: number, seriesId: number): RvResult {
  const cur = db.prepare("SELECT * FROM reviews WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  if (!cur) return { ok: false, msg: "这篇书评不在库里" };
  if (seriesHasReview(db, seriesId, id)) return { ok: false, msg: "这个系列已经有总评了" };
  db.prepare("UPDATE reviews SET book_id = NULL, series_id = ?, updated_at = ? WHERE id = ?").run(seriesId, now(), id);
  return { ok: true, id };
}

export function moveReviewToBook(db: DB, id: number, bookId: string): RvResult {
  const cur = db.prepare("SELECT id FROM reviews WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  if (!cur) return { ok: false, msg: "这篇书评不在库里" };
  if (bookHasReview(db, bookId, id)) return { ok: false, msg: "目标书已经有书评了" };
  db.prepare("UPDATE reviews SET book_id = ?, series_id = NULL, updated_at = ? WHERE id = ?").run(bookId, now(), id);
  return { ok: true, id };
}

/** 供导出与同步用：一篇书评该叫什么文件名 */
export function reviewFileName(db: DB, r: { kind: string; id: number }): string {
  if (r.kind === "orphan") {
    const o = db.prepare("SELECT name, title_guess, file_name FROM orphan_reviews WHERE id = ?").get(r.id) as any;
    if (!o) return "";
    const base = o.file_name ? String(o.file_name).replace(/\.md$/i, "") : "";
    /* 原文件名干净就照用，带哈希尾巴的按书名重起一个 */
    if (base && !/[\s_-][0-9a-f]{16,}$/i.test(base)) return sanitizeFile(base + ".md");
    return sanitizeFile("未匹配-" + cleanLabel(o) + ".md");
  }
  const row = db.prepare(`${BASE} WHERE r.id = ?`).get(r.id) as any;
  if (!row) return "";
  if (row.fileName) return row.fileName;
  if (row.seriesId) {
    /* 系列总评跟单本一个规矩：作者打头，中期是系列名，尾巴写「系列」 */
    const au = seriesAuthor(db, row.seriesId);
    const head = au ? au + "-" : "";
    return sanitizeFile(head + seriesTitle(row.seriesName) + "系列.md");
  }
  const author = row.author ? row.author + "-" : "";
  return sanitizeFile(author + "《" + (row.title || "未命名") + "》书评.md");
}

export function sanitizeFile(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}
