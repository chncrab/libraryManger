import type { DB } from "../db";
import { splitLabel } from "./reviewIo";
import { seriesAuthor, seriesLabel } from "./seriesService";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

type Row = Record<string, any>;
type MatchKind = "book" | "series" | "draft" | "orphan";
export type ReviewMatch = { kind: MatchKind; bookId: string | null; seriesId: number | null; strength: number };

const S = (v: unknown): string => String(v ?? "").trim();

/** 仅识别旧合写「作者-《题名》」，普通书名里的《》不拆 */
export function splitLegacyReviewLabel(value: string): { author: string; title: string } | null {
  const s = S(value).replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  const m = /^(.+?)\s*[-_]\s*《(.+)》$/.exec(s);
  return m ? { author: m[1].trim(), title: m[2].trim() } : null;
}

/** 首部里的作者只用顿号分隔，逗号、分号属于姓名本身 */
function authorList(v: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of String(v ?? "").split("、")) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function allRows(db: DB, sql: string, ...params: any[]): Row[] {
  const d = db as any;
  if (typeof d.prepare === "function") return d.prepare(sql).all(...params);
  if (typeof d.all === "function") return d.all(sql, ...params);
  if (typeof d.query === "function") return d.query(sql, params);
  return [];
}

function findBook(db: DB, title: string, author: string): Row | null {
  const t = S(title);
  if (!t) return null;
  const names = authorList(author);
  let sql = "SELECT b.* FROM books b WHERE b.title = ? AND b.deleted_at IS NULL";
  const params: any[] = [t];
  /* 作者可以写多个，但必须每一个都真的挂在这本书上，才承认是同名书里的这一部 */
  for (const name of names) {
    sql +=
      " AND EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id" +
      " WHERE ba.book_id = b.id AND a.name = ?)";
    params.push(name);
  }
  const rows = allRows(db, sql, ...params);
  return rows.length === 1 ? rows[0] : null;
}

function findSeries(db: DB, name: string, author: string): Row | null {
  const n = seriesLabel(S(name));
  if (!n) return null;
  /* 系列总评只记首位作者，这里也只看首位 */
  const a = authorList(author)[0] || "";
  const rows = allRows(db, "SELECT id, name, zh_name FROM series");
  const hits = rows.filter((r) => {
    const names = [seriesLabel(S(r.name)), seriesLabel(S(r.zh_name))].filter(Boolean);
    if (!names.includes(n)) return false;
    if (!a) return true;
    return S(seriesAuthor(db, Number(r.id))) === a;
  });
  return hits.length === 1 ? hits[0] : null;
}

function mkBook(r: Row, strength: number): ReviewMatch {
  return { kind: "book", bookId: S(r.id), seriesId: null, strength };
}

function mkSeries(r: Row, strength: number): ReviewMatch {
  return { kind: "series", bookId: null, seriesId: Number(r.id), strength };
}

export function splitReviewFile(raw: string): { front: string; md: string; fields: Record<string, string> } {
  const bom = raw.charCodeAt(0) === 0xfeff ? raw[0] : "";
  const text = raw.slice(bom.length);
  const noClose = { front: bom, md: text, fields: {} as Record<string, string> };
  if (!text.startsWith("---") || (text.length > 3 && text[3] !== "\r" && text[3] !== "\n")) return noClose;
  if (text.length === 3) return noClose;
  const openEnd = text[3] === "\r" && text[4] === "\n" ? 5 : 4;
  const re = /(?:\r\n|\n|\r)---(?=\r\n|\n|\r|$)/g;
  re.lastIndex = openEnd - (openEnd === 5 ? 2 : 1);
  const m = re.exec(text);
  if (!m) return noClose;
  const close = m.index + m[0].length - 3;
  const fields: Record<string, string> = {};
  for (const line of text.slice(openEnd, close).match(/[^\r\n]+/g) || []) {
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    if (!key) continue;
    let value = kv[2].trim();
    if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) value = value.slice(1, -1);
    fields[key] = value;
  }
  let body = close + 3;
  if (text.startsWith("\r\n", body)) body += 2;
  else if (text[body] === "\r" || text[body] === "\n") body += 1;
  if (text.startsWith("\r\n", body)) body += 2;
  else if (text[body] === "\r" || text[body] === "\n") body += 1;
  const at = bom.length + body;
  return { front: raw.slice(0, at), md: raw.slice(at), fields };
}

export function reviewFilePath(dir: string, fileName: string): string {
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    /[\\/:]/.test(fileName) ||
    /[\u0000-\u001f\u007f]/.test(fileName) ||
    !/\.md$/i.test(fileName)
  ) {
    throw new Error("Invalid review file name");
  }
  return path.join(dir, fileName);
}

