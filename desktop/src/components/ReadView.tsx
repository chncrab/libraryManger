import { useEffect, useMemo, useRef, useState } from "react";
import api from "../api";
import ReadAxis from "./ReadAxis";
import ReadCalendar from "./ReadCalendar";
import ReadFeed from "./ReadFeed";
import type { ReadTimelineHandle } from "./readTypes";
import {
  buildScale,
  dayNum,
  dayParts,
  dayStr,
  FIXED_MONTH_W,
  finishDay,
  latestRecordedDay,
  yearBands,
  yearRange
} from "../../shared/readScale";
import type { ReadEntry, ReadStats } from "../../shared/types";
import "./readViews.css";

/**
 * 阅读页。统计照旧挂在顶栏，视图分「时间线｜日历」；时间线里再分「竖排｜横排」。
 *
 * 日期焦点只有一份：focusDay 是天序号，不是像素。横排、竖排、日历都围着它转；
 * 横竖各自记缩放，切换时回到同一天。手动年份区间缩小时焦点收进边界，
 * 从日历或日期框定位到区间外时区间自动扩到目标年并同步两个年份框。
 *
 * 换算用 buildScale 的固定月宽模式：每月等宽、空月保留、铺到本地今天，
 * 月宽不再被某一天集中录入的书撑开。旧调用没传 fixedMonthW，仍是最密月定宽。
 */
interface Props {
  /** 写操作之后加一，用来重新取数 */
  ver: number;
  onPick: (id: string) => void;
}

const LAYOUT_KEY = "booklib.readLayout";
const MODE_KEY = "booklib.readMode";
const RANGE_KEY = "booklib.readRange";

