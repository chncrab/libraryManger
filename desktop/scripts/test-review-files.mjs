import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { openDb, closeDb } = require("../dist-electron/electron/db/index.js");
const { listReviews } = require("../dist-electron/electron/services/reviewService.js");
const { reconcileReviewFiles } = require("../dist-electron/electron/services/reviewFiles.js");
const { ReviewRuntime } = require("../dist-electron/electron/services/reviewRuntime.js");
const {
  createFileReview,
  moveFileReview,
  preserveLegacyReviewGrades,
  readIndexedReview,
  refreshLinkedReviewFront,
  updateFileReview
} = require("../dist-electron/electron/services/reviewFileEdits.js");
const {
  autoBackupWithReviews,
  backupReviewLibrary,
  isReviewSnapshot,
  listReviewBackups,
  restoreReviewLibrary
} = require("../dist-electron/electron/services/reviewBackup.js");
const { bulkEditReviewFiles, importFileReviews, exportFileReviews } = require("../dist-electron/electron/services/reviewFileTools.js");

async function withLibrary(run) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "booklib-file-test-"));
  assert.equal(path.dirname(root), parent);
  assert.match(path.basename(root), /^booklib-file-test-/);
  const dir = path.join(root, "reviews");
  const dbFile = path.join(root, "library.db");
  const recovery = path.join(root, "recovery");
  fs.mkdirSync(dir);
  const db = openDb(dbFile);
  try {
    const insert = db.prepare("INSERT INTO books (id, title, created_at, updated_at) VALUES (?, ?, '2026-01-01', '2026-01-01')");
    insert.run("book-a", "月光");
    insert.run("book-b", "雨天");
    insert.run("book-c", "同名");
    insert.run("book-d", "同名");
    db.prepare("INSERT INTO authors (id, name) VALUES (1, '甲'), (2, '乙')").run();
    db.prepare("INSERT INTO book_authors (book_id, author_id) VALUES ('book-c', 1), ('book-d', 2)").run();
    db.prepare("INSERT INTO series (id, name, zh_name) VALUES (1, 'Example series', '示例系列')").run();
    await run({ db, dbFile, root, dir, recovery });
  } finally {
    closeDb();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const front = (k, v, md) => `---\n${k}: ${v}\n---\n\n${md}`;

test("文件移出、移回和清空；数据库从不补写正文", () =>
  withLibrary(({ db, dir, root }) => {
    const name = "完全自定义.md";
    const text = front("书籍", "月光", "外部正文");
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    reconcileReviewFiles(db, dir);
    const [r] = listReviews(db);
    assert.equal(r.bookId, "book-a");
    assert.equal(r.fileName, name);
    assert.equal(r.md, "");
    assert.equal(readIndexedReview(db, dir, r.kind, r.id).raw, text);
    const unchanged = reconcileReviewFiles(db, dir);
    assert.equal(unchanged.updated + unchanged.added, 0);
    assert.equal(listReviews(db)[0].id, r.id);

    const outside = path.join(root, name);
    fs.renameSync(p, outside);
    reconcileReviewFiles(db, dir);
    assert.deepEqual(listReviews(db), []);
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.renameSync(outside, p);
    reconcileReviewFiles(db, dir);
    assert.equal(listReviews(db)[0].bookId, "book-a");
    fs.unlinkSync(p);
    reconcileReviewFiles(db, dir);
    assert.deepEqual(listReviews(db), []);
  }));

test("标签优先，同名书目歧义；无目录保留旧索引", () =>
  withLibrary(({ db, dir, root }) => {
    fs.writeFileSync(path.join(dir, "《雨天》书评.md"), front("书籍", "月光", "以首部为准"));
    fs.writeFileSync(path.join(dir, "任意系列.md"), front("系列", "示例系列", "系列正文"));
    fs.writeFileSync(path.join(dir, "《同名》书评.md"), "同名歧义");
    fs.writeFileSync(path.join(dir, "乙-《同名》书评.md"), "作者匹配");
    reconcileReviewFiles(db, dir);
    const reviews = listReviews(db);
    assert.equal(reviews.find((r) => r.fileName === "《雨天》书评.md").bookId, "book-a");
    assert.equal(reviews.find((r) => r.fileName === "任意系列.md").seriesId, 1);
    assert.equal(reviews.find((r) => r.fileName === "未匹配-《同名》书评.md").kind, "orphan");
    assert.equal(reviews.find((r) => r.fileName === "乙-《同名》书评.md").bookId, "book-d");
    const movedDir = path.join(root, "gone");
    fs.renameSync(dir, movedDir);
    assert.throws(() => reconcileReviewFiles(db, dir));
    assert.equal(listReviews(db).length, reviews.length);
  }));

test("系列书评批量改名使用完整译名，保留正文、其他标签和其他文件", () =>
  withLibrary(({ db, dir, root }) => {
    db.prepare("UPDATE books SET series_id = 1 WHERE id = 'book-c'").run();
    db.prepare("INSERT INTO series (id, name, zh_name) VALUES (2, 'Untranslated', '')").run();
    const old = "甲-《Example》系列.md";
    const target = "甲-《示例系列》系列书评.md";
    const source = path.join(dir, old);
    const destination = path.join(dir, target);
    const raw = "\uFEFF---\r\n系列: Example series\r\n作者: 甲\r\n自定义: 保留\r\n---\r\n\r\n正文\r\n";
    fs.writeFileSync(source, raw);
    const unchanged = [
      ["月光.md", front("书籍", "月光", "单册正文")],
      ["随手记录.md", "未关联正文"],
      ["《Untranslated》系列.md", front("系列", "Untranslated", "未翻译系列正文")]
    ];
    for (const [name, body] of unchanged) fs.writeFileSync(path.join(dir, name), body);
    reconcileReviewFiles(db, dir, false);
    const before = listReviews(db).find((row) => row.seriesId === 1);

    fs.mkdirSync(destination);
    assert.equal(bulkEditReviewFiles(db, dir, path.join(root, "backups"), "renameSeries").renamed, 0);
    assert.equal(fs.readFileSync(source, "utf8"), raw);
    fs.rmdirSync(destination);

    assert.equal(bulkEditReviewFiles(db, dir, path.join(root, "backups"), "renameSeries").renamed, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, "utf8"), raw.replace("Example series", "示例系列"));
    for (const [name, body] of unchanged) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), body);
    const after = listReviews(db).find((row) => row.seriesId === 1);
    assert.deepEqual([after.id, after.seriesId, after.fileName], [before.id, 1, target]);
  }));

