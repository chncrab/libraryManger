/**
 * 把封面文件改成「作者-作品名-系列序号.ext」，没序号的就是「作者-作品名.ext」。
 * DB 里的 cover_file 与 cover_history.orig_file 一并改，改的是真文件（rename），不重新生成图片。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/rename-covers.mjs [书库目录] [--dry]
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const libRoot = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(root, "我的书库"));
const dbFile = path.join(libRoot, "library.db");
const coversDir = path.join(libRoot, "covers");

if (!fs.existsSync(dbFile)) {
  console.error("找不到 " + dbFile);
  process.exit(1);
}
process.env.LIBRARY_DB = dbFile;

const { openDb } = require("../dist-electron/electron/db/index.js");
const { uniqueCoverName } = require("../dist-electron/electron/services/coverService.js");
const db = openDb(dbFile);

const rows = db
  .prepare(
    `SELECT b.id, b.cover_file AS f,
            (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
              WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
       FROM books b WHERE b.deleted_at IS NULL AND b.cover_file <> '' ORDER BY b.id`
  )
  .all();

console.log((dry ? "[试运行] " : "") + "书库 " + libRoot);
console.log("带封面的书 " + rows.length + " 本");

let renamed = 0;
let same = 0;
let missing = 0;
let failed = 0;

for (const r of rows) {
  const from = path.join(coversDir, path.basename(r.f));
  if (!fs.existsSync(from)) {
    missing++;
    continue;
  }
  const ext = (path.extname(r.f) || ".jpg").toLowerCase();
  /* 已经是这个名字就跳过；uniqueCoverName 会把别的书的占用算进去 */
  const want = uniqueCoverName(db, r.id, coversDir, ext);
  if (want === r.f) {
    same++;
    continue;
  }
  if (dry) {
    if (renamed < 12) console.log("  " + r.f + "  →  " + want);
    renamed++;
    continue;
  }
  const to = path.join(coversDir, want);
  try {
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  } catch (e) {
    failed++;
    console.error("  改名失败 " + r.f + " → " + want + "：" + (e instanceof Error ? e.message : e));
    continue;
  }
  db.prepare("UPDATE books SET cover_file = ? WHERE id = ?").run(want, r.id);
  db.prepare("UPDATE cover_history SET orig_file = ? WHERE book_id = ? AND orig_file = ?").run(want, r.id, r.f);
  renamed++;
}

console.log((dry ? "待改名 " : "已改名 ") + renamed + " 张，本来就对 " + same + " 张，源文件缺失 " + missing + " 张，失败 " + failed + " 张");

/* 抽查：库里记的名字在不在目录里 */
const bad = db
  .prepare("SELECT id, cover_file FROM books WHERE deleted_at IS NULL AND cover_file <> ''")
  .all()
  .filter((r) => !fs.existsSync(path.join(coversDir, path.basename(r.cover_file))));
console.log("库里指向但不存在的封面 " + bad.length + " 张");
for (const b of bad.slice(0, 10)) console.log("  缺 " + b.id + " " + b.cover_file);

const total = fs.readdirSync(coversDir).filter((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f)).length;
console.log("目录里图片共 " + total + " 张");
db.close();
