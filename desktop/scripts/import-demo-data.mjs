/**
 * 把 app/ 下现有的 demo 数据导进 SQLite：书目、作者、系列、分类、实体与电子库存、封面、书评。
 * 用法：node scripts/import-demo-data.mjs [--reset]
 * 数据源：../app/data.js、../app/covers.js、../app/covers/、../app/reviews/_seed.js
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { MIGRATIONS } = require("../dist-electron/electron/db/schema.js");
const { planSeriesMatches, applySeriesMatches } = await import("./series-match.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP = path.resolve(ROOT, "..", "app");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = process.env.LIBRARY_DB || path.join(DATA_DIR, "library.db");
const COVER_DST = path.join(path.dirname(DB_FILE), "covers");

const CAT_TIERS = [
  { n: "国籍", list: ["日本", "中国", "欧美"] },
  { n: "次分类", list: ["推理", "悬疑", "科幻", "奇幻", "轻小说", "网络文学", "恋爱", "爱情", "历史", "经典", "武侠", "私小说", "童话"] },
  { n: "细分类", list: ["校园", "体育", "喜剧", "励志", "职场", "家庭", "青春", "恐怖", "摇滚", "科普", "画集", "官能"] }
];

function loadGlobal(file, name) {
  const code = fs.readFileSync(file, "utf8");
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window[name];
}

const nowIso = () => new Date().toISOString();

function main() {
  if (process.argv.includes("--reset")) {
    for (const f of [DB_FILE, DB_FILE + "-wal", DB_FILE + "-shm"]) if (fs.existsSync(f)) fs.unlinkSync(f);
    console.log("已删旧库", DB_FILE);
  }
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.mkdirSync(COVER_DST, { recursive: true });

  const data = loadGlobal(path.join(APP, "data.js"), "BOOK_DATA");
  const covers = loadGlobal(path.join(APP, "covers.js"), "COVER_MAP") || {};
  let seed = { books: {}, orphans: [] };
  const seedFile = path.join(APP, "reviews", "_seed.js");
  if (fs.existsSync(seedFile)) seed = loadGlobal(seedFile, "REVIEW_SEED") || seed;

  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, nowIso());
    console.log("迁移", m.version, m.name);
  }

  const stat = { books: 0, authors: 0, series: 0, cats: 0, covers: 0, reviews: 0, orphans: 0, states: 0, tags: 0 };

  const insSeries = db.prepare("INSERT OR IGNORE INTO series (media_type, name, display_name) VALUES (?, ?, ?)");
  const getSeries = db.prepare("SELECT id FROM series WHERE media_type = ? AND name = ?");
  const insAuthor = db.prepare("INSERT OR IGNORE INTO authors (name, country) VALUES (?, ?)");
  const getAuthor = db.prepare("SELECT id FROM authors WHERE name = ?");
  const insCat = db.prepare("INSERT OR IGNORE INTO categories (name, tier, ord) VALUES (?, ?, ?)");
  const getCat = db.prepare("SELECT id FROM categories WHERE name = ?");
  const insTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTag = db.prepare("SELECT id FROM tags WHERE name = ?");

  const insBook = db.prepare(`INSERT INTO books
    (id, title, subtitle, original_title, original_subtitle, media_type, series_id, series_index,
     country, is_mystery, publish_date, publish_year, is_read, read_date, rating, ebook_state, note,
     cover_file, source, created_at, updated_at)
    VALUES (@id, @title, @subtitle, @original_title, @original_subtitle, @media_type, @series_id, @series_index,
     @country, @is_mystery, @publish_date, @publish_year, @is_read, @read_date, @rating, @ebook_state, @note,
     @cover_file, @source, @created_at, @updated_at)`);
  const insBA = db.prepare("INSERT OR IGNORE INTO book_authors (book_id, author_id, role, ord) VALUES (?, ?, '著', ?)");
  const insBC = db.prepare("INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)");
  const insBS = db.prepare("INSERT OR IGNORE INTO book_states (book_id, state) VALUES (?, ?)");
  const insBT = db.prepare("INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)");
  const insFts = db.prepare("INSERT INTO books_fts (rowid, title, subtitle, original_title, authors, series, note) VALUES (?, ?, ?, ?, ?, ?, ?)");

  for (const tier of CAT_TIERS) tier.list.forEach((name, i) => insCat.run(name, CAT_TIERS.indexOf(tier), i));
  stat.cats = db.prepare("SELECT COUNT(*) AS n FROM categories").get().n;

  /* 封面文件名跟软件里一致：作者-作品名-系列序号.ext，没有序号就省掉尾巴 */
  const takenCovers = new Set();
  const coverName = (b, ext) => {
    const head = (Array.isArray(b.authors) && b.authors[0]) || "";
    const idx = Number.isFinite(b.seriesIndex) ? String(b.seriesIndex) : "";
    const base = [head, b.title || "未命名", idx].filter((x) => x !== "").join("-");
    const clean = base.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
    let name = clean + ext;
    let i = 2;
    while (takenCovers.has(name) || fs.existsSync(path.join(COVER_DST, name))) {
      name = clean + "-" + i + ext;
      i++;
    }
    takenCovers.add(name);
    return name;
  };

  const copyCover = (b) => {
    const rel = covers[b.id] || "";
    if (!rel) return "";
    const src = path.join(APP, rel);
    if (!fs.existsSync(src)) return "";
    const dst = path.join(COVER_DST, coverName(b, path.extname(src).toLowerCase()));
    fs.copyFileSync(src, dst);
    stat.covers++;
    return path.basename(dst);
  };

  const run = db.transaction(() => {
    for (const b of data.books) {
      let seriesId = null;
      const sname = (b.seriesName || "").trim();
      if (sname) {
        insSeries.run(b.mediaType, sname, sname.replace(/シリーズ$/, "").replace(/系列$/, "").trim() || sname);
        seriesId = getSeries.get(b.mediaType, sname).id;
      }
      const rowid = data.books.indexOf(b) + 1;
      insBook.run({
        id: b.id,
        title: b.title || "(无题)",
        subtitle: b.subtitle || "",
        original_title: b.originalTitle || "",
        original_subtitle: b.originalSubtitle || "",
        media_type: b.mediaType || "小说",
        series_id: seriesId,
        series_index: Number.isFinite(b.seriesIndex) ? b.seriesIndex : null,
        country: b.country || "",
        is_mystery: b.isMystery ? 1 : 0,
        publish_date: b.publishDate || "",
        publish_year: b.publishYear ?? null,
        is_read: b.isRead ? 1 : 0,
        read_date: b.readDate || "",
        rating: b.rating == null || b.rating === "" ? null : Number(b.rating),
        ebook_state: b.ebookState || "",
        note: b.note || "",
        cover_file: copyCover(b),
        source: "demo",
        created_at: nowIso(),
        updated_at: nowIso()
      });
      stat.books++;

      const authors = Array.isArray(b.authors) ? b.authors : [];
      authors.forEach((name, i) => {
        const n = String(name || "").trim();
        if (!n) return;
        insAuthor.run(n, b.country || "");
        const a = getAuthor.get(n);
        insBA.run(b.id, a.id, i);
        stat.authors++;
      });
      const cats = Array.isArray(b.categories) ? b.categories : [];
      for (const c of cats) {
        const n = String(c || "").trim();
        if (!n) continue;
        insCat.run(n, 9, 0);
        insBC.run(b.id, getCat.get(n).id);
        stat.cats++;
      }
      const states = Array.isArray(b.physicalState) ? b.physicalState : [];
      for (const s of states) {
        const n = String(s || "").trim();
        if (!n) continue;
        insBS.run(b.id, n === "有" ? "实体" : n);
        stat.states++;
      }
      const tags = Array.isArray(b.tags) ? b.tags : [];
      for (const t of tags) {
        const n = String(t || "").trim();
        if (!n) continue;
        insTag.run(n);
        insBT.run(b.id, getTag.get(n).id);
        stat.tags++;
      }
      const authorsText = authors.join(" ");
      insFts.run(rowid, b.title || "", b.subtitle || "", b.originalTitle || "", authorsText, sname, b.note || "");
    }

    const insReview = db.prepare(`INSERT INTO reviews (book_id, md, name, grade, happened_at, file_name, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'demo-seed', ?, ?)`);
    const bookIds = new Set(data.books.map((b) => b.id));
    for (const [id, r] of Object.entries(seed.books || {})) {
      if (!bookIds.has(id) || !r || !r.md) continue;
      insReview.run(id, r.md, r.name || "", r.grade || "normal", r.at || "", "", nowIso(), nowIso());
      stat.reviews++;
    }
    const insOrphan = db.prepare(`INSERT INTO orphan_reviews (name, title_guess, md, grade, happened_at, file_name, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const o of seed.orphans || []) {
      if (!o || !o.md) continue;
      insOrphan.run(o.name || "", o.titleGuess || "", o.md, o.grade || "normal", o.at || "", "", o.path || "", nowIso(), nowIso());
      stat.orphans++;
    }
    /* 名字对得上系列的，直接当系列总评收进去，不再躺在未匹配池里 */
    const plan = planSeriesMatches(
      db.prepare("SELECT id, name, md, file_name FROM orphan_reviews WHERE deleted_at IS NULL").all(),
      db.prepare("SELECT id, name, display_name, media_type FROM series").all()
    );
    stat.seriesReviews = applySeriesMatches(db, plan).length;
    stat.orphans -= stat.seriesReviews;
  });
  run();

  stat.series = db.prepare("SELECT COUNT(*) AS n FROM series").get().n;
  stat.cats = db.prepare("SELECT COUNT(*) AS n FROM categories").get().n;
  const total = db.prepare("SELECT COUNT(*) AS n FROM books").get().n;
  console.log("库文件", DB_FILE);
  console.log("书目", total, "| 系列", stat.series, "| 分类", stat.cats, "| 封面复制", stat.covers);
  console.log(
    "书评", stat.reviews, "| 系列总评", stat.seriesReviews || 0, "| 未匹配", stat.orphans,
    "| 库存项", stat.states, "| 标签关联", stat.tags
  );
  db.close();
}

main();
