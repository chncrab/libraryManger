import { coverUrl } from "../api";
import { gradeIcon, ratingText } from "./GridView";
import { dayLabel, dayNum, navFrac, navX, ticks, yearBands, type Scale } from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import ReadTip, { type TipAnchor } from "./ReadTip";
import ReadNav, { type ReadNavHandle } from "./ReadNav";

/**
 * 竖排时间线：一条竖轴在正中，书从上往下按读的那段时间排开，早的在上面。
 *
 * 条目在轴左右交替站，封面都贴着轴放，文字朝外，像一条大河两边分岔。
 * 时间段平时不画，鼠标停在哪条上才动起来：先从封面拉一根细线横到轴上，
 * 再沿着轴往下漫到读完那天，当天读完的以那天为中心上下各盖半个日格。
 * 同时光标旁浮出一张写着起止、用时与评分的小卡。
 * 整条是一条瀑布，不按年折叠，最右边竖着一条按年等分的总览，拖着它跨年。
 * 右边那条要占地方，内容整体让出 34px，轴于是落在窗口正中偏左一点，
 * 免得最右那列书名被总览压住。
 *
 * Ctrl + 滚轮缩放整屏，光标那一点不动。缩放走 transform，外面另套一层
 * 按缩放撑开的盒子，滚动条才认得实际长度。倍数不打 React 的 state：
 * 一帧一个值，几百条封面跟着重渲染会卡，所以直接写到两个盒子的 style 上。
 * 目标倍数与画着的倍数分开，每帧朝目标靠一截，缩放才有过渡而不是硬跳。
 *
 * 三套倍数各管一段，跟横排是同一套口径：
 *   --z  轴上的距离，一直放大下去，日刻度才拉得开；
 *   --vi 封面与文字，放到「刚好铺满容器」就封顶，再放大不让书名涨成三倍；
 *   --zi 贴轴的那些零碎（金线、日号、探针、刻度线与刻度字），按 1/z 抵回去，
 *       屏幕上始终一样粗细大小 —— 不然放到三倍，年份会变四十多号字。
 * 只把看得见的几十条挂进 DOM：全挂着的话，改一次变量就是上千条一起重排重绘。
 */
interface Props {
  list: ReadEntry[];
  sc: Scale;
  onPick: (id: string) => void;
}

const COV_W = 44;
const COV_H = 66;
const TXT_W = 292;
const ITEM_GAP = 10;
/** 封面 + 间距 + 文字，一条的总宽 */
const ITEM_W = COV_W + ITEM_GAP + TXT_W;
/** 封面靠轴那一侧离轴多远 */
const AX_GAP = 46;
const W = (AX_GAP + ITEM_W) * 2;
/** 轴线在正中间，左右各一半 */
const AX = W / 2;
/** 同一列相邻两条最少隔这么高，交错之后实际隔一半 */
const MINSEP = COV_H + 8;
/** 竖排的缩放范围。月按同一个宽度排之后一屏只有一两个月，
    往下要能缩到 0.28 才看得见小半年；往上放到日刻度能拉开 */
const Z_MIN = 0.28;
const Z_MAX = 3.2;
/** 追目标的时间常数，与横排同一个手感 */
const EASE_MS = 90;
/** 视窗外上下各留这么高，滚过去时不至于露白；世界坐标 */
const WIN_PAD = 360;

interface Row {
  e: ReadEntry;
  y: number;
  col: 0 | 1;
  /** 轴上那段金线的上下沿，相对这条顶端 */
  barTop: number;
  barH: number;
  /** 金线两头的日号，只写几号 */
  d0: string;
  d1: string;
  span: boolean;
}

