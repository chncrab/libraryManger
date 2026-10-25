import { useState } from "react";
import type { SortKey, SortSpec } from "../../shared/types";

export const SORT_LABEL: Record<SortKey, string> = {
  title: "书名",
  author: "作者",
  series: "系列",
  index: "卷序",
  rating: "评分",
  read: "读完时间",
  year: "出版年",
  updated: "最近改动",
  grade: "书评等级"
};

export const SORT_KEYS = Object.keys(SORT_LABEL) as SortKey[];

export const DEFAULT_SORTS: SortSpec[] = [{ key: "title", dir: 1 }];

/** 旧版本存下来的单字段排序转成数组，别让老配置一升级就丢 */
export function normalizeSorts(v: unknown): SortSpec[] {
  if (Array.isArray(v)) {
    const out = v.filter((x) => x && SORT_LABEL[x.key as SortKey]) as SortSpec[];
    return out.length ? out : DEFAULT_SORTS;
  }
  if (typeof v === "string" && SORT_LABEL[v as SortKey]) {
    return [{ key: v as SortKey, dir: v === "rating" || v === "year" || v === "read" ? -1 : 1 }];
  }
  return DEFAULT_SORTS;
}

/**
 * 排序条件做成可拖拽的圆片，工具栏与设置面板共用这一套。
 * 点一下翻方向，× 去掉，拖到别的位置就换优先级。
 */
export default function SortBar({
  sorts,
  onChange,
  compact = false
}: {
  sorts: SortSpec[];
  onChange: (s: SortSpec[]) => void;
  compact?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = sorts.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onChange(next);
  };

  const add = (key: SortKey) => {
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
            {SORT_LABEL[s.key]} {s.dir === 1 ? "↑" : "↓"}
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
              {SORT_KEYS.filter((k) => !sorts.some((s) => s.key === k)).map((k) => (
                <div key={k} className="sort-item" onClick={() => add(k)}>
                  {SORT_LABEL[k]}
                </div>
              ))}
              {SORT_KEYS.every((k) => sorts.some((s) => s.key === k)) ? <div className="dim">都加上了</div> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
