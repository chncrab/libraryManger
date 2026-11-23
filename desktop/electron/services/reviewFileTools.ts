import fs from "node:fs";
import path from "node:path";

import type { DB } from "../db";
import type { ReviewIoSummary } from "../../shared/types";
import {
  matchReviewFile,
  readReviewFile,
  reconcileReviewFiles,
  renameReviewFileNoReplace,
  reviewFilePath,
  splitReviewFile,
  splitLegacyReviewLabel
} from "./reviewFiles";
import { listReviews } from "./reviewService";
import { refreshLinkedReviewFront } from "./reviewFileEdits";
import { seriesAuthor, seriesTitle } from "./seriesService";

/* ------------------------------------------------------------------ */
/* 公共小工具                                                          */
/* ------------------------------------------------------------------ */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const MD_EXT = /\.md$/i;
const IMPORT_EXT = /\.(md|markdown|txt)$/i;

/** 程序拥有、strip 时可以删掉的首部键 */
const OWNED_KEYS = ["书籍", "系列", "作者", "评分", "分类", "阅读时间"] as const;
const OWNED_SET = new Set<string>(OWNED_KEYS as readonly string[]);

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function emptySummary(dir = ""): ReviewIoSummary {
  return {
    added: 0,
    updated: 0,
    orphan: 0,
    skipped: 0,
    written: 0,
    removed: 0,
    renamed: 0,
    filled: 0,
    backup: "",
    dir,
    msgs: []
  };
}

function hasBom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/** 读原始字节，同时给出剥掉 BOM 的文本与行尾风格 */
function readRaw(file: string): { raw: Buffer; text: string; bom: boolean; eol: "\r\n" | "\n" } {
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
  return { raw, text, bom: hasBom(raw), eol };
}

/** 正文文本；只取 readReviewFile 返回的 .raw */
function readText(file: string): string {
  const r = readReviewFile(path.dirname(file), path.basename(file));
  return String(r.raw || "").replace(/^\uFEFF/, "");
}

/** 首部里 `---` 之间的那几行 */
function innerFront(front: string): string {
  if (!front) return "";
  const lines = front.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
  let j = lines.length - 1;
  while (j > i && !/^---\s*$/.test(lines[j])) j--;
  if (j <= i) return "";
  return lines.slice(i + 1, j).join("\n");
}