test("重复归属时保留原文，标签唯一胜出，同级并列不猜测", () =>
  withLibrary(({ db, dir }) => {
    const a = "有标签.md";
    const b = "月光.md";
    const c = "另一标签.md";
    fs.writeFileSync(path.join(dir, a), front("书籍", "月光", "A"));
    fs.writeFileSync(path.join(dir, b), "B");
    const first = reconcileReviewFiles(db, dir);
    assert.ok(first.msgs.length);
    assert.equal(listReviews(db).find((r) => r.bookId === "book-a").fileName, a);
    const bOrphan = path.join(dir, "未匹配-" + b);
    assert.equal(fs.readFileSync(bOrphan, "utf8"), "B");
    fs.writeFileSync(path.join(dir, c), front("书籍", "月光", "C"));
    reconcileReviewFiles(db, dir);
    assert.ok(listReviews(db).every((r) => r.kind === "orphan"));
    assert.equal(listReviews(db).length, 3);
    fs.unlinkSync(path.join(dir, "未匹配-" + c));
    reconcileReviewFiles(db, dir);
    assert.equal(listReviews(db).find((r) => r.bookId === "book-a").fileName, a);
    assert.equal(fs.readFileSync(bOrphan, "utf8"), "B");
  }));

test("草稿、非数字书目 ID、改绑和改名", () =>
  withLibrary(({ db, dir, recovery }) => {
    const draft = createFileReview(db, dir, { name: "例子", md: "草稿" });
    assert.ok(draft.ok, draft.msg);
    assert.equal(draft.kind, "draft");
    const moved = moveFileReview(db, dir, recovery, "draft", draft.id, { bookId: "book-a" });
    assert.ok(moved.ok, moved.msg);
    const r = readIndexedReview(db, dir, "book", moved.id);
    assert.equal(r.bookId, "book-a");
    assert.equal(r.md, "草稿");
    const renamed = updateFileReview(db, dir, recovery, "book", r.id, {
      fileName: "新名字.md",
      expectedFileName: r.fileName,
      expectedVersion: r.version
    });
    assert.ok(renamed.ok, renamed.msg);
    assert.equal(renamed.fileName, "新名字.md");
    assert.equal(readIndexedReview(db, dir, "book", renamed.id).md, "草稿");
    assert.equal(fs.existsSync(path.join(dir, r.fileName)), false);
  }));

