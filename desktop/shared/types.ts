/** 主进程与渲染进程共用的类型。改这里两边同时生效。 */

export type MediaType = "小说" | "漫画";

/* 排序键不再写死，自定义字段建出来就能拿来排 */
export type SortKey = string;

export interface SortSpec {
  key: SortKey;
  /** 1 升序，-1 降序 */
  dir: 1 | -1;
}

/* ---- 字段定义 ---- */

/** 十种字段类型。控件、排序依据、筛选方式都按它分派 */
export type FieldType =
  | "text"
  | "longtext"
  | "number"
  | "date"
  | "switch"
  | "rating"
  | "select"
  | "multiselect"
  | "image"
  | "ref";

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: "text", label: "文本" },
  { type: "longtext", label: "长文本" },
  { type: "number", label: "数字" },
  { type: "date", label: "日期" },
  { type: "switch", label: "是否" },
  { type: "rating", label: "评分" },
  { type: "select", label: "单选" },
  { type: "multiselect", label: "多选" },
  { type: "image", label: "图片" },
  { type: "ref", label: "关联" }
];

export interface FieldOption {
  id: number;
  name: string;
  color: string;
  ord: number;
}

/** 字段定义。builtin 0 自定义，1 对应 books 表某一列，2 内建多对多，3 派生只读 */
export interface FieldDef {
  id: number;
  key: string;
  label: string;
  type: FieldType;
  builtin: number;
  col: string;
  /** 内建字段提交时用的补丁键，自定义字段为空，走 custom */
  patchKey: string;
  width: number;
  ord: number;
  inTable: boolean;
  searchable: boolean;
  filterable: boolean;
  deletedAt: string | null;
  /** 有多少本书填了这一项，字段管理页显示，删除前据此提示 */
  filled: number;
  options: FieldOption[];
}

export interface FieldInput {
  label: string;
  type: FieldType;
  /** 自己定 key，只有程序内部建字段用。不传就随机生成 */
  key?: string;
  options?: string[];
  inTable?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  width?: number;
}

export interface FieldPatch {
  label?: string;
  inTable?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  width?: number;
}

/** 改类型时拒绝的条目，界面上列出来给人看，不静默清空 */
export interface FieldReject {
  bookId: string;
  title: string;
  value: string;
}

export interface FieldResult {
  ok: boolean;
  id?: number;
  msg?: string;
  rejected?: FieldReject[];
}

/** 自定义字段的筛选条件。op 决定用 val 还是 num 还是 day 去比 */
export interface FieldFilter {
  key: string;
  op: "like" | "between" | "eq" | "has" | "yes" | "no";
  a?: string;
  b?: string;
}

export interface BookRow {
  id: string;
  title: string;
  subtitle: string;
  originalTitle: string;
  originalSubtitle: string;
  mediaType: string;
  seriesId: number | null;
  seriesName: string;
  seriesIndex: number | null;
  country: string;
  isMystery: boolean;
  publishDate: string;
  publishYear: number | null;
  isRead: boolean;
  readDate: string;
  rating: number | null;
  ebookState: string;
  note: string;
  cover: string;
  authors: string[];
  categories: string[];
  states: string[];
  reviewGrade: string | null;
  /** 自定义字段的值，一律给数组，多选就是多个元素。键是字段 key */
  custom: Record<string, string[]>;
}

/** 高级筛选的区间与存在性条件，面板里填，空值表示不限 */
export interface AdvFilter {
  ratingMin: number | null;
  ratingMax: number | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** true 只看有书评的，false 只看没书评的，null 不限 */
  hasReview: boolean | null;
  /** 备注关键词 */
  note: string;
  /** 自定义字段的筛选条件 */
  fvals: FieldFilter[];
}

export const EMPTY_ADV: AdvFilter = {
  ratingMin: null,
  ratingMax: null,
  yearFrom: null,
  yearTo: null,
  hasReview: null,
  note: "",
  fvals: []
};

export interface BookQuery {
  q?: string;
  media?: string;
  seriesId?: number | null;
  read?: "all" | "read" | "unread" | "rated";
  noCover?: boolean | null;
  categories?: string[];
  states?: string[];
  ebook?: string[];
  decades?: number[];
  /** 多字段排序，前一条相同再比下一条；不传则按书名 */
  sorts?: SortSpec[];
  adv?: AdvFilter;
  /** 自定义字段的筛选条件，一条一个 EXISTS */
  fvals?: FieldFilter[];
  offset?: number;
  limit?: number;
}

