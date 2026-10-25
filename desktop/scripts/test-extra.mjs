/*
 * 服务层自测第二组：多字段排序、高级筛选、系列集合、书评导入导出与目录同步、封面、备份、设置。
 * 跑法同 test-edit：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/test-extra.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* data 只是测试临时目录，跑完就清；书库本体在「我的书库」，两者不是一回事 */
fs.mkdirSync(path.join(root, "data"), { recursive: true });
const file = process.argv[2] || path.join(root, "data", "t2.db");
const src = path.join(root, "我的书库", "library.db");
if (!fs.existsSync(src)) {
  console.log("缺少样本库 " + src + "，本组测试以本地书库为样本，跳过");
  process.exit(0);
}
fs.rmSync(file, { force: true });
fs.rmSync(file + "-wal", { force: true });
fs.rmSync(file + "-shm", { force: true });
fs.copyFileSync(src, file);
process.env.LIBRARY_DB = file;

const { openDb } = require("../dist-electron/electron/db/index.js");
const { listBooks } = require("../dist-electron/electron/services/bookService.js");
const { listSeries, seriesBooks, seriesReviewOf, seriesLabel, seriesAuthor } = require("../dist-electron/electron/services/seriesService.js");
const rv = require("../dist-electron/electron/services/reviewService.js");
const io = require("../dist-electron/electron/services/reviewIo.js");
const { setCoverFromFile, resetCover } = require("../dist-electron/electron/services/coverService.js");
const { backupTo } = require("../dist-electron/electron/services/backupService.js");
const { getSetting, setSetting } = require("../dist-electron/electron/services/settingsService.js");
const { ensureStructure, isLibrary, copyLibrary } = require("../dist-electron/electron/services/libraryService.js");
const { copyBook, copyBooks, updateBook } = require("../dist-electron/electron/services/editService.js");

const db = openDb(file);
let ok = 0;
let bad = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    ok++;
    console.log("  ok   " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("  FAIL " + name + (extra ? "  " + extra : ""));
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booklib-"));

/* 换封面只需要一张能读的图片，跟库里现有封面叫什么没关系。
   自带一张最小 png，不去翻书库目录：测试要能在没有书库的机器上跑，
   也不该把用户的书库图片当成测试夹具 */
const coverSrcDir = tmp;
const anyCover = (() => {
  const p = path.join(coverSrcDir, "_sample.png");
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      )
    );
  }
  return p;
})();
const coverSrc = () => anyCover;

console.log("\n[1] 迁移 v4");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
t("有 settings 表", tables.includes("settings"));
t("有 cover_history 表", tables.includes("cover_history"));
const ver = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
t("迁移到 v4", ver === 4, "当前 v" + ver);

console.log("\n[2] 多字段排序");
const byRating = listBooks(db, { sorts: [{ key: "rating", dir: -1 }, { key: "title", dir: 1 }], limit: 2000 }).rows;
let sortedOk = true;
let nullTail = true;
let seenNull = false;
for (let i = 0; i < byRating.length; i++) {
  const r = byRating[i].rating;
  if (r == null) seenNull = true;
  else if (seenNull) nullTail = false;
  if (i && byRating[i - 1].rating != null && r != null && byRating[i - 1].rating < r) sortedOk = false;
}
t("评分降序", sortedOk, byRating.slice(0, 3).map((b) => b.rating).join(","));
t("未评分沉到末尾", nullTail);

const byYearAsc = listBooks(db, { sorts: [{ key: "year", dir: 1 }], limit: 40 }).rows;
t("出版年升序", byYearAsc[0].publishYear <= byYearAsc[byYearAsc.length - 1].publishYear, byYearAsc[0].publishYear + " → " + byYearAsc[byYearAsc.length - 1].publishYear);

