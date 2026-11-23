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

/**
 * 横排：轴压在底部，阅读区间从轴往上长。
 *
 * 坐标只由 shared/readScale 的日期换算给，书卡不再按中点推挤；
 * 同一天读完了多少本只聚成一个带数量的圆点，所以 26 本也不会把轴撑开。
 * 拉远后读完标记按年、月聚合，聚合桶从全量数据算，平移时不会重新分组。
 * 起止相交的区间最多占两条轨道，第三条起收进带数量的「叠加」标记，
 * 点开是完整清单，书一本不少。
 */
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

interface Bar {
  e: ReadEntry;
  x0: number;
  x1: number;
  lane: 0 | 1;
}

interface Overflow {
  entries: ReadEntry[];
  x0: number;
  x1: number;
  day: number;
}

/** 世界坐标下排轨道。只按日期相交，不看当前视窗，所以平移稳定 */
function layoutBars(list: ReadEntry[], sc: Scale): { bars: Bar[]; overflow: Overflow[] } {
  const spans = list
    .map((e) => {
      const b = readBounds(e);
      if (!Number.isFinite(b.a) || b.b <= b.a) return null;
      return { e, x0: sc.xOf(b.a), x1: sc.xOf(b.b + 1), mid: Math.round((b.a + b.b) / 2) };
    })
    .filter((v): v is { e: ReadEntry; x0: number; x1: number; mid: number } => !!v)
    .sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);

  const laneEnd = [-Infinity, -Infinity];
  const bars: Bar[] = [];
  const hidden: { e: ReadEntry; x0: number; x1: number; mid: number }[] = [];
  for (const s of spans) {
    let lane: 0 | 1 | -1 = -1;
    if (s.x0 >= laneEnd[0]) lane = 0;
    else if (s.x0 >= laneEnd[1]) lane = 1;
    if (lane === -1) {
      hidden.push(s);
      continue;
    }
    laneEnd[lane] = s.x1;
    bars.push({ e: s.e, x0: s.x0, x1: s.x1, lane });
  }

  /* 收起来的那几段按相交关系抱成团，一团一枚数量标记；点开是全清单 */
  const groups: Overflow[] = [];
  hidden.sort((a, b) => a.x0 - b.x0);
  for (const s of hidden) {
    const g = groups[groups.length - 1];
    if (g && s.x0 <= g.x1) {
      g.entries.push(s.e);
      g.x1 = Math.max(g.x1, s.x1);
      g.day = Math.min(g.day, s.mid);
    } else {
      groups.push({ entries: [s.e], x0: s.x0, x1: s.x1, day: s.mid });
    }
  }
  return { bars, overflow: groups };
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

  const { bars, overflow } = useMemo(() => layoutBars(list, sc), [list, sc]);
  const marks = useMemo(() => navMarks(list, sc, navRange), [list, sc, navRange]);

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
    if (el0.closest("button, .rd-nav, .rd-hpanel, .rd-hedge")) return;
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
    if (bucketKind === "day") return finishBuckets(list, "day").map((b) => ({ ...b, kind: "day" as const }));
    if (bucketKind === "month") return finishBuckets(list, "month").map((b) => ({ ...b, kind: "month" as const }));
    return finishBuckets(list, "year").map((b) => ({ ...b, kind: "year" as const }));
  }, [list, bucketKind]);

  const tk = useMemo(() => {
    if (!view.x1) return [];
    const lo = Math.max(0, navRange.a);
    const hi = Math.min(sc.width, Math.max(lo + 1, navRange.b));
    return ticks(sc, sc.dayAt(view.x0), sc.dayAt(view.x1), view.k || 1).filter(
      (t) => t.x >= lo && t.x < hi
    );
  }, [sc, view, navRange.a, navRange.b]);

  /* 跨年区间按年份区间取交集裁边：区间外的部分不画出来 */
  const shownBars = useMemo(() => {
    if (!view.x1) return [];
    const lo = Math.max(0, navRange.a);
    const hi = Math.min(sc.width, Math.max(lo + 1, navRange.b));
    return bars
      .filter((b) => b.x1 > view.x0 - 80 && b.x0 < view.x1 + 80)
      .map((b) => ({ ...b, x0: Math.max(b.x0, lo), x1: Math.min(b.x1, hi) }))
      .filter((b) => b.x1 > b.x0);
  }, [bars, view.x0, view.x1, navRange.a, navRange.b, sc.width]);

  const shownBuckets = useMemo(() => {
    if (!view.x1) return [];
    const lo = Math.max(0, navRange.a);
    const hi = Math.min(sc.width, Math.max(lo + 1, navRange.b));
    return buckets.filter((b) => {
      const x = sc.xOf(b.day);
      return x >= lo && x <= hi && x > view.x0 - 120 && x < view.x1 + 120;
    });
  }, [buckets, sc, view.x0, view.x1, navRange.a, navRange.b]);

  const edgeClip = useMemo(() => {
    if (!view.x1) return { l: false, r: false };
    let l = false;
    let r = false;
    for (const b of bars) {
      if (b.x1 <= view.x0 || b.x0 >= view.x1) continue;
      if (b.x0 < view.x0) l = true;
      if (b.x1 > view.x1) r = true;
    }
    return { l, r };
  }, [bars, view.x0, view.x1]);

  const focusX = Math.min(boundsRef.current.b, Math.max(boundsRef.current.a, sc.xOf(focusDay)));

  const enter = (e: ReadEntry) => (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    setHover({ e, anchor: { x: r.left + r.width / 2, y: r.top, side: "top" } });
  };

  return (
    <div
      className="rd-hwrap"
      ref={wrapRef}
      tabIndex={0}
      aria-label="横排阅读区间时间线，方向键按天或周移动"
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

      <div className="rd-hstage" ref={hostRef}>
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

          {shownBars.map((b) => {
            const wide = (b.x1 - b.x0) * (view.k || 1) >= 120;
            const from = dayParts(readBounds(b.e).a);
            const to = dayParts(readBounds(b.e).b);
            return (
              <button
                key={"bar-" + b.e.id}
                type="button"
                className={"rd-hbar lane" + b.lane}
                data-id={b.e.id}
                data-title={b.e.title + " · " + b.e.start + " 至 " + b.e.end}
                style={{
                  ["--wx" as never]: b.x0,
                  ["--ww" as never]: Math.max(1, b.x1 - b.x0),
                  ["--lane" as never]: b.lane
                }}
                aria-label={`${b.e.title}，${b.e.start} 至 ${b.e.end}`}
                title={`${b.e.title} · ${b.e.start} 至 ${b.e.end}`}
                onMouseEnter={enter(b.e)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPick(b.e.id)}
              >
                <span className="rd-hbar-t">{b.e.title}</span>
                {wide ? (
                  <>
                    <span className="rd-hbar-d0">{String(from.m).padStart(2, "0")}-{String(from.d).padStart(2, "0")}</span>
                    <span className="rd-hbar-d1">{String(to.m).padStart(2, "0")}-{String(to.d).padStart(2, "0")}</span>
                  </>
                ) : null}
              </button>
            );
          })}

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

          {overflow.map((g, i) => (
            <button
              key={"ovf-" + i}
              type="button"
              className="rd-hovf"
              data-i={i}
              style={{ ["--wx" as never]: g.x0 }}
              aria-label={`还有 ${g.entries.length} 个重叠区间，打开完整清单`}
              title={`还有 ${g.entries.length} 个重叠区间`}
              onClick={() => openDay(g.entries, g.day, "重叠区间 · " + g.entries.length + " 本")}
            >
              <b>{g.entries.length}</b>
              <span>段</span>
            </button>
          ))}
        </div>
        {edgeClip.l ? <div className="rd-hedge l" aria-hidden="true">‹</div> : null}
        {edgeClip.r ? <div className="rd-hedge r" aria-hidden="true">›</div> : null}
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
