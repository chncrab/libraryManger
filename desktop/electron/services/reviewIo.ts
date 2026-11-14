import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";
import type { ReviewIoSummary, ReviewRow } from "../../shared/types";
import { listReviews, reviewFileName, sanitizeFile } from "./reviewService";
import { seriesAuthor, seriesLabel, seriesTitle } from "./seriesService";
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
  const bound: { id: number; from: string; kind: string }[] = [];
  const dup: { id: number; from: string; kind: string }[] = [];

  const run = db.transaction(() => {
    for (const f of files) {
      const raw = String(f.text || "").replace(/\r\n/g, "\n");
      const { fields, body } = splitFront(raw);
      const text = body;
      const fileName = sanitizeFile(path.basename(f.name));
      const named = parseName(fileName, text);
      const grade = gradeOf(fileName, text);

      /* 标签优先。开头写了「书籍」或「系列」就先按它认，认不上再退回文件名，
         两样都认不出才进未匹配池。标签是手写的，错一个字不该把整篇丢掉 */
      const labRaw = String(fields["书籍"] || "").trim();
      const serRaw = labRaw ? "" : String(fields["系列"] || "").trim();
      const lab = labRaw ? splitLabel(labRaw) : serRaw ? splitLabel(serRaw) : null;
      let title = named.title;
      let author = named.author;
      let bookId: string | null = null;
      let seriesId: number | null = null;
      let viaLabel = false;

      if (lab) {
        const au = lab.author || named.author;
        if (labRaw) {
          const hit = findBook(db, lab.title, au);
          if (hit) {
            bookId = hit;
            title = lab.title;
            author = au;
            viaLabel = true;
          }
        } else {
          const sid = findSeries(db, lab.title, au);
          if (sid) {
            seriesId = sid;
            title = lab.title;
            viaLabel = true;
          }
        }
      }
      if (!bookId && !seriesId) {
        bookId = findBook(db, named.title, named.author);
        title = named.title;
        author = named.author;
      }
      /* 标签与文件名各指一本时以标签为准，说明一句，免得以为软件没听 */
      if (viaLabel && lab) {
        const byName = findBook(db, named.title, named.author);
        if (byName && byName !== bookId) {
          out.msgs.push("《" + named.title + "》与开头写的《" + lab.title + "》不是同一本，按开头那份挂上");
        }
      }
      /* 阅读时间以首部为准，没写的用导入这一刻 */
      const day = String(fields["阅读时间"] || "").slice(0, 10);
      const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day + "T00:00:00.000Z" : t;

      if (bookId || seriesId) {
        const cur = bookId
          ? (db.prepare("SELECT id, md FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(bookId) as any)
          : (db.prepare("SELECT id, md FROM reviews WHERE series_id = ? AND book_id IS NULL AND deleted_at IS NULL").get(seriesId) as any);
        if (!cur) {
          const info = db
            .prepare(
              `INSERT INTO reviews (book_id, series_id, name, md, grade, happened_at, file_name, origin, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, '', 'import', ?, ?)`
            )
            .run(bookId || null, seriesId || null, title, text, grade, at, t, t);
          bound.push({ id: Number(info.lastInsertRowid), from: fileName, kind: bookId ? "book" : "series" });
          out.added++;
        } else if (cur.md === text) {
          out.skipped++;
        } else if (!text.trim() && String(cur.md || "").trim()) {
          /* 空文件不许盖掉已有正文。目录里这份是空的，没有东西可并，库里那份留着 */
          out.skipped++;
        } else {
          db.prepare("UPDATE reviews SET md = ?, updated_at = ? WHERE id = ?").run(text, t, cur.id);
          dup.push({ id: cur.id, from: fileName, kind: bookId ? "book" : "series" });
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
    for (const it of bound) writeOne(db, dir, it.kind, it.id, it.from);
    /* 这本书本来就有书评，外面这份是同一篇的另一份。内容已经并进库，
       按规范名写一次，再把外面那份收走，免得两份对着改 */
    for (const it of dup) {
      writeOne(db, dir, it.kind, it.id);
      if (!opts.move) continue;
      const now = loadMap(db)[keyOf(it.kind, it.id)];
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

/* 首部认这五个键。别的键原样留在文件里不动，也不往库里塞 */
const FRONT_KEYS = ["阅读时间", "评分", "书籍", "系列", "分类"];

/* 标签总开关。设成 "0" 之后一律不写首部，撤销标签靠它，不能只删文件那一块 */
const FRONT_SWITCH = "review_front";

/**
 * 拆文件开头的首部。正文里本来就可能有 `---` 分隔线，
 * 所以只有认得出已知键时才算首部，认不出就整篇当正文。
 *
 * hasFront 表示「开头确实有一块标签」，补写时按它判断该不该补，
 * 不看正文有没有变。块里缺了某个键也算有块，缺的那行由补写补上。
 */
export function splitFront(raw: string): { fields: Record<string, string>; body: string; hasFront: boolean } {
  const s = String(raw || "").replace(/^\uFEFF/, "");
  if (!s.startsWith("---")) return { fields: {}, body: s, hasFront: false };
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fields: {}, body: s, hasFront: false };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!FRONT_KEYS.includes(k)) continue;
    fields[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!Object.keys(fields).length) return { fields: {}, body: s, hasFront: false };
  /* 写的时候首部与正文之间留一个空行，读回来把这个空行去掉，两边才对得上 */
  return { fields, body: s.slice(m[0].length).replace(/^\r?\n/, ""), hasFront: true };
}

/**
 * 首部里「书籍」「系列」两行的写法是「作者-《书名》」，作者可以省。
 * 拆开之后交给 findBook 走现有那套同名收窄，与文件名那条路同一个口径。
 */
export function splitLabel(v: string): { author: string; title: string } {
  const s = String(v || "").trim();
  const m = s.match(/《([^》]+)》/);
  if (m) {
    const head = s.slice(0, m.index).replace(/[-_\s]+$/, "").trim();
    return { author: head, title: m[1].trim() };
  }
  return { author: "", title: s.replace(/^[《〈【\s]+|[》〉】\s]+$/g, "").trim() };
}

/** 系列名归一：去书名号、去尾部「系列/シリーズ」、去空白，好让标签与库里的名字对得上 */
function normSeries(s: string): string {
  return seriesLabel(String(s || "").replace(/^[《〈【\s]+|[》〉】\s]+$/g, ""))
    .replace(/\s+/g, "")
    .trim();
}

/** 标签里的系列名去库里找。同名跨媒介时用主作者收窄，收不窄取库里排前面的那个 */
function findSeries(db: DB, name: string, author: string): number | null {
  const want = normSeries(name);
  if (!want) return null;
  /* 书评首部里的系列名可能是原名也可能是译名，两个都认 */
  const rows = db.prepare("SELECT id, name, zh_name FROM series ORDER BY id").all() as any[];
  const hits = rows.filter(
    (r) => normSeries(String(r.name)) === want || (r.zh_name && normSeries(String(r.zh_name)) === want)
  );
  if (!hits.length) return null;
  if (hits.length === 1) return Number(hits[0].id);
  if (author) {
    const byAuthor = hits.filter((r) => seriesAuthor(db, Number(r.id)) === author);
    if (byAuthor.length === 1) return Number(byAuthor[0].id);
  }
  return Number(hits[0].id);
}

/**
 * 一本书的分类名。只写叶子名字，不带「地区/」这种前缀，按根节点的先后排，
 * 同根下面按自己的序号排。根序号与子序号不在一个域里，分开比才排得对。
 */
function catsOf(db: DB, bookId: string): string[] {
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
    out.push({ name, root: Number(r.pOrd ?? r.cOrd) || 0, leaf: r.pOrd == null ? 0 : Number(r.cOrd) || 0 });
  }
  out.sort((a, b) => a.root - b.root || a.leaf - b.leaf || a.name.localeCompare(b.name, "zh"));
  return out.map((o) => o.name);
}

/** 系列里册序最靠前的那本，分类与作者都从它取 */
function firstBookOfSeries(db: DB, seriesId: number): any {
  return db
    .prepare(
      `SELECT id, title FROM books
        WHERE series_id = ? AND deleted_at IS NULL
        ORDER BY series_index IS NULL, series_index, title LIMIT 1`
    )
    .get(seriesId);
}

type FrontInfo = { day: string; rate: number | null; own: string; cats: string[] };

/**
 * 首部里由库派生出来的那几项。
 * 单本取这本书的阅读日期、评分、分类；系列取最晚读的那天、最近读过且有分那册的评分、首册的分类。
 */
function frontOf(db: DB, kind: string, id: number): FrontInfo | null {
  if (kind === "book") {
    const r = db
      .prepare(
        `SELECT b.id, b.title, b.read_date AS readDate, b.rating AS rating,
                (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                  WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
           FROM reviews r JOIN books b ON b.id = r.book_id
          WHERE r.id = ?`
      )
      .get(id) as any;
    if (!r) return null;
    const day = String(r.readDate || "").slice(0, 10);
    return {
      day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "",
      rate: numOrNull(r.rating),
      own: (r.author ? r.author + "-" : "") + "《" + String(r.title || "") + "》",
      cats: catsOf(db, String(r.id))
    };
  }
  if (kind === "series") {
    const s = db
      .prepare("SELECT s.id, s.name FROM reviews r JOIN series s ON s.id = r.series_id WHERE r.id = ?")
      .get(id) as any;
    if (!s) return null;
    const sid = Number(s.id);
    const last = db
      .prepare(
        `SELECT MAX(b.read_date) AS d FROM books b
          WHERE b.series_id = ? AND b.deleted_at IS NULL`
      )
      .get(sid) as any;
    const rated = db
      .prepare(
        `SELECT b.rating AS rating FROM books b
          WHERE b.series_id = ? AND b.deleted_at IS NULL AND b.rating > 0
            AND b.read_date IS NOT NULL AND b.read_date <> ''
          ORDER BY b.read_date DESC, b.series_index IS NULL, b.series_index, b.title LIMIT 1`
      )
      .get(sid) as any;
    const day = String(last?.d || "").slice(0, 10);
    const au = seriesAuthor(db, sid);
    const first = firstBookOfSeries(db, sid);
    return {
      day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "",
      rate: numOrNull(rated?.rating),
      own: (au ? au + "-" : "") + seriesTitle(String(s.name || "")),
      cats: first ? catsOf(db, String(first.id)) : []
    };
  }
  return null;
}

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

/**
 * 拼上首部再落盘。只有挂到书或系列上的才写：未匹配与草稿没有关联对象，
 * 硬塞一个空头子反而看不懂。库里存的始终是正文，首部是落盘时现拼的。
 *
 * existing 是磁盘上那份现在的内容。给了它，首部里的「书籍」「系列」以文件为准，
 * 免得把人在 Obsidian 里手改的那行盖回去。这两行是文件权威，其余三行由库单向写出。
 *
 * 设置 review_front 关掉时整块不写，这是「撤销标签」的落点：
 * 只删文件里那一块而不改这个开关，下一次同步又会把它补回来。
 */
function compose(db: DB, kind: string, id: number, existing?: string): string {
  const body = mdOf(db, kind, id);
  if (kind !== "book" && kind !== "series") return body;
  if (getSetting(db, FRONT_SWITCH, "1") === "0") return body;
  const info = frontOf(db, kind, id);
  if (!info) return body;

  const cur = existing ? splitFront(existing).fields : {};
  const key = kind === "book" ? "书籍" : "系列";
  /* 文件里那行认得出、而且带上了作者，就照它写；只写了个书名的是老格式，按现在的规矩补上作者 */
  const fromFile = ownOf(db, kind, cur[key]);
  const own = /-《/.test(fromFile) ? fromFile : info.own;

  const lines: string[] = [
    "阅读时间:" + (info.day ? " " + info.day : ""),
    "评分:" + (info.rate ? " " + info.rate : ""),
    key + ":" + (own ? " " + own : ""),
    "分类:" + (info.cats.length ? " " + info.cats.join("、") : "")
  ];
  return "---\n" + lines.join("\n") + "\n---\n\n" + body;
}

/** 磁盘上那份的现状，读不到就当没有 */
function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 文件开头写的「书籍」或「系列」。认得出对应的书或系列才照它写，那是文件权威；
 * 认不出说明手写错了，不能把一个不存在的名字一直留在文件里，交给库里的值纠回来。
 */
function ownOf(db: DB, kind: string, v: string | undefined): string {
  const s = String(v || "").trim();
  if (!s) return "";
  const lab = splitLabel(s);
  if (!lab.title) return "";
  const hit = kind === "book" ? !!findBook(db, lab.title, lab.author) : findSeries(db, lab.title, lab.author) !== null;
  return hit ? s : "";
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
  const target = path.join(dir, final);
  writeIfChanged(target, compose(db, kind, id, readText(target)));
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
    const target = path.join(dir, final);
    if (writeIfChanged(target, compose(db, r.kind, r.id, readText(target)))) out.written++;
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
 * 把整个书评目录复制一份。不用 cpSync：宿主机上装了删除与复制的垫片，
 * 自己走一遍目录最省事，也不会因为某个文件占用就整批退出。
 */
function copyDir(from: string, to: string): number {
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else {
      fs.copyFileSync(a, b);
      n++;
    }
  }
  return n;
}

function backupReviews(dir: string, backupDir?: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = backupDir || path.join(path.dirname(dir), "backups", "reviews-" + stamp);
  copyDir(dir, bak);
  return bak;
}

/**
 * 现有书评一次性把开头那块补齐。
 *
 * 只动开头，正文一个字节不碰：写完立刻把拆出来的正文与写之前比一次，
 * 不一致就整批停下，不再往下跑。
 *
 * 已经齐的跳过，重复点没有副作用。动作之前把整个目录复制一份到 backups 下面，
 * 库里不动，所以备份只备文件。
 */
export function fillFront(db: DB, dir: string, backupDir?: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  if (!dir) return out;
  fs.mkdirSync(dir, { recursive: true });

  try {
    out.backup = backupReviews(dir, backupDir);
  } catch (e) {
    out.msgs.push("备份没做成，这次不补了");
    return out;
  }

  /* 补之前把开关打开，否则 compose 会因为「标签已撤销」拒绝写首部 */
  setSetting(db, FRONT_SWITCH, "1");
  const map = loadMap(db);
  const rows = listReviews(db).filter((r) => r.kind === "book" || r.kind === "series");

  for (const r of rows) {
    const key = keyOf(r.kind, r.id);
    const mapped = map[key] || "";
    const canon = reviewFileName(db, r);
    const name = mapped && fs.existsSync(path.join(dir, mapped)) ? mapped : canon;
    if (!name) continue;
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;

    const cur = readText(file);
    const next = compose(db, r.kind, r.id, cur);
    if (next === cur) {
      out.skipped++;
      continue;
    }
    /* 正文必须原样：这一条挡的是「补标签顺手改了正文」这种最不该出的事 */
    if (splitFront(next).body !== splitFront(cur).body) {
      out.msgs.push("《" + (r.title || name) + "》补完正文对不上，停在它这里，前面的已写");
      break;
    }
    writeIfChanged(file, next);
    map[key] = name;
    out.filled = (out.filled || 0) + 1;
  }

  saveMap(db, map);
  return out;
}

/**
 * 撤销标签。把开头那块整段删掉，同时把开关关掉。
 *
 * 只删文件那一块是不够的：库里每次导出都会按现有规则重拼首部，
 * 下一次同步或保存就把删掉的补回来，撤销等于白做。
 */
export function stripFront(db: DB, dir: string, backupDir?: string): ReviewIoSummary {
  const out = empty();
  out.dir = dir;
  if (!dir || !fs.existsSync(dir)) return out;

  try {
    out.backup = backupReviews(dir, backupDir);
  } catch (e) {
    out.msgs.push("备份没做成，这次不撤了");
    return out;
  }

  setSetting(db, FRONT_SWITCH, "0");
  for (const f of fs.readdirSync(dir)) {
    if (!/\.md$/i.test(f)) continue;
    const file = path.join(dir, f);
    const cur = readText(file);
    const parts = splitFront(cur);
    if (!parts.hasFront) continue;
    writeIfChanged(file, parts.body);
    out.filled = (out.filled || 0) + 1;
  }
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