function rows(list: ReadEntry[], sc: Scale) {
  const asc = list.slice().reverse();
  const out: Row[] = [];
  /* 记的是每条占到的下沿，比较时不再另加 MINSEP，否则一列里每两条要隔两倍高 */
  const edge: [number, number] = [-1e9, -1e9];
  let alt = 0;
  for (const e of asc) {
    const a = dayNum(e.start);
    const b = dayNum(e.end || e.anchor);
    const day0 = Number.isFinite(a) ? a : b;
    const day1 = Number.isFinite(b) ? Math.max(b, day0) : day0;
    /* 一天是相邻两点之间的一段：从开始那天清晨，盖到读完那天的深夜 */
    const s = sc.xOf(day0);
    const t = sc.xOf(day1 + 1);
    const mid = (s + t) / 2;
    let y = mid - COV_H / 2;
    let col: 0 | 1 = alt as 0 | 1;
    if (y < edge[col]) {
      const other = (1 - col) as 0 | 1;
      if (y >= edge[other]) col = other;
      else {
        y = Math.min(edge[0], edge[1]);
        col = edge[0] <= edge[1] ? 0 : 1;
      }
    }
    const span = day1 > day0;
    out.push({
      e,
      y,
      col,
      barTop: s - y,
      barH: t - s,
      d0: dayLabel(day0),
      d1: dayLabel(day1),
      span
    });
    edge[col] = y + MINSEP;
    alt = 1 - col;
  }
  return { rows: out, height: Math.max(edge[0], edge[1]) + 48 };
}

