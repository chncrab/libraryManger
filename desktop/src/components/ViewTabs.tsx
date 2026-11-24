import { useState } from "react";
import type { LibraryView } from "../../shared/types";
import { FIXED_VIEW_ID } from "../../shared/types";

interface Props {
  views: LibraryView[];
  currentId: string;
  /** 在书评或阅读页时不高亮书库标签 */
  active: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onMenu: (e: React.MouseEvent, v: LibraryView) => void;
  onDelete: (v: LibraryView) => void;
  onMove: (fromId: string, toId: string) => void;
  addDisabled?: boolean;
}

/**
 * 顶部标题栏的标签。最左「全部」固定，后面的自定义标签横向排，
 * 放不下就压缩并横向滚动。拖动只改自定义标签的顺序。
 */
export default function ViewTabs({ views, currentId, active, onSelect, onAdd, onMenu, onDelete, onMove, addDisabled }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const allOn = active && currentId === FIXED_VIEW_ID;

  const tabKey = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div className="viewtabs" aria-label="书库视图">
      <div className="vt-all">
        <div
          className={"vt-tab fixed" + (allOn ? " on" : "")}
          role="tab"
          tabIndex={0}
          aria-selected={allOn}
          title="全部：所有媒介，一行一本"
          onClick={() => onSelect(FIXED_VIEW_ID)}
          onKeyDown={(e) => tabKey(e, FIXED_VIEW_ID)}
        >
          <span className="vt-name">全部</span>
        </div>
      </div>

      <div
        className="vt-scroll"
        onWheel={(e) => {
          if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {views.map((v) => {
          const on = active && currentId === v.id;
          return (
            <div
              key={v.id}
              className={"vt-tab custom" + (on ? " on" : "") + (dragId === v.id ? " dragging" : "") + (overId === v.id && dragId !== v.id ? " over" : "")}
              role="tab"
              tabIndex={0}
              aria-selected={on}
              title={v.name + " · " + (v.unit === "series" ? "系列" : "单册") + " · " + (v.layout === "table" ? "表格" : "书架") + (v.filter.media ? " · " + v.filter.media : "")}
              draggable
              onDragStart={(e) => {
                setDragId(v.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", v.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === v.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(v.id);
              }}
              onDragLeave={() => setOverId((x) => (x === v.id ? null : x))}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragId || e.dataTransfer.getData("text/plain");
                if (from && from !== v.id) onMove(from, v.id);
                setDragId(null);
                setOverId(null);
              }}
              onClick={() => onSelect(v.id)}
              onDoubleClick={() => onDelete(v)}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onDelete(v);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onMenu(e, v);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                tabKey(e, v.id);
              }}
            >
              <span className="vt-name">{v.name}</span>
            </div>
          );
        })}
      </div>

      <button className="vt-plus" title="新建视图" aria-label="新建视图" disabled={addDisabled} onClick={onAdd}>
        ＋
      </button>
    </div>
  );
}
