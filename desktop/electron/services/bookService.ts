import type { DB } from "../db";
import type { BookQuery, BookRow, ListResult, Facets, SortSpec } from "../../shared/types";

/* 多字段排序：每个 key 对应一个可比较的表达式，方向另加。
   评分与读过日期这类有大量空值，空值统一沉到最后，不随升降序翻面 */
const ORDER_COL: Record<string, string> = {
  title: "b.title COLLATE NOCASE",
  author:
    "(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) COLLATE NOCASE",
  series: "COALESCE(s.name, '') COLLATE NOCASE",
  index: "b.series_index",
  rating: "b.rating",
  read: "b.read_date",
  year: "b.publish_year",
  updated: "b.updated_at",
  grade:
    "CASE (SELECT r.grade FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL) WHEN 'god' THEN 0 WHEN 'normal' THEN 1 WHEN 'bad' THEN 2 ELSE 3 END"
};

const NULL_LAST = new Set(["rating", "read", "year", "index", "grade"]);

export function orderBy(sorts?: SortSpec[]): string {
  const list = sorts && sorts.length ? sorts : [{ key: "title", dir: 1 } as SortSpec];
  const parts: string[] = [];
  for (const s of list) {
    const col = ORDER_COL[s.key];
    if (!col) continue;
    if (NULL_LAST.has(s.key)) parts.push(`(${col} IS NULL) ASC`);
    parts.push(col + (s.dir === -1 ? " DESC" : " ASC"));
  }
  if (!parts.length) parts.push("b.title COLLATE NOCASE ASC");
  return parts.join(", ");
}

const SELECT_ROW = `
SELECT b.id, b.title, b.subtitle, b.original_title, b.original_subtitle, b.media_type,
       b.series_id, b.series_index, b.country, b.is_mystery, b.publish_date, b.publish_year,
       b.is_read, b.read_date, b.rating, b.ebook_state, b.note, b.cover_file, b.updated_at,
       s.name AS series_name,
       (SELECT group_concat(a.name, '、') FROM book_authors ba JOIN authors a ON a.id = ba.author_id
          WHERE ba.book_id = b.id) AS authors_text,
       (SELECT group_concat(c.name, '、') FROM book_categories bc JOIN categories c ON c.id = bc.category_id
          WHERE bc.book_id = b.id) AS cats_text,
       (SELECT group_concat(bs.state, '、') FROM book_states bs WHERE bs.book_id = b.id) AS states_text,
       (SELECT r.grade FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL) AS review_grade
FROM books b
LEFT JOIN series s ON s.id = b.series_id`;

function splitList(v: unknown): string[] {
  return v ? String(v).split("、").filter(Boolean) : [];
}

function toRow(r: any): BookRow {
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    originalTitle: r.original_title,
    originalSubtitle: r.original_subtitle,
    mediaType: r.media_type,
    seriesId: r.series_id,
    seriesName: r.series_name || "",
    seriesIndex: r.series_index,
    country: r.country,
    isMystery: !!r.is_mystery,
    publishDate: r.publish_date,
    publishYear: r.publish_year,
    isRead: !!r.is_read,
    readDate: r.read_date,
    rating: r.rating,
    ebookState: r.ebook_state,
    note: r.note,
    cover: r.cover_file || "",
    authors: splitList(r.authors_text),
    categories: splitList(r.cats_text),
    states: splitList(r.states_text),
    reviewGrade: r.review_grade || null
  };
}

function ftsQuery(q: string): string {
  /* trigram 索引按三字符切，词本身必须加引号当短语，否则标点会被当语法 */
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => '"' + w.replace(/"/g, '""') + '"')
    .join(" AND ");
}

/** 把选中的分类名展开成「自身加全部后代」。库里就几十条，直接内存里走 */
export function expandCategories(db: DB, names: string[]): string[] {
  const all = db.prepare("SELECT id, name, parent_id AS parentId FROM categories").all() as any[];
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parentId == null || out.has(c.name)) continue;
      const p = all.find((x) => x.id === c.parentId);
      if (p && out.has(p.name)) {
        out.add(c.name);
        grew = true;
      }
    }
  }
  return [...out];
}

