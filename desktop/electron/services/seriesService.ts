import type { DB } from "../db";
import type { BookRow, SeriesInfo } from "../../shared/types";
import { listBooks } from "./bookService";

/** 系列名里尾部的「系列 / シリーズ」是资料里带的分类词，界面上不显示 */
export function seriesLabel(name: string): string {
  return String(name || "")
    .replace(/\s*(シリーズ|系列)\s*$/i, "")
    .trim() || String(name || "");
}

/** 系列名本身可能已经带书名号，外面就不要再套一层《》 */
export function seriesTitle(name: string): string {
  const s = seriesLabel(name);
  return /^[《〈【]/.test(s) ? s : "《" + s + "》";
}

/**
 * 系列集合一格格的数据。册数与均分只算在架书，均分只算读过且打过分的那几册。
 * 封面取系列里册序最靠前、且有封面的一本。
 */
export function listSeries(db: DB, mediaType = ""): SeriesInfo[] {
  const on = !!mediaType && mediaType !== "全部";
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.media_type AS mediaType,
              COUNT(b.id) AS n,
              SUM(CASE WHEN b.is_read = 1 THEN 1 ELSE 0 END) AS read,
              AVG(CASE WHEN b.is_read = 1 AND b.rating > 0 THEN b.rating END) AS avg,
              MAX(b.updated_at) AS updatedAt
         FROM series s
         JOIN books b ON b.series_id = s.id AND b.deleted_at IS NULL
        ${on ? "WHERE s.media_type = ?" : ""}
        GROUP BY s.id
        ORDER BY n DESC, s.name`
    )
    .all(...(on ? [mediaType] : [])) as any[];

  const covers = db
    .prepare(
      `SELECT series_id AS sid, cover_file AS file
         FROM books
        WHERE series_id IS NOT NULL AND deleted_at IS NULL AND cover_file <> ''
        ORDER BY series_index IS NULL, series_index, title`
    )
    .all() as any[];
  const coverOf = new Map<number, string>();
  for (const c of covers) if (!coverOf.has(c.sid)) coverOf.set(c.sid, c.file);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    label: seriesLabel(r.name),
    mediaType: r.mediaType,
    n: r.n,
    read: r.read || 0,
    avg: r.avg == null ? null : Number(r.avg),
    cover: coverOf.get(r.id) || "",
    updatedAt: r.updatedAt || ""
  }));
}

/** 系列内的书按册序排，方便弹层里从上到下看 */
export function seriesBooks(db: DB, id: number): BookRow[] {
  return listBooks(db, { seriesId: id, sorts: [{ key: "index", dir: 1 }], limit: 2000 }).rows;
}

/** 系列的主作者：册序最靠前那本的作者。系列总评的文件名拿它起头 */
export function seriesAuthor(db: DB, id: number): string {
  const r = db
    .prepare(
      `SELECT (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
         FROM books b
        WHERE b.series_id = ? AND b.deleted_at IS NULL
        ORDER BY b.series_index IS NULL, b.series_index, b.title
        LIMIT 1`
    )
    .get(id) as any;
  return r && r.author ? String(r.author) : "";
}

export function seriesReviewOf(db: DB, id: number): { id: number; md: string; grade: string } | null {
  const r = db
    .prepare("SELECT id, md, grade FROM reviews WHERE series_id = ? AND book_id IS NULL AND deleted_at IS NULL")
    .get(id) as any;
  return r ? { id: r.id, md: r.md || "", grade: r.grade || "normal" } : null;
}
