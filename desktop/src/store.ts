/** 界面偏好（主题、列、排序、筛选）存本机 localStorage，不进数据库，换机器不带走 */

const PREFIX = "booklib.";

export function loadJson<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return def;
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

export function loadStr(key: string, def: string): string {
  try {
    return localStorage.getItem(PREFIX + key) || def;
  } catch {
    return def;
  }
}

export function saveStr(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* 同上 */
  }
}
