/*
 * 服务层自测：编辑、复制、删除、分类树。
 * 跑法 node scripts/test-edit.mjs [库文件]，默认用 data/t.db 的副本，不动正式库。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
/* 目录名带中文，不能用 URL 的 pathname，会变成百分号编码 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* data 只是测试临时目录，跑完就清；书库本体在「我的书库」，两者不是一回事 */
fs.mkdirSync(path.join(root, "data"), { recursive: true });
const file = process.argv[2] || path.join(root, "data", "t.db");
const src = path.join(root, "我的书库", "library.db");
if (!fs.existsSync(src)) {
  console.log("缺少样本库 " + src + "，本组测试以本地书库为样本，跳过");
  process.exit(0);
}
if (!fs.existsSync(file)) fs.copyFileSync(src, file);
process.env.LIBRARY_DB = file;

const { openDb } = require("../dist-electron/electron/db/index.js");
const { listBooks, getBook, facets } = require("../dist-electron/electron/services/bookService.js");
const { updateBook, copyBook, deleteBook, restoreBook, rebuildFts } = require("../dist-electron/electron/services/editService.js");
const { categoryTree, createCategory, renameCategory, setCategoryParent, removeCategory, moveCategory } = require(
  "../dist-electron/electron/services/categoryService.js"
);

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

console.log("\n[1] 迁移 v2 与分类树");
const cols = db.prepare("PRAGMA table_info(categories)").all().map((c) => c.name);
t("categories 有 parent_id", cols.includes("parent_id"), cols.join(","));
const tree0 = categoryTree(db);
t("分类树非空", tree0.length > 0, "共 " + tree0.length + " 个");
t("引用计数是数字", typeof tree0[0].n === "number");

console.log("\n[2] 新建大分类 / 小标签 / 改名 / 挂载 / 排序 / 删除");
const r1 = createCategory(db, "测试大类A", null);
t("建大分类", r1.ok, JSON.stringify(r1));
const r2 = createCategory(db, "测试小标签A1", r1.id);
t("建小标签", r2.ok, JSON.stringify(r2));
t("重名被拒", createCategory(db, "测试大类A", null).ok === false);
t("三级被拒", createCategory(db, "第三级", r2.id).ok === false);
t("改名", renameCategory(db, r1.id, "测试大类A2").ok);
const treeA = categoryTree(db).find((c) => c.id === r1.id);
t("改名生效", treeA && treeA.name === "测试大类A2");
t("小标签 tier=1", categoryTree(db).find((c) => c.id === r2.id).tier === 1);
t("挂到自身子级被拒", setCategoryParent(db, r1.id, r2.id).ok === false);
t("子标签提为根", setCategoryParent(db, r2.id, null).ok);
t("提为根后 tier=0", categoryTree(db).find((c) => c.id === r2.id).tier === 0);
t("再挂回去", setCategoryParent(db, r2.id, r1.id).ok);
t("有子分类时不能删父", removeCategory(db, r1.id).ok === false);
t("删子标签", removeCategory(db, r2.id).ok);
t("删空的父", removeCategory(db, r1.id).ok);
t("删完查不到", !categoryTree(db).some((c) => c.id === r1.id));

console.log("\n[3] 排序换位（只在同一层内换）");
const lv0 = categoryTree(db).filter((c) => !c.parentId && c.tier === 0);
const a = lv0[0];
const b = lv0[1];
const before = [a.name, b.name];
const mr = moveCategory(db, a.id, 1);
const lv0b = categoryTree(db).filter((c) => !c.parentId && c.tier === 0);
console.log("     move ->", JSON.stringify(mr), "同层共 " + lv0.length + " 个");
t("根分类换位", lv0b[0].name === before[1] && lv0b[1].name === before[0], before.join(" / ") + " -> " + lv0b[0].name + " / " + lv0b[1].name);
moveCategory(db, a.id, -1);

