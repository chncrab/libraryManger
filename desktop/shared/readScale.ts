/**
 * 阅读时间轴的换算：日期 ↔ 世界坐标。横排与竖排共用一份，界面只拿坐标去摆。
 *
 * 世界坐标是 1 倍下的像素，界面再乘自己的缩放倍数。
 *
 * 轴是一整张连续日历：从最早那本书所在年份的一月，一直铺到今天所在年份的十二月，
 * 每月一格、每格一样宽，一年正好十二格。中间几年一本没读也照占格，不压缩、
 * 不跳过，所以「空了多久」在轴上就是实打实的多长。格子里每天一样宽 —— 书只用来
 * 把月宽撑起来，不把某一天撑开，所以一天正好一格、一根日刻度。
 *
 * 一天是相邻两个点之间的一段，不是一个点：xOf(d) 是这天的起点，
 * 这天的区间是 [xOf(d), xOf(d+1))。刻度画在点上，金线盖满整段。
 *
 * width 是轴的可见长度，只到「今天」那一天结束；后面那些还没到的月份仍在
 * 坐标系里，只是不画出来，好让每一年每一月都保持同一格宽。
 */

export const PXD = 3.6;
/** 主界面用的固定月宽。与书多书少无关，缩放到同一年月时尺度稳定 */
export const FIXED_MONTH_W = 168;
/** 保留给旧断言用，连续日历里已经没有「压空档」这回事 */
export const MAX_GAP = 320;
/** 一本书在轴上要占的长度，两轨交错，所以一半就够 */
export const SLOT = 76;
export const LANES = 2;
export const DAY_MS = 86400000;
/** 日历上最长的月是 31 天，一个月最少按这么宽排 */
export const MONTH_SLOT = 31;
/** 放到这个倍数才画日刻度，一倍下只有年与月 */
export const DAY_ZOOM = 1.6;

export function dayNum(s: string): number {
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : NaN;
}

