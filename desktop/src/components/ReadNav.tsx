import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { navBand, type YearBand } from "../../shared/readScale";

/**
 * 时间线上那条总览。横排横着摆在顶上，竖排竖着贴在右边，两屏同一份逻辑。
 *
 * 按年等分：一年一格，格子里的柱子是那年读完几本，一本没读的年份空着。
 * 当年那排年份按钮撤了 —— 二十几个按钮挤在顶上，翻的年份一多就变成一条
 * 认不出的数字带。改成拖这条：拖到哪年，光标旁浮出「2016 年 · 31 本」。
 *
 * 可见的那一段由画轴那头每帧推过来（setWindow），不走 React state：
 * 拖动与缩放时一帧一个值，进了 state 就是每帧重渲染一次整条时间线。
 */
export interface ReadNavHandle {
  /** 可见窗口落在导航条上的哪一段（0–1），与它正中那一点落在哪 */
  setWindow(f0: number, f1: number, fc: number): void;
}

interface Props {
  bands: YearBand[];
  /** 拖到 p 处（0–1），把那一带挪到视口中间。两屏各按自己的坐标系换算 */
  onSeek: (p: number) => void;
  /** 竖着摆：一格一年从上往下，柱子朝右长 */
  vertical?: boolean;
}

const ReadNav = forwardRef<ReadNavHandle, Props>(function ReadNav({ bands, onSeek, vertical }, ref) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const hairRef = useRef<HTMLDivElement | null>(null);
  const win = useRef({ f0: 0, f1: 1, fc: 0.5 });
  const grab = useRef(0);
  const dragging = useRef(false);

  /** 光标旁那行字：哪一年、那年读完几本。pos 是按方向换算好的像素 */
  const [tip, setTip] = useState<{ pos: number; text: string } | null>(null);

  const maxN = useMemo(() => Math.max(1, ...bands.map((b) => b.n)), [bands]);

  const paint = () => {
    const t = thumbRef.current;
    if (!t) return;
    const { f0, f1 } = win.current;
    const span = Math.max(0.012, f1 - f0);
    if (vertical) {
      t.style.top = (f0 * 100).toFixed(3) + "%";
      t.style.height = (Math.min(1, span) * 100).toFixed(3) + "%";
    } else {
      t.style.left = (f0 * 100).toFixed(3) + "%";
      t.style.width = (Math.min(1, span) * 100).toFixed(3) + "%";
    }
  };

  useImperativeHandle(ref, () => ({
    setWindow(f0: number, f1: number, fc: number) {
      win.current = { f0, f1, fc };
      paint();
    }
  }));

  const frac = (x: number, y: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return 0;
    const len = vertical ? r.height : r.width;
    if (len < 1) return 0;
    const v = vertical ? y - r.top : x - r.left;
    return Math.min(1, Math.max(0, v / len));
  };

  /** 浮出来的那行与那根细线。位置按像素掐在条里头，免得半个气泡露到外面 */
  const float = (p: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    const b = navBand(bands, p);
    if (!r || !b) {
      setTip(null);
      return;
    }
    const len = vertical ? r.height : r.width;
    const half = vertical ? 16 : 46;
    const v = Math.min(Math.max(p * len, half), Math.max(half, len - half));
    setTip({ pos: Math.round(v), text: b.y + " 年 · " + b.n + " 本" });
    const hair = hairRef.current;
    if (hair) {
      if (vertical) hair.style.top = (p * 100).toFixed(2) + "%";
      else hair.style.left = (p * 100).toFixed(2) + "%";
    }
  };

  const seek = (p: number) => {
    const c = Math.min(1, Math.max(0, p));
    const hair = hairRef.current;
    if (hair) {
      if (vertical) hair.style.top = (c * 100).toFixed(2) + "%";
      else hair.style.left = (c * 100).toFixed(2) + "%";
    }
    onSeek(c);
  };

  const n = bands.length;
  const cell = n ? 100 / n : 100;

  return (
    <div
      className={"rd-nav" + (vertical ? " v" : "") + (tip ? " on" : "")}
      ref={trackRef}
      title="一年一格，柱子是那年读完几本，拖着跳到那几年"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const p = frac(e.clientX, e.clientY);
        /* 按在滑块上就保持手指与滑块的相对位置，滑块不会被一下吸到正中。
           拿来比的是「视口正中那一点在导航条上的位置」，不是滑块左右两沿的
           中点 —— 一年在轴上占多长并不相等，两沿中点与正中常常差着一截。
           按在别处就直接把那一带挪到中间 */
        grab.current = (e.target as HTMLElement).closest(".rd-nav-thumb") ? p - win.current.fc : 0;
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        seek(p - grab.current);
        float(p);
      }}
      onPointerMove={(e) => {
        const p = frac(e.clientX, e.clientY);
        if (dragging.current) seek(p - grab.current);
        float(p);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* 指针已经没了就算了 */
        }
        float(frac(e.clientX, e.clientY));
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onPointerLeave={() => {
        if (dragging.current) return;
        setTip(null);
      }}
    >
      <div className="rd-nav-marks">
        {bands.map((b, i) => (
          <i
            key={b.y}
            className="rd-nav-bar"
            style={
              vertical
                ? {
                    top: ((i + 0.5) / n) * 100 + "%",
                    height: cell * 0.32 + "%",
                    /* 长度按平方根压一压：几十本的那年 15px，只读了一两本的那年
                       还有 2px，照本数直接乘比例的话早年那几格等于没有 */
                    width: b.n ? Math.max(2, Math.round(18 * Math.sqrt(b.n / maxN))) + "px" : "0px"
                  }
                : {
                    left: ((i + 0.5) / n) * 100 + "%",
                    width: cell * 0.32 + "%",
                    height: b.n ? Math.max(2, Math.round(18 * Math.sqrt(b.n / maxN))) + "px" : "0px"
                  }
            }
          />
        ))}
        {/* 年界线画在两根之间 */}
        {bands.slice(1).map((b, i) => (
          <i
            key={"l" + b.y}
            className="rd-nav-line"
            style={vertical ? { top: ((i + 1) / n) * 100 + "%" } : { left: ((i + 1) / n) * 100 + "%" }}
          />
        ))}
      </div>
      <div className="rd-nav-hair" ref={hairRef} />
      <div className="rd-nav-thumb" ref={thumbRef} />
      {tip ? (
        <span className="rd-nav-bub" style={vertical ? { top: tip.pos } : { left: tip.pos }}>
          {tip.text}
        </span>
      ) : null}
    </div>
  );
});

export default ReadNav;
