import type { BooklibApi } from "../shared/types";

declare global {
  interface Window {
    api: BooklibApi;
  }
}

const api: BooklibApi = window.api;

export default api;

/** 封面图地址。文件名由书派生，换封面后常常跟换之前同名，
    只给文件名的话地址一个字不变，界面就还挂着旧图。
    所以带一个版本参数，传书或系列的 updated_at，换过封面地址就跟着变 */
export const coverUrl = (file: string, ver?: string): string =>
  file ? "cover://c/" + encodeURIComponent(file) + "?v=" + encodeURIComponent(ver || "0") : "";
