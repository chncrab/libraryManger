import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface CtxItem {
  key: string;
  label: string;
  danger?: boolean;
  sep?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}

/* 右键菜单：定位到鼠标处，贴边时往回收。点别处、按 Esc、滚动都关掉 */
export default function CtxMenu({ x, y, items, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: Math.min(y, window.innerHeight - r.height - 8)
    });
  }, [x, y]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    /* 捕获阶段接，免得被列表自己的点击处理先行拦掉 */
    window.addEventListener("mousedown", away, true);
    window.addEventListener("contextmenu", away, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("contextmenu", away, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it) => (
        <div key={it.key}>
          {it.sep ? <div className="ctx-sep" /> : null}
          <div
            className={"ctx-i" + (it.danger ? " danger" : "") + (it.disabled ? " off" : "")}
            onClick={() => {
              /* 灰掉的项点下去也要收菜单，否则看着像没反应 */
              if (it.disabled) {
                onClose();
                return;
              }
              onPick(it.key);
              onClose();
            }}
          >
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}