export function dayStr(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function dayParts(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 这天所在月的月首。日期尺、月份分组都用它换算 */
export function monthFirstOf(day: number): number {
  const p = dayParts(day);
  return dayNum(`${p.y}-${String(p.m).padStart(2, "0")}-01`);
}

/** 月份编号：年 × 12 + 月 − 1，跨年加减方便 */
export function monthKeyOf(day: number): number {
  const p = dayParts(day);
  return p.y * 12 + p.m - 1;
}

/** 月份编号对应的月首 */
export function monthFirstOfKey(key: number): number {
  return monthFirst(key);
}

export function monthLength(day: number): number {
  const key = monthKeyOf(day);
  return monthFirst(key + 1) - monthFirst(key);
}

export interface Scale {
  /** 这天在轴上从哪开始 */
  xOf(day: number): number;
  /** 反查：世界坐标落在哪天，刻度只算看得见的那一段 */
  dayAt(x: number): number;
  /** 这天占多宽 */
  slopeAt(day: number): number;
  first: number;
  last: number;
  /** 轴的可见长度，到今天结束为止 */
  width: number;
  /** 一个月在轴上占多长，全轴统一 */
  monthW: number;
}

export interface BuildOpts {
  pxd?: number;
  maxGap?: number;
  slot?: number;
  lanes?: number;
  /** 轴延伸到哪一天，传进来的应是今天的天序号 */
  until?: number;
  /**
   * 固定月宽。不传仍按最密的月份定宽（旧行为，老测试依赖它）；
   * 主界面传 FIXED_MONTH_W，月份坐标就与书量脱钩。
   */
  fixedMonthW?: number;
}

interface Month {
  key: number;
  /** 月首那天的序号 */
  start: number;
  /** 月内每天的相对偏移，下标 = 日 - 月首；末尾多一格是整天宽 */
  off: Float64Array;
  natW: number;
  x0: number;
}

function monthFirst(key: number): number {
  return dayNum(`${Math.floor(key / 12)}-${String((key % 12) + 1).padStart(2, "0")}-01`);
}

/**
 * 日期表由书落的日期构成，传进来什么顺序都行，内部排序去重。
 *
 * 有书的那天至少占「那天的本数 × 一本书的宽 / 轨数」，没书的一天占 pxd。
 * 把一个月里每天的宽度加起来就是它自己需要多宽，全轴取最宽的那个月定下统一
 * 月宽，别的月份把自己按同一比例摊开，正好填满一格。
 */
export function buildScale(days: number[], o: BuildOpts = {}): Scale {
  const pxd = o.pxd ?? PXD;
  const slot = o.slot ?? SLOT;
  const lanes = o.lanes ?? LANES;
  const counts = new Map<number, number>();
  for (const d of days) if (Number.isFinite(d)) counts.set(d, (counts.get(d) || 0) + 1);
  const ds = [...counts.keys()].sort((a, b) => a - b);

  if (!ds.length) {
    return {
      xOf: (day) => day * pxd,
      dayAt: (x) => Math.round(x / pxd),
      slopeAt: () => pxd,
      first: 0,
      last: 0,
      width: 0,
      monthW: pxd * MONTH_SLOT
    };
  }

  /* 一个月自己需要多宽：每天按 pxd 起算，有书的那天按「本数 × 一本书的宽 ÷ 轨数」
     再加。这个和只用来定全轴统一的那一格月宽 —— 书多的月份把月宽撑起来，别的
     月份跟着摊到一样宽，于是从「哪年到哪年」在轴上的长短不因读书多少而失真 */
  const needOf = (day: number) => Math.max(pxd, ((counts.get(day) || 0) * slot) / lanes);
  const until = Math.max(o.until ?? ds[ds.length - 1], ds[ds.length - 1]);
  const startKey = dayParts(ds[0]).y * 12;
  const endKey = dayParts(until).y * 12 + 11;

  const months: Month[] = [];
  for (let key = startKey; key <= endKey; key++) {
    const start = monthFirst(key);
    const len = monthFirst(key + 1) - start;
    let c = 0;
    for (let i = 0; i < len; i++) c += needOf(start + i);
    months.push({ key, start, off: new Float64Array(len + 1), natW: c, x0: 0 });
  }

  let monthW = pxd * MONTH_SLOT;
  for (const u of months) if (u.natW > monthW) monthW = u.natW;
  /* 固定宽模式：月宽由界面给定，不再被某一天集中录入的几十本撑开。
     buildScale 的默认分支保持原样，老调用与老测试不必改 */
  if (o.fixedMonthW != null && Number.isFinite(o.fixedMonthW) && o.fixedMonthW > 0) {
    monthW = o.fixedMonthW;
  }
  /* 月内每天一样宽：书只用来定月宽，不把某一天撑开。撑开的那一天会占掉十来天
     的宽度，而它仍旧只有一个日期，放大到看得见日刻度时那一大片就只有一根刻度，
     看着就像刻度被吃了。摊平之后每一天正好一格，一天一根，间距均匀 */
  for (let i = 0; i < months.length; i++) {
    const u = months[i];
    const len = u.off.length - 1;
    const step = len > 0 ? monthW / len : monthW;
    for (let j = 0; j <= len; j++) u.off[j] = j * step;
    u.natW = monthW;
    u.x0 = i * monthW;
  }

  const gridW = months.length * monthW;
  const first = months[0].start;
  const last = until;
  const tail = months[months.length - 1];
  /** 最后一月的最后一天。off 末尾多一格是下月一号，所以要减二 */
  const tailEnd = tail.start + tail.off.length - 2;

  const xOf = (day: number) => {
    if (!Number.isFinite(day)) return 0;
    const i = monthKeyOf(day) - startKey;
    if (i < 0) return (day - first) * pxd;
    if (i >= months.length) return gridW + (day - tailEnd - 1) * pxd;
    const u = months[i];
    const k = day - u.start;
    if (k < 0) return u.x0 + k * pxd;
    if (k < u.off.length) return u.x0 + u.off[k];
    return u.x0 + monthW + (k - (u.off.length - 1)) * pxd;
  };

  const dayAt = (x: number) => {
    if (x <= 0) return Math.round(first + x / pxd);
    if (x >= gridW) return Math.round(tailEnd + 1 + (x - gridW) / pxd);
    const i = Math.min(months.length - 1, Math.floor(x / monthW));
    const u = months[i];
    const rel = x - u.x0;
    const off = u.off;
    let a = 0;
    let b = off.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (off[m] <= rel) a = m;
      else b = m;
    }
    const w = off[b] - off[a];
    return Math.round(u.start + a + (w > 0 ? (rel - off[a]) / w : 0));
  };

  const slopeAt = (day: number) => {
    const i = monthKeyOf(day) - startKey;
    if (i < 0 || i >= months.length) return pxd;
    const u = months[i];
    const k = day - u.start;
    if (k >= 0 && k < u.off.length - 1) return u.off[k + 1] - u.off[k];
    return pxd;
  };

  return { xOf, dayAt, slopeAt, first, last, width: Math.min(xOf(last + 1), gridW), monthW };
}

export interface Tick {
  x: number;
  kind: "year" | "month" | "day";
  /** 空串表示只画一道刻度线，不写字 */
  label: string;
  /** 这根刻度管的那一段有多宽（世界坐标） */
  w: number;
}

/** 金线两头的日期，写成 05-12 这样的月-日，不带年份也不带「日」字 */
export function dayLabel(day: number): string {
  const p = dayParts(day);
  return Number.isFinite(p.m) && Number.isFinite(p.d)
    ? String(p.m).padStart(2, "0") + "-" + String(p.d).padStart(2, "0")
    : "";
}

/** 这天是不是星期天。刻度已经不按星期分组，留着给别的用处 */
export function isSunday(day: number): boolean {
  return new Date(day * DAY_MS).getUTCDay() === 0;
}

function nextMonthFirst(y: number, m: number): number {
  return m === 12 ? dayNum(`${y + 1}-01-01`) : dayNum(`${y}-${String(m + 1).padStart(2, "0")}-01`);
}

/**
 * 看得见的那一段里的刻度。
 *
 * 轴上有字的是月与年：月写「5月」，年写一枚四位年份。日刻度只画一道短线，
 * 不写字 —— 一天一格，写满就是一排「05-12」，把轴糊成一片。
 *
 * 日刻度只有一条门槛：倍率到 DAY_ZOOM 以上，视野里的每一天都画一根，一根不少；
 * 不到就一根都不画。不按「屏幕上挤不挤得下」挑，也不因为月初有月线就跳过 ——
 * 那套挑着画的逻辑删了，缺一根都算漏。
 *
 * 一月一号同时出月刻度与年刻度，一月和别的月一样写「1月」，年份另挂在自己
 * 那道年线上，表示这道线之后的一年归它。
 *
 * 年刻度按整年算：这一年只要和视野有交集就挂上。只认年线本身在不在视野里
 * 的话，滚到二三月这枚年份就没了。
 */
export function ticks(sc: Scale, d0: number, d1: number, k = 1): Tick[] {
  const out: Tick[] = [];
  const vs = Math.min(2.2, k);
  const showLabel = vs >= 0.15;
  const showDays = k >= DAY_ZOOM;
  /* 月份自己一把避让尺子：密处的月名挤不下时连那根月线一起省掉，
     一根没有字的月线说不清管的是哪个月 */
  let monthRight = -1e9;
  const from = Math.floor(d0) - 1;
  const to = Math.ceil(d1) + 1;
  const xFrom = sc.xOf(from);
  const xTo = sc.xOf(to);

  for (let y = dayParts(from).y; y <= dayParts(to).y; y++) {
    const start = dayNum(`${y}-01-01`);
    const end = dayNum(`${y + 1}-01-01`);
    const wx = sc.xOf(start);
    if (sc.xOf(end) > xFrom && wx < xTo) {
      out.push({ x: wx, w: Math.max(0, sc.xOf(end) - wx), kind: "year", label: showLabel ? String(y) : "" });
    }
  }

  for (let d = from; d <= to; d++) {
    const p = dayParts(d);
    const isMonth = p.d === 1;
    const wx = sc.xOf(d);
    const sx = wx * k;

    if (isMonth) {
      const span = sc.xOf(nextMonthFirst(p.y, p.m)) - wx;
      const label = span * k >= 34 ? p.m + "月" : "";
      if (label && showLabel) {
        const w = (label.length * 6.4 + 6) * vs;
        if (sx >= monthRight + 4) {
          monthRight = sx + w;
          out.push({ x: wx, w: Math.max(0, span), kind: "month", label });
        }
      }
    }

    /* 日刻度只是一道线，不写日期。放大够了就天天都画，一根不落：
       不挑间距、不看那天有多宽、月初也照画（月线压在上面而已） */
    if (showDays) {
      out.push({ x: wx, w: Math.max(0, sc.slopeAt(d)), kind: "day", label: "" });
    }
  }
  /* 年刻度先按整年拎出来，排回去才按位置站队 */
  out.sort((a, b) => a.x - b.x);
  return out;
}

/** 这本书站在轴上哪一天：起止那段的中心。长条以封面为轴两头伸出来，
   封面落在中间，所以换算也按中间的这天建，封面才不会挤成一堆 */
export function midDay(e: { start: string; end: string; anchor: string }): number {
  const a = dayNum(e.start);
  const b = dayNum(e.end || e.anchor);
  return Number.isFinite(a) ? Math.round((a + b) / 2) : b;
}

/** 一条阅读记录的有效起止。end 是读完日；只有 start 时它是一个「开始点」 */
export interface ReadBounds {
  /** 轴上覆盖的起点 */
  a: number;
  /** 轴上覆盖的终点（含当天） */
  b: number;
  /** 只有开始日期，没有读完日 */
  onlyStart: boolean;
  /** 起止同一天 */
  point: boolean;
}

export function readBounds(e: { start: string; end: string; anchor: string }): ReadBounds {
  const s = dayNum(e.start);
  const en = dayNum(e.end);
  const hasS = Number.isFinite(s);
  const hasE = Number.isFinite(en);
  if (hasE) {
    const a = hasS ? Math.min(s, en) : en;
    return { a, b: Math.max(a, en), onlyStart: false, point: a === en };
  }
  if (hasS) return { a: s, b: s, onlyStart: true, point: true };
  const an = dayNum(e.anchor);
  return Number.isFinite(an)
    ? { a: an, b: an, onlyStart: false, point: true }
    : { a: NaN, b: NaN, onlyStart: false, point: true };
}

/** 读完日；只有开始日期时退回开始日。日历、书目分组一律按它 */
export function finishDay(e: { start: string; end: string; anchor: string }): number {
  const en = dayNum(e.end);
  if (Number.isFinite(en)) return en;
  const s = dayNum(e.start);
  if (Number.isFinite(s)) return s;
  return dayNum(e.anchor);
}

/** 最近一条有展示日期的记录。首次进时间线落到它上面 */
export function latestRecordedDay(list: { start: string; end: string; anchor: string }[]): number {
  let best = NaN;
  for (const e of list) {
    const d = finishDay(e);
    if (Number.isFinite(d) && (!Number.isFinite(best) || d > best)) best = d;
  }
  return best;
}

export type BucketKind = "year" | "month" | "day";

/** 缩得太远时按固定桶聚合读完标记。桶从全量数据算，所以平移时分组不会变 */
export function bucketAt(monthPx: number): BucketKind {
  if (monthPx < 42) return "year";
  if (monthPx < 420) return "month";
  return "day";
}

export interface ReadBucket<T> {
  key: string;
  /** 桶的代表日：年取元旦，月取月初，日就是那天 */
  day: number;
  n: number;
  entries: T[];
}

export function finishBuckets<T extends { start: string; end: string; anchor: string }>(
  list: T[],
  kind: BucketKind
): ReadBucket<T>[] {
  const map = new Map<string, ReadBucket<T>>();
  for (const e of list) {
    const d = finishDay(e);
    if (!Number.isFinite(d)) continue;
    const p = dayParts(d);
    const key =
      kind === "year"
        ? String(p.y)
        : kind === "month"
          ? `${p.y}-${String(p.m).padStart(2, "0")}`
          : `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    const day = kind === "year" ? dayNum(`${p.y}-01-01`) : kind === "month" ? monthFirstOf(d) : d;
    const b = map.get(key);
    if (b) {
      b.n++;
      b.entries.push(e);
    } else map.set(key, { key, day, n: 1, entries: [e] });
  }
  return [...map.values()].sort((a, b) => a.day - b.day);
}

/** 一段阅读在轴上盖住的世界坐标：从开始那天清晨读到读完那天深夜 */
export function spanOf(sc: Scale, start: string, end: string, anchor: string): { x0: number; x1: number } {
  const a = dayNum(start);
  const b = dayNum(end || anchor);
  const d0 = Number.isFinite(a) ? a : b;
  const d1 = Number.isFinite(b) ? Math.max(b, d0) : d0;
  return { x0: sc.xOf(d0), x1: sc.xOf(d1 + 1) };
}

export interface YearBand {
  y: number;
  /** 那年 1 月 1 日与次年 1 月 1 日在世界坐标里的位置，掐在整条轴两头之内 */
  x0: number;
  x1: number;
  /** 那年读完几本 */
  n: number;
}

/** 导航条按年等分。轴本身现在也是一年十二格，两者天然对得上 */
export function yearBands(anchors: string[], sc: Scale): YearBand[] {
  const cnt = new Map<number, number>();
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of anchors) {
    const y = Number(String(a || "").slice(0, 4));
    if (!Number.isFinite(y) || y < 1900) continue;
    cnt.set(y, (cnt.get(y) || 0) + 1);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  if (!Number.isFinite(lo)) return [];
  const clampX = (v: number) => Math.min(sc.width, Math.max(0, v));
  const out: YearBand[] = [];
  for (let y = lo; y <= hi; y++) {
    out.push({
      y,
      x0: clampX(sc.xOf(dayNum(y + "-01-01"))),
      x1: clampX(sc.xOf(dayNum(y + 1 + "-01-01"))),
      n: cnt.get(y) || 0
    });
  }
  return out;
}

/** 导航条上那个滑块：左沿与宽，都是「条铺开的那一段」的 0–1 */
export interface NavThumb {
  l: number;
  w: number;
}

/**
 * 导航条铺开的那一段世界坐标。默认整条轴；在上头选了一段年份，就只铺那几年 ——
 * 二十几年摊在一千多像素里，一像素跨着半个月，金线挤成亮带；只铺三五年，
 * 同样的条长全给这几年，一像素跨几个钟头，逐本也挑得动。
 */
export interface NavRange {
  a: number;
  b: number;
}

/** 没选区间时铺整条轴 */
export function fullRange(total: number): NavRange {
  return { a: 0, b: Math.max(1, total) };
}

/**
 * 没选区间时条铺到哪儿。轴到头之后还可能压着几本：同一天挤好几本时封面会往后
 * 推出去一截，那些书的落点在轴长之外。留一点余量，免得把末端那几本从条上筛掉。
 */
export function navFull(list: { start: string; end: string; anchor: string }[], sc: Scale): NavRange {
  let end = Math.max(1, sc.width);
  for (const e of list) {
    const d = midDay(e);
    if (Number.isFinite(d)) end = Math.max(end, sc.xOf(d) + 120);
  }
  return { a: 0, b: end };
}

/**
 * 年份区间换成世界坐标：从起点年一月一号，到终点年十二月三十一号，掐在轴两头之内。
 * 上端留的这点余量跟 navFull 一样：末年最后那几本可能压在轴尾上，硬掐会把它们滤掉。
 * 不再多留 —— 区间铺到今年时，条该跟「全部」一样到头，不该伸进还没到的月份。
 */
export function yearRange(sc: Scale, y0: number, y1: number): NavRange {
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  const clampX = (v: number) => Math.min(sc.width + 120, Math.max(0, v));
  const a = clampX(sc.xOf(dayNum(lo + "-01-01")));
  const b = clampX(sc.xOf(dayNum(hi + 1 + "-01-01")));
  return b - a < 1 ? { a, b: a + 1 } : { a, b };
}

/**
 * 标准进度条那套：滑块左沿 = 视野起点在条上的分位，滑块宽 = 视野占条的分位。
 * 视野本来就被夹在轴里，所以左沿天然不会超过 1 − w。
 *
 * 这里没有「窗口」这回事。条铺的是一段固定的世界坐标（默认整条轴），条长与刻度
 * 都不随视野变，于是拖动是纯线性的：手挪多少像素，滑块挪多少像素，内容也挪同样
 * 多的像素。以前每帧拿视野中心重算窗口，等于边走边换尺子，光标停在同一处分位指
 * 向的时间每帧都变，拖起来就飞 —— 这条链现在从根上断了。
 *
 * 视野比铺开的那段还宽时（缩到很小、又把区间选得很短），滑块满条，贴在最左。
 */
export function navThumb(r: NavRange, v0: number, view: number): NavThumb {
  const d = Math.max(1, r.b - r.a);
  const w = Math.min(1, Math.max(1e-5, view / d));
  const l = Math.min(1 - w, Math.max(0, (v0 - r.a) / d));
  return { l, w };
}

/** 条上的分位 → 世界坐标 */
export function navX(r: NavRange, p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return r.a + c * Math.max(1, r.b - r.a);
}

/** 世界坐标 → 条上的分位 */
export function navAt(r: NavRange, x: number): number {
  const d = Math.max(1, r.b - r.a);
  return Math.min(1, Math.max(0, (x - r.a) / d));
}

/** 世界坐标落在哪一年：给浮出来的那行字用 */
export function navBandAt(bands: YearBand[], x: number): YearBand | null {
  if (!bands.length) return null;
  for (const b of bands) if (x < b.x1) return b;
  return bands[bands.length - 1];
}

export interface NavMark {
  id: string;
  /** 落在条上的分位（0–1）。条上那一层按它摆 */
  p: number;
  /** 世界坐标，比远近、反查落点都用它 */
  x: number;
  /** 气泡里那行字：书名 · 月-日 */
  text: string;
}

/**
 * 每本书落在条上的哪一个位置。
 *
 * 导航条以前只按年画柱子，同一年的书挤成一根，落点是「哪一年」，一年在轴上
 * 七八千像素、在条上只有几十像素，拖起来对不准。改成每本一根金色细线，
 * 条上哪一处有书一眼看得出，拖着对齐它就落到那本书那一带。
 *
 * 位置按封面落点算（起止的中点），与轴上的摆法同一个日期，两者不容易错位。
 * range 是条铺开的那一段：区间外的书不给线，否则全叠在条的两头。
 */
export function navMarks(
  list: { id: string; title: string; start: string; end: string; anchor: string }[],
  sc: Scale,
  range: NavRange
): NavMark[] {
  const out: NavMark[] = [];
  for (const e of list) {
    const d = midDay(e);
    if (!Number.isFinite(d)) continue;
    const x = sc.xOf(d);
    if (x < range.a || x > range.b) continue;
    out.push({ id: e.id, p: navAt(range, x), x, text: e.title + " · " + dayLabel(d) });
  }
  out.sort((a, b) => a.p - b.p);
  return out;
}

/** 世界坐标 x 附近最近的那本书；tol 是按世界坐标算的容差。没有就返回 null */
export function nearestMark(marks: NavMark[], x: number, tol: number): NavMark | null {
  let best: NavMark | null = null;
  let bd = Infinity;
  for (const m of marks) {
    const d = Math.abs(m.x - x);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best && bd <= tol ? best : null;
}