export interface ListResult {
  total: number;
  rows: BookRow[];
}

export interface FacetItem {
  name: string;
  n: number;
  tier?: number;
  ord?: number;
  id?: number;
  parentId?: number | null;
}

export interface Facets {
  media: FacetItem[];
  read: FacetItem[];
  cover: FacetItem[];
  categories: FacetItem[];
  series: { id: number; name: string; mediaType: string; n: number }[];
  states: FacetItem[];
  ebook: FacetItem[];
  decades: FacetItem[];
}

export interface SeriesAvg {
  avg: number | null;
  read: number;
  total: number;
}

/** 系列集合视图的一格 */
export interface SeriesInfo {
  id: number;
  name: string;
  /** 去掉尾部「系列 / シリーズ」的显示名 */
  label: string;
  mediaType: string;
  n: number;
  read: number;
  avg: number | null;
  cover: string;
  updatedAt: string;
}

export interface ReviewRow {
  id: number;
  bookId: string | null;
  seriesId: number | null;
  title: string;
  grade: string;
  md: string;
  fileName: string;
  happenedAt: string;
  updatedAt: string;
  /** 书评、系列总评、新建草稿、未匹配四种来源，id 各自独立，前端 key 要带上它 */
  kind: "book" | "series" | "draft" | "orphan";
  /** 系列总评带上系列显示名，导出文件名要用 */
  seriesLabel?: string;
  /** 所属书籍的作者，导出成「作者-《书名》书评.md」要用 */
  author?: string;
}

export interface ReviewInput {
  bookId?: string | null;
  seriesId?: number | null;
  name?: string;
  grade?: string;
  md?: string;
  happenedAt?: string;
}

export interface ReviewPatch {
  grade?: string;
  md?: string;
  happenedAt?: string;
  name?: string;
}

export interface RvResult {
  ok: boolean;
  id?: number;
  msg?: string;
}

/** 导入或同步一批 md 之后的汇总 */
export interface ReviewIoSummary {
  /** 匹配上并新建的书评 */
  added: number;
  /** 匹配上并更新了正文的 */
  updated: number;
  /** 没匹配上、进了未匹配池的 */
  orphan: number;
  /** 已有书评、同内容或同名，跳过的 */
  skipped: number;
  /** 写出去的篇数，导出与同步才有 */
  written: number;
  /** 目录里没了、库里跟着删掉的篇数，只有同步才有 */
  removed?: number;
  /** 在外面改了文件名、库里跟着改映射的篇数，只有同步才有 */
  renamed?: number;
  dir?: string;
  msgs: string[];
}

export interface AppInfo {
  version: string;
  dbFile: string;
  /** 书库文件夹。书、封面、书评、备份全在它里面 */
  libraryRoot: string;
  reviewDir: string;
  /** 还没选书库时为 false，界面出选择页 */
  hasLibrary: boolean;
  bookCount: number;
  reviewCount: number;
  orphanCount: number;
}

/** 一个书库文件夹的概况，选择书库时列出来用 */
export interface LibraryBrief {
  root: string;
  db: boolean;
  books: number;
  covers: number;
  reviews: number;
}

export interface LibraryOpenResult {
  ok: boolean;
  msg?: string;
  root?: string;
  books?: number;
}

/** 编辑书时只传改过的字段，其余保持原值。作者、分类、实体书传了就是整组重写 */
export interface BookPatch {
  title?: string;
  subtitle?: string;
  originalTitle?: string;
  originalSubtitle?: string;
  mediaType?: string;
  country?: string;
  publishDate?: string;
  isRead?: boolean;
  readDate?: string;
  rating?: number | null;
  ebookState?: string;
  note?: string;
  seriesName?: string;
  seriesIndex?: number | null;
  coverFile?: string;
  authors?: string[];
  categories?: string[];
  states?: string[];
  /** 自定义字段的值，键是字段 key，空数组表示清空。传了哪个键就整组重写哪个 */
  custom?: Record<string, string[]>;
}

export interface CatNode {
  id: number;
  name: string;
  parentId: number | null;
  tier: number;
  ord: number;
  n: number;
}

export interface CatResult {
  ok: boolean;
  id?: number;
  msg?: string;
}

export interface BackupResult {
  ok: boolean;
  file?: string;
  msg?: string;
}

/** 数据包导出/导入的结果，dir 是实际用的目录，covers 是这次搬运的封面张数 */
export interface PackResult {
  ok: boolean;
  dir?: string;
  covers?: number;
  msg?: string;
}