test("保存保留 BOM、CRLF 与自定义首部；冲突或移出保留恢复稿", () =>
  withLibrary(({ db, dir, root, recovery }) => {
    const header = "\uFEFF---\r\n书籍: 月光\r\ncustom: [x, y]\r\n---\r\n\r\n";
    const fileName = "外部名字.md";
    const p = path.join(dir, fileName);
    fs.writeFileSync(p, header + "旧正文");
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    const base = readIndexedReview(db, dir, row.kind, row.id);
    const save = (version, md) => updateFileReview(db, dir, recovery, row.kind, row.id, {
      md, expectedVersion: version, expectedFileName: fileName
    });
    const first = save(base.version, "新正文");
    assert.ok(first.ok, first.msg);
    assert.equal(fs.readFileSync(p, "utf8"), header + "新正文");

    fs.writeFileSync(p, header + "外部改动");
    const conflict = save(first.version, "未保存的内容");
    assert.equal(conflict.ok, false);
    assert.ok(conflict.recoveryPath, conflict.msg);
    assert.equal(fs.readFileSync(p, "utf8"), header + "外部改动");
    assert.match(fs.readFileSync(conflict.recoveryPath, "utf8"), /未保存的内容/);

    fs.renameSync(p, path.join(root, fileName));
    reconcileReviewFiles(db, dir);
    const missing = save(first.version, "移出时还在编辑");
    assert.equal(missing.ok, false);
    assert.ok(missing.recoveryPath, missing.msg);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(fs.readFileSync(missing.recoveryPath, "utf8"), /移出时还在编辑/);
  }));

test("自动保存合并连续输入，立即保存不等待定时器", () =>
  withLibrary(async ({ db, dir, recovery }) => {
    const name = "月光.md";
    const file = path.join(dir, name);
    fs.writeFileSync(file, "初始正文");
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    let base = readIndexedReview(db, dir, row.kind, row.id);
    const notices = [];
    const runtime = new ReviewRuntime(() => ({ db, dir, recoveryDir: recovery }), (_kind, _id, result) => {
      notices.push(result);
    });
    const stage = (md, editRevision, immediate = false) => runtime.stage(row.kind, row.id, {
      md, editRevision, expectedFileName: name, expectedVersion: base.version
    }, immediate);

    assert.ok(stage("前一笔", 1).ok);
    await delay(200);
    assert.ok(stage("最后一笔", 2).ok);
    await delay(500);
    assert.equal(fs.readFileSync(file, "utf8"), "初始正文");
    await delay(1750);
    assert.equal(fs.readFileSync(file, "utf8"), "最后一笔");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].editRevision, 2);

    base = readIndexedReview(db, dir, row.kind, row.id);
    assert.ok(stage("待写入正文", 3).ok);
    const saved = stage("立即保存", 4, true);
    assert.ok(saved.ok && saved.version);
    assert.equal(saved.editRevision, 4);
    assert.equal(fs.readFileSync(file, "utf8"), "立即保存");
  }));

