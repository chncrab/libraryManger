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
 * 自己现在这张不算占用，换图时允许直接覆盖。
 */
export function uniqueCoverName(db: DB, bookId: string, coversDir: string, ext: string): string {
  const base = coverBaseName(db, bookId) || bookId;
  const self = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  const owned = new Set(
    (db.prepare("SELECT cover_file FROM books WHERE cover_file <> '' AND id <> ?").all(bookId) as any[]).map((r) =>
      String(r.cover_file)
    )
  );

  let name = base + ext;
  let i = 2;
  while (owned.has(name) || (coversDir && name !== (self && self.cover_file) && fs.existsSync(path.join(coversDir, name)))) {
    name = base + "-" + i + ext;
    i++;
  }
  return name;
}

/**
 * 书名、作者、系列序号变了以后，封面文件跟着改名。
 * 这是真改名，不重新生成图片。
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
  db.prepare("UPDATE books SET cover_file = ?, updated_at = ? WHERE id = ?").run(want, t, bookId);
  return want;
}

/**
 * 换封面：把选中的图片拷进库旁的 covers 目录，改 books.cover_file。
 * 一本一张，换下来的旧图当场删掉，目录里不留副本。
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
  const dest = path.join(coversDir, name);
  const cur = b.cover_file ? path.basename(String(b.cover_file)) : "";

  /* 选中的就是目录里这一张时，拷自己会报错，跳过拷贝 */
  try {
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
  } catch {
    return { ok: false, msg: "图片写不进封面目录" };
  }

  const t = new Date().toISOString();
  db.prepare("UPDATE books SET cover_file = ?, updated_at = ? WHERE id = ?").run(name, t, bookId);

  /* 换了名字的旧图删掉；同名的话上面那次拷贝已经把它盖掉了 */
  if (cur && cur !== name) {
    const old = path.join(coversDir, cur);
    if (fs.existsSync(old)) {
      try {
        fs.rmSync(old, { force: true });
      } catch {
        /* 占用中就算了 */
      }
    }
  }
  return { ok: true, cover: name };
}

/** 移除封面：文件删掉，cover_file 置空，回到没有封面的状态 */
export function resetCover(db: DB, bookId: string, coversDir: string): CoverResult {
  const b = db.prepare("SELECT cover_file FROM books WHERE id = ?").get(bookId) as any;
  if (!b) return { ok: false, msg: "书不存在" };
  const cur = b.cover_file ? path.basename(String(b.cover_file)) : "";
  if (!cur) return { ok: false, msg: "这本书没有封面" };

  db.prepare("UPDATE books SET cover_file = '', updated_at = ? WHERE id = ?").run(new Date().toISOString(), bookId);
  /* 副本可能还指着这张图，别人在用就只摘引用 */
  const shared = db.prepare("SELECT COUNT(*) AS n FROM books WHERE cover_file = ?").get(cur) as any;
  if (Number((shared && shared.n) || 0) === 0) {
    const p = path.join(coversDir, cur);
    if (fs.existsSync(p)) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 占用中就算了 */
      }
    }
  }
  return { ok: true, cover: "" };
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
