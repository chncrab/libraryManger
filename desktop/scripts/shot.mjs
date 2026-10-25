/** 连上 Electron 的调试端口，取 DOM 摘要并截图。用法：node scripts/shot.mjs [输出文件] */
import fs from "node:fs";

const port = process.env.CDP_PORT || 9334;
const out = process.argv[2] || "shot.png";

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
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

await new Promise((r) => ws.addEventListener("open", r));

await call("Page.enable");
await call("Runtime.enable");

/* 本机 Windows 缩放会把 CSS 视口压到七八百宽，截图看不出真实排布。
   这里按 1440×900 的视口渲染，再整页截 */
const VW = Number(process.env.SHOT_W || 1440);
const VH = Number(process.env.SHOT_H || 900);
await call("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

/* 等首屏数据落地 */
for (let i = 0; i < 20; i++) {
  const n = await evalJs("document.querySelectorAll('.card').length + document.querySelectorAll('.table tbody tr').length");
  if (n > 0) break;
  await new Promise((r) => setTimeout(r, 300));
}

/* 第三个参数指定截图前先做几步操作，逗号分隔，按顺序执行：
   tab:书架 切视图，media:漫画 切媒介，review 进书评库，detail:3 点开第 4 张书卡看详情抽屉 */
const acts = String(process.argv[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (sel, text) =>
  evalJs(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`);

for (const act of acts) {
  if (act.startsWith("detail:")) {
    await evalJs(`(() => { const c = document.querySelectorAll('.card')[${Number(act.slice(7))}]; if (c) c.click(); })()`);
    await wait(800);
  } else if (act === "review") {
    await clickText(".seg button", "书评");
    await wait(1200);
  } else if (act.startsWith("media:")) {
    await clickText(".seg button", act.slice(6));
    await wait(900);
  } else if (act.startsWith("tab:")) {
    await clickText(".seg button", act.slice(4));
    await wait(900);
  } else if (act.startsWith("close")) {
    await evalJs("(() => { const m = document.querySelector('.mask'); if (m) m.click(); })()");
    await wait(500);
  } else if (act === "clearchips") {
    await evalJs("(() => { document.querySelectorAll('.chip.on').forEach((c) => c.click()); })()");
    await wait(900);
  } else if (act === "ctx") {
    await evalJs(`(() => { const c = document.querySelectorAll('.card')[0];
      if (c) c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 320 })); })()`);
    await wait(400);
  } else if (act === "rvedit") {
    await evalJs("(() => { const b = [...document.querySelectorAll('.rvm-h .mini')].find(x => x.textContent === '编辑'); if (b) b.click(); })()");
    await wait(700);
  } else if (act === "cad") {
    await evalJs("(() => { const b = document.querySelector('.h4row .mini'); if (b) b.click(); })()");
    await wait(700);
  } else if (act.startsWith("tcell:")) {
    /* tcell:0:5 点开表格第 1 行第 6 格，让它变成输入框 */
    const [ri, ci] = act.slice(6).split(":").map(Number);
    await evalJs(`(() => {
      const tr = document.querySelectorAll('.table tbody tr')[${ri}];
      if (!tr) return;
      const td = tr.children[${ci}];
      const s = td && td.querySelector('.tc');
      if (s) s.click();
    })()`);
    await wait(400);
  } else if (act === "mpopen") {
    await evalJs("(() => { const m = document.querySelectorAll('.mp-show')[0]; if (m) m.click(); })()");
    await wait(500);
  } else if (act.startsWith("scard:")) {
    /* 系列视图里点第 N 张系列卡，弹出系列书目 */
    await evalJs(`(() => { const c = document.querySelectorAll('.scard')[${Number(act.slice(6))}]; if (c) c.click(); })()`);
    await wait(900);
  } else if (act === "adv") {
    await evalJs(`(() => { const b = [...document.querySelectorAll('.toolbar .mini')].find(x => x.textContent.startsWith('高级筛选')); if (b) b.click(); })()`);
    await wait(500);
  } else if (act === "cols") {
    await evalJs(`(() => { const b = [...document.querySelectorAll('.toolbar .mini')].find(x => x.textContent.startsWith('列设置')); if (b) b.click(); })()`);
    await wait(500);
  } else if (act === "sortadd") {
    await evalJs("(() => { const b = document.querySelector('.sort-add .mini'); if (b) b.click(); })()");
    await wait(400);
  } else if (act === "light" || act === "dark") {
    /* 主题存在 localStorage，直接写进去再刷新，比走菜单稳 */
    await evalJs(`localStorage.setItem('booklib.theme', ${JSON.stringify(act)})`);
    await evalJs("location.reload()");
    await wait(3000);
  } else if (act === "rvmore") {
    await evalJs(`(() => { const b = [...document.querySelectorAll('.rvs-h .mini')].find(x => x.textContent.includes('更多')); if (b) b.click(); })()`);
    await wait(500);
  } else if (Number.isFinite(Number(act)) && act !== "") {
    await evalJs(`(() => { const c = document.querySelectorAll('.card')[${Number(act)}]; if (c) c.click(); })()`);
    await wait(700);
  }
}

const summary = await evalJs(`(() => {
  const t = (s) => (document.querySelector(s) || {}).textContent || '';
  return {
    title: document.title,
    brand: t('.brand'),
    cards: document.querySelectorAll('.card').length,
    facetCount: document.querySelectorAll('.facet').length,
    total: t('.toolbar'),
    empty: t('.empty'),
    body: document.body.innerText.slice(0, 200)
  };
})()`);
console.log(JSON.stringify(summary, null, 1));

const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("截图", out);
ws.close();