test("标签校验失败后仍能保存原先待写入的正文", () =>
  withLibrary(({ db, dir, recovery }) => {
    const row = createFileReview(db, dir, { name: "合成草稿", md: "初始正文" });
    assert.ok(row.ok);
    const runtime = new ReviewRuntime(() => ({ db, dir, recoveryDir: recovery }), () => {});
    const patch = { md: "待写入正文", expectedFileName: row.fileName, expectedVersion: row.version };
    assert.ok(runtime.stage(row.kind, row.id, { ...patch, editRevision: 1 }).ok);
    const invalid = runtime.stage(row.kind, row.id, {
      ...patch, editRevision: 2, frontmatter: [{ key: "tags", value: "首行\n---" }]
    }, true);
    assert.equal(invalid.ok, false);
    assert.equal(readIndexedReview(db, dir, row.kind, row.id).md, "初始正文");
    assert.ok(runtime.flushAll().ok);
    assert.equal(readIndexedReview(db, dir, row.kind, row.id).md, "待写入正文");
  }));

test("迁移保留仍在目录中的旧等级，离开的正文只留在迁移备份", () =>
  withLibrary(async ({ db, dir, root }) => {
    const legacy = db.prepare("INSERT INTO reviews (book_id, md, grade, file_name, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')");
    legacy.run("book-a", "旧数据库正文", "god", "月光.md");
    legacy.run("book-b", "已移出的旧正文", "normal", "雨天.md");
    fs.writeFileSync(path.join(dir, "月光.md"), "磁盘原文");
    const snap = await backupReviewLibrary(db, dir, path.join(root, "backups"), "migration");
    assert.ok(isReviewSnapshot(snap));
    preserveLegacyReviewGrades(db, dir);
    reconcileReviewFiles(db, dir);
    const [r] = listReviews(db);
    assert.equal(r.grade, "god");
    assert.equal(readIndexedReview(db, dir, r.kind, r.id).md, "磁盘原文");
    assert.deepEqual(fs.readdirSync(dir), ["月光.md"]);
  }));

test("快照保留原文件名与字节，恢复同时替换数据库与书评", () =>
  withLibrary(async ({ db, dbFile, dir, root }) => {
    const name = "磁盘书评.MD";
    const raw = "\uFEFF" + front("书籍", "月光", "备份以前的正文");
    const backups = path.join(root, "backups");
    fs.writeFileSync(path.join(dir, name), raw);
    reconcileReviewFiles(db, dir);
    const snapshot = await backupReviewLibrary(db, dir, backups);
    assert.ok(isReviewSnapshot(snapshot));
    assert.match(listReviewBackups(backups)[0].at, /^\d{4}-\d{2}-\d{2}T/);
    db.prepare("UPDATE books SET title = '备份之后的书名' WHERE id = 'book-a'").run();
    fs.unlinkSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, "快照以后.md"), "后来才出现");
    closeDb();
    restoreReviewLibrary(snapshot, dbFile, dir);
    assert.deepEqual(fs.readdirSync(dir), [name]);
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), raw);
    assert.equal(openDb(dbFile).prepare("SELECT title FROM books WHERE id = 'book-a'").get().title, "月光");
  }));

