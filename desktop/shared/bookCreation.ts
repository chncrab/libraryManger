/**
 * 新增图书的入参与选项。放 shared 里是因为主进程与界面共用同一套形状，
 * 逻辑只在 services/editService.ts。
 */

export type NewBookMode = "series-one" | "series-many" | "author" | "blank";

export interface NewBookInput {
  mode: NewBookMode;
  /** 系列新增时必填 */
  seriesId?: number;
  /** 按作者新增时必填 */
  authorId?: number;
  /** 系列批量新增的册数，1 到 100 */
  count?: number;
  /** 按作者或空白新增时的媒介 */
  mediaType?: "小说" | "漫画";
}

export interface NewBookOptions {
  series: { id: number; name: string; mediaType: string }[];
  authors: { id: number; name: string }[];
}

export interface NewBookResult {
  ok: boolean;
  msg?: string;
  ids?: string[];
}
