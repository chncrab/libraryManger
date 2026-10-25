import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";
import type { ReviewIoSummary, ReviewRow } from "../../shared/types";
import { listReviews, reviewFileName, sanitizeFile } from "./reviewService";
import { getSetting, setSetting } from "./settingsService";

/**
 * 书评与磁盘上 md 文件的双向通道。
 * 命名沿用 demo 的规矩：单本「作者-《书名》书评.md」，系列「作者-《系列名》系列.md」，
 * 未匹配的用原始文件名。同名不同篇一律加序号，绝不互相覆盖。
 *
 * 已经写出去的文件名记在 settings.review_files（kind:id → 文件名）里，
 * 改绑或改书名之后再写，才知道该收走哪一份旧的。
 */

const MAP_KEY = "review_files";

function empty(): ReviewIoSummary {
  return { added: 0, updated: 0, orphan: 0, skipped: 0, written: 0, msgs: [] };
}

function keyOf(kind: string, id: number): string {
  return kind + ":" + id;
}

function loadMap(db: DB): Record<string, string> {
  try {
    return JSON.parse(getSetting(db, MAP_KEY, "{}")) || {};
  } catch {
    return {};
  }
}

function saveMap(db: DB, m: Record<string, string>): void {
  setSetting(db, MAP_KEY, JSON.stringify(m));
}