test("自动备份包含书评并轮换，保留迁移快照和旧单库备份", () =>
  withLibrary(async ({ db, dir, root }) => {
    const backups = path.join(root, "backups");
    const name = "磁盘书评.Md";
    const source = path.join(dir, name);
    const initial = front("书籍", "月光", "第一版");
    fs.writeFileSync(source, initial);
    const migration = await backupReviewLibrary(db, dir, backups, "migration");
    const legacy = path.join(backups, "旧备份.db");
    await db.backup(legacy);

    const oldest = await autoBackupWithReviews(db, dir, backups, 2);
    assert.ok(oldest && isReviewSnapshot(oldest));
    assert.equal(fs.readFileSync(path.join(path.dirname(oldest), "reviews", name), "utf8"), initial);
    const previous = await autoBackupWithReviews(db, dir, backups, 2);
    const latest = Buffer.from("\uFEFF---\r\n书籍: 月光\r\n---\r\n\r\n第二版");
    fs.writeFileSync(source, latest);
    const current = await autoBackupWithReviews(db, dir, backups, 2);
    assert.ok(previous && current && isReviewSnapshot(current));
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(current), "reviews", name)), latest);
    assert.deepEqual(new Set(listReviewBackups(backups).map(({ file }) => file)), new Set([previous, current, migration, legacy]));
    assert.equal(fs.existsSync(path.dirname(oldest)), false);
  }));

test("旧单数据库备份恢复时保留当前书评文件", () =>
  withLibrary(async ({ db, dbFile, dir, root }) => {
    const legacy = path.join(root, "旧备份.db");
    await db.backup(legacy);
    db.prepare("UPDATE books SET title = '后来改的书名' WHERE id = 'book-a'").run();
    const current = path.join(dir, "当前文档.md");
    const raw = front("书籍", "月光", "现有书评原文");
    fs.writeFileSync(current, raw);
    closeDb();
    restoreReviewLibrary(legacy, dbFile, dir);
    assert.equal(fs.readFileSync(current, "utf8"), raw);
    assert.equal(openDb(dbFile).prepare("SELECT title FROM books WHERE id = 'book-a'").get().title, "月光");
  }));

test("导入和导出保留实际文件名与完整字节", () =>
  withLibrary(({ db, dir, root }) => {
    const source = path.join(root, "Obsidian 文件.markdown");
    const name = "Obsidian 文件.md";
    const raw = Buffer.from("\uFEFF---\r\n书籍: 月光\r\ncustom: value\r\n---\r\n\r\n整篇书评");
    fs.writeFileSync(source, raw);
    const imported = importFileReviews(db, dir, [source]);
    assert.equal(imported.written, 1);
    assert.equal(listReviews(db)[0].fileName, name);
    assert.deepEqual(fs.readFileSync(source), raw);
    assert.deepEqual(fs.readFileSync(path.join(dir, name)), raw);
    const destination = path.join(root, "导出");
    assert.equal(exportFileReviews(db, dir, destination).written, 1);
    assert.deepEqual(fs.readFileSync(path.join(destination, name)), raw);
  }));

test("读取并编辑标签时保留正文、其他首部属性和原始换行", () =>
  withLibrary(({ db, dir, recovery }) => {
    const name = "标签样本.md";
    const file = path.join(dir, name);
    const raw = "\uFEFF---\r\n书籍: 月光\r\n评分: 7.5\r\n书评等级: god\r\n# 独立注释\r\ntags:\r\n  - 旧标签\r\n  - 保留\r\n摘要: |\r\n  自定义段落\r\n---\r\n\r\n原始正文\r\n评分: 正文中的普通文字\r\n";
    fs.writeFileSync(file, raw);
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    let disk = readIndexedReview(db, dir, row.kind, row.id);
    assert.ok(disk.frontmatter.some((item) => item.key === "tags" && item.value.includes("旧标签")));
    assert.ok(disk.frontmatter.some((item) => item.key === "摘要" && item.value.includes("自定义段落")));
    const save = (key, value) => updateFileReview(db, dir, recovery, row.kind, row.id, {
      frontmatter: [{ key, value }], expectedFileName: disk.fileName, expectedVersion: disk.version
    });
    const score = save("评分", "8.5");
    assert.ok(score.ok, score.msg);
    assert.equal(fs.readFileSync(file, "utf8"), raw.replace("评分: 7.5", "评分: 8.5"));
    assert.equal(listReviews(db)[0].grade, "god");

    disk = readIndexedReview(db, dir, row.kind, row.id);
    const tags = save("tags", "\n  - 新标签\n  - 保留");
    assert.ok(tags.ok, tags.msg);
    assert.equal(fs.readFileSync(file, "utf8"), raw.replace("评分: 7.5", "评分: 8.5").replace("  - 旧标签", "  - 新标签"));

    disk = readIndexedReview(db, dir, row.kind, row.id);
    const removed = save("tags", "");
    assert.ok(removed.ok, removed.msg);
    assert.equal(fs.readFileSync(file, "utf8"), raw.replace("评分: 7.5", "评分: 8.5").replace("tags:\r\n  - 旧标签\r\n  - 保留\r\n", ""));
  }));

