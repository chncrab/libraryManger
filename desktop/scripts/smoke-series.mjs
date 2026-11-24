/*
 * 只跑系列改名这一块的冒烟。改系列名相关代码时用它。
 * 自己起一个 electron 实例，用书库副本，跑完把改过的名字改回去。
 * 用法：node scripts/smoke-series.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.BOOKLIB_SRC || path.join(root, "我的书库");
const lib = path.join(root, "data", "smoke_series");
const userData = path.join(root, "data", "_smoke_series_user");
const port = Number(process.env.CDP_PORT || 9338);

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

/* 端口被别的实例占着时，后面连上的是那一个，检查的也是它那份书库，
   跑出来的结果全是别人的。先挡一道 */
try {
  const probe = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (probe.ok) {
    console.log("端口 " + port + " 已被别的实例占着，先关掉它再跑");
    process.exit(1);
  }
} catch {
  /* 没起来就是干净的 */
}

console.log("起一个只跑系列改名的实例…");
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
/* 系列集合与书架现在都在书库标签栏里，顶栏 .seg 只剩书评/阅读 */
const clickTab = (name) =>
  js(
    `(() => {
      const tab = [...document.querySelectorAll('.viewtabs .vt-tab')]
        .find(t => ((t.querySelector('.vt-name') || {}).textContent || '').trim() === ${JSON.stringify(name)});
      if (!tab) return false;
      tab.click();
      return true;
    })()`
  );
/* 受控输入框要靠原生 setter 赋值，直接改 value 不会触发 React 的 onChange */
const setInput = (sel, text, nth = 0) =>
  js(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
const key = async (k) => {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 13 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 13 });
  await wait(350);
};

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

/* ---- 进系列集合，开第一张卡 ---- */
await clickTab("系列小说");
await wait(1200);
const cardText = String((await js(`(document.querySelector('.scard')||{}).textContent||''`)) || "");
check("系列集合有卡", !!cardText, cardText.slice(0, 24));
await js(`document.querySelector('.scard').click()`);
await wait(900);
const opened = await js(`!!document.querySelector('.drawer.on .dh h2')`);
check("系列面板打开", opened === true);

/* 找出正在看的是哪个系列，后面靠 id 核对库里的值 */
const pick = (await js(`(async () => {
  const list = await window.api.seriesList('小说');
  const hit = list.find(s => ${JSON.stringify(cardText)}.includes(s.label));
  return hit ? JSON.stringify({ id: hit.id, name: hit.name, zhName: hit.zhName, label: hit.label }) : '';
})()`)) || "";
if (!pick) {
  console.log("认不出卡片对应哪个系列，后面没法比");
  stop();
  process.exit(1);
}
const s = JSON.parse(pick);
const other = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const o = list.find(x => x.id !== ${s.id} && x.name !== ${JSON.stringify(s.name)} && x.zhName && x.zhName !== ${JSON.stringify(
      s.zhName
    )});
    return o ? JSON.stringify({ id: o.id, name: o.name, zhName: o.zhName }) : 'null';
  })()`)) || "null"
);
console.log("  样本 " + s.label + "（" + s.name + "）");

/* ---- 编辑态 ---- */
await clickText(".dh .mini", "改名");
await wait(400);
const inputs = await js(`document.querySelectorAll('.sedit input').length`);
check("点改名出两个输入框", inputs === 2, String(inputs));

const zhNew = s.zhName + "冒烟";
await setInput(".sedit input", zhNew, 0);
await wait(250);
const typed = await js(`document.querySelectorAll('.sedit input')[0].value`);
check("译名框能写", typed === zhNew, typed);

/* ---- 取消不写库 ---- */
await clickText(".sedit-acts .mini", "取消");
await wait(600);
const afterCancel = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const x = list.find(v => v.id === ${s.id});
    return JSON.stringify({ zhName: x.zhName, name: x.name });
  })()`)) || "{}"
);
check("取消没写库", afterCancel.zhName === s.zhName, afterCancel.zhName);
check("取消后编辑态收掉", (await js(`!document.querySelector('.sedit')`)) === true);

/* ---- 保存译名 ---- */
await clickText(".dh .mini", "改名");
await wait(300);
await setInput(".sedit input", zhNew, 0);
await wait(200);
await clickText(".sedit-acts .mini", "保存");
await wait(1200);
const saved = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const x = list.find(v => v.id === ${s.id});
    return JSON.stringify({ zhName: x.zhName, name: x.name });
  })()`)) || "{}"
);
check("译名存进库了", saved.zhName === zhNew, saved.zhName);
check("原名没被连带改", saved.name === s.name, saved.name);
const headNow = String((await js(`(document.querySelector('.dh h2')||{}).textContent||''`)) || "");
check("标题跟着变了", headNow.includes(zhNew), headNow.trim().slice(0, 30));
check("保存后收起编辑态", (await js(`!document.querySelector('.sedit')`)) === true);

/* ---- 译名撞名只提示不拦 ---- */
await clickText(".dh .mini", "改名");
await wait(300);
await setInput(".sedit input", other.zhName, 0);
await wait(200);
await clickText(".sedit-acts .mini", "保存");
await wait(1200);
const noteText = String((await js(`(document.querySelector('.snote')||{}).textContent||''`)) || "");
const clashSaved = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const x = list.find(v => v.id === ${s.id});
    return JSON.stringify({ zhName: x.zhName });
  })()`)) || "{}"
);
check("译名撞名照样存进去", clashSaved.zhName === other.zhName, clashSaved.zhName);
check("撞名给了一句提示", noteText.length > 0, noteText);

/* ---- 原名撞键被拒 ---- */
await clickText(".dh .mini", "改名");
await wait(300);
await setInput(".sedit input", other.name, 1);
await wait(200);
await clickText(".sedit-acts .mini", "保存");
await wait(1200);
const errText = String((await js(`(document.querySelector('.sedit-err')||{}).textContent||''`)) || "");
const nameKept = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const x = list.find(v => v.id === ${s.id});
    return JSON.stringify({ name: x.name });
  })()`)) || "{}"
);
check("原名撞键被拒并说明理由", errText.length > 0, errText.slice(0, 40));
check("被拒后库里原名没变", nameKept.name === s.name, nameKept.name);
check("被拒后还留在编辑态", (await js(`!!document.querySelector('.sedit')`)) === true);

/* ---- Esc 两级 ---- */
await key("Escape");
check("Esc 先退出编辑", (await js(`!document.querySelector('.sedit') && !!document.querySelector('.drawer.on')`)) === true);
await key("Escape");
check("再按 Esc 关面板", (await js(`!document.querySelector('.drawer.on')`)) === true);

/* ---- 收尾：两个名字都改回原值 ---- */
const restored = JSON.parse(
  (await js(`(async () => {
    const r = await window.api.seriesUpdate(${s.id}, { name: ${JSON.stringify(s.name)}, zhName: ${JSON.stringify(s.zhName)} });
    return JSON.stringify({ ok: r.ok, msg: r.msg || '' });
  })()`)) || "{}"
);
await wait(600);
const backNow = JSON.parse(
  (await js(`(async () => {
    const list = await window.api.seriesList('小说');
    const x = list.find(v => v.id === ${s.id});
    return JSON.stringify({ name: x.name, zhName: x.zhName });
  })()`)) || "{}"
);
check("名字改回原值", restored.ok === true && backNow.zhName === s.zhName && backNow.name === s.name, restored.msg || "ok");

console.log("\n系列冒烟 " + ok + "/" + (ok + bad) + " 通过");
stop();
process.exit(bad ? 1 : 0);