/** 「2016-2022」这样的串；空的或者不成样子就当没选 */
function parseRange(s: string | null): { y0: number; y1: number } | null {
  const m = /^(\d{4})-(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const y0 = Number(m[1]);
  const y1 = Number(m[2]);
  if (!(y0 >= 1900 && y1 >= y0 && y1 <= 2200)) return null;
  return { y0, y1 };
}

function localDay(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function clampYears(day: number, y0: number, y1: number): number {
  const a = dayNum(`${y0}-01-01`);
  const b = dayNum(`${y1}-12-31`);
  return Math.min(b, Math.max(a, day));
}

/**
 * 一个四位年份框，右边一对上下箭头各调一年。
 * 手离框（或者按回车）就按上下界夹住 —— 早于最早那本、晚于今年的都写不进去。
 */
function YearBox({
  value,
  min,
  max,
  onChange,
  title
}: {
  value: number;
  min: number;
  max: number;
  onChange: (y: number) => void;
  title: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const put = (y: number) => {
    const v = Math.min(max, Math.max(min, y));
    setText(String(v));
    if (v !== value) onChange(v);
  };
  const base = () => {
    const n = Number(text.replace(/\D/g, ""));
    return text.trim() && n >= 1900 ? n : value;
  };
  const commit = () => {
    const n = Number(text.replace(/\D/g, ""));
    if (!text.trim() || !Number.isFinite(n)) setText(String(value));
    else put(n);
  };

  return (
    <span className="rd-year" title={title}>
      <input
        className="rd-year-in"
        value={text}
        inputMode="numeric"
        maxLength={4}
        aria-label={title}
        onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            put(base() + 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            put(base() - 1);
          }
        }}
      />
      <span className="rd-year-steps">
        <button
          className="rd-year-step up"
          tabIndex={-1}
          disabled={value >= max}
          title="加一年"
          onClick={() => put(base() + 1)}
        >
          ▲
        </button>
        <button
          className="rd-year-step down"
          tabIndex={-1}
          disabled={value <= min}
          title="减一年"
          onClick={() => put(base() - 1)}
        >
          ▼
        </button>
      </span>
    </span>
  );
}

export default function ReadView({ ver, onPick }: Props) {
  const todayStr = useMemo(localDay, []);
  const today = useMemo(() => dayNum(todayStr), [todayStr]);
  const currentY = dayParts(today).y;

  const [list, setList] = useState<ReadEntry[]>([]);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<"timeline" | "calendar">(() =>
    localStorage.getItem(MODE_KEY) === "calendar" ? "calendar" : "timeline"
  );
  const [layout, setLayout] = useState<"feed" | "axis">(() =>
    localStorage.getItem(LAYOUT_KEY) === "axis" ? "axis" : "feed"
  );
  const [range, setRange] = useState<{ y0: number; y1: number } | null>(() =>
    parseRange(localStorage.getItem(RANGE_KEY))
  );
  const [focusDay, setFocusDay] = useState(today);
  const [axisZoom, setAxisZoom] = useState(1);
  const [feedZoom, setFeedZoom] = useState(1);
  const viewRef = useRef<ReadTimelineHandle | null>(null);
  const initFocus = useRef(false);
  const calendarSeen = useRef(mode === "calendar");

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);
  useEffect(() => {
    localStorage.setItem(RANGE_KEY, range ? range.y0 + "-" + range.y1 : "");
  }, [range]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([api.readTimeline(), api.readStats()])
      .then(([l, s]) => {
        if (!alive) return;
        setList(l);
        setStats(s);
        setError("");
      })
      .catch(() => {
        if (!alive) return;
        setList([]);
        setStats(null);
        setError("读取阅读记录失败。请确认书库可用后重试。");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ver, reload]);

  /* 日期表把所有起止日都带上：开始与结束边界都进轴，跨期区间按交集裁切。
     空库也铺今天一条，日历与时间线都有落点 */
  const sc = useMemo(() => {
    const days: number[] = [];
    /* 轴只铺到今天：今天之后的日期不进坐标系，可见结束日天然以上限收口 */
    const push = (d: number) => {
      if (Number.isFinite(d) && d <= today) days.push(d);
    };
    if (list.length) {
      for (const e of list) {
        push(finishDay(e));
        push(dayNum(e.start));
        push(dayNum(e.end));
      }
    }
    if (!days.length) days.push(today);
    return buildScale(days, { until: today, fixedMonthW: FIXED_MONTH_W });
  }, [list, today]);

  const bands = useMemo(() => yearBands(list.map((e) => e.anchor), sc), [list, sc]);
  const years = useMemo(() => bands.map((b) => b.y), [bands]);
  const yearLo = list.length ? Math.min(currentY, dayParts(sc.first).y) : currentY;
  const yearHi = Math.max(currentY, dayParts(sc.last).y);

  const eff = useMemo(() => {
    const r = range ?? { y0: yearLo, y1: yearHi };
    const y0 = Math.min(Math.max(r.y0, yearLo), yearHi);
    return { y0, y1: Math.min(Math.max(r.y1, y0), yearHi) };
  }, [range, yearLo, yearHi]);
  const navRange = useMemo(() => yearRange(sc, eff.y0, eff.y1), [sc, eff]);

  const clampScale = (day: number) => Math.min(sc.last, Math.max(sc.first, day));

  /** 定位到某天。expand 为真时把手动年份区间扩到目标年，两个年份框随之更新 */
  const focusTo = (day: number, expand = false) => {
    const d = clampScale(day);
    if (expand) {
      const y = dayParts(d).y;
      if (y < eff.y0 || y > eff.y1) {
        setRange({
          y0: Math.min(y, eff.y0),
          y1: Math.max(y, eff.y1)
        });
      }
    }
    setFocusDay(d);
  };

  /* 第一次落焦点：时间线落最近一条记录，日历落今天。空库都是今天。
     存过的手动区间若把它挡在外头，先夹回边界 */
  useEffect(() => {
    if (loading || initFocus.current) return;
    initFocus.current = true;
    if (!list.length) {
      setFocusDay(today);
      return;
    }
    const latest = latestRecordedDay(list);
    const seed = mode === "calendar" ? today : Number.isFinite(latest) ? Math.min(today, latest) : today;
    setFocusDay(clampYears(Math.min(sc.last, Math.max(sc.first, seed)), eff.y0, eff.y1));
  }, [loading, list, today, mode, sc, eff]);

  /** 改区间的一头：另一头让开。焦点若被关在外头，收进最近的边界 */
  const setYear = (side: "from" | "to", y: number) => {
    const cur = eff;
    const v = Math.min(yearHi, Math.max(yearLo, y));
    const next =
      side === "from"
        ? { y0: v, y1: Math.max(v, cur.y1) }
        : { y0: Math.min(v, cur.y0), y1: v };
    setRange(next);
    const f = clampYears(focusDay, next.y0, next.y1);
    if (f !== focusDay) {
      setFocusDay(f);
      viewRef.current?.seekDay(f);
    }
  };

  const resetRange = () => {
    setRange(null);
    const f = clampYears(focusDay, yearLo, yearHi);
    if (f !== focusDay) {
      setFocusDay(f);
      viewRef.current?.seekDay(f);
    }
  };

  /* 日历的书目和单本直开都只认读完日 e.end，不退回开始日/anchor */
  const dayBooks = (day: number) =>
    list.filter((e) => {
      const en = dayNum(e.end);
      return Number.isFinite(en) && en === day;
    });

  /** 日历里点一天：只改共享焦点，不动时间线年份区间；单本直开 */
  const pickCalendarDay = (day: number) => {
    setFocusDay(clampScale(day));
    const books = dayBooks(day);
    if (books.length === 1) onPick(books[0].id);
  };

  /* 数据刷新后焦点若落到轴外（最早那本被删了），拉回最近的边界 */
  useEffect(() => {
    if (loading) return;
    const d = Math.min(sc.last, Math.max(sc.first, focusDay));
    if (d !== focusDay) setFocusDay(d);
  }, [loading, sc, focusDay]);

  /**
   * 进日历。普通点「日历」第一次默认今天；显式「在日历定位」keep 为真，
   * 保留当前目标日。两者都只挪共享焦点，不扩时间线年份区间。
   */
  const openCalendar = (keep = false) => {
    if (!keep && !calendarSeen.current) setFocusDay(today);
    calendarSeen.current = true;
    setMode("calendar");
  };

  const goToday = () => {
    if (mode === "calendar") {
      setFocusDay(today);
      return;
    }
    focusTo(today, true);
    viewRef.current?.seekDay(today);
  };

  const gotoDate = (s: string) => {
    const d = dayNum(s);
    if (!Number.isFinite(d)) return;
    const v = Math.min(today, Math.max(sc.first, d));
    focusTo(v, true);
    viewRef.current?.seekDay(v);
  };

  return (
    <div className="main">
      <div className="toolbar rd-bar">
        {error ? (
          <span className="rd-error">
            {error}
            <button className="mini xs" onClick={() => setReload((n) => n + 1)}>
              重试
            </button>
          </span>
        ) : stats ? (
          <>
            <span>
              <b className="rd-n">{stats.total}</b> 本有日期
            </span>
            <span>
              今年读完 <b className="rd-n">{stats.yearRead}</b> 本
            </span>
            {stats.busiest ? (
              <span>
                最忙 <b className="rd-n">{stats.busiest.n}</b> 本在 {stats.busiest.day}
              </span>
            ) : null}
            {stats.avgRating != null ? (
              <span>
                均分 <b className="rd-n">{stats.avgRating}</b>
              </span>
            ) : null}
            {stats.streak.days > 1 ? (
              <span>
                最长连读 <b className="rd-n">{stats.streak.days}</b> 天，止于 {stats.streak.end}
              </span>
            ) : null}
            <span className="rd-scope">仅小说</span>
            <span className="spacer" />
            {stats.noDate ? <span className="dim">另有 {stats.noDate} 本标了已读、没填日期，落不到这里</span> : null}

            <div className="seg rd-mode">
              <button className={mode === "timeline" ? "on" : ""} onClick={() => setMode("timeline")}>
                时间线
              </button>
              <button className={mode === "calendar" ? "on" : ""} onClick={() => openCalendar()}>
                日历
              </button>
            </div>

            {mode === "timeline" && years.length ? (
              <div className="rd-range">
                <span className="rd-range-name">显示区间</span>
                <YearBox
                  value={eff.y0}
                  min={yearLo}
                  max={eff.y1}
                  onChange={(y) => setYear("from", y)}
                  title={"从哪一年起，最早 " + yearLo}
                />
                <span className="rd-dash">–</span>
                <YearBox
                  value={eff.y1}
                  min={eff.y0}
                  max={yearHi}
                  onChange={(y) => setYear("to", y)}
                  title={"到哪一年止，最晚 " + yearHi}
                />
                <button className="mini xs" onClick={resetRange} title={"回到 " + yearLo + " – " + yearHi}>
                  重置
                </button>
              </div>
            ) : null}

            {mode === "timeline" ? (
              <div className="seg rd-switch">
                <button className={layout === "feed" ? "on" : ""} onClick={() => setLayout("feed")}>
                  竖排
                </button>
                <button className={layout === "axis" ? "on" : ""} onClick={() => setLayout("axis")}>
                  横排
                </button>
              </div>
            ) : null}

            {mode === "timeline" ? (
              <div className="rd-timectl">
                <span className="rd-focus" title="当前焦点日期">
                  焦点 <b>{dayStr(focusDay)}</b>
                </span>
                <button className="mini xs" onClick={goToday} title="回到今天">
                  今天
                </button>
                <input
                  className="rd-goto"
                  type="date"
                  value={dayStr(focusDay)}
                  min={dayStr(sc.first)}
                  max={todayStr}
                  aria-label="定位日期"
                  title="定位到日期"
                  onChange={(e) => gotoDate(e.target.value)}
                />
                <button
                  className="mini xs"
                  onClick={() => viewRef.current?.zoomBy(0.8)}
                  title="缩小"
                  aria-label="缩小"
                >
                  −
                </button>
                <button
                  className="mini xs"
                  onClick={() => viewRef.current?.zoomBy(1.25)}
                  title="放大"
                  aria-label="放大"
                >
                  ＋
                </button>
              </div>
            ) : (
              <button className="mini xs" onClick={goToday} title="回到今天">
                今天
              </button>
            )}

            <button
              className="mini xs rd-to-cal"
              onClick={() => {
                if (mode === "calendar") {
                  /* 只有从日历回时间线才扩年份区间，保证目标日真的在轴里 */
                  focusTo(focusDay, true);
                  setMode("timeline");
                } else openCalendar(true);
              }}
              title={mode === "calendar" ? "回到时间线" : "在日历中定位当前焦点"}
            >
              {mode === "calendar" ? "在时间线定位" : "在日历定位"}
            </button>
          </>
        ) : (
          <span>读取中…</span>
        )}
      </div>

      <div
        className={
          "scroll" +
          (mode === "calendar" ? " rd-calscroll" : layout === "axis" ? " rd-axscroll" : " rd-feedscroll")
        }
      >
        {error ? (
          <div className="empty rd-errorbody">
            <p>{error}</p>
            <button className="mini" onClick={() => setReload((n) => n + 1)}>
              重新加载
            </button>
          </div>
        ) : loading && !stats ? (
          <div className="empty">读取中…</div>
        ) : mode === "calendar" && stats ? (
          <ReadCalendar
            list={list}
            stats={stats}
            focusDay={focusDay}
            today={today}
            onDayClick={pickCalendarDay}
            onFocusDay={(d) => setFocusDay(clampScale(d))}
            onPick={onPick}
          />
        ) : !list.length ? (
          <div className="empty">还没有一本填了阅读时间</div>
        ) : layout === "axis" ? (
          <ReadAxis
            ref={viewRef}
            list={list}
            sc={sc}
            bands={bands}
            navRange={navRange}
            focusDay={focusDay}
            today={today}
            initialZoom={axisZoom}
            onFocus={(d) => setFocusDay(clampScale(d))}
            onZoom={setAxisZoom}
            onPick={onPick}
          />
        ) : (
          <ReadFeed
            ref={viewRef}
            list={list}
            sc={sc}
            bands={bands}
            range={navRange}
            focusDay={focusDay}
            today={today}
            initialZoom={feedZoom}
            onFocus={(d) => setFocusDay(clampScale(d))}
            onZoom={setFeedZoom}
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}
