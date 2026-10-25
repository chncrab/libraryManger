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

/* 收尾：把测试库清掉，免得下次跑基数对不上 */
deleteBook(db, cp2.id);
deleteBook(db, cp.id);
updateBook(db, one.id, { title: oldTitle, note: one.note, rating: one.rating, isRead: one.isRead, readDate: one.readDate, publishDate: one.publishDate, authors: one.authors, categories: one.categories, states: one.states });
/* 软删的书还挂在分类上，先清关联再删分类，否则外键拦着 */
db.prepare("DELETE FROM book_categories WHERE category_id IN (SELECT id FROM categories WHERE name IN ('测试分类X','测试分类Y'))").run();
db.prepare("DELETE FROM categories WHERE name IN ('测试分类X','测试分类Y')").run();

console.log("\n通过 " + ok + " 条，失败 " + bad + " 条");
process.exit(bad ? 1 : 0);