export function listBooks(db: DB, q: BookQuery): ListResult {
  const where: string[] = ["b.deleted_at IS NULL"];
  const params: any[] = [];

  const kw = (q.q || "").trim();
  if (kw) {
    if (kw.length >= 3) {
      where.push("b.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)");
      params.push(ftsQuery(kw));
    } else {
      where.push("(b.title LIKE ? OR b.original_title LIKE ? OR b.subtitle LIKE ? OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id AND a.name LIKE ?))");
      const like = "%" + kw + "%";
      params.push(like, like, like, like);
    }
  }
  if (q.media && q.media !== "全部") {
    where.push("b.media_type = ?");
    params.push(q.media);
  }
  if (q.seriesId) {
    where.push("b.series_id = ?");
    params.push(q.seriesId);
  }
  if (q.read === "read") where.push("b.is_read = 1");
  if (q.read === "unread") where.push("b.is_read = 0");
  if (q.read === "rated") where.push("b.rating IS NOT NULL AND b.rating > 0");
  if (q.noCover === true) where.push("b.cover_file = ''");
  if (q.noCover === false) where.push("b.cover_file <> ''");
  if (q.categories && q.categories.length) {
    /* 大分类只是分组，书挂在叶子标签上。点「题材」要把旗下所有标签的书一起算进来 */
    const picked = expandCategories(db, q.categories);
    const marks = picked.map(() => "?").join(",");
    where.push(
      `b.id IN (SELECT bc.book_id FROM book_categories bc JOIN categories c ON c.id = bc.category_id WHERE c.name IN (${marks}))`
    );
    params.push(...picked);
  }
  if (q.states && q.states.length) {
    const marks = q.states.map(() => "?").join(",");
    where.push(`b.id IN (SELECT book_id FROM book_states WHERE state IN (${marks}))`);
    params.push(...q.states);
  }
  if (q.ebook && q.ebook.length) {
    const marks = q.ebook.map(() => "?").join(",");
    where.push(`b.ebook_state IN (${marks})`);
    params.push(...q.ebook);
  }
  if (q.decades && q.decades.length) {
    where.push("(" + q.decades.map(() => "b.publish_year BETWEEN ? AND ?").join(" OR ") + ")");
    for (const d of q.decades) params.push(d, d + 9);
  }

  /* 高级筛选：区间与存在性条件，留空的那一项不加 */
  const adv = q.adv;
  if (adv) {
    if (adv.ratingMin != null) (where.push("b.rating >= ?"), params.push(adv.ratingMin));
    if (adv.ratingMax != null) (where.push("b.rating <= ?"), params.push(adv.ratingMax));
    if (adv.yearFrom != null) (where.push("b.publish_year >= ?"), params.push(adv.yearFrom));
    if (adv.yearTo != null) (where.push("b.publish_year <= ?"), params.push(adv.yearTo));
    if (adv.hasReview === true)
      where.push("EXISTS (SELECT 1 FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL)");
    if (adv.hasReview === false)
      where.push("NOT EXISTS (SELECT 1 FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL)");
    const note = String(adv.note || "").trim();
    if (note) (where.push("b.note LIKE ?"), params.push("%" + note + "%"));
  }

  const sqlWhere = where.length ? " WHERE " + where.join(" AND ") : "";
  const order = orderBy(q.sorts);
  const limit = Math.min(Math.max(q.limit || 120, 1), 2000);
  const offset = Math.max(q.offset || 0, 0);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM books b LEFT JOIN series s ON s.id = b.series_id${sqlWhere}`).get(...params) as any).n;
  const rows = db
    .prepare(`${SELECT_ROW}${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(toRow);

  return { total, rows };
}

export function getBook(db: DB, id: string): BookRow | null {
  const r = db.prepare(`${SELECT_ROW} WHERE b.id = ?`).get(id);
  return r ? toRow(r) : null;
}

export function reviewOf(db: DB, id: string): { md: string; grade: string; happenedAt: string } | null {
  const r = db.prepare("SELECT md, grade, happened_at, updated_at FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(id) as any;
  if (!r) return null;
  return { md: r.md || "", grade: r.grade || "normal", happenedAt: r.happened_at || r.updated_at || "" };
}

/* 左栏每一项的计数都跟着当前媒介走：切到漫画，「分类」「系列」里的数字就是漫画的，
   和右侧列表对得上。media 为空或「全部」时不加这层条件 */
export function facets(db: DB, media = ""): Facets {
  const on = !!media && media !== "全部";
  const scope = "b.deleted_at IS NULL" + (on ? " AND b.media_type = ?" : "");
  /* 同一条语句里 scope 可能出现两次，占位符几个就补几个参数 */
  const all = (sql: string, times = 1) => db.prepare(sql).all(...(on ? Array(times).fill(media) : [])) as any[];

  return {
    /* 媒介自身那一档不受媒介筛选影响，永远给全量，且这条语句没有占位符，不能带上参数 */
    media: db
      .prepare("SELECT media_type AS name, COUNT(*) AS n FROM books WHERE deleted_at IS NULL GROUP BY media_type ORDER BY n DESC")
      .all() as any[],
    read: all(
      `SELECT name, COUNT(*) AS n FROM (
         SELECT CASE WHEN b.is_read = 1 THEN '已读' ELSE '未读' END AS name FROM books b WHERE ${scope}
         UNION ALL
         SELECT '有评分' AS name FROM books b WHERE ${scope} AND b.rating > 0
       ) GROUP BY name`,
      2
    ),
    cover: all(
      `SELECT CASE WHEN b.cover_file = '' THEN '无封面' ELSE '有封面' END AS name, COUNT(*) AS n
         FROM books b WHERE ${scope} GROUP BY b.cover_file = ''`
    ),
    /* 分类要把没有书的大分类也带回来，否则左栏摆不出分组标题。
       数字按整个子树去重统计，一本书挂了同组的两个标签也只算一次，
       否则「题材」这类父级会把 1245 本的书库数出 1249 来 */
    categories: all(
      `SELECT c.id, c.name, c.tier, c.ord, c.parent_id AS parentId,
              (SELECT COUNT(DISTINCT bc2.book_id)
                 FROM book_categories bc2
                 JOIN books b2 ON b2.id = bc2.book_id AND b2.deleted_at IS NULL${on ? " AND b2.media_type = ?" : ""}
                WHERE bc2.category_id IN (
                  WITH RECURSIVE sub(id) AS (
                    SELECT c.id
                    UNION ALL
                    SELECT cc.id FROM categories cc JOIN sub ON cc.parent_id = sub.id
                  ) SELECT id FROM sub
                )) AS n
         FROM categories c ORDER BY c.ord, c.name`
    ),
    series: all(
      `SELECT s.id, s.name, s.media_type AS mediaType, COUNT(*) AS n
         FROM series s JOIN books b ON b.series_id = s.id AND ${scope}
        GROUP BY s.id ORDER BY n DESC`
    ),
    states: all(
      `SELECT bs.state AS name, COUNT(*) AS n
         FROM book_states bs JOIN books b ON b.id = bs.book_id AND ${scope}
        GROUP BY bs.state ORDER BY n DESC`
    ),
    ebook: all(
      `SELECT b.ebook_state AS name, COUNT(*) AS n FROM books b
        WHERE ${scope} AND b.ebook_state <> '' GROUP BY b.ebook_state ORDER BY n DESC`
    ),
    decades: all(
      `SELECT (b.publish_year / 10) * 10 AS name, COUNT(*) AS n FROM books b
        WHERE ${scope} AND b.publish_year IS NOT NULL GROUP BY name ORDER BY name`
    )
  };
}

/** 系列均分只算读过的册，没读或没打分的不进分母 */
export function seriesAvg(db: DB, id: number): { avg: number | null; read: number; total: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) AS read,
              AVG(CASE WHEN is_read = 1 AND rating > 0 THEN rating END) AS avg
         FROM books WHERE series_id = ? AND deleted_at IS NULL`
    )
    .get(id) as any;
  return { avg: r.avg == null ? null : Number(r.avg), read: r.read || 0, total: r.total || 0 };
}
