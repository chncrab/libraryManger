import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coverUrl } from "../api";
import { dayLabel, dayNum, navMarks, ticks, type NavRange, type Scale, type YearBand } from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";
import ReadTip, { type TipAnchor } from "./ReadTip";
import ReadNav, { type ReadNavHandle } from "./ReadNav";

/**
 * 横排时间线：一条横轴，书按读的那段时间站到轴上，早的在左。
 *
 * 时间段平时根本不画，鼠标停在哪本上才动起来：先从封面拉一根细线下来落到
 * 轴上，再从开始那天沿着轴漫到读完那天，轴上一段金线正好压在它读的那几天。
 * 当天读完的没有区间，就以那天为中心盖住左右各半个日格。同时光标旁浮出一张
 * 小卡，写着起止、用时与评分。一屏几百本，默认不画才不会满眼金线。
 *
 * 位置一律先按 1 倍算成「世界坐标」，显示时整体乘 k（挂在容器的 --k 上），
 * 尺寸与字号由 --v 派生，所以放大时字跟着放大，而 --v 到 2.2 倍封顶、
 * 还会被窗口高度压住（窗口矮时封面先不放大，只让轴拉开），
 * 免得放大后封面被上下裁掉。
 *
 * 拖动、缩放改的是「目标」位置，真正画的那个值每帧朝目标挪一截，
 * 于是滚轮缩放、双击复位、点年份跳转都是滑过去的，不是一下子跳到位；
 * 拖动与导航条这种手直接拖的则两头同时改，跟手不拖泥带水。
 */
interface Props {
  /** 服务层给的顺序是从近到远 */
  list: ReadEntry[];
  /** 与竖排同一份换算，两边落点才一致 */
  sc: Scale;
  /** 年份分段，与竖排共用一份 */
  bands: YearBand[];
  /** 导航条铺开的那一段，选了显示区间就只铺那几年 */
  navRange: NavRange;
  onPick: (id: string) => void;
}

const CARD_W = 66;
const PAD = 40;
const GAPX = 10;
/* 月按同一个宽度排之后，一年要七八千像素，往回缩得能拉到 0.2 才看得见半年 */
const K_MIN = 0.2;
const K_MAX = 5;
/** 封面与字号最多放大到这么多倍，再往上只让轴继续拉开 */
const V_MAX = 2.2;
/** 一个 --v 单位要占的高度：与轴 40、封面 99、书名两行 26 + 3 */
const V_ROOM = 168;
/** 追目标的时间常数，越小越跟手，越大越绵。90ms 看着刚好 */
const EASE_MS = 90;

interface Node {
  e: ReadEntry;
  /** 封面左边的世界坐标 */
  x: number;
  lane: 0 | 1;
  /** 轴上那段金线，相对封面左边的世界坐标与宽度 */
  barX: number;
  barW: number;
  /** 金线两头的日号，只写几号 */
  d0: string;
  d1: string;
  /** 读了好几天才两头都标，一天读完的只标一个 */
  span: boolean;
}

