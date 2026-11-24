import type { DB } from "../db";
import type { ReviewIoSummary } from "../../shared/types";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as fmt from "./reviewFileFormat";

export * from "./reviewFileFormat";

const { readReviewFile, splitReviewFile, matchReviewFile, renameReviewFileNoReplace } = fmt;
const PREFIX = "未匹配-";

type Match = {
  kind: "book" | "series" | "draft" | "orphan";
  bookId: string | null;
  seriesId: number | null;
  strength: number;
};

type FileRec = {
  original: string;
  actual: string;
  version: string;
  fields: Record<string, any>;
  match: Match;
  grade: string;
  happened_at: string;
  renamed?: boolean;
};

function all<T = any>(db: DB, sql: string, ...p: any[]): T[] {
  const d = db as any;
  const st = d.prepare?.(sql);
  if (st?.all) return st.all(...p);
  if (typeof d.all === "function") return d.all(sql, ...p);
  throw new Error("db.all unsupported");
}
function get<T = any>(db: DB, sql: string, ...p: any[]): T | null {
  const d = db as any;
  const st = d.prepare?.(sql);
  if (st?.get) return st.get(...p) ?? null;
  if (typeof d.get === "function") return d.get(sql, ...p) ?? null;
  throw new Error("db.get unsupported");
}
function run(db: DB, sql: string, ...p: any[]): any {
  const d = db as any;
  const st = d.prepare?.(sql);
  if (st?.run) return st.run(...p);
  if (typeof d.run === "function") return d.run(sql, ...p);
  throw new Error("db.run unsupported");
}
function exec(db: DB, sql: string): void {
  const d = db as any;
  if (typeof d.exec === "function") return d.exec(sql);
  throw new Error("db.exec unsupported");
}
function tx<T>(db: DB, fn: () => T): T {
  const d = db as any;
  if (typeof d.transaction === "function") return d.transaction(fn)();
  exec(db, "BEGIN");
  try {
    const out = fn();
    exec(db, "COMMIT");
    return out;
  } catch (e) {
    exec(db, "ROLLBACK");
    throw e;
  }
}

