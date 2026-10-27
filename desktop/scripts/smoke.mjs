/** 交互冒烟：连 Electron 调试端口，按真实点击走一遍关键路径。用法：node scripts/smoke.mjs */
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const port = process.env.CDP_PORT || 9334;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("没有找到页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
await call("Runtime.enable");

const js = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
};
const wait = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : ""));
}

const clickText = (sel, text) =>
  js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return false;
    el.click(); return true;
  })()`);

const totalText = () => js(`(document.querySelector('.toolbar')||{}).textContent||''`);

/* 左栏某一档里某个取值的计数 */
const facetN = (label) =>
  js(`(() => {
    const el = [...document.querySelectorAll('.facet')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!el) return -1;
    const n = el.querySelector('.n');
    return n ? Number(n.textContent) : 0;
  })()`);

// 0 先清掉上一轮存的界面偏好（排序、列、筛选、主题），再刷新回到初始视图
await js(`Object.keys(localStorage).filter(k => k.startsWith('booklib.')).forEach(k => localStorage.removeItem(k))`);
await js("location.reload()");
await wait(3000);

// 1 首屏
await wait(900);
const cards = await js("document.querySelectorAll('.card').length");
check("首屏书架渲染 120 张卡", cards === 120, "实际 " + cards);
const coverOk = await js(`(() => {
  const imgs = [...document.querySelectorAll('.card img, .sh-card img, img')].slice(0, 6);
  const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
  return { loaded, total: imgs.length, sample: imgs[0] ? imgs[0].getAttribute('src') || '' : '' };
})()`);
check(
  "封面图经 cover:// 真的取到了",
  coverOk.total > 0 && coverOk.loaded >= Math.min(3, coverOk.total),
  coverOk.loaded + "/" + coverOk.total + " 张，样例 " + decodeURIComponent(coverOk.sample)
);

// 2 左栏分面跟媒介走：切漫画后「推理」的计数应该变小
const catAll = await facetN("推理");
await clickText(".seg button", "漫画");
await wait(900);
let t = await totalText();
check("切到漫画后总数 518", t.includes("518"), t.slice(0, 20));
const catManga = await facetN("推理");
check("左栏分面跟着媒介重算", catAll > 0 && catManga > 0 && catManga !== catAll, "全部 " + catAll + " → 漫画 " + catManga);
const decAll = await js("document.querySelectorAll('.side h4').length");
check("左栏档数 7（分类/封面/实体书/电子书/阅读状态/出版年代/系列）", decAll === 7, "实际 " + decAll);

// 3 回全部再搜索（两字走 LIKE）
await clickText(".seg button", "全部");
await wait(1000);
await js(`(() => { const i = document.querySelector('.search'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, '柯南'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await wait(1200);
t = await totalText();
const hitTitle = await js("(document.querySelector('.card .t')||{}).textContent||''");
check("搜「柯南」有命中且标题含柯南", /共 [1-9]/.test(t) && hitTitle.includes("柯南"), t.slice(0, 14) + " / " + hitTitle);

// 4 清空搜索，切表格
await js(`(() => { const i = document.querySelector('.search'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await wait(800);
await clickText(".seg button", "表格");
await wait(800);
const rows = await js("document.querySelectorAll('.table tbody tr').length");
check("表格视图有行", rows > 0, "行数 " + rows);

// 4b 表格单击就地编辑：点评分格变成输入框，改成 9.9 后落库
const cellOpen = await js(`(() => {
  const td = document.querySelector('.table tbody tr td[data-col=rating]');
  const s = td && td.querySelector('.tc');
  if (!s) return false;
  s.click();
  return true;
})()`);
await wait(250);
const cellIsInput = await js("!!document.querySelector('.table tbody tr td[data-col=rating] .tc-in')");
await js(`(() => {
  const i = document.querySelector('.table tbody tr td[data-col=rating] .tc-in');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(i, '9.9');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
})()`);
await wait(1300);
const cellVal = await js("document.querySelector('.table tbody tr td[data-col=rating]').textContent.trim()");
check("表格单击单元格可编辑", cellOpen && cellIsInput && cellVal === "9.9", "输入框 " + cellIsInput + "，值 " + cellVal);

// 4c 表格里已读格点一下就能切换
const readBefore = await js("document.querySelector('.table tbody tr td[data-col=read]').textContent.trim()");
await js("document.querySelector('.table tbody tr td[data-col=read] .tc').click()");
await wait(1200);
const readAfter = await js("document.querySelector('.table tbody tr td[data-col=read]').textContent.trim()");
check("表格里点一下就切已读", readBefore !== readAfter, "'" + readBefore + "' → '" + readAfter + "'");

// 5 详情是抽屉：点书评图标打开，点遮罩关闭
await js("document.querySelector('.table tbody tr td.iconcell').click()");
await wait(700);
const detailTitle = await js("(document.querySelector('.drawer .dh h2')||{}).textContent||''");
const drawerOn = await js("document.querySelector('.drawer').classList.contains('on')");
check("详情从右侧抽屉弹出", drawerOn && detailTitle.length > 1, detailTitle.trim().slice(0, 20));

// 5a 表格列与详情字段一一对应：详情里能改的条目表格里都得有，备注是长文本留在详情里
const detailLabels = await js(`(() => {
  const top = [...document.querySelectorAll('.drawer .dfields label')].map(e => e.textContent.trim());
  const kv = [...document.querySelectorAll('.drawer .kv > div > span:first-child')].map(e => e.textContent.trim());
  return [...top, ...kv].filter(Boolean);
})()`);
const headTexts = await js("[...document.querySelectorAll('.table thead th')].map(e => (e.textContent || '').trim())");
/* 详情里一行放两个条目的，表格拆成两列 */
const PAIR = { 系列: ["系列", "卷"], 已读: ["已读", "阅读日期"] };
const headSet = new Set(headTexts.filter(Boolean));
const detailSet = new Set(detailLabels.filter((l) => l !== "备注"));
const pairMembers = new Set(Object.values(PAIR).flat());
const missInTable = detailLabels.filter(
  (l) => l !== "备注" && !(PAIR[l] ? PAIR[l].every((x) => headSet.has(x)) : headSet.has(l))
);
const missInDetail = headTexts.filter((h) => h && h !== "书评" && !detailSet.has(h) && !pairMembers.has(h));
check(
  "表格列与详情字段一一对应（备注除外）",
  missInTable.length === 0 && missInDetail.length === 0,
  "详情 " + detailLabels.length + " 项，表头 " + headTexts.length + " 列" +
    (missInTable.length ? "，表格缺 " + missInTable.join("、") : "") +
    (missInDetail.length ? "，详情缺 " + missInDetail.join("、") : "")
);

// 5b 详情里的下拉统一成同一套，关闭是叉号，评分范围 0 到 10
const pickShown = await js("document.querySelectorAll('.drawer .kv .mp-show').length");
const xText = await js("((document.querySelector('.dh .xbtn')||{}).textContent||'').trim()");
const scoreMax = await js(`[...document.querySelectorAll('.drawer .kv input[type=number]')].map(i => i.max).find(m => m === '10') || ''`);
const ebookPick = await js(`(() => {
  const rows = [...document.querySelectorAll('.drawer .kv > div')];
  const row = rows.find(r => (r.querySelector('span')||{}).textContent === '电子书');
  const box = row && row.querySelector('.mp-show');
  if (!box) return false;
  box.click();
  return true;
})()`);
await wait(300);
const ebookOpts = await js("[...document.querySelectorAll('.drawer .mp-pop .mp-o')].map(e => e.textContent).join(',')");
check("详情下拉统一样式且电子书只有有/无", pickShown >= 4 && ebookPick && ebookOpts === "有,无", "下拉 " + pickShown + " 个，选项 " + ebookOpts);
check("详情关闭是叉号", xText === "×", "'" + xText + "'");
check("评分上限 10", scoreMax === "10", scoreMax);
await js("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
await js("document.querySelector('.mask').click()");
await wait(400);
const drawerOff = await js("document.querySelector('.drawer').classList.contains('on')");
check("点外侧遮罩收起详情", drawerOff === false);

// 6 书评视图：左栏列表 + 中间正文
await clickText(".seg button", "书评");
await wait(1200);
const rvItems = await js("document.querySelectorAll('.rvs-list .rvi').length");
/* 篇数以库里实际为准。样本库会随用户增删书评变化，写死数字一改就红 */
const libDb = path.join(process.env.BOOKLIB_ROOT || path.join("data", "smoke_lib"), "library.db");
const dbReviews = (() => {
  try {
    const py = "import sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute('SELECT (SELECT COUNT(*) FROM reviews WHERE deleted_at IS NULL)+(SELECT COUNT(*) FROM orphan_reviews WHERE deleted_at IS NULL)').fetchone()[0])";
    return Number(execFileSync("python", ["-c", py, libDb], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
})();
check(
  "书评左栏把库里的书评都列出来",
  dbReviews ? rvItems === dbReviews : rvItems >= 100,
  "左栏 " + rvItems + "，库里 " + (dbReviews || "没读到")
);
/* 空书评也会入库，按时间排第一的那个可能正好是空的。先挑一篇有字的再看中间 */
await js(`(() => {
  const it = [...document.querySelectorAll('.rvs-list .rvi')].find((e) => {
    const m = e.querySelector('.rvi-m');
    return m && !/^0 字/.test(m.textContent.trim());
  });
  if (it) it.click();
})()`);
await wait(500);
const rvBody = await js("(document.querySelector('.rvm-body .md')||{}).textContent||''");
check("中间显示书评正文", rvBody.length > 0, rvBody.trim().slice(0, 18));
const rvLeftX = await js("(() => { const a=document.querySelector('.rvs'); const b=document.querySelector('.rvm'); return a && b ? Math.round(a.getBoundingClientRect().width) + '/' + Math.round(b.getBoundingClientRect().left) : '0/0'; })()");
check("列表在左、正文在右", rvLeftX !== "0/0", rvLeftX);

// 7 回书架点分类
await clickText(".seg button", "书架");
await wait(700);
const catClicked = await js(`(() => {
  const el = [...document.querySelectorAll('.facet')].find(e => e.textContent.trim().startsWith('推理'));
  if (!el) return false; el.click(); return true;
})()`);
await wait(900);
t = await totalText();
check("点分类「推理」筛出 708 本", catClicked && t.includes("708"), t.slice(0, 16));

// 7b 预置大分类：点「题材」把旗下小标签的书一起筛出来，树上的数字要对得上
const topN = await facetN("题材");
const topClicked = await js(`(() => {
  const el = [...document.querySelectorAll('.facet')].find(e => e.textContent.trim().startsWith('题材'));
  if (!el) return false; el.click(); return true;
})()`);
await wait(1000);
t = await totalText();
check("大分类「题材」的计数与筛选结果一致", topClicked && topN > 0 && t.includes("共 " + topN + " 本"), "分面 " + topN + "，列表 " + t.slice(0, 18));
await js(`document.querySelectorAll('.chip.on').forEach(e => e.click())`);
await wait(800);

// 8 系列分面
const serClicked = await js(`(() => {
  const el = [...document.querySelectorAll('.facet.ser')].find(e => e.textContent.includes('名侦探柯南'));
  if (!el) return false; el.click(); return true;
})()`);
await wait(900);
t = await totalText();
check("点系列「名侦探柯南」有结果", serClicked && /共 \d+/.test(t), t.slice(0, 16));

/* 写操作会改库，跑之前请用副本库启动：LIBRARY_DB=data/smoke.db */

// 9 右键菜单
await js(`document.querySelectorAll('.chip.on').forEach(e => e.click())`);
await wait(800);
const beforeTotal = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
const ctxOpened = await js(`(() => {
  const card = document.querySelector('.card');
  if (!card) return false;
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 320 }));
  return true;
})()`);
await wait(400);
const ctxItems = await js("[...document.querySelectorAll('.ctx-i')].map(e => e.textContent).join('|')");
check("书库右键弹出菜单", ctxOpened && ctxItems.includes("创建副本") && ctxItems.includes("删除书籍"), ctxItems.slice(0, 40));

// 10 复制条目
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent === '创建副本').click()`);
await wait(1000);
const afterCopy = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
const copyTitle = await js(`(() => { const t = [...document.querySelectorAll('.card .t')].map(e => e.textContent).filter(x => /（1）$/.test(x)); return t[0] || ''; })()`);
check("复制条目后多一本且标题带（1）", afterCopy === beforeTotal + 1 && copyTitle.length > 1, beforeTotal + " → " + afterCopy + " " + copyTitle);

