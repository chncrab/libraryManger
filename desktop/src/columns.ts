/** 表格列定义。列设置面板与表头共用，改一处两边一致。
 *  顺序与详情抽屉的字段一一对应，详情里能改的条目表格里都得有，
 *  只有备注是长文本，留在详情里改 */
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
  { key: "title", label: "书名", width: 224 },
  { key: "subtitle", label: "副标题", width: 150 },
  { key: "originalTitle", label: "原作名", width: 200 },
  { key: "originalSubtitle", label: "原作副标题", width: 170 },
  { key: "authors", label: "作者", width: 116 },
  { key: "media", label: "媒介", width: 66 },
  { key: "series", label: "系列", width: 168 },
  { key: "index", label: "卷", width: 54 },
  { key: "country", label: "国籍", width: 70 },
  { key: "publishDate", label: "出版日期", width: 100 },
  { key: "read", label: "已读", width: 46 },
  { key: "readDate", label: "阅读日期", width: 100 },
  { key: "rating", label: "评分", width: 62 },
  { key: "categories", label: "分类", width: 168 },
  { key: "states", label: "实体书", width: 80 },
  { key: "ebook", label: "电子书", width: 72 },
  { key: "more", label: "", width: 40, fixed: true }
];

/* 默认全部显示。想让表格窄一点在列设置里隐藏，选择会记住 */
export const DEFAULT_HIDDEN: string[] = [];
