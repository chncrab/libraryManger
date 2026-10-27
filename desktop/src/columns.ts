import type { FieldDef, FieldType } from "../shared/types";

/** 表格列。列定义不再写死，从字段表生成，改一处两边一致。
 *  顺序与详情抽屉的字段一一对应，详情里能改的条目表格里都得有 */
export interface ColDef {
  key: string;
  label: string;
  width?: number;
  /** 不能隐藏的列，比如末列的操作入口 */
  fixed?: boolean;
  type?: FieldType;
  builtin?: number;
}

/** 末列固定，放右键菜单的入口，不属于字段 */
export const MORE_COL: ColDef = { key: "more", label: "", width: 40, fixed: true };

/* 默认全部显示。想让表格窄一点在列设置里隐藏，选择会记住 */
export const DEFAULT_HIDDEN: string[] = [];

/** 字段表 → 表格列。inTable 为假的字段（备注这类长文本）不出列 */
export function colsFromFields(fields: FieldDef[], hidden: string[]): ColDef[] {
  const cols: ColDef[] = fields
    .filter((f) => f.inTable && !f.deletedAt)
    .map((f) => ({
      key: f.key,
      label: f.label,
      width: f.width || undefined,
      type: f.type,
      builtin: f.builtin
    }));
  return [...cols.filter((c) => !hidden.includes(c.key)), MORE_COL];
}

/** 排序键与标签。长文本与图片排不了，其余都能 */
export function sortablesOf(fields: FieldDef[]): { key: string; label: string }[] {
  const extra = [
    { key: "author", label: "作者" },
    { key: "updated", label: "最近改动" },
    { key: "year", label: "出版年" }
  ];
  const mine = fields
    .filter((f) => !f.deletedAt && f.type !== "longtext" && f.type !== "image")
    .map((f) => ({ key: f.key, label: f.label }));
  const seen = new Set(mine.map((m) => m.key));
  return [...mine, ...extra.filter((e) => !seen.has(e.key))];
}
