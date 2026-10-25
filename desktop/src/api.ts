import type { BooklibApi } from "../shared/types";

declare global {
  interface Window {
    api: BooklibApi;
  }
}

const api: BooklibApi = window.api;

export default api;

export const coverUrl = (file: string): string => (file ? "cover://c/" + encodeURIComponent(file) : "");
