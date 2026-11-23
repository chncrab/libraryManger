import { useEffect, useMemo, useRef, useState } from "react";
import { coverUrl } from "../api";
import { DAY_MS, dayNum, dayParts, dayStr, readBounds } from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";
import { ratingText } from "./GridView";
import ReadCalendarHover, { type ReadHoverHandle } from "./ReadCalendarHover";
import { buildCalendarTracks, calendarRuns } from "./readCalendarTracks";

/**
 * 阅读日历：
 * - 月历（默认）：七列大方格，起止日可显示 1–3 本书名，其余 +n。
 * - 全年：一张整年纸，十二个月按三列四行排开，每月月号、周一至周日表头和
 *   六行日期；起止日显示一本书名，其余 +n。在读本数用底色区分。
 *
 * 格子按 readBounds 的闭区间覆盖：开始日到结束日（含两端）每天都算在读；
 * 只填开始日的书只落在开始那天，只有结束日的书落在结束那天；都不合法的才退回
 * anchor。今天之后的格子仍禁用且为空。
 *
 * 月格、年格、选中日书目、悬停与点击共用同一份「当前可见年」索引；跨年的部分
 * 在各自年份里分别出现，不把每一年的每一天都展开存着。年选择器与标题里的本数
 * 按书去重：一本书跨几年就在几年各算一次，不按天数累加。
 *
 * 两种视图共用同一个 focusDay：月份、年份切换都只移动焦点，
 * 按实际日期格定位；空月同样可以查看。点日期只选中，不直接开详情：
 * 有书的日期把书目浮层固定在点击处，点卡片才交给 ReadView 打开抽屉。
 */
interface Props {
  list: ReadEntry[];
  /** 共享焦点日，天序号 */
  focusDay: number;
  today: number;
  /** 点格子：选中这一天；有书时再固定书目浮层 */
  onFocusDay: (day: number) => void;
  onPick: (id: string) => void;
}

type CalMode = "month" | "year";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const EMPTY_BOOKS: ReadEntry[] = [];

function fullDate(day: number): string {
  const p = dayParts(day);
  return `${p.y} 年 ${p.m} 月 ${p.d} 日`;
}

