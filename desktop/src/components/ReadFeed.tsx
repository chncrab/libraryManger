import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { coverUrl } from "../api";
import {
  DAY_MS,
  dayParts,
  dayStr,
  finishBuckets,
  finishDay,
  monthFirstOfKey,
  monthKeyOf,
  monthLength,
  navMarks,
  type NavRange,
  type Scale,
  type YearBand
} from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";
import { ratingText } from "./GridView";
import ReadNav, { type ReadNavHandle } from "./ReadNav";
import type { ReadTimelineHandle } from "./readTypes";

/**
 * 竖排：左边一条日期尺，右边当前月份按日列书。
 *
 * 日期尺的像素直接取横排那套日期换算：(sc.xOf(day) − sc.xOf(first)) × zoom，
 * 反查用 sc.dayAt。于是二月与三月同宽，和横排完全一致，不再按「天差 × 日高」
 * 把短月压短。可见范围取 ReadView 的年份区间，结束日以今天为上限。
 *
 * 右边仍按读完日分组。日期尺滚动先预览焦点，停稳后才换右侧月份；点尺上的
 * 日期、点右侧日期标题都落到同一组。右侧另贴一条竖放的 ReadNav 进度条。
 */
interface Props {
  list: ReadEntry[];
  sc: Scale;
  bands: YearBand[];
  range: NavRange;
  focusDay: number;
  today: number;
  initialZoom: number;
  onFocus: (day: number) => void;
  onZoom: (z: number) => void;
  onPick: (id: string) => void;
}

const Z_MIN = 0.5;
const Z_MAX = 5;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function clampMonth(key: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, key));
}