test("新增标签可改变书评关联，外部改动时拒绝用旧版本保存", () =>
  withLibrary(({ db, dir, recovery }) => {
    const name = "未匹配-样本随笔.md";
    fs.writeFileSync(path.join(dir, name), "无首部正文\n");
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    const disk = readIndexedReview(db, dir, row.kind, row.id);
    assert.deepEqual(disk.frontmatter, []);
    const update = updateFileReview(db, dir, recovery, row.kind, row.id, {
      frontmatter: [{ key: "书籍", value: "月光" }], expectedFileName: disk.fileName, expectedVersion: disk.version
    });
    assert.ok(update.ok, update.msg);
    const linked = readIndexedReview(db, dir, update.kind, update.id);
    assert.equal(linked.bookId, "book-a");
    assert.equal(linked.md, "无首部正文\n");
    const file = path.join(dir, linked.fileName);
    const external = linked.raw.replace("无首部正文", "外部修改正文");
    fs.writeFileSync(file, external);
    const stale = updateFileReview(db, dir, recovery, linked.kind, linked.id, {
      frontmatter: [{ key: "分类", value: "旧版本改动" }], expectedFileName: linked.fileName, expectedVersion: linked.version
    });
    assert.ok(!stale.ok);
    assert.equal(fs.readFileSync(file, "utf8"), external);
  }));

test("旧合写首部只读展示为独立字段，编辑作者后写回独立的标签并匹配同名书", () =>
  withLibrary(({ db, dir, recovery }) => {
    const fileName = "旧合写书评.md";
    const file = path.join(dir, fileName);
    const raw = "\uFEFF---\r\n书籍: 甲-《同名》\r\ncustom: 保留\r\n---\r\n\r\n正文\r\n";
    fs.writeFileSync(file, raw);
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    const before = readIndexedReview(db, dir, row.kind, row.id);
    assert.equal(before.bookId, "book-c");
    const tags = new Map(before.frontmatter.map(({ key, value }) => [key, value]));
    assert.equal(tags.get("作者"), "甲");
    assert.equal(tags.get("书籍"), "同名");
    assert.equal(fs.readFileSync(file, "utf8"), raw);

    const result = updateFileReview(db, dir, recovery, row.kind, row.id, {
      frontmatter: [{ key: "作者", value: "乙" }],
      expectedFileName: before.fileName,
      expectedVersion: before.version
    });
    assert.ok(result.ok, result.msg);
    assert.equal(listReviews(db)[0].bookId, "book-d");
    const written = fs.readFileSync(file, "utf8");
    assert.ok(written.startsWith("\uFEFF---\r\n"));
    assert.ok(written.includes("书籍: 同名\r\n"));
    assert.ok(written.includes("作者: 乙\r\n"));
    assert.ok(written.includes("custom: 保留\r\n"));
    assert.ok(written.endsWith("---\r\n\r\n正文\r\n"));
    assert.deepEqual(fs.readdirSync(dir), [fileName]);
  }));

