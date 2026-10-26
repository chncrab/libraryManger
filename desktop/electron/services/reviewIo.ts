import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";
import type { ReviewIoSummary, ReviewRow } from "../../shared/types";
import { listReviews, reviewFileName, sanitizeFile } from "./reviewService";
import { seriesTitle } from "./seriesService";
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
  return { added: 0, updated: 0, orphan: 0, skipped: 0, written: 0, removed: 0, renamed: 0, msgs: [] };
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
/**
 * 把外面的 md 收进库。
 * dir 给了就把绑定成功的那些落成规范名（作者-《书名》书评.md）；不给只入库不动文件。
 * move 表示源文件就在 dir 里，可以当场改名或收走；从别处导入时不能动人家的文件。
 *
 * 空文件也收：目录里摆着一个 md 却哪儿都看不见，比收进来一条空书评更让人摸不着头脑。
 * 有正文的按正文算，没有的先建一条空书评，点进去就能写。
 */
export function importReviewTexts(
  db: DB,
  files: { name: string; text: string }[],
  opts?: { dir?: string; move?: boolean }
): ReviewIoSummary {
  const out = empty();
  const t = new Date().toISOString();
  /* 事务里不碰文件，先把要落盘的攒下来，提交之后再做。
     事务回滚了文件却已改名，库和目录就对不上了 */
  const bound: { id: number; from: string }[] = [];
  const dup: { id: number; from: string }[] = [];

  const run = db.transaction(() => {
    for (const f of files) {
      const raw = String(f.text || "").replace(/\r\n/g, "\n");
      const { fields, body } = splitFront(raw);
      const text = body;
      const fileName = sanitizeFile(path.basename(f.name));
      let { title, author } = parseName(fileName, text);
      const grade = gradeOf(fileName, text);
      /* 文件名认不出是哪本书时再看首部的「书籍」。名字对不上、字段说了算，仍是一本对一本 */
      let bookId = findBook(db, title, author);
      if (!bookId) {
        const named = bareName(fields["书籍"] || "");
        if (named) {
          const byField = findBook(db, named, author);
          if (byField) {
            bookId = byField;
            title = named;
          }
        }
      }
      /* 阅读时间以首部为准，没写的用导入这一刻 */
      const day = String(fields["阅读时间"] || "").slice(0, 10);
      const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day + "T00:00:00.000Z" : t;

      if (bookId) {
        const cur = db.prepare("SELECT id, md FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(bookId) as any;
        if (!cur) {
          const info = db
            .prepare(
              `INSERT INTO reviews (book_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'import', ?, ?)`
            )
            .run(bookId, title, text, grade, at, "", t, t);
          bound.push({ id: Number(info.lastInsertRowid), from: fileName });
          out.added++;
        } else if (cur.md === text) {
          out.skipped++;
        } else if (!text.trim() && String(cur.md || "").trim()) {
          /* 空文件不许盖掉已有正文。目录里这份是空的，没有东西可并，库里那份留着 */
          out.skipped++;
        } else {
          db.prepare("UPDATE reviews SET md = ?, updated_at = ? WHERE id = ?").run(text, t, cur.id);
          dup.push({ id: cur.id, from: fileName });
          out.updated++;
        }
      } else {
        const oid = existingOrphan(db, fileName);
        if (oid) {
          const cur = db.prepare("SELECT md, grade FROM orphan_reviews WHERE id = ?").get(oid) as any;
          if (cur && cur.md === text && cur.grade === grade) {
            out.skipped++;
          } else if (!text.trim() && String(cur?.md || "").trim()) {
            /* 同上，空的不覆盖已有的 */
            out.skipped++;
          } else {
            db.prepare("UPDATE orphan_reviews SET md = ?, grade = ?, updated_at = ? WHERE id = ?").run(text, grade, t, oid);
            out.updated++;
          }
        } else {
          db.prepare(
            `INSERT INTO orphan_reviews (name, title_guess, md, grade, happened_at, file_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(path.basename(fileName, ".md"), title, text, grade, at, fileName, t, t);
          out.orphan++;
        }
      }
    }
  });
  run();

  /* 新绑上书的那份：把文件改名成规范名，不是另写一份。另写会留下原来那份，
     目录里就成了两份同内容的东西，用户看到的是「绑上了但名字没变」 */
  if (opts?.dir) {
    const dir = opts.dir;
    for (const it of bound) writeOne(db, dir, "book", it.id, it.from);
    /* 这本书本来就有书评，外面这份是同一篇的另一份。内容已经并进库，
       按规范名写一次，再把外面那份收走，免得两份对着改 */
    for (const it of dup) {
      writeOne(db, dir, "book", it.id);
      if (!opts.move) continue;
      const now = loadMap(db)[keyOf("book", it.id)];
      if (now && it.from !== now) removeFile(dir, it.from);
    }
  }

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

/* 首部只认这四个键。别的键原样留在文件里不动，也不往库里塞 */
const FRONT_KEYS = ["阅读时间", "评分", "书籍", "系列"];

/**
 * 拆文件开头的首部。正文里本来就可能有 `---` 分隔线，
 * 所以只有认得出已知键时才算首部，认不出就整篇当正文。
 */
export function splitFront(raw: string): { fields: Record<string, string>; body: string } {
  const s = String(raw || "").replace(/^\uFEFF/, "");
  if (!s.startsWith("---")) return { fields: {}, body: s };
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fields: {}, body: s };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!FRONT_KEYS.includes(k)) continue;
    fields[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!Object.keys(fields).length) return { fields: {}, body: s };
  /* 写的时候首部与正文之间留一个空行，读回来把这个空行去掉，两边才对得上 */
  return { fields, body: s.slice(m[0].length).replace(/^\r?\n/, "") };
}

function bareName(v: string): string {
  return String(v || "").replace(/^[《〈【\s]+|[》〉】\s]+$/g, "").trim();
}

/**
 * 拼上首部再落盘。只有挂到书或系列上的才写：未匹配与草稿没有关联对象，
 * 硬塞一个空头子反而看不懂。库里存的始终是正文，首部是落盘时现拼的。
 */
function compose(db: DB, kind: string, id: number, row?: any): string {
  const body = mdOf(db, kind, id);
  if (kind !== "book" && kind !== "series") return body;
  const r =
    row ||
    (db
      .prepare(
        `SELECT r.happened_at AS happenedAt, b.title AS bookTitle, b.rating AS rating, s.name AS seriesName
           FROM reviews r LEFT JOIN books b ON b.id = r.book_id LEFT JOIN series s ON s.id = r.series_id
          WHERE r.id = ?`
      )
      .get(id) as any);
  if (!r) return body;
  /* 三项一律写出来：没有值也留个空行，字段齐了才好照着填 */
  const day = String(r.happenedAt || "").slice(0, 10);
  const rate = r.rating === null || r.rating === undefined ? NaN : Number(r.rating);
  const lines: string[] = [
    "阅读时间:" + (/^\d{4}-\d{2}-\d{2}$/.test(day) ? " " + day : ""),
    "评分:" + (Number.isFinite(rate) && rate > 0 ? " " + Math.round(rate * 10) / 10 : "")
  ];
  if (kind === "book" && r.bookTitle) lines.push("书籍: 《" + r.bookTitle + "》");
  if (kind === "series" && r.seriesName) lines.push("系列: " + seriesTitle(String(r.seriesName)));
  return "---\n" + lines.join("\n") + "\n---\n\n" + body;
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
  writeIfChanged(path.join(dir, final), compose(db, kind, id));
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

/**
 * 删除之后把磁盘那份收走，并把映射清掉。
 *
 * 只认映射表是不够的：映射是后来才有的，早先导入的书评、或者名字被加了 (2) 序号的那些，
 * 表里可能查不到，于是文件留在原地，下一次同步又把它当成外面新放进来的一份导回库里，
 * 看起来就是「删了又回来」。所以这里退两步：先按规范名再试一次，最后按正文收一份。
 */
export function forgetFile(db: DB, dir: string, kind: string, id: number): void {
  const map = loadMap(db);
  const key = keyOf(kind, id);
  const names = new Set<string>();
  if (map[key]) names.add(map[key]);
  const canon = reviewFileName(db, { kind, id });
  if (canon) names.add(canon);
  for (const n of names) removeFile(dir, n);

  if (dir) {
    const md = mdOf(db, kind, id) || "";
    /* 空正文认不出是谁的，不去猜，免得删到别的空篇 */
    if (md.trim()) {
      const takenByAlive = new Set(
        Object.entries(map)
          .filter(([k]) => k !== key)
          .map(([, v]) => v)
      );
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.md$/i.test(f) || takenByAlive.has(f)) continue;
          if (splitFront(fs.readFileSync(path.join(dir, f), "utf8")).body !== md) continue;
          removeFile(dir, f);
          break;
        }
      } catch {
        /* 读不动目录就算了，文件留着不影响库里已经删掉这件事 */
      }
    }
  }

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
    if (writeIfChanged(path.join(dir, final), compose(db, r.kind, r.id))) out.written++;
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
 * 把已经挂到书或系列上的 md 一律改回当前规范名。
 * 只改名，不写正文也不删文件：正文以同步那条路为准，这里只收拾名字。
 * 目录里找不到对应文件的跳过，免得把映射指到一个不存在的文件上，
 * 下一次同步会以为外面删了这份，把书评从库里抹掉。
 */
export function normalizeNames(db: DB, dir: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  if (!dir) return out;
  fs.mkdirSync(dir, { recursive: true });

  const rows = listReviews(db).filter((r) => r.kind === "book" || r.kind === "series");
  const map = loadMap(db);
  const files = new Set(fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)));
  const texts = new Map<string, string>();
  const textOf = (f: string): string => {
    if (!texts.has(f)) {
      try {
        texts.set(f, fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        texts.set(f, "");
      }
    }
    return texts.get(f) || "";
  };

  /* 先认账：一条书评对应目录里的哪一份。映射优先，映射没了就按规范名，最后按正文认，
     早先导入的那批没有映射记录，只认映射会让它们永远叫旧名字 */
  const used = new Set<string>();
  const plan: { key: string; from: string; canon: string }[] = [];
  for (const r of rows) {
    const key = keyOf(r.kind, r.id);
    const canon = reviewFileName(db, r);
    if (!canon) continue;
    const md = r.md || "";
    let from = "";
    const mapped = map[key];
    if (mapped && files.has(mapped) && !used.has(mapped)) from = mapped;
    if (!from && files.has(canon) && !used.has(canon)) from = canon;
    if (!from && md.trim()) {
      from = [...files].find((f) => !used.has(f) && splitFront(textOf(f)).body === md) || "";
    }
    if (!from) continue;
    used.add(from);
    plan.push({ key, from, canon });
  }

  /* 目录里现在占着的名字一律先算占用。只认自己这一批的名字是不够的：
     未匹配的那些文件、别的书评的文件都在目录里，撞上了会被改名顶掉，那是直接丢文件 */
  const live = new Set<string>(files);
  for (const p of plan) {
    if (p.from === p.canon) continue;
    const final = pickName(p.canon, live);
    live.add(final);
    /* 改成了才记新名字。没改成还记着新名字，下一次同步会以为这份文件被外面删了 */
    if (renameIn(dir, p.from, final)) {
      live.delete(p.from);
      map[p.key] = final;
      out.renamed = (out.renamed || 0) + 1;
    }
  }
  saveMap(db, map);
  return out;
}

/** 库里那条打上删除标记。目录里没了就等于软件里没了，反过来也是 */
function softDelete(db: DB, kind: string, id: number): void {
  const table = kind === "orphan" ? "orphan_reviews" : "reviews";
  const t = new Date().toISOString();
  db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(t, t, id);
}

/**
 * 目录与库对齐。顺序很要紧：先读目录、把外面删掉的、改名的、改过正文的处理完，
 * 再把库里的内容整体写出去。反过来的话，写盘会先把外面删掉的那几份重新造出来，
 * 用户看到的就是「关掉软件时删的书评，一打开又回来了」。
 */
export function syncDir(db: DB, dir: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  fs.mkdirSync(dir, { recursive: true });

  const map = loadMap(db);
  const rows = listReviews(db);
  const byKey = new Map(rows.map((r) => [keyOf(r.kind, r.id), r]));
  const alive = new Set(byKey.keys());
  const files = new Set(fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)));

  /* 这个文件名是不是还有另一条活着的书评在用。改绑时新旧两条会短暂共用一个名字，
     认错了会把刚写出去的那份删掉 */
  const ownedElsewhere = (name: string, exceptKey: string): boolean =>
    Object.entries(map).some(([k, v]) => k !== exceptKey && v === name && alive.has(k));

  /* 一、库里已经没有这条了，映射还留着。文件收走，映射摘掉。
     软件里删书评本来就会顺手删文件，这一步是兜底：上一次没删干净的残留在这收口 */
  for (const [k, v] of Object.entries(map)) {
    if (alive.has(k)) continue;
    if (files.has(v) && !ownedElsewhere(v, k)) {
      removeFile(dir, v);
      files.delete(v);
    }
    delete map[k];
  }

  /* 二、映射里的文件不见了。外面可能在资源管理器里改过名，也可能直接删了。
     先拿正文去找：目录里有一份内容一样、还没人认领的，就是改了名；找不到就是删了 */
  const mapped = new Set(Object.values(map));
  const loose = [...files].filter((f) => !mapped.has(f));
  const textOf = new Map<string, string>();
  for (const f of loose) {
    try {
      textOf.set(f, fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      /* 读不到就按没有这份处理 */
    }
  }

  /* 目录里一个 md 都不剩时不敢删库：多半是书库路径没接对，或者目录刚被整体清空，
     这时候把库里的书评全清掉是灾难。宁可写回去，让人先看见东西还在 */
  const dirEmpty = files.size === 0;
  const claimed = new Set<string>();
  for (const [k, v] of Object.entries(map)) {
    if (files.has(v)) continue;
    const row = byKey.get(k);
    if (!row) continue;
    const md = mdOf(db, k.split(":")[0], row.id) || "";
    if (md.trim()) {
      const hit = loose.find((f) => !claimed.has(f) && splitFront(textOf.get(f) || "").body === md);
      if (hit) {
        map[k] = hit;
        claimed.add(hit);
        out.renamed = (out.renamed || 0) + 1;
        continue;
      }
    }
    if (dirEmpty) continue;
    softDelete(db, row.kind, row.id);
    alive.delete(k);
    delete map[k];
    out.removed = (out.removed || 0) + 1;
  }
  saveMap(db, map);

  /* 三、认过名字之后还剩的映射，比对正文。软件里一改就立刻写盘，文件永远跟得上，
     所以两边不一致只可能是外面动过手 */
  const known = new Set(Object.values(map));
  const incoming: { name: string; text: string }[] = [];
  const byFile = new Map<string, ReviewRow>();
  for (const r of rows) {
    if (!alive.has(keyOf(r.kind, r.id))) continue;
    const n = map[keyOf(r.kind, r.id)];
    if (n && files.has(n)) byFile.set(n, r);
  }
  for (const f of files) {
    let text: string;
    try {
      text = textOf.get(f) ?? fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    if (!known.has(f)) {
      incoming.push({ name: f, text });
      continue;
    }
    const r = byFile.get(f);
    if (!r) continue;
    if (splitFront(text).body !== (r.md || "")) {
      const table = r.kind === "orphan" ? "orphan_reviews" : "reviews";
      db.prepare(`UPDATE ${table} SET md = ?, updated_at = ? WHERE id = ?`).run(text, new Date().toISOString(), r.id);
      out.updated++;
    }
  }
  if (incoming.length) {
    const got = importReviewTexts(db, incoming, { dir, move: true });
    out.added += got.added;
    out.updated += got.updated;
    out.orphan += got.orphan;
    out.skipped += got.skipped;
    out.msgs.push(...got.msgs);
  }

  /* 四、库里剩下的写出去。走到这里，删掉的那些已经不在库里，不会再被造回来 */
  const written = exportAll(db, dir);
  out.written = written.written;
  if (out.removed) out.msgs.push("目录里删掉的 " + out.removed + " 篇，库里也已删除");
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
