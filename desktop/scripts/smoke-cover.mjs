/*
 * 只跑封面识别这一块的冒烟。改封面相关的东西时用它。
 * 自己起实例、用书库副本、网络走假数据（BOOKLIB_FAKE_COVER=1），不碰豆瓣，跑完自动收掉。
 * 用法：node scripts/smoke-cover.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.BOOKLIB_SRC || path.join(root, "我的书库");
const lib = path.join(root, "data", "smoke_cover");
const userData = path.join(root, "data", "_smoke_cover_user");
const port = Number(process.env.CDP_PORT || 9338);

/* 这台机器上的 node 一调 fs.cpSync 就直接退，只能自己走一遍 */
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
/* 假数据 + 不等待，否则 65 本按一点五秒歇一遍要跑两分钟 */
env.BOOKLIB_FAKE_COVER = "1";
env.BOOKLIB_COVER_GAP = "0";

console.log("起一个只跑封面的实例…");
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

/* ---- 接口这一层先过一遍 ---- */
const apiSearch = JSON.parse(
  String(
    (await js(`(async () => {
      const r = await window.api.searchCovers("测试之书");
      return JSON.stringify({ ok: r.ok, n: r.candidates.length, first: r.candidates[0] || null });
    })()`)) || "{}"
  )
);
check("搜接口返回候选", apiSearch.ok && apiSearch.n > 0, apiSearch.n + " 条");
check("候选带书名与大图", !!apiSearch.first && !!apiSearch.first.title && /\/l\/public\//.test(apiSearch.first.image || ""));

const thumb = String((await js(`(async () => (await window.api.coverThumb(${JSON.stringify(apiSearch.first.image)})) || "")()`)) || "");
check("缩略图能转成 data URL", thumb.startsWith("data:image/"), thumb.slice(0, 22));

const isbnSearch = JSON.parse(
  String(
    (await js(`(async () => {
      const r = await window.api.searchCovers("9787000000001");
      return JSON.stringify({ n: r.candidates.length, id: (r.candidates[0] || {}).id || "" });
    })()`)) || "{}"
  )
);
check("ISBN 也搜得到", isbnSearch.n === 1 && !!isbnSearch.id, isbnSearch.id);

/* ---- 详情里的搜封面 ---- */
await js("document.querySelectorAll('.card')[0].click()");
await wait(900);
const drawerOpen = await js("!!document.querySelector('.drawer.on')");
check("详情抽屉打开了", drawerOpen === true);

const hasBtn = await js("[...document.querySelectorAll('.dcacts .mini')].some(e => e.textContent.trim() === '搜封面')");
check("封面区有搜封面按钮", hasBtn === true);

/* 网格第一张卡对应的就是列表第一本，拿它的 id 记前后对照 */
const target = JSON.parse(
  String(
    (await js(`(async () => {
      const r = await window.api.listBooks({ limit: 1 });
      const b = r.rows[0];
      return JSON.stringify(b ? { id: b.id, cover: b.cover, title: b.title } : {});
    })()`)) || "{}"
  )
);
check("拿到封面区那本书", !!target.id, target.title || "");

await clickText(".dcacts .mini", "搜封面");
await wait(1600);
const cards = await js("document.querySelectorAll('.csrch .ccard').length");
check("弹层里铺出候选卡", cards > 0, cards + " 张");

await js("document.querySelectorAll('.csrch .ccard')[0].click()");
await wait(2400);
const stillOpen = await js("!!document.querySelector('.csrch')");
check("选完自动关弹层", stillOpen === false);

const after = JSON.parse(
  String(
    (await js(`(async () => {
      const d = await window.api.getBook(${JSON.stringify(target.id)});
      /* 走 IPC 时 getBook 回来是 { book, review }，字段在 book 上 */
      return JSON.stringify({ cover: d && d.book ? d.book.cover : "" });
    })()`)) || "{}"
  )
);
check("封面写进了库", !!after.cover && after.cover !== target.cover, after.cover);
const hasImg = await js("!!document.querySelector('.drawer.on .dc')");
check("详情里换上了新图", hasImg === true);

/* 撤销要退得回原来那张，换封面那条老路没有因为走网络而变样 */
await clickText(".dcacts .mini", "撤销");
await wait(1800);
const undone = JSON.parse(
  String(
    (await js(`(async () => {
      const d = await window.api.getBook(${JSON.stringify(target.id)});
      return JSON.stringify({ cover: d && d.book ? d.book.cover : "" });
    })()`)) || "{}"
  )
);
check("撤销退回了原来那张", undone.cover === target.cover, undone.cover + " / 原 " + target.cover);

/* ---- 搜不到时回落站内搜索 ----
   假数据里查询词以「台版」开头时 suggest 给空数组，只有站内搜索页有结果，
   跟真站上搜繁体、台版书的情形一样。这条就是那次搜不出书的回归。 */
await clickText(".dcacts .mini", "搜封面");
await wait(1200);
await js(`(() => {
  const inp = document.querySelector('.csrch-q input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '台版测试书名');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await wait(2400);
const fell = await js("document.querySelectorAll('.csrch .ccard').length");
check("suggest 空了走站内搜索也有候选", typeof fell === "number" && fell > 0, fell + " 张");
const fellName = await js("(document.querySelector('.csrch .ccard .ccard-name')||{}).textContent||''");
check("回落候选的书名对得上", String(fellName).includes("台版测试书名"), String(fellName));
const fellImg = await js("!!document.querySelector('.csrch .ccard img')");
check("回落候选的缩略图也取到了", fellImg === true);
await js("(() => { const b = document.querySelector('.csrch .xbtn'); if (b) b.click(); })()");
await wait(500);

/* ---- 批量 ---- */
await js("document.querySelector('.drawer.on .xbtn').click()");
await wait(500);
await clickText(".topbar .mini", "更多 ▾");
await wait(400);
const hasBatch = await clickText(".ctx-i", "批量找封面…");
await wait(800);
const batchTitle = await js("(document.querySelector('.cbatch .cad-h h3')||{}).textContent||''");
check("更多菜单里能打开批量", hasBatch && batchTitle === "批量找封面", batchTitle);

const started = await clickText(".cbatch .cb-top .mini", "开始识别");
check("开始按钮点得动", started === true);

/* 每本之间不等，但 65 本仍要一会儿，轮询到停为止 */
let st = null;
for (let i = 0; i < 200; i++) {
  const raw = await js("(async () => JSON.stringify(await window.api.coverBatchState()))()");
  st = JSON.parse(String(raw || "{}"));
  if (st && !st.running) break;
  await wait(300);
}
check("批量跑完了", !!st && st.running === false, st ? st.stopReason || "" : "没起来");
check("确实配上了封面", !!st && st.applied > 0, st ? st.applied + " 本" : "");
check("处理数等于总数", !!st && st.done === st.total, st ? st.done + " / " + st.total : "");

const queueN = await js("document.querySelectorAll('.cbatch .cb-i').length");
check("队列面板画得出来", typeof queueN === "number", queueN + " 条");
check("弱匹配进了队列", queueN > 0, queueN + " 条");

/* 队列里那条带着候选，接受后应当出队并落封面 */
const q1 = JSON.parse(
  String(
    (await js(`(async () => {
      const q = await window.api.coverQueue();
      const it = q[0];
      return JSON.stringify(it ? { id: it.bookId, title: it.title, score: it.score } : {});
    })()`)) || "{}"
  )
);
check("队列条目带书名与分数", !!q1.id && typeof q1.score === "number", (q1.title || "") + " " + q1.score + " 分");

const accepted = JSON.parse(
  String(
    (await js(`(async () => JSON.stringify(await window.api.acceptQueuedCover(${JSON.stringify(q1.id)}, false)))()`)) || "{}"
  )
);
check("接受队列里那一条", accepted.ok === true, accepted.cover || accepted.msg || "");

const left = JSON.parse(
  String((await js(`(async () => JSON.stringify(await window.api.coverQueue()))()`)) || "[]")
);
check("接受后出了队", !left.some((x) => x.bookId === q1.id), "还剩 " + left.length + " 条");

/* 剩下的跳过，跳完队列要空 */
await js(`(async () => {
  const q = await window.api.coverQueue();
  for (const it of q) await window.api.skipQueuedCover(it.bookId);
})()`);
const afterSkip = JSON.parse(String((await js(`(async () => JSON.stringify(await window.api.coverQueue()))()`)) || "[]"));
check("跳过之后队列清空", afterSkip.length === 0, afterSkip.length + " 条");

console.log("\n封面冒烟 " + ok + "/" + (ok + bad) + " 通过");
stop();
process.exit(bad ? 1 : 0);
