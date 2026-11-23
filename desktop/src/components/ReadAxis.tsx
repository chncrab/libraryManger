import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { coverUrl } from "../api";
import {
  bucketAt,
  dayLabel,
  dayNum,
  dayParts,
  dayStr,
  finishBuckets,
  monthFirstOfKey,
  monthKeyOf,
  navMarks,
  readBounds,
  ticks,
  type NavRange,
  type ReadBucket,
  type Scale,
  type YearBand
} from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";
import ReadTip, { type TipAnchor } from "./ReadTip";
import ReadNav, { type ReadNavHandle } from "./ReadNav";
import { ratingText } from "./GridView";
import type { ReadTimelineHandle } from "./readTypes";

interface Props {
  list: ReadEntry[];
  sc: Scale;
  bands: YearBand[];
  navRange: NavRange;
  focusDay: number;
  today: number;
  initialZoom: number;
  onFocus: (day: number) => void;
  onZoom: (k: number) => void;
  onPick: (id: string) => void;
}

const K_MIN = 0.08;
const K_MAX = 7;
const EASE_MS = 90;
const COVER_WIDTH = 108;
const COVER_EDGE = 31;
const MAX_COVERS = 7;

interface CoverPile {
  day: number;
  left: number;
  entries: ReadEntry[];
}

const visibleCoverCount = (pile: CoverPile) => Math.min(pile.entries.length, MAX_COVERS);
const pileWidth = (pile: CoverPile) => COVER_WIDTH + (visibleCoverCount(pile) - 1) * COVER_EDGE;