export default function ReadFeed({ list, sc, onPick }: Props) {
  const { rows: items, height } = useMemo(() => rows(list, sc), [list, sc]);
  /* 导航条按年等分，一年一格，格里的柱子是那年读完几本 */
  const bands = useMemo(() => yearBands(list.map((e) => e.anchor), sc), [list, sc]);
  /** 量可见段那个 effect 只跑一次，bands 得走 ref 才拿得到新的 */
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const navRef = useRef<ReadNavHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  /* 缩放不进布局：外面那层按倍数撑开给滚动条用，里面的 .rv 整体 transform */
  const zCam = useRef(1);
  const zTgt = useRef(1);
  const lastZ = useRef(0);
  const rafZ = useRef(0);
  /** 光标下那一点的世界坐标与它离滚动框顶的距离，缩放全程按它反算 scrollTop */
  const anchor = useRef<{ wy: number; py: number } | null>(null);
  const hRef = useRef(height);
  hRef.current = height;

  /* 现在看得见的一段（世界坐标）与当下的缩放档位。只有它变了才重挂条目与刻度 */
  const [win, setWin] = useState({ y0: 0, y1: 0, z: 1 });

  /* 鼠标停在哪一条上，条目外侧浮出一张小卡。位置只在换一条时算一次 */
  const [hover, setHover] = useState<{ e: ReadEntry; anchor: TipAnchor } | null>(null);

  const boxOf = () => rootRef.current?.closest(".scroll") as HTMLElement | null;

  const drawZRef = useRef<() => void>(() => {});
  const drawZ = () => {
    rafZ.current = 0;
    const inner = innerRef.current;
    const scale = scaleRef.current;
    if (!inner || !scale) return;
    const t = zTgt.current;
    if (zCam.current !== t) {
      const now = performance.now();
      const dt = Math.min(64, Math.max(8, now - lastZ.current || 16));
      lastZ.current = now;
      const a = 1 - Math.exp(-dt / EASE_MS);
      const z = zCam.current + (t - zCam.current) * a;
      zCam.current = Math.abs(t - z) < 0.004 ? t : z;
    }
    const z = zCam.current;
    /* 封面与文字放到「刚好铺满容器」就封顶：再往上只让轴拉开，
       不然放到看得清日刻度的三倍时，书名也跟着涨成三倍 */
    const fit = Math.max(1, (scale.clientWidth || W) / W);
    inner.style.setProperty("--vi", (Math.min(fit, z) / z).toFixed(4));
    inner.style.setProperty("--zi", (1 / Math.max(1, z)).toFixed(4));
    inner.style.transform = `translateX(-50%) scale(${z})`;
    scale.style.height = hRef.current * z + "px";
    const box = boxOf();
    const a0 = anchor.current;
    if (box && a0) box.scrollTop = Math.max(0, a0.wy * z - a0.py);
    if (zCam.current !== t) scheduleZ();
  };
  drawZRef.current = drawZ;

  const scheduleZ = () => {
    if (!rafZ.current) rafZ.current = requestAnimationFrame(() => drawZRef.current());
  };

  /* 开场落在最下面，最近读的先看见，往回翻才是一年一年往前 */
  useEffect(() => {
    const box = boxOf();
    if (box) box.scrollTop = box.scrollHeight;
    return () => {
      if (rafZ.current) cancelAnimationFrame(rafZ.current);
      /* id 得一起清掉：StrictMode 下撤销之后还要再跑一遍，留着旧 id 的话
         之后再排帧永远被当成「已经排上了」，缩放就再也动不了 */
      rafZ.current = 0;
    };
  }, []);

  /* 窗口变宽变窄，「刚好铺满」的那一档封顶跟着变，得重算一次；
     右边那条导航占掉的 34px 也在这个宽度里，窗口一动它就得重新让位 */
  useEffect(() => {
    const el = scaleRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => drawZRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* 量一下现在看得见哪一段。滚动与缩放都会改它，落到窗口上只认粗档：
     每帧都更新的话，条目跟着一帧重挂一次，比不裁还慢 */
  useEffect(() => {
    const measure = () => {
      const box = boxOf();
      const el = innerRef.current;
      if (!box || !el) return;
      /* 右边那条竖导航跟着滚动框的高度走，窗口矮了它也跟着矮 */
      rootRef.current?.style.setProperty("--navh", Math.max(140, box.clientHeight - 40) + "px");
      const z = zCam.current || 1;
      const b = box.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const y0 = (b.top - r.top) / z;
      const y1 = y0 + box.clientHeight / z;
      /* 滑块跟着走：看得见的那一段压在导航条的哪一截 */
      navRef.current?.setWindow(
        navFrac(bandsRef.current, box.scrollTop / z),
        navFrac(bandsRef.current, (box.scrollTop + box.clientHeight) / z),
        navFrac(bandsRef.current, (box.scrollTop + box.clientHeight / 2) / z)
      );
      const zq = Math.round(z * 10) / 10;
      setWin((p) => {
        const slack = Math.max(160, (p.y1 - p.y0) * 0.5);
        const moved = Math.abs(y0 - p.y0) > slack || Math.abs(y1 - p.y1) > slack;
        if (!moved && Math.abs(zq - p.z) < 0.06) return p;
        return { y0, y1, z: zq };
      });
    };
    measure();
    const id = setInterval(measure, 150);
    const box = boxOf();
    box?.addEventListener("scroll", measure, { passive: true });
    return () => {
      clearInterval(id);
      box?.removeEventListener("scroll", measure);
    };
  }, []);

  useEffect(() => {
    const wrap = rootRef.current;
    if (!wrap) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      const box = boxOf();
      if (!box) return;
      const z = zCam.current;
      const nz = Math.min(Z_MAX, Math.max(Z_MIN, Math.round(z * Math.exp(-ev.deltaY * 0.0018) * 40) / 40));
      if (nz === zTgt.current) return;
      /* 记下这一刻光标压着哪个世界坐标，动画每一帧都把它按回原处 */
      const p = ev.clientY - box.getBoundingClientRect().top;
      anchor.current = { wy: (box.scrollTop + p) / z, py: p };
      zTgt.current = nz;
      scheduleZ();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  /** 拖导航条：把那一带挪到视口正中。手直接拖的，不用平滑滚动 */
  const seekFrac = (p: number) => {
    const box = boxOf();
    if (!box) return;
    box.scrollTop = Math.max(0, navX(bands, p) * zCam.current - box.clientHeight / 2);
  };

  /* 只挂看得见的那几条 */
  const shown = useMemo(() => {
    if (!win.y1) return [];
    const y0 = win.y0 - WIN_PAD;
    const y1 = win.y1 + WIN_PAD;
    return items.filter((r) => r.y + COV_H + 60 > y0 && r.y < y1);
  }, [items, win.y0, win.y1]);

  /* 刻度也只算这一段。放大到能看见日刻度的时候，整条轴上有几千天 */
  const tks = useMemo(() => {
    if (!win.y1) return [];
    return ticks(sc, sc.dayAt(win.y0 - WIN_PAD * 0.4), sc.dayAt(win.y1 + WIN_PAD * 0.4), win.z);
  }, [sc, win]);

  /* 小卡钉在封面外侧：右半边朝右放、左半边朝左放。
     不放到整条的最边上 —— 那样离轴快四百像素，眼睛得横着跳过去 */
  const enter = (r: Row, e: ReadEntry) => (ev: React.MouseEvent) => {
    const row = ev.currentTarget as HTMLElement;
    const cov = (row.querySelector(".rv-cov") as HTMLElement | null)?.getBoundingClientRect();
    const box = (cov || row.getBoundingClientRect());
    setHover({
      e,
      anchor: {
        x: r.col ? box.right : box.left,
        y: box.top + box.height / 2,
        side: r.col ? "right" : "left"
      }
    });
  };

  return (
    <div className="rvwrap" ref={rootRef}>
      <div className="rv-navslot">
        <ReadNav ref={navRef} bands={bands} onSeek={seekFrac} vertical />
      </div>

      <div className="rv-scale" ref={scaleRef} style={{ width: "calc(100% - 34px)", height }}>
        <div className="rv" ref={innerRef} style={{ height, width: W, transform: "translateX(-50%) scale(1)" }}>
          <div className="rv-axis" style={{ left: AX }}>
            {/* 轴上不标日号，星期天那根加粗；起止那两天标在金线两头 */}
            {tks.map((t) => (
              <div
                key={t.kind + "-" + t.x.toFixed(1)}
                className={"rv-tk " + t.kind + (t.sun ? " sun" : "")}
                style={{ top: t.x, ["--ww" as never]: t.w }}
              >
                {t.label ? <span>{t.label}</span> : null}
              </div>
            ))}
          </div>

          {shown.map((r) => (
            <div
              className={"rv-item col" + r.col}
              key={r.e.id}
              data-id={r.e.id}
              data-title={r.e.title + " · " + (r.e.span ? r.e.start + " 至 " + r.e.end : r.e.anchor)}
              style={{ top: r.y }}
              onClick={() => onPick(r.e.id)}
              onMouseEnter={enter(r, r.e)}
              onMouseLeave={() => setHover(null)}
            >
              {/* 先一根细线从封面横到轴上，再沿着轴漫开，盖住读的那几天 */}
              <i className="rv-probe" />
              <i className="rv-run" style={{ top: r.barTop, height: r.barH }} />
              {/* 金线两头的日号：开始那天在上、读完那天在下。条太短时只留一个，
                  上下两个会挤成一坨 */}
              {r.span && r.barH >= 26 ? (
                <span className="rv-d0" style={{ top: r.barTop }}>
                  {r.d0}
                </span>
              ) : null}
              {r.span ? (
                <span className="rv-d1" style={{ top: r.barTop + r.barH }}>
                  {r.d1}
                </span>
              ) : null}
              <div className="rv-body">
                <div className="rv-cov">
                  {r.e.cover ? (
                    <img src={coverUrl(r.e.cover, r.e.coverV)} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <div className="rv-covempty" />
                  )}
                </div>
                <div className="rv-txt">
                  <div className="rv-t">
                    {gradeIcon(r.e.reviewGrade) ? <span className="rv-grade">{gradeIcon(r.e.reviewGrade)}</span> : null}
                    {r.e.title}
                  </div>
                  <div className="rv-a">
                    {r.e.authors.join("、")}
                    {r.e.seriesName ? " · " + r.e.seriesName + (r.e.seriesIndex != null ? " " + r.e.seriesIndex : "") : ""}
                  </div>
                  {/* 起止与天数在轴上已经标了，这行只留评分 */}
                  {ratingText(r.e.rating) ? (
                    <div className="rv-m">
                      <span className="rv-rate">
                        <b>★</b> {ratingText(r.e.rating)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ReadTip e={hover ? hover.e : null} anchor={hover ? hover.anchor : null} />
    </div>
  );
}
