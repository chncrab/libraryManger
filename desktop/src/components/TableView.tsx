import { cloneElement, useState, type ReactElement } from "react";
import type { BookPatch, BookRow } from "../../shared/types";
import { gradeIcon } from "./GridView";
import { MultiPick, SinglePick, type PickItem } from "./Pickers";
import { COLUMNS } from "../columns";

const MEDIA = ["小说", "漫画"];
const EBOOK = ["有", "无"];

interface Props {
  rows: BookRow[];
  selected: string[];
  /** 分类树与实体书取值，供多选下拉用 */
  cats: PickItem[];
  states: string[];
  /** 被列设置隐藏掉的列 */
  hidden: string[];
  onSelect: (id: string, multi?: boolean) => void;
  onCtx: (e: React.MouseEvent, b: BookRow) => void;
  onPatch: (id: string, p: BookPatch) => void;
}

/* 点一下格子就变成输入框，失焦或回车落库，Esc 放弃。
   表格里每一格都是这样，和详情页用同一批字段与同一套取值 */
function TextCell({
  value,
  numeric,
  placeholder,
  onCommit
}: {
  value: string;
  numeric?: boolean;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);

  if (!editing) {
    return (
      <span
        className={"tc" + (value ? "" : " dim")}
        title={value || placeholder || "点一下编辑"}
        onClick={() => {
          setV(value);
          setEditing(true);
        }}
      >
        {value || "—"}
      </span>
    );
  }
  return (
    <input
      className={"tc-in" + (numeric ? " num" : "")}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          setEditing(false);
        }
      }}
    />
  );
}

/* 多选格：点开就是详情页那颗下拉，选一项落一次库，点别处收起 */
function MultiCell({
  all,
  picked,
  onCommit
}: {
  all: PickItem[];
  picked: string[];
  onCommit: (names: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span className={"tc" + (picked.length ? "" : " dim")} onClick={() => setEditing(true)}>
        {picked.length ? picked.join("、") : "—"}
      </span>
    );
  }
  return (
    <div className="tc-mp">
      <MultiPick all={all} picked={picked} autoOpen onCommit={onCommit} onDismiss={() => setEditing(false)} />
    </div>
  );
}

/* 单选格：详情页那颗下拉，选完收起 */
function SingleCell({
  options,
  value,
  placeholder,
  onCommit
}: {
  options: string[];
  value: string | null;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span className={"tc" + (value ? "" : " dim")} onClick={() => setEditing(true)}>
        {value || "—"}
      </span>
    );
  }
  return (
    <div className="tc-mp">
      <SinglePick
        options={options}
        value={value}
        placeholder={placeholder}
        autoOpen
        onCommit={(v) => {
          onCommit(v);
          setEditing(false);
        }}
        onDismiss={() => setEditing(false)}
      />
    </div>
  );
}

const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

