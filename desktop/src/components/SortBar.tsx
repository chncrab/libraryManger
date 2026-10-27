import { useState } from "react";
import type { SortSpec } from "../../shared/types";

export const DEFAULT_SORTS: SortSpec[] = [{ key: "title", dir: 1 }];

/* 老配置里可能存着旧键，排序时找不到会被忽略，这里只把形状理正 */
export function normalizeSorts(v: unknown): SortSpec[] {
  if (Array.isArray(v)) {
    const out = v.filter((x) => x && typeof x.key === "string" && (x.dir === 1 || x.dir === -1)) as SortSpec[];
    return out.length ? out : DEFAULT_SORTS;
  }
  if (typeof v === "string" && v) {
    return [{ key: v, dir: v === "rating" || v === "year" || v === "read" ? -1 : 1 }];
  }
  return DEFAULT_SORTS;
}

/**
 * 排序条件做成可拖拽的圆片，工具栏与设置面板共用这一套。
 * 点一下翻方向，× 去掉，拖到别的位置就换优先级。
 * 能排的字段由外部的字段表给，自定义字段建出来就在列表里。
 */
export default function SortBar({
  sorts,
  onChange,
  sortables,
  compact = false
}: {
  sorts: SortSpec[];
  onChange: (s: SortSpec[]) => void;
  sortables: { key: string; label: string }[];
  compact?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const labelOf = (key: string) => sortables.find((s) => s.key === key)?.label || key;

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = sorts.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onChange(next);
  };

  const add = (key: string) => {
    if (sorts.some((s) => s.key === key)) return;
    onChange([...sorts, { key, dir: key === "rating" || key === "read" || key === "year" ? -1 : 1 }]);
    setAddOpen(false);
  };

  return (
    <div className={"sortbar" + (compact ? " compact" : "")}>
      {sorts.map((s, i) => (
        <span
          key={s.key}
          className={"chip sort" + (drag === i ? " dragging" : "")}
          draggable
          onDragStart={() => setDrag(i)}
          onDragEnd={() => setDrag(null)}
          onDragOver={(e) => {
            e.preventDefault();
            if (drag !== null && drag !== i) move(drag, i), setDrag(i);
          }}
          title="拖到别处换优先级，点一下翻方向"
        >
          <b onClick={() => onChange(sorts.map((x, j) => (j === i ? { ...x, dir: x.dir === 1 ? -1 : 1 } : x)))}>
            {labelOf(s.key)} {s.dir === 1 ? "↑" : "↓"}
          </b>
          {sorts.length > 1 ? (
            <i
              title="去掉这个排序条件"
              onClick={(e) => {
                e.stopPropagation();
                onChange(sorts.filter((_, j) => j !== i));
              }}
            >
              ×
            </i>
          ) : null}
        </span>
      ))}

      <div className="sort-add">
        <button className="mini xs" onClick={() => setAddOpen(!addOpen)} title="再加一个排序条件">
          + 排序
        </button>
        {addOpen ? (
          <>
            <div className="sort-mask" onClick={() => setAddOpen(false)} />
            <div className="sort-pop">
              {sortables
                .filter((s) => !sorts.some((x) => x.key === s.key))
                .map((s) => (
                  <div key={s.key} className="sort-item" onClick={() => add(s.key)}>
                    {s.label}
                  </div>
                ))}
              {sortables.every((s) => sorts.some((x) => x.key === s.key)) ? <div className="dim">都加上了</div> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
