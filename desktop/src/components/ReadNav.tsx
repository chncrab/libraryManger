import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { navAt, navBandAt, navThumb, nearestMark, type NavMark, type NavRange, type YearBand } from "../../shared/readScale";

/**
 * 时间线上那条总览。横排横着摆在顶上，竖排竖着贴在右边，两屏同一份逻辑。
 *
 * 做的是剪辑软件那条进度条的脾气：条铺开的是固定的一段世界坐标（默认整条轴），
 * 长度和刻度都不随视野变。滑块左沿就等于视野起点在那段上的分位，滑块宽就是视
 * 野占那段的分位 —— 位置与内容一一对应，拖多少内容就走多少，按在滑块上抓住的
 * 是滑块里那一处，按在别处滑块中心就过来。没有窗口、没有每帧重算。
 *
 * 条上每本书一根金色细线，落在它在轴上的位置：读得密的年份连成一条亮带，
 * 空着的那几年就是干净的空白。拖着它走，光标旁浮出最近那本书的书名与日期，
 * 松手落到那本书上，正好落在视野正中。
 *
 * 条下面（竖排是左边）按年区间写着年份，左右居中，点一下就把那一年摆到正中。
 * 年份挤得写不下时按间隔挑着写，免得叠成一团。
 *
 * 可见的那一段由画轴那头每帧推过来（setView），不走 React state：
 * 拖动与缩放时一帧一个值，进了 state 就是每帧重渲染整条时间线。
 */
export interface ReadNavHandle {
  /** 视野那一段的世界坐标。滑块位置按条铺开的那段直接算，与视野一一对应 */
  setView(v0: number, v1: number): void;
}

interface Props {
  bands: YearBand[];
  /** 每本书落在条上的位置 */
  marks: NavMark[];
  /** 条铺开的那一段世界坐标。选了显示区间，就只铺那几年 */
  range: NavRange;
  /** 把视野中心摆到哪个世界坐标 */
  onSeek: (x: number) => void;
  /** 竖着摆：一格一年从上往下，书线横着画 */
  vertical?: boolean;
}

/** 金色细线那一层。单拎出来 memo：拖动时每帧都在改气泡，别把上千根线一起重排 */
const Marks = memo(function Marks({ marks, vertical }: { marks: NavMark[]; vertical: boolean }) {
  return (
    <>
      {marks.map((m) => {
        const p = (m.p * 100).toFixed(4) + "%";
        return (
          <i
            key={m.id}
            className="rd-nav-book"
            data-id={m.id}
            data-p={m.p.toFixed(5)}
            style={vertical ? { top: p } : { left: p }}
          />
        );
      })}
    </>
  );
});

