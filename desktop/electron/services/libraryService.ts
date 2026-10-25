import fs from "node:fs";
import path from "node:path";

/**
 * 一个书库就是一个普通文件夹，里面装着自己全部的用户数据。
 * 换机器、重装软件只要把这个文件夹搬过去，软件里看到的东西一模一样。
 *
 *   我的书库/
 *     library.db     书目、作者、分类、评分、书评正文
 *     covers/        封面图
 *     reviews/       书评 markdown，与库双向同步
 *     backups/       每次启动自动留的库备份
 *     .booklib.json  标识文件，写清这是哪个版本的库
 *
 * 程序本身不碰这个文件夹之外的用户数据。软件的配置（记得哪个书库、窗口多大）
 * 放在 userData 里，那份丢了也不影响书。
 */

export interface LibraryPaths {
  root: string;
  dbFile: string;
  coverDir: string;
  reviewDir: string;
  backupDir: string;
  markFile: string;
}

export const MARK_NAME = ".booklib.json";
export const DB_NAME = "library.db";

export function pathsOf(root: string): LibraryPaths {
  const r = path.resolve(root);
  return {
    root: r,
    dbFile: path.join(r, DB_NAME),
    coverDir: path.join(r, "covers"),
    reviewDir: path.join(r, "reviews"),
    backupDir: path.join(r, "backups"),
    markFile: path.join(r, MARK_NAME)
  };
}

/** 目录建齐。重复调用没有副作用，打开旧库时也走一遍，缺什么补什么 */
export function ensureStructure(root: string): LibraryPaths {
  const p = pathsOf(root);
  for (const d of [p.root, p.coverDir, p.reviewDir, p.backupDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(p.markFile)) {
    fs.writeFileSync(
      p.markFile,
      JSON.stringify({ kind: "booklib-library", version: 1, createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
  return p;
}

/** 认库只看有没有 library.db。`.booklib.json` 只是标记，老的库没有也照开 */
export function isLibrary(root: string): boolean {
  try {
    return fs.existsSync(path.join(path.resolve(root), DB_NAME));
  } catch {
    return false;
  }
}

export function libraryEmpty(root: string): boolean {
  try {
    return fs.readdirSync(path.resolve(root)).length === 0;
  } catch {
    return false;
  }
}

/** 书库里各处的文件数，选择界面与自检用 */
export function survey(root: string): { db: boolean; books: number; covers: number; reviews: number } {
  const p = pathsOf(root);
  const count = (d: string, re?: RegExp) => {
    try {
      const all = fs.readdirSync(d);
      return re ? all.filter((f) => re.test(f)).length : all.length;
    } catch {
      return 0;
    }
  };
  return { db: fs.existsSync(p.dbFile), books: 0, covers: count(p.coverDir), reviews: count(p.reviewDir, /\.md$/i) };
}

/* ---- 软件自己的配置：只记「上次开的是哪个书库」，不记书 ---- */

export interface AppConfig {
  root: string;
  recent: string[];
}

export function readConfig(userData: string): AppConfig {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8")) as Partial<AppConfig>;
    return {
      root: typeof c.root === "string" ? c.root : "",
      recent: Array.isArray(c.recent) ? c.recent.filter((x) => typeof x === "string").slice(0, 8) : []
    };
  } catch {
    return { root: "", recent: [] };
  }
}

export function writeConfig(userData: string, cfg: AppConfig): void {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[config] 写不进去", e);
  }
}

export function rememberRoot(userData: string, root: string): AppConfig {
  const c = readConfig(userData);
  const r = path.resolve(root);
  const recent = [r, ...c.recent.filter((x) => path.resolve(x) !== r)].slice(0, 8);
  const next = { root: r, recent };
  writeConfig(userData, next);
  return next;
}

/** 记过但已经被删掉或挪走的书库，别在最近列表里留着误导人 */
export function pruneRecent(cfg: AppConfig): AppConfig {
  return { root: cfg.root, recent: cfg.recent.filter((r) => isLibrary(r)) };
}

/**
 * 自己走一遍目录，逐个文件复制并顺手计数。
 * 不用 fs.cpSync：它一次吞掉整棵子树，复制到哪一步、有多少个文件都拿不到，
 * 中途失败也没有可回退的细粒度信息。
 */
function copyTree(from: string, to: string): number {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    let n = 0;
    for (const name of fs.readdirSync(from)) {
      n += copyTree(path.join(from, name), path.join(to, name));
    }
    return n;
  }
  fs.copyFileSync(from, to);
  return 1;
}

/**
 * 整个书库复制一份到别处，用于备份到移动硬盘或换机器。
 * backups 不跟着走，那是这台机器的历史，搬过去只会占地方。
 * library.db 的 -wal/-shm 跟着一起走，库里还开着的时候靠这两个文件恢复。
 */
export function copyLibrary(srcRoot: string, target: string): { ok: boolean; msg?: string; files: number } {
  const src = path.resolve(srcRoot);
  const dst = path.resolve(target);
  if (src === dst) return { ok: false, msg: "目标就是当前书库", files: 0 };
  if (dst.startsWith(src + path.sep)) return { ok: false, msg: "不能复制到书库自己里面", files: 0 };
  if (!isLibrary(src)) return { ok: false, msg: "当前书库不完整，找不到 library.db", files: 0 };
  try {
    fs.mkdirSync(dst, { recursive: true });
    let files = 0;
    for (const name of fs.readdirSync(src)) {
      if (name === "backups") continue;
      files += copyTree(path.join(src, name), path.join(dst, name));
    }
    return { ok: true, files };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e), files: 0 };
  }
}
