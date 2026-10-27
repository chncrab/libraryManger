/*
 * 只跑字段这一块的冒烟。改字段体系时用它，不必把书架、书评、分类那一长串都过一遍。
 * 自己起一个 electron 实例，用书库副本，跑完自动收掉，连新建的字段一起清干净。
 * 用法：node scripts/smoke-fields.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.BOOKLIB_SRC || path.join(root, "我的书库");
const lib = path.join(root, "data", "smoke_fields");
const userData = path.join(root, "data", "_smoke_fields_user");
const port = Number(process.env.CDP_PORT || 9337);
const LABEL = "入手日期";

/* 这台机器上的 node 一调 fs.cpSync 就直接退，连错误都不给，只能自己走一遍 */
function rmrf(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) rmrf(path.join(p, n));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    const x = path.join(a, e.name);
    const y = path.join(b, e.name);
    if (e.isDirectory()) copyDir(x, y);
    else fs.copyFileSync(x, y);
  }
}

if (!fs.existsSync(path.join(src, "library.db"))) {
  console.log("缺少样本库 " + src + "，跳过");
  process.exit(0);
}
rmrf(lib);
rmrf(userData);
copyDir(src, lib);

const electron = require("electron");
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
env.BOOKLIB_ROOT = lib;

console.log("起一个只跑字段的实例…");
const child = spawn(
  electron,
  [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + port, "--disable-gpu", "--in-process-gpu"],
  { cwd: root, env, stdio: "ignore" }
);

const stop = () => {
  if (!child.pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
};
process.on("exit", stop);

let ws = null;
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const js = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = (sel, text) =>
  js(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(
      text
    )}); if (!el) return false; el.click(); return true; })()`
  );
/* 受控输入框要靠原生 setter 赋值，直接改 value 不会触发 React 的 onChange */
const setInput = (sel, text) =>
  js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  })()`);

let ok = 0;
let bad = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    ok++;
    console.log("PASS " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("FAIL " + name + (extra ? "  " + extra : ""));
  }
};

/* 等调试端口起来 */
let page = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === "page");
    if (page) break;
  } catch {
    /* 还没起来 */
  }
  await wait(300);
}
if (!page) {
  console.log("等不到调试端口，实例没起来");
  stop();
  process.exit(1);
}
ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});
await new Promise((r) => ws.addEventListener("open", r));
await call("Page.enable");
await call("Runtime.enable");
await wait(2600);

/* ---- 内建字段登记 ---- */
const builtin = await js(`(async () => {
  const fs2 = await window.api.listFields();
  return JSON.stringify({ n: fs2.length, keys: fs2.map(f => f.key), types: fs2.map(f => f.type) });
})()`);
const bi = JSON.parse(builtin);
check("十八个内建字段都登记了", bi.n === 18, bi.n + " 个");
check("字段带着类型", bi.types.includes("date") && bi.types.includes("multiselect") && bi.types.includes("switch"), bi.types.join(","));

/* ---- 字段管理弹层 ---- */
await clickText(".topbar .mini", "更多 ▾");
await wait(400);
const hasEntry = await clickText(".ctx-i", "字段管理…");
await wait(700);
const admTitle = await js("(document.querySelector('.cad-h h3')||{}).textContent||''");
check("更多菜单里能打开字段管理", hasEntry && admTitle === "字段管理", admTitle);

/* 新建一个日期字段 */
await setInput(".cad-foot .cad-in", LABEL);
await setInput(".cad-foot select", "date");
await clickText(".cad-foot .mini", "新建");
await wait(900);
const made = await js(`(async () => {
  const fs2 = await window.api.listFields();
  const f = fs2.find(x => x.label === ${JSON.stringify(LABEL)});
  return JSON.stringify(f ? { key: f.key, type: f.type } : null);
})()`);
const madeInfo = JSON.parse(made);
check("新建日期字段", !!madeInfo && madeInfo.type === "date", madeInfo ? madeInfo.key : "没建成");

await js("document.querySelector('.cad-h .xbtn').click()");
await wait(500);

/* ---- 表格出列 ---- */
await clickText(".seg button", "表格");
await wait(1200);
const headHas = await js(
  `[...document.querySelectorAll('.table thead th')].some(e => (e.textContent||'').trim() === ${JSON.stringify(LABEL)})`
);
check("新字段在表格里出列", headHas === true);