export function readReviewFile(dir: string, name: string): { raw: string; md: string; version: string } {
  const file = reviewFilePath(dir, name);
  const rootBefore = fs.lstatSync(dir);
  if (rootBefore.isSymbolicLink()) throw new Error("Symlink review directory is not allowed");

  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Review file must be a regular file");

  const flags = fs.constants.O_RDONLY | ((fs.constants as any).O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Review file changed while opening");
    }
    const buf = fs.readFileSync(fd);
    const after = fs.lstatSync(file);
    const rootAfter = fs.lstatSync(dir);
    if (rootAfter.isSymbolicLink() || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino) {
      throw new Error("Review directory changed while reading");
    }
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("Review file changed while reading");
    }
    const raw = buf.toString("utf8");
    return { raw, md: splitReviewFile(raw).md, version: createHash("sha256").update(buf).digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function linkUnsupported(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS" || code === "EXDEV" || code === "EMLINK";
}

export function renameReviewFileNoReplace(dir: string, from: string, to: string): void {
  const src = reviewFilePath(dir, from);
  const dst = reviewFilePath(dir, to);
  if (src === dst) return;
  if (from.toLowerCase() === to.toLowerCase()) throw new Error("Case-only rename is not supported");

  const st = fs.lstatSync(src);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("Review file must be a regular file");

  let created = false;
  try {
    try {
      fs.linkSync(src, dst);
      created = true;
    } catch (e) {
      if (!linkUnsupported(e)) throw e;
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      created = true;
    }
    fs.unlinkSync(src);
  } catch (e) {
    if (created) {
      try {
        fs.unlinkSync(dst);
      } catch {
        // Keep the original error. The original source was never removed.
      }
    }
    throw e;
  }
}

/** 先按首部里的原始题名找，找不到再按旧合写格式拆出来的题名找 */
function titleCandidates(value: string): string[] {
  const raw = S(value);
  if (!raw) return [];
  const parsed = splitLegacyReviewLabel(raw);
  const out: string[] = [];
  const add = (t: string) => {
    const s = S(t);
    if (s && !out.includes(s)) out.push(s);
  };
  const unwrap = (t: string) => {
    const m = /^《(.*)》$/.exec(S(t));
    return m ? m[1] : t;
  };
  add(raw);
  add(unwrap(raw));
  if (parsed) {
    add(parsed.title);
    add(unwrap(parsed.title));
  }
  return out;
}

function headerMatch(db: DB, fields: Record<string, string>): ReviewMatch | null {
  const explicitAuthor = S(fields["作者"]);
  const bookVal = S(fields["书籍"]);
  const seriesVal = S(fields["系列"]);
  let book: Row | null = null;
  let series: Row | null = null;

  if (bookVal) {
    /* 显式作者优先；没有时退回旧格式「作者-《题名》」里推断的作者 */
    const author = explicitAuthor || S(splitLegacyReviewLabel(bookVal)?.author);
    for (const title of titleCandidates(bookVal)) {
      book = findBook(db, title, author);
      if (book) break;
    }
  }

  if (seriesVal) {
    const author = explicitAuthor || S(splitLegacyReviewLabel(seriesVal)?.author);
    for (const title of titleCandidates(seriesVal)) {
      series = findSeries(db, title, author);
      if (series) break;
    }
  }

  if (book && series) {
    if (S(book.series_id) !== S(series.id)) return null;
    return mkBook(book, 2);
  }
  if (book) return mkBook(book, 2);
  if (series) return mkSeries(series, 2);
  return null;
}

function matchStem(db: DB, stem: string): ReviewMatch | null {
  const s = S(stem);
  if (!s || s.startsWith("草稿-")) return null;

  const suffix = /^(.*)(书评|系列)$/.exec(s);
  if (suffix && suffix[1].includes("《")) {
    const parsed = splitLabel(suffix[1]);
    if (suffix[2] === "书评") {
      const row = findBook(db, parsed.title, parsed.author);
      if (row) return mkBook(row, 1);
    } else {
      const row = findSeries(db, parsed.title, parsed.author);
      if (row) return mkSeries(row, 1);
    }
  }

  const parsed = splitLabel(s);
  const book = findBook(db, parsed.title, parsed.author);
  return book ? mkBook(book, 1) : null;
}

export function matchReviewFile(db: DB, fileName: string, fields: Record<string, string>): ReviewMatch {
  const header = headerMatch(db, fields);
  if (header) return header;

  const stem = fileName.replace(/\.md$/i, "").replace(/^未匹配-/, "");
  if (stem.startsWith("草稿-")) {
    return { kind: "draft", bookId: null, seriesId: null, strength: 0 };
  }

  const clean = stem.replace(/-重名\d+$/, "");
  const match = matchStem(db, stem) ?? (clean !== stem ? matchStem(db, clean) : null);
  return match ?? { kind: "orphan", bookId: null, seriesId: null, strength: 0 };
}