/** 首部里出现过的键 */
function frontKeys(front: string): string[] {
  const s = new Set<string>();
  for (const line of innerFront(front).split("\n")) {
    const m = /^([^\s:#][^:]*?)\s*:/.exec(line);
    if (m) s.add(m[1].trim());
  }
  return [...s];
}

/** 从首部内部文本里删掉给定键（连同它下面的列表/缩进子项） */
function stripInner(inner: string, keys: Set<string>): string {
  const lines = inner.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const m = /^([^\s:#][^:]*?)\s*:/.exec(line);
    if (m) {
      skipping = keys.has(m[1].trim());
      if (!skipping) out.push(line);
      continue;
    }
    if (skipping && (/^\s+\S/.test(line) || /^\s*-\s*\S/.test(line))) continue;
    skipping = false;
    out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "");
}

function safeName(s: string): string {
  return String(s || "")
    .replace(BAD_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
}

function joinName(a: string, t: string): string {
  return [safeName(a), safeName(t)].filter(Boolean).join("-");
}

/** 独占写入；同名同内容视为无需写入，同名不同内容换 -重名N */
function writeUnique(dir: string, name: string, data: Buffer): { name: string; wrote: boolean } | null {
  const stem = name.replace(MD_EXT, "");
  let candidate = name;
  for (let n = 1; n <= 999; n++) {
    const p = path.join(dir, candidate);
    try {
      fs.writeFileSync(p, data, { flag: "wx" });
      return { name: candidate, wrote: true };
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== "EEXIST") return null;
      try {
        if (fs.readFileSync(p).equals(data)) return { name: candidate, wrote: false };
      } catch {
        /* 读不到就当作不同内容，换个名字再来 */
      }
      candidate = `${stem}-重名${n + 1}.md`;
    }
  }
  return null;
}

/** 写临时文件 → 确认原文件未被改动 → 原子替换 */
function atomicSwap(file: string, data: Buffer, expected: Buffer): boolean {
  let cur: Buffer;
  try {
    cur = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (!cur.equals(expected)) return false;

  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, data, { flag: "wx" });
  } catch {
    return false;
  }

  try {
    if (!fs.readFileSync(file).equals(expected)) {
      fs.unlinkSync(tmp);
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理临时文件失败就算了 */
    }
    return false;
  }
}

function copyDir(from: string, to: string): number {
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else if (e.isFile()) {
      fs.copyFileSync(a, b);
      n++;
    }
  }
  return n;
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** 一本书的规范名（作者-书名），没作者就只留书名 */
function bookFileName(db: DB, bookId: string): string {
  const r = db
    .prepare(
      `SELECT b.title AS title,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
         FROM books b WHERE b.id = ?`
    )
    .get(bookId) as any;
  if (!r) return "";
  return joinName(String(r.author || ""), String(r.title || ""));
}

/** 一个系列/一本书的规范名，只看库里实际的名字 */
function targetName(db: DB, kind: string, id: number, bookId?: string | null, seriesId?: number | null): string {
  const k = String(kind || "");
  if (k === "book") {
    let bid = String(bookId || "");
    if (!bid) {
      const r = db.prepare("SELECT book_id AS b FROM reviews WHERE id = ?").get(id) as any;
      bid = r && r.b ? String(r.b) : "";
    }
    return bid ? bookFileName(db, bid) : "";
  }
  if (k === "series") {
    let sid = seriesId != null ? Number(seriesId) || 0 : 0;
    if (!sid) {
      const r = db.prepare("SELECT series_id AS s FROM reviews WHERE id = ?").get(id) as any;
      sid = r ? Number(r.s) || 0 : 0;
    }
    if (!sid) return "";
    const row = db.prepare("SELECT name FROM series WHERE id = ?").get(sid) as any;
    const title = row ? String(row.name || "") : "";
    return joinName(seriesAuthor(db, sid) || "", seriesTitle(title));
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* 1. 列目录里的 Markdown                                              */
/* ------------------------------------------------------------------ */

/** 只列本层常规 .md 文件，返回全路径，不跟链接、不递归 */
export function listReviewMarkdown(dir: string): string[] {
  const root = path.resolve(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!MD_EXT.test(e.name)) continue;
    out.push(path.join(root, e.name));
  }
  out.sort((a, b) => a.localeCompare(b, "zh"));
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 导入文件                                                         */
/* ------------------------------------------------------------------ */

/** 把给定文件逐字节搬进书评目录：只增不改不删，后缀统一成 .md */
export function importFileReviews(db: DB, dir: string, files: string[]): ReviewIoSummary {
  const root = path.resolve(dir);
  const out = emptySummary(root);
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error("不是目录");
  } catch (e) {
    out.msgs.push("书评目录不可用：" + ((e as Error)?.message || String(e)));
    return out;
  }

  const seen = new Set<string>();
  for (const input of files || []) {
    const src = path.resolve(String(input || ""));
    if (!src) continue;
    if (seen.has(src)) {
      out.skipped++;
      continue;
    }
    seen.add(src);

    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch {
      out.orphan++;
      out.msgs.push("找不到文件：" + src);
      continue;
    }
    if (!st.isFile()) {
      out.skipped++;
      out.msgs.push("不是常规文件，已跳过：" + src);
      continue;
    }
    if (!IMPORT_EXT.test(src)) {
      out.skipped++;
      out.msgs.push("后缀不认识，已跳过：" + path.basename(src));
      continue;
    }

    let data: Buffer;
    try {
      data = fs.readFileSync(src);
    } catch (e) {
      out.orphan++;
      out.msgs.push("读不了：" + src + "（" + ((e as Error)?.message || String(e)) + "）");
      continue;
    }

    const base = path.basename(src);
    const stem = base.replace(IMPORT_EXT, "");
    const got = writeUnique(root, safeName(stem) + ".md", data);
    if (!got) {
      out.skipped++;
      out.msgs.push("写不进去：" + base);
      continue;
    }
    if (got.wrote) {
      out.added++;
      out.written++;
      if (got.name !== safeName(stem) + ".md") out.msgs.push(`${base} → ${got.name}（重名避让）`);
    } else {
      out.skipped++;
    }
  }

  reconcileReviewFiles(db, root);
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. 导出                                                             */
/* ------------------------------------------------------------------ */

/** 按实际文件名把当前 Markdown 整份抄到 dest，只增不覆盖 */
export function exportFileReviews(db: DB, dir: string, dest: string): ReviewIoSummary {
  const from = path.resolve(dir);
  const to = path.resolve(dest);
  const out = emptySummary(to);

  if (!to || isInside(from, to)) {
    out.msgs.push("导出目录不能是书评目录本身或它的子目录");
    return out;
  }
  if (!fs.existsSync(from)) {
    out.msgs.push("书评目录不存在：" + from);
    return out;
  }
  try {
    fs.mkdirSync(to, { recursive: true });
  } catch (e) {
    out.msgs.push("建不了导出目录：" + ((e as Error)?.message || String(e)));
    return out;
  }

  const names = new Set<string>();
  for (const r of listReviews(db) as any[]) {
    const n = String(r?.fileName || "");
    if (n && path.basename(n) === n) names.add(n);
  }
  for (const p of listReviewMarkdown(from)) names.add(path.basename(p));

  const ordered = [...names].sort((a, b) => a.localeCompare(b, "zh"));
  for (const name of ordered) {
    const src = reviewFilePath(from, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch {
      out.orphan++;
      out.msgs.push("文件已不在：" + name);
      continue;
    }
    if (!st.isFile()) {
      out.skipped++;
      continue;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(src);
    } catch (e) {
      out.orphan++;
      out.msgs.push("读不了：" + name + "（" + ((e as Error)?.message || String(e)) + "）");
      continue;
    }
    try {
      fs.writeFileSync(path.join(to, name), data, { flag: "wx" });
      out.written++;
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "EEXIST") {
        out.skipped++;
        out.msgs.push("导出目录里已有同名文件，未覆盖：" + name);
      } else {
        out.skipped++;
        out.msgs.push("写不出去：" + name);
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 4. 批量改文件                                                       */
/* ------------------------------------------------------------------ */

/**
 * 只由用户点击触发。先整目录备份，再按 mode 动文件；
 * 改名保留字节，补齐只动首部，剥离只删程序自己的键。
 */
export function bulkEditReviewFiles(
  db: DB,
  dir: string,
  backupDir: string,
  mode: "rename" | "fill" | "strip"
): ReviewIoSummary {
  const root = path.resolve(dir);
  const out = emptySummary(root);

  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    out.msgs.push("书评目录不存在：" + root);
    return out;
  }
  if (!st.isDirectory()) {
    out.msgs.push("不是目录：" + root);
    return out;
  }

  const backupRoot = path.resolve(String(backupDir || ""));
  if (!backupDir || !backupRoot) {
    out.msgs.push("没有指定备份目录，已停下");
    return out;
  }
  if (isInside(root, backupRoot) || isInside(backupRoot, root)) {
    out.msgs.push("备份目录不能与书评目录互相包含");
    return out;
  }
  let bak: string;
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    bak = fs.mkdtempSync(path.join(backupRoot, "review-" + mode + "-"));
    copyDir(root, bak);
    out.backup = bak;
  } catch (e) {
    out.msgs.push("备份失败，已停下：" + ((e as Error)?.message || String(e)));
    return out;
  }

  reconcileReviewFiles(db, root);

  let rows: any[] = [];
  try {
    rows = listReviews(db) as any[];
  } catch (e) {
    out.msgs.push("取不到书评清单：" + ((e as Error)?.message || String(e)));
    return out;
  }

  for (const r of rows) {
    const fileName = String(r?.fileName || "");
    const kind = String(r?.kind || "");
    const id = Number(r?.id) || 0;
    if (!fileName) {
      out.orphan++;
      continue;
    }

    const file = reviewFilePath(root, fileName);
    let exists = false;
    try {
      exists = fs.lstatSync(file).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      out.orphan++;
      out.msgs.push("文件已不在：" + fileName);
      continue;
    }

    try {
      if (mode === "rename") {
        const want = targetName(db, kind, id, r?.bookId, r?.seriesId);
        if (!want) {
          out.skipped++;
          out.msgs.push("库里没有可用的名字，跳过：" + fileName);
          continue;
        }
        const wantFile = want + ".md";
        if (wantFile === fileName) {
          out.skipped++;
          continue;
        }
        renameReviewFileNoReplace(root, fileName, wantFile);
        out.renamed = (out.renamed || 0) + 1;
        out.written++;
        continue;
      }

      if (mode === "fill") {
        if (kind !== "book" && kind !== "series") {
          out.skipped++;
          continue;
        }
        const before = fs.readFileSync(file);
        const text = readText(file);
        const parts = splitReviewFile(text);
        const present = new Set(frontKeys(parts.front || ""));
        const keys = OWNED_KEYS.filter(
          (k) => !present.has(k) || (k === "作者" && !String(parts.fields?.[k] ?? "").trim())
        );
        /* 旧文件把作者塞在 书籍/系列 里时，补作者要连题名一起改回纯标题 */
        if (!present.has("作者") || !String(parts.fields?.["作者"] ?? "").trim()) {
          for (const k of ["书籍", "系列"] as const) {
            const v = String(parts.fields?.[k] ?? "");
            if (v && splitLegacyReviewLabel(v)?.author && !keys.includes(k)) keys.push(k);
          }
        }
        if (!keys.length) {
          out.skipped++;
          continue;
        }
        refreshLinkedReviewFront(
          db,
          root,
          bak,
          { bookId: r.bookId, seriesId: r.seriesId },
          [...keys]
        );
        const after = fs.readFileSync(file);
        if (!before.equals(after)) {
          out.filled = (out.filled || 0) + 1;
          out.written++;
        } else {
          out.skipped++;
        }
        continue;
      }

      /* mode === "strip" */
      const m = matchReviewFile(db, fileName, {});
      const same =
        !!m &&
        String(m.kind) === kind &&
        (Number(m.bookId) || 0) === (Number(r?.bookId) || 0) &&
        (Number(m.seriesId) || 0) === (Number(r?.seriesId) || 0);
      if (!same) {
        out.skipped++;
        out.msgs.push("去掉库字段后就无法按文件名重新对上，已跳过：" + fileName);
        continue;
      }

      const raw = readRaw(file);
      const text = readText(file);
      const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
      const parts = splitReviewFile(text);
      const inner = innerFront(parts.front || "");
      if (!inner.trim()) {
        out.skipped++;
        continue;
      }
      const kept = stripInner(inner, OWNED_SET);
      if (kept === inner) {
        out.skipped++;
        continue;
      }

      const newFront = kept.trim() ? "---" + eol + kept.replace(/\r?\n/g, eol) + eol + "---" + eol : "";
      let next = newFront + (parts.md || "");
      if (eol === "\r\n") next = next.replace(/\r?\n/g, "\r\n");

      const bytes = Buffer.concat([raw.bom ? BOM : Buffer.alloc(0), Buffer.from(next, "utf8")]);
      if (!atomicSwap(file, bytes, raw.raw)) {
        out.skipped++;
        out.msgs.push("文件在写入前被改动，已跳过：" + fileName);
        continue;
      }
      out.written++;
    } catch (e) {
      out.skipped++;
      out.msgs.push(fileName + "：" + ((e as Error)?.message || String(e)));
    }
  }

  reconcileReviewFiles(db, root);
  return out;
}