/** 搜到的一张候选。pic 是缩略图，image 是大图，落盘用大图 */
export interface CoverCandidate {
  id: string;
  title: string;
  authors: string;
  year: string;
  publisher: string;
  pic: string;
  image: string;
  /** 自动识别给的匹配分，手动搜出来的是 0 */
  score: number;
}

/** 条目详情。info 里是页面上那几行原样字段，键为中文标签 */
export interface CoverDetail {
  id: string;
  image: string;
  info: Record<string, string>;
}

/** 一次搜索结果。cached 表示这次没走网络，用的是二十四小时内的旧结果 */
export interface CoverSearchResult {
  ok: boolean;
  candidates: CoverCandidate[];
  cached?: boolean;
  msg?: string;
}

/** 落封面的结果。filled 是顺手补上的字段名，skipped 是有值没动的 */
export interface CoverApplyResult {
  ok: boolean;
  cover?: string;
  filled?: string[];
  skipped?: string[];
  msg?: string;
}

/** 批量识别的进度，前端按这个画条 */
export interface CoverBatchState {
  running: boolean;
  total: number;
  done: number;
  applied: number;
  queued: number;
  failed: number;
  /** 当前正在处理的书名，停下来时为空 */
  current: string;
  /** 停下来的原因，跑完或被限速打断 */
  stopReason?: string;
}

/** 待确认队列的一条。candidate 是打分最高的那张，score 没到阈值 */
export interface CoverQueueItem {
  bookId: string;
  title: string;
  authors: string;
  cover: string;
  candidate: CoverCandidate | null;
  score: number;
  createdAt: string;
}

export interface BooklibApi {
  info(): Promise<AppInfo>;

  /* 书库文件夹：一个文件夹装全部用户数据，换机器搬它就行 */
  libraryRecent(): Promise<LibraryBrief[]>;
  /** 弹目录选择框，里面有库就打开，没有就问一句在原地新建 */
  chooseLibrary(): Promise<LibraryOpenResult>;
  openLibrary(root: string): Promise<LibraryOpenResult>;
  /** 文档目录下的「我的书库」，没有就建 */
  defaultLibrary(): Promise<LibraryOpenResult>;
  revealLibrary(): Promise<boolean>;
  /** 把整个书库另存一份到别处，备份到移动硬盘用 */
  copyLibraryTo(): Promise<{ ok: boolean; msg?: string; files?: number; dir?: string } | null>;
  /** 外部改了 reviews 里的 md，主进程同步完之后通知界面重取 */
  onReviewsChanged(cb: () => void): () => void;

  listBooks(q: BookQuery): Promise<ListResult>;
  getBook(id: string): Promise<{ book: BookRow; review: { md: string; grade: string; happenedAt: string } | null } | null>;
  facets(media?: string): Promise<Facets>;
  seriesAvg(id: number): Promise<SeriesAvg>;
  seriesList(mediaType?: string): Promise<SeriesInfo[]>;
  seriesBooks(id: number): Promise<BookRow[]>;
  seriesReview(id: number): Promise<{ id: number; md: string; grade: string } | null>;
  reviews(): Promise<ReviewRow[]>;
  /** 单篇导出用的文件名，与落盘那份同一套规则（作者-《书名》书评.md / 作者-《系列名》系列.md） */
  reviewFileName(kind: string, id: number): Promise<string>;
  setRead(id: string, read: boolean): Promise<boolean>;
  setRating(id: string, rating: number | null): Promise<boolean>;
  updateBook(id: string, patch: BookPatch): Promise<BookRow | null>;
  deleteBook(id: string): Promise<boolean>;
  restoreBook(id: string): Promise<boolean>;
  copyBook(id: string): Promise<BookRow | null>;
  copyBooks(ids: string[]): Promise<BookRow[]>;
  categoryTree(): Promise<CatNode[]>;
  createCategory(name: string, parentId: number | null): Promise<CatResult>;
  renameCategory(id: number, name: string): Promise<CatResult>;
  setCategoryParent(id: number, parentId: number | null): Promise<CatResult>;
  removeCategory(id: number): Promise<CatResult>;
  moveCategory(id: number, dir: -1 | 1): Promise<CatResult>;
  createReview(p: ReviewInput): Promise<RvResult>;
  updateReview(kind: string, id: number, p: ReviewPatch): Promise<RvResult>;
  deleteReview(kind: string, id: number): Promise<RvResult>;
  associateOrphan(orphanId: number, bookId: string): Promise<RvResult>;
  /* kind 必须带：未匹配表的 id 与书评表各从 1 起，只给 id 会挂错那篇 */
  moveReview(kind: string, id: number, bookId: string): Promise<RvResult>;
  moveReviewToSeries(kind: string, id: number, seriesId: number): Promise<RvResult>;
  /** 把系列总评搬回单本 */
  moveReviewToBook(kind: string, id: number, bookId: string): Promise<RvResult>;

