import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openDb, closeDb } from "./db";
import type { DB } from "./db";
import { listBooks, getBook, facets, seriesAvg } from "./services/bookService";
import { updateBook, deleteBook, restoreBook, copyBook, copyBooks, setRead, setRating } from "./services/editService";
import { categoryTree, createCategory, renameCategory, setCategoryParent, removeCategory, moveCategory } from "./services/categoryService";
import { listReviews, counts } from "./services/reviewService";
import { listSeries, renameSeries, seriesBooks } from "./services/seriesService";
import { readReviewFile, reviewFileVersion } from "./services/reviewFiles";
import {
  getIndexedReview,
  readIndexedReview,
  createFileReview,
  updateFileReview,
  moveFileReview,
  deleteFileReview,
  refreshLinkedReviewFront,
  preserveLegacyReviewGrades
} from "./services/reviewFileEdits";
import { importFileReviews, exportFileReviews, listReviewMarkdown, bulkEditReviewFiles } from "./services/reviewFileTools";
import { readTimeline, readStats } from "./services/readService";
import {
  listFields,
  createField,
  updateField,
  changeFieldType,
  removeField,
  restoreField,
  moveField,
  addFieldOption,
  renameFieldOption,
  removeFieldOption
} from "./services/fieldService";
import { setCoverFromFile, resetCover } from "./services/coverService";
import {
  search as coverSearch,
  detailOf,
  applyCandidate,
  enqueue,
  dequeue,
  listQueue,
  booksWithoutCover,
  bestHit,
  BlockedError,
  MIN_SCORE,
  GAP_MS
} from "./services/coverFetch";
import type { Http } from "./services/coverFetch";
import { getSetting, setSetting } from "./services/settingsService";
import { backupReviewLibrary, autoBackupWithReviews, listReviewBackups, isReviewSnapshot, restoreReviewLibrary } from "./services/reviewBackup";
import { reconcileReviewFiles } from "./services/reviewFiles";
import { ReviewRuntime } from "./services/reviewRuntime";
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
import type { BookPatch, BookQuery, FieldInput, FieldPatch, FieldType, ReviewInput, ReviewPatch, SeriesPatch } from "../shared/types";
import type { CoverBatchState, CoverCandidate } from "../shared/types";

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
let autoBackupTask: Promise<unknown> | null = null;
let libraryBusy = false;

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

function reviewRecoveryDir(): string {
  return lib ? path.join(lib.backupDir, "review-recovery") : "";
}

function announceReviewsChanged(): void {
  win?.webContents.send("library:reviews-changed");
}

function announceReviewsWatch(ok: boolean, msg?: string): void {
  win?.webContents.send("library:reviews-watch", { ok, msg: msg || "" });
}

function announceBackupsChanged(): void {
  win?.webContents.send("backup:changed");
}

const reviewRuntime = new ReviewRuntime(
  () => (db && lib ? { db, dir: lib.reviewDir, recoveryDir: reviewRecoveryDir() } : null),
  (kind, id, r) => {
    win?.webContents.send("reviews:saveState", kind, id, r);
    if (r.ok) announceReviewsChanged();
  }
);

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function flushReviews(why: string): Promise<{ ok: boolean; msg?: string }> {
  try {
    const r = await reviewRuntime.flushAll();
    if (r && r.ok === false) return { ok: false, msg: (r as { msg?: string }).msg || `书评保存失败（${why}）` };
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: msgOf(e) };
  }
}

/* ---- 打开与切换书库 ---- */

function reviewDirHasMarkdown(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /\.md$/i.test(f));
  } catch {
    return false;
  }
}

async function openLibrary(root: string): Promise<{ ok: boolean; msg?: string; root?: string; books: number }> {
  if (libraryBusy) return { ok: false, msg: "书库正在打开或切换，请稍候", books: db ? counts(db).books : 0 };
  libraryBusy = true;
  try {
    return await openLibraryUnlocked(root);
  } finally {
    libraryBusy = false;
  }
}

