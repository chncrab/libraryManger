import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openDb, closeDb } from "./db";
import type { DB } from "./db";
import { listBooks, getBook, facets, seriesAvg, reviewOf } from "./services/bookService";
import { updateBook, deleteBook, restoreBook, copyBook, copyBooks, setRead, setRating } from "./services/editService";
import { categoryTree, createCategory, renameCategory, setCategoryParent, removeCategory, moveCategory } from "./services/categoryService";
import {
  listReviews,
  counts,
  createReview,
  updateReview,
  deleteReview,
  deleteOrphan,
  associateOrphan,
  associateOrphanToSeries,
  moveReview,
  moveReviewToSeries,
  moveReviewToBook,
  reviewFileName
} from "./services/reviewService";
import { listSeries, seriesBooks, seriesReviewOf } from "./services/seriesService";
import { setCoverFromFile, resetCover } from "./services/coverService";
import { getSetting, setSetting } from "./services/settingsService";
import { autoBackup, backupTo, listBackups } from "./services/backupService";
import {
  importReviewTexts,
  exportAll,
  syncDir,
  readMdDir,
  writeOne,
  forgetFile,
  dropMapping,
  normalizeNames
} from "./services/reviewIo";
import {
  pathsOf,
  ensureStructure,
  isLibrary,
  libraryEmpty,
  survey,
  readConfig,
  rememberRoot,
  pruneRecent,
  copyLibrary
} from "./services/libraryService";
import type { LibraryPaths } from "./services/libraryService";
import type { BookPatch, BookQuery, ReviewInput, ReviewPatch } from "../shared/types";

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";

/* 少数机器或远程桌面里 GPU 进程会崩，崩了窗口直接黑屏退出。
   加 --soft 启动参数或 BOOKLIB_SOFTWARE_GL=1 时走软件渲染 */
const SOFT_GL = process.argv.includes("--soft") || process.env.BOOKLIB_SOFTWARE_GL === "1";
if (SOFT_GL) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.log("[gpu] 软件渲染");
}

