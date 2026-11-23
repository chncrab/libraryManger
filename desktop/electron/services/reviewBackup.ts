import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db";

const MARKER = ".complete";
const MARKER_BODY = JSON.stringify({ version: 1, complete: true }) + "\n";
const SNAP_RE = /^(library|migration)-(\d{13})-([0-9a-f]{12})$/;
const LIB_RE = /^library-(\d{13})-([0-9a-f]{12})$/;
const OLD_RE = /\.(db|sqlite|bak)$/i;

type BackupCapable = { backup(destination: string): Promise<unknown> | unknown };
type ReviewFile = { name: string; data: Buffer; hash: string };
type BackupEntry = { file: string; size: number; at: string };

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

async function lstatAsync(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function assertRealDirSync(p: string): void {
  const st = lstatOrNull(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a real directory: ${p}`);
}

async function assertRealDirAsync(p: string): Promise<void> {
  const st = await lstatAsync(p);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a real directory: ${p}`);
}

function ensureRealDirSync(p: string): void {
  const st = lstatOrNull(p);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a real directory: ${p}`);
    return;
  }
  fs.mkdirSync(p, { recursive: true });
  assertRealDirSync(p);
}

async function ensureRealDirAsync(p: string): Promise<void> {
  const st = await lstatAsync(p);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a real directory: ${p}`);
    return;
  }
  await fsp.mkdir(p, { recursive: true });
  await assertRealDirAsync(p);
}

function markerComplete(dir: string): boolean {
  const marker = path.join(dir, MARKER);
  const st = lstatOrNull(marker);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size <= 0) return false;
  try {
    const text = fs.readFileSync(marker, "utf8").trim();
    if (!text) return false;
    try {
      return JSON.parse(text)?.complete === true;
    } catch {
      return text === "complete";
    }
  } catch {
    return false;
  }
}

function sameReviewSet(a: ReviewFile[], b: ReviewFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].hash !== b[i].hash) return false;
  }
  return true;
}

async function readReviewSetAsync(dir: string): Promise<ReviewFile[]> {
  await assertRealDirAsync(dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: ReviewFile[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) throw new Error(`symlink is not allowed: ${p}`);
    if (st.isDirectory()) throw new Error(`nested directory is not allowed: ${p}`);
    if (!e.name.toLowerCase().endsWith(".md")) continue;
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    const data = await fsp.readFile(p);
    if (data.length !== st.size) throw new Error(`file changed while reading: ${p}`);
    out.push({ name: e.name, data, hash: sha(data) });
  }
  return out;
}

async function writeReviewSetAsync(srcDir: string, dstDir: string): Promise<void> {
  const files = await readReviewSetAsync(srcDir);
  await fsp.mkdir(dstDir, { recursive: false });
  for (const f of files) {
    const dst = path.join(dstDir, f.name);
    await fsp.writeFile(dst, f.data, { flag: "wx" });
    const got = await fsp.readFile(dst);
    if (got.length !== f.data.length || sha(got) !== f.hash) throw new Error(`copy verification failed: ${dst}`);
  }
  if (!sameReviewSet(files, await readReviewSetAsync(srcDir))) throw new Error(`review files changed during backup: ${srcDir}`);
}

function readReviewSetSync(dir: string): ReviewFile[] {
  assertRealDirSync(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: ReviewFile[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`symlink is not allowed: ${p}`);
    if (st.isDirectory()) throw new Error(`nested directory is not allowed: ${p}`);
    if (!e.name.toLowerCase().endsWith(".md")) continue;
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    const data = fs.readFileSync(p);
    if (data.length !== st.size) throw new Error(`file changed while reading: ${p}`);
    out.push({ name: e.name, data, hash: sha(data) });
  }
  return out;
}

function writeReviewSetSync(srcDir: string, dstDir: string): void {
  const files = readReviewSetSync(srcDir);
  fs.mkdirSync(dstDir);
  for (const f of files) {
    const dst = path.join(dstDir, f.name);
    fs.writeFileSync(dst, f.data, { flag: "wx" });
    const got = fs.readFileSync(dst);
    if (got.length !== f.data.length || sha(got) !== f.hash) throw new Error(`copy verification failed: ${dst}`);
  }
  if (!sameReviewSet(files, readReviewSetSync(srcDir))) throw new Error(`review files changed during restore: ${srcDir}`);
}

function copyFileVerifiedSync(src: string, dst: string): string {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`not a regular file: ${src}`);
  const data = fs.readFileSync(src);
  if (data.length !== st.size) throw new Error(`file changed while reading: ${src}`);
  const hash = sha(data);
  fs.writeFileSync(dst, data, { flag: "wx" });
  const got = fs.readFileSync(dst);
  if (got.length !== data.length || sha(got) !== hash) throw new Error(`copy verification failed: ${dst}`);
  const afterStat = fs.lstatSync(src);
  const after = fs.readFileSync(src);
  if (afterStat.isSymbolicLink() || !afterStat.isFile() || after.length !== data.length || sha(after) !== hash) {
    throw new Error(`source changed during copy: ${src}`);
  }
  return hash;
}

