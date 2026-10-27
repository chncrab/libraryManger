import type { DB } from "./index";

/**
 * 全文索引的重建。FTS 是独立表，改了标题作者这些列它不会自动跟，
 * 每次写完都得整行重写一遍。
 *
 * 放在 db 目录里而不是某个 service，是因为开库的迁移流程也要用它，
 * 依赖 service 会绕成环。
 */

/** 自定义字段里勾了可搜索的那些，值拼成一串塞进 extra 列 */
function extraOf(db: DB, id: string): string {
  const rows = db
    .prepare(
      `SELECT v.val FROM book_field_values v JOIN fields f ON f.id = v.field_id
        WHERE v.book_id = ? AND f.searchable = 1 AND f.deleted_at IS NULL AND v.val <> ''
        ORDER BY f.ord, v.ord`
    )
    .all(id) as any[];
  return rows.map((r) => String(r.val)).join(" ");
}

export function rebuildFts(db: DB, id: string): void {
  const r = db
    .prepare(
      `SELECT b.rowid AS rid, b.title, b.subtitle, b.original_title, b.note,
              COALESCE(s.name, '') AS series,
              (SELECT group_concat(a.name, '、') FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                 WHERE ba.book_id = b.id) AS authors
         FROM books b LEFT JOIN series s ON s.id = b.series_id WHERE b.id = ?`
    )
    .get(id) as any;
  if (!r) return;
  db.prepare("DELETE FROM books_fts WHERE rowid = ?").run(r.rid);
  db.prepare(
    "INSERT INTO books_fts (rowid, title, subtitle, original_title, authors, series, note, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    r.rid,
    r.title || "",
    r.subtitle || "",
    r.original_title || "",
    r.authors || "",
    r.series || "",
    r.note || "",
    extraOf(db, id)
  );
}

/** 全库重建。迁移新建了索引表、或者索引被外部改坏时用 */
export function rebuildAllFts(db: DB): number {
  const ids = db.prepare("SELECT id FROM books WHERE deleted_at IS NULL").all() as any[];
  const run = db.transaction(() => {
    db.prepare("DELETE FROM books_fts").run();
    for (const r of ids) rebuildFts(db, String(r.id));
  });
  run();
  return ids.length;
}

/**
 * 索引空了而书还在，说明刚建过表或者被清过，补一遍。
 * 开库时调一次，代价是一千多行的整表读，几秒钟。
 */
export function ensureFts(db: DB): void {
  const index = (db.prepare("SELECT COUNT(*) AS n FROM books_fts").get() as any).n as number;
  if (index > 0) return;
  const live = (db.prepare("SELECT COUNT(*) AS n FROM books WHERE deleted_at IS NULL").get() as any).n as number;
  if (live > 0) rebuildAllFts(db);
}
