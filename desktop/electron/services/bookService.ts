import type { DB } from "../db";
import { filterRulesWhere } from "./filterRules";
import type { BookQuery, BookRow, ListResult, Facets, SortSpec } from "../../shared/types";
import { BOOK_SEARCH_FIELDS, parseBookSearch, type BookSearchFieldTerm } from "../../shared/bookSearch";
import { seriesDisplay } from "../../shared/seriesText";
import { customOfBooks } from "./fieldService";

/* 多字段排序：每个 key 对应一个可比较的表达式，方向另加。
   评分与读过日期这类有大量空值，空值统一沉到最后，不随升降序翻面 */
const ORDER_COL: Record<string, string> = {
  title: "b.title COLLATE NOCASE",
  author:
    "(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) COLLATE NOCASE",
  series: "COALESCE(NULLIF(s.zh_name, ''), s.name, '') COLLATE NOCASE",
  index: "b.series_index",
  rating: "b.rating",
  read: "b.read_date",
  readStart: "b.read_start",
  year: "b.publish_year",
  updated: "b.updated_at",
  grade:
    "CASE (SELECT r.grade FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL) WHEN 'god' THEN 0 WHEN 'normal' THEN 1 WHEN 'bad' THEN 2 ELSE 3 END"
};

const NULL_LAST = new Set(["rating", "read", "readStart", "year", "index", "grade"]);

/** 自定义字段排序时用的表达式。值表按字段 id 取，id 来自库里不是用户输入 */
function customOrderExpr(db: DB, key: string, dir: number): string {
  const f = db.prepare("SELECT id, type FROM fields WHERE key = ? AND deleted_at IS NULL").get(key) as any;
  if (!f) return "";
  const col = f.type === "date" ? "v.day" : f.type === "text" || f.type === "longtext" || f.type === "select" || f.type === "multiselect" ? "v.val" : "v.num";
  const expr = `(SELECT ${col} FROM book_field_values v WHERE v.book_id = b.id AND v.field_id = ${Number(f.id)} ORDER BY v.ord LIMIT 1)`;
  return `(${expr} IS NULL) ASC, ${expr}${dir === -1 ? " DESC" : " ASC"}`;
}

export function orderBy(db: DB, sorts?: SortSpec[]): string {
  const list = sorts && sorts.length ? sorts : [{ key: "title", dir: 1 } as SortSpec];
  const parts: string[] = [];
  for (const s of list) {
    const col = ORDER_COL[s.key];
    if (col) {
      if (NULL_LAST.has(s.key)) parts.push(`(${col} IS NULL) ASC`);
      parts.push(col + (s.dir === -1 ? " DESC" : " ASC"));
      continue;
    }
    /* 不是内建的排序键就去字段表里找，找不到就不排这一条 */
    const custom = customOrderExpr(db, s.key, s.dir);
    if (custom) parts.push(custom);
  }
  if (!parts.length) parts.push("b.title COLLATE NOCASE ASC");
  return parts.join(", ");
}