async function openLibraryUnlocked(root: string): Promise<{ ok: boolean; msg?: string; root?: string; books: number }> {
  const target = path.resolve(root);
  const flushed = await flushReviews("switch");
  if (!flushed.ok) {
    return { ok: false, msg: flushed.msg || "书评还没保存好，先不切换书库", books: db ? counts(db).books : 0 };
  }
  if (autoBackupTask) await autoBackupTask.catch(() => undefined);
  /* 换库时旧目录的监听先停，否则会拿着新库去同步旧路径 */
  stopWatch();
  const prevLib = lib;
  let conn: DB | null = null;
  try {
    const overrideDb = process.env.LIBRARY_DB && path.dirname(path.resolve(process.env.LIBRARY_DB)) === target
      ? path.resolve(process.env.LIBRARY_DB)
      : "";
    const existing = isLibrary(target) || (!!overrideDb && fs.existsSync(overrideDb));
    const p = ensureStructure(target, !existing);
    /* 测试脚本会指定一个单独的 db 文件名，认这个覆盖 */
    if (overrideDb) {
      p.dbFile = overrideDb;
    }
    closeDb();
    db = null;
    lib = null;
    conn = openDb(p.dbFile);

    /* 旧库第一次对账前先留一份完整快照，备份失败就不动文件索引 */
    const reconciled = getSetting(conn, "review_files_v1", "");
    if (!reconciled && existing) {
      let reviewDirReady = false;
      try {
        reviewDirReady = fs.lstatSync(p.reviewDir).isDirectory();
      } catch {
        reviewDirReady = false;
      }
      if (!reviewDirReady) {
        if (listReviews(conn).length > 0) {
          throw new Error("书评目录缺失，但旧库里已有书评数据。请把原 reviews 目录移回书库根目录后再打开。");
        }
        try {
          fs.mkdirSync(p.reviewDir, { recursive: true });
          if (!fs.lstatSync(p.reviewDir).isDirectory()) throw new Error("not dir");
        } catch {
          throw new Error("书评目录不可用");
        }
      }
    }
    if (!reconciled) {
      if (reviewDirHasMarkdown(p.reviewDir) || listReviews(conn).length > 0) {
        try {
          await backupReviewLibrary(conn, p.reviewDir, p.backupDir, "migration");
        } catch (e) {
          throw new Error("旧书评迁移前备份失败：" + msgOf(e));
        }
      }
      preserveLegacyReviewGrades(conn, p.reviewDir);
    }
    let rec: unknown = null;
    try {
      rec = reconcileReviewFiles(conn, p.reviewDir);
    } catch (e) {
      if (!reconciled) throw e;
    }
    const recErr = rec as { ok?: boolean; msg?: string } | null;
    if (!reconciled && recErr && recErr.ok === false) {
      throw new Error(recErr.msg || "书评文件对账失败");
    }
    setSetting(conn, "review_files_v1", "1");

    const opened = conn;
    db = opened;
    lib = p;
    conn = null;
    rememberRoot(userData(), target);
    startWatch();
    const n = counts(opened).books;
    autoBackupTask = autoBackupWithReviews(opened, p.reviewDir, p.backupDir, 8)
      .catch((e) => console.error("[backup] 失败", e))
      .finally(() => {
        autoBackupTask = null;
      });
    return { ok: true, root: p.root, books: n };
  } catch (e) {
    if (conn) {
      try {
        closeDb();
      } catch {
        /* 新库没打开成功，关不掉也不影响恢复旧库 */
      }
    }
    db = null;
    lib = null;
    if (prevLib) {
      try {
        const restored = openDb(prevLib.dbFile);
        db = restored;
        lib = prevLib;
        startWatch();
      } catch (re) {
        console.error("[library] 恢复此前书库失败", re);
      }
    }
    return { ok: false, msg: "这个文件夹里的库打不开：" + msgOf(e), books: db ? counts(db).books : 0 };
  }
}

let watcher: fs.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let watchRetryTimer: NodeJS.Timeout | null = null;
let syncing = false;
let syncPending = false;

/**
 * 盯着 reviews 目录。普通事件延后到 2000ms 后统一对账一次。
 * 只处理文件事件，不在 IPC 里做旧式全量 sync；目录没了关掉监听并等轻量 lstat 重试。
 */
function startWatch(): void {
  stopWatch();
  if (!lib) return;
  const dir = lib.reviewDir;
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("书评目录不可用");
    watcher = fs.watch(dir, { persistent: false }, (_ev, file) => {
      if (file && !/\.md$/i.test(String(file))) return;
      scheduleSync("watch");
    });
    watcher.on("error", (e) => {
      console.error("[watch] 书评目录监听出错", e);
      announceReviewsWatch(false, msgOf(e));
      closeWatcherOnly();
      scheduleWatchRetry();
    });
    announceReviewsWatch(true);
  } catch (e) {
    console.error("[watch] 书评目录监听失败", e);
    announceReviewsWatch(false, msgOf(e));
    scheduleWatchRetry();
  }
}

function closeWatcherOnly(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 关不掉也不影响 */
    }
    watcher = null;
  }
}

function stopWatch(): void {
  closeWatcherOnly();
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchRetryTimer) {
    clearTimeout(watchRetryTimer);
    watchRetryTimer = null;
  }
}

function scheduleWatchRetry(): void {
  if (watchRetryTimer || !lib) return;
  const dir = lib.reviewDir;
  watchRetryTimer = setTimeout(() => {
    watchRetryTimer = null;
    if (!lib || lib.reviewDir !== dir) return;
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw new Error("not dir");
    } catch {
      scheduleWatchRetry();
      return;
    }
    startWatch();
    void runReconcile("recover");
    announceReviewsChanged();
  }, 2000);
}

function scheduleSync(why: string): void {
  if (syncing) {
    syncPending = true;
    return;
  }
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    void runReconcile(why);
  }, 2000);
}

async function runReconcile(why: string): Promise<void> {
  if (!db || !lib) return;
  if (syncing) {
    syncPending = true;
    return;
  }
  syncing = true;
  try {
    const out = reconcileReviewFiles(db, lib.reviewDir);
    const renamed = Number((out as { renamed?: number } | undefined)?.renamed || 0);
    const removed = Number((out as { removed?: number } | undefined)?.removed || 0);
    const added = Number((out as { added?: number } | undefined)?.added || 0);
    const updated = Number((out as { updated?: number } | undefined)?.updated || 0);
    if (renamed + removed + added + updated) {
      console.log(`[reconcile:${why}] 重命名 ${renamed}，移除 ${removed}，新增 ${added}，更新 ${updated}`);
      announceReviewsChanged();
    }
  } catch (e) {
    console.error(`[reconcile:${why}] 失败`, e);
    announceReviewsWatch(false, msgOf(e));
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      scheduleSync("pending");
    }
  }
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

  let allowClose = false;
  let closing = false;
  win.on("close", (e) => {
    const w = win;
    if (!w) return;
    if (allowClose || appQuitting) {
      saveWinState(w);
      return;
    }
    e.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        const saved = await flushReviews("close");
        if (!saved.ok) {
          await dialog.showMessageBox(w, {
            type: "warning",
            buttons: ["知道了"],
            defaultId: 0,
            cancelId: 0,
            message: "书评还没保存成功",
            detail: (saved.msg || "有些修改没有写进书评文件。") + "\n\n这次关闭已取消，请稍后重试。"
          });
          return;
        }
        if (autoBackupTask) await autoBackupTask.catch(() => undefined);
        allowClose = true;
        saveWinState(w);
        w.close();
      } finally {
        closing = false;
      }
    })();
  });
  win.on("closed", () => {
    win = null;
  });
}