console.log("\n[3] 高级筛选");
const hi = listBooks(db, { adv: { ratingMin: 8, ratingMax: null, yearFrom: null, yearTo: null, hasReview: null, note: "" }, limit: 2000 });
t("评分 ≥ 8 全部满足", hi.rows.every((b) => b.rating != null && b.rating >= 8), hi.total + " 本");
const reviewed = listBooks(db, { adv: { ratingMin: null, ratingMax: null, yearFrom: null, yearTo: null, hasReview: true, note: "" }, limit: 2000 });
const unreviewed = listBooks(db, { adv: { ratingMin: null, ratingMax: null, yearFrom: null, yearTo: null, hasReview: false, note: "" }, limit: 2000 });
const allN = listBooks(db, { limit: 1 }).total;
t("有书评 + 没书评 = 全部", reviewed.total + unreviewed.total === allN, reviewed.total + " + " + unreviewed.total + " = " + allN);
t("有书评条目都带等级", reviewed.rows.every((b) => !!b.reviewGrade));

console.log("\n[4] 系列集合");
const ser = listSeries(db, "小说");
t("小说系列非空", ser.length > 0, ser.length + " 个");
t("册数降序", ser.every((s, i) => i === 0 || ser[i - 1].n >= s.n));
t("有系列带封面", ser.some((s) => !!s.cover));
t("系列名去掉尾部系列一词", seriesLabel("冰菓シリーズ") === "冰菓" && seriesLabel("某系列") === "某", seriesLabel("冰菓シリーズ") + " / " + seriesLabel("某系列"));
const top = ser[0];
const booksOfTop = seriesBooks(db, top.id);
t("系列内册数与集合一致", booksOfTop.length === top.n, top.n + " 册");
t("系列内按卷序排", booksOfTop.every((b, i) => i === 0 || (booksOfTop[i - 1].seriesIndex ?? 0) <= (b.seriesIndex ?? 0)));

console.log("\n[5] 系列总评");
const sr = rv.createReview(db, { seriesId: top.id, name: top.label, grade: "god", md: "# 系列总评\n整体系列评价。" });
t("新建系列总评", sr.ok && !!sr.id);
const got = seriesReviewOf(db, top.id);
t("读得回来", !!got && got.grade === "god" && got.md.includes("总评"));
const again = rv.createReview(db, { seriesId: top.id, md: "重复" });
t("同一系列不许第二篇", !again.ok, again.msg || "");
const all = rv.listReviews(db);
const seriesRows = all.filter((r) => r.kind === "series");
t("书评清单里有系列这一档", seriesRows.some((r) => r.id === sr.id));
t("系列行带 display 名", !!seriesRows[0].seriesLabel, seriesRows[0].seriesLabel || "");
const serFile = rv.reviewFileName(db, { kind: "series", id: sr.id });
t(
  "系列总评文件名叫 作者-《系列名》系列.md",
  /^.+?-《?.+?》?系列\.md$/.test(serFile) && serFile.includes(top.label.replace(/^[《〈【]|[》〉】]$/g, "")),
  serFile
);
t("系列文件名以主作者打头", serFile.startsWith(seriesAuthor(db, top.id) + "-"), serFile + " / " + seriesAuthor(db, top.id));

console.log("\n[6] 书评导入");
const free = db
  .prepare(
    `SELECT b.title, (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
       FROM books b WHERE b.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.book_id = b.id AND r.deleted_at IS NULL)
       ORDER BY b.title LIMIT 1`
  )
  .get();
const fname = (free.author || "佚名") + "-《" + free.title + "》书评.md";
const imported = io.importReviewTexts(db, [
  { name: fname, text: "# 测试导入\n这篇是导入的正文。" },
  { name: "不存在-《根本没有这本书》书评.md", text: "孤儿正文" }
]);
t("匹配上一本", imported.added === 1, fname);
t("没匹配的进未匹配池", imported.orphan === 1);
const dup = io.importReviewTexts(db, [{ name: fname, text: "# 测试导入\n这篇是导入的正文。" }]);
t("同样的内容再导一次算跳过", dup.skipped === 1);

