import type { DB } from "../db";

/** 跟着数据库走的键值设置。书评同步目录、备份策略这类换机器要一起迁的放这里 */
export function getSetting(db: DB, key: string, def = ""): string {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return r ? String(r.value) : def;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value ?? ""));
}

export function delSetting(db: DB, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
