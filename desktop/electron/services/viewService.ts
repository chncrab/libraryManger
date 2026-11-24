import type { DB } from "../db";
import type {
  LibraryView,
  ReadFilter,
  ViewConfigResult,
  ViewLayout,
  ViewSaveResult,
  ViewUnit
} from "../../shared/types";
import { FIXED_VIEW_ID, VIEW_CONFIG_KEY, VIEW_PRESETS } from "../../shared/types";
import { setSetting } from "./settingsService";

/**
 * 自定义书库视图的读写。配置跟着书库存进 settings，换书库就换一套。
 * 「全部」不在这里，它由界面虚拟出来；配置里出现这个固定 ID 一律拒绝。
 */

const READ_VALUES: ReadFilter[] = ["all", "read", "unread", "rated"];
const UNITS: ViewUnit[] = ["book", "series"];
const LAYOUTS: ViewLayout[] = ["shelf", "table"];

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 预设置只初始化一次，这里给的是副本，别把共享常量里的数组直接存进去 */
function seedViews(): LibraryView[] {
  return VIEW_PRESETS.map((v, i) => ({
    ...v,
    ord: i,
    filter: {
      media: v.filter.media,
      keywords: [...v.filter.keywords],
      categories: [...v.filter.categories],
      read: v.filter.read
    }
  }));
}

/** 收下全部非空、去重后的规范值，不做静默截断 */
function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/** 把一条配置收紧成能用的形状。收不了就返回 null，由调用方决定是跳过还是报错 */
function normalizeView(raw: unknown, ord: number): LibraryView | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  if (!id || id === FIXED_VIEW_ID || id.length > 80) return null;
  const name = typeof v.name === "string" ? v.name.trim() : "";
  if (!name) return null;
  const unit = v.unit as ViewUnit;
  if (!UNITS.includes(unit)) return null;
  const layout = v.layout as ViewLayout;
  if (!LAYOUTS.includes(layout)) return null;

  const f = (v.filter && typeof v.filter === "object" ? v.filter : {}) as Record<string, unknown>;
  const media = typeof f.media === "string" ? f.media.trim() : "";
  const read = READ_VALUES.includes(f.read as ReadFilter) ? (f.read as ReadFilter) : "all";
  return {
    id,
    name,
    unit,
    layout,
    ord,
    filter: {
      /* 「全部」在配置里统一存空串 */
      media: media === "全部" ? "" : media,
      keywords: stringList(f.keywords),
      categories: stringList(f.categories),
      read
    }
  };
}

function writeViews(db: DB, views: LibraryView[]): void {
  setSetting(db, VIEW_CONFIG_KEY, JSON.stringify({ v: 1, views }));
}

function corrupt(msg?: string): ViewConfigResult {
  return {
    views: [],
    status: "corrupt",
    msg: msg || "视图配置读不出来，已退回「全部」；原有配置没有改动，等确认后再保存"
  };
}

/**
 * 读视图配置。
 * settings 里根本没有这一行才是首次初始化，写入四个预设；
 * 行在但内容为空或解析不了算损坏，只留「全部」，坏数据原样留着重试；
 * 存着空数组说明自定义视图被删空了，不能再补；个别条目坏了跳过，状态记 repaired。
 */
export function readViews(db: DB): ViewConfigResult {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(VIEW_CONFIG_KEY) as { value?: unknown } | undefined;
  if (!row) {
    const views = seedViews();
    try {
      writeViews(db, views);
      return { views, status: "seeded" };
    } catch (e) {
      /* 写不进去也要把预设给界面，这一次先能看 */
      return { views, status: "seeded", msg: "视图配置没能写进书库：" + msgOf(e) };
    }
  }

  /* 行存在却拿不到字符串，说明这一格被写坏了，按损坏处理而不是当成没配置 */
  if (typeof row.value !== "string") return corrupt();
  const raw = row.value;
  if (!raw.trim()) return corrupt();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt();
  }
  const obj = parsed as { v?: unknown; views?: unknown } | null;
  if (!obj || typeof obj !== "object" || obj.v !== 1 || !Array.isArray(obj.views)) return corrupt();

  const views: LibraryView[] = [];
  let dropped = 0;
  for (const item of obj.views) {
    const one = normalizeView(item, views.length);
    if (!one || views.some((x) => x.id === one.id)) {
      dropped++;
      continue;
    }
    views.push(one);
  }
  if (dropped) return { views, status: "repaired", msg: "有 " + dropped + " 个视图配置不完整，读取时已跳过" };
  return { views, status: views.length ? "ok" : "empty" };
}

/** 整排保存。数组顺序就是标签顺序，ord 按下标重写；非数组一律拒绝，不替调用方兜底成空表 */
export function saveViews(db: DB, list: unknown): ViewSaveResult {
  if (!Array.isArray(list)) return { ok: false, msg: "视图列表格式不对" };

  const views: LibraryView[] = [];
  for (let i = 0; i < list.length; i++) {
    const one = normalizeView(list[i], views.length);
    if (!one) return { ok: false, msg: "第 " + (i + 1) + " 个视图不完整，或者用了保留的固定 ID" };
    if (views.some((x) => x.id === one.id)) return { ok: false, msg: "视图 ID 重复：" + one.id };
    views.push(one);
  }

  try {
    writeViews(db, views);
    return { ok: true, views };
  } catch (e) {
    return { ok: false, msg: "视图配置没能写进书库：" + msgOf(e) };
  }
}