let appQuitting = false;

const err = (e: unknown) => ({ ok: false, msg: e instanceof Error ? e.message : String(e) });

/* ---- 封面识别 ---- */

let batchState: CoverBatchState = {
  running: false,
  total: 0,
  done: 0,
  applied: 0,
  queued: 0,
  failed: 0,
  current: "",
  stopReason: ""
};
let batchStopWant = false;

const emitBatch = () => {
  try {
    win?.webContents.send("covers:batchProgress", batchState);
  } catch {
    /* 窗口没了就没人听，不影响批量本身 */
  }
};

/** 正式的网络实现。走 Chromium 的网络栈，系统代理与证书都跟着走 */
function netHttp(): Http {
  return {
    async text(url, headers) {
      const r = await net.fetch(url, { headers, redirect: "follow" });
      return { status: r.status, url: r.url || url, text: await r.text() };
    },
    async bytes(url, headers) {
      const r = await net.fetch(url, { headers, redirect: "follow" });
      const buf = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, url: r.url || url, bytes: buf, contentType: r.headers.get("content-type") || "" };
    }
  };
}

/* 一张 2:3 的小封面，深边加浅底。后面补零撑到 1KB 以上好过体积校验，
   解码器读到 IEND 就停，补的零不碍事。冒烟与截图用它，不联网也能走通落盘 */
const FAKE_PNG = (() => {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAADwAAABaCAIAAABrM6JiAAAAdElEQVR42u3bOQ0AIAAAMcQQJnQgBxGIYEYqAphYeJImJ6AGLsSUvytAH0eX2h4PGhoaGhoaGhp6H937eDxoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaOibaDcz9NIEd3irul9Vf0MAAAAASUVORK5CYII=";
  const head = Buffer.from(b64, "base64");
  const pad = Buffer.alloc(1200 - head.length);
  return new Uint8Array(Buffer.concat([head, pad]));
})();

/**
 * 假数据。BOOKLIB_FAKE_COVER=1 时启用，只在测试里用。
 * 搜索按查询词现造一条同名候选，另加一条带括号后缀的与一条作者条目，
 * 后者是 type 为 a 的，用来确认过滤没漏；详情页与图片也现造。
 * 每五次里有一次只返回弱匹配（书名只剩头两个字），好让待确认队列也能跑到。
 */
