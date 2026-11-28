import type { DB } from "../db";
import type { BookQuery, BookRow, SeriesInfo, SeriesPatch, SeriesQuery, SeriesResult } from "../../shared/types";
import { rebuildFts } from "../db/fts";
import { bookWhere, listBooks, seriesKeywordWhere } from "./bookService";
import { parseBookSearch } from "../../shared/bookSearch";
import { seriesDisplay, seriesLabel, seriesTitle } from "../../shared/seriesText";

export { seriesLabel, seriesTitle };

/**
 * 系列集合一格格的数据。册数与均分只算在架书，均分只算读过且打过分的那几册。
 * 封面取系列里册序最靠前、且有封面的一本。
 * label 是给人看的名字，译名优先；original 是原作语言的名，与 label 相同就不必显示。
 *
 * 参数保留旧的媒介字符串写法；传 SeriesQuery 时关键词按系列名匹配，
 * 分类、阅读状态这类单册条件走 bookWhere，要求系列里至少有一册同时满足。
 * 成员条件只决定系列出不出现，册数与均分仍按整套在架的书算。
 */
export function listSeries(db: DB, arg: string | SeriesQuery = ""): SeriesInfo[] {
  const q: SeriesQuery = typeof arg === "string" ? { media: arg } : arg || {};
  const where: string[] = [];
  const params: any[] = [];

  for (const raw of [q.presetQ, q.q]) {
    const text = String(raw || "");
    const parsed = parseBookSearch(text);
    /* 没有 @字段 时原样交给系列名匹配；有字段时只拿剩下的普通关键词 */
    const hit = seriesKeywordWhere(parsed.hasFields ? parsed.keywords : text.trim());
    if (hit) {
      where.push(hit.sql);
      params.push(...hit.params);
    }
  }

  const media = q.media || "";
  if (media && media !== "全部") {
    where.push("s.media_type = ?");
    params.push(media);
  }

  /* 媒介由系列自己定，成员条件里去掉，只留分类、阅读状态这些单册条件 */
  const memberQ: BookQuery = { ...q, media: undefined };
  const member = bookWhere(db, memberQ, "bm", { base: false, keywords: false });
  if (member.sql) {
    where.push(
      `EXISTS (SELECT 1 FROM books bm WHERE bm.series_id = s.id AND bm.deleted_at IS NULL AND (${member.sql}))`
    );
    params.push(...member.params);
  }

  const sqlWhere = where.length ? " WHERE " + where.join(" AND ") : "";
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.zh_name, s.media_type AS mediaType,
              COUNT(b.id) AS n,
              SUM(CASE WHEN b.is_read = 1 THEN 1 ELSE 0 END) AS read,
              AVG(CASE WHEN b.is_read = 1 AND b.rating > 0 THEN b.rating END) AS avg,
              MAX(b.updated_at) AS updatedAt
         FROM series s
         JOIN books b ON b.series_id = s.id AND b.deleted_at IS NULL
         ${sqlWhere}
        GROUP BY s.id
        ORDER BY n DESC`
    )
    .all(...params) as any[];

  const covers = db
    .prepare(
      `SELECT series_id AS sid, cover_file AS file, updated_at AS upd
         FROM books
        WHERE series_id IS NOT NULL AND deleted_at IS NULL AND cover_file <> ''
        ORDER BY series_index IS NULL, series_index, title`
    )
    .all() as any[];
  const coverOf = new Map<number, any>();
  for (const c of covers) if (!coverOf.has(c.sid)) coverOf.set(c.sid, c);

  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      zhName: r.zh_name || "",
      label: seriesLabel(seriesDisplay(r.zh_name, r.name)),
      original: seriesLabel(r.name),
      mediaType: r.mediaType,
      n: r.n,
      read: r.read || 0,
      avg: r.avg == null ? null : Number(r.avg),
      cover: coverOf.get(r.id)?.file || "",
      coverV: coverOf.get(r.id)?.upd || "",
      updatedAt: r.updatedAt || ""
    }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "zh"));
}

/** 系列内的书按册序排，方便弹层里从上到下看 */
export function seriesBooks(db: DB, id: number): BookRow[] {
  const read = db.transaction(() => {
    const query: BookQuery = { seriesId: id, sorts: [{ key: "index", dir: 1 }], limit: 2000 };
    const first = listBooks(db, query);
    const rows = first.rows;
    while (rows.length < first.total) {
      const next = listBooks(db, { ...query, offset: rows.length }).rows;
      if (!next.length) break;
      rows.push(...next);
    }
    return rows;
  });
  return read();
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

/** 单个系列，形状与集合里的一格相同 */
export function oneSeries(db: DB, id: number): SeriesInfo | undefined {
  const hit = listSeries(db).find((s) => s.id === id);
  if (hit) return hit;
  /* 名下没有在架的书时集合里不会出现它，界面仍要有个能显示的东西 */
  const r = db.prepare("SELECT id, name, zh_name AS zhName, media_type AS mediaType FROM series WHERE id = ?").get(id) as any;
  if (!r) return undefined;
  return {
    id: r.id,
    name: r.name,
    zhName: r.zhName || "",
    label: seriesLabel(seriesDisplay(r.zhName, r.name)),
    original: seriesLabel(r.name),
    mediaType: r.mediaType,
    n: 0,
    read: 0,
    avg: null,
    cover: "",
    coverV: "",
    updatedAt: ""
  };
}

/**
 * 改系列名。只认原名与译名两个键，传哪个写哪个，没传的保持原值。
 *
 * 原名是唯一键的一半，撞上同媒介下别的系列就写不进去，直接拒并说清那边名下有几本。
 * 译名没有唯一约束，撞了只提示不拦，拦死了反而挡路；后果是书评首部写这个译名时
 * 可能认到另一个系列上去，提示足够。
 *
 * 文件那边不在这里做。系列总评的文件名由原名派生，改名之后由调用方拿返回的 renamed
 * 去走 writeOne，服务层不碰文件系统。
 */
export function renameSeries(db: DB, id: number, patch: SeriesPatch): SeriesResult {
  const cur = db
    .prepare("SELECT id, name, zh_name AS zhName, media_type AS mediaType FROM series WHERE id = ?")
    .get(id) as any;
  if (!cur) return { ok: false, msg: "这个系列不在库里" };

  const name = patch.name === undefined ? String(cur.name) : String(patch.name).trim();
  const zhName = patch.zhName === undefined ? String(cur.zhName || "") : String(patch.zhName).trim();
  if (!name) return { ok: false, msg: "系列原名不能空着，它是这个系列的身份" };

  const oldName = String(cur.name);
  const oldZh = String(cur.zhName || "");
  if (name === oldName && zhName === oldZh) return { ok: true, series: oneSeries(db, id) };

  if (name !== oldName) {
    const hit = db
      .prepare("SELECT id FROM series WHERE media_type = ? AND name = ? AND id <> ?")
      .get(cur.mediaType, name, id) as any;
    if (hit) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM books WHERE series_id = ? AND deleted_at IS NULL").get(hit.id) as any)
        .n as number;
      return {
        ok: false,
        msg:
          "「" + cur.mediaType + "」下已经有一个叫《" + seriesLabel(name) + "》的系列，名下 " + n + " 本。" +
          "合并系列本版不做，换个名字，或者先把书挪过去"
      };
    }
  }

  let warn = "";
  if (zhName) {
    const others = db.prepare("SELECT name, zh_name FROM series WHERE id <> ?").all(id) as any[];
    const clash = others.find((r) => {
      const zh = String(r.zh_name || "");
      return (zh && seriesLabel(zh) === zhName) || seriesLabel(String(r.name || "")) === zhName;
    });
    if (clash) warn = "这个译名与另一个系列重了，书评首部写这个名字时可能认到那个系列上";
  }

  const run = db.transaction(() => {
    db.prepare("UPDATE series SET name = ?, zh_name = ? WHERE id = ?").run(name, zhName, id);
    /* 全文索引的系列列是原名与译名拼起来的，不会自己跟，名下每本都得重灌 */
    const books = db.prepare("SELECT id FROM books WHERE series_id = ? AND deleted_at IS NULL").all(id) as any[];
    for (const b of books) rebuildFts(db, String(b.id));
  });
  run();

  return { ok: true, msg: warn || undefined, series: oneSeries(db, id), renamed: name !== oldName };
}
