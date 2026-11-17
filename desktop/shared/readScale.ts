/**
 * 阅读时间轴的换算：日期 ↔ 世界坐标。横排与竖排共用一份，界面只拿坐标去摆。
 *
 * 世界坐标是 1 倍下的像素，界面再乘自己的缩放倍数。
 *
 * 月份按同一个宽度排：全轴取「过得最满的那个月」的宽度，一月一格，每个月都把
 * 自己的日子按比例摊开填满这一格。照日历天数各排各的话，二月比一月窄一截、
 * 读书密的月份又被撑得很开，一路看下去节奏忽快忽慢；照自然宽度排、把余下的空白
 * 留在月末，稀疏的月份末尾又会空出一大段，下个月从那之后才开始，看着还是忽长忽短。
 * 统一之后每个月正好一格，哪个月读得多，由月里的书自己去挤，轴本身不跟着伸缩。
 *
 * 一天是相邻两个点之间的一段，不是一个点：xOf(d) 是这天的起点，
 * 这天的区间是 [xOf(d), xOf(d+1))。刻度画在点上，金线盖满整段。
 */

export const PXD = 3.6;
export const MAX_GAP = 320;
/** 一本书在轴上要占的长度，两轨交错，所以一半就够 */
export const SLOT = 76;
export const LANES = 2;
export const DAY_MS = 86400000;
/** 日历上最长的月是 31 天，一个月最少按这么宽排 */
export const MONTH_SLOT = 31;

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

export interface Scale {
  /** 这天在轴上从哪开始 */
  xOf(day: number): number;
  /** 反查：世界坐标落在哪天，刻度只算看得见的那一段 */
  dayAt(x: number): number;
  /** 这天占多宽，被压过的空档里会小得多 */
  slopeAt(day: number): number;
  first: number;
  last: number;
  width: number;
  /** 一个月在轴上占多长。全轴统一，取过得最满的那个月 */
  monthW: number;
}

export interface BuildOpts {
  pxd?: number;
  maxGap?: number;
  slot?: number;
  lanes?: number;
}

interface Month {
  /** 年 * 12 + 月（0 起），用来算中间空掉几个月 */
  key: number;
  /** 月首那天的序号 */
  start: number;
  /** 月内每天的相对偏移，下标 = 日 - 月首；末尾多一格是整天宽 */
  off: Float64Array;
  /** 这个月自己需要多宽 */
  natW: number;
  /** 与上一个月之间的空档 */
  gap: number;
  x0: number;
}

const monthKeyOf = (day: number) => {
  const p = dayParts(day);
  return p.y * 12 + p.m - 1;
};

const monthFirst = (key: number) =>
  dayNum(`${Math.floor(key / 12)}-${String((key % 12) + 1).padStart(2, "0")}-01`);

/**
 * 日期表由书落的日期构成，传进来什么顺序都行，内部排序去重。
 *
 * 有书的那天至少占「那天的本数 × 一本书的宽 / 轨数」，没书的一天占 pxd。
 * 把这个月里三十二天（含月末）的宽度加起来，就是它自己需要多宽；
 * 全轴取最宽的那个月当统一月宽，别的月份把余下的空白留在月末。
 * 中间整整几个月没读书的，整段压到 maxGap，不然几年空白会把轴撑成荒原。
 */