function parseName(file: string, text: string): { base: string; title: string; author: string } {
  const base = path.basename(file).replace(/\.md$/i, "").trim();
  let title = "";
  let author = "";
  const m = base.match(/《([^》]+)》/);
  if (m) {
    title = m[1].trim();
    author = base.slice(0, m.index).replace(/[-_\s]+$/, "").trim();
  } else {
    title = base.replace(/^未匹配[-_]?/, "").trim();
  }
  if (!title) {
    const h = text.match(/^#+\s*《([^》]+)》/m);
    if (h) title = h[1].trim();
  }
  return { base, title, author };
}

function gradeOf(base: string, text: string): string {
  const head = base + " " + text.slice(0, 60);
  if (/扫雷|💣/.test(head)) return "bad";
  if (/神作|❤/.test(head)) return "god";
  return "normal";
}

/** 书名命中一本才算匹配上；同名多本时再用作者收窄，收不窄宁可不挂 */
function findBook(db: DB, title: string, author: string): string | null {
  if (!title) return null;
  const rows = db.prepare("SELECT id FROM books WHERE deleted_at IS NULL AND title = ?").all(title) as any[];
  if (rows.length === 1) return rows[0].id;
  if (!author) return null;
  const hit = rows.filter((r) =>
    !!db
      .prepare(
        "SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ? AND a.name = ?"
      )
      .get(r.id, author)
  );
  return hit.length === 1 ? hit[0].id : null;
}

function existingOrphan(db: DB, fileName: string): number | null {
  const r = db.prepare("SELECT id FROM orphan_reviews WHERE file_name = ? AND deleted_at IS NULL").get(fileName) as any;
  return r ? r.id : null;
}

/** 导入一批 md 的正文。文件名给匹配用，匹配不上进未匹配池 */
export function importReviewTexts(db: DB, files: { name: string; text: string }[]): ReviewIoSummary {
  const out = empty();
  const t = new Date().toISOString();

  const run = db.transaction(() => {
    for (const f of files) {
      const text = String(f.text || "").replace(/\r\n/g, "\n");
      const fileName = sanitizeFile(path.basename(f.name));
      if (!text.trim()) {
        out.skipped++;
        continue;
      }
      const { title, author } = parseName(fileName, text);
      const grade = gradeOf(fileName, text);
      const bookId = findBook(db, title, author);

      if (bookId) {
        const cur = db.prepare("SELECT id, md FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(bookId) as any;
        if (!cur) {
          db.prepare(
            `INSERT INTO reviews (book_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)`
          ).run(bookId, title, text, grade, t, "", t, t);
          out.added++;
        } else if (cur.md === text) {
          out.skipped++;
        } else {
          db.prepare("UPDATE reviews SET md = ?, updated_at = ? WHERE id = ?").run(text, t, cur.id);
          out.updated++;
        }
      } else {
        const oid = existingOrphan(db, fileName);
        if (oid) {
          const cur = db.prepare("SELECT md, grade FROM orphan_reviews WHERE id = ?").get(oid) as any;
          if (cur && cur.md === text && cur.grade === grade) {
            out.skipped++;
          } else {
            db.prepare("UPDATE orphan_reviews SET md = ?, grade = ?, updated_at = ? WHERE id = ?").run(text, grade, t, oid);
            out.updated++;
          }
        } else {
          db.prepare(
            `INSERT INTO orphan_reviews (name, title_guess, md, grade, happened_at, file_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(path.basename(fileName, ".md"), title, text, grade, t, fileName, t, t);
          out.orphan++;
        }
      }
    }
  });
  run();

  if (out.orphan) out.msgs.push(out.orphan + " 篇没匹配上书，已放进未匹配池，可在书评库关联");
  return out;
}

function nameWithSuffix(name: string, i: number): string {
  const ext = path.extname(name);
  return name.slice(0, name.length - ext.length) + "(" + i + ")" + ext;
}

/**
 * 内容没变就不碰文件。这不是省磁盘，是保命：
 * 目录监听靠 mtime 触发，每次都重写会让「写盘 → 事件 → 同步 → 再写盘」永远停不下来。
 */
function writeIfChanged(file: string, text: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch {
    /* 没有这个文件，往下写 */
  }
  fs.writeFileSync(file, text, "utf8");
  return true;
}

/** 在已有名字集合里让位，返回不撞车的名字 */
function pickName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const stem = name.replace(/\(\d+\)(?=\.md$)/, "");
  let i = 2;
  while (taken.has(nameWithSuffix(stem, i))) i++;
  return nameWithSuffix(stem, i);
}

/** 去掉末尾的 (2) 这类序号，用来判断「只是序号不同」还是「名字本身变了」 */
function stemOf(name: string): string {
  return name.replace(/\(\d+\)(?=\.md$)/i, "");
}

/**
 * 改名走真正的重命名。删了再写一份会有两个问题：
 * 一是中途断掉就留一份孤儿文件，二是文件的时间戳变成新建的，
 * 下一次同步会以为外面刚改过。
 */
function renameIn(dir: string, from: string, to: string): boolean {
  if (!from || !to || from === to) return false;
  const a = path.join(dir, path.basename(from));
  const b = path.join(dir, path.basename(to));
  if (!fs.existsSync(a)) return false;
  try {
    if (fs.existsSync(b)) fs.rmSync(b, { force: true });
    fs.renameSync(a, b);
    return true;
  } catch {
    /* 跨卷或占用，退回删旧 */
    removeFile(dir, from);
    return false;
  }
}

function mdOf(db: DB, kind: string, id: number): string {
  const table = kind === "orphan" ? "orphan_reviews" : "reviews";
  const r = db.prepare(`SELECT md FROM ${table} WHERE id = ?`).get(id) as any;
  return r ? r.md || "" : "";
}

/**
 * 单篇落盘。保存正文、改绑、改书名之后调。
 * prevName 是改绑前那份文件的名字：给了它就把那份**改名**成新名字，
 * 没给就查自己记过的旧名。改名不能走「先删后写」，那等于重新生成一份。
 */
export function writeOne(db: DB, dir: string, kind: string, id: number, prevName?: string): boolean {
  if (!dir) return false;
  const name = reviewFileName(db, { kind, id });
  if (!name) return false;
  fs.mkdirSync(dir, { recursive: true });

  const map = loadMap(db);
  const key = keyOf(kind, id);
  const taken = new Set(
    Object.entries(map)
      .filter(([k]) => k !== key)
      .map(([, v]) => v)
  );
  const final = pickName(name, taken);

  const old = prevName || map[key];
  if (old && old !== final) renameIn(dir, old, final);
  writeIfChanged(path.join(dir, final), mdOf(db, kind, id));
  map[key] = final;
  saveMap(db, map);
  return true;
}

/** 只把映射摘掉，文件留在原地。改绑时用这个，文件随后由 writeOne 改名带走 */
export function dropMapping(db: DB, kind: string, id: number): string {
  const map = loadMap(db);
  const key = keyOf(kind, id);
  const old = map[key] || "";
  if (key in map) {
    delete map[key];
    saveMap(db, map);
  }
  return old;
}

/** 删除或改绑后把旧文件收走，并把映射清掉 */
export function forgetFile(db: DB, dir: string, kind: string, id: number): void {
  const map = loadMap(db);
  const key = keyOf(kind, id);
  const old = map[key];
  if (old) removeFile(dir, old);
  delete map[key];
  saveMap(db, map);
}

export function removeFile(dir: string, fileName: string): void {
  if (!dir || !fileName) return;
  const p = path.join(dir, path.basename(fileName));
  if (fs.existsSync(p)) {
    try {
      fs.rmSync(p);
    } catch {
      /* 文件被占用就算了，不打断主流程 */
    }
  }
}

/** 把库里全部书评写进目录，同时清掉已经不对应任何书评的旧文件 */
export function exportAll(db: DB, dir: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  fs.mkdirSync(dir, { recursive: true });
  const rows = listReviews(db);
  const old = loadMap(db);
  const map: Record<string, string> = {};
  const taken = new Set<string>();

  for (const r of rows) {
    const key = keyOf(r.kind, r.id);
    const name = reviewFileName(db, r);
    if (!name) continue;
    /* 之前写过的名字沿用，免得每次导出都往后加序号。
       但只能沿用到「仅序号不同」为止：书名改了、从书挪到系列了，名字本体变了就得换，
       否则文件永远叫旧名字 */
    const prev = old[key];
    const want = prev && !taken.has(prev) && stemOf(prev) === stemOf(name) ? prev : name;
    const final = pickName(want, taken);
    taken.add(final);
    map[key] = final;
    if (writeIfChanged(path.join(dir, final), r.md || "")) out.written++;
  }

  /* 改过名的、已经删掉的，旧名字那份收走 */
  for (const [k, v] of Object.entries(old)) {
    const now = map[k];
    if (now === v) continue;
    if (Object.values(map).includes(v)) continue;
    removeFile(dir, v);
  }
  saveMap(db, map);
  return out;
}

/**
 * 目录与库对齐。顺序很要紧：先读目录、把比库里新的正文收进来，
 * 再把库里的内容整体写出去。反过来的话，写盘会先把用户在外面改的内容盖掉，
 * 后面的比对就永远看不出差异。
 */
export function syncDir(db: DB, dir: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  fs.mkdirSync(dir, { recursive: true });

  const map = loadMap(db);
  const rows = listReviews(db);
  const byFile = new Map<string, ReviewRow>();
  for (const r of rows) {
    const n = map[keyOf(r.kind, r.id)];
    if (n) byFile.set(n, r);
  }

  const incoming: { name: string; text: string }[] = [];
  const files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f));
  for (const f of files) {
    const full = path.join(dir, f);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    const r = byFile.get(f);
    if (!r) {
      incoming.push({ name: f, text });
      continue;
    }
    /* 内容不一样就以文件为准。软件里一改正文就立刻写盘，文件永远跟得上，
       所以两边不一致只可能是外面动过手 */
    if (text !== (r.md || "")) {
      const table = r.kind === "orphan" ? "orphan_reviews" : "reviews";
      db.prepare(`UPDATE ${table} SET md = ?, updated_at = ? WHERE id = ?`).run(text, new Date().toISOString(), r.id);
      out.updated++;
    }
  }
  if (incoming.length) {
    const got = importReviewTexts(db, incoming);
    out.added += got.added;
    out.orphan += got.orphan;
    out.skipped += got.skipped;
    out.msgs.push(...got.msgs);
  }

  const written = exportAll(db, dir);
  out.written = written.written;
  return out;
}

/** 读目录里的 md 作为导入源 */
export function readMdDir(dir: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (d: string, depth = 0) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.md$/i.test(e.name)) out.push({ name: e.name, text: fs.readFileSync(full, "utf8") });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