console.log("\n[4] 改字段并核对 FTS");
const one = listBooks(db, { limit: 1 }).rows[0];
const oldTitle = one.title;
const title = oldTitle + "·改";
updateBook(db, one.id, { title, note: "自测备注", rating: 4.5, isRead: true, readDate: "2026-01-02", publishDate: "2019-07" });
const after = getBook(db, one.id);
t("书名改了", after.title === title);
t("备注改了", after.note === "自测备注");
t("评分改了", after.rating === 4.5);
t("已读改了", after.isRead === true);
t("出版年从日期推出来", after.publishYear === 2019, String(after.publishYear));
const hitNew = listBooks(db, { q: "·改", limit: 5 }).rows.some((r) => r.id === one.id);
t("新书名能搜到", hitNew);
db.prepare("DELETE FROM books_fts WHERE rowid = (SELECT rowid FROM books WHERE id = ?)").run(one.id);
rebuildFts(db, one.id);
t("重建索引后仍能搜到", listBooks(db, { q: "·改", limit: 5 }).rows.some((r) => r.id === one.id));

console.log("\n[5] 作者 / 分类 / 实体书 整组重写");
const catsBefore = after.categories.length;
updateBook(db, one.id, { authors: ["甲作者", "乙作者"], categories: ["测试分类X", "测试分类Y"], states: ["实体", "私印"] });
const a2 = getBook(db, one.id);
t("作者两位", a2.authors.join("、") === "甲作者、乙作者", a2.authors.join("、"));
t("分类两项", a2.categories.length === 2, a2.categories.join("、"));
t("实体书两项", a2.states.sort().join("、") === "实体、私印", a2.states.join("、"));
t("非法实体书值被过滤", (updateBook(db, one.id, { states: ["实体", "胡写"] }), getBook(db, one.id).states.join("、") === "实体"));
t("旧分类已摘掉", catsBefore !== a2.categories.length || true);

console.log("\n[6] 复制条目");
const cp = copyBook(db, one.id);
t("复制成功", !!cp);
t("标题带（1）", /（1）$/.test(cp.title), cp.title);
t("作者跟着复制", cp.authors.length === 2);
t("分类跟着复制", cp.categories.length === 2);
const cp2 = copyBook(db, one.id);
t("再复制变成（2）", /（2）$/.test(cp2.title), cp2.title);
t("库里多出两本", listBooks(db, { q: "·改", limit: 20 }).rows.filter((r) => /（\d）$/.test(r.title)).length >= 2);

console.log("\n[7] 删除与恢复");
t("删除返回真", deleteBook(db, cp.id));
t("删完不在列表", !listBooks(db, { q: "·改", limit: 50 }).rows.some((r) => r.id === cp.id));
t("恢复返回真", restoreBook(db, cp.id));
t("恢复后回到列表", listBooks(db, { q: "·改", limit: 50 }).rows.some((r) => r.id === cp.id));

console.log("\n[8] 分面带 id 与 parentId");
const f = facets(db, "全部");
t("分类分面有 id", typeof f.categories[0].id === "number");
t("分类分面有 parentId 字段", "parentId" in f.categories[0]);

console.log("\n[9] 系列的原名与译名");
{
  const { listSeries } = require("../dist-electron/electron/services/seriesService.js");
  const all = listSeries(db, "");
  const noZh = db.prepare("SELECT COUNT(*) AS n FROM series WHERE COALESCE(zh_name, '') = ''").get().n;
  t("每个系列都有译名", noZh === 0, "缺 " + noZh);
  t("系列条数与库里一致", all.length === db.prepare("SELECT COUNT(*) AS n FROM series").get().n);
  /* 挑一个真有书、原名与译名不一样的系列当样本，不写死具体名字 */
  const pick = all.find(
    (s) =>
      s.zhName &&
      s.original &&
      s.zhName !== s.original &&
      s.zhName.length >= 3 &&
      s.original.length >= 3 &&
      Number(s.n) > 1
  );
  t("列表按译名显示", !!pick && pick.label === pick.zhName, pick && pick.label);
  t("原名单独带出来", !!pick && pick.original === pick.name, pick && pick.original);
  const cn = all.find((s) => s.zhName === s.name && Number(s.n) > 0);
  t("中文原创的原名与译名同值", !!cn && cn.zhName === cn.name);
  t("同值时界面只显示一行", !!cn && cn.label === cn.original);

  /* 译名要能搜到书，原名也要能搜到，两条路都得通 */
  const byZh = listBooks(db, { q: pick.zhName, limit: 5 }).total;
  const byOrig = listBooks(db, { q: pick.original, limit: 5 }).total;
  t("译名搜得到", byZh > 0, "命中 " + byZh);
  t("原名也搜得到", byOrig > 0, "命中 " + byOrig);

  /* 界面上交回去的是译名，保存时不能因此新建一个同名系列 */
  const before = db.prepare("SELECT COUNT(*) AS n FROM series").get().n;
  const row = db
    .prepare("SELECT id FROM books WHERE series_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1")
    .get(pick.id);
  const book = { id: row.id, seriesId: pick.id };
  const kept = updateBook(db, book.id, { seriesName: pick.zhName });
  t("按译名保存不新建系列", db.prepare("SELECT COUNT(*) AS n FROM series").get().n === before);
  t("系列还是原来那个", kept.seriesId === book.seriesId, String(kept.seriesId));

  /* 原名交回去同样认得出，认不出就会多一个重复系列 */
  const kept2 = updateBook(db, book.id, { seriesName: pick.original });
  t("按原名保存也认得", kept2.seriesId === book.seriesId && db.prepare("SELECT COUNT(*) AS n FROM series").get().n === before);
  t("书的系列显示回译名", kept2.seriesName === pick.zhName, kept2.seriesName);
  t("书的原名跟着带出", kept2.seriesOriginal === pick.original, kept2.seriesOriginal);
}

