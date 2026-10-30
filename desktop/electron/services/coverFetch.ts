import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "../db";
import type { CoverCandidate, CoverDetail, CoverQueueItem } from "../../shared/types";
import { setCoverFromFile } from "./coverService";
import { updateBook } from "./editService";
import { createField, listFields, restoreField } from "./fieldService";

/**
 * 封面识别。仿 emby 的 provider 那套，网络与解析分开：
 * 解析与打分是不吃网络的纯函数，谁来发请求由外面传进来。
 * 服务层不碰 Electron API，所以 net.fetch 在 main.ts 里注入。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REFERER = "https://book.douban.com/";
const HEADERS = { "User-Agent": UA, Referer: REFERER };

/** 这些状态码是豆瓣在拦人，撞上就整批停，不硬闯 */
const BLOCK_CODES = new Set([403, 418, 429]);
/** 缓存有效期，二十四小时内不重复打 */
const CACHE_TTL = 24 * 60 * 60 * 1000;
/** 批量里每本之间停多久。冒烟要跑几十本，用环境变量压到 0，正式跑还是 1.5 秒 */
export const GAP_MS = Number(process.env.BOOKLIB_COVER_GAP ?? 1500);
/** 到这个分直接落盘，不到的进待确认队列 */
export const MIN_SCORE = 60;

export interface TextResponse {
  status: number;
  url: string;
  text: string;
}
export interface BytesResponse {
  status: number;
  url: string;
  bytes: Uint8Array;
  contentType: string;
}
/** 两个取法分开，取图片不必当文本解一遍 */
export interface Http {
  text(url: string, headers?: Record<string, string>): Promise<TextResponse>;
  bytes(url: string, headers?: Record<string, string>): Promise<BytesResponse>;
}