protocol.registerSchemesAsPrivileged([
  { scheme: "cover", privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

let win: BrowserWindow | null = null;

/* 书库可以没打开：第一次启动时用户还没选文件夹，界面先把选择页铺出来。
   打开之后 db 与 paths 一起就位，所有服务都靠这两个 */
let db: DB | null = null;
let lib: LibraryPaths | null = null;

const userData = () => app.getPath("userData");

/** 环境变量里指定了书库就直接开，省得每次开发都要点一遍 */
function rootFromEnv(): string {
  if (process.env.BOOKLIB_ROOT) return path.resolve(process.env.BOOKLIB_ROOT);
  /* 老脚本用 LIBRARY_DB 指到某个具体的库文件，兼容它 */
  if (process.env.LIBRARY_DB) return path.dirname(path.resolve(process.env.LIBRARY_DB));
  return "";
}

function requireDb(): DB {
  if (!db) throw new Error("还没有打开书库");
  return db;
}

function reviewDir(): string {
  return lib ? lib.reviewDir : "";
}

function coverDir(): string {
  return lib ? lib.coverDir : "";
}

/* ---- 打开与切换书库 ---- */

function openLibrary(root: string): { ok: boolean; msg?: string; root?: string; books: number } {
  const target = path.resolve(root);
  /* 换库时旧目录的监听先停，否则会拿着新库去同步旧路径 */
  stopWatch();
  const p = ensureStructure(target);
  /* 测试脚本会指定一个单独的 db 文件名，认这个覆盖 */
  if (process.env.LIBRARY_DB && path.dirname(path.resolve(process.env.LIBRARY_DB)) === target) {
    p.dbFile = path.resolve(process.env.LIBRARY_DB);
  }
  let conn: DB;
  try {
    closeDb();
    conn = openDb(p.dbFile);
  } catch (e) {
    db = null;
    return { ok: false, msg: "这个文件夹里的库打不开：" + (e instanceof Error ? e.message : String(e)), books: 0 };
  }
  db = conn;
  lib = p;
  rememberRoot(userData(), target);

  /* 老版本的「书评同步文件夹」是用户自己挑的。升级上来先把那边的 md 收进书库，
     之后再按书库自己的 reviews 走。清掉设置，下次不会再扫一遍 */
  const oldDir = getSetting(conn, "review_dir", "");
  if (oldDir && path.resolve(oldDir) !== path.resolve(p.reviewDir) && fs.existsSync(oldDir)) {
    const files = readMdDir(oldDir);
    if (files.length) {
      const got = importReviewTexts(conn, files, { dir: p.reviewDir });
      console.log(`[library] 从旧同步目录收进 ${got.added + got.updated + got.orphan} 篇书评`);
    }
    setSetting(conn, "review_dir", "");
  }

  /* 打开就把 reviews 目录对齐一次：外面的改动收进来，库里新的写出去 */
  runSync("open");
  startWatch();
  const n = counts(conn).books;
  autoBackup(conn, p.backupDir, 8).catch((e) => console.error("[backup] 失败", e));
  return { ok: true, root: p.root, books: n };
}

let watcher: fs.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let syncing = false;
let syncPending = false;

/**
 * 盯着 reviews 目录。在文件夹里改 md、拖进来新的一份，界面这边几秒内跟着变。
 * 自己写盘也会触发这个事件，靠 exportAll 的「内容没变就不写」把手脚收住，
 * 否则会变成写盘 → 事件 → 同步 → 再写盘的死循环。
 */
function startWatch(): void {
  stopWatch();
  if (!lib) return;
  try {
    watcher = fs.watch(lib.reviewDir, { persistent: false }, (_ev, file) => {
      if (file && !/\.md$/i.test(String(file))) return;
      scheduleSync("watch");
    });
  } catch (e) {
    console.error("[watch] 书评目录监听失败", e);
  }
}

function stopWatch(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 关不掉也不影响 */
    }
    watcher = null;
  }
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
}

function scheduleSync(why: string): void {
  if (syncing) {
    syncPending = true;
    return;
  }
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    runSync(why);
  }, 700);
}

function runSync(why: string): void {
  if (!db || !lib) return;
  syncing = true;
  try {
    const out = syncDir(db, lib.reviewDir);
    const changed = out.updated + out.added + out.orphan;
    if (changed) {
      console.log(`[sync:${why}] 收进改动 ${out.updated}，新增 ${out.added}，未匹配 ${out.orphan}`);
      win?.webContents.send("library:reviews-changed");
    }
  } catch (e) {
    console.error(`[sync:${why}] 失败`, e);
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      scheduleSync("pending");
    }
  }
}

/**
 * 书评写完、改绑、删除之后把文件跟上。
 * 改绑时不能先删旧文件再写新文件 —— 那等于重新生成一份，旧名字那份还可能在。
 * 正确做法是把旧名字摘下来交给 writeOne，由它做一次重命名。
 */
function pushReview(kind: string, id: number, forgetKind?: string): void {
  const dir = reviewDir();
  if (!dir || !db) return;
  const prev = forgetKind ? dropMapping(db, forgetKind, id) : "";
  writeOne(db, dir, kind, id, prev);
}

interface WinState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const winStateFile = () => path.join(userData(), "window.json");

function loadWinState(): WinState {
  const def: WinState = { width: 1480, height: 940 };
  try {
    const s = JSON.parse(fs.readFileSync(winStateFile(), "utf8")) as WinState;
    /* 换了显示器之后旧坐标可能落在屏幕外，宽高兜个底 */
    return {
      width: Math.max(1040, Math.min(s.width || def.width, 4000)),
      height: Math.max(640, Math.min(s.height || def.height, 3000)),
      x: typeof s.x === "number" ? s.x : undefined,
      y: typeof s.y === "number" ? s.y : undefined,
      maximized: !!s.maximized
    };
  } catch {
    return def;
  }
}

