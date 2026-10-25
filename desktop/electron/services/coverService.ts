import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";

export interface CoverResult {
  ok: boolean;
  cover?: string;
  msg?: string;
}

/** 文件名里不能出现的字符换成下划线，空白压成一个 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}

/**
 * 封面的名字就是书本身：作者-作品名-系列序号，没有序号就省掉尾巴。
 * 一张图对应哪本书看得见，把文件夹拿出去也能对上号。
 */
export function coverBaseName(db: DB, bookId: string): string {
  const r = db
    .prepare(
      `SELECT b.title, b.series_index AS idx,
              (SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                WHERE ba.book_id = b.id ORDER BY ba.ord LIMIT 1) AS author
         FROM books b WHERE b.id = ?`
    )
    .get(bookId) as any;
  if (!r) return "";
  const author = String(r.author || "").trim();
  const title = String(r.title || "").trim();
  const idx = r.idx == null ? "" : String(r.idx);
  const parts = [author, title || "未命名", idx].filter((x) => x !== "");
  return sanitize(parts.join("-"));
}

/**
 * 不撞车的文件名。别的书占了这个名字、或者目录里已经躺着同名文件，就往后加 -2 -3。
 * 自己现在这张不算占用，换图时允许覆盖，撤销靠 cover_history 里另一份。
 */
export function uniqueCoverName(db: DB, bookId: string, coversDir: string, ext: string): string {
  const base = coverBaseName(db, bookId) || bookId;
  const self = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  const owned = new Set(
    (db.prepare("SELECT cover_file FROM books WHERE cover_file <> '' AND id <> ?").all(bookId) as any[]).map((r) =>
      String(r.cover_file)
    )
  );
  const hist = db.prepare("SELECT orig_file FROM cover_history WHERE book_id = ?").get(bookId) as any;
  if (hist && hist.orig_file) owned.add(String(hist.orig_file));

  let name = base + ext;
  let i = 2;
  while (owned.has(name) || (coversDir && name !== (self && self.cover_file) && fs.existsSync(path.join(coversDir, name)))) {
    name = base + "-" + i + ext;
    i++;
  }
  return name;
}

/**
 * 原图暂放的位置。封面名由书名派生，换图时新名与当前这张同名，
 * 先把原图挪到「-原图」上，撤销才退得回去。
 */
function holdFor(coversDir: string, name: string, ext: string): string {
  const stem = name.slice(0, name.length - ext.length);
  let cand = stem + "-原图" + ext;
  let i = 2;
  while (fs.existsSync(path.join(coversDir, cand))) cand = stem + "-原图" + i++ + ext;
  return cand;
}

/**
 * 书名、作者、系列序号变了以后，封面文件跟着改名。
 * 这是真改名，不重新生成图片；历史里那一份若指着旧名也一并改过来。
 */
export function renameCoverFor(db: DB, bookId: string, coversDir: string): string {
  const b = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  if (!b || !b.cover_file) return "";
  const old = String(b.cover_file);
  const from = path.join(coversDir, path.basename(old));
  if (!fs.existsSync(from)) return old;

  const ext = (path.extname(old) || ".jpg").toLowerCase();
  const want = uniqueCoverName(db, bookId, coversDir, ext);
  if (want === old) return old;

  const to = path.join(coversDir, want);
  try {
    if (fs.existsSync(to)) fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  } catch {
    return old;
  }
  const t = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare("UPDATE books SET cover_file = ?, updated_at = ? WHERE id = ?").run(want, t, bookId);
    db.prepare("UPDATE cover_history SET orig_file = ? WHERE book_id = ? AND orig_file = ?").run(want, bookId, old);
  });
  run();
  return want;
}

/**
 * 换封面：把选中的图片拷进库旁的 covers 目录，改 books.cover_file。
 * 第一次替换前把原来的文件名记进 cover_history，撤销时退回去；
 * 再次替换时删掉上一张自定义图，历史仍指向最初那张，不越退越乱。
 *
 * 封面名由书名派生，换图时新名字往往就是当前这张的名字，
 * 直接写下去会把原图盖掉、撤销时无图可退，所以先把原图挪到「-原图」位上。
 */