console.log("\n[7] 导出与目录同步");
const dir = path.join(tmp, "reviews");
const exp = io.exportAll(db, dir);
t("导出写了文件", exp.written > 50, exp.written + " 篇");
t("文件名是作者-《书名》书评.md", fs.existsSync(path.join(dir, fname)), fname);
const seriesFile = fs.readdirSync(dir).find((f) => f.endsWith("系列.md"));
t("系列总评单独成文件", !!seriesFile, seriesFile || "");

/* 模拟在文件夹里改了正文（时间戳放到未来），同步应当把库里的正文更新掉 */
const target = fs.readdirSync(dir).find((f) => f.includes(free.title));
const changed = "# 外部改过\n这是在文件夹里改的。";
fs.writeFileSync(path.join(dir, target), changed, "utf8");
const future = new Date(Date.now() + 60000);
fs.utimesSync(path.join(dir, target), future, future);
const sync = io.syncDir(db, dir);
const after = db.prepare("SELECT md FROM reviews WHERE book_id = (SELECT id FROM books WHERE title = ?) AND deleted_at IS NULL").get(free.title);
t("文件夹里改的正文被收进库", sync.updated >= 1 && after.md === changed, "更新 " + sync.updated);
const newFile = "佚名-《又一本不存在的书》书评.md";
fs.writeFileSync(path.join(dir, newFile), "目录里新放的一篇", "utf8");
const sync2 = io.syncDir(db, dir);
t("目录里新增的 md 被导进来", sync2.orphan >= 1, "未匹配 " + sync2.orphan);

console.log("\n[8] 换封面与撤销");
const withCover = db.prepare("SELECT id, cover_file FROM books WHERE cover_file <> '' AND deleted_at IS NULL LIMIT 1").get();
const coversDir = path.join(tmp, "covers");
fs.mkdirSync(coversDir, { recursive: true });
const srcCover = coverSrc(withCover.cover_file);
if (fs.existsSync(srcCover)) {
  /* 先按现在的名字放一张进去，模拟库里本来就有这张封面 */
  const origName = path.basename(String(withCover.cover_file));
  fs.copyFileSync(srcCover, path.join(coversDir, origName));
  const set = setCoverFromFile(db, withCover.id, srcCover, coversDir);
  t("换封面写出的还是规范名", set.ok && !!set.cover && fs.existsSync(path.join(coversDir, set.cover)), set.cover || set.msg || "");
  const hist = db.prepare("SELECT orig_file FROM cover_history WHERE book_id = ?").get(withCover.id);
  t(
    "原图没被盖掉，另存一份",
    !!hist && hist.orig_file !== set.cover && fs.existsSync(path.join(coversDir, hist.orig_file)),
    hist ? hist.orig_file : "无历史"
  );
  const back = resetCover(db, withCover.id, coversDir);
  const row = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(withCover.id);
  t(
    "撤销退回原图",
    back.ok && row.cover_file === withCover.cover_file && fs.existsSync(path.join(coversDir, row.cover_file)),
    row.cover_file
  );
} else {
  t("换封面成功", false, "找不到源封面文件 " + srcCover);
}

console.log("\n[8b] 封面文件名");
/* 封面叫 作者-作品名-系列序号，没有序号就省掉尾巴 */
const pickAuthor = `(SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                      WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1)`;
const withIdx = db
  .prepare(
    `SELECT b.id, b.title, b.series_index AS idx, b.cover_file, ${pickAuthor} AS author
       FROM books b WHERE b.deleted_at IS NULL AND b.cover_file <> '' AND b.series_index IS NOT NULL
       ORDER BY b.id LIMIT 1`
  )
  .get();
const noIdx = db
  .prepare(
    `SELECT b.id, b.title, b.cover_file, ${pickAuthor} AS author
       FROM books b WHERE b.deleted_at IS NULL AND b.cover_file <> '' AND b.series_index IS NULL
       ORDER BY b.id LIMIT 1`
  )
  .get();
/* 源图只用来当一张能读的图片，跟库里现有封面叫什么没关系 */
const srcOf = (row) => coverSrc(row.cover_file);