  /** 换封面与撤销，走主进程的文件对话框 */
  pickCover(bookId: string): Promise<{ ok: boolean; cover?: string; msg?: string }>;
  resetCover(bookId: string): Promise<{ ok: boolean; cover?: string; msg?: string }>;

  /** 书评导入导出。目录固定是书库里的 reviews，会自动同步 */
  importReviewFiles(): Promise<ReviewIoSummary | null>;
  importReviewFolder(): Promise<ReviewIoSummary | null>;
  exportReviews(): Promise<ReviewIoSummary | null>;
  reviewDirInfo(): Promise<{ dir: string; exist: boolean; files: number }>;
  syncReviewDir(): Promise<ReviewIoSummary | null>;
  /** 把已经挂上书或系列的书评 md 改回规范名，renamed 是改了几份 */
  renameReviewFiles(): Promise<ReviewIoSummary | null>;
  openReviewDir(): Promise<boolean>;

  /** 备份与恢复 */
  backupDb(): Promise<BackupResult | null>;
  openBackupDir(): Promise<boolean>;
  restoreDb(): Promise<BackupResult | null>;
  autoBackups(): Promise<{ file: string; size: number; at: string }[]>;

  /** 当前书库概况 */
  dataInfo(): Promise<{ dir: string; covers: number; bytes: number; books: number; reviews: number }>;

  /** 通用键值设置，主题、列设置、排序都存这里 */
  getSetting(key: string): Promise<string>;
  setSetting(key: string, value: string): Promise<boolean>;

  /** 字段定义。表格列、详情行、排序键、筛选控件都从这里取 */
  listFields(includeDeleted?: boolean): Promise<FieldDef[]>;
  createField(p: FieldInput): Promise<FieldResult>;
  updateField(id: number, p: FieldPatch): Promise<FieldResult>;
  /** 改类型，解析不了的值会返回 rejected 清单，不清空 */
  changeFieldType(id: number, type: FieldType): Promise<FieldResult>;
  removeField(id: number): Promise<FieldResult>;
  restoreField(id: number): Promise<FieldResult>;
  moveField(id: number, dir: -1 | 1): Promise<FieldResult>;
  addFieldOption(fieldId: number, name: string): Promise<FieldResult>;
  renameFieldOption(id: number, name: string): Promise<FieldResult>;
  removeFieldOption(id: number): Promise<FieldResult>;
  /** 图片类型字段选一张本地图，落进书库的 covers 目录，返回值就是文件名 */
  pickFieldImage(fieldKey: string, bookId: string): Promise<{ ok: boolean; name?: string; msg?: string } | null>;

  /** 按书名、作者或 ISBN 搜封面候选。十三位数字当 ISBN 走 /isbn/ 那条 */
  searchCovers(q: string): Promise<CoverSearchResult>;
  /** 取条目详情，选中时才调 */
  coverDetail(id: string): Promise<CoverDetail | null>;
  /** 候选缩略图。图片站认 Referer，界面直连会被挡，由主进程取回转成 data URL */
  coverThumb(url: string): Promise<string>;
  /** 把选中的候选下下来落盘，backfill 为真时顺带补空着的书目字段 */
  applyCover(bookId: string, hit: CoverCandidate, backfill: boolean): Promise<CoverApplyResult>;
  /** 批量识别缺封面的书，backfill 为真时顺手补空着的书目字段，进度用 onCoverProgress 推 */
  startCoverBatch(backfill: boolean): Promise<CoverBatchState>;
  stopCoverBatch(): Promise<CoverBatchState>;
  coverBatchState(): Promise<CoverBatchState>;
  onCoverProgress(cb: (s: CoverBatchState) => void): () => void;
  /** 待确认队列 */
  coverQueue(): Promise<CoverQueueItem[]>;
  acceptQueuedCover(bookId: string, backfill: boolean): Promise<CoverApplyResult>;
  skipQueuedCover(bookId: string): Promise<{ ok: boolean }>;
}
