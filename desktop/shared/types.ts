/** 主进程与渲染进程共用的类型。改这里两边同时生效。 */

export type MediaType = "小说" | "漫画";

export type SortKey =
  | "title"
  | "author"
  | "series"
  | "index"
  | "rating"
  | "read"
  | "year"
  | "updated"
  | "grade";

export interface SortSpec {
  key: SortKey;
  /** 1 升序，-1 降序 */
  dir: 1 | -1;
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
}

export const EMPTY_ADV: AdvFilter = {
  ratingMin: null,
  ratingMax: null,
  yearFrom: null,
  yearTo: null,
  hasReview: null,
  note: ""
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
}
