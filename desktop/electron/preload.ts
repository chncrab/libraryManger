import { contextBridge, ipcRenderer } from "electron";
import type {
  BooklibApi,
  BookPatch,
  BookQuery,
  CoverBatchState,
  CoverCandidate,
  FieldInput,
  FieldPatch,
  FieldType,
  LibraryView,
  ReviewInput,
  ReviewPatch,
  SeriesPatch,
  SeriesQuery
} from "../shared/types";

const api: BooklibApi = {
  info: () => ipcRenderer.invoke("app:info"),
  setWindowTheme: (theme) => ipcRenderer.invoke("app:windowTheme", theme),

  libraryRecent: () => ipcRenderer.invoke("library:recent"),
  chooseLibrary: () => ipcRenderer.invoke("library:choose"),
  openLibrary: (root: string) => ipcRenderer.invoke("library:open", root),
  defaultLibrary: () => ipcRenderer.invoke("library:default"),
  revealLibrary: () => ipcRenderer.invoke("library:reveal"),
  copyLibraryTo: () => ipcRenderer.invoke("library:copyTo"),
  onReviewsChanged: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on("library:reviews-changed", fn);
    return () => ipcRenderer.removeListener("library:reviews-changed", fn);
  },
  readReview: (kind: string, id: number) => ipcRenderer.invoke("reviews:read", kind, id),
  searchReviewText: (q: string) => ipcRenderer.invoke("reviews:search", q),
  stageReview: (kind: string, id: number, p: ReviewPatch, immediate?: boolean) =>
    ipcRenderer.invoke("reviews:stage", kind, id, p, immediate),
  flushReviews: () => ipcRenderer.invoke("reviews:flush"),
  onReviewSaveState: (cb: (kind: string, id: number, result: any) => void) => {
    const fn = (_e: unknown, kind: string, id: number, result: any) => cb(kind, id, result);
    ipcRenderer.on("reviews:saveState", fn);
    return () => ipcRenderer.removeListener("reviews:saveState", fn);
  },

  listBooks: (q: BookQuery) => ipcRenderer.invoke("books:list", q),
  suggestBookField: (q, field, prefix, seriesMode) => ipcRenderer.invoke("books:fieldSuggestions", q, field, prefix, seriesMode),
  getBook: (id: string) => ipcRenderer.invoke("books:get", id),
  facets: (media?: string) => ipcRenderer.invoke("books:facets", media),
  seriesAvg: (id: number) => ipcRenderer.invoke("series:avg", id),
  seriesList: (query?: string | SeriesQuery) => ipcRenderer.invoke("series:list", query),
  seriesBooks: (id: number) => ipcRenderer.invoke("series:books", id),
  seriesReview: (id: number) => ipcRenderer.invoke("series:review", id),
  seriesUpdate: (id: number, patch: SeriesPatch) => ipcRenderer.invoke("series:update", id, patch),
  readTimeline: (media?: string) => ipcRenderer.invoke("read:timeline", media),
  readStats: (media?: string) => ipcRenderer.invoke("read:stats", media),
  reviews: () => ipcRenderer.invoke("reviews:list"),
  reviewFileName: (kind: string, id: number) => ipcRenderer.invoke("reviews:fileName", kind, id),
  setRead: (id: string, read: boolean) => ipcRenderer.invoke("books:setRead", id, read),
  setRating: (id: string, rating: number | null) => ipcRenderer.invoke("books:setRating", id, rating),
  updateBook: (id: string, patch: BookPatch) => ipcRenderer.invoke("books:update", id, patch),
  deleteBook: (id: string) => ipcRenderer.invoke("books:delete", id),
  restoreBook: (id: string) => ipcRenderer.invoke("books:restore", id),
  copyBook: (id: string) => ipcRenderer.invoke("books:copy", id),
  copyBooks: (ids: string[]) => ipcRenderer.invoke("books:copyMany", ids),
  newBookOptions: () => ipcRenderer.invoke("books:newOptions"),
  createBooks: (p) => ipcRenderer.invoke("books:create", p),
  categoryTree: () => ipcRenderer.invoke("cats:tree"),
  createCategory: (name, parentId, color) => ipcRenderer.invoke("cats:create", name, parentId, color),
  setCategoryColor: (id, color) => ipcRenderer.invoke("cats:color", id, color),
  onCategoryRenamed: (callback) => {
    const fn = (_event: Electron.IpcRendererEvent, before: string, after: string) => callback(before, after);
    ipcRenderer.on("cats:renamed", fn);
    return () => ipcRenderer.removeListener("cats:renamed", fn);
  },
  renameCategory: (id: number, name: string) => ipcRenderer.invoke("cats:rename", id, name),
  setCategoryParent: (id: number, parentId: number | null) => ipcRenderer.invoke("cats:parent", id, parentId),
  removeCategory: (id: number) => ipcRenderer.invoke("cats:remove", id),
  moveCategory: (id: number, dir: -1 | 1) => ipcRenderer.invoke("cats:move", id, dir),
  createReview: (p: ReviewInput) => ipcRenderer.invoke("reviews:create", p),
  updateReview: (kind: string, id: number, p: ReviewPatch) => ipcRenderer.invoke("reviews:update", kind, id, p),
  deleteReview: (kind: string, id: number) => ipcRenderer.invoke("reviews:delete", kind, id),
  associateOrphan: (oid: number, bookId: string) => ipcRenderer.invoke("reviews:associateOrphan", oid, bookId),
  moveReview: (kind: string, id: number, bookId: string) => ipcRenderer.invoke("reviews:move", kind, id, bookId),
  moveReviewToSeries: (kind: string, id: number, seriesId: number) =>
    ipcRenderer.invoke("reviews:moveToSeries", kind, id, seriesId),
  moveReviewToBook: (kind: string, id: number, bookId: string) =>
    ipcRenderer.invoke("reviews:moveToBook", kind, id, bookId),

  pickCover: (bookId: string) => ipcRenderer.invoke("covers:pick", bookId),
  resetCover: (bookId: string) => ipcRenderer.invoke("covers:reset", bookId),

  searchCovers: (q: string) => ipcRenderer.invoke("covers:search", q),
  coverDetail: (id: string) => ipcRenderer.invoke("covers:detail", id),
  coverThumb: (url: string) => ipcRenderer.invoke("covers:thumb", url),
  applyCover: (bookId: string, hit: CoverCandidate, backfill: boolean) =>
    ipcRenderer.invoke("covers:apply", bookId, hit, !!backfill),
  startCoverBatch: (backfill: boolean) => ipcRenderer.invoke("covers:batchStart", !!backfill),
  stopCoverBatch: () => ipcRenderer.invoke("covers:batchStop"),
  coverBatchState: () => ipcRenderer.invoke("covers:batchState"),
  onCoverProgress: (cb: (s: CoverBatchState) => void) => {
    const fn = (_e: unknown, s: CoverBatchState) => cb(s);
    ipcRenderer.on("covers:batchProgress", fn);
    return () => ipcRenderer.removeListener("covers:batchProgress", fn);
  },
  coverQueue: () => ipcRenderer.invoke("covers:queue"),
  acceptQueuedCover: (bookId: string, backfill: boolean) =>
    ipcRenderer.invoke("covers:queueAccept", bookId, !!backfill),
  skipQueuedCover: (bookId: string) => ipcRenderer.invoke("covers:queueSkip", bookId),

  importReviewFiles: () => ipcRenderer.invoke("reviews:importFiles"),
  importReviewFolder: () => ipcRenderer.invoke("reviews:importFolder"),
  exportReviews: () => ipcRenderer.invoke("reviews:export"),
  reviewDirInfo: () => ipcRenderer.invoke("reviews:dirInfo"),
  syncReviewDir: () => ipcRenderer.invoke("reviews:sync"),
  renameReviewFiles: () => ipcRenderer.invoke("reviews:rename"),
  fillReviewFront: () => ipcRenderer.invoke("reviews:fillFront"),
  stripReviewFront: () => ipcRenderer.invoke("reviews:stripFront"),
  openReviewDir: () => ipcRenderer.invoke("reviews:openDir"),

  backupDb: () => ipcRenderer.invoke("backup:now"),
  openBackupDir: () => ipcRenderer.invoke("backup:openDir"),
  restoreDb: () => ipcRenderer.invoke("backup:restore"),
  autoBackups: () => ipcRenderer.invoke("backup:list"),

  dataInfo: () => ipcRenderer.invoke("data:info"),

  getSetting: (key: string) => ipcRenderer.invoke("settings:get", key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke("settings:set", key, value),
  views: () => ipcRenderer.invoke("views:list"),
  saveViews: (views: LibraryView[], expectedRoot?: string) => ipcRenderer.invoke("views:save", views, expectedRoot),

  listFields: (includeDeleted?: boolean) => ipcRenderer.invoke("fields:list", !!includeDeleted),
  createField: (p: FieldInput) => ipcRenderer.invoke("fields:create", p),
  updateField: (id: number, p: FieldPatch) => ipcRenderer.invoke("fields:update", id, p),
  changeFieldType: (id: number, type: FieldType) => ipcRenderer.invoke("fields:type", id, type),
  removeField: (id: number) => ipcRenderer.invoke("fields:remove", id),
  restoreField: (id: number) => ipcRenderer.invoke("fields:restore", id),
  moveField: (id: number, dir: -1 | 1) => ipcRenderer.invoke("fields:move", id, dir),
  addFieldOption: (fieldId: number, name: string) => ipcRenderer.invoke("fields:addOption", fieldId, name),
  renameFieldOption: (id: number, name: string) => ipcRenderer.invoke("fields:renameOption", id, name),
  removeFieldOption: (id: number) => ipcRenderer.invoke("fields:removeOption", id),
  pickFieldImage: (fieldKey: string, bookId: string) => ipcRenderer.invoke("fields:pickImage", fieldKey, bookId)
};

contextBridge.exposeInMainWorld("api", api);