const ReadNav = forwardRef<ReadNavHandle, Props>(function ReadNav(
  { bands, marks, range, onSeek, vertical },
  ref
) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  /** 滑块现在的位置与宽窄（条上那段的 0–1）。缩放时由 setView 给，拖动时由手给 */
  const thumb = useRef({ l: 0, w: 0.05 });
  /** 按下的那一刻，手指落在滑块里哪一处。这一趟不动它，滑块于是永远跟着手 */
  const grab = useRef<{ g: number } | null>(null);
  /** 上一次推过来的视野段。换了铺开的范围时拿它重算滑块 */
  const lastView = useRef({ v0: 0, v1: 1 });
  /** 条有多长（屏幕像素）。年份字按它算摆哪儿、几个写一个 */
  const [len, setLen] = useState(0);

  /** 光标旁那行字：一本书的名字，或者空档处那句「哪一年、几本」 */
  const [tip, setTip] = useState<{ pos: number; text: string; kind: "book" | "year" } | null>(null);

  const span = Math.max(1, range.b - range.a);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const read = () => setLen(vertical ? el.clientHeight : el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vertical]);

  const paint = () => {
    const t = thumbRef.current;
    if (!t) return;
    const { l, w } = thumb.current;
    if (vertical) {
      t.style.top = (l * 100).toFixed(4) + "%";
      t.style.height = (w * 100).toFixed(4) + "%";
    } else {
      t.style.left = (l * 100).toFixed(4) + "%";
      t.style.width = (w * 100).toFixed(4) + "%";
    }
  };

  useImperativeHandle(ref, () => ({
    setView(v0: number, v1: number) {
      lastView.current = { v0, v1 };
      /* 手正按着的那一趟不接外面的值：滑块归手管，接了会把框从手指下拉走 */
      if (grab.current) return;
      thumb.current = navThumb(range, v0, Math.max(1, v1 - v0));
      paint();
    }
  }));

  /* 换了铺开的范围（选了别的显示区间），滑块按新尺子重算一遍。视野没动的话
     画轴那头不会推新值过来，不重算的话条的刻度换了、框还是旧的 */
  useEffect(() => {
    if (grab.current) return;
    const { v0, v1 } = lastView.current;
    thumb.current = navThumb(range, v0, Math.max(1, v1 - v0));
    paint();
  }, [range.a, range.b]);

  /** 指针落在条上的分位。raw 为真时不夹在 0–1，气泡之类要按原值算 */
  const frac = (x: number, y: number, raw = false) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return 0;
    const l = vertical ? r.height : r.width;
    if (l < 1) return 0;
    const v = (vertical ? y - r.top : x - r.left) / l;
    return raw ? v : Math.min(1, Math.max(0, v));
  };

  /** 条上一像素跨多少世界像素。吸附容差按屏幕 5px 折过来 */
  const tolWorld = () => {
    const r = trackRef.current?.getBoundingClientRect();
    const l = r ? (vertical ? r.height : r.width) : 1;
    return (5 / Math.max(1, l)) * span;
  };

  /**
   * 滑块左沿摆到 l。视野中心随之落到 l + w/2 那一处。
   *
   * 这一步就是全部的拖动逻辑 —— 手在哪，滑块就在哪，内容跟到哪，一比一，
   * 没有任何中间状态需要回读。
   */
  const seekTo = (l: number) => {
    const w = thumb.current.w;
    const c = Math.min(1 - w, Math.max(0, l));
    thumb.current = { l: c, w };
    paint();
    onSeek(range.a + (c + w / 2) * span);
  };

  /** 浮出来的那行字。位置按像素掐在条里头，免得半个气泡露到外面 */
  const float = (p: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) {
      setTip(null);
      return;
    }
    const at = range.a + p * span;
    const m = nearestMark(marks, at, tolWorld());
    const b = m ? null : navBandAt(bands, at);
    const text = m ? m.text : b ? b.y + " 年 · " + b.n + " 本" : "";
    if (!text) {
      setTip(null);
      return;
    }
    const l = vertical ? r.height : r.width;
    const half = vertical ? 20 : Math.min(120, l / 2);
    const v = Math.min(Math.max(p * l, half), Math.max(half, l - half));
    setTip({ pos: Math.round(v), text, kind: m ? "book" : "year" });
  };

  /* 条上写得出年份字的那些年：区间内的年段，按条长挑选。一个标签横排要三十来
     像素、竖排要三十来像素高，挤不下就隔几个写一个，宁可少写也不叠成一团 */
  const years = useMemo(() => {
    if (!len) return [];
    const list: { y: number; p: number; x: number }[] = [];
    for (const b of bands) {
      const a = Math.max(b.x0, range.a);
      const c = Math.min(b.x1, range.b);
      if (c - a < 1) continue;
      list.push({ y: b.y, x: (a + c) / 2, p: (a + c) / 2 - range.a });
    }
    if (!list.length) return [];
    const slot = len / list.length;
    /* 横排一个标签要三十来像素宽，竖排一列要二十四像素高 */
    const step = Math.max(1, Math.ceil((vertical ? 24 : 30) / Math.max(1, slot)));
    return list
      .filter((_, i) => i % step === 0)
      .map((o) => {
        const raw = (o.p / span) * len;
        /* 两头的字掐在条里，别让半个字露到条外。横排按半个字宽、竖排按半行字高 */
        const half = vertical ? 8 : 18;
        return {
          y: o.y,
          x: o.x,
          px: Math.min(Math.max(raw, half), Math.max(half, len - half))
        };
      });
  }, [bands, range.a, range.b, span, len, vertical]);

  return (
    <div
      className={"rd-nav" + (vertical ? " v" : "") + (tip ? " on" : "")}
      ref={trackRef}
      title="每根金线是一本书，拖着滑块跳到那一带；滚轮翻年份"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        /* 年份字是按钮，按它不算拖条 */
        if ((e.target as HTMLElement).closest(".rd-nav-year")) return;
        const p = frac(e.clientX, e.clientY);
        const { l, w } = thumb.current;
        /* 按在滑块上，手指落在滑块里哪一处就一直是那一处，滑块不被吸到正中；
           按在别处，滑块中心就过来。跟拖进度条一个脾气 */
        const onThumb = !!(e.target as HTMLElement).closest(".rd-nav-thumb");
        grab.current = { g: onThumb ? Math.min(w, Math.max(0, p - l)) : w / 2 };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        seekTo(p - grab.current.g);
        float(p);
      }}
      onPointerMove={(e) => {
        const g = grab.current;
        if (!g) {
          float(frac(e.clientX, e.clientY));
          return;
        }
        const raw = frac(e.clientX, e.clientY, true);
        seekTo(raw - g.g);
        float(Math.min(1, Math.max(0, raw)));
      }}
      onPointerUp={(e) => {
        const g = grab.current;
        grab.current = null;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* 指针已经没了就算了 */
        }
        if (!g) return;
        const raw = frac(e.clientX, e.clientY, true);
        const p = Math.min(1, Math.max(0, raw));
        /* 松手朝最近那本书靠一下：拖到金线附近就把那本摆到正中，不用再微调 */
        const w = thumb.current.w;
        const c = Math.min(1 - w, Math.max(0, raw - g.g));
        const m = nearestMark(marks, range.a + (c + w / 2) * span, tolWorld());
        if (m) seekTo(navAt(range, m.x) - w / 2);
        else float(p);
      }}
      onPointerCancel={() => {
        grab.current = null;
      }}
      onPointerLeave={() => {
        if (grab.current) return;
        setTip(null);
      }}
    >
      <div className="rd-nav-marks">
        <Marks marks={marks} vertical={!!vertical} />
        {/* 年界线画在两根之间，认年份用。位置取那年一月一号 ——
            取上一年的 x1 的话，最后一年那头被轴尾夹过，线会飘到轴尽头去。
            区间以外的不画，条上本来就没有那一段 */}
        {bands
          .filter((b) => b.x0 > range.a && b.x0 < range.b)
          .map((b) => {
            const p = (navAt(range, b.x0) * 100).toFixed(4) + "%";
            return <i key={"l" + b.y} className="rd-nav-line" style={vertical ? { top: p } : { left: p }} />;
          })}
      </div>
      <div className="rd-nav-thumb" ref={thumbRef} />
      {/* 年份字：横排挂在条下面一行，竖排竖着写在条左边。点一下把那年摆到正中 */}
      {years.length ? (
        <div className="rd-nav-years">
          {years.map((o) => (
            <button
              key={o.y}
              className="rd-nav-year"
              data-y={o.y}
              style={vertical ? { top: o.px } : { left: o.px }}
              title={"跳到 " + o.y + " 年"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSeek(o.x)}
            >
              {o.y}
            </button>
          ))}
        </div>
      ) : null}
      {tip ? (
        <span
          className="rd-nav-bub"
          data-kind={tip.kind}
          style={vertical ? { top: tip.pos } : { left: tip.pos }}
        >
          {tip.text}
        </span>
      ) : null}
    </div>
  );
});

export default ReadNav;
