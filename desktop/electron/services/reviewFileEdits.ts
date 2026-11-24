import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DB } from "../db";
import type { ReviewRow, ReviewInput, ReviewPatch, RvResult, ReviewFileContent } from "../../shared/types";
import { listReviews, sanitizeFile, seriesReviewStem } from "./reviewService";
import { seriesAuthor, seriesLabel } from "./seriesService";
import {
  splitReviewFile,
  readReviewFile,
  reviewFilePath,
  renameReviewFileNoReplace,
  reconcileReviewFiles,
  reviewFileVersion,
  splitLegacyReviewLabel,
} from "./reviewFiles";
import { readReviewFrontmatter, patchReviewFrontmatter } from "./reviewFrontmatter";

type AnyDb = any;
type DiskReview = { raw: string; md: string; version: string };
type FrontPatch = Record<string, string | undefined>;

const S = (v: unknown): string => String(v ?? "").trim();

function dbAny(db: DB): AnyDb {
  return db as AnyDb;
}

function allRows(db: DB): ReviewRow[] {
  return listReviews(db);
}

function findRow(db: DB, kind: string, id: number): ReviewRow | null {
  return allRows(db).find((r) => r.kind === kind && r.id === id) || null;
}

function findByFileName(db: DB, fileName: string): ReviewRow | null {
  return allRows(db).find((r) => r.fileName === fileName) || null;
}

function filePath(dir: string, fileName: string): string {
  return reviewFilePath(dir, fileName);
}

function ensureMd(name: string): string {
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

function buildFront(fields: Record<string, string>, nl = "\n"): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && `${v}` !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(nl);
  return `---${nl}${body}${body ? nl : ""}---${nl}`;
}

function patchFront(front: string, set: FrontPatch, clear: string[]): string {
  let bom = "";
  if (front.charCodeAt(0) === 0xfeff) {
    bom = front[0];
    front = front.slice(1);
  }
  const nl = front.includes("\r\n") ? "\r\n" : "\n";
  const lines = front.split(/\r?\n/);
  const hasFront = (lines[0] || "").trim() === "---";

  if (!hasFront) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(set)) {
      if (v !== undefined && v !== null && `${v}` !== "") fields[k] = String(v);
    }
    if (Object.keys(fields).length === 0) return bom + front;
    const built = buildFront(fields, nl);
    return bom + built + nl + front;
  }

  let start = 1;
  let end = lines.length;
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^([^:]+):(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1].trim();
    if (clear.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(set, key)) {
      const v = set[key];
      if (v === undefined || v === null || `${v}` === "") continue;
      out.push(`${key}: ${v}`);
      seen.add(key);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of Object.entries(set)) {
    if (v !== undefined && v !== null && `${v}` !== "" && !seen.has(k) && !clear.includes(k)) {
      out.push(`${k}: ${v}`);
    }
  }
  const joined = [...lines.slice(0, start), ...out, ...lines.slice(end)].join(nl);
  return bom + joined + (front.endsWith(nl) && !joined.endsWith(nl) ? nl : "");
}

/**
 * 原子写：先写 temp 并 fsync，重新读回校验内容后，
 * 若给出 expectedVersion 则校验现有目标文件一致（CAS），再 rename temp。
 * expectedVersion 为 null/undefined 时用 link+unlink 实现 no-replace 语义。
 */
