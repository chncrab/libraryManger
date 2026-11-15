import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  src: string;
  /** 顶上那行小字，写书名 */
  title: string;
  onClose: () => void;
}

/** 缩放档位相对「适应窗口」那一档算，1 就是铺满可用区域 */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 12;
/** 拖到极限时至少留这么多像素在窗口里，免得图被拖丢 */
const KEEP = 48;
/** 一次按下到抬起走了这么多像素就算拖动，不再当成点击 */
const DRAG_SLOP = 4;
/** 书库里的封面多半只有两三百像素宽，铺满窗口是放大小图，最多放这么大 */
const MAX_FIT = 3;

interface View {
  /** 适应窗口时相对图片原始像素的比例 */
  fit: number;
  /** 用户缩放倍数，叠在 fit 上 */
  zoom: number;
  x: number;
  y: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * 封面大图。点详情里的封面打开，滚轮在光标处缩放，按住拖动平移，
 * 双击在适应窗口与原始尺寸之间来回。放大倍数一律以「适应窗口」为 1，
 * 所以窗口大小一变，图还是铺满，不用重新调。
 */
export default function CoverViewer({ src, title, onClose }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const nat = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View>({ fit: 1, zoom: 1, x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [moving, setMoving] = useState(false);

  /* 平移留边：图片中心最多跑到这么远，再远就只剩一条边，找不回来 */
  const clampPos = useCallback((x: number, y: number, fit: number, zoom: number) => {
    const box = boxRef.current;
    const vw = box ? box.clientWidth : window.innerWidth;
    const vh = box ? box.clientHeight : window.innerHeight;
    const dw = nat.current.w * fit * zoom;
    const dh = nat.current.h * fit * zoom;
    return {
      x: clamp(x, -((dw + vw) / 2 - KEEP), (dw + vw) / 2 - KEEP),
      y: clamp(y, -((dh + vh) / 2 - KEEP), (dh + vh) / 2 - KEEP)
    };
  }, []);

  /* 适应窗口的比例：留出顶栏与底部工具条，别让图压在按钮上 */
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box || !nat.current.w) return 1;
    const w = Math.max(80, box.clientWidth - 84);
    const h = Math.max(80, box.clientHeight - 136);
    const f = Math.min(w / nat.current.w, h / nat.current.h);
    return f > 0 ? Math.min(f, MAX_FIT) : 1;
  }, []);

  const fill = useCallback(() => {
    setView({ fit: measure(), zoom: 1, x: 0, y: 0 });
  }, [measure]);

  /* 以窗口中心为原点缩放一份，cx cy 是光标相对中心的偏移 */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setView((v) => {
        const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const k = zoom / v.zoom;
        const p = clampPos(cx - (cx - v.x) * k, cy - (cy - v.y) * k, v.fit, zoom);
        return { fit: v.fit, zoom, ...p };
      });
    },
    [clampPos]
  );

  const boxCenter = () => {
    const box = boxRef.current;
    if (!box) return { cx: 0, cy: 0 };
    const r = box.getBoundingClientRect();
    return { cx: r.width / 2, cy: r.height / 2 };
  };

  /* 滚轮缩放要 preventDefault，只能挂原生监听 */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      /* 触控板给的是小步长，鼠标一格给 100，指数收着点两头都跟手 */
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomAt(factor, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /* 窗口尺寸变了重算适应比例，当前倍数保留 */
  useEffect(() => {
    const onResize = () => {
      setView((v) => {
        const fit = measure();
        const p = clampPos(v.x, v.y, fit, v.zoom);
        return { ...v, fit, ...p };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampPos, measure]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomAt(1.25, 0, 0);
      else if (e.key === "-" || e.key === "_") zoomAt(0.8, 0, 0);
      else if (e.key === "0") fill();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fill, onClose, zoomAt]);

  const scale = view.fit * view.zoom;

  /* 光标是不是落在图上。落在图上不关，双击放大还得靠它 */
  const overImage = (cx: number, cy: number) => {
    const box = boxRef.current;
    if (!box || !nat.current.w) return false;
    const r = box.getBoundingClientRect();
    const dx = Math.abs(cx - r.left - (r.width / 2 + view.x));
    const dy = Math.abs(cy - r.top - (r.height / 2 + view.y));
    return dx <= (nat.current.w * scale) / 2 && dy <= (nat.current.h * scale) / 2;
  };

  /* 挂在 body 上。抽屉自己带 transform，固定定位落在它里面会跟着抽屉走 */
  return createPortal(
    <div
      className={"cvw" + (moving ? " moving" : "")}
      ref={boxRef}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        /* 顶栏与工具条上的按钮不吃拖动，否则指针一被接管，按钮就点不动了 */
        if ((e.target as HTMLElement).closest(".cvw-h, .cvw-bar")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, moved: false };
        setMoving(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
        d.moved = true;
        const p = clampPos(d.ox + dx, d.oy + dy, view.fit, view.zoom);
        setView((v) => ({ ...v, ...p }));
      }}
      /* 点图外的空白处关掉；拖完手抬起来那一下不算点 */
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        setMoving(false);
        if (d && !d.moved && !overImage(e.clientX, e.clientY)) onClose();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setMoving(false);
      }}
      /* 双击：没放大过就跳到原始尺寸，放大过就收回适应窗口 */
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".cvw-h, .cvw-bar")) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (view.zoom > 1.02) fill();
        else
          zoomAt(
            1 / view.zoom / view.fit,
            e.clientX - r.left - r.width / 2,
            e.clientY - r.top - r.height / 2
          );
      }}
    >
      <div className="cvw-h">
        <span className="cvw-t">{title}</span>
        <span className="cvw-hint">滚轮缩放，拖动移动，双击看原尺寸，点图外关闭</span>
        <span className="spacer" />
        <button className="xbtn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
          ×
        </button>
      </div>

      {!ready ? <div className="cvw-wait">正在载入…</div> : null}

      <img
        className="cvw-img"
        src={src}
        alt=""
        draggable={false}
        style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale})` }}
        onLoad={(e) => {
          const im = e.currentTarget;
          nat.current = { w: im.naturalWidth || 1, h: im.naturalHeight || 1 };
          setReady(true);
          fill();
        }}
      />

      <div className="cvw-bar">
        <button className="mini" onClick={() => zoomAt(0.8, 0, 0)} title="缩小（-）">
          缩小
        </button>
        <button className="mini" onClick={() => zoomAt(1.25, 0, 0)} title="放大（+）">
          放大
        </button>
        <button className="mini" onClick={fill} title="铺满可用区域（0）">
          适应
        </button>
        <button
          className="mini"
          title="按图片原始像素显示"
          onClick={() => {
            const { cx, cy } = boxCenter();
            zoomAt(1 / scale, cx, cy);
          }}
        >
          原尺寸
        </button>
        <span className="cvw-pct">{Math.round(scale * 100)}%</span>
      </div>
    </div>,
    document.body
  );
}