/** 周一起算的星期序号 */
function mondayIndex(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

function yearFirst(y: number): number {
  return dayNum(`${y}-01-01`);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** m 从 1 开始 */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function makeDay(y: number, m: number, d: number): number {
  return dayNum(`${y}-${pad2(m)}-${pad2(d)}`);
}

/**
 * 阅读本数决定底色的浓度范围。起止日用本档较深的颜色，
 * 即使当天有多本书读完，也不会比更高一档的本数颜色深。
 */
function calFillPct(n: number, edges: number): number {
  if (n <= 0) return 0;
  const strength = (count: number) => 10 + (44 * (count - 1)) / (count + 2);
  const base = strength(n);
  return edges
    ? base + (strength(n + 1) - base) * (0.5 + (0.3 * edges) / n)
    : base;
}

interface MonthCell {
  day: number;
  d: number;
  col: number;
  row: number;
}

interface MonthGrid {
  lead: number;
  total: number;
  cells: MonthCell[];
  rows: number;
}

/** 周一起算的七列月格；月历与全年视图共用同一份日期计算 */
function buildMonthGrid(y: number, m: number): MonthGrid {
  const first = makeDay(y, m, 1);
  const lead = mondayIndex(first);
  const total = daysInMonth(y, m);
  const cells: MonthCell[] = [];
  for (let i = 0; i < total; i++) {
    const slot = lead + i;
    cells.push({ day: first + i, d: i + 1, col: slot % 7, row: Math.floor(slot / 7) });
  }
  return { lead, total, cells, rows: Math.ceil((lead + total) / 7) };
}

export default function ReadCalendar({ list, focusDay, today, onFocusDay, onPick }: Props) {
  const [mode, setMode] = useState<CalMode>("month");
  const [pinnedDay, setPinnedDay] = useState<string | null>(null);
  const todayParts = dayParts(today);
  const currentYear = todayParts.y;
  const currentMonth = todayParts.m;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const monthRef = useRef<HTMLDivElement | null>(null);
  const wantFocus = useRef(false);
  const hoverRef = useRef<ReadHoverHandle | null>(null);
  const hoverKey = useRef("");
  const pinnedRef = useRef<string | null>(null);

  /** 每年去重后的在读本数：一本书跨几年在几年各算一次，不按天数重复累加 */
  const yearCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of list) {
      const b = readBounds(e);
      if (!Number.isFinite(b.a) || !Number.isFinite(b.b) || b.a > today) continue;
      const y0 = dayParts(b.a).y;
      const y1 = dayParts(Math.min(b.b, today)).y;
      for (let y = y0; y <= y1; y++) m.set(y, (m.get(y) || 0) + 1);
    }
    return m;
  }, [list, today]);

  /** 年份下限：最早有效开始日所在年；一本都没有就跟今年重合 */
  const yearLo = Math.min(currentYear, ...yearCounts.keys());

  /** 焦点日决定当前年/月。外部定位与键盘跨年都只改焦点，不另存一份日期 */
  const fp = dayParts(focusDay);
  const year = Math.max(yearLo, Math.min(currentYear, fp.y));
  const month = fp.y === year ? fp.m : 1;

  /** 当前可见年的闭区间索引：年格、月格、选中日书目、悬停与点击都读它 */
  const dayIndex = useMemo(() => {
    const m = new Map<string, ReadEntry[]>();
    const lo = yearFirst(year);
    const hi = dayNum(`${year}-12-31`);
    for (const e of list) {
      const b = readBounds(e);
      if (!Number.isFinite(b.a) || !Number.isFinite(b.b)) continue;
      const a = Math.max(b.a, lo);
      const z = Math.min(b.b, hi, today);
      if (a > z) continue;
      for (let d = a; d <= z; d++) {
        const key = dayStr(d);
        const arr = m.get(key);
        if (arr) arr.push(e);
        else m.set(key, [e]);
      }
    }
    return m;
  }, [list, year, today]);

  const yearTotal = yearCounts.get(year) || 0;

  /**
   * 当前可见年里真正的开始/读完日各落了哪些书。只认记录里填过的起止：
   * 没填 start/end、退回 anchor 的不算端点；区间被年界或今天裁掉时，
   * 也绝不把裁出来的第一天/最后一天当端点。这里存书本身而不是计数，
   * 方格里的书名与 +n 都只读这份端点书单。
   */
  const edgeIndex = useMemo(() => {
    const m = new Map<string, ReadEntry[]>();
    const lo = yearFirst(year);
    const hi = dayNum(`${year}-12-31`);
    for (const e of list) {
      const s = dayNum(e.start);
      const en = dayNum(e.end);
      if (!Number.isFinite(s) && !Number.isFinite(en)) continue;
      const b = readBounds(e);
      if (!Number.isFinite(b.a) || !Number.isFinite(b.b)) continue;
      /* 一天读完的书只算一次 */
      const days = b.a === b.b ? [b.a] : [b.a, b.b];
      for (const d of days) {
        if (d < lo || d > hi || d > today) continue;
        const key = dayStr(d);
        const arr = m.get(key);
        if (arr) arr.push(e);
        else m.set(key, [e]);
      }
    }
    return m;
  }, [list, year, today]);

  /** 同书连读细线：只取真实跨天区间，按书分轨，最多三轨 */
  const tracks = useMemo(
    () => buildCalendarTracks(list, year, today),
    [list, year, today]
  );

  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = currentYear; y >= yearLo; y--) out.push(y);
    return out;
  }, [currentYear, yearLo]);

  /* ---- 全年：十二个月，各自由 buildMonthGrid 铺六行 ---- */
  const yearGrids = useMemo(
    () => MONTHS.map((m) => ({ m, grid: buildMonthGrid(year, m) })),
    [year]
  );

  /* ---- 月历：七列，周一至周日 ---- */
  const monthGrid = useMemo(() => buildMonthGrid(year, month), [year, month]);

  const selected = dayStr(focusDay);
  const selectedBooks = useMemo(
    () => dayIndex.get(selected) ?? EMPTY_BOOKS,
    [dayIndex, selected]
  );

  const clearHover = () => {
    hoverKey.current = "";
    hoverRef.current?.hide();
  };

  /** 固定浮层的状态与日历的 aria 共用一份；浮层自己收起时也从这里回写 */
  const rememberPin = (ds: string | null) => {
    pinnedRef.current = ds;
    setPinnedDay(ds);
  };

  const clearPin = () => {
    if (!pinnedRef.current) return;
    pinnedRef.current = null;
    setPinnedDay(null);
    hoverRef.current?.unpin();
  };

  /** 固定在某天：位置用点击点；键盘激活用格子中心，随后浮层自己把焦点送进卡片 */
  const pinDay = (day: number, x: number, y: number, keyboard: boolean) => {
    const ds = dayStr(day);
    const books = dayIndex.get(ds) ?? EMPTY_BOOKS;
    if (!books.length) return;
    hoverKey.current = "";
    /* 已经固定在同一天：原样保留浮层与位置，不 hide、不重挂 */
    if (pinnedRef.current === ds) return;
    rememberPin(ds);
    hoverRef.current?.pin(day, books, x, y, { keyboard });
  };

  /**
   * 点日期：只选中，不直开详情。有书就把浮层固定在这一点；
   * 空日期只移动选中，并收起原来的固定浮层。有书的日期不再先 hide，
   * 让悬停浮层就地变成固定浮层，避免按下时闪一下。
   */
  const activateDay = (day: number, x: number, y: number, keyboard: boolean) => {
    const books = dayIndex.get(dayStr(day)) ?? EMPTY_BOOKS;
    onFocusDay(day);
    if (books.length) {
      pinDay(day, x, y, keyboard);
    } else {
      clearHover();
      clearPin();
    }
  };

  const move = (target: number) => {
    clearHover();
    clearPin();
    const lo = yearFirst(yearLo);
    const d = Math.min(today, Math.max(lo, target));
    wantFocus.current = true;
    onFocusDay(d);
  };

  /** 换到某年某月，尽量保留日号；超出当月天数或今天则收敛 */
  const jumpMonth = (y: number, m: number) => {
    const d = Math.min(fp.d, daysInMonth(y, m));
    let target = makeDay(y, m, d);
    if (target > today) target = today;
    move(target);
  };

  const shiftMonth = (delta: number) => {
    const idx = fp.y * 12 + (fp.m - 1) + delta;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    if (y < yearLo || y > currentYear) return;
    if (y === currentYear && m > currentMonth) return;
    jumpMonth(y, m);
  };

  const jumpYear = (y: number) => {
    jumpMonth(Math.max(yearLo, Math.min(currentYear, y)), fp.m);
  };

  /* 滚轮翻月永远走现成的 shiftMonth，边界、跨年与「不超过今天」都由它兜住 */
  const shiftRef = useRef(shiftMonth);
  shiftRef.current = shiftMonth;
  const wheelAt = useRef(0);
  const wheelDir = useRef(0);

  /**
   * 月历上的滚轮翻月。监听只挂在月历容器本身：固定书目的浮层挂在 body，
   * 在浮动列表里滚动不会冒泡到这里。Ctrl/Meta 留给缩放，纯横向手势不动月份。
   * 连续惯性按「距上一次方向的静默时间」去重，反向手势立即放行。
   */
  useEffect(() => {
    if (mode !== "month") return;
    const el = monthRef.current;
    if (!el) return;
    wheelAt.current = 0;
    wheelDir.current = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (!e.deltaY || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? -1 : 1;
      const now = performance.now();
      const quiet = now - wheelAt.current;
      wheelAt.current = now;
      if (dir === wheelDir.current && quiet < 160) return;
      wheelDir.current = dir;
      shiftRef.current(dir);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]);

  const atMinMonth = year <= yearLo && month <= 1;
  const atMaxMonth = year >= currentYear && month >= currentMonth;

  /** 月历与全年共用：委托一个移动事件即可；同一格内只挪浮层，不重渲整张日历 */
  const hoverDayCell = (e: React.PointerEvent<HTMLDivElement>) => {
    /* 固定后鼠标怎么移都不改浮层，也不因离开日期而收起 */
    if (pinnedRef.current) return;
    if (e.pointerType === "touch") return;
    const t = e.target as Element | null;
    const cell = t && t.closest ? (t.closest(".rd-cal-cell[data-day]") as HTMLElement | null) : null;
    const ds = cell?.getAttribute("data-day") || "";
    const books = ds ? dayIndex.get(ds) : undefined;
    if (!books || !books.length) {
      if (hoverKey.current) clearHover();
      return;
    }
    if (hoverKey.current !== ds) {
      hoverKey.current = ds;
      hoverRef.current?.show(dayNum(ds), books, e.clientX, e.clientY);
    } else {
      hoverRef.current?.move(e.clientX, e.clientY);
    }
  };

  const switchMode = (next: CalMode) => {
    if (next === mode) return;
    clearHover();
    clearPin();
    // 打开整年时先展示年初，避免焦点把页面滚到选中日期。
    wantFocus.current = next === "month";
    setMode(next);
  };

  /* 切年、切视图或刷新后，浮层不能停在旧格子上；固定浮层同样收掉。
     只选自己的日期（selected 与固定日相同）不触发清理，避免刚固定就消失 */
  useEffect(() => {
    hoverKey.current = "";
    hoverRef.current?.hide();
    if (pinnedRef.current) {
      pinnedRef.current = null;
      setPinnedDay(null);
      hoverRef.current?.unpin();
    }
  }, [mode, year, list]);

  useEffect(() => {
    if (pinnedRef.current && pinnedRef.current !== selected) {
      pinnedRef.current = null;
      setPinnedDay(null);
      hoverRef.current?.unpin();
    }
  }, [selected]);

  /* 方向键跨年/跨月后，格子是重新挂的。等这一轮渲染完再把焦点送回选中的那格 */
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-day="${selected}"]`);
    el?.focus();
  }, [selected, year, month, mode]);

  /* 从详情返回时组件会重新挂载，若焦点落在页面本身则还给选中格 */
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-day="${selected}"]`);
    el?.focus({ preventScroll: true });
    // 只在挂载时做一次；后续焦点由 wantFocus 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const day = dayNum(selected);
    if (!Number.isFinite(day)) return;
    let next: number | null = null;
    /* 两种视图都是七列：左右 ±1 天，上下 ±7 天 */
    if (e.key === "ArrowLeft") next = day - 1;
    else if (e.key === "ArrowRight") next = day + 1;
    else if (e.key === "ArrowUp") next = day - 7;
    else if (e.key === "ArrowDown") next = day + 7;
    else if (e.key === "Home") next = day - mondayIndex(day);
    else if (e.key === "End") next = day - mondayIndex(day) + 6;
    else if (e.key === "PageUp") {
      e.preventDefault();
      if (mode === "month") shiftMonth(-1);
      else jumpYear(fp.y - 1);
      return;
    } else if (e.key === "PageDown") {
      e.preventDefault();
      if (mode === "month") shiftMonth(1);
      else jumpYear(fp.y + 1);
      return;
    }
    if (next == null) return;
    e.preventDefault();
    move(next);
  };

  const totalLabel =
    year === currentYear
      ? `${year} 年截至今天阅读 ${yearTotal} 本`
      : `${year} 年共阅读 ${yearTotal} 本`;

  const legend = (
    <div className="rd-cal-legend" aria-label="在读本数色阶">
      <span>少</span>
      {[1, 2, 3, 4].map((n) => (
        <i
          key={n}
          className="rd-cal-swatch"
          title={n === 4 ? "4 本以上" : n + " 本"}
          style={{
            background: `color-mix(in srgb, var(--acc) ${calFillPct(n, 0)}%, var(--bg2))`
          }}
        />
      ))}
      <span>多</span>
      <span className="rd-cal-legend-t">按本数加深 · 起止日更深</span>
    </div>
  );

  /**
   * 日期格底部那几根同书细线。prev/next 只在本行、本月内成立：
   * 周一没有左邻、周日没有右邻，跨周跨月时线在新一行同色重新起头。
   */
  const renderTracks = (
    books: ReadEntry[],
    day: number,
    prevOK: boolean,
    nextOK: boolean
  ) => {
    const runs = calendarRuns(books, tracks, day, prevOK, nextOK);
    if (!runs.length) return null;
    return (
      <span className="rd-cal-runs" aria-hidden="true">
        {runs.map((r) => (
          <span
            key={r.bookId}
            className={"rd-cal-run" + (r.prev ? " run-prev" : "") + (r.next ? " run-next" : "")}
            data-book={r.bookId}
            data-prev={r.prev ? "true" : "false"}
            data-next={r.next ? "true" : "false"}
            style={{ "--rd-run-lane": r.lane, "--rd-run-h": r.hue } as React.CSSProperties}
          />
        ))}
      </span>
    );
  };

  return (
    <div className="rd-cal" data-mode={mode}>
      <div className="rd-cal-head">
        <div className="rd-cal-yearbar">
          <div className="rd-cal-modes" role="group" aria-label="日历视图">
            <button
              type="button"
              className="rd-cal-modebtn"
              aria-pressed={mode === "month"}
              onClick={() => switchMode("month")}
            >
              月历
            </button>
            <button
              type="button"
              className="rd-cal-modebtn"
              aria-pressed={mode === "year"}
              onClick={() => switchMode("year")}
            >
              全年
            </button>
          </div>

          {mode === "month" ? (
            <>
              <button
                className="mini xs"
                disabled={atMinMonth}
                onClick={() => shiftMonth(-1)}
                title="上一个月"
              >
                ‹ 上月
              </button>
              <label className="rd-cal-yearpick">
                <span className="sr-only">选择月份</span>
                <select
                  value={month}
                  onChange={(e) => jumpMonth(year, Number(e.target.value))}
                  aria-label="选择月份"
                >
                  {MONTHS.map((m) => (
                    <option
                      key={m}
                      value={m}
                      disabled={year === currentYear && m > currentMonth}
                    >
                      {m} 月
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="mini xs"
                disabled={atMaxMonth}
                onClick={() => shiftMonth(1)}
                title="下一个月"
              >
                下月 ›
              </button>
              <label className="rd-cal-yearpick">
                <span className="sr-only">选择年份</span>
                <select
                  value={year}
                  onChange={(e) => jumpYear(Number(e.target.value))}
                  aria-label="选择年份"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y} 年 · {yearCounts.get(y) || 0} 本
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <button
                className="mini xs"
                disabled={year <= yearLo}
                onClick={() => jumpYear(year - 1)}
                title="上一年"
              >
                ‹ 上一年
              </button>
              <label className="rd-cal-yearpick">
                <span className="sr-only">选择年份</span>
                <select
                  value={year}
                  onChange={(e) => jumpYear(Number(e.target.value))}
                  aria-label="选择年份"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y} 年 · {yearCounts.get(y) || 0} 本
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="mini xs"
                disabled={year >= currentYear}
                onClick={() => jumpYear(year + 1)}
                title="下一年"
              >
                下一年 ›
              </button>
            </>
          )}
        </div>
        <div className="rd-cal-focus">
          <b>{fullDate(focusDay)}</b>
          <span>{totalLabel}</span>
          {year === currentYear && yearTotal === 0 ? <span className="rd-cal-none">今年还没有阅读记录</span> : null}
        </div>
      </div>

      <div className={"rd-cal-layout " + mode}>
        {mode === "month" ? (
          <div className="rd-cal-monthview" ref={monthRef}>
            <div className="rd-cal-weekhead" aria-hidden="true">
              {WEEK.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div
              className="rd-cal-monthgrid"
              ref={gridRef}
              role="grid"
              aria-label={`${year} 年 ${month} 月阅读日历`}
              style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}
              onKeyDown={onKey}
              onPointerOver={hoverDayCell}
              onPointerMove={hoverDayCell}
              onPointerLeave={clearHover}
            >
              {Array.from({ length: monthGrid.lead }, (_, i) => (
                <span
                  key={"pad-l" + i}
                  className="rd-cal-pad"
                  style={{ gridColumn: i + 1, gridRow: 1 }}
                  aria-hidden="true"
                />
              ))}
              {monthGrid.cells.map(({ day, d, col, row }) => {
                const ds = dayStr(day);
                const books = dayIndex.get(ds) ?? EMPTY_BOOKS;
                const edgeBooks = edgeIndex.get(ds) ?? EMPTY_BOOKS;
                const n = books.length;
                const future = day > today;
                const isToday = day === today;
                const isSel = ds === selected;
                const isPinned = pinnedDay === ds;
                const edge = edgeBooks.length;
                const lvl = n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4;
                const label = future
                  ? `${fullDate(day)}，尚未到来`
                  : `${fullDate(day)}，${n ? n + " 本在读" : "没有阅读记录"}`;
                return (
                  <button
                    key={ds}
                    type="button"
                    className={
                      "rd-cal-cell day" +
                      (lvl ? " lvl" + lvl : "") +
                      (future ? " future" : "") +
                      (isToday ? " today" : "") +
                      (isSel ? " sel" : "")
                    }
                    data-day={ds}
                    data-n={n}
                    data-edge-count={edge}
                    style={
                      {
                        gridColumn: col + 1,
                        gridRow: row + 1,
                        ...(n > 0 ? { "--rd-cal-fill": `${calFillPct(n, edge)}%` } : {})
                      } as React.CSSProperties
                    }
                    disabled={future}
                    tabIndex={isSel ? 0 : -1}
                    aria-label={label}
                    aria-pressed={isSel}
                    aria-expanded={isPinned ? true : undefined}
                    aria-controls={isPinned ? "rd-cal-popup" : undefined}
                    title={n ? undefined : label}
                    onClick={(ev) => {
                      const r = ev.currentTarget.getBoundingClientRect();
                      activateDay(day, ev.clientX || r.left + r.width / 2, ev.clientY || r.top + r.height / 2, false);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter" && ev.key !== " ") return;
                      ev.preventDefault();
                      const r = ev.currentTarget.getBoundingClientRect();
                      activateDay(day, r.left + r.width / 2, r.top + r.height / 2, true);
                    }}
                  >
                    <span className="rd-cal-dnum">{d}</span>
                    {!future && edgeBooks.length ? (
                      <span className="rd-cal-bks">
                        {edgeBooks.slice(0, 3).map((b, i) => (
                          <span key={b.id + ":" + i} className={"rd-cal-bk b" + (i + 1)}>
                            {b.title}
                          </span>
                        ))}
                        {edgeBooks.length > 3 ? (
                          <span className="rd-cal-more m3">+{edgeBooks.length - 3}</span>
                        ) : null}
                        {edgeBooks.length > 2 ? (
                          <span className="rd-cal-more m2">+{edgeBooks.length - 2}</span>
                        ) : null}
                        {edgeBooks.length > 1 ? (
                          <span className="rd-cal-more m1">+{edgeBooks.length - 1}</span>
                        ) : null}
                      </span>
                    ) : null}
                    {!future
                      ? renderTracks(books, day, col > 0 && d > 1, col < 6 && d < monthGrid.total)
                      : null}
                  </button>
                );
              })}
              {Array.from(
                { length: monthGrid.rows * 7 - monthGrid.lead - monthGrid.total },
                (_, i) => {
                  const slot = monthGrid.lead + monthGrid.total + i;
                  return (
                    <span
                      key={"pad-t" + i}
                      className="rd-cal-pad"
                      style={{ gridColumn: (slot % 7) + 1, gridRow: Math.floor(slot / 7) + 1 }}
                      aria-hidden="true"
                    />
                  );
                }
              )}
            </div>
            {legend}
          </div>
        ) : (
          <div className="rd-cal-yearview">
            <div
              className="rd-cal-yeargrid"
              ref={gridRef}
              role="group"
              aria-label={`${year} 年阅读日历`}
              onKeyDown={onKey}
              onPointerOver={hoverDayCell}
              onPointerMove={hoverDayCell}
              onPointerLeave={clearHover}
            >
              {yearGrids.map(({ m, grid }) => {
                const trailing = 42 - grid.lead - grid.total;
                return (
                  <section
                    key={m}
                    className="rd-cal-year-month"
                    data-month={m}
                    aria-label={`${year} 年 ${m} 月`}
                  >
                    <h4 className="rd-cal-year-mh">{m} 月</h4>
                    <div className="rd-cal-year-week" aria-hidden="true">
                      {WEEK.map((w) => (
                        <span key={w}>{w}</span>
                      ))}
                    </div>
                    {Array.from({ length: grid.lead }, (_, i) => (
                      <span key={"pad-l" + i} className="rd-cal-pad" aria-hidden="true" />
                    ))}
                    {grid.cells.map(({ day, d, col }) => {
                      const ds = dayStr(day);
                      const books = dayIndex.get(ds) ?? EMPTY_BOOKS;
                      const edgeBooks = edgeIndex.get(ds) ?? EMPTY_BOOKS;
                      const n = books.length;
                      const future = day > today;
                      const isToday = day === today;
                      const isSel = ds === selected;
                      const isPinned = pinnedDay === ds;
                      const edge = edgeBooks.length;
                      const lvl = n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4;
                      const label = future
                        ? `${fullDate(day)}，尚未到来`
                        : `${fullDate(day)}，${n ? n + " 本在读" : "没有阅读记录"}`;
                      /* 有书的日期使用自定义浮窗，避免同时显示系统提示。 */
                      return (
                        <button
                          key={ds}
                          type="button"
                          className={
                            "rd-cal-cell" +
                            (lvl ? " lvl" + lvl : "") +
                            (future ? " future" : "") +
                            (isToday ? " today" : "") +
                            (isSel ? " sel" : "")
                          }
                          data-day={ds}
                          data-n={n}
                          data-edge-count={edge}
                          style={
                            n > 0
                              ? ({ "--rd-cal-fill": `${calFillPct(n, edge)}%` } as React.CSSProperties)
                              : undefined
                          }
                          disabled={future}
                          tabIndex={isSel ? 0 : -1}
                          aria-label={label}
                          aria-pressed={isSel}
                          aria-expanded={isPinned ? true : undefined}
                          aria-controls={isPinned ? "rd-cal-popup" : undefined}
                          title={n ? undefined : label}
                          onClick={(ev) => {
                            const r = ev.currentTarget.getBoundingClientRect();
                            activateDay(day, ev.clientX || r.left + r.width / 2, ev.clientY || r.top + r.height / 2, false);
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key !== "Enter" && ev.key !== " ") return;
                            ev.preventDefault();
                            const r = ev.currentTarget.getBoundingClientRect();
                            activateDay(day, r.left + r.width / 2, r.top + r.height / 2, true);
                          }}
                        >
                          <span className="rd-cal-dnum">{d}</span>
                          {!future && edgeBooks.length ? (
                            <span className="rd-cal-bks">
                              <span className="rd-cal-bk">{edgeBooks[0].title}</span>
                              {edgeBooks.length > 1 ? (
                                <span className="rd-cal-more">+{edgeBooks.length - 1}</span>
                              ) : null}
                            </span>
                          ) : null}
                          {!future
                            ? renderTracks(books, day, col > 0 && d > 1, col < 6 && d < grid.total)
                            : null}
                        </button>
                      );
                    })}
                    {Array.from({ length: trailing }, (_, i) => (
                      <span key={"pad-t" + i} className="rd-cal-pad" aria-hidden="true" />
                    ))}
                  </section>
                );
              })}
            </div>
            {legend}
          </div>
        )}

        {/* 月历里书目已由固定浮层承担：格内书名 + 点击固定可滚列表，
            不再在底下重复一整块选中日书目；全年视图维持原侧栏 */}
        {mode === "year" ? (
        <aside className="rd-cal-books" aria-live="polite">
          <div className="rd-cal-bhead">
            <div>
              <b>{fullDate(focusDay)}</b>
              <span>{selectedBooks.length ? selectedBooks.length + " 本在读" : "没有阅读记录"}</span>
            </div>
          </div>
          {selectedBooks.length ? (
            <div className="rd-cal-blist">
              {selectedBooks.map((e) => (
                <button key={e.id} className="rd-cal-book" onClick={() => onPick(e.id)} title={e.title}>
                  <span className="rd-cal-cover">
                    {e.cover ? <img src={coverUrl(e.cover, e.coverV)} alt="" loading="lazy" /> : null}
                  </span>
                  <span className="rd-cal-btxt">
                    <span className="rd-cal-bt">{e.title}</span>
                    <span className="rd-cal-ba">{e.authors.join("、") || "佚名"}</span>
                    {ratingText(e.rating) ? <span className="rd-cal-br">★ {ratingText(e.rating)}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rd-cal-empty">
              <p>当天没有阅读记录</p>
            </div>
          )}
        </aside>
        ) : null}
      </div>

      <ReadCalendarHover
        ref={hoverRef}
        onHidden={() => {
          hoverKey.current = "";
        }}
        onPinChange={(d) => rememberPin(d == null ? null : dayStr(d))}
        onPick={onPick}
      />
    </div>
  );
}
