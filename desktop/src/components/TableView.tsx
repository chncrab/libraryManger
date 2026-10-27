import { cloneElement, type ReactElement } from "react";
import type { BookPatch, BookRow, FieldDef } from "../../shared/types";
import { gradeIcon } from "./GridView";
import { FieldCell } from "./FieldRenderer";
import type { PickItem } from "./Pickers";
import { colsFromFields, type ColDef } from "../columns";

interface Props {
  rows: BookRow[];
  selected: string[];
  /** 字段定义，表格列、单元格控件都从这里取 */
  fields: FieldDef[];
  /** 分类树，分类字段的多选要用整棵树 */
  cats?: PickItem[];
  /** 被列设置隐藏掉的列 */
  hidden: string[];
  onSelect: (id: string, multi?: boolean) => void;
  onCtx: (e: React.MouseEvent, b: BookRow) => void;
  onPatch: (id: string, p: BookPatch) => void;
}

/* 每一格按字段类型出控件，与详情页共用同一套，不再逐列手写 */
export default function TableView({ rows, selected, fields, cats, hidden, onSelect, onCtx, onPatch }: Props) {
  const cols = colsFromFields(fields, hidden);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  const cell = (c: ColDef, b: BookRow) => {
    if (c.key === "more") {
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
    }
    if (c.key === "grade") {
      return (
        <td
          className="dim iconcell"
          title="点一下打开详情，Shift 或 Ctrl 点击多选"
          onClick={(e) => onSelect(b.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        >
          {gradeIcon(b.reviewGrade)}
        </td>
      );
    }
    const f = byKey.get(c.key);
    if (!f) return <td />;
    return (
      <td className={c.key === "title" ? "title" : undefined}>
        <FieldCell
          field={f}
          row={b}
          pickAll={f.patchKey === "categories" ? cats : undefined}
          onPatch={onPatch}
        />
      </td>
    );
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
            {cols.map((c) => {
              /* 每格补上列名，测试与脚本按列名取格子，不靠第几个孩子 */
              const el = cell(c, b) as ReactElement;
              return cloneElement(el, { key: c.key, "data-col": c.key });
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