export class BlockedError extends Error {
  constructor(public code: number) {
    super("豆瓣返回 " + code + "，先停下来");
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
}
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** 缩略图换大图。豆瓣给的是 s 尺寸，路径里换个字母就是 l 尺寸 */
export function bigImage(pic: string): string {
  if (!pic) return "";
  return pic.replace(/\/s\/public\//, "/l/public/").replace(/\/m\/public\//, "/l/public/");
}

/**
 * 书名归一化。去空白、去括号里的内容（出版社、系列、卷次多写在括号里）、
 * 去「第几卷」这类尾巴、统一大小写，剩下的是拿来比的骨架。
 */
export function normalizeTitle(s: string): string {
  if (!s) return "";
  let t = String(s);
  t = t.replace(/[（(【\[〔][^）)】\]〕]*[）)】\]〕]/g, "");
  t = t.replace(/第\s*[0-9一二三四五六七八九十百千]+\s*[卷册部集篇]/g, "");
  t = t.replace(/\b(vol|volume)\.?\s*\d+/gi, "");
  t = t.replace(/\s+/g, "");
  t = t.replace(/[·・:：,，.。!！?？'"“”‘’\-—_~～、\/\\|]/g, "");
  return t.toLowerCase();
}

/** 作者名归一化，去掉国籍方括号与空白，方便在候选的作者串里找 */
function normalizeAuthor(s: string): string {
  return String(s || "")
    .replace(/[\[【（(][^\]】）)]*[\]】）)]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function yearOf(s: string): string {
  const m = String(s || "").match(/(\d{4})/);
  return m ? m[1] : "";
}

/**
 * 打分。书名完全相等 60，互为包含 35，作者对得上 20，同年 10，差一年内 5。
 * 书名一个字符都不沾的直接判 0，这种候选连排队都不该进。
 */
export function scoreCandidate(
  book: { title: string; authors?: string[]; year?: string },
  cand: { title: string; authors?: string; year?: string }
): number {
  const nt = normalizeTitle(book.title);
  const nc = normalizeTitle(cand.title);
  if (!nt || !nc) return 0;

  const shared = [...new Set(nt.split(""))].some((ch) => nc.includes(ch));
  if (!shared) return 0;

  let score = 0;
  if (nt === nc) score += 60;
  else if (nt.includes(nc) || nc.includes(nt)) score += 35;

  const mine = (book.authors || []).map(normalizeAuthor).filter(Boolean);
  const theirs = normalizeAuthor(cand.authors || "");
  if (mine.length && theirs && mine.some((a) => theirs.includes(a))) score += 20;

  const by = yearOf(book.year || "");
  const cy = yearOf(cand.year || "");
  if (by && cy) {
    const d = Math.abs(Number(by) - Number(cy));
    if (d === 0) score += 10;
    else if (d <= 1) score += 5;
  }
  return score;
}

/**
 * 解析搜索接口。返回里混着作者、影视条目，只收 type 为 b 的书。
 * 没有 type 字段的（旧版接口）按有没有 subject 链接判断。
 */
export function parseSuggest(json: string): CoverCandidate[] {
  let arr: any;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: CoverCandidate[] = [];
  for (const it of arr) {
    const kind = String(it?.type ?? "b");
    if (kind !== "b") continue;
    const url = String(it?.url || "");
    const id = String(it?.id || (url.match(/subject\/(\d+)/) || [])[1] || "");
    if (!id) continue;
    const pic = String(it?.pic || "");
    out.push({
      id,
      title: stripTags(String(it?.title || "")),
      authors: stripTags(String(it?.author_name || "")),
      year: String(it?.year || ""),
      publisher: "",
      pic,
      image: bigImage(pic),
      score: 0
    });
  }
  return out;
}

/**
 * 从站内搜索页里抠出 window.__DATA__ 那段 JSON。
 * 页面上还有别的脚本，正则会截错，这里按括号配平扫，跳过字符串里的括号。
 */
function dataOf(html: string): any | null {
  const at = html.indexOf("window.__DATA__");
  if (at < 0) return null;
  const from = html.indexOf("{", at);
  if (from < 0) return null;
  let depth = 0;
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(from, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 解析站内搜索页。豆瓣的 suggest 索引对台版与繁体书名覆盖很差，
 * 搜一本台版书的繁体原名给空数组，可站内搜索里明明有十几条，这条路就是补这个洞的。
 * abstract 的定式是「作者 / 译者 / 绘者 / 出版社 / 日期 / 价格」，
 * 作者总在第一段，日期是四位数那一段，出版社紧挨在日期前面。
 */
export function parseSearchPage(html: string): CoverCandidate[] {
  const d = dataOf(html);
  const items = Array.isArray(d?.items) ? d.items : [];
  const out: CoverCandidate[] = [];
  for (const it of items) {
    const url = String(it?.url || "");
    const id = String(it?.id || (url.match(/subject\/(\d+)/) || [])[1] || "");
    const title = stripTags(String(it?.title || ""));
    if (!id || !title) continue;
    const pic = String(it?.cover_url || "");
    const segs = String(it?.abstract || "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    const dayAt = segs.findIndex((s) => /^\d{4}(-\d{1,2})?(-\d{1,2})?$/.test(s));
    out.push({
      id,
      title,
      authors: segs[0] || "",
      year: dayAt >= 0 ? (segs[dayAt].match(/\d{4}/) || [""])[0] : "",
      publisher: dayAt > 0 ? segs[dayAt - 1] : "",
      pic,
      image: bigImage(pic),
      score: 0
    });
  }
  return out;
}

interface Subject {
  id: string;
  title: string;
  authors: string;
  year: string;
  publisher: string;
  image: string;
  info: Record<string, string>;
}

/** 详情页。og:image 是大图，书名取 og:title，信息区按「标签: 值」逐行拆 */
export function parseSubject(html: string, id = ""): Subject {
  const meta = (prop: string): string => {
    const m = html.match(new RegExp(`<meta\\s+property=["']${prop}["']\\s+content=["']([^"']*)["']`, "i"));
    return m ? decodeEntities(m[1]).trim() : "";
  };
  const image = meta("og:image");
  let title = meta("og:title");
  if (!title) {
    const m = html.match(/property=["']v:itemreviewed["'][^>]*>([\s\S]*?)<\/span>/i);
    title = m ? stripTags(m[1]) : "";
  }

  const info: Record<string, string> = {};
  const start = html.search(/id=["']info["']/i);
  if (start >= 0) {
    /* 切点要落在开标签之后。从 id="info" 本身切会把 <div 前缀留在正文里，
       第一段就成了 id="info"> 作者 : xxx，字段名超长整行匹配不上，作者永远读不到 */
    const gt = html.indexOf(">", start);
    const tail = gt >= 0 ? html.slice(gt + 1) : "";
    const end = tail.indexOf("</div>");
    const block = end >= 0 ? tail.slice(0, end) : tail.slice(0, 4000);
    for (const line of block.split(/<br\s*\/?>/i)) {
      const text = stripTags(line);
      const m = text.match(/^\s*([^:：]{1,12})[:：]\s*(.+)$/);
      if (m) {
        const k = m[1].trim();
        if (!(k in info)) info[k] = m[2].trim();
      }
    }
  }

  return {
    id,
    title,
    authors: info["作者"] || "",
    year: info["出版年"] || "",
    publisher: info["出版社"] || "",
    image,
    info
  };
}

/**
 * 把 ISBN 剥干净，不是 ISBN 返回空串。
 * 从别处粘过来的常带着 isbn 三个字母、横杠、全角数字，一律认。
 */
export function normIsbn(q: string): string {
  const s = String(q || "")
    /* 全角转半角，连 ＩＳＢＮ 与全角数字一起处理 */
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/isbn/gi, "")
    .replace(/[-\s:：·]/g, "");
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/i.test(s)) return s.toUpperCase();
  return "";
}

/** 十三位数字当 ISBN，带横杠、带 isbn 前缀的也认。其余当关键词 */
export function looksLikeIsbn(q: string): boolean {
  return !!normIsbn(q);
}

/* ---------------- 缓存 ---------------- */

function cacheGet(db: DB, kind: string, q: string): any | null {
  const r = db.prepare("SELECT payload, fetched_at FROM cover_cache WHERE kind = ? AND q = ?").get(kind, q) as any;
  if (!r) return null;
  const age = Date.now() - new Date(String(r.fetched_at)).getTime();
  if (!(age >= 0 && age < CACHE_TTL)) return null;
  try {
    return JSON.parse(String(r.payload));
  } catch {
    return null;
  }
}

function cacheSet(db: DB, kind: string, q: string, payload: unknown): void {
  db.prepare(
    "INSERT INTO cover_cache (kind, q, payload, fetched_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(kind, q) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at"
  ).run(kind, q, JSON.stringify(payload), new Date().toISOString());
}

export function clearCache(db: DB): void {
  db.prepare("DELETE FROM cover_cache").run();
}

/* ---------------- 搜索 ---------------- */

/** 站内搜索页。suggest 搜不到时用这条，覆盖台版与繁体书名 */
async function rawSite(http: Http, kw: string): Promise<CoverCandidate[]> {
  const url = "https://book.douban.com/subject_search?search_text=" + encodeURIComponent(kw) + "&cat=1001";
  const r = await http.text(url, HEADERS);
  if (BLOCK_CODES.has(r.status)) throw new BlockedError(r.status);
  if (r.status !== 200) return [];
  return parseSearchPage(r.text);
}

async function rawKeyword(http: Http, kw: string): Promise<CoverCandidate[]> {
  const url = "https://book.douban.com/j/subject_suggest?q=" + encodeURIComponent(kw);
  const r = await http.text(url, HEADERS);
  if (BLOCK_CODES.has(r.status)) throw new BlockedError(r.status);
  if (r.status !== 200) return [];
  const list = parseSuggest(r.text);
  /* suggest 的索引对台版、繁体书名基本没收录，空了就走站内搜索再捞一遍 */
  if (list.length) return list;
  return rawSite(http, kw);
}

async function rawIsbn(http: Http, isbn: string): Promise<CoverCandidate | null> {
  const clean = isbn.replace(/[-\s]/g, "");
  /* 搜接口把 ISBN 当关键词会返回空数组，必须走这条跳转 */
  const r = await http.text("https://book.douban.com/isbn/" + clean + "/", HEADERS);
  if (BLOCK_CODES.has(r.status)) throw new BlockedError(r.status);
  const id = (r.url.match(/subject\/(\d+)/) || [])[1] || "";
  if (r.status !== 200 || !id) return null;
  const s = parseSubject(r.text, id);
  if (!s.title && !s.image) return null;
  return {
    id,
    title: s.title,
    authors: s.authors,
    year: s.year,
    publisher: s.publisher,
    pic: s.image,
    image: s.image,
    score: 0
  };
}

/** 关键词搜。结果缓存一份，手动搜与批量共用 */
export async function searchKeyword(db: DB, http: Http, kw: string): Promise<{ list: CoverCandidate[]; cached: boolean }> {
  const q = String(kw || "").trim();
  if (!q) return { list: [], cached: false };
  const hit = cacheGet(db, "search", q);
  if (hit) return { list: hit as CoverCandidate[], cached: true };
  const list = await rawKeyword(http, q);
  if (list.length) cacheSet(db, "search", q, list);
  return { list, cached: false };
}

/** 一次搜索把三条路都试过：ISBN 走跳转，关键词走 suggest，都空了走站内搜索 */
export async function search(db: DB, http: Http, q: string): Promise<{ list: CoverCandidate[]; cached: boolean }> {
  const raw = String(q || "").trim();
  if (!raw) return { list: [], cached: false };

  const isbn = normIsbn(raw);
  if (isbn) {
    /* 缓存键用剥干净的号，isbn978... 与 978... 算同一个 */
    const hit = cacheGet(db, "isbn", isbn);
    if (hit) return { list: hit as CoverCandidate[], cached: true };
    const one = await rawIsbn(http, isbn);
    if (one) {
      const list = [one];
      cacheSet(db, "isbn", isbn, list);
      return { list, cached: false };
    }
    /* 台版与老版次有时没登记 isbn 跳转，拿站内搜索再试，站内搜索认 ISBN */
    const alt = await rawSite(http, isbn);
    if (alt.length) cacheSet(db, "isbn", isbn, alt);
    return { list: alt, cached: false };
  }
  return searchKeyword(db, http, raw);
}

/** 取详情，选中时才调，也缓存 */
export async function detailOf(db: DB, http: Http, id: string): Promise<CoverDetail | null> {
  if (!id) return null;
  const hit = cacheGet(db, "detail", id);
  if (hit) return hit as CoverDetail;
  const r = await http.text("https://book.douban.com/subject/" + id + "/", HEADERS);
  if (BLOCK_CODES.has(r.status)) throw new BlockedError(r.status);
  if (r.status !== 200) return null;
  const s = parseSubject(r.text, id);
  const d: CoverDetail = { id, image: s.image, info: s.info };
  if (s.image || Object.keys(s.info).length) cacheSet(db, "detail", id, d);
  return d;
}

/* ---------------- 下载与落盘 ---------------- */

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp"
};

/**
 * 下图片。豆瓣图片站有防盗链，不带 Referer 直接 418，
 * 所以请求一律在主进程发，界面不能直接引豆瓣的地址。
 */
export async function downloadImage(http: Http, url: string): Promise<{ file: string; bytes: number }> {
  if (!/^https?:\/\//i.test(url)) throw new Error("图片地址不对");
  const r = await http.bytes(url, HEADERS);
  if (BLOCK_CODES.has(r.status)) throw new BlockedError(r.status);
  if (r.status !== 200) throw new Error("图片取不到，返回 " + r.status);

  const ct = String(r.contentType || "").split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[ct];
  if (!ext) throw new Error("不是图片，返回的是 " + (ct || "未知类型"));
  const size = r.bytes.byteLength;
  if (size < 1024) throw new Error("图片太小，只有 " + size + " 字节");
  if (size > 12 * 1024 * 1024) throw new Error("图片太大，超过 12MB");

  const tmp = path.join(os.tmpdir(), "booklib-cover-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext);
  fs.writeFileSync(tmp, Buffer.from(r.bytes));
  return { file: tmp, bytes: size };
}

/* ---------------- 顺手补字段 ---------------- */

/**
 * 豆瓣那几项要落在哪。出版年进原有的出版日期列，其余四项走自建字段。
 * seed 是这次要写进去的值，单选建字段时得先有选项，把它一起塞进去。
 */
const BACKFILL: { key: string; label: string; type: "text" | "number" | "select"; from: string }[] = [
  { key: "publisher", label: "出版社", type: "text", from: "出版社" },
  { key: "isbn", label: "ISBN", type: "text", from: "ISBN" },
  { key: "pages", label: "页数", type: "number", from: "页数" },
  { key: "binding", label: "装帧", type: "select", from: "装帧" }
];

/** 装帧常见的那几个先摆上，豆瓣给的值不在其中时再补一个 */
const BINDING_SEED = ["平装", "精装", "线装", "软精装"];

function ensureField(
  db: DB,
  spec: { key: string; label: string; type: "text" | "number" | "select" },
  seed?: string
): number {
  const row = db.prepare("SELECT id, deleted_at FROM fields WHERE key = ?").get(spec.key) as any;
  /* 删过的字段恢复回来，比另建一个新的干净，界面上的位置与顺序还是原来那个 */
  if (row && row.deleted_at) {
    restoreField(db, Number(row.id));
    return Number(row.id);
  }
  if (row) return Number(row.id);

  const options = spec.type === "select" ? [...BINDING_SEED, ...(seed && !BINDING_SEED.includes(seed) ? [seed] : [])] : undefined;
  const r = createField(db, { key: spec.key, label: spec.label, type: spec.type, options });
  const made = db.prepare("SELECT id FROM fields WHERE key = ?").get(spec.key) as any;
  if (!made) throw new Error("补字段失败，" + spec.label + (r.msg ? "，" + r.msg : ""));
  return Number(made.id);
}

/** 只写空着的。已有的值一律不覆盖，返回值告诉界面写了哪几项、因为已有值跳过哪几项 */
export function backfill(
  db: DB,
  bookId: string,
  coversDir: string,
  detail: CoverDetail
): { filled: string[]; skipped: string[] } {
  const b = db.prepare("SELECT publish_date FROM books WHERE id = ?").get(bookId) as any;
  if (!b) return { filled: [], skipped: [] };

  const filled: string[] = [];
  const skipped: string[] = [];
  const custom: Record<string, string[]> = {};

  /* 出版年落进原有的出版日期列，它是内建字段，不必再建一个自定义的 */
  const year = String(detail.info["出版年"] || "").trim();
  let publishDate: string | undefined;
  if (year) {
    const m = year.match(/(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/);
    if (m) {
      const day = m[1] + (m[2] ? "-" + m[2].padStart(2, "0") : "-01") + (m[3] ? "-" + m[3].padStart(2, "0") : "-01");
      if (!String(b.publish_date || "").trim()) {
        publishDate = day;
        filled.push("出版日期");
      } else skipped.push("出版日期");
    }
  }

  const have = new Map<string, string[]>();
  for (const f of listFields(db)) {
    const rows = db
      .prepare("SELECT val FROM book_field_values WHERE book_id = ? AND field_id = ? AND ord >= 0 ORDER BY ord")
      .all(bookId, f.id) as any[];
    have.set(
      f.key,
      rows.map((r) => String(r.val))
    );
  }

  for (const f of BACKFILL) {
    const val = String(detail.info[f.from] || "").trim();
    if (!val) continue;
    const cur = have.get(f.key) || [];
    if (cur.filter(Boolean).length) {
      skipped.push(f.label);
      continue;
    }
    ensureField(db, f, val);
    custom[f.key] = [val];
    filled.push(f.label);
  }

  if (publishDate || Object.keys(custom).length) {
    updateBook(db, bookId, { ...(publishDate ? { publishDate } : {}), ...(Object.keys(custom).length ? { custom } : {}) });
  }
  return { filled, skipped };
}

/* ---------------- 落一张候选 ---------------- */

export interface ApplyOptions {
  coversDir: string;
  backfill?: boolean;
}

/**
 * 落盘：下大图 → 交给 setCoverFromFile（命名、原图移位、撤销历史全复用，不另写一套）。
 * 临时文件用完就删，不管成败。
 */
export async function applyCandidate(
  db: DB,
  http: Http,
  bookId: string,
  hit: CoverCandidate,
  opts: ApplyOptions
): Promise<{ ok: boolean; cover?: string; filled?: string[]; skipped?: string[]; msg?: string }> {
  const url = hit.image || hit.pic;
  if (!url) return { ok: false, msg: "这张候选没有图片" };

  let tmp = "";
  try {
    const got = await downloadImage(http, url);
    tmp = got.file;
    const r = setCoverFromFile(db, bookId, tmp, opts.coversDir);
    if (!r.ok) return { ok: false, msg: r.msg };

    let filled: string[] = [];
    let skipped: string[] = [];
    if (opts.backfill) {
      const d = await detailOf(db, http, hit.id);
      if (d) {
        const out = backfill(db, bookId, opts.coversDir, d);
        filled = out.filled;
        skipped = out.skipped;
      }
    }
    return { ok: true, cover: r.cover, filled, skipped };
  } catch (e: any) {
    return { ok: false, msg: e?.message || String(e) };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 临时文件删不掉不影响结果 */
      }
    }
  }
}

/* ---------------- 待确认队列 ---------------- */

export function enqueue(db: DB, bookId: string, cand: CoverCandidate | null, score: number): void {
  db.prepare(
    "INSERT INTO cover_queue (book_id, candidate, score, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(book_id) DO UPDATE SET candidate = excluded.candidate, score = excluded.score, created_at = excluded.created_at"
  ).run(bookId, cand ? JSON.stringify(cand) : "", score, new Date().toISOString());
}

export function dequeue(db: DB, bookId: string): void {
  db.prepare("DELETE FROM cover_queue WHERE book_id = ?").run(bookId);
}

export function listQueue(db: DB): CoverQueueItem[] {
  const rows = db
    .prepare(
      `SELECT q.book_id, q.candidate, q.score, q.created_at, b.title, b.cover_file,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
         FROM cover_queue q JOIN books b ON b.id = q.book_id
        WHERE b.deleted_at IS NULL
        ORDER BY q.created_at DESC`
    )
    .all() as any[];
  return rows.map((r) => {
    let cand: CoverCandidate | null = null;
    if (r.candidate) {
      try {
        cand = JSON.parse(String(r.candidate));
      } catch {
        cand = null;
      }
    }
    return {
      bookId: String(r.book_id),
      title: String(r.title || ""),
      authors: String(r.author || ""),
      cover: String(r.cover_file || ""),
      candidate: cand,
      score: Number(r.score || 0),
      createdAt: String(r.created_at || "")
    };
  });
}

/* ---------------- 批量 ---------------- */

export interface BatchBook {
  id: string;
  title: string;
  authors: string[];
  year: string;
}

/** 缺封面的书，按书名排，方便照着看进度 */
export function booksWithoutCover(db: DB): BatchBook[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.publish_date,
              (SELECT GROUP_CONCAT(a.name, '|') FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                WHERE ba.book_id = b.id) AS authors
         FROM books b
        WHERE b.deleted_at IS NULL AND (b.cover_file IS NULL OR b.cover_file = '')
        ORDER BY b.title`
    )
    .all() as any[];
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title || ""),
    authors: String(r.authors || "").split("|").filter(Boolean),
    year: yearOf(String(r.publish_date || ""))
  }));
}

export interface BatchTick {
  book: BatchBook;
  best: CoverCandidate | null;
  score: number;
}

/**
 * 一本书跑一遍搜索并挑最高分。搜不出来就返回空，让调用方记账。
 * 关键词用书名，另外把作者加一个关键字再搜一次，能捞到只差副标题的那些。
 */
export async function bestHit(db: DB, http: Http, book: BatchBook): Promise<BatchTick> {
  let list: CoverCandidate[] = [];
  try {
    const r1 = await search(db, http, book.title);
    list = r1.list;
    if (!list.length && book.authors[0]) {
      const r2 = await searchKeyword(db, http, book.authors[0]);
      list = r2.list;
    }
  } catch (e) {
    throw e;
  }

  let best: CoverCandidate | null = null;
  let bestScore = 0;
  for (const c of list) {
    const s = scoreCandidate(book, c);
    if (s > bestScore) {
      bestScore = s;
      best = { ...c, score: s };
    }
  }
  return { book, best, score: bestScore };
}