function field(fields: any, keys: string[]): string {
  for (const k of keys) {
    const v = fields?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
function gradeOf(fields: any): string {
  const level = field(fields, ["书评等级"]);
  if (level) {
    const g = level.toLowerCase();
    if (g === "神作" || g === "god") return "god";
    if (g === "普通" || g === "normal") return "normal";
    if (g === "扫雷" || g === "bad" || g === "mine" || g === "bomb") return "bad";
  }
  const score = field(fields, ["评分"]);
  if (score) {
    const g = score.toLowerCase();
    if (g === "god") return "god";
    if (g === "normal") return "normal";
    if (g === "bad" || g === "mine" || g === "bomb") return "bad";
  }
  return "normal";
}
function happenedOf(fields: any, mtime: Date): string {
  return field(fields, ["阅读时间", "读完时间", "时间", "日期", "happened_at", "readAt"]) || mtime.toISOString();
}
function ciStarts(name: string, prefix: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}
function splitName(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}
function uniqueName(desired: string, current: string, taken: Set<string>): string {
  const [base, ext] = splitName(desired);
  let out = desired;
  let n = 2;
  while (taken.has(out.toLowerCase()) && out.toLowerCase() !== current.toLowerCase()) {
    out = `${base}-重名${n}${ext}`;
    n++;
  }
  return out;
}

function resolveDuplicates(files: FileRec[], msgs: string[]): void {
  const groups = new Map<string, FileRec[]>();
  for (const f of files) {
    const m = f.match;
    if ((m.kind === "book" && m.bookId) || (m.kind === "series" && m.seriesId != null)) {
      const key = m.kind + ":" + String(m.kind === "book" ? m.bookId : m.seriesId);
      const arr = groups.get(key) ?? [];
      arr.push(f);
      groups.set(key, arr);
    }
  }
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const max = Math.max(...arr.map((f) => f.match.strength));
    const top = arr.filter((f) => f.match.strength === max);
    const keep = top.length === 1 ? top[0] : null;
    for (const f of arr) {
      if (f === keep) continue;
      msgs.push(`重复归属 ${key}: ${f.original} -> orphan`);
      f.match = { kind: "orphan", bookId: null, seriesId: null, strength: 0 };
    }
  }
}

function ownership(f: FileRec): { book_id: string | null; series_id: number | null } {
  if (f.match.kind === "book") return { book_id: f.match.bookId, series_id: null };
  if (f.match.kind === "series") return { book_id: null, series_id: f.match.seriesId };
  return { book_id: null, series_id: null };
}

function findReview(rows: any[], f: FileRec, used: Set<number>): any | null {
  const a = f.actual.toLowerCase();
  const o = f.original.toLowerCase();
  const ok = (r: any) => !used.has(Number(r.id));
  return (
    rows.find(
      (r) =>
        ok(r) &&
        (String(r.file_name ?? "").toLowerCase() === a || String(r.file_name ?? "").toLowerCase() === o),
    ) ?? null
  );
}

function findOrphan(rows: any[], f: FileRec, used: Set<number>): any | null {
  const a = f.actual.toLowerCase();
  const o = f.original.toLowerCase();
  return (
    rows.find(
      (r) =>
        !used.has(Number(r.id)) &&
        (String(r.file_name ?? "").toLowerCase() === a ||
          String(r.file_name ?? "").toLowerCase() === o),
    ) ?? null
  );
}

function sameReview(row: any, f: FileRec, own: { book_id: string | null; series_id: number | null }): boolean {
  return (
    String(row.book_id ?? "") === String(own.book_id ?? "") &&
    String(row.series_id ?? "") === String(own.series_id ?? "") &&
    String(row.name ?? "") === f.actual &&
    String(row.grade ?? "") === f.grade &&
    String(row.happened_at ?? "") === f.happened_at &&
    String(row.file_name ?? "") === f.actual &&
    String(row.file_hash ?? "") === f.version &&
    String(row.md ?? "") === ""
  );
}

function sameOrphan(row: any, f: FileRec, path: string): boolean {
  return (
    String(row.name ?? "") === f.actual &&
    String(row.grade ?? "") === f.grade &&
    String(row.happened_at ?? "") === f.happened_at &&
    String(row.file_name ?? "") === f.actual &&
    String(row.file_hash ?? "") === f.version &&
    String(row.path ?? "") === path &&
    String(row.md ?? "") === ""
  );
}

function titleGuess(name: string): string {
  let n = name;
  if (ciStarts(n, PREFIX)) n = n.slice(PREFIX.length);
  return splitName(n)[0];
}

export function reconcileReviewFiles(
  db: DB,
  dir: string,
  rename = true,
): ReviewIoSummary {
  const summary: ReviewIoSummary = {
    added: 0,
    updated: 0,
    orphan: 0,
    skipped: 0,
    written: 0,
    removed: 0,
    renamed: 0,
    msgs: [],
    dir,
  };

  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const entries = readdirSync(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort();

  const files: FileRec[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const fst = lstatSync(path);
    if (!fst.isFile()) continue;
    const r = readReviewFile(dir, name);
    if (!r || typeof r.raw !== "string") throw new Error(`invalid review file: ${name}`);
    const parsed = splitReviewFile(r.raw);
    const fields = parsed.fields ?? {};
    const m0 = matchReviewFile(db, name, fields);
    const match: Match = {
      kind: m0.kind ?? "orphan",
      bookId: m0.bookId ?? null,
      seriesId: m0.seriesId ?? null,
      strength: Number(m0.strength) || 0,
    };
    files.push({
      original: name,
      actual: name,
      version: String(r.version ?? ""),
      fields,
      match,
      grade: gradeOf(fields),
      happened_at: happenedOf(fields, fst.mtime),
    });
  }

  resolveDuplicates(files, summary.msgs);

  if (rename) {
    const taken = new Set(files.map((f) => f.original.toLowerCase()));
    for (const f of files) {
      const isOrphan = f.match.kind === "orphan";
      let desired = f.original;
      if (isOrphan && !ciStarts(desired, PREFIX)) desired = PREFIX + desired;
      if (!isOrphan && ciStarts(desired, PREFIX)) desired = desired.slice(PREFIX.length);
      if (!desired || desired === f.original) continue;
      const target = uniqueName(desired, f.original, taken);
      if (target === f.original) continue;
      try {
      renameReviewFileNoReplace(dir, f.original, target);
        f.actual = target;
        f.renamed = true;
        summary.renamed = (summary.renamed ?? 0) + 1;
        taken.delete(f.original.toLowerCase());
        taken.add(target.toLowerCase());
      } catch (e: any) {
        f.actual = f.original;
        summary.msgs.push(`重命名失败 ${f.original} -> ${target}: ${e?.message ?? e}`);
      }
    }
  }

  const now = new Date().toISOString();
  tx(db, () => {
    const reviewFiles = files.filter((f) => f.match.kind !== "orphan");
    const orphanFiles = files.filter((f) => f.match.kind === "orphan");

    const reviews = all(db, "SELECT * FROM reviews WHERE deleted_at IS NULL");
    const usedR = new Set<number>();
    const wantedR = reviewFiles.map((f) => {
      const row = findReview(reviews, f, usedR);
      if (row) usedR.add(Number(row.id));
      return { f, row, own: ownership(f) };
    });
    for (const row of reviews) {
      if (usedR.has(Number(row.id))) continue;
      run(db, "UPDATE reviews SET deleted_at=?, md='', updated_at=? WHERE id=? AND deleted_at IS NULL", now, now, row.id);
      summary.removed = (summary.removed ?? 0) + 1;
    }
    // 暂软删归属将改变的行，避免同表两条归属交换时唯一约束冲突
    for (const { row, own } of wantedR) {
      if (!row) continue;
      const rowBook = row.book_id != null ? String(row.book_id) : "";
      const rowSeries = row.series_id != null ? String(row.series_id) : "";
      const ownBook = own.book_id != null ? String(own.book_id) : "";
      const ownSeries = own.series_id != null ? String(own.series_id) : "";
      if (rowBook !== ownBook || rowSeries !== ownSeries) {
        run(db, "UPDATE reviews SET deleted_at=? WHERE id=? AND deleted_at IS NULL", now, row.id);
      }
    }
    for (const { f, row, own } of wantedR) {
      if (row) {
        if (sameReview(row, f, own)) {
          summary.skipped++;
          continue;
        }
        run(
          db,
          "UPDATE reviews SET book_id=?, series_id=?, md='', name=?, grade=?, happened_at=?, file_name=?, file_hash=?, updated_at=?, deleted_at=NULL WHERE id=?",
          own.book_id,
          own.series_id,
          f.actual,
          f.grade,
          f.happened_at,
          f.actual,
          f.version,
          now,
          row.id,
        );
        summary.updated++;
        summary.written++;
      } else {
        run(
          db,
          "INSERT INTO reviews (book_id,series_id,md,name,grade,happened_at,file_name,file_hash,origin,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)",
          own.book_id,
          own.series_id,
          "",
          f.actual,
          f.grade,
          f.happened_at,
          f.actual,
          f.version,
          "file",
          now,
          now,
        );
        summary.added++;
        summary.written++;
      }
    }

    const orphans = all(db, "SELECT * FROM orphan_reviews WHERE deleted_at IS NULL");
    const usedO = new Set<number>();
    const wantedO = orphanFiles.map((f) => {
      const row = findOrphan(orphans, f, usedO);
      if (row) usedO.add(Number(row.id));
      return { f, row };
    });
    for (const row of orphans) {
      if (usedO.has(Number(row.id))) continue;
      run(db, "UPDATE orphan_reviews SET deleted_at=?, md='', updated_at=? WHERE id=? AND deleted_at IS NULL", now, now, row.id);
      summary.removed = (summary.removed ?? 0) + 1;
    }
    for (const { f, row } of wantedO) {
      const path = join(dir, f.actual);
      const title = titleGuess(f.actual);
      if (row) {
        if (sameOrphan(row, f, path)) {
          summary.skipped++;
          continue;
        }
        run(
          db,
          "UPDATE orphan_reviews SET name=?, title_guess=?, md='', grade=?, happened_at=?, file_name=?, file_hash=?, path=?, updated_at=?, deleted_at=NULL WHERE id=?",
          f.actual,
          title,
          f.grade,
          f.happened_at,
          f.actual,
          f.version,
          path,
          now,
          row.id,
        );
        summary.updated++;
        summary.written++;
      } else {
        run(
          db,
          "INSERT INTO orphan_reviews (name,title_guess,md,grade,happened_at,file_name,file_hash,path,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)",
          f.actual,
          title,
          "",
          f.grade,
          f.happened_at,
          f.actual,
          f.version,
          path,
          now,
          now,
        );
        summary.added++;
        summary.written++;
        summary.orphan = (summary.orphan ?? 0) + 1;
      }
    }
  });

  return summary;
}

export function reviewFileVersion(db: DB, kind: string, id: number): string {
  const table = kind === "orphan" ? "orphan_reviews" : "reviews";
  const row = get<any>(db, `SELECT file_hash FROM ${table} WHERE id=? AND deleted_at IS NULL`, id);
  return String(row?.file_hash ?? "");
}
