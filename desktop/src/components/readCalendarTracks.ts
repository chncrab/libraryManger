import { dayNum, monthKeyOf, readBounds } from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";

/**
 * 日历上的「同书连读」细线。
 *
 * 只给真正跨天的阅读区间画线（起止差至少一天）；只开始或只有一天的书不画。
 * 线按书分轨：区间相交的书一定落在不同轨上，所以两本并排读的书不会在视觉上
 * 接成一条。轨数固定为三，第四本及以后直接不画，免得密处糊成一片。
 *
 * 颜色按全部数据一次性分配：先按原始区间的时间顺序排队，再给每本书挑一个
 * 「它覆盖的月份里还没被用过」的色相；月份太挤时挑冲突最少的，允许多本书
 * 共用一色。这样同一本书在月历、全年、换年、滚动前后都是同一色，且与输入
 * 顺序、当前可见年份无关。日期边界仍按 readBounds，并且一律裁到今天，未来不画。
 */
export const CAL_TRACK_LANES = 3;
export const MAX_CAL_TRACKS = 3;

/**
 * 在明暗两套主题里都能站住的低饱和色相。顺序不是色轮顺序，而是分配优先级：
 * 前八色尽量拉开，后面才补中间的过渡色。旧版 id 取模八只会在同月里反复撞色。
 */
const TRACK_HUES = [
  206, 28, 150, 322, 48, 268, 188, 4,
  112, 238, 80, 292, 64, 172, 338, 220
];

export interface CalTrack {
  bookId: string;
  /** 可见区间的起止（含端点），已裁到本年与今天 */
  a: number;
  z: number;
  lane: number;
  hue: number;
}

export interface CalRun {
  bookId: string;
  lane: number;
  hue: number;
  /** 同书前一天也在同一行、同一个月里 */
  prev: boolean;
  /** 同书后一天也在同一行、同一个月里 */
  next: boolean;
}

/**
 * 全部有效原始区间上的确定性配色。只看书自己的起止，不看传入年份与今天，
 * 所以换年、切视图都不会让某本书换色。
 */
function assignTrackHues(list: ReadEntry[]): Map<string, number> {
  const items: { id: string; a: number; z: number }[] = [];
  for (const e of list) {
    const b = readBounds(e);
    if (!Number.isFinite(b.a) || !Number.isFinite(b.b) || b.b <= b.a) continue;
    items.push({ id: e.id, a: b.a, z: b.b });
  }
  items.sort(
    (x, y) => x.a - y.a || x.z - y.z || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  );

  /** 每个自然月已经占用的色位。跨月区间会把自己的颜色登记到每一月 */
  const monthUse = new Map<number, Set<number>>();
  const out = new Map<string, number>();

  for (const { id, a, z } of items) {
    if (out.has(id)) continue;
    const m0 = monthKeyOf(a);
    const m1 = monthKeyOf(z);
    const hits = new Array<number>(TRACK_HUES.length).fill(0);
    for (let m = m0; m <= m1; m++) {
      const used = monthUse.get(m);
      if (!used) continue;
      for (const c of used) hits[c]++;
    }

    let pick = hits.indexOf(0);
    if (pick < 0) {
      /* 密到所有颜色都在这些月份出现过：用冲突最少的那一色，顺序仍然确定 */
      pick = 0;
      for (let i = 1; i < hits.length; i++) if (hits[i] < hits[pick]) pick = i;
    }

    out.set(id, pick);
    for (let m = m0; m <= m1; m++) {
      let used = monthUse.get(m);
      if (!used) {
        used = new Set<number>();
        monthUse.set(m, used);
      }
      used.add(pick);
    }
  }
  return out;
}

/**
 * 按当前可见年建一份书 → 轨/色的索引。排序按起点、再按 id，结果与数据返回
 * 顺序无关，因此同一本书的轨位在重渲、切视图后都不跳。颜色来自全量区间的
 * 一次性分配，与当前年无关。
 */
export function buildCalendarTracks(
  list: ReadEntry[],
  year: number,
  today: number
): Map<string, CalTrack> {
  const y0 = dayNum(`${year}-01-01`);
  const y1 = dayNum(`${year}-12-31`);
  const hues = assignTrackHues(list);
  const items: { e: ReadEntry; a: number; z: number }[] = [];

  for (const e of list) {
    const b = readBounds(e);
    if (!Number.isFinite(b.a) || !Number.isFinite(b.b)) continue;
    /* 真正的区间才画；单日与只有开始日的记录没有可连的邻居 */
    if (b.b <= b.a) continue;
    if (b.a > today) continue;
    const a = Math.max(b.a, y0);
    const z = Math.min(b.b, y1, today);
    /* 裁到可见范围后不足两天，同样没有邻居可连 */
    if (a >= z) continue;
    items.push({ e, a, z });
  }

  items.sort((x, y) => x.a - y.a || (x.e.id < y.e.id ? -1 : x.e.id > y.e.id ? 1 : 0));

  const laneEnd = new Array<number>(CAL_TRACK_LANES).fill(-Infinity);
  const out = new Map<string, CalTrack>();
  for (const { e, a, z } of items) {
    let lane = -1;
    for (let i = 0; i < CAL_TRACK_LANES; i++) {
      if (laneEnd[i] < a) {
        lane = i;
        break;
      }
    }
    /* 三轨都占着：这本书不画线，计数与悬停完全不受影响 */
    if (lane < 0) continue;
    laneEnd[lane] = z;
    const hueIndex = hues.get(e.id);
    out.set(e.id, {
      bookId: e.id,
      a,
      z,
      lane,
      hue: TRACK_HUES[hueIndex ?? 0]
    });
  }
  return out;
}

/**
 * 某一天要画的线。prev/next 由调用方按「同一行、同一月」判定：周一那格没有
 * 左边邻居，周日那格没有右边邻居，跨周/跨月时不把线拐到别的月份去。
 */
export function calendarRuns(
  dayBooks: ReadEntry[],
  tracks: Map<string, CalTrack>,
  day: number,
  prevOK: boolean,
  nextOK: boolean
): CalRun[] {
  const out: CalRun[] = [];
  for (const e of dayBooks) {
    const t = tracks.get(e.id);
    if (!t) continue;
    out.push({
      bookId: e.id,
      lane: t.lane,
      hue: t.hue,
      prev: prevOK && t.a < day,
      next: nextOK && t.z > day
    });
  }
  out.sort((x, y) => x.lane - y.lane || (x.bookId < y.bookId ? -1 : x.bookId > y.bookId ? 1 : 0));
  return out.slice(0, MAX_CAL_TRACKS);
}
