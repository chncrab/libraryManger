/**
 * 书评正文的 markdown 渲染。和 demo 里那套手写实现同源，不引第三方库，
 * 够用范围就是书评里常见的东西：标题、列表、引用、代码、表格、粗斜体与链接。
 * 所有正文先转义再拼标签，正文里的尖括号不会变成真标签。
 */

export const esc = (s: unknown): string =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function inline(s: string): string {
  const codes: string[] = [];
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return "\u0001" + (codes.length - 1) + "\u0001";
  });
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => "<code>" + codes[+i] + "</code>");
  return t;
}

const cells = (row: string): string[] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

function list(lines: string[], start: number): [string, number] {
  const m0 = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+/)!;
  const indent = m0[1].length;
  const ordered = /\d/.test(m0[2]);
  const items: { text: string; kids: string }[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m) {
      if (items.length && /^\s+\S/.test(lines[i])) {
        items[items.length - 1].text += "\n" + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    if (m[1].length < indent) break;
    if (m[1].length === indent) {
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: m[3], kids: "" });
      i++;
      continue;
    }
    const sub = list(lines, i);
    if (items.length) items[items.length - 1].kids += sub[0];
    i = sub[1];
  }
  const tag = ordered ? "ol" : "ul";
  const body = items.map((it) => "<li>" + inline(it.text).replace(/\n/g, "<br>") + it.kids + "</li>").join("");
  return ["<" + tag + ">" + body + "</" + tag + ">", i];
}

export function mdToHtml(src: string): string {
  const lines = String(src == null ? "" : src)
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blank = (s: string) => !s.trim();
  const sep = (s: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.indexOf("-") >= 0;
  const start = (s: string) =>
    /^\s*(#{1,6})\s+/.test(s) ||
    /^\s*>/.test(s) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(s) ||
    /^\s*(```|~~~)/.test(s) ||
    /^\s*([-*_])\s*\1\s*\1/.test(s);

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (blank(ln)) {
      i++;
      continue;
    }
    const fence = ln.match(/^\s*(```|~~~)/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i].indexOf(fence[1]) < 0) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }
    const hd = ln.match(/^(#{1,6})\s+(.*)$/);
    if (hd) {
      const lv = hd[1].length;
      out.push("<h" + lv + ">" + inline(hd[2].trim()) + "</h" + lv + ">");
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + mdToHtml(buf.join("\n")) + "</blockquote>");
      continue;
    }
    if (ln.indexOf("|") >= 0 && i + 1 < lines.length && sep(lines[i + 1])) {
      const head = cells(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].indexOf("|") >= 0 && !blank(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => "<th>" + inline(c) + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + head.map((_, j) => "<td>" + inline(r[j] || "") + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>"
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      const r = list(lines, i);
      out.push(r[0]);
      i = r[1];
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && !blank(lines[i]) && !start(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push("<p>" + inline(buf.join("\n")).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("\n");
}