const SELECT_ROW = `
SELECT b.id, b.title, b.subtitle, b.original_title, b.original_subtitle, b.media_type,
       b.series_id, b.series_index, b.country, b.is_mystery, b.publish_date, b.publish_year,
       b.is_read, b.read_start, b.read_date, b.rating, b.ebook_state, b.note, b.cover_file, b.updated_at,
       s.name AS series_name, s.zh_name AS series_zh,
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
    seriesName: r.series_name ? seriesDisplay(r.series_zh, r.series_name) : "",
    seriesOriginal: r.series_name || "",
    seriesIndex: r.series_index,
    country: r.country,
    isMystery: !!r.is_mystery,
    publishDate: r.publish_date,
    publishYear: r.publish_year,
    isRead: !!r.is_read,
    readDate: r.read_date,
    readStart: r.read_start,
    rating: r.rating,
    ebookState: r.ebook_state,
    note: r.note,
    cover: r.cover_file || "",
    coverV: r.updated_at || "",
    authors: splitList(r.authors_text),
    categories: splitList(r.cats_text),
    states: splitList(r.states_text),
    reviewGrade: r.review_grade || null,
    custom: {}
  };
}

/** 自定义字段的值另外查一次，按批走，不塞进那条大查询里 */
function attachCustom(db: DB, rows: BookRow[]): BookRow[] {
  if (!rows.length) return rows;
  const map = customOfBooks(
    db,
    rows.map((r) => r.id)
  );
  for (const r of rows) r.custom = map[r.id] || {};
  return rows;
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

/** 关键词条件。三个字符以上走全文索引，短词退回 LIKE，与原来的分法一致 */
function keywordWhere(kw: string, alias: string): { sql: string; params: any[] } | null {
  if (!kw) return null;
  if (kw.length >= 3) {
    return {
      sql: `${alias}.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ?)`,
      params: [ftsQuery(kw)]
    };
  }
  const like = "%" + kw + "%";
  return {
    sql:
      `(${alias}.title LIKE ? OR ${alias}.original_title LIKE ? OR ${alias}.subtitle LIKE ?` +
      ` OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id` +
      ` WHERE ba.book_id = ${alias}.id AND a.name LIKE ?))`,
    params: [like, like, like, like]
  };
}

/** @字段 的条件。值与别名全走占位符或内部常量，值一律按包含匹配 */
function fieldWhere(terms: BookSearchFieldTerm[], alias: string): { sql: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  for (const term of terms) {
    const like = "%" + term.value + "%";
    if (term.field === "作者") {
      where.push(
        `EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id` +
          ` WHERE ba.book_id = ${alias}.id AND a.name LIKE ?)`
      );
      params.push(like);
    } else if (term.field === "书名") {
      where.push(`${alias}.title LIKE ?`);
      params.push(like);
    } else if (term.field === "原作名") {
      where.push(`${alias}.original_title LIKE ?`);
      params.push(like);
    } else if (term.field === "系列") {
      where.push(
        `EXISTS (SELECT 1 FROM series sx WHERE sx.id = ${alias}.series_id` +
          ` AND (sx.name LIKE ? OR sx.zh_name LIKE ?))`
      );
      params.push(like, like);
    } else if (term.field === "分类") {
      where.push(
        `EXISTS (SELECT 1 FROM book_categories bc JOIN categories c ON c.id = bc.category_id` +
          ` WHERE bc.book_id = ${alias}.id AND c.name LIKE ?)`
      );
      params.push(like);
    }
  }
  return { sql: where.join(" AND "), params };
}

function readWhere(value: BookQuery["read"], alias: string): string | null {
  if (value === "read") return `${alias}.is_read = 1`;
  if (value === "unread") return `${alias}.is_read = 0`;
  if (value === "rated") return `${alias}.rating IS NOT NULL AND ${alias}.rating > 0`;
  return null;
}

export interface BookWhereOptions {
  /** 是否带上 deleted_at IS NULL。单册列表要；系列成员由自己的子查询补 */
  base?: boolean;
  /** 关键词条件是否由这里出。系列视图的关键词按系列名匹配，成员条件要关掉这一项 */
  keywords?: boolean;
}

/**
 * 单册筛选的 SQL 条件。系列视图的成员筛选复用这一份，
 * 保证「符合条件」在单册列表与系列列表里是同一套判定。
 */
export function bookWhere(
  db: DB,
  q: BookQuery,
  alias = "b",
  opts: BookWhereOptions = {}
): { sql: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.base !== false) where.push(`${alias}.deleted_at IS NULL`);

  /* @字段 先拆出来，普通关键词仍旧走原来的全文索引与短词 LIKE。
     预设词条与临时词条都要拆，系列视图只关普通关键词，字段条件照常进成员子查询 */
  const presetParsed = parseBookSearch(q.presetQ);
  const qParsed = parseBookSearch(q.q);
  if (opts.keywords !== false) {
    for (const word of presetParsed.keywords.split(/\s+/).filter(Boolean)) {
      const hit = keywordWhere(word, alias);
      if (hit) {
        where.push(hit.sql);
        params.push(...hit.params);
      }
    }
    /* 没有字段词条时保留原串，连空格写法都与旧路径一致 */
    const rawQ = String(q.q || "").trim();
    const hit = keywordWhere(qParsed.hasFields ? qParsed.keywords : rawQ, alias);
    if (hit) {
      where.push(hit.sql);
      params.push(...hit.params);
    }
  }
  for (const parsed of [presetParsed, qParsed]) {
    const hit = fieldWhere(parsed.fields, alias);
    if (hit.sql) {
      where.push(hit.sql);
      params.push(...hit.params);
    }
  }

  if (q.media && q.media !== "全部") {
    where.push(`${alias}.media_type = ?`);
    params.push(q.media);
  }
  if (q.seriesId) {
    where.push(`${alias}.series_id = ?`);
    params.push(q.seriesId);
  }
  for (const r of [q.presetRead, q.read]) {
    const cond = readWhere(r, alias);
    if (cond) where.push(cond);
  }
  if (q.noCover === true) where.push(`${alias}.cover_file = ''`);
  if (q.noCover === false) where.push(`${alias}.cover_file <> ''`);

  /* 预设分类与临时分类各自成一条，同一本册要两边都落在 */
  for (const list of [q.presetCategories, q.categories]) {
    if (!list || !list.length) continue;
    /* 大分类只是分组，书挂在叶子标签上。点「题材」要把旗下所有标签的书一起算进来 */
    const picked = expandCategories(db, list);
    if (!picked.length) continue;
    const marks = picked.map(() => "?").join(",");
    where.push(
      `${alias}.id IN (SELECT bc.book_id FROM book_categories bc JOIN categories c ON c.id = bc.category_id WHERE c.name IN (${marks}))`
    );
    params.push(...picked);
  }
  if (q.states && q.states.length) {
    const marks = q.states.map(() => "?").join(",");
    where.push(`${alias}.id IN (SELECT book_id FROM book_states WHERE state IN (${marks}))`);
    params.push(...q.states);
  }
  if (q.ebook && q.ebook.length) {
    const marks = q.ebook.map(() => "?").join(",");
    where.push(`${alias}.ebook_state IN (${marks})`);
    params.push(...q.ebook);
  }
  if (q.decades && q.decades.length) {
    where.push("(" + q.decades.map(() => `${alias}.publish_year BETWEEN ? AND ?`).join(" OR ") + ")");
    for (const d of q.decades) params.push(d, d + 9);
  }

  /* 高级筛选：区间与存在性条件，留空的那一项不加 */
  const adv = q.adv;
  const group = filterRulesWhere(db, adv?.group, alias);
  if (group.sql) {
    where.push(group.sql);
    params.push(...group.params);
  }
  if (adv) {
    if (adv.ratingMin != null) (where.push(`${alias}.rating >= ?`), params.push(adv.ratingMin));
    if (adv.ratingMax != null) (where.push(`${alias}.rating <= ?`), params.push(adv.ratingMax));
    if (adv.yearFrom != null) (where.push(`${alias}.publish_year >= ?`), params.push(adv.yearFrom));
    if (adv.yearTo != null) (where.push(`${alias}.publish_year <= ?`), params.push(adv.yearTo));
    if (adv.hasReview === true)
      where.push(`EXISTS (SELECT 1 FROM reviews r WHERE r.book_id = ${alias}.id AND r.deleted_at IS NULL)`);
    if (adv.hasReview === false)
      where.push(`NOT EXISTS (SELECT 1 FROM reviews r WHERE r.book_id = ${alias}.id AND r.deleted_at IS NULL)`);
    const note = String(adv.note || "").trim();
    if (note) (where.push(`${alias}.note LIKE ?`), params.push("%" + note + "%"));
  }

  /* 自定义字段的筛选。一条一个 EXISTS，未填值的不匹配，与左栏那套一致 */
  if (q.fvals && q.fvals.length) {
    for (const f of q.fvals) {
      if (!f || !f.key) continue;
      const sub = `SELECT 1 FROM book_field_values v JOIN fields ff ON ff.id = v.field_id WHERE v.book_id = ${alias}.id AND ff.key = ?`;
      if (f.op === "yes") {
        where.push(`EXISTS (${sub} AND v.val = '1')`);
        params.push(f.key);
      } else if (f.op === "no") {
        where.push(`NOT EXISTS (${sub} AND v.val = '1')`);
        params.push(f.key);
      } else if (f.op === "between") {
        where.push(`EXISTS (${sub} AND (v.num BETWEEN ? AND ? OR v.day BETWEEN ? AND ?))`);
        const a = f.a == null || f.a === "" ? -1e15 : Number(f.a);
        const b = f.b == null || f.b === "" ? 1e15 : Number(f.b);
        const da = f.a == null || f.a === "" ? "0000-00-00" : String(f.a);
        const dbTo = f.b == null || f.b === "" ? "9999-99-99" : String(f.b);
        params.push(f.key, a, b, da, dbTo);
      } else if (f.op === "eq" || f.op === "has") {
        where.push(`EXISTS (${sub} AND v.val = ?)`);
        params.push(f.key, String(f.a || ""));
      } else {
        where.push(`EXISTS (${sub} AND v.val LIKE ?)`);
        params.push(f.key, "%" + String(f.a || "") + "%");
      }
    }
  }

  return { sql: where.join(" AND "), params };
}

export function listBooks(db: DB, q: BookQuery): ListResult {
  const built = bookWhere(db, q, "b");
  const params = built.params;
  const sqlWhere = built.sql ? " WHERE " + built.sql : "";
  const ids = Array.isArray(q.firstIds)
    ? [...new Set(q.firstIds.filter((id) => typeof id === "string"))].slice(0, 200)
    : [];
  const priority = ids.length
    ? `CASE b.id ${ids.map((_, index) => "WHEN ? THEN " + index).join(" ")} ELSE ${ids.length} END, `
    : "";
  const order = priority + orderBy(db, q.sorts);
  const limit = Math.min(Math.max(q.limit || 120, 1), 2000);
  const offset = Math.max(q.offset || 0, 0);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM books b LEFT JOIN series s ON s.id = b.series_id${sqlWhere}`).get(...params) as any).n;
  const rows = attachCustom(
    db,
    db
      .prepare(`${SELECT_ROW}${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, ...ids, limit, offset)
      .map(toRow)
  );

  return { total, rows };
}

const SUGGEST_LIMIT = 10;

/** 系列关键词同时匹配原名和译名。 */
export function seriesKeywordWhere(kw: string): { sql: string; params: string[] } | null {
  const words = kw.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const parts: string[] = [];
  const params: string[] = [];
  for (const word of words) {
    parts.push("(s.name LIKE ? OR s.zh_name LIKE ?)");
    const like = "%" + word + "%";
    params.push(like, like);
  }
  return { sql: "(" + parts.join(" AND ") + ")", params };
}

/**
 * 字段输入候选。只查当前字段对应的表，带 LIMIT，不把整库读进来。
 * q 包含当前标签与其它搜索词条，用来把候选收窄到当前结果集；
 * seriesMode 为真时普通关键词按系列名走，与系列集合的判定一致。
 */
export function suggestBookField(
  db: DB,
  q: BookQuery,
  field: string,
  input: string,
  seriesMode = false
): string[] {
  const key = BOOK_SEARCH_FIELDS.find((value) => value === field);
  if (!key) return [];

  const built = bookWhere(db, seriesMode ? { ...q, media: undefined } : q, "b", { keywords: !seriesMode });
  const condParts = [built.sql];
  const condParams = [...built.params];

  if (seriesMode) {
    condParts.push("s.id IS NOT NULL");
    if (q.media && q.media !== "全部") {
      condParts.push("s.media_type = ?");
      condParams.push(q.media);
    }
    for (const raw of [q.presetQ, q.q]) {
      const hit = seriesKeywordWhere(parseBookSearch(raw).keywords);
      if (hit) {
        condParts.push(hit.sql);
        condParams.push(...hit.params);
      }
    }
  }

  const scopeSql =
    `WITH scope AS (` +
    ` SELECT DISTINCT b.id AS id, b.series_id AS sid, b.title AS title, b.original_title AS orig` +
    ` FROM books b LEFT JOIN series s ON s.id = b.series_id` +
    ` WHERE ${condParts.join(" AND ")}) `;

  const text = String(input == null ? "" : input).trim();
  const like = "%" + text + "%";
  const prefix = text + "%";
  const order = "ORDER BY CASE WHEN v LIKE ? THEN 0 ELSE 1 END, v COLLATE NOCASE LIMIT ?";

  let sql = "";
  let params: any[] = [];
  if (key === "作者") {
    sql =
      `${scopeSql}SELECT DISTINCT a.name AS v FROM authors a` +
      ` JOIN book_authors ba ON ba.author_id = a.id` +
      ` JOIN scope sc ON sc.id = ba.book_id` +
      ` WHERE a.name LIKE ? ${order}`;
    params = [...condParams, like, prefix, SUGGEST_LIMIT];
  } else if (key === "书名") {
    sql =
      `${scopeSql}SELECT DISTINCT sc.title AS v FROM scope sc` +
      ` WHERE sc.title LIKE ? AND sc.title <> '' ${order}`;
    params = [...condParams, like, prefix, SUGGEST_LIMIT];
  } else if (key === "原作名") {
    sql =
      `${scopeSql}SELECT DISTINCT sc.orig AS v FROM scope sc` +
      ` WHERE sc.orig LIKE ? AND sc.orig <> '' ${order}`;
    params = [...condParams, like, prefix, SUGGEST_LIMIT];
  } else if (key === "分类") {
    sql =
      `${scopeSql}SELECT DISTINCT c.name AS v FROM categories c` +
      ` JOIN book_categories bc ON bc.category_id = c.id` +
      ` JOIN scope sc ON sc.id = bc.book_id` +
      ` WHERE c.name LIKE ? ${order}`;
    params = [...condParams, like, prefix, SUGGEST_LIMIT];
  } else {
    sql =
      `${scopeSql}SELECT v FROM (` +
      `SELECT s.name AS v FROM series s JOIN scope sc ON sc.sid = s.id WHERE s.name LIKE ?` +
      ` UNION ` +
      `SELECT s.zh_name AS v FROM series s JOIN scope sc ON sc.sid = s.id` +
      ` WHERE s.zh_name LIKE ? AND s.zh_name <> '') WHERE v <> '' ${order}`;
    params = [...condParams, like, like, prefix, SUGGEST_LIMIT];
  }

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r) => String(r.v));
}

export function getBook(db: DB, id: string): BookRow | null {
  const r = db.prepare(`${SELECT_ROW} WHERE b.id = ?`).get(id);
  return r ? attachCustom(db, [toRow(r)])[0] : null;
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
       否则父级分类会把同一本书重复计入，合计超过书库本身的册数 */
    categories: all(
      `SELECT c.id, c.name, c.color, c.tier, c.ord, c.parent_id AS parentId,
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
      `SELECT s.id, COALESCE(NULLIF(s.zh_name, ''), s.name) AS name, s.media_type AS mediaType, COUNT(*) AS n
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
