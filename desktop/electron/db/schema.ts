/**
 * 数据库结构。每个版本一段 SQL，按 schema_migrations 里没跑过的顺序执行。
 * 改结构一律新增一段，不要改已发布的段落。
 */

export type Migration = { version: number; name: string; sql: string };

const V1 = `
CREATE TABLE IF NOT EXISTS series (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type   TEXT NOT NULL DEFAULT '小说',
  name         TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  total_volumes INTEGER,
  note         TEXT NOT NULL DEFAULT '',
  UNIQUE (media_type, name)
);

CREATE TABLE IF NOT EXISTS authors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  name_norm TEXT NOT NULL DEFAULT '',
  country   TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tier INTEGER NOT NULL DEFAULT 0,
  ord  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS books (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  subtitle          TEXT NOT NULL DEFAULT '',
  original_title    TEXT NOT NULL DEFAULT '',
  original_subtitle TEXT NOT NULL DEFAULT '',
  media_type        TEXT NOT NULL DEFAULT '小说',
  series_id         INTEGER REFERENCES series(id),
  series_index      INTEGER,
  country           TEXT NOT NULL DEFAULT '',
  is_mystery        INTEGER NOT NULL DEFAULT 0,
  publish_date      TEXT NOT NULL DEFAULT '',
  publish_year      INTEGER,
  is_read           INTEGER NOT NULL DEFAULT 0,
  read_date         TEXT NOT NULL DEFAULT '',
  rating            REAL,
  ebook_state       TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  cover_file        TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_media   ON books(media_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_books_series  ON books(series_id, series_index);
CREATE INDEX IF NOT EXISTS idx_books_read    ON books(is_read);
CREATE INDEX IF NOT EXISTS idx_books_title   ON books(title);

CREATE TABLE IF NOT EXISTS book_authors (
  book_id   TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  role      TEXT NOT NULL DEFAULT '著',
  ord       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, author_id, role)
);

CREATE TABLE IF NOT EXISTS book_categories (
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (book_id, category_id)
);

CREATE TABLE IF NOT EXISTS book_states (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  state   TEXT NOT NULL,
  PRIMARY KEY (book_id, state)
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (book_id, tag_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    TEXT REFERENCES books(id) ON DELETE CASCADE,
  series_id  INTEGER REFERENCES series(id) ON DELETE CASCADE,
  md         TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  grade      TEXT NOT NULL DEFAULT 'normal',
  happened_at TEXT NOT NULL DEFAULT '',
  file_name  TEXT NOT NULL DEFAULT '',
  origin     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_book   ON reviews(book_id) WHERE book_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_series ON reviews(series_id) WHERE series_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS orphan_reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  title_guess TEXT NOT NULL DEFAULT '',
  md         TEXT NOT NULL DEFAULT '',
  grade      TEXT NOT NULL DEFAULT 'normal',
  happened_at TEXT NOT NULL DEFAULT '',
  file_name  TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name  TEXT NOT NULL DEFAULT '',
  file_hash  TEXT NOT NULL DEFAULT '',
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_ok    INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  report     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5 (
  title, subtitle, original_title, authors, series, note,
  tokenize = 'trigram'
);
`;

/* v2 分类改成真正的两级树：大分类挂小标签，去掉原来靠 tier 猜层级的做法。
   分类管理还需要记录被软删的书引用过哪些分类，所以 book_categories 不动，
   删分类前用引用计数拦一道 */
const V2 = `
ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id, ord);
UPDATE categories SET tier = 0 WHERE tier IS NULL;
`;

/* v3 预置三个大分类，把原来的 28 个标签按层级挂进去。
   大分类只作分组，书仍然只挂叶子标签；筛选点大分类时在查询里展开子树。
   ord 保留标签原有顺序，父子两级的排序各看各的 */
const V3 = `
INSERT OR IGNORE INTO categories (name, tier, ord) VALUES ('地区', 0, 0);
INSERT OR IGNORE INTO categories (name, tier, ord) VALUES ('题材', 0, 1);
INSERT OR IGNORE INTO categories (name, tier, ord) VALUES ('细分题材', 0, 2);

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = '地区')
 WHERE name IN ('日本', '中国', '欧美');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = '题材')
 WHERE name IN ('推理', '悬疑', '科幻', '奇幻', '轻小说', '网络文学', '恋爱',
                '爱情', '历史', '经典', '武侠', '私小说', '童话');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE name = '细分题材')
 WHERE name IN ('校园', '体育', '喜剧', '励志', '职场', '家庭', '青春',
                '恐怖', '摇滚', '科普', '画集', '官能');

-- 挂了父级的就是第二层，tier 统一成 1，免得老数据的 0/1/2 与新层级打架
UPDATE categories SET tier = 1 WHERE parent_id IS NOT NULL;
`;

/* v4 键值设置与封面替换历史。
   settings 存书评同步目录、上次备份时间这类跟随数据库走的状态，换机器一起迁走；
   cover_history 记第一次换封面之前用的是哪张图，撤销时才能退回原图 */
const V4 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cover_history (
  book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  orig_file   TEXT NOT NULL DEFAULT '',
  replaced_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", sql: V1 },
  { version: 2, name: "category_parent", sql: V2 },
  { version: 3, name: "preset_top_categories", sql: V3 },
  { version: 4, name: "settings_and_cover_history", sql: V4 }
];