// 11 删除副本并确认
await js(`(() => {
  const card = [...document.querySelectorAll('.card')].find(e => /（1）$/.test((e.querySelector('.t')||{}).textContent || ''));
  if (!card) return false;
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 320 }));
  return true;
})()`);
await wait(350);
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent === '删除书籍').click()`);
await wait(350);
const cfmShown = await js("!!document.querySelector('.cfm')");
await js("document.querySelector('.cfm-b .mini.danger').click()");
await wait(1000);
const afterDel = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
check("删除走二次确认并回到原数量", cfmShown && afterDel === beforeTotal, "确认框 " + cfmShown + "，删除后 " + afterDel);

// 12 详情字段可编辑
await js("document.querySelector('.card').click()");
await wait(700);
const titleInput = await js("(document.querySelector('.dfields input')||{}).value||''");
const newTitle = titleInput + "·测";
await js(`(() => {
  const i = document.querySelector('.dfields input');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, ${JSON.stringify(newTitle)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  /* React 把 onBlur 挂在 focusout 上，dispatch 不冒泡的 blur 收不到 */
  i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
})()`);
await wait(1300);
const drawerH2 = await js("(document.querySelector('.drawer .dh h2')||{}).textContent||''");
const savedFlag = await js("(document.querySelector('.dstat')||{}).textContent||''");
check("详情里改书名能落库", drawerH2.includes("·测"), drawerH2.trim().slice(0, 24) + " / " + savedFlag);

/* 改回去，脚本反复跑不会把库越改越乱 */
await js(`(() => {
  const i = document.querySelector('.dfields input');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, ${JSON.stringify(titleInput)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
})()`);
await wait(900);

// 13 分类管理
await js("document.querySelector('.mask').click()");
await wait(400);
await js("document.querySelector('.h4row .mini').click()");
await wait(500);
const cadOpen = await js("!!document.querySelector('.cadmin')");
await js(`(() => {
  const i = document.querySelector('.cad-foot .cad-in');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, '自测大类');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await wait(700);
const cadHas = await js("[...document.querySelectorAll('.cad-n')].some(e => e.textContent === '自测大类')");
check("分类管理能新增大分类", cadOpen && cadHas, "弹层 " + cadOpen + "，出现 " + cadHas);

// 14 子标签与两级
await js(`(() => {
  const row = [...document.querySelectorAll('.cad-r')].find(e => (e.querySelector('.cad-n')||{}).textContent === '自测大类');
  if (!row) return false;
  [...row.querySelectorAll('.mini')].find(b => b.textContent === '＋').click();
  return true;
})()`);
await wait(300);
await js(`(() => {
  const i = document.querySelector('.cad-add .cad-in');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i, '自测小标签');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await wait(700);
const subIndent = await js(`(() => {
  const r = [...document.querySelectorAll('.cad-r')].find(e => (e.querySelector('.cad-n')||{}).textContent === '自测小标签');
  return r ? r.className : '';
})()`);
check("大分类下能挂小标签", subIndent.includes("sub"), subIndent);

// 收尾：删掉自测分类，别留在库里
await js(`(() => {
  const row = [...document.querySelectorAll('.cad-r')].find(e => (e.querySelector('.cad-n')||{}).textContent === '自测小标签');
  if (row) [...row.querySelectorAll('.mini')].find(b => b.textContent === '删').click();
})()`);
await wait(500);
await js(`(() => {
  const row = [...document.querySelectorAll('.cad-r')].find(e => (e.querySelector('.cad-n')||{}).textContent === '自测大类');
  if (row) [...row.querySelectorAll('.mini')].find(b => b.textContent === '删').click();
})()`);
await wait(500);
const cadClean = await js("[...document.querySelectorAll('.cad-n')].every(e => !e.textContent.startsWith('自测'))");
check("自测分类已清理", cadClean);
await js("document.querySelector('.cadmin .cad-h .xbtn').click()");

// 15 书评新建
await clickText(".seg button", "书评");
await wait(1200);
const rvBefore = await js("document.querySelectorAll('.rvs-list .rvi').length");
await clickText(".rvs-h .mini", "新建");
await wait(900);
const rvAfterNew = await js("document.querySelectorAll('.rvs-list .rvi').length");
const draftTag = await js("[...document.querySelectorAll('.rvi-badge')].some(e => e.textContent === '草稿')");
check("书评库能新建草稿", rvAfterNew === rvBefore + 1 && draftTag, rvBefore + " → " + rvAfterNew);

// 16 编辑正文自动保存（所见即所得，改 DOM 后转回 markdown 落库）
await js(`(() => {
  const el = document.querySelector('.rve');
  el.focus();
  el.innerHTML = '<p>这是一段自测正文，写完应当自动落库。</p>';
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(2200);
const rvStat = await js("(document.querySelector('.rvm-stat')||{}).textContent||''");
const rvFirstWord = await js("((document.querySelector('.rvs-list .rvi .rvi-m')||{}).textContent||'')");
check("书评正文自动保存", rvStat.includes("已保存"), rvStat.slice(0, 24) + " / " + rvFirstWord.slice(0, 14));

// 16b 工具栏加粗：选中整段点 B，DOM 里出现 b/strong，落库后仍是这个形态
const rvBold = await js(`(() => {
  const el = document.querySelector('.rve');
  const p = el.querySelector('p');
  if (!p) return '';
  const r = document.createRange();
  r.selectNodeContents(p);
  const s = window.getSelection();
  s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
  const btn = [...document.querySelectorAll('.rvt-b')].find(b => b.textContent === 'B');
  if (!btn) return '';
  btn.click();
  return el.innerHTML;
})()`);
check("工具栏加粗生效", /<(b|strong)>/i.test(rvBold), rvBold.slice(0, 44));

// 17 书评右键
await js(`(() => {
  const it = document.querySelector('.rvs-list .rvi');
  it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
})()`);
await wait(400);
const rvCtx = await js("[...document.querySelectorAll('.ctx-i')].map(e => e.textContent).join('|')");
check("书评右键弹出菜单", rvCtx.includes("编辑书评") && rvCtx.includes("删除书评"), rvCtx.slice(0, 44));

// 18 删除草稿
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent === '删除书评').click()`);
await wait(400);
const rvCfm = await js("!!document.querySelector('.cfm')");
await js("document.querySelector('.cfm-b .mini.danger').click()");
await wait(1000);
const rvAfterDel = await js("document.querySelectorAll('.rvs-list .rvi').length");
check("删除草稿后回到原数量", rvCfm && rvAfterDel === rvBefore, "确认框 " + rvCfm + "，删除后 " + rvAfterDel);

// 18b 未匹配的书评也要能右键删掉（它和普通书评不在同一张表，id 会撞）
const rightClickOrphan = () =>
  js(`(() => {
    const it = [...document.querySelectorAll('.rvs-list .rvi')].find(e => (e.textContent || '').includes('未匹配'));
    if (!it) return false;
    it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 320 }));
    return true;
  })()`);
let orphanRight = await rightClickOrphan();
/* 样本库里没有未匹配时，放一份对不上书的 md 进去，让目录监听把它收进未匹配池。
   这条断言测的是「未匹配那张表也能删」，不能因为样本里恰好没有就跳过 */
if (!orphanRight) {
  const rdir = path.join(path.dirname(libDb), "reviews");
  fs.writeFileSync(path.join(rdir, "未匹配-《这本不存在》.md"), "冒烟用的未匹配书评", "utf8");
  await wait(3000);
  await clickText(".seg button", "书架");
  await wait(600);
  await clickText(".seg button", "书评");
  await wait(1000);
  orphanRight = await rightClickOrphan();
}
await wait(400);
const orphanDelState = await js(`(() => {
  const b = [...document.querySelectorAll('.ctx-i')].find(e => e.textContent === '删除书评');
  if (!b) return 'no-item';
  return b.className.includes('off') ? 'disabled' : 'enabled';
})()`);
const rvOrphanBefore = await js("document.querySelectorAll('.rvs-list .rvi').length");
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent === '删除书评').click()`);
await wait(450);
await js("document.querySelector('.cfm-b .mini.danger').click()");
await wait(1100);
const rvOrphanAfter = await js("document.querySelectorAll('.rvs-list .rvi').length");
check(
  "未匹配书评右键能删掉",
  orphanRight && orphanDelState === "enabled" && rvOrphanAfter === rvOrphanBefore - 1,
  orphanDelState + "，" + rvOrphanBefore + " → " + rvOrphanAfter
);

// 19 排序圆片：加一个条件，工具栏上多一片
await clickText(".seg button", "书架");
await wait(700);
const sortsBefore = await js("document.querySelectorAll('.chip.sort').length");
await js("document.querySelector('.sort-add .mini').click()");
await wait(300);
await js(`[...document.querySelectorAll('.sort-item')].find(e => e.textContent === '出版年').click()`);
await wait(900);
const sortsAfter = await js("document.querySelectorAll('.chip.sort').length");
check("能追加排序条件", sortsAfter === sortsBefore + 1, sortsBefore + " → " + sortsAfter);

// 20 列设置：隐藏作者列
await clickText(".seg button", "表格");
await wait(800);
const thBefore = await js("document.querySelectorAll('.table thead th').length");
await js(`[...document.querySelectorAll('.toolbar .mini')].find(b => b.textContent.startsWith('列设置')).click()`);
await wait(350);
await js(`[...document.querySelectorAll('.tpanel .tp-row')].find(e => e.textContent.includes('作者')).click()`);
await wait(700);
const thAfter = await js("document.querySelectorAll('.table thead th').length");
check("列设置能隐藏一列", thAfter === thBefore - 1, thBefore + " → " + thAfter);
await js(`[...document.querySelectorAll('.tpanel .tp-foot .mini')].find(b => b.textContent === '全部显示').click()`);
await wait(600);
await js("document.querySelector('.tpanel .xbtn').click()");
await wait(350);

// 21 高级筛选：评分下限收窄
const totalBeforeAdv = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
await js(`[...document.querySelectorAll('.toolbar .mini')].find(b => b.textContent.startsWith('高级筛选')).click()`);
await wait(350);
await js(`(() => {
  const i = document.querySelector('.tpanel .tp-line input');
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(i, '8');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(1100);
const totalAdv = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
check("高级筛选按评分下限收窄", totalAdv > 0 && totalAdv < totalBeforeAdv, totalBeforeAdv + " → " + totalAdv);
await js(`[...document.querySelectorAll('.tpanel .tp-foot .mini')].find(b => b.textContent === '全部清空').click()`);
await wait(900);
const totalAdvBack = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
check("清空高级筛选取回全量", totalAdvBack === totalBeforeAdv, "回到 " + totalAdvBack);
await js("document.querySelector('.tpanel .xbtn').click()");
await wait(300);

// 22 系列视图：两档媒介、系列卡、弹层书目与两个动作
await clickText(".seg button", "系列小说");
await wait(1200);
const scards = await js("document.querySelectorAll('.scard').length");
check("系列小说列出系列卡", scards > 0, scards + " 个");
await js("document.querySelector('.scard').click()");
await wait(900);
const sbItems = await js("document.querySelectorAll('.sb-list .sb-i').length");
const sbBtns = await js("[...document.querySelectorAll('.sb-foot .mini')].map(b => b.textContent).join('|')");
check("系列弹层列出书目并给两个动作", sbItems > 0 && sbBtns.includes("系列书评") && sbBtns.includes("只看本系列"), sbItems + " 册 / " + sbBtns);
await js(`(() => { const d = [...document.querySelectorAll('.drawer')].find(x => x.querySelector('.sb-foot')); if (d) d.querySelector('.xbtn').click(); })()`);
await wait(500);
await clickText(".seg button", "全部");
await wait(700);

// 23 主题：更多菜单里切浅色再切回
await js(`[...document.querySelectorAll('.topbar .mini')].find(b => b.textContent.includes('更多')).click()`);
await wait(350);
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent.includes('浅色主题')).click()`);
await wait(500);
const themeNow = await js("document.documentElement.dataset.theme");
check("能切到浅色主题", themeNow === "light", themeNow);
await js(`[...document.querySelectorAll('.topbar .mini')].find(b => b.textContent.includes('更多')).click()`);
await wait(350);
await js(`[...document.querySelectorAll('.ctx-i')].find(e => e.textContent.includes('深色主题')).click()`);
await wait(500);

// 24 多选与批量创建副本
await clickText(".seg button", "书架");
await wait(800);
const beforeMulti = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
await js(`(() => {
  const cards = [...document.querySelectorAll('.card')];
  cards[0].click();
  cards[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
})()`);
await wait(600);
const multiChip = await js(`(() => { const c = [...document.querySelectorAll('.chip.on')].find((x) => x.textContent.includes('已选')); return c ? c.textContent.trim() : ''; })()`);
check("Shift 点第二本变成多选", multiChip.includes("已选 2 本"), multiChip);
await js(`document.querySelectorAll('.card')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 320, clientY: 320 }))`);
await wait(420);
const multiMenu = await js(`[...document.querySelectorAll('.ctx-i')].map((e) => e.textContent).join('|')`);
check("多选右键菜单整批生效", multiMenu.includes("为这 2 本创建副本"), multiMenu);
await js(`[...document.querySelectorAll('.ctx-i')].find((e) => e.textContent.includes('创建副本')).click()`);
await wait(1600);
const afterMulti = Number((await totalText()).match(/共 (\d+) 本/)?.[1] || 0);
check("批量复制多出两条", afterMulti === beforeMulti + 2, beforeMulti + " → " + afterMulti);

// 25 用户数据全部落在一个书库文件夹里
const rootNow = await js("window.api.info().then((i) => i.libraryRoot)");
check("书库根已就位", !!rootNow && rootNow.includes("smoke"), rootNow);
await js(`[...document.querySelectorAll('.topbar .mini')].find((b) => b.textContent.includes('更多')).click()`);
await wait(380);
const moreTxt = await js(`[...document.querySelectorAll('.ctx-i')].map((e) => e.textContent).join('|')`);
check(
  "更多菜单有书库与搬移入口",
  ["打开书库文件夹", "打开书评文件夹", "切换书库", "把整个书库另存一份"].every((x) => moreTxt.includes(x)),
  moreTxt
);
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await wait(300);

// 26 书评栏的动作条：刷新与重命名，右边写着目录里几份 md
await clickText(".seg button", "书评");
await wait(1200);
const actsTxt = await js(`(document.querySelector('.rvs-acts') || {}).textContent || ''`);
check(
  "书评栏有刷新与重命名",
  actsTxt.includes("刷新") && actsTxt.includes("重命名") && /\d+ 个 md/.test(actsTxt),
  actsTxt
);
const oldBar = await js(`document.querySelectorAll('.rvs-dir').length`);
check("只开文件夹的旧提示条已去掉", oldBar === 0, "还剩 " + oldBar + " 条");
await js(`[...document.querySelectorAll('.rvs-acts .mini')].find((b) => b.textContent.includes('重命名')).click()`);
await wait(1600);
const renToast = await js(`(document.querySelector('.toast') || {}).textContent || ''`);
check("重命名按下去会给结果", renToast.includes("重命名"), renToast);
await js(`[...document.querySelectorAll('.rvs-acts .mini')].find((b) => b.textContent.includes('刷新')).click()`);
await wait(1900);
const refToast = await js(`(document.querySelector('.toast') || {}).textContent || ''`);
check("刷新会扫一遍目录并报结果", refToast.includes("刷新"), refToast);
await js(`[...document.querySelectorAll('.rvs-h .mini')].find((b) => b.textContent.includes('更多')).click()`);
await wait(400);
const rvMenu = await js(`[...document.querySelectorAll('.ctx-i')].map((e) => e.textContent).join('|')`);
check(
  "书评菜单保留打开文件夹，重复的同步项已收进刷新",
  rvMenu.includes("打开书评文件夹") && !rvMenu.includes("立即与文件夹同步"),
  rvMenu
);
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await wait(300);

// 27 空的 md 也要收进来：目录里有这份文件，界面上就得有这一条
const emptyDir = path.join(rootNow, "reviews");
const emptyFile = path.join(emptyDir, "空占位-冒烟.md");
fs.writeFileSync(emptyFile, "", "utf8");
await js(`[...document.querySelectorAll('.rvs-acts .mini')].find((b) => b.textContent.includes('刷新')).click()`);
await wait(2400);
const seenEmpty = await js(
  `[...document.querySelectorAll('.rvs-list .rvi')].some((e) => (e.textContent || '').includes('空占位'))`
);
check("空的 md 也进库并显示", seenEmpty === true, "写了一份 " + path.basename(emptyFile));

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
ws.close();
process.exit(bad.length ? 1 : 0);