test("显式作者优先于旧组合值，新建双作者书评与改绑系列评都写独立字段", () =>
  withLibrary(({ db, dir, recovery }) => {
    const legacy = path.join(dir, "旧作者冲突.md");
    fs.writeFileSync(legacy, "---\n作者: 乙\n书籍: 甲-《同名》\n---\n\n旧正文");
    reconcileReviewFiles(db, dir);
    const [legacyRow] = listReviews(db);
    assert.equal(legacyRow.bookId, "book-d");
    const legacyDisk = readIndexedReview(db, dir, legacyRow.kind, legacyRow.id);
    const editLegacy = updateFileReview(db, dir, recovery, legacyRow.kind, legacyRow.id, {
      frontmatter: [{ key: "分类", value: "样本" }],
      expectedFileName: legacyDisk.fileName,
      expectedVersion: legacyDisk.version
    });
    assert.ok(editLegacy.ok, editLegacy.msg);
    assert.match(fs.readFileSync(legacy, "utf8"), /^书籍: 同名$/m);
    assert.match(fs.readFileSync(legacy, "utf8"), /^作者: 乙$/m);

    db.prepare("INSERT INTO book_authors (book_id, author_id, ord) VALUES ('book-c', 2, 1)").run();
    db.prepare("UPDATE books SET series_id = 1 WHERE id = 'book-c'").run();
    const created = createFileReview(db, dir, { bookId: "book-c", md: "新正文" });
    assert.ok(created.ok, created.msg);
    const book = readIndexedReview(db, dir, created.kind, created.id);
    assert.equal(book.bookId, "book-c");
    assert.match(book.raw, /^书籍: 同名$/m);
    assert.match(book.raw, /^作者: 甲、乙$/m);
    const moved = moveFileReview(db, dir, recovery, book.kind, book.id, { seriesId: 1 });
    assert.ok(moved.ok, moved.msg);
    const series = readIndexedReview(db, dir, moved.kind, moved.id);
    assert.equal(series.seriesId, 1);
    assert.equal(series.md, "新正文");
    assert.equal(series.fileName, book.fileName);
    assert.match(series.raw, /^系列: 示例系列$/m);
    assert.match(series.raw, /^作者: 甲$/m);
    assert.doesNotMatch(series.raw, /^书籍:/m);
  }));

test("书目作者更新可同步独立标签，保留书名和原文件名", () =>
  withLibrary(({ db, dir, recovery }) => {
    const name = "书目同步.md";
    const file = path.join(dir, name);
    fs.writeFileSync(file, "---\n书籍: 甲-《同名》\n---\n\n正文");
    reconcileReviewFiles(db, dir);
    db.prepare("UPDATE authors SET name = '甲改名' WHERE id = 1").run();
    refreshLinkedReviewFront(db, dir, recovery, { bookId: "book-c" }, ["作者"]);
    const updated = fs.readFileSync(file, "utf8");
    assert.match(updated, /^作者: 甲改名$/m);
    assert.match(updated, /^书籍: 同名$/m);
    reconcileReviewFiles(db, dir);
    assert.equal(listReviews(db)[0].bookId, "book-c");
  }));

test("独立标题和姓名中的标点按字面保留", () =>
  withLibrary(({ db, dir }) => {
    const title = "读《样本》札记";
    db.prepare("UPDATE books SET title = ? WHERE id = 'book-c'").run(title);
    db.prepare("UPDATE authors SET name = 'Doe, John' WHERE id = 1").run();
    const fileName = "带标点的书评.md";
    fs.writeFileSync(path.join(dir, fileName), `---\n书籍: ${title}\n作者: Doe, John\n---\n\n正文`);
    reconcileReviewFiles(db, dir);
    const [row] = listReviews(db);
    const disk = readIndexedReview(db, dir, row.kind, row.id);
    assert.equal(disk.bookId, "book-c");
    assert.equal(disk.frontmatter.find((field) => field.key === "书籍").value, title);
    assert.equal(disk.frontmatter.find((field) => field.key === "作者").value, "Doe, John");
  }));