function saveWinState(w: BrowserWindow): void {
  try {
    const b = w.getNormalBounds();
    fs.mkdirSync(userData(), { recursive: true });
    fs.writeFileSync(winStateFile(), JSON.stringify({ ...b, maximized: w.isMaximized() }), "utf8");
  } catch {
    /* 记不住尺寸不影响使用 */
  }
}

function createWindow(): void {
  const st = loadWinState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: "#12100e",
    title: "藏书库",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (st.maximized) win.maximize();

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", () => {
    if (win) saveWinState(win);
  });
  win.on("closed", () => {
    win = null;
  });
}

const err = (e: unknown) => ({ ok: false, msg: e instanceof Error ? e.message : String(e) });

function registerIpc(): void {
  const D = requireDb;

  ipcMain.handle("app:info", () => {
    const base = {
      version: app.getVersion(),
      hasLibrary: !!db && !!lib,
      libraryRoot: lib?.root || "",
      dbFile: lib?.dbFile || "",
      reviewDir: lib?.reviewDir || ""
    };
    if (!db) return { ...base, books: 0, reviews: 0, orphans: 0, bookCount: 0, reviewCount: 0, orphanCount: 0 };
    const c = counts(db);
    return { ...base, ...c, bookCount: c.books, reviewCount: c.reviews, orphanCount: c.orphans };
  });

  /* ---- 书库本身 ---- */
  ipcMain.handle("library:info", () => {
    if (!lib) return { hasLibrary: false, root: "", recent: [], covers: 0, reviews: 0, books: 0 };
    const s = survey(lib.root);
    return {
      hasLibrary: true,
      root: lib.root,
      recent: [],
      covers: s.covers,
      reviews: s.reviews,
      books: db ? counts(db).books : 0
    };
  });
  ipcMain.handle("library:recent", () => {
    const c = pruneRecent(readConfig(userData()));
    return c.recent.map((r) => ({ root: r, ...survey(r) }));
  });
  /* 选一个文件夹当书库。里面有库就直接开，空的或不是库就问一句在原地新建 */
  ipcMain.handle("library:choose", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择书库文件夹",
      message: "书、封面、书评都存在这个文件夹里，换机器时整个搬走就行",
      buttonLabel: "用这个文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, msg: "没有选择文件夹" };
    const pick = r.filePaths[0];
    if (!isLibrary(pick)) {
      const sure = await dialog.showMessageBox(win!, {
        type: "question",
        buttons: ["取消", "在这里新建书库"],
        defaultId: 1,
        cancelId: 0,
        message: "这个文件夹里还没有书库",
        detail: libraryEmpty(pick)
          ? pick + "\n\n会在这里建一个空书库，之后加的书、封面、书评都装进这个文件夹。"
          : pick + "\n\n这个文件夹里已经有别的东西。新建书库会往里面加 library.db、covers、reviews 几个条目，原有文件不动。"
      });
      if (sure.response !== 1) return { ok: false, msg: "已取消" };
    }
    return openLibrary(pick);
  });
  ipcMain.handle("library:open", (_e, root: string) => {
    if (!root || !isLibrary(root)) return { ok: false, msg: "这个位置没有书库", books: 0 };
    return openLibrary(root);
  });
  /* 默认位置：文档目录下的「我的书库」，没有就建 */
  ipcMain.handle("library:default", () => {
    const target = path.join(app.getPath("documents"), "我的书库");
    return openLibrary(target);
  });
  ipcMain.handle("library:reveal", async () => {
    if (!lib) return false;
    await shell.openPath(lib.root);
    return true;
  });
  ipcMain.handle("library:copyTo", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "把书库复制到哪里",
      buttonLabel: "复制到这里",
      properties: ["openDirectory", "createDirectory"]
    });
    if (r.canceled || !r.filePaths[0] || !lib) return null;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const target = path.join(r.filePaths[0], "我的书库-" + stamp);
    try {
      return { ...copyLibrary(lib.root, target), dir: target };
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("books:list", (_e, q: BookQuery) => listBooks(D(), q || {}));
  ipcMain.handle("books:get", (_e, id: string) => {
    const book = getBook(D(), id);
    if (!book) return null;
    const review = reviewOf(D(), id);
    return { book, review };
  });
  ipcMain.handle("books:facets", (_e, media?: string) => facets(D(), media || ""));
  ipcMain.handle("series:avg", (_e, id: number) => seriesAvg(D(), id));
  ipcMain.handle("series:list", (_e, mediaType?: string) => listSeries(D(), mediaType || ""));
  ipcMain.handle("series:books", (_e, id: number) => seriesBooks(D(), id));
  ipcMain.handle("series:review", (_e, id: number) => seriesReviewOf(D(), id));
  ipcMain.handle("reviews:list", () => listReviews(D()));
  /* 单篇导出用同一个命名规则，界面别自己拼文件名，否则和落盘那份对不上 */
  ipcMain.handle("reviews:fileName", (_e, kind: string, id: number) => reviewFileName(D(), { kind, id }));
  ipcMain.handle("books:setRead", (_e, id: string, read: boolean) => setRead(D(), id, read));
  ipcMain.handle("books:setRating", (_e, id: string, rating: number | null) => setRating(D(), id, rating));
  ipcMain.handle("books:update", (_e, id: string, patch: BookPatch) => {
    const nb = updateBook(D(), id, patch || {}, coverDir());
    /* 改了书名或作者，已落盘的书评文件名要跟着改 */
    if (nb) {
      const rv = D().prepare("SELECT id FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(id) as any;
      if (rv) pushReview("book", rv.id);
    }
    return nb;
  });
  ipcMain.handle("books:delete", (_e, id: string) => deleteBook(D(), id));
  ipcMain.handle("books:restore", (_e, id: string) => restoreBook(D(), id));
  ipcMain.handle("books:copy", (_e, id: string) => copyBook(D(), id, coverDir()));
  ipcMain.handle("books:copyMany", (_e, ids: string[]) => copyBooks(D(), ids || [], coverDir()));
  ipcMain.handle("cats:tree", () => categoryTree(D()));
  ipcMain.handle("cats:create", (_e, name: string, parentId: number | null) => createCategory(D(), name, parentId ?? null));
  ipcMain.handle("cats:rename", (_e, id: number, name: string) => renameCategory(D(), id, name));
  ipcMain.handle("cats:parent", (_e, id: number, parentId: number | null) => setCategoryParent(D(), id, parentId ?? null));
  ipcMain.handle("cats:remove", (_e, id: number) => removeCategory(D(), id));
  ipcMain.handle("cats:move", (_e, id: number, dir: -1 | 1) => moveCategory(D(), id, dir));

  ipcMain.handle("reviews:create", (_e, p: ReviewInput) => {
    const r = createReview(D(), p || {});
    if (r.ok && r.id) pushReview(p.bookId ? "book" : p.seriesId ? "series" : "draft", r.id);
    return r;
  });
  ipcMain.handle("reviews:update", (_e, kind: string, id: number, p: ReviewPatch) => {
    const r = updateReview(D(), kind, id, p || {});
    if (!r.ok) return r;
    if (kind === "orphan") {
      writeOne(D(), reviewDir(), "orphan", id);
      return r;
    }
    const row = D().prepare("SELECT book_id, series_id FROM reviews WHERE id = ?").get(id) as any;
    if (row) pushReview(row.book_id ? "book" : row.series_id ? "series" : "draft", id);
    return r;
  });
  /* 未匹配书评存在另一张表里，id 与 reviews 各从 1 起，按 id 硬删会删到别的书评，
     所以 kind 必须由界面带上来 */
  ipcMain.handle("reviews:delete", (_e, kind: string, id: number) => {
    if (kind === "orphan") {
      const o = deleteOrphan(D(), id);
      if (o.ok) forgetFile(D(), reviewDir(), "orphan", id);
      return o;
    }
    const row = D().prepare("SELECT book_id, series_id FROM reviews WHERE id = ?").get(id) as any;
    const r = deleteReview(D(), id);
    if (r.ok && row) forgetFile(D(), reviewDir(), row.book_id ? "book" : row.series_id ? "series" : "draft", id);
    return r;
  });
  ipcMain.handle("reviews:associateOrphan", (_e, oid: number, bookId: string) => {
    const r = associateOrphan(D(), oid, bookId);
    if (r.ok && r.id) {
      const prev = dropMapping(D(), "orphan", oid);
      writeOne(D(), reviewDir(), "book", r.id, prev);
    }
    return r;
  });
  ipcMain.handle("reviews:move", (_e, kind: string, id: number, bookId: string) => {
    /* 未匹配那条的 id 与 reviews 的 id 各从 1 起，按 id 硬查会命中另一篇不相干的书评 */
    if (kind === "orphan") return { ok: false, msg: "未匹配书评请用「关联到书籍」" };
    const old = D().prepare("SELECT book_id, series_id FROM reviews WHERE id = ?").get(id) as any;
    const r = moveReview(D(), id, bookId);
    if (r.ok) pushReview("book", id, old?.series_id ? "series" : "book");
    return r;
  });
  ipcMain.handle("reviews:moveToSeries", (_e, kind: string, id: number, seriesId: number) => {
    if (kind === "orphan") {
      const r = associateOrphanToSeries(D(), id, seriesId);
      if (r.ok && r.id) {
        const prev = dropMapping(D(), "orphan", id);
        writeOne(D(), reviewDir(), "series", r.id, prev);
      }
      return r;
    }
    const old = D().prepare("SELECT series_id FROM reviews WHERE id = ?").get(id) as any;
    const r = moveReviewToSeries(D(), id, seriesId);
    if (r.ok) pushReview("series", id, old?.series_id ? "series" : "book");
    return r;
  });
  ipcMain.handle("reviews:moveToBook", (_e, kind: string, id: number, bookId: string) => {
    if (kind === "orphan") return { ok: false, msg: "未匹配书评请用「关联到书籍」" };
    const old = D().prepare("SELECT series_id FROM reviews WHERE id = ?").get(id) as any;
    const r = moveReviewToBook(D(), id, bookId);
    if (r.ok) pushReview("book", id, old?.series_id ? "series" : "book");
    return r;
  });

  ipcMain.handle("covers:pick", async (_e, bookId: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择封面图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }]
    });
    if (r.canceled || !r.filePaths[0] || !lib) return { ok: false, msg: "没有选择图片" };
    try {
      return setCoverFromFile(D(), bookId, r.filePaths[0], lib.coverDir);
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("covers:reset", (_e, bookId: string) => {
    if (!lib) return { ok: false, msg: "还没有打开书库" };
    try {
      return resetCover(D(), bookId, lib.coverDir);
    } catch (e) {
      return err(e);
    }
  });

  /* ---- 书评导入导出：目录固定是书库里的 reviews ---- */
  ipcMain.handle("reviews:importFiles", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择书评 Markdown 文件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    const files = r.filePaths.map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, "utf8") }));
    return importReviewTexts(D(), files, { dir: reviewDir() });
  });
  ipcMain.handle("reviews:importFolder", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择放着书评 md 的文件夹",
      properties: ["openDirectory"]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importReviewTexts(D(), readMdDir(r.filePaths[0]), { dir: reviewDir() });
  });
  /* 导出到书库以外的地方，当一份可读的备份 */
  ipcMain.handle("reviews:export", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "把书评导出到哪里",
      buttonLabel: "导出到这里",
      properties: ["openDirectory", "createDirectory"]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return exportAll(D(), r.filePaths[0]);
    } catch (e) {
      return { ...err(e), added: 0, updated: 0, orphan: 0, skipped: 0, written: 0, msgs: [] };
    }
  });
  ipcMain.handle("reviews:dirInfo", () => {
    const dir = reviewDir();
    let files = 0;
    if (dir && fs.existsSync(dir)) files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).length;
    return { dir, exist: !!dir && fs.existsSync(dir), files, auto: true };
  });
  ipcMain.handle("reviews:sync", () => {
    if (!db || !lib) return null;
    try {
      return syncDir(db, lib.reviewDir);
    } catch (e) {
      console.error("[review] 同步失败", e);
      return null;
    }
  });
  /* 把已经挂上书或系列的书评 md 改回规范名。只动名字，正文与关联都不动 */
  ipcMain.handle("reviews:rename", () => {
    if (!db || !lib) return null;
    try {
      return normalizeNames(db, lib.reviewDir);
    } catch (e) {
      console.error("[review] 重命名失败", e);
      return null;
    }
  });
  ipcMain.handle("reviews:openDir", async () => {
    const dir = reviewDir();
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return true;
  });

  /* ---- 备份恢复 ---- */
  ipcMain.handle("backup:now", async () => {
    if (!lib) return null;
    const r = await dialog.showSaveDialog(win!, {
      title: "备份数据库",
      defaultPath: path.join(lib.backupDir, "library-" + new Date().toISOString().slice(0, 10) + ".db"),
      filters: [{ name: "SQLite", extensions: ["db"] }]
    });
    if (r.canceled || !r.filePath) return null;
    try {
      await backupTo(D(), r.filePath);
      return { ok: true, file: r.filePath };
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("backup:openDir", async () => {
    if (!lib) return false;
    fs.mkdirSync(lib.backupDir, { recursive: true });
    await shell.openPath(lib.backupDir);
    return true;
  });
  ipcMain.handle("backup:list", () => (lib ? listBackups(lib.backupDir) : []));
  ipcMain.handle("backup:restore", async () => {
    if (!lib) return null;
    const r = await dialog.showOpenDialog(win!, {
      title: "选择要恢复的备份",
      properties: ["openFile"],
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "bak"] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const pick = r.filePaths[0];
    const sure = await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["取消", "覆盖并重启"],
      defaultId: 1,
      cancelId: 0,
      message: "用这份备份覆盖当前数据库？",
      detail: pick + "\n\n当前库会先自动备份一份到 backups 目录，然后软件重启。"
    });
    if (sure.response !== 1) return { ok: false, msg: "已取消" };
    try {
      await autoBackup(D(), lib.backupDir, 8);
      const target = lib.dbFile;
      closeDb();
      db = null;
      fs.copyFileSync(pick, target);
      app.relaunch();
      app.exit(0);
      return { ok: true, msg: "正在重启" };
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("settings:get", (_e, key: string) => getSetting(D(), key, ""));
  ipcMain.handle("settings:set", (_e, key: string, value: string) => {
    setSetting(D(), key, value);
    return true;
  });

  ipcMain.handle("data:info", () => {
    if (!lib) return { dir: "", covers: 0, bytes: 0, books: 0, reviews: 0 };
    const s = survey(lib.root);
    return {
      dir: lib.root,
      covers: s.covers,
      bytes: 0,
      books: db ? counts(db).books : 0,
      reviews: db ? counts(db).reviews : 0
    };
  });
}

/* 单实例：第二次点图标只是把已有窗口顶到前面，不另起一个进程去抢数据库 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.setAppUserModelId("cn.chncrab.booklib");

  app.whenReady().then(async () => {
    protocol.handle("cover", (req) => {
      const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ""));
      const base = lib ? lib.coverDir : "";
      if (!base) return new Response("", { status: 404 });
      const file = path.join(base, path.basename(name));
      if (!fs.existsSync(file)) return new Response("", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    registerIpc();

    /* 从环境变量或上次记住的位置开库。都没有就留空，界面出选择页 */
    const env = rootFromEnv();
    const remembered = readConfig(userData()).root;
    const start = env && isLibrary(env) ? env : remembered && isLibrary(remembered) ? remembered : "";
    if (start) {
      const r = openLibrary(start);
      if (r.ok) console.log(`[library] 已打开 ${r.root}，${r.books} 本`);
      else console.error("[library] 打开失败", r.msg);
    } else {
      console.log("[library] 还没有选书库，等界面选择");
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    stopWatch();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    stopWatch();
    closeDb();
  });
}
