import { useEffect, useMemo, useRef, useState } from "react";
import { coverUrl } from "../api";
import { DAY_MS, dayNum, dayParts, dayStr } from "../../shared/readScale";
import type { ReadEntry, ReadStats } from "../../shared/types";
import { ratingText } from "./GridView";

/**
 * 阅读日历：一年一张热力图，一列一周、周一到周日七行。
 *
 * 计数只认 readStats.byDay（读完日）。只有开始日期的书不在格子里，
 * 因此点开任何一天，书目也用 readTimeline 的 end 对齐，口径不会出现两套。
 *
 * 年份范围从最早有读完记录的年份到今年；空年照样出现在下拉里。
 * 点日期只改变焦点，是否直接打开详情由 ReadView 决定 —— 单本直开、多本列全。
 */
interface Props {
  list: ReadEntry[];
  stats: ReadStats;
  /** 共享焦点日，天序号 */
  focusDay: number;
  today: number;
  /** 点格子：选中这一天。ReadView 负责单本直开 */
  onDayClick: (day: number) => void;
  /** 方向键等只移动焦点，不自动开详情 */
  onFocusDay: (day: number) => void;
  onPick: (id: string) => void;
}

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

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

export default function ReadCalendar({
  list,
  stats,
  focusDay,
  today,
  onDayClick,
  onFocusDay,
  onPick
}: Props) {
  const todayStr = dayStr(today);
  const currentYear = dayParts(today).y;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const wantFocus = useRef(false);

  /* 只认读完日，且今天之后的日子不计：当前年统计与格子都只到 today */
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of stats.byDay) if (d.n > 0 && d.day <= todayStr) m.set(d.day, d.n);
    return m;
  }, [stats.byDay, todayStr]);

  const yearCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const [d, c] of byDay) {
      const y = Number(d.slice(0, 4));
      if (Number.isFinite(y)) m.set(y, (m.get(y) || 0) + c);
    }
    return m;
  }, [byDay]);

  /** 年份下限：最早有读完记录的年份；一本都没有就跟今年重合 */
  const yearLo = useMemo(() => {
    let lo = currentYear;
    for (const key of byDay.keys()) {
      const y = Number(key.slice(0, 4));
      if (Number.isFinite(y) && y < lo) lo = y;
    }
    return lo;
  }, [byDay, currentYear]);

  /** 焦点日决定当前年份。外部定位与键盘跨年都只改焦点，不另存一份年份 */
  const focusYear = dayParts(focusDay).y;
  const year = Math.max(yearLo, Math.min(currentYear, focusYear));

  const dayCount = (d: string) => byDay.get(d) || 0;
  const yearTotal = useMemo(() => {
    let n = 0;
    for (const [d, c] of byDay) if (Number(d.slice(0, 4)) === year) n += c;
    return n;
  }, [byDay, year]);

  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = currentYear; y >= yearLo; y--) out.push(y);
    return out;
  }, [currentYear, yearLo]);

  const cells = useMemo(() => {
    const jan1 = yearFirst(year);
    const days = yearFirst(year + 1) - jan1;
    const pad = mondayIndex(jan1);
    const weeks = Math.ceil((pad + days) / 7);
    const out: { day: number; col: number; row: number }[] = [];
    for (let i = 0; i < days; i++) {
      const day = jan1 + i;
      const slot = pad + i;
      out.push({ day, col: Math.floor(slot / 7), row: slot % 7 });
    }
    return { weeks, out };
  }, [year]);

  const months = useMemo(() => {
    const out: { m: number; col: number }[] = [];
    let lastCol = -1;
    for (let m = 1; m <= 12; m++) {
      const d = dayNum(`${year}-${String(m).padStart(2, "0")}-01`);
      const slot = d - yearFirst(year) + mondayIndex(yearFirst(year));
      const real = Math.floor(slot / 7);
      if (real === lastCol) continue;
      lastCol = real;
      out.push({ m, col: real });
    }
    return out;
  }, [year]);

  const selected = dayStr(focusDay);
  /* 与 ReadView 的单本直开同一口径：只认 e.end，不退回开始日/anchor */
  const selectedBooks = useMemo(
    () =>
      list.filter((e) => {
        const en = dayNum(e.end);
        return Number.isFinite(en) && dayStr(en) === selected;
      }),
    [list, selected]
  );

  const gotoYear = (y: number) => {
    const prefix = String(y) + "-";
    let target = "";
    for (const d of byDay.keys()) {
      if (d.startsWith(prefix) && d <= todayStr && d > target) target = d;
    }
    onFocusDay(dayNum(target || `${y}-01-01`));
  };

  const move = (target: number) => {
    const lo = yearFirst(yearLo);
    const d = Math.min(today, Math.max(lo, target));
    wantFocus.current = true;
    onFocusDay(d);
  };

  /* 方向键跨年后，格子是重新挂的。等这一轮渲染完再把焦点送回选中的那格 */
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const el = gridRef.current?.querySelector(`[data-day="${selected}"]`) as HTMLElement | null;
    el?.focus();
  }, [selected, year]);

  const onKey = (e: React.KeyboardEvent) => {
    const day = dayNum(selected);
    if (!Number.isFinite(day)) return;
    let next: number | null = null;
    /* 网格是一列一周、一行一天：左右跨周 ±7，上下跨星期 ±1 */
    if (e.key === "ArrowLeft") next = day - 7;
    else if (e.key === "ArrowRight") next = day + 7;
    else if (e.key === "ArrowUp") next = day - 1;
    else if (e.key === "ArrowDown") next = day + 1;
    else if (e.key === "Home") next = day - mondayIndex(day);
    else if (e.key === "End") next = day - mondayIndex(day) + 6;
    else if (e.key === "PageUp") next = dayNum(`${dayParts(day).y - 1}-${String(dayParts(day).m).padStart(2, "0")}-${String(dayParts(day).d).padStart(2, "0")}`);
    else if (e.key === "PageDown") next = dayNum(`${dayParts(day).y + 1}-${String(dayParts(day).m).padStart(2, "0")}-${String(dayParts(day).d).padStart(2, "0")}`);
    if (next == null) return;
    e.preventDefault();
    move(next);
  };

  const totalLabel =
    year === currentYear ? `${year} 年截至今天共 ${yearTotal} 本` : `${year} 年共 ${yearTotal} 本`;

  return (
    <div className="rd-cal">
      <div className="rd-cal-head">
        <div className="rd-cal-yearbar">
          <button
            className="mini xs"
            disabled={year <= yearLo}
            onClick={() => gotoYear(year - 1)}
            title="上一年"
          >
            ‹ 上一年
          </button>
          <label className="rd-cal-yearpick">
            <span className="sr-only">选择年份</span>
            <select value={year} onChange={(e) => gotoYear(Number(e.target.value))} aria-label="选择年份">
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
            onClick={() => gotoYear(year + 1)}
            title="下一年"
          >
            下一年 ›
          </button>
        </div>
        <div className="rd-cal-focus">
          <b>{fullDate(focusDay)}</b>
          <span>{totalLabel}</span>
          {year === currentYear && yearTotal === 0 ? <span className="rd-cal-none">今年还没有读完记录</span> : null}
        </div>
      </div>

      <div className="rd-cal-layout">
        <div className="rd-cal-board">
          <div className="rd-cal-main">
            <div className="rd-cal-week" aria-hidden="true">
              {WEEK.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="rd-cal-scroll">
              <div
                className="rd-cal-grid"
                ref={gridRef}
                role="grid"
                aria-label={`${year} 年阅读热力图`}
                style={{
                  gridTemplateColumns: `repeat(${cells.weeks}, var(--rd-cal-cell))`
                }}
                onKeyDown={onKey}
              >
                {months.map((m) => (
                  <span
                    key={m.m}
                    className="rd-cal-month"
                    style={{ gridColumn: m.col + 1, gridRow: 1 }}
                  >
                    {m.m}月
                  </span>
                ))}
                {cells.out.map(({ day, col, row }) => {
                  const d = dayStr(day);
                  const n = dayCount(d);
                  const future = day > today;
                  const isToday = day === today;
                  const isSel = d === selected;
                  const lvl = n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4;
                  const label = future ? `${fullDate(day)}，尚未到来` : `${fullDate(day)}，${n ? n + " 本读完" : "没有读完记录"}`;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={
                        "rd-cal-cell lvl" +
                        lvl +
                        (future ? " future" : "") +
                        (isToday ? " today" : "") +
                        (isSel ? " sel" : "")
                      }
                      data-day={d}
                      data-n={n}
                      style={{ gridColumn: col + 1, gridRow: row + 2 }}
                      disabled={future}
                      tabIndex={isSel ? 0 : -1}
                      aria-label={label}
                      aria-pressed={isSel}
                      title={label}
                      onClick={() => onDayClick(day)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <div className="rd-cal-legend" aria-label="读完本数色阶">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((n) => (
              <i key={n} className={"rd-cal-swatch lvl" + n} title={n === 4 ? "4 本以上" : n + " 本"} />
            ))}
            <span>多</span>
            <span className="rd-cal-legend-t">0 / 1 / 2 / 3 / 4+ 本</span>
          </div>
        </div>

        <aside className="rd-cal-books" aria-live="polite">
          <div className="rd-cal-bhead">
            <div>
              <b>{fullDate(focusDay)}</b>
              <span>{selectedBooks.length ? selectedBooks.length + " 本读完" : "没有读完记录"}</span>
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
              <p>当天没有读完记录</p>
              <p className="dim">只填开始日期的书不进入日历；可以到时间线上查看。</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