function fakeHttp(): Http {
  let hits = 0;
  const subjectHtml = (id: string, title: string) => `<!doctype html><html><head>
<meta property="og:title" content="${title}" />
<meta property="og:image" content="https://img3.doubanio.com/view/subject/l/public/${id}.jpg" />
<meta property="og:url" content="https://book.douban.com/subject/${id}/" />
</head><body><h1 class="title"><span property="v:itemreviewed">${title}</span></h1>
<div id="info">
<span class="pl"> 作者</span>: 某作者<br/>
<span class="pl">出版社:</span> 某出版社<br/>
<span class="pl">出版年:</span> 2019-5-1<br/>
<span class="pl">ISBN:</span> 9787000000001<br/>
<span class="pl">页数:</span> 320<br/>
<span class="pl">装帧:</span> 平装<br/>
<span class="pl">定价:</span> 45.00元<br/>
</div></body></html>`;

  const suggest = (q: string) =>
    JSON.stringify([
      { title: q, url: "https://book.douban.com/subject/9001/", pic: "https://img3.doubanio.com/view/subject/s/public/9001.jpg", author_name: "某作者", year: "2019", type: "b", id: "9001" },
      { title: q + "（新版）", url: "https://book.douban.com/subject/9002/", pic: "https://img3.doubanio.com/view/subject/s/public/9002.jpg", author_name: "另一个人", year: "2021", type: "b", id: "9002" },
      { title: q, url: "https://book.douban.com/author/1/", pic: "https://img3.doubanio.com/view/celebrity/m/public/p1.jpg", type: "a", id: "1" }
    ]);

  /* 站内搜索页。查询词以「台版」开头时 suggest 给空数组，只有这条路有结果，
     用来验 suggest 没收录时的回落，跟真站上搜繁体书的情形一个样 */
  const siteHtml = (q: string) => {
    const items = [
      {
        abstract: "某作者 / 某出版社 / 2018-10-18 / NTD450",
        cover_url: "https://img3.doubanio.com/view/subject/m/public/9101.jpg",
        id: 9101,
        title: q,
        url: "https://book.douban.com/subject/9101/"
      },
      {
        abstract: "另一个人 / 另一家出版社 / 2016-1-14 / JPY 1296",
        cover_url: "https://img3.doubanio.com/view/subject/m/public/9102.jpg",
        id: 9102,
        title: q + " : 副标题",
        url: "https://book.douban.com/subject/9102/"
      }
    ];
    return `<html><body><script>window.__DATA__ = ${JSON.stringify({ count: items.length, items })};</script></body></html>`;
  };

  return {
    async text(url) {
      if (url.includes("/j/subject_suggest")) {
        const q = decodeURIComponent((url.split("q=")[1] || "").split("&")[0]);
        hits++;
        if (q.startsWith("台版")) return { status: 200, url, text: "[]" };
        /* 每五次弱一次：书名只留头两个字，打 35 分，落在阈值下面进队列 */
        if (hits % 5 === 0) {
          return {
            status: 200,
            url,
            text: JSON.stringify([
              {
                title: q.slice(0, 2),
                url: "https://book.douban.com/subject/9003/",
                pic: "https://img3.doubanio.com/view/subject/s/public/9003.jpg",
                author_name: "不像的人",
                year: "1999",
                type: "b",
                id: "9003"
              }
            ])
          };
        }
        return { status: 200, url, text: suggest(q) };
      }
      if (url.includes("/subject_search")) {
        const q = decodeURIComponent((url.split("search_text=")[1] || "").split("&")[0]);
        return { status: 200, url, text: siteHtml(q) };
      }
      if (url.includes("/isbn/")) {
        return { status: 200, url: "https://book.douban.com/subject/9001/", text: subjectHtml("9001", "按ISBN找到的书") };
      }
      const m = url.match(/subject\/(\d+)/);
      return { status: 200, url, text: m ? subjectHtml(m[1], "假书名") : "" };
    },
    async bytes(url) {
      if (url.includes("broken")) return { status: 200, url, bytes: new Uint8Array(10), contentType: "image/png" };
      if (url.includes("notimage")) return { status: 200, url, bytes: FAKE_PNG, contentType: "text/html" };
      return { status: 200, url, bytes: FAKE_PNG, contentType: "image/png" };
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 每回真往豆瓣发请求之前先等够间隔。一次搜索背后往往连着好几次请求，
 * 联想接口、站内搜索、详情页、封面图各算一次，只在每本书之间停是不够的，
 * 挡的就是这一串连发。单本搜封面、队列重试与批量都走这里，一并受管。
 */
let lastHitAt = 0;
async function pace(): Promise<void> {
  const rest = GAP_MS - (Date.now() - lastHitAt);
  if (rest > 0) await sleep(rest);
  lastHitAt = Date.now();
}

function paced(inner: Http): Http {
  return {
    async text(url, headers) {
      await pace();
      return inner.text(url, headers);
    },
    async bytes(url, headers) {
      await pace();
      return inner.bytes(url, headers);
    }
  };
}

/** 不加间隔的那一份。缩略图预览一次要十几张，走图床，不参与排队 */
const rawHttp = (): Http => (process.env.BOOKLIB_FAKE_COVER === "1" ? fakeHttp() : netHttp());
const httpImpl = (): Http => paced(rawHttp());

/**
 * 撞上豆瓣拦截时给界面与批量用的一句话。软限流是它把「搜索访问太频繁」
 * 写进 200 的响应体里，与 403、418 那种硬挡不同，提示要分得开，
 * 不然用户以为是书不存在或者软件坏了。
 */
function blockMsg(e: BlockedError): string {
  if (e.soft) return "豆瓣限制了搜索频率（" + e.detail + "），过一会儿再试，或者直接把 ISBN 粘进来";
  return "豆瓣拦了一下（" + e.code + "），过一会儿再试";
}

/**
 * 批量跑一遍缺封面的书。串行，两次请求之间由 pace 隔开，撞上限速就整批停，
 * 剩下的一本不动、留在库里等下次。已经排进队列的也算处理过，不会重复弹。
 */
async function runCoverBatch(backfill: boolean): Promise<void> {
  if (!lib) return;
  const dir = lib.coverDir;
  const conn = requireDb();
  const books = booksWithoutCover(conn);

  batchStopWant = false;
  batchState = {
    running: true,
    total: books.length,
    done: 0,
    applied: 0,
    queued: 0,
    failed: 0,
    current: "",
    stopReason: ""
  };
  emitBatch();
  if (!books.length) {
    batchState = { ...batchState, running: false, stopReason: "没有缺封面的书" };
    emitBatch();
    return;
  }

  const http = httpImpl();
  for (const b of books) {
    if (batchStopWant) {
      batchState = { ...batchState, stopReason: "手动停了" };
      break;
    }
    batchState = { ...batchState, current: b.title };
    emitBatch();

    try {
      const tick = await bestHit(conn, http, b);
      if (tick.best && tick.score >= MIN_SCORE) {
        const r = await applyCandidate(conn, http, b.id, tick.best, { coversDir: dir, backfill });
        if (r.ok) {
          batchState = { ...batchState, applied: batchState.applied + 1, done: batchState.done + 1 };
        } else {
          enqueue(conn, b.id, tick.best, tick.score);
          batchState = { ...batchState, failed: batchState.failed + 1, queued: batchState.queued + 1, done: batchState.done + 1 };
        }
      } else {
        enqueue(conn, b.id, tick.best, tick.score);
        batchState = { ...batchState, queued: batchState.queued + 1, done: batchState.done + 1 };
      }
    } catch (e) {
      if (e instanceof BlockedError) {
        batchState = {
          ...batchState,
          stopReason: blockMsg(e) + "，剩下的没动",
          failed: batchState.failed + 1,
          done: batchState.done + 1
        };
        break;
      }
      batchState = { ...batchState, failed: batchState.failed + 1, done: batchState.done + 1 };
    }
    emitBatch();
  }

  batchState = {
    ...batchState,
    running: false,
    current: "",
    stopReason: batchState.stopReason || "跑完了"
  };
  emitBatch();
}

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
    let review = null;
    try {
      const rv = D().prepare("SELECT id FROM reviews WHERE book_id = ? AND deleted_at IS NULL").get(id) as any;
      if (rv) review = readIndexedReview(D(), reviewDir(), "book", rv.id);
    } catch (e) {
      console.error("[review] 读书评失败", e);
      review = null;
    }
    return { book, review };
  });
  ipcMain.handle("books:facets", (_e, media?: string) => facets(D(), media || ""));
  ipcMain.handle("series:avg", (_e, id: number) => seriesAvg(D(), id));
  ipcMain.handle("series:list", (_e, mediaType?: string) => listSeries(D(), mediaType || ""));
  ipcMain.handle("series:books", (_e, id: number) => seriesBooks(D(), id));
  ipcMain.handle("series:review", (_e, id: number) => {
    try {
      const rv = D().prepare("SELECT id FROM reviews WHERE series_id = ? AND deleted_at IS NULL").get(id) as any;
      if (!rv) return null;
      return readIndexedReview(D(), reviewDir(), "series", rv.id);
    } catch (e) {
      console.error("[review] 读系列总评失败", e);
      return null;
    }
  });
  /**
   * 改系列名。先落暂存的正文，再改库；原名换了就定点刷新系列总评头部，
   * 正文与元数据保留。文件出错不影响库里已经是新名字。
   */
  ipcMain.handle("series:update", (_e, id: number, patch: SeriesPatch) => {
    reviewRuntime.flushAll();
    const r = renameSeries(D(), id, patch);
    if (r.ok && r.renamed) {
      try {
        refreshLinkedReviewFront(D(), reviewDir(), reviewRecoveryDir(), { seriesId: id }, ["系列"]);
        announceReviewsChanged();
      } catch (e) {
        console.error("[review] 刷新系列总评头部失败", e);
      }
    }
    return r;
  });
  /* 阅读时间线与日历，只读。两屏共用同一次取回，界面切排布不重取 */
  ipcMain.handle("read:timeline", (_e, media?: string) => readTimeline(D(), media || ""));
  ipcMain.handle("read:stats", (_e, media?: string) => readStats(D(), media || ""));
  /* 字数缓存：key 用「目录/文件名/版本」，单次只保留当前列表出现过的 key */
  const mdLenCache = new Map<string, number>();
  const mdLenKey = (dir: string, fileName: string, version: string) => dir + "\u0000" + fileName + "\u0000" + version;
  ipcMain.handle("reviews:list", () => {
    const dir = reviewDir();
    const rows = listReviews(D()) as any[];
    const keep = new Set<string>();
    const list = rows.map((r) => {
      const fileName = r.fileName || "";
      const version = reviewFileVersion(D(), r.kind, r.id);
      const key = mdLenKey(dir, fileName, version);
      let length = mdLenCache.get(key);
      if (length === undefined) {
        let file: { raw: string; md: string; version: string } | null = null;
        try {
          file = fileName ? readReviewFile(dir, fileName) : null;
        } catch {
          file = null;
        }
        length = file ? file.md.length : 0;
        mdLenCache.set(key, length);
      }
      keep.add(key);
      return { ...r, md: "", fileName, fileVersion: version, length };
    });
    for (const k of mdLenCache.keys()) if (!keep.has(k)) mdLenCache.delete(k);
    return list;
  });
  /* 单篇导出用同一个命名规则，界面别自己拼文件名，否则和落盘那份对不上 */
  ipcMain.handle("reviews:fileName", (_e, kind: string, id: number) => getIndexedReview(D(), kind as any, id)?.fileName || "");
  ipcMain.handle("books:setRead", (_e, id: string, read: boolean) => setRead(D(), id, read));
  ipcMain.handle("books:setRating", (_e, id: string, rating: number | null) => {
    reviewRuntime.flushAll();
    const r = setRating(D(), id, rating);
    try {
      refreshLinkedReviewFront(D(), reviewDir(), reviewRecoveryDir(), { bookId: id }, ["评分"]);
      announceReviewsChanged();
    } catch (e) {
      console.error("[review] 刷新书评头部失败", e);
    }
    return r;
  });
  ipcMain.handle("books:update", (_e, id: string, patch: BookPatch) => {
    reviewRuntime.flushAll();
    const nb = updateBook(D(), id, patch || {}, coverDir());
    /* 改了书名或作者，已落盘的书评头部跟着改，正文与元数据保留 */
    if (nb) {
      const p = patch || {};
      const keys: Parameters<typeof refreshLinkedReviewFront>[4] = [];
      if (Object.prototype.hasOwnProperty.call(p, "title")) keys.push("书籍");
      if (Object.prototype.hasOwnProperty.call(p, "authors")) keys.push("作者");
      if (Object.prototype.hasOwnProperty.call(p, "readDate")) keys.push("阅读时间");
      if (Object.prototype.hasOwnProperty.call(p, "rating")) keys.push("评分");
      if (Object.prototype.hasOwnProperty.call(p, "categories")) keys.push("分类");
      if (keys.length) {
        try {
          refreshLinkedReviewFront(D(), reviewDir(), reviewRecoveryDir(), { bookId: id }, keys);
          announceReviewsChanged();
        } catch (e) {
          console.error("[review] 刷新书评头部失败", e);
        }
      }
    }
    return nb;
  });
  ipcMain.handle("books:delete", (_e, id: string) => {
    reviewRuntime.flushAll();
    const r = deleteBook(D(), id);
    /* 文件不删，只通过对账更新关联，让界面重取 */
    try {
      reconcileReviewFiles(D(), reviewDir());
      announceReviewsChanged();
    } catch (e) {
      console.error("[review] 移除书评关联失败", e);
    }
    return r;
  });
  ipcMain.handle("books:restore", (_e, id: string) => {
    reviewRuntime.flushAll();
    const r = restoreBook(D(), id);
    try {
      reconcileReviewFiles(D(), reviewDir());
      announceReviewsChanged();
    } catch (e) {
      console.error("[review] 恢复书评关联失败", e);
    }
    return r;
  });
  ipcMain.handle("books:copy", (_e, id: string) => copyBook(D(), id, coverDir()));
  ipcMain.handle("books:copyMany", (_e, ids: string[]) => copyBooks(D(), ids || [], coverDir()));
  ipcMain.handle("cats:tree", () => categoryTree(D()));
  ipcMain.handle("cats:create", (_e, name: string, parentId: number | null) => createCategory(D(), name, parentId ?? null));
  ipcMain.handle("cats:rename", (_e, id: number, name: string) => renameCategory(D(), id, name));
  ipcMain.handle("cats:parent", (_e, id: number, parentId: number | null) => setCategoryParent(D(), id, parentId ?? null));
  ipcMain.handle("cats:remove", (_e, id: number) => removeCategory(D(), id));
  ipcMain.handle("cats:move", (_e, id: number, dir: -1 | 1) => moveCategory(D(), id, dir));

  /* 字段定义。表格列、详情行、排序键、筛选控件全靠这一组 */
  ipcMain.handle("fields:list", (_e, includeDeleted?: boolean) => listFields(D(), !!includeDeleted));
  ipcMain.handle("fields:create", (_e, p: FieldInput) => createField(D(), p || ({ label: "" } as FieldInput)));
  ipcMain.handle("fields:update", (_e, id: number, p: FieldPatch) => updateField(D(), id, p || {}));
  ipcMain.handle("fields:type", (_e, id: number, type: FieldType) => changeFieldType(D(), id, type));
  ipcMain.handle("fields:remove", (_e, id: number) => removeField(D(), id));
  ipcMain.handle("fields:restore", (_e, id: number) => restoreField(D(), id));
  ipcMain.handle("fields:move", (_e, id: number, dir: -1 | 1) => moveField(D(), id, dir));
  ipcMain.handle("fields:addOption", (_e, fieldId: number, name: string) => addFieldOption(D(), fieldId, name));
  ipcMain.handle("fields:renameOption", (_e, id: number, name: string) => renameFieldOption(D(), id, name));
  ipcMain.handle("fields:removeOption", (_e, id: number) => removeFieldOption(D(), id));
  /* 图片类型字段选一张本地图。文件名由字段与书派生，换图时同名覆盖，不留旧图 */
  ipcMain.handle("fields:pickImage", async (_e, fieldKey: string, bookId: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, msg: "没有选择图片" };
    const dir = coverDir();
    if (!dir) return { ok: false, msg: "还没有打开书库" };
    const src = r.filePaths[0];
    const ext = (path.extname(src) || ".jpg").toLowerCase();
    const base = ("字段-" + fieldKey + "-" + String(bookId || "x").slice(0, 8)).replace(/[\\/:*?"<>|]/g, "_");
    const name = base + ext;
    try {
      fs.mkdirSync(dir, { recursive: true });
      /* 扩展名换过时上一张会留在原地，顺手清掉同名的其他后缀 */
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(base + ".") && f !== name) fs.rmSync(path.join(dir, f), { force: true });
      }
      fs.copyFileSync(src, path.join(dir, name));
    } catch (e) {
      return err(e);
    }
    return { ok: true, name };
  });

  /* 新建：直接落一篇文件，磁盘有变化就通知界面重取 */
  ipcMain.handle("reviews:create", (_e, p: ReviewInput) => {
    try {
      const r = createFileReview(D(), reviewDir(), p || {});
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  /* 更新：先把已经暂存的内容落盘，再即时写当前这篇，version/filename 由服务处理 */
  ipcMain.handle("reviews:update", async (_e, kind: string, id: number, p: ReviewPatch) => {
    const flushed = await flushReviews("update");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = updateFileReview(D(), reviewDir(), reviewRecoveryDir(), kind as any, id, p || {});
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  /* 未匹配与已挂靠的 id 各自独立，kind 由界面带上来 */
  ipcMain.handle("reviews:delete", async (_e, kind: string, id: number) => {
    const flushed = await flushReviews("delete");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = deleteFileReview(D(), reviewDir(), kind as any, id);
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("reviews:associateOrphan", async (_e, oid: number, bookId: string) => {
    const flushed = await flushReviews("associate");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = moveFileReview(D(), reviewDir(), reviewRecoveryDir(), "orphan", oid, { bookId });
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("reviews:move", async (_e, kind: string, id: number, bookId: string) => {
    /* 未匹配那条的 id 与 reviews 的 id 各从 1 起，按 id 硬查会命中另一篇不相干的书评 */
    if (kind === "orphan") return { ok: false, msg: "未匹配书评请用「关联到书籍」" };
    const flushed = await flushReviews("move");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = moveFileReview(D(), reviewDir(), reviewRecoveryDir(), kind as any, id, { bookId });
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("reviews:moveToSeries", async (_e, kind: string, id: number, seriesId: number) => {
    const flushed = await flushReviews("moveSeries");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = moveFileReview(D(), reviewDir(), reviewRecoveryDir(), kind as any, id, { seriesId });
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("reviews:moveToBook", async (_e, kind: string, id: number, bookId: string) => {
    if (kind === "orphan") return { ok: false, msg: "未匹配书评请用「关联到书籍」" };
    const flushed = await flushReviews("moveBook");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存好" };
    try {
      const r = moveFileReview(D(), reviewDir(), reviewRecoveryDir(), kind as any, id, { bookId });
      if (r && r.ok) announceReviewsChanged();
      return r;
    } catch (e) {
      return err(e);
    }
  });
  /* 读正文、搜索、暂存、冲刷 */
  ipcMain.handle("reviews:read", (_e, kind: string, id: number) => {
    try {
      return readIndexedReview(D(), reviewDir(), kind as any, id);
    } catch (e) {
      console.error("[review] 读正文失败", e);
      return null;
    }
  });
  ipcMain.handle("reviews:search", (_e, q: string) => {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return [];
    const dir = reviewDir();
    const out: string[] = [];
    for (const r of listReviews(D()) as any[]) {
      if (!r.fileName) continue;
      let file: { raw: string; md: string; version: string } | null = null;
      try {
        file = readReviewFile(dir, r.fileName);
      } catch {
        file = null;
      }
      if (!file) continue;
      const body = file.md || file.raw || "";
      if (body.toLowerCase().indexOf(needle) < 0) continue;
      out.push(r.kind + ":" + r.id);
    }
    return out;
  });
  ipcMain.handle("reviews:stage", (_e, kind: string, id: number, p: ReviewPatch) => {
    return reviewRuntime.stage(kind as any, id, p || {});
  });
  ipcMain.handle("reviews:flush", () => {
    return reviewRuntime.flushAll();
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

  /* ---- 封面识别。网络一律在主进程发，图片站认 Referer，界面直连会被 418 挡掉 ---- */

  const http = httpImpl();

  ipcMain.handle("covers:search", async (_e, q: string) => {
    if (!lib) return { ok: false, candidates: [], msg: "还没有打开书库" };
    try {
      const r = await coverSearch(D(), http, String(q || ""));
      return { ok: true, candidates: r.list, cached: r.cached };
    } catch (e) {
      if (e instanceof BlockedError) return { ok: false, candidates: [], msg: blockMsg(e) };
      return { ok: false, candidates: [], msg: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("covers:detail", async (_e, id: string) => {
    if (!lib) return null;
    try {
      return await detailOf(D(), http, String(id || ""));
    } catch {
      return null;
    }
  });

  /* 候选缩略图转成 data URL 再给界面。豆瓣图片站要 Referer，img 标签直连一律 418 */
  ipcMain.handle("covers:thumb", async (_e, url: string) => {
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return "";
    try {
      /* 预览图一次要十几张，排队等间隔半天出不来，图床也不吃这套限速，走不加间隔那份 */
      const r = await rawHttp().bytes(u, { "User-Agent": "Mozilla/5.0", Referer: "https://book.douban.com/" });
      if (r.status !== 200 || !r.bytes.byteLength) return "";
      const ct = String(r.contentType || "image/jpeg").split(";")[0].trim() || "image/jpeg";
      return "data:" + ct + ";base64," + Buffer.from(r.bytes).toString("base64");
    } catch {
      return "";
    }
  });

  ipcMain.handle("covers:apply", async (_e, bookId: string, hit: CoverCandidate, backfill: boolean) => {
    if (!lib) return { ok: false, msg: "还没有打开书库" };
    try {
      return await applyCandidate(D(), http, bookId, hit, { coversDir: lib.coverDir, backfill: !!backfill });
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("covers:queue", () => {
    if (!lib) return [];
    try {
      return listQueue(D());
    } catch {
      return [];
    }
  });

  ipcMain.handle("covers:queueAccept", async (_e, bookId: string, backfill: boolean) => {
    if (!lib) return { ok: false, msg: "还没有打开书库" };
    const item = listQueue(D()).find((x) => x.bookId === bookId);
    if (!item || !item.candidate) return { ok: false, msg: "队列里没有这一条" };
    try {
      const r = await applyCandidate(D(), http, bookId, item.candidate, {
        coversDir: lib.coverDir,
        backfill: !!backfill
      });
      if (r.ok) dequeue(D(), bookId);
      return r;
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("covers:queueSkip", (_e, bookId: string) => {
    if (!lib) return { ok: false };
    try {
      dequeue(D(), bookId);
      return { ok: true };
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("covers:batchStart", async (_e, backfill: boolean) => {
    if (!lib) return { ...batchState, stopReason: "还没有打开书库" };
    if (batchState.running) return batchState;
    void runCoverBatch(!!backfill);
    return batchState;
  });

  ipcMain.handle("covers:batchStop", () => {
    batchStopWant = true;
    return batchState;
  });

  ipcMain.handle("covers:batchState", () => batchState);

  /* ---- 书评导入导出：目录固定是书库里的 reviews ---- */
  const ioFail = (e: unknown) => ({ ...err(e), added: 0, updated: 0, orphan: 0, skipped: 0, written: 0, msgs: [] as string[] });
  ipcMain.handle("reviews:importFiles", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择书评 Markdown 文件",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    try {
      return importFileReviews(D(), reviewDir(), r.filePaths);
    } catch (e) {
      return ioFail(e);
    }
  });
  ipcMain.handle("reviews:importFolder", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "选择放着书评 md 的文件夹",
      properties: ["openDirectory"]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return importFileReviews(D(), reviewDir(), listReviewMarkdown(r.filePaths[0]));
    } catch (e) {
      return ioFail(e);
    }
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
      return exportFileReviews(D(), reviewDir(), r.filePaths[0]);
    } catch (e) {
      return ioFail(e);
    }
  });
  ipcMain.handle("reviews:dirInfo", () => {
    const dir = reviewDir();
    let exist = false;
    let files = 0;
    if (dir) {
      try {
        const st = fs.lstatSync(dir);
        if (st.isDirectory()) {
          exist = true;
          files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).length;
        }
      } catch {
        exist = false;
      }
    }
    return { dir, exist, files, auto: true };
  });
  ipcMain.handle("reviews:sync", () => {
    if (!db || !lib) return null;
    try {
      const r = reconcileReviewFiles(D(), reviewDir());
      if (r) announceReviewsChanged();
      return r;
    } catch (e) {
      console.error("[review] 同步失败", e);
      return null;
    }
  });
  /* 把已经挂上书或系列的书评 md 改回规范名。只动名字，正文与关联都不动 */
  ipcMain.handle("reviews:rename", () => {
    if (!db || !lib) return null;
    try {
      const r = bulkEditReviewFiles(D(), reviewDir(), lib.backupDir, "rename");
      if (r) announceReviewsChanged();
      return r;
    } catch (e) {
      console.error("[review] 重命名失败", e);
      return null;
    }
  });
  /* 现有书评一次性补齐开头那块标签。只动开头，正文不动，动手前整目录备份一份 */
  ipcMain.handle("reviews:fillFront", () => {
    if (!db || !lib) return null;
    try {
      const r = bulkEditReviewFiles(D(), reviewDir(), lib.backupDir, "fill");
      if (r) announceReviewsChanged();
      return r;
    } catch (e) {
      console.error("[review] 补标签失败", e);
      return null;
    }
  });
  /* 撤销标签：删掉开头那块，并把开关关掉，之后不再自动写 */
  ipcMain.handle("reviews:stripFront", () => {
    if (!db || !lib) return null;
    try {
      const r = bulkEditReviewFiles(D(), reviewDir(), lib.backupDir, "strip");
      if (r) announceReviewsChanged();
      return r;
    } catch (e) {
      console.error("[review] 撤销标签失败", e);
      return null;
    }
  });
  ipcMain.handle("reviews:openDir", async () => {
    const dir = reviewDir();
    if (!dir) return false;
    try {
      if (!fs.lstatSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
    await shell.openPath(dir);
    return true;
  });

  /* ---- 备份恢复 ---- */
  ipcMain.handle("backup:now", async () => {
    if (!lib) return null;
    const flushed = await flushReviews("backup");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存成功" };
    const r = await dialog.showOpenDialog(win!, {
      title: "选择备份保存到哪里",
      buttonLabel: "备份到这个文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    if (r.canceled || !r.filePaths[0] || !lib) return null;
    try {
      const file = await backupReviewLibrary(D(), lib.reviewDir, r.filePaths[0]);
      announceBackupsChanged();
      announceReviewsChanged();
      return { ok: true, file };
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
  ipcMain.handle("backup:list", () => (lib ? listReviewBackups(lib.backupDir) : []));
  ipcMain.handle("backup:restore", async () => {
    if (!lib) return null;
    const r = await dialog.showOpenDialog(win!, {
      title: "选择要恢复的备份",
      properties: ["openFile"],
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "bak"] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const pick = r.filePaths[0];
    const snapshot = isReviewSnapshot(pick);
    const sure = await dialog.showMessageBox(win!, {
      type: "warning",
      buttons: ["取消", "覆盖并重启"],
      defaultId: 1,
      cancelId: 0,
      message: snapshot ? "用这份备份覆盖当前数据库和书评目录？" : "用这份备份覆盖当前数据库？",
      detail:
        pick +
        "\n\n" +
        (snapshot ? "数据库和书评目录会一起被替换。" : "只替换数据库文件，不会改动书评目录。") +
        "\n当前库会先自动备份一份到 backups 目录，然后软件重启。"
    });
    if (sure.response !== 1) return { ok: false, msg: "已取消" };
    const flushed = await flushReviews("restore");
    if (!flushed.ok) return { ok: false, msg: flushed.msg || "书评还没保存成功" };
    if (autoBackupTask) await autoBackupTask.catch(() => undefined);
    const savedLib = lib;
    const target = savedLib.dbFile;
    try {
      await backupReviewLibrary(D(), savedLib.reviewDir, savedLib.backupDir, "migration");
      const flushedAgain = await flushReviews("restore");
      if (!flushedAgain.ok) return { ok: false, msg: flushedAgain.msg || "书评还没保存成功" };
      stopWatch();
      closeDb();
      db = null;
      restoreReviewLibrary(pick, target, savedLib.reviewDir);
      app.relaunch();
      app.exit(0);
      return { ok: true, msg: "正在重启" };
    } catch (e) {
      try {
        const restored = openDb(target);
        db = restored;
        lib = savedLib;
        startWatch();
      } catch (re) {
        console.error("[backup] 恢复失败后重连书库失败", re);
      }
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
      const r = await openLibrary(start);
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
    if (process.platform !== "darwin") app.quit();
  });

  let quitAllowed = false;
  let quitFlushing = false;
  app.on("before-quit", (e) => {
    if (quitAllowed) {
      return;
    }
    e.preventDefault();
    if (quitFlushing) return;
    quitFlushing = true;
    void (async () => {
      try {
        const saved = await flushReviews("quit");
        if (!saved.ok) {
          await dialog.showMessageBox({
            type: "warning",
            buttons: ["知道了"],
            defaultId: 0,
            cancelId: 0,
            message: "书评还没保存成功",
            detail: (saved.msg || "有些修改没有写进书评文件。") + "\n\n这次退出已取消，请稍后重试。"
          });
          return;
        }
        if (autoBackupTask) await autoBackupTask.catch(() => undefined);
        appQuitting = true;
        quitAllowed = true;
        app.quit();
      } finally {
        quitFlushing = false;
      }
    })();
  });

  app.on("will-quit", () => {
    stopWatch();
    closeDb();
  });
}