export function setCoverFromFile(db: DB, bookId: string, src: string, coversDir: string): CoverResult {
  const b = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  if (!b) return { ok: false, msg: "书不存在" };
  if (!fs.existsSync(src)) return { ok: false, msg: "找不到这张图片" };

  const ext = (path.extname(src) || ".jpg").toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext)) {
    return { ok: false, msg: "只支持 jpg、png、webp、gif、bmp" };
  }
  fs.mkdirSync(coversDir, { recursive: true });
  const name = uniqueCoverName(db, bookId, coversDir, ext);

  const t = new Date().toISOString();
  const hist = db.prepare("SELECT orig_file FROM cover_history WHERE book_id = ?").get(bookId) as any;
  const cur = b.cover_file ? path.basename(String(b.cover_file)) : "";
  const curPath = cur ? path.join(coversDir, cur) : "";
  /* 当前这张就是「原图」时，同名覆盖前先把它挪开 */
  const isOrig = hist ? String(hist.orig_file || "") === cur : !!cur;
  let hold = "";
  if (isOrig && cur === name && !!curPath && fs.existsSync(curPath)) {
    const cand = holdFor(coversDir, name, ext);
    try {
      fs.renameSync(curPath, path.join(coversDir, cand));
      hold = cand;
    } catch {
      hold = "";
    }
  }

  const run = db.transaction(() => {
    if (!hist) {
      db.prepare("INSERT INTO cover_history (book_id, orig_file, replaced_at) VALUES (?, ?, ?)").run(
        bookId,
        hold || b.cover_file || "",
        t
      );
    } else if (hold) {
      db.prepare("UPDATE cover_history SET orig_file = ? WHERE book_id = ?").run(hold, bookId);
    } else if (b.cover_file && b.cover_file !== hist.orig_file && b.cover_file !== name) {
      /* 上一张是自己换的，留着没用，删掉省空间 */
      const old = path.join(coversDir, path.basename(b.cover_file));
      if (fs.existsSync(old)) {
        try {
          fs.rmSync(old);
        } catch {
          /* 占用中就算了 */
        }
      }
    }
    fs.copyFileSync(src, path.join(coversDir, name));
    db.prepare("UPDATE books SET cover_file = ?, updated_at = ? WHERE id = ?").run(name, t, bookId);
  });
  run();
  return { ok: true, cover: name };
}

/** 撤销自定义封面，退回替换前那张。本来就没封面的退回空 */
export function resetCover(db: DB, bookId: string, coversDir: string): CoverResult {
  const hist = db.prepare("SELECT orig_file FROM cover_history WHERE book_id = ?").get(bookId) as any;
  const b = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  if (!b) return { ok: false, msg: "书不存在" };
  if (!hist) return { ok: false, msg: "这本书没有换过封面" };
  const orig = String(hist.orig_file || "");

  if (b.cover_file && b.cover_file !== orig) {
    const p = path.join(coversDir, path.basename(b.cover_file));
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p);
      } catch {
        /* 占用中就算了 */
      }
    }
  }

  /* 原图可能停在「-原图」位上，退回去时按当前书名重新算规范名 */
  let final = orig;
  if (orig && coversDir) {
    const from = path.join(coversDir, path.basename(orig));
    if (fs.existsSync(from)) {
      const ext = (path.extname(orig) || ".jpg").toLowerCase();
      db.prepare("UPDATE books SET cover_file = ? WHERE id = ?").run(orig, bookId);
      /* 这条历史到此为止，先摘掉再算名字。留着它等于告诉命名函数
         「这张图被别人占了」，恢复的正是自己那张，会平白让位成 -2 */
      db.prepare("DELETE FROM cover_history WHERE book_id = ?").run(bookId);
      const want = uniqueCoverName(db, bookId, coversDir, ext);
      if (want !== orig) {
        try {
          fs.renameSync(from, path.join(coversDir, want));
          final = want;
        } catch {
          final = orig;
        }
      }
    }
  }

  const t = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare("UPDATE books SET cover_file = ?, updated_at = ? WHERE id = ?").run(final, t, bookId);
    db.prepare("DELETE FROM cover_history WHERE book_id = ?").run(bookId);
  });
  run();
  return { ok: true, cover: hist.orig_file || "" };
}

/** 复制条目时给副本一份独立图片，改副本的封面不会动到原书 */
export function copyCoverFor(db: DB, fromBookId: string, toBookId: string, coversDir: string): string {
  const src = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(fromBookId) as any;
  const old = src && src.cover_file ? String(src.cover_file) : "";
  if (!old) return "";
  const from = path.join(coversDir, path.basename(old));
  if (!fs.existsSync(from)) return old;
  const ext = (path.extname(old) || ".jpg").toLowerCase();
  const name = uniqueCoverName(db, toBookId, coversDir, ext);
  try {
    fs.copyFileSync(from, path.join(coversDir, name));
  } catch {
    return old;
  }
  db.prepare("UPDATE books SET cover_file = ? WHERE id = ?").run(name, toBookId);
  return name;
}
