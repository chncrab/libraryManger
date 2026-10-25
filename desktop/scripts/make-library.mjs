/*
 * 把开发期的 data/ 搬成一个正式的书库文件夹。
 *
 *   node scripts/make-library.mjs [目标目录]
 *
 * 默认目标 desktop/我的书库。做完之后这个文件夹自带
 * library.db、covers/、reviews/ 与 backups/，软件直接指过去就能用。
 *
 * 只复制不搬走，原来的 data/ 原样留着，确认没问题再自己删。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] || path.join(root, "我的书库"));

const srcDb = path.join(root, "data", "library.db");
const srcCovers = path.join(root, "data", "covers");
if (!fs.existsSync(srcDb)) {
  console.error("找不到 " + srcDb + "，没什么可搬的");
  process.exit(1);
}

const { ensureStructure } = require("../dist-electron/electron/services/libraryService.js");
const { openDb } = require("../dist-electron/electron/db/index.js");
const { exportAll } = require("../dist-electron/electron/services/reviewIo.js");

const p = ensureStructure(target);
console.log("书库目录 " + p.root);

if (!fs.existsSync(p.dbFile)) {
  fs.copyFileSync(srcDb, p.dbFile);
  console.log("已复制 library.db " + Math.round(fs.statSync(p.dbFile).size / 1024) + " KB");
} else {
  console.log("目标位置已经有 library.db，不动它");
}

if (fs.existsSync(srcCovers)) {
  let n = 0;
  for (const name of fs.readdirSync(srcCovers)) {
    const dst = path.join(p.coverDir, name);
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(srcCovers, name), dst);
    n++;
  }
  console.log("已复制封面 " + n + " 张（目录里现有 " + fs.readdirSync(p.coverDir).length + " 张）");
}

const db = openDb(p.dbFile);
const out = exportAll(db, p.reviewDir);
console.log("已写出书评 md " + out.written + " 篇");
const books = db.prepare("SELECT COUNT(*) n FROM books WHERE deleted_at IS NULL").get().n;
const reviews = db.prepare("SELECT COUNT(*) n FROM reviews WHERE deleted_at IS NULL").get().n;
console.log(`库里 ${books} 本，书评 ${reviews} 篇`);
db.close();
console.log("\n完成。" + p.root);