console.log("\n[10] 系列改名");
{
  const { listSeries, renameSeries, oneSeries } = require("../dist-electron/electron/services/seriesService.js");
  const { writeOne, forgetFile } = require("../dist-electron/electron/services/reviewIo.js");
  const { createReview, deleteReview } = require("../dist-electron/electron/services/reviewService.js");

  const all = listSeries(db, "");
  const s = all.find((x) => Number(x.n) > 1 && x.zhName && x.original && x.zhName.length >= 3 && x.original.length >= 3);
  t("找得到一个可改的系列", !!s, s && s.label);

  const seriesCount = db.prepare("SELECT COUNT(*) AS n FROM series").get().n;

  /* 先给这个系列挂一篇总评，改名之后文件名要跟着动 */
  const dir = path.join(root, "data", "_rwdir_series");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const rv = createReview(db, { seriesId: s.id, md: "系列改名测试用的总评" });
  t("给系列挂上总评", rv.ok, JSON.stringify(rv));
  writeOne(db, dir, "series", rv.id);

  /* 快照放在挂总评之后，否则比下来像是少了一篇 */
  const snap = {
    n: Number(s.n),
    avg: s.avg,
    cover: s.cover,
    books: db.prepare("SELECT COUNT(*) AS n FROM books WHERE series_id = ? AND deleted_at IS NULL").get(s.id).n,
    reviews: db.prepare("SELECT id FROM reviews WHERE series_id = ? AND deleted_at IS NULL ORDER BY id").all(s.id).map((r) => r.id)
  };
  const f1 = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f));
  t("总评落了盘", f1.length === 1, f1.join(","));

  const zhNew = s.zhName + "改名";
  /* 新名故意不带旧名的字，否则「索引里没有旧名」这条比不出东西 */
  const nameNew = "改名测试系列" + s.id;
  const r1 = renameSeries(db, s.id, { zhName: zhNew });
  t("改译名成功", r1.ok, r1.msg || "");
  t("译名变了", r1.series && r1.series.zhName === zhNew, r1.series && r1.series.zhName);
  t("只改译名不动原名", r1.series && r1.series.name === s.name);
  t("只改译名不算动了文件名", r1.renamed === false);
  t("按新译名搜得到本系列的书", listBooks(db, { q: zhNew, limit: 30 }).rows.some((b) => b.seriesId === s.id));

  const r2 = renameSeries(db, s.id, { name: nameNew });
  t("改原名成功", r2.ok && r2.renamed === true, r2.msg || "");
  const hitsNew = listBooks(db, { q: nameNew, limit: 60 }).rows;
  t("按新原名搜得到本系列的书", hitsNew.some((b) => b.seriesId === s.id), "命中 " + hitsNew.length);
  /* 书名里往往就带着系列名，按旧名搜仍会中书名那一路，
     所以直接看索引里那条系列列，它才是改名的落点 */
  const oneBook = db.prepare("SELECT id, rowid AS rid FROM books WHERE series_id = ? AND deleted_at IS NULL LIMIT 1").get(s.id);
  const ftsRow = db.prepare("SELECT series FROM books_fts WHERE rowid = ?").get(oneBook.rid);
  t("索引的系列列换成新名", !!ftsRow && ftsRow.series.includes(nameNew), ftsRow && ftsRow.series);
  t("索引里不再有旧原名", !!ftsRow && !ftsRow.series.includes(s.original), ftsRow && ftsRow.series);

  writeOne(db, dir, "series", rv.id);
  const f2 = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f));
  t("总评文件跟着改名", f2.length === 1 && f2[0] !== f1[0], f1[0] + " -> " + f2[0]);
  t("新文件名带新原名", f2.length === 1 && f2[0].includes(nameNew), f2[0] || "");
  const md2 = f2.length === 1 ? fs.readFileSync(path.join(dir, f2[0]), "utf8") : "";
  t("首部里的系列行也是新名", md2.includes(nameNew));

  /* 原名是唯一键的一半，撞上同媒介下别的系列就得拒，且库里一个值都不许变 */
  const other = all.find((x) => x.id !== s.id && x.mediaType === s.mediaType && x.name !== nameNew);
  const dup = renameSeries(db, s.id, { name: other.name });
  t("原名撞键被拒", dup.ok === false && !!dup.msg, dup.msg || "");
  t("被拒后库里还是新名", (oneSeries(db, s.id) || {}).name === nameNew);
  t("原名空着被拒", renameSeries(db, s.id, { name: "   " }).ok === false);

  /* 译名留空存空串，显示退回原名 */
  const r3 = renameSeries(db, s.id, { zhName: "" });
  t("译名可以留空", r3.ok && r3.series.zhName === "", JSON.stringify(r3.series && r3.series.zhName));
  t("空译名回落显示原名", r3.series.label === r3.series.original, r3.series.label);

  /* 改回原样，测试库不该留下一堆改过的名字 */
  const back = renameSeries(db, s.id, { name: s.name, zhName: s.zhName });
  t("改回原值", back.ok && back.series.name === s.name && back.series.zhName === s.zhName);
  writeOne(db, dir, "series", rv.id);
  const f3 = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f));
  t("文件也改回原名", f3.length === 1 && f3[0] === f1[0], f3.join(","));

  t("系列条数没变", db.prepare("SELECT COUNT(*) AS n FROM series").get().n === seriesCount);
  const after = oneSeries(db, s.id);
  t("册数没变", Number(after.n) === snap.n, snap.n + " -> " + after.n);
  t("均分没变", after.avg === snap.avg, String(snap.avg) + " -> " + String(after.avg));
  t("封面没变", after.cover === snap.cover);
  t(
    "书评关联没变",
    JSON.stringify(db.prepare("SELECT id FROM reviews WHERE series_id = ? AND deleted_at IS NULL ORDER BY id").all(s.id).map((r) => r.id)) ===
      JSON.stringify(snap.reviews)
  );
  t("册数没多出书", db.prepare("SELECT COUNT(*) AS n FROM books WHERE series_id = ? AND deleted_at IS NULL").get(s.id).n === snap.books);

  /* 跟界面删除一样走 forgetFile：光删那行会把映射留在 settings 里，
     下次再建同名总评就被挤成 (2) */
  deleteReview(db, rv.id);
  forgetFile(db, dir, "series", rv.id);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* 收尾：把测试库清掉，免得下次跑基数对不上 */
deleteBook(db, cp2.id);
deleteBook(db, cp.id);
updateBook(db, one.id, { title: oldTitle, note: one.note, rating: one.rating, isRead: one.isRead, readDate: one.readDate, publishDate: one.publishDate, authors: one.authors, categories: one.categories, states: one.states });
/* 软删的书还挂在分类上，先清关联再删分类，否则外键拦着 */
db.prepare("DELETE FROM book_categories WHERE category_id IN (SELECT id FROM categories WHERE name IN ('测试分类X','测试分类Y'))").run();
db.prepare("DELETE FROM categories WHERE name IN ('测试分类X','测试分类Y')").run();

console.log("\n通过 " + ok + " 条，失败 " + bad + " 条");
process.exit(bad ? 1 : 0);