function atomicWrite(
  dir: string,
  name: string,
  raw: string,
  expectedVersion: string | null | undefined
): void {
  const target = filePath(dir, name);
  const tmpName = `.${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmp = path.join(dir, tmpName);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeFileSync(fd, raw, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;

    if (fs.readFileSync(tmp, "utf8") !== raw) throw new Error("临时文件校验失败");

    if (expectedVersion !== null && expectedVersion !== undefined) {
      const cur = readReviewFile(dir, name);
      if (cur.version !== expectedVersion) throw new Error("版本不一致");
      fs.renameSync(tmp, target);
    } else {
      fs.linkSync(tmp, target);
      fs.unlinkSync(tmp);
    }
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function recovery(
  recoveryDir: string,
  base: string,
  msg: string,
  md?: string
): RvResult {
  if (md === undefined) return { ok: false, msg };
  try {
    fs.mkdirSync(recoveryDir, { recursive: true });
    const safe = sanitizeFile(base || "review") || "review";
    for (let i = 0; i < 1000; i++) {
      const p = path.join(
        recoveryDir,
        `恢复稿-${safe}-${Date.now()}-${i}-${Math.random().toString(16).slice(2)}.md`
      );
      try {
        fs.writeFileSync(p, md, { encoding: "utf8", flag: "wx" });
        return { ok: false, msg, recoveryPath: p };
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
    }
  } catch {}
  return { ok: false, msg };
}

function editRevision(row: any): number | undefined {
  const v = Number(row?.editRevision ?? row?.edit_revision);
  return Number.isFinite(v) ? v : undefined;
}

function bookAuthorOf(db: DB, bookId: string): string {
  const d = dbAny(db);
  try {
    const ar = d
      .prepare(
        "SELECT a.name FROM book_authors ba JOIN authors a ON a.id=ba.author_id WHERE ba.book_id=? ORDER BY ba.ord, a.name"
      )
      .all(bookId) as any[];
    return ar.map((x) => x.name).filter(Boolean).join("、");
  } catch {
    return "";
  }
}

function ownBookInfo(
  db: DB,
  bookId: string,
  overrideTitle?: string
): { title: string; author: string } {
  const d = dbAny(db);
  const b = d.prepare("SELECT title FROM books WHERE id=?").get(bookId) as any;
  if (!b) return { title: "", author: "" };
  const title = overrideTitle !== undefined ? overrideTitle : String(b.title || "");
  return { title, author: bookAuthorOf(db, bookId) };
}

function ownSeriesInfo(
  db: DB,
  seriesId: number,
  overrideName?: string
): { title: string; author: string } {
  const d = dbAny(db);
  const s = d.prepare("SELECT name, zh_name FROM series WHERE id=?").get(seriesId) as any;
  if (!s) return { title: "", author: "" };
  const display = String(s.zh_name || "").trim() || seriesLabel(String(s.name || ""));
  const title = overrideName !== undefined ? overrideName : display;
  return { title, author: seriesAuthor(db, seriesId) || "" };
}

/** 旧合写首部里拆出来的作者；已经有显式作者时不再推断 */
function legacyAuthor(fields: Record<string, string> | undefined, key: "书籍" | "系列"): string {
  if (!fields || S(fields["作者"])) return "";
  const value = S(fields[key]);
  return S(splitLegacyReviewLabel(value)?.author);
}

/** 只读投影：旧合写「作者-《题名》」在面板里拆成作者与纯题名，不动磁盘 */
function projectFrontmatter(raw: string): { key: string; value: string }[] {
  const out = readReviewFrontmatter(raw).map((f) => ({ ...f }));
  const authorField = out.find((f) => f.key === "作者");
  let authorReady = !!authorField && S(authorField.value) !== "";
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    if (f.key !== "书籍" && f.key !== "系列") continue;
    const parsed = splitLegacyReviewLabel(f.value);
    if (!parsed) continue;
    if (parsed.title && parsed.title !== f.value) out[i] = { ...f, value: parsed.title };
    if (!parsed.author || authorReady) continue;
    if (authorField) {
      authorField.value = parsed.author;
      authorReady = true;
    } else {
      out.splice(i, 0, { key: "作者", value: parsed.author });
      authorReady = true;
      i++;
    }
  }
  return out;
}

/**
 * 落盘前把真实旧首部定点归一：只处理明确的「作者-《题名》」合写，
 * 普通书名不猜着拆；已有显式作者时保留它，只把题名改回纯标题。
 */
function normalizeLegacyFront(raw: string): string {
  const fields = splitReviewFile(raw).fields || {};
  const explicitAuthor = S(fields["作者"]);
  const changes: { key: string; value: string }[] = [];
  for (const key of ["书籍", "系列"] as const) {
    const value = S(fields[key]);
    if (!value) continue;
    const parsed = splitLegacyReviewLabel(value);
    if (!parsed) continue;
    if (parsed.title && parsed.title !== value) changes.push({ key, value: parsed.title });
    if (!explicitAuthor && !changes.some((c) => c.key === "作者")) {
      changes.push({ key: "作者", value: parsed.author });
    }
  }
  if (!changes.length) return raw;
  try {
    return patchReviewFrontmatter(raw, changes);
  } catch {
    return raw;
  }
}

function catsOfBook(db: DB, bookId: string): string[] {
  if (!bookId) return [];
  const rows = db
    .prepare(
      `SELECT c.name AS name, c.ord AS cOrd, p.ord AS pOrd
         FROM book_categories bc
         JOIN categories c ON c.id = bc.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        WHERE bc.book_id = ?`
    )
    .all(bookId) as any[];
  const seen = new Set<string>();
  const out: { name: string; root: number; leaf: number }[] = [];
  for (const r of rows) {
    const name = String(r.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      root: Number(r.pOrd ?? r.cOrd) || 0,
      leaf: r.pOrd == null ? 0 : Number(r.cOrd) || 0,
    });
  }
  out.sort(
    (a, b) => a.root - b.root || a.leaf - b.leaf || a.name.localeCompare(b.name, "zh")
  );
  return out.map((o) => o.name);
}

export function getIndexedReview(db: DB, kind: string, id: number): ReviewRow | null {
  return findRow(db, kind, id);
}

export function readIndexedReview(
  db: DB,
  dir: string,
  kind: string,
  id: number
): ReviewFileContent | null {
  const row = getIndexedReview(db, kind, id);
  if (!row) return null;
  try {
    const disk = readReviewFile(dir, row.fileName);
    return {
      ...row,
      md: disk.md,
      raw: disk.raw,
      version: disk.version,
      frontmatter: projectFrontmatter(disk.raw),
    };
  } catch {
    return null;
  }
}

export function createFileReview(db: DB, dir: string, p: ReviewInput): RvResult {
  const d = dbAny(db);
  const hasBook = p.bookId !== undefined && p.bookId !== null && p.bookId !== "";
  const hasSeries = p.seriesId !== undefined && p.seriesId !== null;
  if (hasBook && hasSeries) {
    return { ok: false, msg: "不能同时指定书籍和系列" };
  }

  try {
    if (!fs.lstatSync(dir).isDirectory()) {
      return { ok: false, msg: "书评目录不可用" };
    }
  } catch {
    return { ok: false, msg: "书评目录不可用" };
  }

  let kind: ReviewRow["kind"] = "draft";
  let bookId: string | null = null;
  let seriesId: number | null = null;
  let title = p.name || "未命名";
  const fields: Record<string, string> = {};

  if (hasSeries) {
    kind = "series";
    seriesId = p.seriesId as number;
    const info = ownSeriesInfo(db, seriesId);
    if (!info.title) return { ok: false, msg: "系列不存在" };
    title = info.title;
    fields["系列"] = title;
    if (info.author) fields["作者"] = info.author;
  } else if (hasBook) {
    kind = "book";
    bookId = String(p.bookId);
    const b = d
      .prepare("SELECT id,title,read_date,rating,deleted_at FROM books WHERE id=?")
      .get(bookId) as any;
    if (!b) return { ok: false, msg: "书籍不存在" };
    if (b.deleted_at) return { ok: false, msg: "书籍已软删" };
    title = String(b.title || p.name || "未命名");
    const info = ownBookInfo(db, bookId);
    if (info.title) fields["书籍"] = info.title;
    if (info.author) fields["作者"] = info.author;
    if (b.read_date) {
      const dd = String(b.read_date).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) fields["阅读时间"] = dd;
    }
    if (b.rating !== null && b.rating !== undefined && Number(b.rating) > 0) {
      fields["评分"] = String(b.rating);
    }
  } else {
    title = p.name || "未命名";
  }

  if (p.happenedAt) fields["阅读时间"] = p.happenedAt;
  if (p.grade) fields["书评等级"] = p.grade;

  if (bookId !== null || seriesId !== null) {
    const occupied = allRows(db).find(
      (r) =>
        (bookId !== null && r.bookId === bookId) ||
        (seriesId !== null && r.seriesId === seriesId)
    );
    if (occupied) {
      return { ok: false, id: occupied.id, msg: "目标已有书评", fileName: occupied.fileName };
    }
  }

  const raw = buildFront(fields) + "\n" + (p.md || "");
  const safeTitle = sanitizeFile(title) || "未命名";
  let base = kind === "draft" ? `草稿-${safeTitle}` : safeTitle;
  if (kind === "series") {
    base = seriesReviewStem(fields["作者"] || "", title);
  }

  let created = "";
  for (let n = 0; n < 1000 && !created; n++) {
    const name = ensureMd(n === 0 ? base : `${base}-${n + 1}`);
    try {
      atomicWrite(dir, name, raw, null);
      created = name;
    } catch (e: any) {
      if (e?.code === "EEXIST") continue;
      throw e;
    }
  }
  if (!created) return { ok: false, msg: "无法创建书评文件" };

  try {
    reconcileReviewFiles(db, dir);
  } catch {}

  const row = findByFileName(db, created);
  if (!row) return { ok: false, msg: "对账未找到书评", fileName: created };
  return {
    ok: true,
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    version: reviewFileVersion(db, row.kind, row.id),
  };
}

function findEditedReview(db: DB, fileName: string, version: string): ReviewRow | null {
  const direct = findByFileName(db, fileName);
  if (direct) return reviewFileVersion(db, direct.kind, direct.id) === version ? direct : null;

  /* 重新匹配时，只有未匹配前缀以及重名时追加的尾缀允许发生变化。 */
  const original = fileName.replace(/\.md$/i, "");
  const renamed = original.startsWith("未匹配-") ? original.slice("未匹配-".length) : "未匹配-" + original;
  const candidates = listReviews(db).filter((row) => {
    const name = row.fileName.replace(/\.md$/i, "");
    if (name !== renamed && name.replace(/-重名\d+$/, "") !== renamed) return false;
    return reviewFileVersion(db, row.kind, row.id) === version;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function updateFileReview(
  db: DB,
  dir: string,
  recoveryDir: string,
  kind: string,
  id: number,
  p: ReviewPatch
): RvResult {
  const row = getIndexedReview(db, kind, id);
  if (!row) return recovery(recoveryDir, `${kind}-${id}`, "索引缺失", p.md);

  if (p.frontmatter !== undefined && (!p.expectedVersion || !p.expectedFileName)) {
    return { ok: false, msg: "书评版本未知，请重新打开标签编辑" };
  }

  let disk: DiskReview;
  try {
    disk = readReviewFile(dir, row.fileName);
  } catch {
    return recovery(recoveryDir, row.fileName, "磁盘文件缺失", p.md);
  }

  if (p.expectedVersion && p.expectedVersion !== disk.version) {
    return recovery(recoveryDir, row.fileName, "版本不一致", p.md);
  }
  if (p.expectedFileName && p.expectedFileName !== row.fileName) {
    return recovery(recoveryDir, row.fileName, "文件名不一致", p.md);
  }

  const split = splitReviewFile(disk.raw);
  const newMd = p.md !== undefined && p.md !== disk.md ? p.md : split.md;

  let finalName = row.fileName;
  if (p.fileName !== undefined && p.fileName !== "") {
    let fn = ensureMd(sanitizeFile(p.fileName));
    if (kind === "draft" && !fn.startsWith("草稿-")) fn = `草稿-${fn}`;
    finalName = fn;
  }
  const renaming = finalName !== row.fileName;

  const set: FrontPatch = {};
  const clear: string[] = [];

  if (p.grade !== undefined) {
    if (p.grade) set["书评等级"] = p.grade;
    else clear.push("书评等级");
  }
  if (p.happenedAt !== undefined) {
    if (p.happenedAt) set["阅读时间"] = p.happenedAt;
    else clear.push("阅读时间");
  }
  if (p.name !== undefined) {
    if (kind === "book" && row.bookId) {
      const info = ownBookInfo(db, row.bookId, p.name);
      if (info.title) set["书籍"] = info.title;
    } else if (kind === "series" && row.seriesId !== null) {
      const info = ownSeriesInfo(db, row.seriesId, p.name);
      if (info.title) set["系列"] = info.title;
    }
  }

  if (renaming || p.name !== undefined) {
    const explicitAuthor = S(split.fields?.["作者"]) !== "";
    if (kind === "book" && row.bookId) {
      const info = ownBookInfo(db, row.bookId);
      if (!set["书籍"] && (!split.fields || split.fields["书籍"] === undefined)) {
        if (info.title) set["书籍"] = info.title;
      }
      if (!explicitAuthor && (info.author || legacyAuthor(split.fields, "书籍"))) {
        set["作者"] = info.author || legacyAuthor(split.fields, "书籍");
      }
    }
    if (kind === "series" && row.seriesId !== null) {
      const info = ownSeriesInfo(db, row.seriesId);
      if (!set["系列"] && (!split.fields || split.fields["系列"] === undefined)) {
        if (info.title) set["系列"] = info.title;
      }
      if (!explicitAuthor && (info.author || legacyAuthor(split.fields, "系列"))) {
        set["作者"] = info.author || legacyAuthor(split.fields, "系列");
      }
    }
  }

  const hasSet = Object.keys(set).length > 0 || clear.length > 0;
  const newFront = hasSet ? patchFront(split.front, set, clear) : split.front;
  const baseRaw = hasSet || p.md !== undefined ? newFront + newMd : disk.raw;
  let newRaw = baseRaw;
  if (p.frontmatter !== undefined) {
    try {
      /* 先把磁盘上的旧合写首部归一，再套用户的字段改动，避免只改一半丢另一半 */
      const hasChanges = !Array.isArray(p.frontmatter) || p.frontmatter.length > 0;
      const base = hasChanges ? normalizeLegacyFront(baseRaw) : baseRaw;
      newRaw = patchReviewFrontmatter(base, p.frontmatter);
    } catch (e: any) {
      return { ok: false, msg: e?.message ? `标签更新失败：${e.message}` : "标签更新失败" };
    }
  }
  const expectedVersion = createHash("sha256").update(newRaw, "utf8").digest("hex");
  const changed = newRaw !== disk.raw;

  if (!changed && !renaming) {
    return {
      ok: true,
      id: row.id,
      kind: row.kind,
      fileName: row.fileName,
      version: disk.version,
      editRevision: editRevision(row),
    };
  }

  try {
    if (changed) atomicWrite(dir, row.fileName, newRaw, disk.version);

    if (renaming) {
      const cur = readReviewFile(dir, row.fileName);
      if (changed) {
        if (cur.raw !== newRaw) return recovery(recoveryDir, row.fileName, "提交前内容变化", p.md);
      } else if (cur.version !== disk.version) {
        return recovery(recoveryDir, row.fileName, "提交前版本变化", p.md);
      }
      if (fs.existsSync(filePath(dir, finalName))) {
        return recovery(recoveryDir, finalName, "目标文件名已存在", p.md);
      }
      renameReviewFileNoReplace(dir, row.fileName, finalName);
    }
  } catch (e: any) {
    return recovery(recoveryDir, finalName, e?.message || "写入失败", p.md);
  }

  try {
    reconcileReviewFiles(db, dir);
  } catch {}

  const actual = p.frontmatter === undefined
    ? findByFileName(db, finalName) || getIndexedReview(db, kind, id)
    : findEditedReview(db, finalName, expectedVersion);
  if (!actual) return { ok: false, msg: "对账未找到书评", fileName: finalName };

  let version = "";
  try {
    version = readReviewFile(dir, actual.fileName).version;
  } catch {}

  return {
    ok: true,
    id: actual.id,
    kind: actual.kind,
    fileName: actual.fileName,
    version,
    editRevision: editRevision(row),
  };
}

export function moveFileReview(
  db: DB,
  dir: string,
  recoveryDir: string,
  kind: string,
  id: number,
  target: { bookId?: string; seriesId?: number }
): RvResult {
  const row = getIndexedReview(db, kind, id);
  if (!row) return { ok: false, msg: "索引缺失" };
  const d = dbAny(db);
  const bookId = target.bookId ?? null;
  const seriesId = target.seriesId ?? null;
  if ((bookId && seriesId !== null) || (!bookId && seriesId === null)) {
    return { ok: false, msg: "必须且只能指定一个目标" };
  }

  const occupied = allRows(db).find(
    (r) =>
      r.id !== row.id &&
      ((bookId && r.bookId === bookId) || (seriesId !== null && r.seriesId === seriesId))
  );
  if (occupied) {
    return { ok: false, msg: "目标已有书评", fileName: occupied.fileName };
  }

  if (bookId) {
    if (!d.prepare("SELECT id FROM books WHERE id=?").get(bookId)) {
      return { ok: false, msg: "书籍不存在" };
    }
  } else if (seriesId !== null) {
    if (!d.prepare("SELECT id FROM series WHERE id=?").get(seriesId)) {
      return { ok: false, msg: "系列不存在" };
    }
  }

  let disk: DiskReview;
  try {
    disk = readReviewFile(dir, row.fileName);
  } catch {
    return recovery(recoveryDir, row.fileName, "磁盘文件缺失");
  }
  const sp = splitReviewFile(disk.raw);
  const set: FrontPatch = {};
  const clear: string[] = [];
  if (bookId) {
    const info = ownBookInfo(db, bookId);
    if (info.title) set["书籍"] = info.title;
    else clear.push("书籍");
    if (info.author) set["作者"] = info.author;
    else clear.push("作者");
    clear.push("系列");
  } else {
    const info = ownSeriesInfo(db, seriesId as number);
    if (info.title) set["系列"] = info.title;
    else clear.push("系列");
    if (info.author) set["作者"] = info.author;
    else clear.push("作者");
    clear.push("书籍");
  }
  const nf = patchFront(sp.front, set, clear);
  const raw = nf + sp.md;
  try {
    if (raw !== disk.raw) atomicWrite(dir, row.fileName, raw, disk.version);
    reconcileReviewFiles(db, dir);
  } catch (e: any) {
    return recovery(recoveryDir, row.fileName, e?.message || "移动失败");
  }

  const actual =
    allRows(db).find(
      (r) =>
        (bookId && r.bookId === bookId) ||
        (seriesId !== null && r.seriesId === seriesId)
    ) || getIndexedReview(db, kind, id);
  if (!actual) return { ok: false, msg: "对账未找到书评", fileName: row.fileName };
  let version = "";
  try {
    version = readReviewFile(dir, actual.fileName).version;
  } catch {}
  return {
    ok: true,
    id: actual.id,
    kind: actual.kind,
    fileName: actual.fileName,
    version,
  };
}

export function deleteFileReview(db: DB, dir: string, kind: string, id: number): RvResult {
  const row = getIndexedReview(db, kind, id);
  if (!row) return { ok: false, msg: "索引缺失" };
  let disk: DiskReview;
  try {
    disk = readReviewFile(dir, row.fileName);
  } catch (e: any) {
    return { ok: false, msg: e?.message || "读取失败", fileName: row.fileName };
  }
  const indexVersion = reviewFileVersion(db, kind, id);
  if (indexVersion && disk.version !== indexVersion) {
    return { ok: false, msg: "文件已变更，拒绝删除", fileName: row.fileName };
  }
  try {
    fs.unlinkSync(filePath(dir, row.fileName));
  } catch (e: any) {
    return { ok: false, msg: e?.message || "删除失败", fileName: row.fileName };
  }
  try {
    reconcileReviewFiles(db, dir);
  } catch {}
  return { ok: true, id: row.id, kind: row.kind, fileName: row.fileName, version: disk.version };
}

export function refreshLinkedReviewFront(
  db: DB,
  dir: string,
  _recoveryDir: string,
  target: { bookId?: string | null; seriesId?: number | null },
  keys: ("书籍" | "系列" | "作者" | "阅读时间" | "评分" | "分类")[]
): void {
  const d = dbAny(db);
  const bookId = target.bookId ?? null;
  const seriesId = target.seriesId ?? null;

  let bookTitle = "";
  let bookAuthor = "";
  let bookReadDate = "";
  let bookRating: number | null = null;
  let bookCats: string[] = [];

  if (bookId) {
    const b = d
      .prepare("SELECT id, title, read_date, rating FROM books WHERE id=?")
      .get(bookId) as any;
    if (b) {
      bookTitle = String(b.title || "");
      bookAuthor = bookAuthorOf(db, bookId);
      const dd = String(b.read_date || "").slice(0, 10);
      bookReadDate = /^\d{4}-\d{2}-\d{2}$/.test(dd) ? dd : "";
      bookRating =
        typeof b.rating === "number" && b.rating > 0 ? b.rating : null;
      bookCats = catsOfBook(db, bookId);
    }
  }

  let seriesName = "";
  let seriesAuthorValue = "";
  let seriesReadDate = "";
  let seriesRating: number | null = null;
  let seriesCats: string[] = [];

  if (seriesId !== null) {
    const s = d.prepare("SELECT id, name, zh_name FROM series WHERE id=?").get(seriesId) as any;
    if (s) {
      seriesName = String(s.zh_name || "").trim() || seriesLabel(String(s.name || ""));
      seriesAuthorValue = seriesAuthor(db, seriesId) || "";
      const last = d
        .prepare(
          "SELECT MAX(b.read_date) AS d FROM books b WHERE b.series_id=? AND b.deleted_at IS NULL"
        )
        .get(seriesId) as any;
      const dd = String(last?.d || "").slice(0, 10);
      seriesReadDate = /^\d{4}-\d{2}-\d{2}$/.test(dd) ? dd : "";
      const rated = d
        .prepare(
          `SELECT b.rating AS rating FROM books b
            WHERE b.series_id=? AND b.deleted_at IS NULL AND b.rating > 0
              AND b.read_date IS NOT NULL AND b.read_date <> ''
            ORDER BY b.read_date DESC, b.series_index IS NULL, b.series_index, b.title
            LIMIT 1`
        )
        .get(seriesId) as any;
      seriesRating =
        rated && typeof rated.rating === "number" && rated.rating > 0 ? rated.rating : null;
      const first = d
        .prepare(
          `SELECT id FROM books WHERE series_id=? AND deleted_at IS NULL
            ORDER BY series_index IS NULL, series_index, title LIMIT 1`
        )
        .get(seriesId) as any;
      if (first) seriesCats = catsOfBook(db, String(first.id));
    }
  }

  for (const row of allRows(db)) {
    const matches =
      (bookId && row.bookId === bookId) ||
      (seriesId !== null && row.seriesId === seriesId);
    if (!matches) continue;
    const pth = filePath(dir, row.fileName);
    if (!fs.existsSync(pth)) continue;
    try {
      const disk = readReviewFile(dir, row.fileName);
      const normalized = normalizeLegacyFront(disk.raw);
      const sp = splitReviewFile(normalized);
      const explicitAuthor = S(sp.fields?.["作者"]) !== "";
      /* 「作者」单独在补时以库里的作者为准，标题那边就不要再用旧合写里的作者兜底 */
      const authorKey = keys.includes("作者");
      const set: FrontPatch = {};
      const clear: string[] = [];
      for (const k of keys) {
        if (k === "书籍") {
          if (bookId && bookTitle) {
            set[k] = bookTitle;
            if (!explicitAuthor && !authorKey) {
              const au = bookAuthor || legacyAuthor(sp.fields, "书籍");
              if (au) set["作者"] = au;
            }
          } else clear.push(k);
        } else if (k === "系列") {
          if (seriesId !== null && seriesName) {
            set[k] = seriesName;
            if (!explicitAuthor && !authorKey) {
              const au = seriesAuthorValue || legacyAuthor(sp.fields, "系列");
              if (au) set["作者"] = au;
            }
          } else clear.push(k);
        } else if (k === "作者") {
          const au = bookId ? bookAuthor : seriesId !== null ? seriesAuthorValue : "";
          if (au) set[k] = au;
          else clear.push(k);
        } else if (k === "阅读时间") {
          const v = bookId ? bookReadDate : seriesReadDate;
          if (v) set[k] = v;
          else clear.push(k);
        } else if (k === "评分") {
          const v = bookId ? bookRating : seriesRating;
          if (v !== null) set[k] = String(v);
          else clear.push(k);
        } else if (k === "分类") {
          const cats = bookId ? bookCats : seriesCats;
          if (cats.length > 0) set[k] = cats.join(", ");
          else clear.push(k);
        }
      }
      const nf = patchFront(sp.front, set, clear);
      const nextRaw = nf + sp.md;
      if (nextRaw !== disk.raw) atomicWrite(dir, row.fileName, nextRaw, disk.version);
    } catch {}
  }
}

export function preserveLegacyReviewGrades(db: DB, dir: string): void {
  const d = dbAny(db);
  const legacyFiles = new Set<string>();
  try {
    const r = d.prepare("SELECT value FROM settings WHERE key=?").get("review_files");
    if (r?.value) {
      const obj = JSON.parse(String(r.value)) as Record<string, any>;
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v) legacyFiles.add(v);
        else if (v && typeof v === "object" && v.fileName) legacyFiles.add(String(v.fileName));
      }
    }
  } catch {}

  const hasFilter = legacyFiles.size > 0;

  for (const row of allRows(db)) {
    if (hasFilter && !legacyFiles.has(row.fileName)) continue;
    const grade = row.grade === "god" || row.grade === "bad" ? row.grade : "";
    if (!grade) continue;
    const pth = filePath(dir, row.fileName);
    if (!fs.existsSync(pth)) continue;
    try {
      const disk = readReviewFile(dir, row.fileName);
      const sp = splitReviewFile(disk.raw);
      if (sp.fields && sp.fields["书评等级"] !== undefined) continue;
      const nf = patchFront(sp.front, { 书评等级: grade }, []);
      if (nf !== sp.front) atomicWrite(dir, row.fileName, nf + sp.md, disk.version);
    } catch {}
  }
}