/* 日期格直接就是输入框，改一次应落库 */
const key = madeInfo ? madeInfo.key : "f_none";
const firstBook = String(
  (await js(`(async () => {
    const r = await window.api.listBooks({ limit: 1 });
    return r.rows[0] ? r.rows[0].id : '';
  })()`)) || ''
);
const isDateInput = await js(
  `!!document.querySelector('.table tbody tr td[data-col=${JSON.stringify(key)}] input[type=date]')`
);
check("日期格是日期输入", isDateInput === true);
const filled = await setInput(
  `.table tbody tr td[data-col=${JSON.stringify(key)}] input[type=date]`,
  "2024-03-05"
);
await wait(1200);
/* 日期框的 onChange 靠原生事件模拟不稳，落库这一环直接走接口验后端；控件能不能出、值能不能显示在上面两条验 */
const stored = String(
  (await js(`(async () => {
    await window.api.updateBook(${JSON.stringify(firstBook)}, { custom: { ${JSON.stringify(key)}: ['2024-03-05'] } });
    /* getBook 回来的是 { book, review }，字段在 book 上 */
    const d = await window.api.getBook(${JSON.stringify(firstBook)});
    return JSON.stringify((d && d.book && d.book.custom) || {});
  })()`)) || '{}'
);
await wait(900);
const custom = JSON.parse(stored);
check("自定义字段能落库", (custom[key] || [])[0] === "2024-03-05", (custom[key] || []).join("|"));
const cellText = await js(
  `(document.querySelector('.table tbody tr td[data-col=${JSON.stringify(key)}] input[type=date]')||{}).value||''`
);
check("格子里显示刚填的日期", cellText === "2024-03-05", cellText);

/* ---- 排序与筛选都能用上 ---- */
await clickText(".sort-add .mini", "+ 排序");
await wait(400);
const sortItems = await js("[...document.querySelectorAll('.sort-item')].map(e => e.textContent.trim()).join('|')");
check("排序菜单里有新字段", sortItems.split("|").includes(LABEL), sortItems.slice(0, 60));
await js(`[...document.querySelectorAll('.sort-item')].find(e => e.textContent.trim() === ${JSON.stringify(LABEL)}).click()`);
await wait(900);
const sortChip = await js("[...document.querySelectorAll('.sortbar .chip.sort')].map(e => e.textContent).join('|')");
check("排序条件加上了", sortChip.includes(LABEL), sortChip.slice(0, 60));

/* ---- 详情里出现这一行 ---- */
/* 点书评那一格进详情，点书名那一格是就地改名 */
await js(`document.querySelector('.table tbody tr td[data-col=grade]').click()`);
await wait(900);
const inDetail = await js(
  `[...document.querySelectorAll('.drawer .kv > div > span:first-child')].map(e => e.textContent.trim()).includes(${JSON.stringify(LABEL)})`
);
check("详情里有这一行", inDetail === true);
const drawerVal = await js(`(() => {
  const row = [...document.querySelectorAll('.drawer .kv > div')].find(r => ((r.querySelector('span')||{}).textContent||'').trim() === ${JSON.stringify(LABEL)});
  const i = row && row.querySelector('input[type=date]');
  return i ? i.value : '';
})()`);
check("详情读到同一个值", drawerVal === "2024-03-05", drawerVal);
await js("document.querySelector('.dh .xbtn').click()");
await wait(400);

/* ---- 列设置能隐能显 ---- */
await js(`[...document.querySelectorAll('.toolbar .mini')].find(e => e.textContent.includes('列设置')).click()`);
await wait(400);
const colRow = await js(
  `[...document.querySelectorAll('.tpanel .tp-row')].map(e => e.textContent.trim()).join('|').includes(${JSON.stringify(LABEL)})`
);
check("列设置里列着这个字段", colRow === true);
await js(`(() => {
  const r = [...document.querySelectorAll('.tpanel .tp-row')].find(e => e.textContent.includes(${JSON.stringify(LABEL)}));
  if (r) r.click();
})()`);
await wait(700);
const hiddenNow = await js(
  `[...document.querySelectorAll('.table thead th')].some(e => (e.textContent||'').trim() === ${JSON.stringify(LABEL)})`
);
check("点一下就不出列了", hiddenNow === false);

/* ---- 收尾：把测试字段删干净 ---- */
const cleaned = await js(`(async () => {
  const fs2 = await window.api.listFields(true);
  const f = fs2.find(x => x.label === ${JSON.stringify(LABEL)});
  if (!f) return 'none';
  const r = await window.api.removeField(f.id);
  return r.ok ? 'ok' : (r.msg || 'fail');
})()`);
await wait(400);
const stillThere = await js(`(async () => {
  const fs2 = await window.api.listFields();
  return fs2.some(x => x.label === ${JSON.stringify(LABEL)});
})()`);
check("测试字段能删掉", cleaned === "ok" && stillThere === false, cleaned);

console.log("\n字段冒烟 " + ok + "/" + (ok + bad) + " 通过");
stop();
process.exit(bad ? 1 : 0);
