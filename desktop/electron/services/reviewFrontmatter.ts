import type { ReviewFrontmatterField } from "../../shared/types";
import { splitReviewFile } from "./reviewFileFormat";

type Line = { start: number; end: number; text: string; eol: string };
type Prop = {
  key: string;
  keyRaw: string;
  value: string;
  start: number;
  end: number;
  eol: string;
  hadEol: boolean;
};

function scanLines(s: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    while (i < s.length && s[i] !== "\r" && s[i] !== "\n") i++;
    const end = i;
    let eol = "";
    if (s[i] === "\r") {
      if (s[i + 1] === "\n") {
        eol = "\r\n";
        i += 2;
      } else {
        eol = "\r";
        i++;
      }
    } else if (s[i] === "\n") {
      eol = "\n";
      i++;
    }
    out.push({ start, end, text: s.slice(start, end), eol });
  }
  return out;
}

function detectNl(s: string): string {
  if (s.includes("\r\n")) return "\r\n";
  if (s.includes("\n")) return "\n";
  if (s.includes("\r")) return "\r";
  return "\n";
}

function unquoteKey(raw: string): string {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
    return raw.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return raw;
}

function matchProperty(text: string): { key: string; keyRaw: string; inline: string } | null {
  if (!text || /^[\s#]/.test(text) || text === "-" || text.startsWith("- ")) return null;
  let colon = -1;
  let keyRaw = "";
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    let i = 1;
    let esc = false;
    for (; i < text.length; i++) {
      if (esc) {
        esc = false;
        continue;
      }
      if (text[i] === "\\") {
        esc = true;
        continue;
      }
      if (text[i] === q) break;
    }
    if (i >= text.length) return null;
    let j = i + 1;
    while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
    if (text[j] !== ":") return null;
    colon = j;
    keyRaw = text.slice(0, i + 1);
  } else {
    colon = text.indexOf(":");
    if (colon <= 0) return null;
    keyRaw = text.slice(0, colon).trim();
    if (!keyRaw) return null;
  }
  const key = unquoteKey(keyRaw);
  if (!key) return null;
  const inline = text.slice(colon + 1).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return { key, keyRaw, inline };
}

function parseProps(lines: Line[], start: number, end: number, nl: string): Prop[] {
  const props: Prop[] = [];
  for (let i = start; i < end; ) {
    const m = matchProperty(lines[i].text);
    if (!m) {
      i++;
      continue;
    }
    let j = i + 1;
    let last = i;
    while (j < end) {
      const t = lines[j].text;
      if (t === "" || /^[ \t]/.test(t) || t === "-" || t.startsWith("- ")) {
        if (t !== "") last = j;
        j++;
      } else break;
    }
    const cont: string[] = [];
    for (let k = i + 1; k <= last; k++) cont.push(lines[k].text);
    const value = cont.length ? (m.inline ? m.inline + "\n" + cont.join("\n") : cont.join("\n")) : m.inline;
    const lastLine = lines[last];
    const eol = lines[i].eol || nl;
    props.push({
      key: m.key,
      keyRaw: m.keyRaw,
      value,
      start: lines[i].start,
      end: lastLine.end + lastLine.eol.length,
      eol,
      hadEol: lastLine.eol.length > 0,
    });
    i = j;
  }
  return props;
}

function parseHeader(front: string): { props: Prop[]; contentEnd: number; newline: string } | null {
  const lines = scanLines(front);
  if (!lines.length) return null;
  let openText = lines[0].text;
  if (openText.charCodeAt(0) === 0xfeff) openText = openText.slice(1);
  if (openText !== "---") return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].text === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const nl = lines[0].eol || detectNl(front);
  return { props: parseProps(lines, 1, close, nl), contentEnd: lines[close].start, newline: nl };
}

function validateKey(key: string): void {
  if (!key) throw new Error("属性键不能为空");
  if (key !== key.trim()) throw new Error("属性键不能包含首尾空白");
  if (/[\r\n]/.test(key)) throw new Error("属性键不能包含换行");
  if (/^[#\s]/.test(key)) throw new Error("属性键不合法");
  if (key.includes(":")) throw new Error("属性键不能包含冒号");
  if (key === "---" || key === "-" || key.startsWith("- ")) throw new Error("属性键不合法");
}

function validateValue(value: string): void {
  if (/\r/.test(value)) throw new Error("属性值不能包含回车");
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") throw new Error("属性值不能以空行结尾");
  const first = lines[0] || "";
  const cont = first === "" || /^[ \t]/.test(first) || first === "-" || first.startsWith("- ") ? lines : lines.slice(1);
  for (const line of cont) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) || line === "-" || line.startsWith("- ")) continue;
    throw new Error("属性值不能插入顶层属性或分隔线");
  }
}

function formatProp(key: string, value: string, nl: string): string {
  const lines = value.split("\n");
  const first = lines[0] || "";
  const listLike = first === "" || /^[ \t]/.test(first) || first === "-" || first.startsWith("- ");
  if (listLike) return key + ":" + nl + lines.join(nl);
  if (lines.length > 1) return key + ": " + lines[0] + nl + lines.slice(1).join(nl);
  return key + ": " + value;
}

export function readReviewFrontmatter(raw: string): ReviewFrontmatterField[] {
  const header = parseHeader(splitReviewFile(raw).front);
  return header ? header.props.map(({ key, value }) => ({ key, value })) : [];
}

export function patchReviewFrontmatter(raw: string, changes: ReviewFrontmatterField[]): string {
  const list: ReviewFrontmatterField[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(changes)) throw new Error("标签改动格式不正确");
  for (const c of changes) {
    if (!c || typeof c.key !== "string" || typeof c.value !== "string") throw new Error("标签改动格式不正确");
    validateKey(c.key);
    if (seen.has(c.key)) throw new Error(`重复编辑属性「${c.key}」`);
    seen.add(c.key);
    const value = c.value.startsWith("\n") ? c.value.slice(1) : c.value;
    list.push({ key: c.key, value });
  }
  const parsed = splitReviewFile(raw);
  const header = parseHeader(parsed.front);
  if (!header) {
    const nl = detectNl(raw);
    const additions: string[] = [];
    for (const c of list) {
      if (c.value.trim() === "") continue;
      validateValue(c.value);
      additions.push(formatProp(c.key, c.value, nl) + nl);
    }
    if (!additions.length) return raw;
    return parsed.front + "---" + nl + additions.join("") + "---" + nl + nl + parsed.md;
  }
  const counts = new Map<string, number>();
  for (const p of header.props) counts.set(p.key, (counts.get(p.key) || 0) + 1);
  const edits: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  for (const c of list) {
    if ((counts.get(c.key) || 0) > 1) throw new Error(`属性「${c.key}」重复，无法安全编辑`);
    const prop = header.props.find(p => p.key === c.key);
    if (c.value.trim() === "") {
      if (prop) edits.push({ start: prop.start, end: prop.end, text: "" });
      continue;
    }
    validateValue(c.value);
    if (prop) {
      const eol = prop.eol || header.newline;
      const text = formatProp(prop.keyRaw, c.value, eol) + (prop.hadEol ? eol : "");
      edits.push({ start: prop.start, end: prop.end, text });
    } else {
      additions.push(formatProp(c.key, c.value, header.newline) + header.newline);
    }
  }
  if (additions.length) edits.push({ start: header.contentEnd, end: header.contentEnd, text: additions.join("") });
  if (!edits.length) return raw;
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = raw;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
