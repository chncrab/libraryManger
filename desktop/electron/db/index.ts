import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";
import { ensureFts } from "./fts";

export type DB = Database.Database;

let db: DB | null = null;

export function dbFile(): string {
  const custom = process.env.LIBRARY_DB;
  if (custom) return path.resolve(custom);
  return path.join(process.env.APPDATA || process.cwd(), "藏书库", "library.db");
}

export function openDb(file = dbFile()): DB {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("synchronous = NORMAL");
  migrate(conn);
  db = conn;
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function migrate(conn: DB): void {
  conn.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', applied_at TEXT NOT NULL)"
  );
  const done = new Set<number>(
    conn.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const run = conn.transaction(() => {
      conn.exec(m.sql);
      conn
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, new Date().toISOString());
    });
    run();
    console.log(`[db] 已执行迁移 ${m.version} ${m.name}`);
  }
  /* 新索引表建出来是空的，补一遍，否则搜索会一本都搜不到 */
  ensureFts(conn);
}

export function isEmpty(conn: DB): boolean {
  const row = conn.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number };
  return row.n === 0;
}
