/** 表格列定义。列设置面板与表头共用，改一处两边一致 */

export interface ColDef {
  key: string;
  label: string;
  /** 固定宽度的列，其余自适应 */
  width?: number;
  /** 不能隐藏的列，比如末列的操作入口 */
  fixed?: boolean;
}

export const COLUMNS: ColDef[] = [
  { key: "grade", label: "书评", width: 44 },
  { key: "title", label: "书名" },
  { key: "authors", label: "作者" },
  { key: "series", label: "系列" },
  { key: "index", label: "卷", width: 58 },
  { key: "rating", label: "评分", width: 66 },
  { key: "read", label: "已读", width: 46 },
  { key: "year", label: "出版年", width: 78 },
  { key: "categories", label: "分类" },
  { key: "states", label: "实体书" },
  { key: "media", label: "媒介", width: 60 },
  { key: "more", label: "", width: 40, fixed: true }
];

export const DEFAULT_HIDDEN: string[] = ["media"];