/** 世界坐标下排一遍：先按起止那段的中心落位，再挑一条不打架的轨 */
function layout(list: ReadEntry[], sc: Scale) {
  const asc = list.slice().reverse();
  const nodes: Node[] = [];
  const edge: [number, number] = [PAD, PAD];
  let alt = 0;
  const need = CARD_W + GAPX;

  for (const e of asc) {
    const a = dayNum(e.start);
    const b = dayNum(e.end || e.anchor);
    const day0 = Number.isFinite(a) ? a : b;
    const day1 = Number.isFinite(b) ? Math.max(b, day0) : day0;
    /* 一天是相邻两点之间的一段：从开始那天清晨，盖到读完那天的深夜 */
    const s = sc.xOf(day0);
    const t = sc.xOf(day1 + 1);
    const mid = (s + t) / 2;
    let x = mid - CARD_W / 2;
    let lane: 0 | 1 = alt as 0 | 1;
    if (x < edge[lane]) {
      const other = (1 - lane) as 0 | 1;
      if (x >= edge[other]) lane = other;
      else {
        x = Math.min(edge[0], edge[1]);
        lane = edge[0] <= edge[1] ? 0 : 1;
      }
    }
    /* 当天读完的就是一整格，跨天的按实打实的天数来，窄到看不见时由样式那头补个下限 */
    const span = day1 > day0;
    nodes.push({
      e,
      x,
      lane,
      barX: s - x,
      barW: t - s,
      d0: dayLabel(day0),
      d1: dayLabel(day1),
      span
    });
    edge[lane] = x + need;
    alt = 1 - lane;
  }
  /* 末尾推到今天：最后一本书之后那段日子轴也照画，不提前断掉。
     content 是最后一本书那一头的世界坐标，开场落在它上面，空尾巴留着往后拖 */
  const content = Math.max(edge[0], edge[1]) + PAD;
  return { nodes, width: Math.max(content, sc.width + PAD), content };
}

