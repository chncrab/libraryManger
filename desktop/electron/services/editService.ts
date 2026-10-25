import type { DB } from "../db";
import type { BookPatch, BookRow } from "../../shared/types";
import { getBook } from "./bookService";
import { copyCoverFor, renameCoverFor } from "./coverService";

/** 实体书的取值域，写库前要过滤，避免手打错字造出脏值 */
export const STATE_VALUES = ["实体", "私印", "预定中", "购物车", "无"];

function now(): string {
  return new Date().toISOString();
}

/** 找一个系列，没有就按媒介建一个。系列名空串表示脱离系列 */
function resolveSeries(db: DB, name: string, mediaType: string): number | null {
  const n = name.trim();
  if (!n) return null;
  const hit = db.prepare("SELECT id FROM series WHERE media_type = ? AND name = ?").get(mediaType, n) as any;
  if (hit) return hit.id;
  const info = db.prepare("INSERT INTO series (media_type, name) VALUES (?, ?)").run(mediaType, n);
  return Number(info.lastInsertRowid);
}

function findOrCreateCategory(db: DB, name: string): number {
  const n = name.trim();
  const hit = db.prepare("SELECT id FROM categories WHERE name = ?").get(n) as any;
  if (hit) return hit.id;
  const maxOrd = (db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM categories WHERE parent_id IS NULL").get() as any).m;
  const info = db.prepare("INSERT INTO categories (name, tier, ord, parent_id) VALUES (?, 0, ?, NULL)").run(n, maxOrd + 1);
  return Number(info.lastInsertRowid);
}

function findOrCreateAuthor(db: DB, name: string): number {
  const n = name.trim();
  const hit = db.prepare("SELECT id FROM authors WHERE name = ?").get(n) as any;
  if (hit) return hit.id;
  const info = db.prepare("INSERT INTO authors (name) VALUES (?)").run(n);
  return Number(info.lastInsertRowid);
}

/** FTS 是独立表，改了书名作者系列备注必须整行重写，否则搜索还是旧词 */
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
    "INSERT INTO books_fts (rowid, title, subtitle, original_title, authors, series, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(r.rid, r.title || "", r.subtitle || "", r.original_title || "", r.authors || "", r.series || "", r.note || "");
}

/**
 * 全字段更新。只写传进来的字段，没传的保持原值。
 * 作者、分类、实体书是多对多，传进来就整组重写。
 */
export function updateBook(db: DB, id: string, p: BookPatch, coversDir = ""): BookRow | null {
  const cur = db.prepare("SELECT * FROM books WHERE id = ?").get(id) as any;
  if (!cur) return null;
  /* 封面文件跟着作者、书名、系列序号走，这几项动过就要重算文件名 */
  const renameCover =
    !!coversDir &&
    (p.title !== undefined || p.seriesIndex !== undefined || p.seriesName !== undefined || p.authors !== undefined);

  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any) => {
    sets.push(col + " = ?");
    vals.push(v);
  };

  if (p.title !== undefined) put("title", String(p.title).trim() || cur.title);
  if (p.subtitle !== undefined) put("subtitle", String(p.subtitle).trim());
  if (p.originalTitle !== undefined) put("original_title", String(p.originalTitle).trim());
  if (p.originalSubtitle !== undefined) put("original_subtitle", String(p.originalSubtitle).trim());
  if (p.mediaType !== undefined && p.mediaType) put("media_type", p.mediaType);
  if (p.country !== undefined) put("country", String(p.country).trim());
  if (p.publishDate !== undefined) {
    const d = String(p.publishDate).trim();
    put("publish_date", d);
    const m = d.match(/^(\d{4})/);
    put("publish_year", m ? Number(m[1]) : null);
  }
  if (p.isRead !== undefined) put("is_read", p.isRead ? 1 : 0);
  if (p.readDate !== undefined) put("read_date", String(p.readDate).trim());
  if (p.rating !== undefined) put("rating", p.rating == null || p.rating <= 0 ? null : p.rating);
  if (p.ebookState !== undefined) put("ebook_state", String(p.ebookState).trim());
  if (p.note !== undefined) put("note", String(p.note));
  if (p.seriesIndex !== undefined) put("series_index", p.seriesIndex == null ? null : p.seriesIndex);
  if (p.seriesName !== undefined) {
    const media = p.mediaType || cur.media_type;
    put("series_id", resolveSeries(db, String(p.seriesName), media));
  } else if (p.mediaType !== undefined && p.mediaType !== cur.media_type && cur.series_id) {
    /* 换媒介时系列也要跟着换到新媒介那一条，否则系列视图里小说漫画串了 */
    const s = db.prepare("SELECT name FROM series WHERE id = ?").get(cur.series_id) as any;
    put("series_id", s ? resolveSeries(db, s.name, p.mediaType) : null);
  }
  if (p.coverFile !== undefined) put("cover_file", String(p.coverFile));

  const run = db.transaction(() => {
    if (sets.length) {
      put("updated_at", now());
      db.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    }
    if (p.authors) {
      const names = p.authors.map((s) => s.trim()).filter(Boolean);
      db.prepare("DELETE FROM book_authors WHERE book_id = ?").run(id);
      const ins = db.prepare("INSERT OR IGNORE INTO book_authors (book_id, author_id, role, ord) VALUES (?, ?, '著', ?)");
      names.forEach((n, i) => ins.run(id, findOrCreateAuthor(db, n), i));
    }
    if (p.categories) {
      const names = [...new Set(p.categories.map((s) => s.trim()).filter(Boolean))];
      db.prepare("DELETE FROM book_categories WHERE book_id = ?").run(id);
      const ins = db.prepare("INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)");
      for (const n of names) ins.run(id, findOrCreateCategory(db, n));
    }
    if (p.states) {
      const names = [...new Set(p.states.filter((s) => STATE_VALUES.includes(s)))];
      db.prepare("DELETE FROM book_states WHERE book_id = ?").run(id);
      const ins = db.prepare("INSERT OR IGNORE INTO book_states (book_id, state) VALUES (?, ?)");
      for (const n of names) ins.run(id, n);
    }
    rebuildFts(db, id);
  });
  run();
  if (renameCover) renameCoverFor(db, id, coversDir);
  return getBook(db, id);
}