export function buildScale(days: number[], o: BuildOpts = {}): Scale {
  const pxd = o.pxd ?? PXD;
  const maxGap = o.maxGap ?? MAX_GAP;
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

  const stepOf = (day: number) => Math.max(pxd, ((counts.get(day) || 0) * slot) / lanes);

  const months: Month[] = [];
  let prevKey = NaN;
  for (const d of ds) {
    const key = monthKeyOf(d);
    if (key === prevKey) continue;
    prevKey = key;
    const start = monthFirst(key);
    const len = monthFirst(key + 1) - start;
    const off = new Float64Array(len + 1);
    let c = 0;
    for (let i = 0; i < len; i++) {
      off[i] = c;
      c += stepOf(start + i);
    }
    off[len] = c;
    months.push({ key, start, off, natW: c, gap: 0, x0: 0 });
  }

  /* 统一月宽：取过得最满的那个月，且不窄于 31 天 */
  let monthW = pxd * MONTH_SLOT;
  for (const u of months) if (u.natW > monthW) monthW = u.natW;

  /* 每个月都撑满这一格：书少的月份把日子按比例摊开，直到正好占满一个月的宽度；
     书最满的那个月本来就是满的，比例是 1，书与书的位置原样不动。
     只留自然宽度的话，稀疏的月份末尾会空出一大截，下个月从那一截之后才开始——
     看着像是轴上突然多了一段空白，正是要消掉的那种忽长忽短。
     比例只会大于等于 1，日子只会变宽，封面不会因为撑开而挤在一起。 */
  for (const u of months) {
    const f = u.natW > 0 ? monthW / u.natW : 1;
    if (f !== 1) for (let i = 0; i < u.off.length; i++) u.off[i] *= f;
    u.natW = monthW;
  }

  let acc = 0;
  for (let i = 0; i < months.length; i++) {
    const u = months[i];
    if (i) {
      const skip = u.key - months[i - 1].key - 1;
      u.gap = skip > 0 ? Math.min(skip * monthW, maxGap) : 0;
      acc += u.gap;
    }
    u.x0 = acc;
    acc += monthW;
  }

  const first = ds[0];
  const last = ds[ds.length - 1];
  const width = acc;
  const head = months[0];
  const tail = months[months.length - 1];
  const xOfFirst = head.x0 + head.off[first - head.start];
  const xOfLast = tail.x0 + tail.off[last - tail.start];

  /** 二分：day 落在第几个月。落在两月之间的空档里就归左边那个月 */
  const monthAt = (day: number) => {
    let lo = 0;
    let hi = months.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (months[m].start <= day) lo = m;
      else hi = m - 1;
    }
    return lo;
  };

  /** 月尾到下月首之间那截空档里，day 落在几成 */
  const gapFrac = (i: number, day: number) => {
    const u = months[i];
    const nu = months[i + 1];
    if (!nu) return 0;
    const d0 = u.start + u.off.length - 1;
    return Math.min(1, Math.max(0, (day - d0) / Math.max(1, nu.start - d0)));
  };

  const xOf = (day: number) => {
    if (!Number.isFinite(day)) return 0;
    if (day < first) return xOfFirst + (day - first) * pxd;
    if (day > last) return xOfLast + (day - last) * pxd;
    const i = monthAt(day);
    const u = months[i];
    const k = day - u.start;
    if (k >= 0 && k < u.off.length) return u.x0 + u.off[k];
    const nu = months[i + 1];
    if (!nu) return u.x0 + monthW + (day - (u.start + u.off.length - 1)) * pxd;
    return u.x0 + monthW + gapFrac(i, day) * nu.gap;
  };

  const dayAt = (x: number) => {
    if (x <= xOfFirst) return Math.round(first + (x - xOfFirst) / pxd);
    if (x >= xOfLast) return Math.round(last + (x - xOfLast) / pxd);
    let lo = 0;
    let hi = months.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (months[m].x0 <= x) lo = m;
      else hi = m - 1;
    }
    const u = months[lo];
    const rel = x - u.x0;
    if (rel <= u.natW) {
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
    }
    /* 月尾那段空白不是日子，算作这个月结束的那一刻 */
    if (rel <= monthW) return u.start + u.off.length - 1;
    const nu = months[lo + 1];
    if (!nu) return Math.round(last + (x - xOfLast) / pxd);
    const d0 = u.start + u.off.length - 1;
    const t = nu.gap > 0 ? (rel - monthW) / nu.gap : 0;
    return Math.round(d0 + Math.min(1, Math.max(0, t)) * (nu.start - d0));
  };

  const slopeAt = (day: number) => {
    if (day < first || day > last) return pxd;
    const i = monthAt(day);
    const u = months[i];
    const k = day - u.start;
    if (k >= 0 && k < u.off.length - 1) return u.off[k + 1] - u.off[k];
    const nu = months[i + 1];
    if (!nu) return pxd;
    const d0 = u.start + u.off.length - 1;
    return nu.gap / Math.max(1, nu.start - d0);
  };

  return { xOf, dayAt, slopeAt, first, last, width, monthW };
}

export interface Tick {
  x: number;
  kind: "year" | "month" | "day";
  /** 空串表示只画一道刻度线，不写字 */
  label: string;
  /** 落在星期天的那几根日刻度，画得粗一点，好看出一个月走到哪了 */
  sun?: boolean;
  /** 这根刻度管的那一段有多宽（世界坐标）。字挂在这一段的正中，不挂在线上 */
  w: number;
}

/** 长条两端的几号。只写数字，不带「日」，月份由上头的月刻度交代 */
export function dayLabel(day: number): string {
  const p = dayParts(day);
  return Number.isFinite(p.d) ? String(p.d) : "";
}

/** 这天是不是星期天。1 倍下一格才几像素，日号写不下，只把周日加粗 */
export function isSunday(day: number): boolean {
  return new Date(day * DAY_MS).getUTCDay() === 0;
}

/** 下个月一号 */
function nextMonthFirst(y: number, m: number): number {
  return m === 12 ? dayNum(`${y + 1}-01-01`) : dayNum(`${y}-${String(m + 1).padStart(2, "0")}-01`);
}