/** 相邻日期靠得过近时合成一叠，给每张封面留出可点击的边。 */
function layoutCovers(days: ReadBucket<ReadEntry>[], sc: Scale, zoom: number, lo: number, hi: number): CoverPile[] {
  const step = COVER_EDGE / zoom;
  const piles: CoverPile[] = [];
  for (const bucket of days) {
    const anchor = sc.xOf(bucket.day);
    if (anchor < lo || anchor >= hi) continue;
    const left = Math.max(lo, anchor - COVER_WIDTH / (2 * zoom));
    const last = piles[piles.length - 1];
    if (last && left < last.left + visibleCoverCount(last) * step) {
      last.entries.push(...bucket.entries);
    } else {
      piles.push({ day: bucket.day, left, entries: bucket.entries.slice() });
    }
  }

  /* 右端把最后一叠向内靠齐。和前一叠挤到一起时合并，保持露边。 */
  while (piles.length) {
    const last = piles[piles.length - 1];
    const width = pileWidth(last) / zoom;
    if (last.left + width <= hi) break;
    last.left = hi - width;
    const previous = piles[piles.length - 2];
    if (previous && last.left < previous.left + visibleCoverCount(previous) * step) {
      previous.entries.push(...last.entries);
      piles.pop();
      continue;
    }
    if (last.left < lo) last.left = (lo + hi - width) / 2;
    break;
  }
  return piles;
}
const ReadAxis = forwardRef<ReadTimelineHandle, Props>(function ReadAxis(
  { list, sc, bands, navRange, focusDay, today, initialZoom, onFocus, onZoom, onPick },
  ref
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<ReadNavHandle | null>(null);
  const onFocusRef = useRef(onFocus);
  const onZoomRef = useRef(onZoom);
  onFocusRef.current = onFocus;
  onZoomRef.current = onZoom;

  const marks = useMemo(() => navMarks(list, sc, navRange), [list, sc, navRange]);
  const days = useMemo(() => finishBuckets(list, "day"), [list]);

  const [view, setView] = useState({ x0: 0, x1: 0, k: initialZoom });
  const viewRef = useRef(view);
  const [hover, setHover] = useState<{ e: ReadEntry; anchor: TipAnchor } | null>(null);
  const [panel, setPanel] = useState<{ title: string; day: number; entries: ReadEntry[] } | null>(null);
  const bucketRef = useRef(bucketAt(sc.monthW * (initialZoom || 1)));

  const camRef = useRef({ k: initialZoom, off: 0 });
  const tgtRef = useRef({ k: initialZoom, off: 0 });
  const zoomRef = useRef<{ wx: number; cx: number } | null>(null);
  /** 年份区间（并到今天为止）在世界坐标里的可看范围，镜头与绘制都夹在这里 */
  const boundsRef = useRef({ a: 0, b: Math.max(1, sc.width) });
  boundsRef.current = {
    a: Math.max(0, Math.min(sc.width, navRange.a)),
    b: Math.min(sc.width, Math.max(Math.max(0, navRange.a) + 1, navRange.b))
  };
  const lastT = useRef(0);
  const rafRef = useRef(0);
  const glideRef = useRef(0);
  const lastReport = useRef(0);
  const focusReport = useRef(focusDay);
  /** 程序定位钉住的日期：镜头绘制时不许用视口中点把它冲掉 */
  const pinRef = useRef<number | null>(focusDay);
  /** 只有用户平移/拖导航条之后，才把视口中点回写给工具栏 */
  const needReport = useRef(false);

  const maxOff = useCallback((k = tgtRef.current.k) => {
    const w = hostRef.current?.clientWidth || 0;
    const { a, b } = boundsRef.current;
    return Math.max(0, (b - a) * k - w);
  }, []);

  /** 夹进年份区间对应的世界坐标；区间比视口还窄时居中摆 */
  const clampOff = useCallback(
    (v: number, k = tgtRef.current.k) => {
      const w = hostRef.current?.clientWidth || 0;
      const { a, b } = boundsRef.current;
      const lo = a * k;
      const span = Math.max(1, (b - a) * k);
      if (span <= w) return lo - (w - span) / 2;
      return Math.min(lo + span - w, Math.max(lo, v));
    },
    []
  );

  /** 程序定位：记下真实日期，并暂停中点回写直到用户再平移 */
  const pinFocus = (day: number) => {
    if (Number.isFinite(day)) {
      pinRef.current = day;
      focusReport.current = day;
    }
    needReport.current = false;
  };

  /** 用户操作改变视口才报焦点；归一化到可见区间，避免落到区间外 */
  const reportFocus = (day: number) => {
    if (!Number.isFinite(day)) return;
    const { a, b } = boundsRef.current;
    const lo = Math.max(sc.first, sc.dayAt(a));
    const hi = Math.min(today, sc.dayAt(b));
    const d = Math.min(Math.max(day, Math.min(lo, hi)), Math.max(lo, hi));
    if (Number.isFinite(d) && d !== focusReport.current) {
      focusReport.current = d;
      onFocusRef.current(d);
    }
  };

  const scheduleRef = useRef<() => void>(() => {});
  const drawRef = useRef<() => void>(() => {});

  const draw = () => {
    rafRef.current = 0;
    const host = hostRef.current;
    const rail = railRef.current;
    if (!host || !rail) return;

    const now = performance.now();
    const dt = Math.min(64, Math.max(8, now - lastT.current || 16));
    lastT.current = now;
    const c = camRef.current;
    const t = tgtRef.current;
    if (c.k !== t.k) {
      const a = 1 - Math.exp(-dt / EASE_MS);
      const k = Math.exp(Math.log(c.k) + (Math.log(t.k) - Math.log(c.k)) * a);
      c.k = Math.abs(t.k - k) < 0.002 ? t.k : k;
      const z = zoomRef.current;
      c.off = z ? clampOff(z.wx * c.k - z.cx, c.k) : clampOff(c.off + (t.off - c.off) * a, c.k);
    } else if (c.off !== t.off) {
      const a = 1 - Math.exp(-dt / EASE_MS);
      c.off = Math.abs(t.off - c.off) < 0.4 ? t.off : clampOff(c.off + (t.off - c.off) * a, c.k);
    }

    host.style.setProperty("--k", c.k.toFixed(6));
    rail.style.transform = `translate3d(${-c.off}px,0,0)`;

    const vw = host.clientWidth;
    const vx0 = c.off / c.k;
    const vx1 = (c.off + vw) / c.k;
    navRef.current?.setView(vx0, vx1);

    const x0 = (c.off - 320) / c.k;
    const x1 = (c.off + vw + 320) / c.k;
    const prev = viewRef.current;
    const slack = Math.max(180, (x1 - x0) * 0.18);
    const kq = Math.round(c.k * 20) / 20;
    if (Math.abs(x0 - prev.x0) > slack || Math.abs(x1 - prev.x1) > slack || Math.abs(kq - prev.k) > 0.026) {
      const next = { x0, x1, k: kq };
      viewRef.current = next;
      setView(next);
    }

    /* 只有用户平移/拖导航条之后才跟着视野中心回写焦点。程序定位（初始化、
       点日期、今日、模式切换、缩放按钮）钉住真实日期，哪怕镜头夹在边界或还在
       过渡，也不会被视口中点替换。拖的时候每 140ms 报一次，过渡结束再补一次 */
    const settled = c.k === t.k && c.off === t.off;
    const center = sc.dayAt((c.off + vw / 2) / c.k);
    if (pinRef.current == null && needReport.current) {
      const due = settled || now - lastReport.current > 140;
      if (due) {
        lastReport.current = now;
        if (settled) needReport.current = false;
        reportFocus(center);
      }
    }

    if (c.k !== t.k || c.off !== t.off) scheduleRef.current();
  };
  drawRef.current = draw;

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);
  scheduleRef.current = schedule;

  const kick = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  const jumpTo = useCallback(
    (off: number) => {
      const o = clampOff(off);
      zoomRef.current = null;
      tgtRef.current.off = o;
      camRef.current.off = o;
      schedule();
    },
    [clampOff, schedule]
  );

  const stopGlide = () => {
    if (glideRef.current) {
      cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
    }
  };

  const startGlide = (speed: number) => {
    stopGlide();
    let last = performance.now();
    let v = speed;
    const step = () => {
      const now = performance.now();
      const dt = Math.min(50, now - last);
      last = now;
      const before = camRef.current.off;
      jumpTo(before + v * dt);
      v *= Math.pow(0.92, dt / 16.7);
      const stuck = camRef.current.off === before && (before === 0 || before >= maxOff());
      glideRef.current = !stuck && Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    glideRef.current = requestAnimationFrame(step);
  };

  const centerOn = useCallback(
    (day: number, k = tgtRef.current.k) => {
      const host = hostRef.current;
      if (!host) return;
      const x = sc.xOf(day) * k;
      const off = clampOff(x - host.clientWidth / 2, k);
      zoomRef.current = null;
      tgtRef.current = { k, off };
      pinFocus(day);
      schedule();
    },
    [clampOff, schedule, sc]
  );

  /** 初始与从日历定位：把焦点日摆到视野中心 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const k = Math.min(K_MAX, Math.max(K_MIN, initialZoom || 1));
    const off = clampOff(sc.xOf(focusDay) * k - host.clientWidth / 2, k);
    camRef.current = { k, off };
    tgtRef.current = { k, off };
    pinFocus(focusDay);
    kick();
    const ro = new ResizeObserver(() => {
      camRef.current.off = clampOff(camRef.current.off);
      tgtRef.current.off = clampOff(tgtRef.current.off);
      schedule();
    });
    ro.observe(host);
    return () => ro.disconnect();
    // 只在挂载时落一次；数据刷新与平移都保留当前镜头
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 年份区间换了：先把镜头夹进新区间，视野整个落在区间外才重新定位到区间中间 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !host.clientWidth) return;
    const c = camRef.current;
    const off = clampOff(c.off, c.k);
    if (off !== c.off) {
      c.off = off;
      tgtRef.current.off = off;
      schedule();
    }
    const vx0 = off / c.k;
    const vx1 = (off + host.clientWidth) / c.k;
    if (vx1 > navRange.a && vx0 < Math.min(navRange.b, sc.width)) return;
    centerOn(sc.dayAt((navRange.a + Math.min(navRange.b, sc.width)) / 2));
  }, [navRange.a, navRange.b, centerOn, clampOff, schedule, sc]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (glideRef.current) cancelAnimationFrame(glideRef.current);
      rafRef.current = 0;
      glideRef.current = 0;
    },
    []
  );

  const zoomAt = (factor: number, cx?: number, pin = false) => {
    const host = hostRef.current;
    if (!host) return;
    const t = tgtRef.current;
    const k2 = Math.min(K_MAX, Math.max(K_MIN, t.k * factor));
    if (Math.abs(k2 - t.k) < 1e-5) return;
    const c = cx ?? host.clientWidth / 2;
    const wx = (c + camRef.current.off) / camRef.current.k;
    zoomRef.current = { wx, cx: c };
    t.k = k2;
    t.off = clampOff(wx * k2 - c, k2);
    /* 缩放按钮是程序定位：只改尺度，焦点日仍是原来那天 */
    if (pin) pinFocus(focusReport.current);
    onZoomRef.current(k2);
    schedule();
  };

  const seekDay = useCallback(
    (day: number) => {
      const host = hostRef.current;
      if (!host) return;
      const k = tgtRef.current.k;
      const off = clampOff(sc.xOf(day) * k - host.clientWidth / 2, k);
      zoomRef.current = null;
      tgtRef.current = { k, off };
      pinFocus(day);
      schedule();
    },
    [clampOff, schedule, sc]
  );

  useImperativeHandle(
    ref,
    () => ({
      seekDay,
      zoomBy(factor: number) {
        zoomAt(factor, undefined, true);
      }
    }),
    [seekDay, zoomAt]
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host) return;
    const onWheel = (ev: WheelEvent) => {
      /* 聚合清单里的 26 本要能独立滚完，别把滚轮吞成缩放 */
      if ((ev.target as HTMLElement | null)?.closest?.(".rd-hpanel")) return;
      ev.preventDefault();
      stopGlide();
      const t = tgtRef.current;
      if ((ev.target as HTMLElement | null)?.closest?.(".rd-nav")) {
        const d = (12 * sc.monthW) / 120;
        pinRef.current = null;
        needReport.current = true;
        jumpTo(t.off + (ev.deltaY + ev.deltaX) * d);
        return;
      }
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) * 1.2) {
        pinRef.current = null;
        needReport.current = true;
        jumpTo(t.off + ev.deltaX);
        return;
      }
      const c = ev.clientX - host.getBoundingClientRect().left;
      /* 滚轮缩放是用户改视口：缩放落定后按新的中点回写焦点 */
      pinRef.current = null;
      needReport.current = true;
      zoomAt(Math.exp(-ev.deltaY * 0.0015), c);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [jumpTo, sc.monthW]);

  const dragRef = useRef<{
    x0: number;
    off0: number;
    moved: number;
    k: number;
    pts: { t: number; o: number }[];
  } | null>(null);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el0 = e.target as HTMLElement;
    /* 按钮、导航条和面板都走自己的原生点击/滚动，不在这里抢指针捕获 */
    if (el0.closest("button, .rd-nav, .rd-hpanel")) return;
    stopGlide();
    setHover(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      x0: e.clientX,
      off0: camRef.current.off,
      moved: 0,
      k: camRef.current.k,
      pts: [{ t: performance.now(), o: camRef.current.off }]
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (Math.abs(dx) >= 3) {
      pinRef.current = null;
      needReport.current = true;
    }
    d.moved = Math.max(d.moved, Math.abs(dx));
    jumpTo(d.off0 - dx);
    d.pts.push({ t: performance.now(), o: camRef.current.off });
    if (d.pts.length > 6) d.pts.shift();
  };

  const openDay = (entries: ReadEntry[], day: number, title?: string) => {
    setPanel({ title: title || `${dayStr(day)} · ${entries.length} 本`, day, entries });
  };

  const zoomBucket = (b: ReadBucket<ReadEntry>) => {
    const kind = bucketRef.current;
    const p = dayParts(b.day);
    const end =
      kind === "year"
        ? dayNum(`${p.y + 1}-01-01`)
        : monthFirstOfKey(monthKeyOf(b.day) + 1);
    const a = sc.xOf(b.day);
    const z = sc.xOf(end);
    const host = hostRef.current;
    if (!host || z <= a) return;
    const k = Math.min(K_MAX, Math.max(K_MIN, (host.clientWidth * 0.72) / (z - a)));
    const midpoint = (a + z) / 2;
    const center = host.clientWidth / 2;
    const off = clampOff(midpoint * k - center, k);
    zoomRef.current = { wx: midpoint, cx: center };
    tgtRef.current = { k, off };
    const at = sc.dayAt(midpoint);
    reportFocus(at);
    pinFocus(at);
    onZoomRef.current(k);
    schedule();
  };

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已经没了 */
    }
    if (d.moved < 4) return;
    const a = d.pts[0];
    const b = d.pts[d.pts.length - 1];
    const dt = b.t - a.t;
    if (dt > 8) startGlide((b.o - a.o) / dt);
  };

  const seekFrac = (x: number) => {
    const host = hostRef.current;
    if (!host) return;
    stopGlide();
    pinRef.current = null;
    needReport.current = true;
    jumpTo(x * tgtRef.current.k - host.clientWidth / 2);
  };

  const bucketKind = bucketAt(sc.monthW * (view.k || initialZoom || 1));
  bucketRef.current = bucketKind;
  const buckets = useMemo(() => {
    if (bucketKind === "day") return days.map((b) => ({ ...b, kind: "day" as const }));
    if (bucketKind === "month") return finishBuckets(list, "month").map((b) => ({ ...b, kind: "month" as const }));
    return finishBuckets(list, "year").map((b) => ({ ...b, kind: "year" as const }));
  }, [list, days, bucketKind]);

  const tk = useMemo(() => {
    if (!view.x1) return [];
    const lo = Math.max(0, navRange.a);
    const hi = Math.min(sc.width, Math.max(lo + 1, navRange.b));
    return ticks(sc, sc.dayAt(view.x0), sc.dayAt(view.x1), view.k || 1).filter(
      (t) => t.x >= lo && t.x < hi
    );
  }, [sc, view, navRange.a, navRange.b]);

  const { a: firstX, b: lastX } = boundsRef.current;
  const viewZoom = view.k || initialZoom || 1;
  const piles = useMemo(
    () => sc.monthW * viewZoom < 90 ? [] : layoutCovers(days, sc, viewZoom, firstX, lastX),
    [days, sc, viewZoom, firstX, lastX]
  );
  const shownPiles = view.x1 ? piles.filter((pile) =>
    pile.left < view.x1 && pile.left + pileWidth(pile) / viewZoom > view.x0
  ) : [];

  const shownBuckets = useMemo(() => {
    if (!view.x1) return [];
    const lo = Math.max(0, navRange.a);
    const hi = Math.min(sc.width, Math.max(lo + 1, navRange.b));
    return buckets.filter((b) => {
      const x = sc.xOf(b.day);
      return x >= lo && x <= hi && x > view.x0 - 120 && x < view.x1 + 120;
    });
  }, [buckets, sc, view.x0, view.x1, navRange.a, navRange.b]);

  const focusX = Math.min(lastX, Math.max(firstX, sc.xOf(focusDay)));
  const hoveredBounds = hover && readBounds(hover.e);
  const hoverStart = hoveredBounds && Math.max(firstX, sc.xOf(hoveredBounds.a));
  const hoverEnd = hoveredBounds && Math.min(lastX, sc.xOf(hoveredBounds.b + 1));

  const enter = (e: ReadEntry) => (ev: React.SyntheticEvent<HTMLElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    setHover({ e, anchor: { x: r.left + r.width / 2, y: r.top, side: "top" } });
  };

  return (
    <div
      className="rd-hwrap"
      ref={wrapRef}
      tabIndex={0}
      aria-label="横排阅读封面时间线，方向键按天或周移动"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={(e) => {
        const d = Number.isFinite(focusDay) ? focusDay : sc.first;
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = d - 1;
        else if (e.key === "ArrowRight") next = d + 1;
        else if (e.key === "ArrowUp") next = d - 7;
        else if (e.key === "ArrowDown") next = d + 7;
        else if (e.key.toLowerCase() === "t") next = today;
        if (next == null) return;
        e.preventDefault();
        seekDay(next);
      }}
    >
      <ReadNav ref={navRef} bands={bands} marks={marks} range={navRange} onSeek={seekFrac} />

      <div className="rd-hstage" ref={hostRef} style={{ ["--rd-hcover-width" as never]: COVER_WIDTH + "px" }}>
        <div className="rd-hrail" ref={railRef}>
          <div className="rd-hline" style={{ ["--wx" as never]: sc.width }} />
          <div
            className="rd-hfocus"
            style={{ ["--wx" as never]: focusX }}
            title={"焦点 " + dayLabel(focusDay)}
          >
            <span>{dayLabel(focusDay)}</span>
          </div>

          {tk.map((t) => (
            <div
              key={t.kind + "-" + t.x.toFixed(1)}
              className={"rd-htk " + t.kind}
              style={{ ["--wx" as never]: t.x, ["--ww" as never]: t.w }}
            >
              {t.label ? <span>{t.label}</span> : null}
            </div>
          ))}

          {hoverStart != null && hoverEnd != null && hoverEnd > hoverStart ? (
            <span className="rd-hcover-range" style={{ ["--wx" as never]: hoverStart, ["--ww" as never]: hoverEnd - hoverStart }} aria-hidden="true" />
          ) : null}

          {shownPiles.map((pile) => (
            <div key={pile.day} className="rd-hcover-pile" style={{ ["--wx" as never]: pile.left }}>
              {pile.entries.slice(0, MAX_COVERS).map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  className="rd-hcover"
                  style={{ left: index * COVER_EDGE }}
                  data-id={entry.id}
                  aria-label={entry.title}
                  onMouseEnter={enter(entry)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={enter(entry)}
                  onBlur={() => setHover(null)}
                  onClick={() => onPick(entry.id)}
                >
                  <span className="rd-hcover-face">
                    {entry.cover ? <img src={coverUrl(entry.cover, entry.coverV)} alt="" loading="lazy" /> : null}
                    <span className="rd-hcover-name">{entry.title}</span>
                  </span>
                </button>
              ))}
              {pile.entries.length > MAX_COVERS ? (
                <button
                  type="button"
                  className="rd-hcover-more"
                  style={{ left: pileWidth(pile) }}
                  aria-label={`查看这组的 ${pile.entries.length} 本书`}
                  onClick={() => openDay(pile.entries, pile.day, `${pile.entries.length} 本书`)}
                >
                  +{pile.entries.length - MAX_COVERS}
                </button>
              ) : null}
            </div>
          ))}

          {shownBuckets.map((b) => {
            const x = sc.xOf(b.day);
            const label =
              b.kind === "year"
                ? String(dayParts(b.day).y)
                : b.kind === "month"
                  ? `${dayParts(b.day).y}-${String(dayParts(b.day).m).padStart(2, "0")}`
                  : dayLabel(b.day);
            return (
              <button
                key={"agg-" + b.kind + "-" + b.key}
                type="button"
                className={"rd-hagg " + b.kind}
                data-kind={b.kind}
                data-key={b.kind + ":" + b.key}
                data-day={dayStr(b.day)}
                data-n={b.n}
                style={{ ["--wx" as never]: x }}
                aria-label={`${b.kind === "day" ? dayStr(b.day) : label}，${b.n} 本，${b.kind === "day" ? "打开当天书目" : "放大到这一段"}`}
                title={`${b.kind === "day" ? dayStr(b.day) : label} · ${b.n} 本`}
                onClick={() => {
                  if (b.kind === "day") {
                    reportFocus(b.day);
                    pinFocus(b.day);
                    openDay(b.entries, b.day);
                  } else {
                    zoomBucket(b);
                  }
                }}
              >
                <b>{b.kind === "day" && b.n > 99 ? "99+" : b.n}</b>
                {b.kind !== "day" ? <span>{label}</span> : null}
              </button>
            );
          })}

        </div>
      </div>

      <div className="rd-hfoot" aria-hidden="true">
        <span>拖动平移 · 滚轮/触控板缩放 · 方向键按天移动</span>
      </div>

      {panel ? (
        <div className="rd-hpanel" role="dialog" aria-label={panel.title}>
          <div className="rd-hpanel-h">
            <b>{panel.title}</b>
            <button className="mini xs" onClick={() => setPanel(null)} aria-label="关闭书目">
              关闭
            </button>
          </div>
          <div className="rd-hpanel-list">
            {panel.entries.map((e) => (
              <button key={e.id} className="rd-hpanel-row" onClick={() => onPick(e.id)}>
                <span className="rd-hpanel-cov">
                  {e.cover ? <img src={coverUrl(e.cover, e.coverV)} alt="" loading="lazy" /> : null}
                </span>
                <span className="rd-hpanel-txt">
                  <span className="rd-hpanel-t">{e.title}</span>
                  <span className="rd-hpanel-a">{e.authors.join("、") || "佚名"}</span>
                  <span className="rd-hpanel-d">
                    {e.span ? `${e.start} 至 ${e.end}` : e.end ? e.end : `${e.start} · 仅有开始日期`}
                    {ratingText(e.rating) ? ` · ★ ${ratingText(e.rating)}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <ReadTip e={hover ? hover.e : null} anchor={hover ? hover.anchor : null} />
    </div>
  );
});

export default ReadAxis;