/** 只标已读或改评分时走这条，省掉全量重写 */
export function setRead(db: DB, id: string, read: boolean): boolean {
  db.prepare("UPDATE books SET is_read = ?, updated_at = ? WHERE id = ?").run(read ? 1 : 0, now(), id);
  return true;
}

export function setRating(db: DB, id: string, rating: number | null): boolean {
  db.prepare("UPDATE books SET rating = ?, updated_at = ? WHERE id = ?").run(rating == null || rating <= 0 ? null : rating, now(), id);
  return true;
}

/** 删除是软删，deleted_at 一置列表就不再出现，误删还能恢复 */
export function deleteBook(db: DB, id: string): boolean {
  const info = db.prepare("UPDATE books SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now(), now(), id);
  return info.changes > 0;
}

export function restoreBook(db: DB, id: string): boolean {
  const info = db.prepare("UPDATE books SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  return info.changes > 0;
}

/** 副本标题顺延：已带（N）就加一，否则补（1）；(1) 这种半角括号也认 */
function nextCopyTitle(db: DB, base: string): string {
  const m = base.match(/^(.*?)\s*[（(](\d+)[)）]\s*$/);
  const stem = m ? m[1] : base;
  let n = m ? Number(m[2]) + 1 : 1;
  const taken = new Set(
    (db.prepare("SELECT title FROM books WHERE deleted_at IS NULL AND title LIKE ?").all(stem + "%") as any[]).map((r) => r.title)
  );
  while (taken.has(stem + "（" + n + "）")) n++;
  return stem + "（" + n + "）";
}

/** 复制条目：整套关联一起复制。给了封面目录就连图片复制一份，改副本的封面不动原书 */
export function copyBook(db: DB, id: string, coversDir = ""): BookRow | null {
  const src = db.prepare("SELECT * FROM books WHERE id = ? AND deleted_at IS NULL").get(id) as any;
  if (!src) return null;
  const nid = "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO books (id, title, subtitle, original_title, original_subtitle, media_type, series_id, series_index,
         country, is_mystery, publish_date, publish_year, is_read, read_date, rating, ebook_state, note, cover_file,
         source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nid, nextCopyTitle(db, src.title), src.subtitle, src.original_title, src.original_subtitle, src.media_type,
      src.series_id, src.series_index, src.country, src.is_mystery, src.publish_date, src.publish_year,
      src.is_read, src.read_date, src.rating, src.ebook_state, src.note, src.cover_file, "local", now(), now()
    );
    db.prepare("INSERT OR IGNORE INTO book_authors (book_id, author_id, role, ord) SELECT ?, author_id, role, ord FROM book_authors WHERE book_id = ?").run(nid, id);
    db.prepare("INSERT OR IGNORE INTO book_categories (book_id, category_id) SELECT ?, category_id FROM book_categories WHERE book_id = ?").run(nid, id);
    db.prepare("INSERT OR IGNORE INTO book_states (book_id, state) SELECT ?, state FROM book_states WHERE book_id = ?").run(nid, id);
    rebuildFts(db, nid);
  });
  run();
  if (coversDir) copyCoverFor(db, id, nid, coversDir);
  return getBook(db, nid);
}

/** 批量复制：一次事务里连着建，中途出错整批回滚，不留半套副本 */
export function copyBooks(db: DB, ids: string[], coversDir = ""): BookRow[] {
  const out: BookRow[] = [];
  const run = db.transaction(() => {
    for (const id of ids) {
      const b = copyBook(db, id, coversDir);
      if (b) out.push(b);
    }
  });
  run();
  return out;
}