if (withIdx && fs.existsSync(srcOf(withIdx))) {
  const want = (withIdx.author || "") + "-" + withIdx.title + "-" + withIdx.idx;
  const set = setCoverFromFile(db, withIdx.id, srcOf(withIdx), coversDir);
  const got = String(set.cover || "").replace(/\.(jpg|jpeg|png|webp)$/i, "");
  t("有系列序号的封面带序号", got === want || got === want + "-2", set.cover + " / 期望 " + want);
  t("封面文件真的落盘", fs.existsSync(path.join(coversDir, set.cover || "")), set.cover || "");

  /* 改书名，封面文件跟着改名，不是留一份旧的 */
  const oldName = set.cover;
  updateBook(db, withIdx.id, { title: withIdx.title + "·封面改名" }, coversDir);
  const after = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(withIdx.id).cover_file;
  t("改书名后封面换名", after !== oldName && after.startsWith((withIdx.author || "") + "-" + withIdx.title + "·封面改名"), after);
  t("旧封面文件已收走", !fs.existsSync(path.join(coversDir, oldName)), oldName);
  updateBook(db, withIdx.id, { title: withIdx.title }, coversDir);
  const back2 = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(withIdx.id).cover_file;
  t("书名改回来封面也改回来", back2 === oldName, back2 + " / " + oldName);

  /* 副本拿一份自己的图，改副本封面不动原书 */
  const dup = copyBook(db, withIdx.id, coversDir);
  t("副本有自己的封面文件", !!dup && dup.cover !== oldName && fs.existsSync(path.join(coversDir, dup.cover)), dup ? dup.cover : "");
  const set2 = setCoverFromFile(db, dup.id, srcOf(withIdx), coversDir);
  t("改副本封面不影响原书", set2.ok && fs.existsSync(path.join(coversDir, oldName)), oldName);
  db.prepare("DELETE FROM books WHERE id = ?").run(dup.id);
  db.prepare("DELETE FROM cover_history WHERE book_id = ?").run(dup.id);

  resetCover(db, withIdx.id, coversDir);
}

if (noIdx && fs.existsSync(srcOf(noIdx))) {
  const set = setCoverFromFile(db, noIdx.id, srcOf(noIdx), coversDir);
  const want = (noIdx.author || "") + "-" + noIdx.title;
  const got = String(set.cover || "").replace(/\.(jpg|jpeg|png|webp)$/i, "");
  t("没有序号的封面不带尾巴", got === want || got === want + "-2", set.cover + " / 期望 " + want);
  resetCover(db, noIdx.id, coversDir);
}

console.log("\n[9] 备份与设置");
setSetting(db, "review_dir", tmp);
t("设置写得进读得出", getSetting(db, "review_dir") === tmp);
setSetting(db, "review_dir", "/a/b");
t("设置可覆盖", getSetting(db, "review_dir") === "/a/b");
const bak = path.join(tmp, "bak.db");
await backupTo(db, bak);
t("备份文件生成", fs.existsSync(bak) && fs.statSync(bak).size > 100000, fs.existsSync(bak) ? fs.statSync(bak).size + " 字节" : "没生成");


console.log("\n[10] 书库文件夹");
/* 一个书库就是一个自给自足的文件夹，换机器整个拷走 */
const srcLib = fs.existsSync(path.join(root, "我的书库", "library.db"))
  ? path.join(root, "我的书库")
  : path.dirname(file);
const libPaths = ensureStructure(path.join(root, "data", "_lib_test"));
t(
  "空目录补齐 covers/reviews/backups",
  ["covers", "reviews", "backups"].every((d) => fs.existsSync(path.join(libPaths.root, d)))
);
t("写了标识文件", fs.existsSync(libPaths.markFile));
const mark = fs.existsSync(libPaths.markFile) ? JSON.parse(fs.readFileSync(libPaths.markFile, "utf8")) : {};
t("标识写明是书库", mark.kind === "booklib-library" && mark.version === 1, JSON.stringify(mark));
t("没有 library.db 不算书库", isLibrary(libPaths.root) === false);
t("装着库的目录算书库", isLibrary(srcLib) === true);

