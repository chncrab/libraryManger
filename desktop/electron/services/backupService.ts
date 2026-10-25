import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db";

/**
 * 备份与恢复。WAL 模式下直接拷 .db 会漏掉还没落盘的页，
 * 所以先 checkpoint 再 backup，出来的是一份完整单文件。
 */
export async function backupTo(db: DB, file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.pragma("wal_checkpoint(TRUNCATE)");
  await db.backup(file);
}

/** 启动时自动备份一份，按文件名字典序留最近的 keep 份 */
export async function autoBackup(db: DB, dir: string, keep = 8): Promise<string | null> {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name =
      "library-" +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds()) +
      ".db";
    const file = path.join(dir, name);
    await backupTo(db, file);

    const olds = fs
      .readdirSync(dir)
      .filter((f) => /^library-\d{8}-\d{6}\.db$/.test(f))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
      try {
        fs.rmSync(path.join(dir, f));
      } catch {
        /* 删不掉就留着 */
      }
    }
    return file;
  } catch (e) {
    console.error("[backup] 自动备份失败", e);
    return null;
  }
}

export function listBackups(dir: string): { file: string; size: number; at: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { file: full, size: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