export default function TableView({ rows, selected, cats, states, hidden, onSelect, onCtx, onPatch }: Props) {
  const cols = COLUMNS.filter((c) => c.fixed || !hidden.includes(c.key));

  const cell = (key: string, b: BookRow) => {
    switch (key) {
      case "grade":
        return (
          <td
                className="dim iconcell"
                title="点一下打开详情，Shift 或 Ctrl 点击多选"
                onClick={(e) => onSelect(b.id, e.shiftKey || e.ctrlKey || e.metaKey)}
              >
            {gradeIcon(b.reviewGrade)}
          </td>
        );
      case "title":
        return (
          <td className="title">
            <TextCell value={b.title} onCommit={(v) => v.trim() && onPatch(b.id, { title: v.trim() })} />
          </td>
        );
      case "subtitle":
        return (
          <td>
            <TextCell value={b.subtitle} placeholder="中文副标题" onCommit={(v) => onPatch(b.id, { subtitle: v })} />
          </td>
        );
      case "originalTitle":
        return (
          <td>
            <TextCell value={b.originalTitle} onCommit={(v) => onPatch(b.id, { originalTitle: v })} />
          </td>
        );
      case "originalSubtitle":
        return (
          <td>
            <TextCell
              value={b.originalSubtitle}
              placeholder="原文副标题"
              onCommit={(v) => onPatch(b.id, { originalSubtitle: v })}
            />
          </td>
        );
      case "authors":
        return (
          <td>
            <TextCell
              value={b.authors.join("、")}
              placeholder="多位用、分隔"
              onCommit={(v) =>
                onPatch(b.id, {
                  authors: v
                    .split(/[、,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                })
              }
            />
          </td>
        );
      case "series":
        return (
          <td>
            <TextCell value={b.seriesName} placeholder="不属于系列" onCommit={(v) => onPatch(b.id, { seriesName: v.trim() })} />
          </td>
        );
      case "index":
        return (
          <td>
            <TextCell
              value={b.seriesIndex == null ? "" : String(b.seriesIndex)}
              numeric
              placeholder="册序"
              onCommit={(v) => onPatch(b.id, { seriesIndex: v.trim() ? Number(v) : null })}
            />
          </td>
        );
      case "rating":
        return (
          <td>
            <TextCell
              value={b.rating == null || b.rating === 0 ? "" : String(b.rating)}
              numeric
              placeholder="0 到 10"
              onCommit={(v) => onPatch(b.id, { rating: v.trim() ? Math.min(10, Math.max(0, Number(v))) : null })}
            />
          </td>
        );
      case "read":
        return (
          <td className="iconcell">
            <span
              className={"tc tick" + (b.isRead ? " on" : "")}
              title={b.isRead ? "点一下改成未读" : "点一下标为已读"}
              onClick={() => onPatch(b.id, { isRead: !b.isRead, readDate: !b.isRead && !b.readDate ? today() : b.readDate })}
            >
              {b.isRead ? "✓" : ""}
            </span>
          </td>
        );
      case "country":
        return (
          <td>
            <TextCell value={b.country} placeholder="日本" onCommit={(v) => onPatch(b.id, { country: v.trim() })} />
          </td>
        );
      case "publishDate":
        return (
          <td>
            <TextCell
              value={b.publishDate}
              placeholder="YYYY-MM-DD"
              onCommit={(v) => onPatch(b.id, { publishDate: v.trim() })}
            />
          </td>
        );
      case "readDate":
        return (
          <td>
            <TextCell value={b.readDate} placeholder="YYYY-MM-DD" onCommit={(v) => onPatch(b.id, { readDate: v.trim() })} />
          </td>
        );
      case "categories":
        return (
          <td>
            <MultiCell all={cats} picked={b.categories} onCommit={(names) => onPatch(b.id, { categories: names })} />
          </td>
        );
      case "states":
        return (
          <td>
            <MultiCell
              all={states.map((s) => ({ id: s, name: s, parentId: null }))}
              picked={b.states}
              onCommit={(names) => onPatch(b.id, { states: names })}
            />
          </td>
        );
      case "media":
        return (
          <td>
            <SingleCell options={MEDIA} value={b.mediaType} placeholder="小说" onCommit={(v) => onPatch(b.id, { mediaType: v })} />
          </td>
        );
      case "ebook":
        return (
          <td>
            <SingleCell
              options={EBOOK}
              value={b.ebookState || null}
              placeholder="无"
              onCommit={(v) => onPatch(b.id, { ebookState: v })}
            />
          </td>
        );
      case "more":
        return (
          <td className="iconcell">
            <button
              className="mini xs"
              title="更多操作：创建副本、查看详情、删除"
              onClick={(e) => {
                e.stopPropagation();
                onCtx(e, b);
              }}
            >
              ⋯
            </button>
          </td>
        );
      default:
        return <td />;
    }
  };

  return (
    <table className="table">
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c.key}
              data-col={c.key}
              style={c.width ? { width: c.width } : undefined}
              title={c.key === "grade" ? "点图标进详情" : undefined}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} className={selected.includes(b.id) ? "on" : ""} onContextMenu={(e) => onCtx(e, b)}>
            {cols.map((c) =>
              /* 每格补上列名，测试与脚本按列名取格子，不靠第几个孩子 */
              cloneElement(cell(c.key, b) as ReactElement, { key: c.key, "data-col": c.key })
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