export default function ReadAxis({ list, sc, bands, navRange, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<ReadNavHandle | null>(null);

  const { nodes, width, content } = useMemo(() => layout(list, sc), [list, sc]);
  /* 导航条：条铺 navRange 那一段，每本书一根金线 */
  const marks = useMemo(() => navMarks(list, sc, navRange), [list, sc, navRange]);
  /** 月份宽度：条上滚轮一次翻一年，得靠它算 */
  const monthWRef = useRef(sc.monthW);
  monthWRef.current = sc.monthW;

  /** 现在画着的（k, off）与要去的（k, off），每帧后者朝前者靠 */
  const camRef = useRef({ k: 1, off: 0 });
  const tgtRef = useRef({ k: 1, off: 0 });
  /** 缩放期间钉住的那一点：世界坐标与世界到容器左沿的像素距离。
     光让 k 与 off 各插各的，中途会先飘一下再回位，按这个点反算就一路不抖 */
  const zoomRef = useRef<{ wx: number; cx: number } | null>(null);
  const lastT = useRef(0);
  const rafRef = useRef(0);
  const glideRef = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;
  const contentRef = useRef(content);
  contentRef.current = content;

  /* 刻度只算看得见的那一段，一千多个日刻度不必都挂进 DOM。
     这段区间跟着平移走，攒够一定距离才更新一次，免得每帧都重排 React */
  const [view, setView] = useState({ x0: 0, x1: 0, k: 0 });
  const viewRef = useRef(view);

  /* 鼠标停在那本上，封面外侧浮出一张小卡。位置只在换一本时算一次 */
  const [hover, setHover] = useState<{ e: ReadEntry; anchor: TipAnchor } | null>(null);

  const maxOff = useCallback((k = tgtRef.current.k) => {
    const w = hostRef.current?.clientWidth || 0;
    return Math.max(0, widthRef.current * k - w);
  }, []);

  const clampOff = useCallback(
    (v: number, k = tgtRef.current.k) => {
      const m = maxOff(k);
      return Math.min(m, Math.max(0, v));
    },
    [maxOff]
  );

  /** 一帧只做一次：目标靠一截、挂上 --k 与 --v、推 rail、算导航条滑块、必要时刷新刻度区间 */
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
      /* 倍率按对数插值：从 1 到 5 每一步的放大感才均匀 */
      const k = Math.exp(Math.log(c.k) + (Math.log(t.k) - Math.log(c.k)) * a);
      c.k = Math.abs(t.k - k) < 0.002 ? t.k : k;
      /* 平移量不另插值，直接按锚点跟着倍率反算，光标下那本一动也不动 */
      const z = zoomRef.current;
      c.off = z ? clampOff(z.wx * c.k - z.cx, c.k) : c.off + (t.off - c.off) * a;
    } else if (c.off !== t.off) {
      const a = 1 - Math.exp(-dt / EASE_MS);
      c.off = Math.abs(t.off - c.off) < 0.4 ? t.off : c.off + (t.off - c.off) * a;
    }

    /* 窗口矮的时候封面先别放大，只让轴继续拉开，
       否则 2.2 倍的封面会把轴区顶穿、上下被裁掉一截。
       这里量的是外面那整块（轴自己高度也跟着 --v 变，量它会绕回来） */
    const wrapH = host.parentElement?.clientHeight || host.clientHeight;
    const room = Math.max(0.6, wrapH / (2 * V_ROOM + 24));
    const v = Math.min(V_MAX, c.k, room);
    /* 小数点后留六位：轴长二十多万像素，只留四位的话末位一到，右边的封面
       就会被推十几像素，缩放时光标锚定对不上 */
    host.style.setProperty("--k", c.k.toFixed(6));
    /* 字号跟封面按小台阶走，平移时不至于每帧都重排文字 */
    host.style.setProperty("--v", String(Math.round(v * 40) / 40));
    rail.style.transform = `translate3d(${-c.off}px,0,0)`;
    host.classList.toggle("k-sm", v < 0.62);

    /* 滑块就是现在看得见的这一段：左沿与宽窄都是整条轴的分位，条铺满全轴，
       于是缩得越远框越宽，与倍数严格一一对应 */
    const vw = host.clientWidth;
    const vx0 = c.off / c.k;
    const vx1 = (c.off + vw) / c.k;
    navRef.current?.setView(vx0, vx1);

    const w = host.clientWidth;
    const x0 = (c.off - 300) / c.k;
    const x1 = (c.off + w + 300) / c.k;
    const prev = viewRef.current;
    const slack = Math.max(160, (x1 - x0) * 0.2);
    const kq = Math.round(c.k * 20) / 20;
    if (Math.abs(x0 - prev.x0) > slack || Math.abs(x1 - prev.x1) > slack || Math.abs(kq - prev.k) > 0.026) {
      const next = { x0, x1, k: kq };
      viewRef.current = next;
      setView(next);
    }

    if (c.k !== t.k || c.off !== t.off) schedule();
  };
  drawRef.current = draw;

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  /** 排一帧，不管手里有没有旧 id。
     开发模式下 StrictMode 会把 effect 跑一遍、撤销、再跑一遍，撤销那步把已经
     排好的这一帧取消了，id 却还留着 —— 之后 schedule 全当「已经排上了」直接跳
     过，整屏再也没有画过一帧：拖动没反应、缩放不动、导航条滑块也不走。
     所以开场这一下用 kick，旧的 id 一律先扔掉 */
  const kick = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  /** 手直接拖的那几处：目标与画着一块改，屏幕立刻跟手 */
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

  const tk = useMemo(() => {
    if (!view.x1) return [];
    return ticks(sc, sc.dayAt(view.x0), sc.dayAt(view.x1), view.k || 1);
  }, [sc, view]);

  /* 只把看得见的那些挂进 DOM。全挂上去（几百本封面）每放大一档都要给上千个
     元素重新算一遍 calc 里的 --k、重新光栅化这些图，实测一帧要一百多毫秒。
     两边各留 260px，滚过去的时候不会露白 */
  const shown = useMemo(() => {
    if (!view.x1) return [];
    const x0 = view.x0 - 260;
    const x1 = view.x1 + 260;
    return nodes.filter((n) => n.x + CARD_W + PAD > x0 && n.x < x1);
  }, [nodes, view.x0, view.x1]);

  const stopGlide = () => {
    if (glideRef.current) {
      cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
    }
  };

  /** 松手后按最后几帧的速度滑一段，每帧衰减 8% */
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

  /* 开场落在最右，最近读的先看见，更早的用导航条过去。
     轴一直铺到今天，最后一本书之后还有几个月的空档，所以落点是书那一头，
     不是轴的尽头 —— 否则一进来就是一屏空白 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let lastW = host.clientWidth;
    const off = Math.max(0, Math.min(widthRef.current, contentRef.current) - lastW);
    camRef.current = { k: 1, off };
    tgtRef.current = { k: 1, off };
    kick();
    const ro = new ResizeObserver(() => {
      if (host.clientWidth === lastW) return;
      lastW = host.clientWidth;
      camRef.current.off = clampOff(camRef.current.off);
      tgtRef.current.off = clampOff(tgtRef.current.off);
      schedule();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [width, clampOff, schedule, kick]);

  /* 换了显示区间，视野要是落在区间外头就挪进去 —— 否则条上的滑块贴在边上，
     看着像没反应。已经在区间里就不动，别打断手头的拖动 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !host.clientWidth) return;
    const c = camRef.current;
    const vx0 = c.off / c.k;
    const vx1 = (c.off + host.clientWidth) / c.k;
    if (vx1 > navRange.a && vx0 < navRange.b) return;
    jumpTo(((navRange.a + navRange.b) / 2) * c.k - host.clientWidth / 2);
  }, [navRange.a, navRange.b, jumpTo]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (glideRef.current) cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
    },
    []
  );

  /* 滚轮：左右滑是平移，上下滑是缩放，光标下面那本缩完还停在原处。
     挂在整屏上而不是只挂在轴上，鼠标停在轴上方那片空白里滚也能用 */
  useEffect(() => {
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      stopGlide();
      const t = tgtRef.current;
      /* 滚在导航条上就是翻年份：一路平着走，不缩放。一次滚轮约走一年 ——
         铺的是全轴，条上一像素跨着几天，按条长算就滚不动了 */
      if ((ev.target as HTMLElement | null)?.closest?.(".rd-nav")) {
        const d = (12 * monthWRef.current) / 120;
        zoomRef.current = null;
        jumpTo(t.off + (ev.deltaY + ev.deltaX) * d);
        return;
      }
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        zoomRef.current = null;
        jumpTo(t.off + ev.deltaX);
        return;
      }
      const c = ev.clientX - host.getBoundingClientRect().left;
      /* 倍率按目标一档档累，连续滚才加得动；锚点从「现在画着的样子」算，
         上一段动画还没走完也不会算歪 */
      const k1 = t.k;
      const k2 = Math.min(K_MAX, Math.max(K_MIN, k1 * Math.exp(-ev.deltaY * 0.0015)));
      if (Math.abs(k2 - k1) < 1e-4) return;
      const wx = (c + camRef.current.off) / camRef.current.k;
      zoomRef.current = { wx, cx: c };
      t.k = k2;
      t.off = clampOff(wx * k2 - c, k2);
      schedule();
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [clampOff, jumpTo, schedule]);

  /* 指针被 setPointerCapture 抓住之后，move 与 up 的 target 都变成捕获元素，
     所以按下那一刻就得记住落在哪本书上，不能等松手再找 */
  const dragRef = useRef<{
    x0: number;
    off0: number;
    moved: number;
    nodeId: string;
    pts: { t: number; o: number }[];
  } | null>(null);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el0 = e.target as HTMLElement;
    /* 导航条自己管指针，别让拖动抢了它 */
    if (el0.closest(".rd-nav")) return;
    stopGlide();
    setHover(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const el = el0.closest(".rd-node") as HTMLElement | null;
    dragRef.current = {
      x0: e.clientX,
      off0: camRef.current.off,
      moved: 0,
      nodeId: el?.dataset.id || "",
      pts: [{ t: performance.now(), o: camRef.current.off }]
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    d.moved = Math.max(d.moved, Math.abs(dx));
    jumpTo(d.off0 - dx);
    d.pts.push({ t: performance.now(), o: camRef.current.off });
    if (d.pts.length > 6) d.pts.shift();
  };

  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已经没了就算了 */
    }
    /* 位移不到 4 像素算点，与封面大图一个判据 */
    if (d.moved < 4) {
      if (d.nodeId) onPick(d.nodeId);
      return;
    }
    const a = d.pts[0];
    const b = d.pts[d.pts.length - 1];
    const dt = b.t - a.t;
    if (dt > 8) startGlide((b.o - a.o) / dt);
  };

  /** 双击空白回到 1 倍，光标下那本不动。这一下走动画，滑回去 */
  const onDbl = (e: React.MouseEvent) => {
    const el0 = e.target as HTMLElement;
    if (el0.closest(".rd-node, .rd-nav")) return;
    const host = hostRef.current;
    const c = camRef.current;
    if (!host || Math.abs(c.k - 1) < 0.001) return;
    const px = e.clientX - host.getBoundingClientRect().left;
    const wx = (px + c.off) / c.k;
    zoomRef.current = { wx, cx: px };
    tgtRef.current.k = 1;
    tgtRef.current.off = clampOff(wx - px, 1);
    schedule();
  };

  /** 拖导航条：把那个世界坐标摆到视野正中。手直接拖的，不用等动画 */
  const seekFrac = (x: number) => {
    const host = hostRef.current;
    if (!host) return;
    stopGlide();
    jumpTo(x * tgtRef.current.k - host.clientWidth / 2);
  };

  /* 上轨的卡往上放、下轨往下放，都在封面外侧，不压住正在看的那本。
     书名挂得更外一层，所以让过一个书名的高度，缩放到几倍就留多高 */
  const enter = (n: Node) => (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const host = hostRef.current;
    const v = Number(host?.style.getPropertyValue("--v")) || 1;
    const away = 27 * v;
    setHover({
      e: n.e,
      anchor: {
        x: r.left + r.width / 2,
        y: n.lane ? r.bottom + away : r.top - away,
        side: n.lane ? "bottom" : "top"
      }
    });
  };

  return (
    <div
      className="rd-axwrap"
      ref={wrapRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onDbl}
    >
      <ReadNav ref={navRef} bands={bands} marks={marks} range={navRange} onSeek={seekFrac} />

      <div className="rd-axis" ref={hostRef}>
        <div className="rd-rail" ref={railRef}>
          <div className="rd-line" style={{ ["--wx" as never]: width }} />
          {tk.map((t) => (
            <div
              key={t.kind + "-" + t.x.toFixed(1)}
              className={"rd-tk " + t.kind}
              style={{ ["--wx" as never]: t.x, ["--ww" as never]: t.w }}
            >
              {t.label ? (
                <span>
                  {t.label}
                  {/* 年份后面跟一支箭头，指着这一年往下走的那一边 */}
                  {t.kind === "year" ? <i className="rd-yarw" /> : null}
                </span>
              ) : null}
            </div>
          ))}
          {shown.map((n) => (
            <div
              className={"rd-node lane" + n.lane}
              key={n.e.id}
              data-id={n.e.id}
              data-title={n.e.title + " · " + (n.e.span ? n.e.start + " 至 " + n.e.end : n.e.anchor)}
              style={{ ["--wx" as never]: n.x, ["--bl" as never]: n.barX, ["--bw" as never]: n.barW }}
              onMouseEnter={enter(n)}
              onMouseLeave={() => setHover(null)}
            >
              {/* 先一根细线从封面落到轴上，再在轴上漫开，盖住读的那几天 */}
              <i className="rd-probe" />
              <i className="rd-run" />
              <div className="rd-card">
                {n.e.cover ? (
                  <img className="rd-img" src={coverUrl(n.e.cover, n.e.coverV)} alt="" draggable={false} />
                ) : (
                  <div className="rd-img empty" />
                )}
                {/* 书名挂在封面外侧，远离轴的那一边，两轨各挂各的 */}
                <span className="rd-t">{n.e.title}</span>
                {/* 金线两头的日期：开始那天在左头，读完那天在右头，都写成 月-日 */}
                <span className="rd-d0">{n.d0}</span>
                <span className="rd-d1">{n.d1}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <ReadTip e={hover ? hover.e : null} anchor={hover ? hover.anchor : null} />
    </div>
  );
}
