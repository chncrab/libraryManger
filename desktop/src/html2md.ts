/**
 * 把编辑区里的 HTML 还原成 markdown。所见即所得编辑器只改 DOM，
 * 落库仍是 markdown 原文，两边来回传要靠这一层。
 * 只处理编辑器自己会产出的那些标签，遇到不认识的按行内文本拼进去，不丢字。
 */

const WRAP: Record<string, string> = { STRONG: "**", B: "**", EM: "*", I: "*", DEL: "~~", S: "~~", STRIKE: "~~" };

function inlineOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (tag === "BR") return "\n";
  const kids = [...el.childNodes].map(inlineOf).join("");
  if (WRAP[tag]) return WRAP[tag] + kids + WRAP[tag];
  if (tag === "CODE") return "`" + kids + "`";
  if (tag === "A") {
    const href = el.getAttribute("href") || "";
    return href ? "[" + kids + "](" + href + ")" : kids;
  }
  if (tag === "IMG") return "![" + (el.getAttribute("alt") || "") + "](" + (el.getAttribute("src") || "") + ")";
  return kids;
}

function listToMd(el: HTMLElement, ordered: boolean, depth: number): string {
  const out: string[] = [];
  const items = [...el.children].filter((c) => c.tagName === "LI") as HTMLElement[];
  items.forEach((li, i) => {
    let head = "";
    let nest = "";
    for (const c of [...li.childNodes]) {
      if (c.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test((c as HTMLElement).tagName)) {
        const sub = c as HTMLElement;
        nest += listToMd(sub, sub.tagName === "OL", depth + 1);
      } else {
        head += inlineOf(c);
      }
    }
    const mark = ordered ? i + 1 + ". " : "- ";
    out.push("  ".repeat(depth) + mark + head.trim().replace(/\n+/g, " "));
    if (nest) out.push(nest.replace(/\n$/, ""));
  });
  return out.join("\n") + "\n";
}

function tableToMd(el: HTMLElement): string {
  const rows = [...el.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((td) => inlineOf(td).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|"))
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => r.concat(Array(width - r.length).fill(""));
  const head = pad(rows[0]);
  const out = ["| " + head.join(" | ") + " |", "| " + head.map(() => "---").join(" | ") + " |"];
  for (const r of rows.slice(1)) out.push("| " + pad(r).join(" | ") + " |");
  return out.join("\n");
}

function blockOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent || "").trim();
    return t ? t + "\n\n" : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;

  const hd = tag.match(/^H([1-6])$/);
  if (hd) return "#".repeat(Number(hd[1])) + " " + inlineOf(el).trim() + "\n\n";
  if (tag === "HR") return "---\n\n";
  if (tag === "PRE") return "```\n" + (el.textContent || "").replace(/\n+$/, "") + "\n```\n\n";
  if (tag === "BLOCKQUOTE") {
    const inner = htmlToMd(el.innerHTML).trim();
    return inner
      .split("\n")
      .map((l) => "> " + l)
      .join("\n") + "\n\n";
  }
  if (tag === "UL" || tag === "OL") return listToMd(el, tag === "OL", 0) + "\n";
  if (tag === "TABLE") return tableToMd(el) + "\n\n";

  /* 浏览器回车默认生成 div，mdToHtml 出来的却是 p，两种都当段落 */
  const t = inlineOf(el);
  return t.trim() ? t.trim() + "\n\n" : "";
}

export function htmlToMd(html: string): string {
  const box = document.createElement("div");
  box.innerHTML = html;
  const body = [...box.childNodes].map(blockOf).join("");
  return body.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim() + "\n";
}