export async function backupReviewLibrary(
  db: DB,
  reviewDir: string,
  parent: string,
  prefix: "library" | "migration" = "library"
): Promise<string> {
  const root = path.resolve(parent);
  const reviews = path.resolve(reviewDir);
  await ensureRealDirAsync(root);
  await assertRealDirAsync(reviews);

  const stage = await fsp.mkdtemp(path.join(root, ".review-stage-"));
  let published = false;
  try {
    const dbDest = path.join(stage, "library.db");
    await (db as unknown as BackupCapable).backup(dbDest);
    const dbStat = await fsp.lstat(dbDest);
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) throw new Error(`invalid backup db: ${dbDest}`);
    const dbBytes = await fsp.readFile(dbDest);
    if (dbBytes.length !== dbStat.size) throw new Error(`incomplete backup db: ${dbDest}`);

    await writeReviewSetAsync(reviews, path.join(stage, "reviews"));
    await fsp.writeFile(path.join(stage, MARKER), MARKER_BODY, { flag: "wx" });

    const name = `${prefix}-${String(Date.now()).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
    const final = path.join(root, name);
    await fsp.rename(stage, final);
    published = true;
    return path.join(final, "library.db");
  } finally {
    if (!published) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

export function isReviewSnapshot(dbFile: string): boolean {
  const db = path.resolve(dbFile);
  const dir = path.dirname(db);
  const dbStat = lstatOrNull(db);
  if (!dbStat || dbStat.isSymbolicLink() || !dbStat.isFile()) return false;
  const dirStat = lstatOrNull(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
  const reviews = path.join(dir, "reviews");
  const revStat = lstatOrNull(reviews);
  if (!revStat || revStat.isSymbolicLink() || !revStat.isDirectory()) return false;
  return markerComplete(dir);
}

export function listReviewBackups(parent: string): BackupEntry[] {
  const root = path.resolve(parent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const m = SNAP_RE.exec(e.name);
      if (!m) continue;
      const db = path.join(full, "library.db");
      if (!isReviewSnapshot(db)) continue;
      const st = fs.lstatSync(db);
      const ts = Number(m[2]);
      let at: string;
      try {
        at = new Date(ts).toISOString();
      } catch {
        at = new Date(st.mtimeMs).toISOString();
      }
      out.push({ file: db, size: st.size, at });
    } else {
      if (!OLD_RE.test(e.name)) continue;
      const st = lstatOrNull(full);
      if (!st || st.isSymbolicLink() || !st.isFile()) continue;
      out.push({ file: full, size: st.size, at: new Date(st.mtimeMs).toISOString() });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.file.localeCompare(a.file));
}

async function rotateLibraryBackups(root: string, keep: number): Promise<void> {
  const limit = Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 8;
  const realRoot = await fsp.realpath(root);
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const found: { dir: string; ts: number }[] = [];
  for (const e of entries) {
    const m = LIB_RE.exec(e.name);
    if (!m) continue;
    const full = path.join(root, e.name);
    const st = await fsp.lstat(full);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const real = await fsp.realpath(full);
    if (path.dirname(real) !== realRoot) continue;
    if (!isReviewSnapshot(path.join(real, "library.db"))) continue;
    found.push({ dir: real, ts: Number(m[1]) });
  }
  found.sort((a, b) => b.ts - a.ts);
  for (const item of found.slice(limit)) {
    const st = await fsp.lstat(item.dir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const real = await fsp.realpath(item.dir);
    if (path.dirname(real) !== realRoot) continue;
    await fsp.rm(real, { recursive: true, force: false });
  }
}

export async function autoBackupWithReviews(
  db: DB,
  reviewDir: string,
  parent: string,
  keep = 8
): Promise<string | null> {
  try {
    const out = await backupReviewLibrary(db, reviewDir, parent, "library");
    await rotateLibraryBackups(path.resolve(parent), keep);
    return out;
  } catch {
    return null;
  }
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // keep leftovers rather than risking loss
  }
}

export function restoreReviewLibrary(dbFileFromBackup: string, dbFile: string, reviewDir: string): void {
  const source = path.resolve(dbFileFromBackup);
  const targetDb = path.resolve(dbFile);
  const targetReviews = path.resolve(reviewDir);

  if (source === targetDb) throw new Error("refusing to restore from the active database");
  if (isInside(source, targetReviews)) throw new Error("refusing to restore from the reviews directory");

  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`invalid backup db: ${source}`);
  if (!OLD_RE.test(source)) throw new Error(`invalid backup db extension: ${source}`);

  const snapshot = isReviewSnapshot(source);
  const sourceReviews = snapshot ? path.join(path.dirname(source), "reviews") : null;
  if (sourceReviews) assertRealDirSync(sourceReviews);

  const dbDir = path.dirname(targetDb);
  const revParent = path.dirname(targetReviews);
  ensureRealDirSync(dbDir);
  ensureRealDirSync(revParent);

  const targetDbStat = lstatOrNull(targetDb);
  if (targetDbStat && (targetDbStat.isSymbolicLink() || !targetDbStat.isFile())) {
    throw new Error(`invalid target db: ${targetDb}`);
  }
  const targetReviewsStat = lstatOrNull(targetReviews);
  if (targetReviewsStat && (targetReviewsStat.isSymbolicLink() || !targetReviewsStat.isDirectory())) {
    throw new Error(`invalid target reviews directory: ${targetReviews}`);
  }

  const stageDbDir = fs.mkdtempSync(path.join(dbDir, ".restore-db-"));
  const stageRevDir = fs.mkdtempSync(path.join(revParent, ".restore-reviews-"));
  const oldDbDir = fs.mkdtempSync(path.join(dbDir, ".restore-old-db-"));
  const oldRevDir = fs.mkdtempSync(path.join(revParent, ".restore-old-reviews-"));

  const stagedDb = path.join(stageDbDir, "new.db");
  const stagedReviews = path.join(stageRevDir, "reviews");
  const expected: { file: string; hash: string }[] = [];
  const movedDb: { target: string; old: string }[] = [];
  const installedDb: string[] = [];
  let movedReviews = false;
  let installedReviews = false;

  const rollback = (): void => {
    let firstError: unknown = null;
    if (installedReviews) {
      try {
        if (lstatOrNull(targetReviews)) fs.rmSync(targetReviews, { recursive: true, force: true });
      } catch (e) {
        firstError ??= e;
      }
    }
    for (const p of installedDb.slice().reverse()) {
      try {
        if (lstatOrNull(p)) fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        firstError ??= e;
      }
    }
    if (movedReviews) {
      try {
        if (lstatOrNull(targetReviews)) fs.rmSync(targetReviews, { recursive: true, force: true });
        fs.renameSync(path.join(oldRevDir, "old"), targetReviews);
      } catch (e) {
        firstError ??= e;
      }
    }
    for (const m of movedDb.slice().reverse()) {
      try {
        if (lstatOrNull(m.target)) fs.rmSync(m.target, { recursive: true, force: true });
        fs.renameSync(m.old, m.target);
      } catch (e) {
        firstError ??= e;
      }
    }
    if (firstError) throw firstError;
  };

  try {
    expected.push({ file: source, hash: copyFileVerifiedSync(source, stagedDb) });

    if (sourceReviews) {
      writeReviewSetSync(sourceReviews, stagedReviews);
    } else {
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = source + suffix;
        const st = lstatOrNull(sidecar);
        if (!st) continue;
        if (st.isSymbolicLink() || !st.isFile()) throw new Error(`invalid sidecar: ${sidecar}`);
        expected.push({ file: sidecar, hash: copyFileVerifiedSync(sidecar, stagedDb + suffix) });
      }
    }

    for (const e of expected) {
      const st = fs.lstatSync(e.file);
      const data = fs.readFileSync(e.file);
      if (st.isSymbolicLink() || !st.isFile() || data.length !== st.size || sha(data) !== e.hash) {
        throw new Error(`backup changed during restore: ${e.file}`);
      }
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const target = targetDb + suffix;
      const st = lstatOrNull(target);
      if (!st) continue;
      if (st.isSymbolicLink() || !st.isFile()) throw new Error(`invalid target db file: ${target}`);
      const old = path.join(oldDbDir, "old.db" + suffix);
      fs.renameSync(target, old);
      movedDb.push({ target, old });
    }

    if (snapshot) {
      const st = lstatOrNull(targetReviews);
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`invalid target reviews directory: ${targetReviews}`);
        fs.renameSync(targetReviews, path.join(oldRevDir, "old"));
        movedReviews = true;
      }
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const staged = stagedDb + suffix;
      if (!lstatOrNull(staged)) continue;
      const target = targetDb + suffix;
      fs.renameSync(staged, target);
      installedDb.push(target);
    }

    if (snapshot) {
      fs.renameSync(stagedReviews, targetReviews);
      installedReviews = true;
    }

    rmQuiet(stageDbDir);
    rmQuiet(stageRevDir);
    rmQuiet(oldDbDir);
    rmQuiet(oldRevDir);
  } catch (e) {
    try {
      rollback();
    } catch (rollbackError) {
      rmQuiet(stageDbDir);
      rmQuiet(stageRevDir);
      throw new Error(
        `restore failed and rollback failed; originals kept at ${oldDbDir} and ${oldRevDir}: ${String(rollbackError)}`
      );
    }
    rmQuiet(stageDbDir);
    rmQuiet(stageRevDir);
    rmQuiet(oldDbDir);
    rmQuiet(oldRevDir);
    throw e;
  }
}