const copyOut = path.join(root, "data", "_lib_copy");
const cp = copyLibrary(srcLib, copyOut);
t("整库复制成功", cp.ok === true, cp.msg || "");
t("副本里有库", fs.existsSync(path.join(copyOut, "library.db")));
t(
  "副本里有封面",
  fs.existsSync(path.join(copyOut, "covers")) && fs.readdirSync(path.join(copyOut, "covers")).length > 100,
  fs.existsSync(path.join(copyOut, "covers")) ? fs.readdirSync(path.join(copyOut, "covers")).length + " 张" : "无"
);
t(
  "副本里有书评 md",
  fs.existsSync(path.join(copyOut, "reviews")) && fs.readdirSync(path.join(copyOut, "reviews")).length > 50,
  fs.existsSync(path.join(copyOut, "reviews")) ? fs.readdirSync(path.join(copyOut, "reviews")).length + " 篇" : "无"
);
t("备份目录不跟着走", !fs.existsSync(path.join(copyOut, "backups")));
t("不能复制到自己里面", copyLibrary(srcLib, path.join(srcLib, "sub")).ok === false);
t("副本自己也是一个正经书库", isLibrary(copyOut) === true);

console.log("\n[11] 批量创建副本");
const two = listBooks(db, { limit: 2, sorts: [{ key: "title", dir: 1 }] }).rows;
const made = copyBooks(db, two.map((b) => b.id));
t("一次复制两本", made.length === 2, "实得 " + made.length);
t("副本标题顺延", made[0] && made[0].title !== two[0].title && /（\d）$/.test(made[0].title), made[0] ? made[0].title : "");
t("副本是本地条目", made.every((b) => b.id.startsWith("local-")), made.map((b) => b.id).join(","));
t("副本在库里能查到", listBooks(db, { q: made[1].title, limit: 5 }).rows.some((b) => b.id === made[1].id));
for (const b of made) db.prepare("DELETE FROM books WHERE id = ?").run(b.id);
t("清理后库里没有副本", made.every((b) => !db.prepare("SELECT id FROM books WHERE id = ?").get(b.id)));


console.log("\n[12] 手动匹配时文件是改名，不是复制一份");
/* 未匹配表的 id 与书评表各自从 1 起，只按 id 查会挂错另一篇；
   文件这边必须是一次 rename，不是删掉旧文件再写一份新的 */
const rdir = path.join(root, "data", "_rvdir");
fs.mkdirSync(rdir, { recursive: true });
for (const f of fs.readdirSync(rdir)) {
  try {
    fs.unlinkSync(path.join(rdir, f));
  } catch {
    /* 忽略 */
  }
}
db.prepare("DELETE FROM settings WHERE key = 'review_files'").run();
io.exportAll(db, rdir);
const mds = () => fs.readdirSync(rdir).filter((f) => /\.md$/i.test(f));
const inode = (f) => {
  try {
    return fs.statSync(path.join(rdir, f)).ino;
  } catch {
    return 0;
  }
};
const cnt0 = mds().length;