/**
 * 看得见的那一段里的刻度。放得越大刻度越细：
 * 一年拉不开只标年，一月有三十来像素标月，一天有十二像素就上日刻度。
 * 刻度线画在天的起点上 —— 相邻两根线之间正好是那一天，
 * 所以字不压在线下，摆在它管的那一段的正中。
 * 日刻度一律不写日号，只把星期天那几根画粗，看着像一个月的骨架；
 * 空档被压过的地段一天只有零点几像素，自然只剩年线。
 */
export function ticks(sc: Scale, d0: number, d1: number, k = 1): Tick[] {
  const out: Tick[] = [];
  /* 阈值与标签宽度都是屏幕像素，x 是世界坐标，比的时候先乘上 k */
  const vs = Math.min(2.2, k);
  const showLabel = vs >= 0.45;
  let markX = -1e9;
  let labelRight = -1e9;
  const from = Math.floor(d0) - 1;
  const to = Math.ceil(d1) + 1;
  for (let d = from; d <= to; d++) {
    const p = dayParts(d);
    const isYear = p.m === 1 && p.d === 1;
    const isMonth = p.d === 1;
    const wx = sc.xOf(d);
    const sx = wx * k;
    if (sx - markX < 4) continue;
    let kind: Tick["kind"] = "day";
    let label = "";
    let span = 0;
    if (isYear) {
      kind = "year";
      label = String(p.y);
      span = sc.xOf(dayNum(`${p.y + 1}-01-01`)) - wx;
    } else if (isMonth) {
      span = sc.xOf(nextMonthFirst(p.y, p.m)) - wx;
      if (span * k < 14) continue;
      kind = "month";
      if (span * k >= 34) label = p.m + "月";
    } else {
      span = sc.slopeAt(d);
      if (span * k < 10) continue;
      kind = "day";
    }
    markX = sx;
    let text = "";
    if (label && showLabel) {
      /* 标签宽度按视觉倍数估，字多大就多宽，不然放大了还挨着 */
      const w = (label.length * 6.4 + 6) * vs;
      if (sx >= labelRight + 4) {
        text = label;
        labelRight = sx + w;
      }
    }
    out.push({ x: wx, w: Math.max(0, span), kind, label: text, sun: kind === "day" && isSunday(d) });
  }
  return out;
}

/** 这本书站在轴上哪一天：起止那段的中心。长条以封面为轴两头伸出来，
   封面落在中间，所以换算也按中间的这天建，封面才不会挤成一堆 */
export function midDay(e: { start: string; end: string; anchor: string }): number {
  const a = dayNum(e.start);
  const b = dayNum(e.end || e.anchor);
  return Number.isFinite(a) ? Math.round((a + b) / 2) : b;
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

/**
 * 导航条按年等分：一年一格，不管那一年读了三十本还是一本。
 *
 * 真实的轴不是等分的 —— 密集的月份会被「当天本数 × 一格长」撑开，几年没读书
 * 的空洞又被压到 320 像素。照真实长度画导航条的话，2018 那一片能占掉半条，
 * 早年只剩一丝，想拖到某一年根本瞄不准。改成按年等分，每格的长度就与读书多少
 * 无关了，读书多少改由格子里那根柱子的高低交代。
 *
 * 中间那些一本没读的年份也留着，一年一格不断档，那几年空白一眼就看得出来。
 */
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

/** 世界坐标落在导航条的哪个位置（0–1）。年内在两条年界线之间线性插值 */
export function navFrac(bands: YearBand[], x: number): number {
  const n = bands.length;
  if (!n) return 0;
  const w = 1 / n;
  for (let i = 0; i < n; i++) {
    const b = bands[i];
    if (x < b.x1 || i === n - 1) {
      const t = b.x1 > b.x0 ? (x - b.x0) / (b.x1 - b.x0) : 0;
      return w * (i + Math.min(1, Math.max(0, t)));
    }
  }
  return 1;
}

/** 导航条位置反查世界坐标，拖动与点击都用它 */
export function navX(bands: YearBand[], p: number): number {
  const n = bands.length;
  if (!n) return 0;
  const w = 1 / n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(p / w)));
  const b = bands[i];
  const t = Math.min(1, Math.max(0, (p - i * w) / w));
  return b.x0 + (b.x1 - b.x0) * t;
}

/** 哪一年：给浮出来的那行字用 */
export function navBand(bands: YearBand[], p: number): YearBand | null {
  const n = bands.length;
  if (!n) return null;
  const i = Math.min(n - 1, Math.max(0, Math.floor(p * n)));
  return bands[i];
}
