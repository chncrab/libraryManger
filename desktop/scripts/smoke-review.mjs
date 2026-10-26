/*
 * 只跑书评这一块的冒烟。改书评相关的东西时用它，不必把书架、表格、分类那一长串都过一遍。
 * 自己起一个 electron 实例，用书库副本，跑完自动收掉。
 * 用法：node scripts/smoke-review.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.BOOKLIB_SRC || path.join(root, "我的书库");
const lib = path.join(root, "data", "smoke_review");
const userData = path.join(root, "data", "_smoke_review_user");
const port = Number(process.env.CDP_PORT || 9336);

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
const reviewDir = path.join(lib, "reviews");

const electron = require("electron");
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
env.BOOKLIB_ROOT = lib;

console.log("起一个只跑书评的实例…");
const child = spawn(electron, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + port, "--disable-gpu", "--in-process-gpu"], {
  cwd: root,
  env,
  stdio: "ignore"
});

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
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`);

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
await wait(2500);

/* ---- 书评视图 ---- */
await clickText(".seg button", "书评");
await wait(1500);
const rows = await js("document.querySelectorAll('.rvs-list .rvi').length");
const dbCount = await js(
  "window.api.reviews().then((rs) => rs.length)"
);
check("左栏条数与库里一致", rows === dbCount && rows > 0, "左栏 " + rows + "，库里 " + dbCount);

/* 空书评也会入库，按时间排第一的可能是空的，先挑一篇有字的 */
await js(`(() => {
  const it = [...document.querySelectorAll('.rvs-list .rvi')].find((e) => {
    const m = e.querySelector('.rvi-m');
    return m && !/^0 字/.test(m.textContent.trim());
  });
  if (it) it.click();
})()`);
await wait(500);
const body = await js("(document.querySelector('.rvm-body .md')||{}).textContent||''");
check("中间显示书评正文", body.length > 0, body.trim().slice(0, 16));

/* ---- 首部字段 ---- */
const front = await js(`(async () => {
  const rs = await window.api.reviews();
  const r = rs.find((x) => x.kind === 'book' && (x.md || '').trim());
  if (!r) return null;
  const name = await window.api.reviewFileName(r.kind, r.id);
  return JSON.stringify({ name, title: r.title, id: r.id });
})()`);
const frontInfo = front ? JSON.parse(front) : null;
let frontText = "";
if (frontInfo) {
  const p = path.join(reviewDir, frontInfo.name);
  frontText = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
check(
  "md 开头写着阅读时间、评分、书籍",
  !!frontInfo &&
    frontText.startsWith("---\n") &&
    /^书籍: 《.+》$/m.test(frontText) &&
    /^阅读时间:/m.test(frontText) &&
    /^评分:/m.test(frontText),
  frontInfo ? frontInfo.name : "没有带正文的书评"
);
check("首部后面才是正文，空一行", frontText.includes("\n---\n\n") && !frontText.slice(0, frontText.indexOf("\n---\n\n")).includes("#"), "长度 " + frontText.length);
check("正文没有把首部混进去", !/^书籍: /m.test(frontText.split("\n---\n\n")[1] || ""));

/* ---- 新建、编辑、保存 ---- */
const before = await js("document.querySelectorAll('.rvs-list .rvi').length");
await clickText(".rvs-h .mini", "新建");
await wait(1200);
const afterNew = await js("document.querySelectorAll('.rvs-list .rvi').length");
check("新建草稿", afterNew === before + 1, before + " → " + afterNew);
/* 新建草稿一般会直接进编辑，没进就点一下「编辑」；已经在编辑时那个按钮写的是「预览」 */
if (!(await js("!!document.querySelector('.rve')"))) {
  await js(`(() => { const b = [...document.querySelectorAll('.rvm-h .mini')].find(x => x.textContent === '编辑'); if (b) b.click(); })()`);
  await wait(600);
}
const hasSave = await js(`[...document.querySelectorAll('.rvm-h .mini')].some((b) => b.textContent === '保存')`);
check("编辑时右边有保存按钮", hasSave === true);
await js(`(() => {
  const el = document.querySelector('.rve');
  if (!el) return;
  el.focus();
  el.innerHTML = '<p>只跑书评的冒烟正文。</p>';
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(1600);
const statTxt = await js("(document.querySelector('.rvm-stat')||{}).textContent||''");
check("正文自动落库", statTxt.includes("已保存"), statTxt.slice(0, 26));
await js(`[...document.querySelectorAll('.rvm-h .mini')].find((b) => b.textContent === '保存').click()`);
await wait(900);
const statTxt2 = await js("(document.querySelector('.rvm-stat')||{}).textContent||''");
check("点保存立刻写回", statTxt2.includes("已保存"), statTxt2.slice(0, 26));

/* ---- 删除草稿 ---- */
await js(`(() => {
  const it = document.querySelector('.rvs-list .rvi');
  if (it) it.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
})()`);
await wait(400);
await js(`[...document.querySelectorAll('.ctx-i')].find((e) => e.textContent === '删除书评').click()`);
await wait(400);
const hasCfm = await js("!!document.querySelector('.cfm')");
await js("document.querySelector('.cfm-b .mini.danger').click()");
await wait(1200);
const afterDel = await js("document.querySelectorAll('.rvs-list .rvi').length");
check("删掉草稿回到原数", hasCfm && afterDel === before, before + " → " + afterDel);

/* ---- 动作条 ---- */
const acts = await js("(document.querySelector('.rvs-acts')||{}).textContent||''");
check("有刷新与重命名", acts.includes("刷新") && acts.includes("重命名"), acts);
await js(`[...document.querySelectorAll('.rvs-acts .mini')].find((b) => b.textContent.includes('重命名')).click()`);
await wait(1600);
const renToast = await js("(document.querySelector('.toast')||{}).textContent||''");
check("重命名给结果", renToast.includes("重命名"), renToast);

/* ---- 空 md 也要收 ---- */
const emptyName = "空占位-只跑书评.md";
fs.writeFileSync(path.join(reviewDir, emptyName), "", "utf8");
await js(`[...document.querySelectorAll('.rvs-acts .mini')].find((b) => b.textContent.includes('刷新')).click()`);
await wait(2400);
const seenEmpty = await js(
  `[...document.querySelectorAll('.rvs-list .rvi')].some((e) => (e.textContent || '').includes('空占位'))`
);
check("空的 md 也进库并显示", seenEmpty === true, emptyName);

console.log(`\n书评冒烟 ${ok}/${ok + bad} 通过`);
ws.close();
stop();
await wait(600);
process.exit(bad ? 1 : 0);
