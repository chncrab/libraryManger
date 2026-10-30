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

/* v5 字段成为数据。原来十八个字段散写在建表、类型定义、列定义、详情面板、
   表格单元格、更新语句六个地方，加一项要改六处。改成一张字段定义表之后，
   表格列、详情行、排序键、筛选控件全从这里取。
   builtin 0 是自定义字段，值存在 book_field_values；1 对应 books 表某一列，
   值仍在原列；2 是内建的多对多，值在各自的关联表，这里只登记占个位置；
   3 是派生只读，比如书评等级图标。
   选项单独成表不塞 JSON，改选项名才只动一行 */
const V5 = `
CREATE TABLE IF NOT EXISTS fields (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT 'text',
  builtin    INTEGER NOT NULL DEFAULT 0,
  col        TEXT NOT NULL DEFAULT '',
  patch_key  TEXT NOT NULL DEFAULT '',
  width      INTEGER NOT NULL DEFAULT 0,
  ord        INTEGER NOT NULL DEFAULT 0,
  in_table   INTEGER NOT NULL DEFAULT 1,
  searchable INTEGER NOT NULL DEFAULT 0,
  filterable INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS field_options (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id   INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '',
  ord        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fopts_field ON field_options(field_id, ord);

CREATE TABLE IF NOT EXISTS book_field_values (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL DEFAULT 0,
  val      TEXT NOT NULL DEFAULT '',
  num      REAL,
  day      TEXT,
  ref      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, field_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_bfv_field ON book_field_values(field_id, val);
CREATE INDEX IF NOT EXISTS idx_bfv_book  ON book_field_values(book_id);

/* ord 与宽度照搬升级前的固定列，升上来表格一格不差 */
INSERT OR IGNORE INTO fields (key, label, type, builtin, col, patch_key, width, ord, in_table, searchable, filterable) VALUES
  ('grade',            '书评',       'ref',         3, '',                  '',                44,  1, 1, 0, 0),
  ('title',            '书名',       'text',        1, 'title',             'title',          224,  2, 1, 1, 0),
  ('subtitle',         '副标题',     'text',        1, 'subtitle',          'subtitle',       150,  3, 1, 1, 0),
  ('originalTitle',    '原作名',     'text',        1, 'original_title',    'originalTitle',  200,  4, 1, 1, 0),
  ('originalSubtitle', '原作副标题', 'text',        1, 'original_subtitle', 'originalSubtitle',170, 5, 1, 1, 0),
  ('authors',          '作者',       'multiselect', 2, '',                  'authors',        116,  6, 1, 1, 0),
  ('media',            '媒介',       'select',      1, 'media_type',        'mediaType',       66,  7, 1, 0, 0),
  ('series',           '系列',       'ref',         1, 'series_id',         'seriesName',     168,  8, 1, 1, 0),
  ('index',            '卷',         'number',      1, 'series_index',      'seriesIndex',     54,  9, 1, 0, 0),
  ('country',          '国籍',       'text',        1, 'country',           'country',         70, 10, 1, 0, 0),
  ('publishDate',      '出版日期',   'date',        1, 'publish_date',      'publishDate',    100, 11, 1, 0, 0),
  ('read',             '已读',       'switch',      1, 'is_read',           'isRead',          46, 12, 1, 0, 0),
  ('readDate',         '阅读日期',   'date',        1, 'read_date',         'readDate',       100, 13, 1, 0, 0),
  ('rating',           '评分',       'rating',      1, 'rating',            'rating',          62, 14, 1, 0, 0),
  ('categories',       '分类',       'multiselect', 2, '',                  'categories',     168, 15, 1, 0, 0),
  ('states',           '实体书',     'multiselect', 2, '',                  'states',          80, 16, 1, 0, 0),
  ('ebook',            '电子书',     'select',      1, 'ebook_state',       'ebookState',      72, 17, 1, 0, 0),
  ('note',             '备注',       'longtext',    1, 'note',              'note',             0, 18, 0, 1, 0);

/* 内建字段的筛选在高级筛选中已经有专门控件（评分区间、出版年、书评），
   这里一律关掉可筛标记，免得面板里同一件事出现两次。自定义字段默认开 */

INSERT INTO field_options (field_id, name, ord) SELECT id, '小说', 1 FROM fields WHERE key = 'media';
INSERT INTO field_options (field_id, name, ord) SELECT id, '漫画', 2 FROM fields WHERE key = 'media';
INSERT INTO field_options (field_id, name, ord) SELECT id, '有', 1 FROM fields WHERE key = 'ebook';
INSERT INTO field_options (field_id, name, ord) SELECT id, '无', 2 FROM fields WHERE key = 'ebook';
INSERT INTO field_options (field_id, name, ord) SELECT id, '实体', 1 FROM fields WHERE key = 'states';
INSERT INTO field_options (field_id, name, ord) SELECT id, '私印', 2 FROM fields WHERE key = 'states';
INSERT INTO field_options (field_id, name, ord) SELECT id, '预定中', 3 FROM fields WHERE key = 'states';
INSERT INTO field_options (field_id, name, ord) SELECT id, '购物车', 4 FROM fields WHERE key = 'states';
INSERT INTO field_options (field_id, name, ord) SELECT id, '无', 5 FROM fields WHERE key = 'states';
`;

/* v6 全文索引加一列 extra，装自定义字段里勾了可搜索的那些。
   FTS5 加列要重建整张表，重建之后由 db/fts.ts 全库补一遍 */
const V6 = `
DROP TABLE IF EXISTS books_fts;
CREATE VIRTUAL TABLE books_fts USING fts5 (
  title, subtitle, original_title, authors, series, note, extra,
  tokenize = 'trigram'
);
`;

/* 封面识别的两张表。缓存按 kind 与关键词存整份响应，二十四小时内不再打豆瓣；
   队列存打分没过阈值的那些，关了程序也还在，下次接着处理 */
const V7 = `
CREATE TABLE IF NOT EXISTS cover_cache (
  kind       TEXT NOT NULL,
  q          TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (kind, q)
);

CREATE TABLE IF NOT EXISTS cover_queue (
  book_id    TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  candidate  TEXT NOT NULL DEFAULT '',
  score      REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", sql: V1 },
  { version: 2, name: "category_parent", sql: V2 },
  { version: 3, name: "preset_top_categories", sql: V3 },
  { version: 4, name: "settings_and_cover_history", sql: V4 },
  { version: 5, name: "fields_and_values", sql: V5 },
  { version: 6, name: "fts_extra_column", sql: V6 },
  { version: 7, name: "cover_cache_and_queue", sql: V7 }
];