/* a 未匹配 → 系列 */
const o1 = db.prepare("SELECT id, title_guess FROM orphan_reviews WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get();
const sameIdRow = db.prepare("SELECT id, book_id, series_id FROM reviews WHERE id = ? AND deleted_at IS NULL").get(o1.id);
const f1 = rv.reviewFileName(db, { kind: "orphan", id: o1.id });
const ino1 = inode(f1);
const serA = db
  .prepare("SELECT s.id FROM series s WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.series_id=s.id AND r.deleted_at IS NULL) LIMIT 1")
  .get();
const rr1 = rv.associateOrphanToSeries(db, o1.id, serA.id);
t("未匹配能挂成系列总评", rr1.ok === true, rr1.msg || "");
const f1new = rv.reviewFileName(db, { kind: "series", id: rr1.id });
const keep1 = io.dropMapping(db, "orphan", o1.id);
io.writeOne(db, rdir, "series", rr1.id, keep1);
t("旧名字收走", !fs.existsSync(path.join(rdir, f1)), f1);
t("新名字就位", fs.existsSync(path.join(rdir, f1new)), f1new);
t("目录里没多出文件", mds().length === cnt0, cnt0 + " → " + mds().length);
t("是一次重命名", inode(f1new) === ino1, ino1 + " → " + inode(f1new));
if (sameIdRow) {
  const nowRow = db.prepare("SELECT book_id, series_id FROM reviews WHERE id = ?").get(sameIdRow.id);
  t(
    "同号的另一篇书评没被误搬",
    nowRow && nowRow.book_id === sameIdRow.book_id && nowRow.series_id === sameIdRow.series_id,
    JSON.stringify(nowRow)
  );
}
io.forgetFile(db, rdir, "series", rr1.id);
io.forgetFile(db, rdir, "series", rr1.id);
db.prepare("DELETE FROM reviews WHERE id = ?").run(rr1.id);
db.prepare("DELETE FROM orphan_reviews WHERE id = ?").run(o1.id);

/* b 书评换绑到系列 */
const rv2 = db.prepare("SELECT id FROM reviews WHERE book_id IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1").get();
const f2 = rv.reviewFileName(db, { kind: "book", id: rv2.id });
const ino2 = inode(f2);
const ser2 = db
  .prepare("SELECT s.id FROM series s WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.series_id=s.id AND r.deleted_at IS NULL) LIMIT 1")
  .get();
const oldBook2 = db.prepare("SELECT book_id FROM reviews WHERE id = ?").get(rv2.id).book_id;
const rr2 = rv.moveReviewToSeries(db, rv2.id, ser2.id);
const f2new = rv.reviewFileName(db, { kind: "series", id: rv2.id });
const keep2 = io.dropMapping(db, "book", rv2.id);
io.writeOne(db, rdir, "series", rv2.id, keep2);
t("换绑到系列成功", rr2.ok === true, rr2.msg || "");
t("旧名收走", !fs.existsSync(path.join(rdir, f2)), f2);
t("新名是系列名", /系列\.md$/.test(f2new), f2new);
t("是一次重命名", inode(f2new) === ino2, ino2 + " → " + inode(f2new));
db.prepare("UPDATE reviews SET book_id = ?, series_id = NULL WHERE id = ?").run(oldBook2, rv2.id);

/* c 改书名，文件名跟着改 */
const rv3 = db
  .prepare("SELECT r.id, r.book_id FROM reviews r WHERE r.book_id IS NOT NULL AND r.deleted_at IS NULL ORDER BY r.id LIMIT 1 OFFSET 3")
  .get();
const title3 = db.prepare("SELECT title FROM books WHERE id = ?").get(rv3.book_id).title;
const f3 = rv.reviewFileName(db, { kind: "book", id: rv3.id });
const ino3 = inode(f3);
updateBook(db, rv3.book_id, { title: title3 + "（改名测试）" });
io.writeOne(db, rdir, "book", rv3.id);
const f3new = rv.reviewFileName(db, { kind: "book", id: rv3.id });
t("文件名跟着书名变", f3new.includes("改名测试"), f3new);
t("旧名收走", !fs.existsSync(path.join(rdir, f3)), f3);
t("是一次重命名", inode(f3new) === ino3, ino3 + " → " + inode(f3new));
updateBook(db, rv3.book_id, { title: title3 });

/* 收尾：清掉临时目录与这轮的改动 */
fs.rmSync(tmp, { recursive: true, force: true });
db.prepare("DELETE FROM reviews WHERE series_id = ?").run(top.id);
db.prepare("DELETE FROM reviews WHERE book_id = (SELECT id FROM books WHERE title = ?)").run(free.title);
db.prepare("DELETE FROM orphan_reviews WHERE title_guess IN ('根本没有这本书', '又一本不存在的书')").run();
db.close();

console.log("\n通过 " + ok + " 条，失败 " + bad + " 条");
process.exit(bad ? 1 : 0);
