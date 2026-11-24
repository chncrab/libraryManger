/**
 * 搜索框里的 @ 字段。放 shared 里是为了让服务层与界面用同一套拆词，
 * 书库视图与系列视图只是把拆出来的条件接到不同的表上。
 *
 * 认得的写法只有 @作者:值、@书名:值、@原作名:值、@系列:值、@分类:值。
 * 值可以用双引号包起来，引号里的空格不拆；引号里连写两个 "" 表示一个引号。
 * 只有词条没有值的（例如 @作者 或 @作者:）先不筛，避免刚敲一半就把结果清空。
 */

export type BookSearchField = "作者" | "书名" | "原作名" | "系列" | "分类";

export interface BookSearchFieldTerm {
  field: BookSearchField;
  value: string;
}

export interface ParsedBookSearch {
  /** 去掉字段词条后剩下的普通关键词，仍走原来的关键词路径 */
  keywords: string;
  fields: BookSearchFieldTerm[];
  /** 出现过已知字段词条（哪怕没写值），调用方据此决定还要不要拿原串当关键词 */
  hasFields: boolean;
}

export const BOOK_SEARCH_FIELDS: readonly BookSearchField[] = ["作者", "书名", "原作名", "系列", "分类"];

const FIELD_SET = new Set<string>(BOOK_SEARCH_FIELDS);

function isKnownField(name: string): name is BookSearchField {
  return FIELD_SET.has(name);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function isColon(ch: string): boolean {
  /* 中文输入法下很容易打出全角冒号，一起认 */
  return ch === ":" || ch === "：";
}

/** 当前是不是另一个 @字段: 的开头，用来让不带空格的连续词条也能断开 */
function isFieldStart(s: string, i: number): boolean {
  if (s[i] !== "@") return false;
  let j = i + 1;
  while (j < s.length && !isSpace(s[j]) && !isColon(s[j])) j++;
  return isColon(s[j] || "") && isKnownField(s.slice(i + 1, j));
}

function readQuoted(s: string, from: number): { value: string; next: number } {
  let i = from + 1;
  let value = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      value += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (s[i + 1] === '"') {
        value += '"';
        i += 2;
        continue;
      }
      return { value, next: i + 1 };
    }
    value += ch;
    i++;
  }
  return { value, next: i };
}

export function parseBookSearch(input: string | null | undefined): ParsedBookSearch {
  const s = String(input == null ? "" : input);
  const words: string[] = [];
  const fields: BookSearchFieldTerm[] = [];
  let hasFields = false;
  let i = 0;

  while (i < s.length) {
    while (i < s.length && isSpace(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === "@") {
      let j = i + 1;
      while (j < s.length && !isSpace(s[j]) && !isColon(s[j])) j++;
      const name = s.slice(i + 1, j);
      if (!isColon(s[j] || "") && BOOK_SEARCH_FIELDS.some((field) => field.startsWith(name)) && !isKnownField(name)) {
        hasFields = true;
        i = j;
        continue;
      }
      if (isKnownField(name)) {
        hasFields = true;
        i = j;
        let value = "";
        let quoted = false;
        if (isColon(s[i] || "")) {
          i++;
          if (s[i] === '"') {
            quoted = true;
            const read = readQuoted(s, i);
            value = read.value;
            i = read.next;
          } else {
            const start = i;
            while (i < s.length && !isSpace(s[i]) && !isFieldStart(s, i)) i++;
            value = s.slice(start, i);
          }
        }
        /* 引号里原样保留空格，只拿 trim 后的值判断是不是空词条 */
        if (value.trim() !== "") {
          fields.push({ field: name, value: quoted ? value : value.trim() });
        }
        continue;
      }
    }

    const start = i;
    while (i < s.length && !isSpace(s[i])) i++;
    words.push(s.slice(start, i));
  }

  return { keywords: words.join(" "), fields, hasFields };
}