const ReadFeed = forwardRef<ReadTimelineHandle, Props>(function ReadFeed(
  { list, sc, bands, range, focusDay, today, initialZoom, onFocus, onZoom, onPick },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const booksRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<ReadNavHandle | null>(null);
  const dragRef = useRef<{ y: number; top: number; moved: number } | null>(null);
  const skipScroll = useRef(0);
  const previewTimer = useRef(0);
  const focusRef = useRef(focusDay);
  const zoomRef = useRef(Math.min(Z_MAX, Math.max(Z_MIN, initialZoom || 1)));
  const onFocusRef = useRef(onFocus);
  const onZoomRef = useRef(onZoom);
  onFocusRef.current = onFocus;
  onZoomRef.current = onZoom;

  /* 年份区间与今天的交集：日期尺和绘制都落在这里，结束日不超过 today */
  const ra = Math.max(0, Math.min(sc.width, range.a));
  const rb = Math.min(sc.width, Math.max(ra + 1, range.b));
  const x0 = ra;
  const first = Math.max(sc.first, Math.min(today, sc.dayAt(x0)));
  const last = Math.min(today, Math.max(first, sc.dayAt(Math.max(x0, rb - 1))));
  const bottom = Math.min(rb, sc.xOf(last + 1));
  const loMonth = monthKeyOf(first);
  const hiMonth = monthKeyOf(last);

  const [focus, setFocus] = useState(focusDay);
  const [month, setMonth] = useState(() => clampMonth(monthKeyOf(focusDay), loMonth, hiMonth));
  const [zoom, setZoom] = useState(zoomRef.current);
  const [win, setWin] = useState({ a: first, b: first, h: 0 });
  const [preview, setPreview] = useState<number | null>(null);
  const wantGroup = useRef<number | null>(null);
  const monthRef = useRef(month);
  monthRef.current = month;
  /* 滚轮翻月：一次手势只翻一次，安静下来才解锁，惯性尾波不会连跳几个月 */
  const flipRef = useRef({ last: 0, done: false });
  /* 翻月后的落点：等新月份的书目 DOM 提交完再设置 scrollTop */
  const pendingEdge = useRef<{ key: number; edge: "top" | "bottom" } | null>(null);
  /* scrollGroup 的 rAF 版本号，翻月后作废旧 commit 的定位 */
  const scrollEpoch = useRef(0);
  const anchorZoom = useRef(false);
  const anchorRef = useRef<{ wx: number; py: number } | null>(null);

  const pxDay = (day: number) => sc.slopeAt(day) * zoom;
  const yOf = (day: number) => (sc.xOf(day) - x0) * zoom;
  const height = Math.max(1, (bottom - x0) * zoom);

  const geomRef = useRef({ x0, bottom, first, last, zoom });
  geomRef.current = { x0, bottom, first, last, zoom };
  const boundsRef = useRef({ first, last, lo: loMonth, hi: hiMonth });
  boundsRef.current = { first, last, lo: loMonth, hi: hiMonth };
  zoomRef.current = zoom;

  const recorded = useMemo(() => {
    const set = new Set<number>();
    for (const e of list) {
      const d = finishDay(e);
      if (Number.isFinite(d)) set.add(d);
    }
    return set;
  }, [list]);

  const dayGroups = useMemo(() => finishBuckets(list, "day"), [list]);
  const groups = useMemo(() => dayGroups.filter((g) => monthKeyOf(g.day) === month), [dayGroups, month]);
  const marks = useMemo(() => navMarks(list, sc, range), [list, sc, range.a, range.b]);

  const monthRecorded = groups.length > 0;

  const monthMarks = useMemo(() => {
    const out: { day: number; y: number; m: number; isYear: boolean }[] = [];
    let key = loMonth;
    while (key <= hiMonth) {
      const d = monthFirstOfKey(key);
      const p = dayParts(d);
      out.push({ day: d, y: p.y, m: p.m, isYear: p.m === 1 });
      key++;
    }
    return out;
  }, [loMonth, hiMonth]);

  const scrollRulerTo = (day: number) => {
    const box = rulerRef.current;
    if (!box) return;
    const g = geomRef.current;
    skipScroll.current = performance.now() + 120;
    const y = (sc.xOf(day) - g.x0) * zoomRef.current;
    box.scrollTop = Math.max(0, y - box.clientHeight / 2 + pxDay(day) / 2);
  };

  const scrollGroup = (day: number) => {
    const box = booksRef.current;
    if (!box) return;
    const el = box.querySelector(`[data-day="${dayStr(day)}"]`) as HTMLElement | null;
    if (!el) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop = Math.max(0, box.scrollTop + delta - 8);
  };

  const commit = (day: number, opts: { ruler?: boolean; group?: boolean } = {}) => {
    const b = boundsRef.current;
    const d = Math.min(b.last, Math.max(b.first, day));
    const key = clampMonth(monthKeyOf(d), b.lo, b.hi);
    setFocus(d);
    setMonth(key);
    focusRef.current = d;
    onFocusRef.current(d);
    if (opts.ruler !== false) scrollRulerTo(d);
    if (opts.group !== false) wantGroup.current = d;
  };
  /** 命令式手柄总拿最新一版 commit，不吃旧的 dayH / range 闭包 */
  const commitRef = useRef(commit);
  commitRef.current = commit;

  /* 月份或焦点变了、右侧重排之后再滚到那组，确保定位到某日能看到相关组 */
  useEffect(() => {
    const d = wantGroup.current;
    if (d == null) return;
    wantGroup.current = null;
    const epoch = scrollEpoch.current;
    const id = requestAnimationFrame(() => {
      if (epoch !== scrollEpoch.current) return;
      scrollGroup(d);
    });
    return () => cancelAnimationFrame(id);
  }, [month, focus, groups]);

  /* 翻月落到月初 / 月末：等这个月的书目 DOM 提交后再设 scrollTop，避免被旧的 scrollGroup 覆盖 */
  useLayoutEffect(() => {
    const p = pendingEdge.current;
    if (!p) return;
    pendingEdge.current = null;
    if (p.key !== month) return;
    const box = booksRef.current;
    if (!box) return;
    box.scrollTop = p.edge === "bottom" ? box.scrollHeight : 0;
  }, [month, groups]);

  useImperativeHandle(
    ref,
    () => ({
      seekDay(day: number) {
        commitRef.current(day);
      },
      zoomBy(factor: number) {
        const z = Math.min(Z_MAX, Math.max(Z_MIN, zoomRef.current * factor));
        if (Math.abs(z - zoomRef.current) < 0.001) return;
        zoomRef.current = z;
        setZoom(z);
        onZoomRef.current(z);
      }
    }),
    []
  );

  /* 挂载时把日期尺和右侧都落到焦点日；之后由交互推动，不跟着 prop 反复重排 */
  useEffect(() => {
    const box = rulerRef.current;
    if (!box) return;
    const g = geomRef.current;
    const d = Math.min(g.last, Math.max(g.first, focusRef.current));
    box.scrollTop = Math.max(0, (sc.xOf(d) - g.x0) * zoomRef.current - box.clientHeight / 2);
    wantGroup.current = d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 外部改了焦点（年份区间夹住、日期输入等）时跟着走 */
  useEffect(() => {
    if (focusDay === focusRef.current) return;
    const b = boundsRef.current;
    const d = Math.min(b.last, Math.max(b.first, focusDay));
    focusRef.current = d;
    setFocus(d);
    setMonth(clampMonth(monthKeyOf(d), b.lo, b.hi));
    scrollRulerTo(d);
    wantGroup.current = d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDay]);

  /* 年份区间变了：可见首尾日跟着换，焦点夹回区间并重新对准 */
  useEffect(() => {
    const b = boundsRef.current;
    const d = Math.min(b.last, Math.max(b.first, focusRef.current));
    focusRef.current = d;
    setFocus(d);
    setMonth(clampMonth(monthKeyOf(d), b.lo, b.hi));
    scrollRulerTo(d);
    wantGroup.current = d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.a, range.b]);

  /* 缩放按钮：仍把焦点日停在日期尺中间。Ctrl 滚轮自己锚定光标，不在这里抢 */
  useEffect(() => {
    if (anchorZoom.current) {
      anchorZoom.current = false;
      const a = anchorRef.current;
      const box = rulerRef.current;
      if (a && box) {
        box.scrollTop = Math.max(0, (a.wx - geomRef.current.x0) * zoom - a.py);
      }
      anchorRef.current = null;
      return;
    }
    scrollRulerTo(focusRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const read = () => {
      const g = geomRef.current;
      const z = zoomRef.current;
      const topW = g.x0 + el.scrollTop / z;
      const botW = g.x0 + (el.scrollTop + el.clientHeight) / z;
      const center = Math.min(g.last, Math.max(g.first, sc.dayAt(g.x0 + (el.scrollTop + el.clientHeight / 2) / z)));
      setWin({
        a: Math.max(g.first, sc.dayAt(topW)),
        b: Math.min(g.last, sc.dayAt(botW)),
        h: sc.slopeAt(center) * z
      });
      /* 程序化滚动（翻月 / 提交定位）不算预览，免得留下过期的浮标 */
      if (performance.now() >= skipScroll.current) setPreview(center);
      navRef.current?.setView(topW, botW);
      if (performance.now() < skipScroll.current) return;
      window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(() => {
        setPreview(null);
        commitRef.current(center, { ruler: false, group: true });
      }, 140);
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
      window.clearTimeout(previewTimer.current);
    };
  }, [zoom, x0, first, last, sc]);

  /* Ctrl + 滚轮只改刻度密度，并让光标下的那一天留在原处 */
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const py = ev.clientY - rect.top;
      const z0 = zoomRef.current;
      const wx = geomRef.current.x0 + (el.scrollTop + py) / z0;
      const z = Math.min(Z_MAX, Math.max(Z_MIN, Math.round(z0 * Math.exp(-ev.deltaY * 0.002) * 40) / 40));
      if (z === z0) return;
      zoomRef.current = z;
      anchorZoom.current = true;
      anchorRef.current = { wx, py };
      setZoom(z);
      onZoomRef.current(z);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 翻到紧邻的自然月，边界夹在既有年份区间里，空月也照走不跳 */
  const flipMonth = (dir: 1 | -1): boolean => {
    const b = boundsRef.current;
    const key = clampMonth(monthRef.current, b.lo, b.hi) + dir;
    if (key < b.lo || key > b.hi) return false;
    const start = monthFirstOfKey(key);
    const day = dir > 0 ? start : start + monthLength(start) - 1;
    window.clearTimeout(previewTimer.current);
    setPreview(null);
    wantGroup.current = null;
    scrollEpoch.current++;
    pendingEdge.current = { key, edge: dir > 0 ? "top" : "bottom" };
    commitRef.current(day, { ruler: true, group: false });
    return true;
  };

  /* 书目区滚轮：平常走原生滚动，滚到边后的下一次同向动作才翻月，Ctrl/Meta 留给系统 */
  useEffect(() => {
    const el = booksRef.current;
    if (!el) return;
    const g = flipRef.current;
    const onWheel = (ev: WheelEvent) => {
      if (ev.ctrlKey || ev.metaKey) return;
      if (ev.deltaY === 0 || Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return;
      const now = performance.now();
      const gap = now - g.last;
      g.last = now;
      if (gap >= 180) g.done = false;
      /* 同一次手势的尾波：翻过月就只吞掉，不再翻 */
      if (g.done) {
        if (ev.cancelable) ev.preventDefault();
        return;
      }
      const dir: 1 | -1 = ev.deltaY > 0 ? 1 : -1;
      const max = el.scrollHeight - el.clientHeight;
      /* 内容不足一屏 / 空月：两个方向都算到边 */
      const atEdge = max <= 2 || (dir > 0 ? el.scrollTop >= max - 2 : el.scrollTop <= 2);
      if (!atEdge) return;
      if (!flipMonth(dir)) return;
      g.done = true;
      if (ev.cancelable) ev.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveMonth = (delta: number) => {
    const b = boundsRef.current;
    const key = clampMonth(month + delta, b.lo, b.hi);
    const start = monthFirstOfKey(key);
    const rec = dayGroups.find((g) => monthKeyOf(g.day) === key);
    commit(rec ? rec.day : start);
  };

  const jumpRecorded = () => {
    if (!dayGroups.length) {
      commit(first);
      return;
    }
    const center = (monthFirstOfKey(month) + monthLength(monthFirstOfKey(month)) / 2) | 0;
    let best = dayGroups[0];
    for (const g of dayGroups) {
      if (Math.abs(g.day - center) < Math.abs(best.day - center)) best = g;
    }
    commit(best.day);
  };

  /** 竖放导航条：把某段世界坐标摆到日期尺正中 */
  const seekWorld = (x: number) => {
    const box = rulerRef.current;
    if (!box) return;
    box.scrollTop = Math.max(0, (x - geomRef.current.x0) * zoomRef.current - box.clientHeight / 2);
  };

  /* 空白处拖动日期尺。滚轮和滚动条本来就能滚，这里补鼠标按住拖 */
  const onRulerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const el = rulerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, top: el.scrollTop, moved: 0 };
  };
  const onRulerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = rulerRef.current;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dy));
    el.scrollTop = Math.max(0, d.top - dy);
  };
  const onRulerUp = (e: React.PointerEvent) => {
    const el = rulerRef.current;
    dragRef.current = null;
    try {
      el?.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已经没了 */
    }
  };

  const monthStart = monthFirstOfKey(month);
  const monthP = dayParts(monthStart);
  const focusP = dayParts(focus);
  const previewP = preview == null ? null : dayParts(preview);
  const focusY = Math.min(height, Math.max(0, yOf(focus) + pxDay(focus) / 2));

  return (
    <div className="rd-vwrap" ref={rootRef}>
      <div className="rd-vside">
        <div
          className="rd-vruler"
          ref={rulerRef}
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
          aria-label="日期尺，滚动或拖动浏览，Ctrl 加滚轮缩放"
        >
          <div className="rd-vruler-track" style={{ height }}>
            <i className="rd-vruler-line" />
            {monthMarks.map((m) => (
              <button
                key={"m" + m.day}
                className={"rd-vmark month" + (m.isYear ? " year" : "")}
                style={{ top: yOf(m.day) }}
                data-day={dayStr(m.day)}
                title={`${m.y} 年 ${m.m} 月`}
                onClick={() => commit(m.day)}
              >
                <span>{m.isYear ? m.y : m.m + "月"}</span>
              </button>
            ))}
            {win.h >= 10
              ? (() => {
                  const out: number[] = [];
                  for (let d = win.a; d <= win.b; d++) out.push(d);
                  return out.map((d) => (
                    <button
                      key={"d" + d}
                      className={"rd-vmark day" + (d === today ? " today" : "") + (d === focus ? " on" : "")}
                      style={{ top: yOf(d) + pxDay(d) / 2 }}
                      data-day={dayStr(d)}
                      title={dayStr(d)}
                      onClick={() => commit(d)}
                    >
                      <span>{dayParts(d).d}</span>
                    </button>
                  ));
                })()
              : null}
            {[...recorded]
              .filter((d) => d >= win.a && d <= win.b)
              .map((d) => (
                <i
                  key={"dot" + d}
                  className="rd-vdot"
                  style={{ top: yOf(d) + pxDay(d) / 2 }}
                  title={dayStr(d)}
                />
              ))}
            <i className="rd-vfocus" style={{ top: focusY }} title={"焦点 " + dayStr(focus)} />
          </div>
        </div>
        {previewP ? (
          <div className="rd-vpreview" aria-live="polite">
            {previewP.m} 月 {previewP.d} 日
          </div>
        ) : null}
      </div>

      <section className="rd-vmain" aria-label="当月书目">
        <header className="rd-vhead">
          <div className="rd-vtitle">
            <b>
              {monthP.y} 年 {monthP.m} 月
            </b>
            <span className="rd-vsub">
              焦点 {focusP.y}-{String(focusP.m).padStart(2, "0")}-{String(focusP.d).padStart(2, "0")}
              {groups.length ? ` · ${groups.reduce((n, g) => n + g.n, 0)} 本` : " · 本月无记录"}
            </span>
          </div>
          <div className="rd-vcontrols">
            <button className="mini xs" onClick={() => moveMonth(-1)} disabled={month <= loMonth} title="上个月">
              上月
            </button>
            <button className="mini xs" onClick={() => moveMonth(1)} disabled={month >= hiMonth} title="下个月">
              下月
            </button>
            {!monthRecorded ? (
              <button className="mini xs" onClick={jumpRecorded} title="跳到最近有记录的月份">
                最近有记录
              </button>
            ) : null}
          </div>
        </header>

        <div className="rd-vbooks" ref={booksRef}>
          {groups.length ? (
            groups.map((g) => (
              <div className="rd-vgroup" key={g.key} data-day={dayStr(g.day)}>
                <button className="rd-vgroup-h" onClick={() => commit(g.day)}>
                  <b>
                    {dayParts(g.day).m} 月 {dayParts(g.day).d} 日
                  </b>
                  <span>{g.n} 本</span>
                  <i>{WEEK[new Date(g.day * DAY_MS).getUTCDay()]}</i>
                </button>
                {g.entries.map((e) => (
                  <button
                    key={e.id}
                    className="rd-vbook"
                    onClick={() => onPick(e.id)}
                    title={e.title}
                    data-id={e.id}
                  >
                    <span className="rd-vcov">
                      {e.cover ? <img src={coverUrl(e.cover, e.coverV)} alt="" loading="lazy" /> : <i />}
                    </span>
                    <span className="rd-vtxt">
                      <span className="rd-vt">{e.title}</span>
                      <span className="rd-va">{e.authors.join("、") || "佚名"}</span>
                      <span className="rd-vm">
                        {e.end
                          ? e.span
                            ? `${e.start} 至 ${e.end}`
                            : e.end
                          : `${e.start} · 仅有开始日期`}
                        {ratingText(e.rating) ? ` · ★ ${ratingText(e.rating)}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            <div className="rd-vempty">
              <p>本月没有记录</p>
              <p className="dim">日期尺照常保留这个月的位置，可以跳到最近有记录的月份。</p>
              {dayGroups.length ? (
                <button className="mini" onClick={jumpRecorded}>
                  跳到最近有记录
                </button>
              ) : (
                <p className="dim">整库还没有填过读完日期的书。</p>
              )}
            </div>
          )}
        </div>
      </section>

      <div className="rd-vnav">
        <ReadNav
          ref={navRef}
          vertical
          bands={bands}
          marks={marks}
          range={range}
          onSeek={seekWorld}
        />
      </div>
    </div>
  );
});

export default ReadFeed;
