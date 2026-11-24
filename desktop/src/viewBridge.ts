/** 视图配置桥接。后端已经提供 views / saveViews，这里只做异常兜底，
 *  IPC 抛错时转成界面能直接提示的中文结果。 */
import api from "./api";
import type { LibraryView, ViewConfigResult, ViewSaveResult } from "../shared/types";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadViews(): Promise<ViewConfigResult> {
  try {
    return await api.views();
  } catch (e) {
    return { views: [], status: "corrupt", msg: "读取视图配置失败：" + reason(e) };
  }
}

export async function saveViews(views: LibraryView[], expectedRoot?: string): Promise<ViewSaveResult> {
  try {
    const r = await api.saveViews(views, expectedRoot);
    if (!r) return { ok: false, msg: "视图配置没有保存成功" };
    return r;
  } catch (e) {
    return { ok: false, msg: "保存视图配置失败：" + reason(e) };
  }
}
