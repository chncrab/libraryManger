/*
 * 只跑阅读时间线这一屏的冒烟。动时间线、阅读起止、阅读视图时用它。
 * 自己起一个 electron 实例，用书库副本，跑完收掉。
 *
 * 分两段，改到哪一段就只跑哪一段：
 *   npm run smoke:read -- v     竖排
 *   npm run smoke:read -- h     横排
 *   npm run smoke:read          两段都跑
 * 默认只打失败的断言与段落汇总，要看逐条加 -v：
 *   npm run smoke:read -- -v v
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.BOOKLIB_SRC || path.join(root, "我的书库");
const lib = path.join(root, "data", "smoke_read");
const userData = path.join(root, "data", "_smoke_read_user");
const port = Number(process.env.CDP_PORT || 9339);

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
console.log("准备副本…");
rmrf(lib);
rmrf(userData);
copyDir(src, lib);
console.log("副本好了");

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

console.log("起一个只跑阅读时间线的实例…");
const child = spawn(
  electron,
  /* 这台机器上窗口被挡就冻页面：CDP 的 evaluate 发出去不回包，整个脚本干等。
     关掉遮挡退化、关掉后台节流，再把页面钉在 active，才不用靠窗口在最前面 */
  [
    ".",
    "--user-data-dir=" + userData,
    "--remote-debugging-port=" + port,
    "--disable-gpu",
    "--in-process-gpu",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling"
  ],
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
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`);
const keyDown = async (k, ctrl) => {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code: "Digit" + k,
    windowsVirtualKeyCode: 48 + Number(k),
    modifiers: ctrl ? 2 : 0
  });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: "Digit" + k, windowsVirtualKeyCode: 48 + Number(k), modifiers: ctrl ? 2 : 0 });
  await wait(400);
};

let ok = 0;
let bad = 0;
/* 改到哪一块就只验哪一块：整条链两段跑完要几分钟，回回跑全程没必要。
     node scripts/smoke-read.mjs v      只验竖排
     node scripts/smoke-read.mjs h      只验横排
     node scripts/smoke-read.mjs        两段都跑
   成功的断言不再逐条打，只报段落汇总；要看全量加 -v */
const ARGS = process.argv.slice(2);
const verbose = ARGS.includes("-v");
const ONLY = (ARGS.find((a) => !a.startsWith("-")) || "").split(",").filter(Boolean);
const want = (seg) => !ONLY.length || ONLY.includes("all") || ONLY.includes(seg);
/** 当下验的是哪一段，只用来归拢失败与汇总 */
let seg = "前置";
const segStat = new Map();
/* 望着某个值到目标再断言：过渡、重挂、量测各有各的节拍，死等一个固定毫秒数不牢 */
const waitFor = async (fn, good, tries = 14, gap = 120) => {
  let v = await fn();
  for (let i = 0; i < tries && !good(v); i++) {
    await wait(gap);
    v = await fn();
  }
  return v;
};
const check = (name, cond, extra = "") => {
  const s = segStat.get(seg) || { ok: 0, bad: 0 };
  if (cond) {
    ok++;
    s.ok++;
    if (verbose) console.log("PASS " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    s.bad++;
    console.log("FAIL " + name + (extra ? "  " + extra : ""));
  }
  segStat.set(seg, s);
};

/* 等实例起来，连上调试端口 */
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await wait(500);
}
if (!ws) {
  console.log("实例没起来，跳过");
  process.exit(0);
}
await new Promise((r) => ws.addEventListener("open", r));
/* 回包按 id 分发给上面对应的那个 Promise，这一步漏了会一直等 */
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = msg.id ? pending.get(msg.id) : null;
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});
await call("Runtime.enable");
/* 窗口被别的窗口压住时页面会进 frozen，evaluate 就永远不回包 */
await call("Emulation.setFocusEmulationEnabled", { enabled: true });
await call("Page.enable");
await call("Page.setWebLifecycleState", { state: "active" });

/* 首屏数据落地 */
for (let i = 0; i < 40; i++) {
  const n = await js("document.querySelectorAll('.card').length");
  if (n > 0) break;
  await wait(300);
}

const timeline = JSON.parse(await js("(async () => JSON.stringify(await window.api.readTimeline('全部')))()"));
const stats = JSON.parse(await js("(async () => JSON.stringify(await window.api.readStats('全部')))()"));
check("样本库有阅读时间线可取", timeline.length > 0 && stats.total === timeline.length, timeline.length + " 条");
const spans = timeline.filter((e) => e.span).length;

/* 一屏只装得下一个月左右（所有年所有月一样宽，格宽按最满的那个月定），最近的月份
   常只有一两本。要验金线、日期、两轨那些，先算清轴上的坐标，把视口挪到读得最多的
   那个月 —— 那里一屏铺得满，断言才有东西可验。算的是同一份换算，与服务层无关 */
const R = require("../dist-electron/shared/readScale.js");
const nowD = new Date();
const todayKey = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, "0")}-${String(nowD.getDate()).padStart(2, "0")}`;
const midDays = timeline.map((e) => R.midDay(e));
const midOf = new Map(timeline.map((e) => [e.id, R.midDay(e)]));
/* 界面那边轴一直铺到今天，这里传同一个尽头，坐标才对得上 */
const scCalc = R.buildScale(midDays, { until: R.dayNum(todayKey) });
const perMonth = new Map();
for (const d of midDays) {
  const k = R.dayStr(d).slice(0, 7);
  perMonth.set(k, (perMonth.get(k) || 0) + 1);
}
const busiest = [...perMonth].sort((a, b) => b[1] - a[1])[0];
const busyX = scCalc.xOf(R.dayNum(busiest[0] + "-01"));
const janKey = [...perMonth.keys()].filter((k) => k.endsWith("-01")).sort()[0];
const janX = janKey ? scCalc.xOf(R.dayNum(janKey)) : busyX;
const calcBands = R.yearBands(timeline.map((e) => e.anchor), scCalc);
const toDay = (x) => js(`(() => { const s = document.querySelector('.scroll'); s.scrollTop = ${Math.round(x)}; return Math.round(s.scrollTop); })()`);

/* 条铺的是一段固定的世界坐标（默认就是最早那本那年到今年），一个世界坐标落在条上的
   哪一分位跟视野无关，所以这把尺子在拖动前后始终是同一把 */
const navR = R.yearRange(scCalc, Number(R.dayStr(scCalc.first).slice(0, 4)), nowD.getFullYear());
const barP = (x, total) => (x - navR.a) / Math.max(1, total);
const barX = (p, total) => navR.a + p * Math.max(1, total);
/* 条上那个滑块：左沿与宽，都是整条轴的百分比。滑块中心对应的世界坐标就是
   视野中心 —— 拖到哪儿、内容到哪儿，验落点全看它 */
const thumbOf = async (sel, vert = false) =>
  JSON.parse(
    await js(
      `JSON.stringify((() => { const t = document.querySelector('${sel} .rd-nav-thumb'); if (!t) return null;` +
        ` return { l: parseFloat(t.style.${vert ? "top" : "left"}) || 0,` +
        ` w: parseFloat(t.style.${vert ? "height" : "width"}) || 0 }; })())`
    )
  );
const thumbCenter = (th, total) => ((th.l + th.w / 2) / 100) * total;

/* 缩放是不是滑过去的，外部轮询测不出来 —— CDP 一次往返就一百多毫秒，
   等打到页面时动画已经走完七成。改成页面里每帧记一笔，跑完读回整条曲线 */
const sample = (expr) =>
  js(`(() => { window.__s = []; const t0 = performance.now();
    const tick = () => { window.__s.push(${expr}); if (performance.now() - t0 < 800) requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return 1; })()`);
const rampOk = (arr, eps) => {
  if (!Array.isArray(arr) || arr.length < 6) return "样本太少 " + (arr || []).length;
  const lo = arr[0];
  const hi = arr[arr.length - 1];
  const mid = arr.filter((v) => v > lo + eps && v < hi - eps).length;
  const up = arr.every((v, i) => i === 0 || v >= arr[i - 1] - 1e-6);
  if (mid < 3) return "中间只有 " + mid + " 帧";
  if (!up) return "不是一路往上";
  return true;
};

/* 进阅读视图 */
check("视图段里有一档「阅读」", await clickText(".seg button", "阅读"));
await wait(1400);
await clickText(".rd-switch button", "竖排");
await wait(1200);
check("进来之后停在竖排这一屏", (await js("document.querySelectorAll('.rv-item').length")) > 0);
/* 挪到读得最多的那个月，一屏才铺得满 */
await toDay(busyX - 60);
await wait(900);

/* 公共：两段都要用的年份统计、导航条读数与离线算的那份书线位置，谁先跑谁先建好 */
/* 右边那条总览：条上每本书一根金线，落在它在轴上的位置；年界线一年一道。
   年份按钮那一排撤了，改成拖着这条跨年，拖的时候浮出最近那本书的名字与日期 */
const yAll = [...new Set(timeline.map((e) => Number(String(e.anchor).slice(0, 4))))].filter((y) => y > 1900);
const yLo = Math.min(...yAll);
const yHi = Math.max(...yAll);
const bandN = yHi - yLo + 1;
/* 界面上那条线的位置在 shared/readScale 里算，这里用同一份函数复算一遍来对 */
const calcMarks = R.navMarks(timeline, scCalc, navR);
const navBooks = async (sel) =>
  JSON.parse(
    await js(`JSON.stringify([...document.querySelectorAll('${sel} .rd-nav-book')].map((b) => ({
      id: b.dataset.id, p: parseFloat(b.dataset.p)
    })))`)
  );
const navLines = async (sel, vert = false) =>
  JSON.parse(
    await js(
      `JSON.stringify([...document.querySelectorAll('${sel} .rd-nav-line')].map((b) => parseFloat(b.style.${vert ? "top" : "left"})))`
    )
  );
/* 气泡里写的是「书名 · 月-日」，或者空档处的「哪一年 · 几本」 */
const bubOf = async (sel) =>
  JSON.parse(
    await js(`JSON.stringify((() => { const b = document.querySelector('${sel} .rd-nav-bub'); return b ? { t: b.textContent.trim(), k: b.dataset.kind || '' } : null; })())`)
  );
const titleOf = (t) => {
  const i = t.lastIndexOf(" · ");
  return i > 0 ? t.slice(0, i) : "";
};

/* ---- 竖排 ---- */
seg = "竖排";
console.log("[竖排]");
if (want("v")) {
const rows = JSON.parse(
  await js(`(() => {
    const out = [...document.querySelectorAll('.rv-item')].map((n) => {
      const r = n.getBoundingClientRect();
      const b = n.querySelector('.rv-run');
      const br = b ? b.getBoundingClientRect() : null;
      return {
        id: n.dataset.id,
        y: Math.round(parseFloat(n.style.top)),
        x: Math.round(parseFloat(n.style.left)),
        left: Math.round(r.left),
        right: Math.round(r.right),
        col: n.className.includes('col1') ? 1 : 0,
        t: (n.querySelector('.rv-t') || {}).textContent || '',
        a: (n.querySelector('.rv-a') || {}).textContent || '',
        m: (n.querySelector('.rv-m') || {}).textContent || '',
        cov: !!n.querySelector('.rv-cov img'),
        bar: b ? Math.round(parseFloat(b.style.height) || 0) : 0,
        barX: br ? Math.round(br.left + br.width / 2) : 0
      };
    });
    return JSON.stringify(out);
  })()`)
);
const axX = await js("(() => { const a = document.querySelector('.rv-axis'); const r = a.getBoundingClientRect(); return Math.round(r.left); })()");
const idsAll = new Set(timeline.map((e) => e.id));
check(
  "竖排只挂看得见的那几条，而且都在时间线里",
  rows.length >= 3 && rows.length < timeline.length && rows.every((r) => idsAll.has(r.id)),
  rows.length + " 条 / 共 " + timeline.length
);
check("每条都有书名", rows.every((r) => r.t.trim().length > 1));
check("每条都写着作者", rows.every((r) => r.a.trim().length > 0), rows.find((r) => !r.a.trim())?.t || "");
check("有条目的封面都出图了", rows.filter((r) => r.cov).length > rows.length * 0.9, rows.filter((r) => r.cov).length + " 张");
/* 轴在正中，条目左右交替：左半边整条落在轴左侧，右半边落在右侧 */
const viewMid = await js("(() => { const v = document.querySelector('.rv').getBoundingClientRect(); return Math.round(v.left + v.width / 2); })()");
check("轴线在容器正中", Math.abs(axX - viewMid) <= 2, "轴 " + axX + " / 中 " + viewMid);
check(
  "左半边整条在轴左边、右半边在轴右边",
  rows.every((r) => (r.col ? r.left >= axX : r.right <= axX)),
  rows.filter((r) => (r.col ? r.left < axX : r.right > axX)).length + " 条越界"
);
/* 挤的时候会把后面的条甩到另一边，所以只要求绝大多数是左右交替 */
const sameSide = rows.filter((r, i) => i > 0 && rows[i - 1].col === r.col).length;
check("左右交替，一边连着的只是少数", sameSide < rows.length * 0.12, sameSide + " / " + rows.length + " 条跟着上一条同边");
/* 金线压在轴线正中，从封面横一根细线过去落到轴上 */
const barOff = rows.map((r) => Math.abs(r.barX - axX));
check("轴上的金线压在轴上", Math.max(...barOff) <= 1.5, "最大偏 " + Math.max(...barOff) + "px");
check("每条都挂着一根探针与一段金线", (await js("document.querySelectorAll('.rv-probe').length")) === rows.length && (await js("document.querySelectorAll('.rv-run').length")) === rows.length);
/* 平时不画，鼠标停在书上才长出来 */
const litBars = () =>
  js("(() => [...document.querySelectorAll('.rv-run')].filter((b) => b.getBoundingClientRect().height > 2).length)()");
const litProbes = () =>
  js("(() => [...document.querySelectorAll('.rv-probe')].filter((b) => b.getBoundingClientRect().width > 30).length)()");
check("金线平时不画", (await litBars()) === 0, (await litBars()) + " 条亮着");
const hoverAt = JSON.parse(
  await js(`JSON.stringify((() => {
    const els = [...document.querySelectorAll('.rv-item')];
    /* 取一条确实露在视口里、而且这一点真能命中的，粘住的年份条会挡掉最上面几条 */
    const e = els.find((n) => {
      const r = n.getBoundingClientRect();
      if (r.top < 130 || r.bottom > innerHeight - 20) return false;
      const hit = document.elementFromPoint(Math.round(r.left + 22), Math.round(r.top + 30));
      return hit && hit.closest('.rv-item') === n;
    });
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + 22), y: Math.round(r.top + 30) };
  })())`)
);
if (hoverAt) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverAt.x, y: hoverAt.y, button: "none", buttons: 0 });
  /* 金线长出来有个 0.1s 的延迟再加 0.18s 的过渡，落到哪一帧不好猜，望着它亮起来 */
  const litV = await waitFor(litBars, (v) => v >= 1);
  check("鼠标停在书上，金线长出来", litV >= 1, litV + " 条亮着");
  const probeV = await waitFor(litProbes, (v) => v >= 1);
  check("先拉一根线横到轴上", probeV >= 1, probeV + " 根伸出去");
  const tipTxt = await js("((document.querySelector('.rd-tip') || {}).textContent || '')");
  check(
    "光标旁的浮层写着起止与用时",
    /起止/.test(tipTxt) && /用时/.test(tipTxt) && /\d{4}-\d{2}-\d{2}/.test(tipTxt),
    tipTxt.slice(0, 36)
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none", buttons: 0 });
  await wait(400);
  check("鼠标移开又收回去", (await litBars()) === 0, (await litBars()) + " 条还亮着");
  check("浮层也跟着收起", (await js("document.querySelectorAll('.rd-tip').length")) === 0);
}
/* 两列交错，隔列的上下可以挨得很近，所以按列看先后 */
const byCol = [0, 1].map((c) => rows.filter((r) => r.col === c));
check("每一列都从上到下按时间排", byCol.every((col) => col.every((r, i) => i === 0 || col[i - 1].y <= r.y)));
check("封面分左右两列", new Set(rows.map((r) => r.col)).size === 2 && rows.filter((r) => r.col === 1).length >= 1);
check("没有按年折叠那套", (await js("document.querySelectorAll('.rd-yh, .rd-group').length")) === 0);
const spanRow = rows.find((r) => r.bar > 66);
check("跨天那条长条比封面高", !!spanRow, spanRow ? spanRow.bar + "px" : "");
/* 起止与天数只在长条两头标着，正文里不再写一遍 */
check(
  "竖排正文不写起止与天数",
  rows.every((r) => !/→|共\s*\d+\s*天/.test(r.m)),
  rows.find((r) => /→|共\s*\d+\s*天/.test(r.m))?.m || ""
);
/* 两头标的是 月-日，起的那头在上、读完的那头在下，每一条都标两头 */
const dayTxt = JSON.parse(
  await js(
    "JSON.stringify({d:[...document.querySelectorAll('.rv-d0, .rv-d1')].map((n) => n.textContent.trim()),n:document.querySelectorAll('.rv-item').length})"
  )
);
const dayNums = dayTxt.d;
check(
  "竖排长条两头的日期写成 月-日",
  dayNums.length > 0 && dayNums.every((s) => /^\d{2}-\d{2}$/.test(s)),
  dayNums.slice(0, 6).join(" / ")
);
check("竖排每一条都标了起止两头", dayNums.length === dayTxt.n * 2, dayNums.length + " / " + dayTxt.n * 2);
/* 条的长度是实打实的天数：单天读完只剩一格，最长那条拉得很长 */
const oneDayIds = new Set(timeline.filter((e) => !e.span).map((e) => e.id));
const single = rows.filter((r) => oneDayIds.has(r.id));
const longRow = rows.slice().sort((a, b) => b.bar - a.bar)[0];
/* 一格就是这一天：金线长度要正好等于那天在轴上占的宽度。一天有几本由换算定，
   没有固定上限 —— 月宽按最满的那个月定，挤的那天可以铺到一百多像素 */
const dayErrV = single.map((r) => Math.abs(r.bar - scCalc.slopeAt(midOf.get(r.id))));
check(
  "当天读完的金线正好盖住那一格",
  single.length >= 1 && Math.max(...dayErrV) <= 1.5,
  single.length + " 条，最大差 " + Math.max(...dayErrV).toFixed(1) + "px（最长 " + Math.max(...single.map((r) => r.bar)) + "px）"
);
check("跨度最长的那条明显更长", !!longRow && longRow.bar > 60, longRow ? longRow.bar + "px" : "");
/* 长度是从日期换算里来的，跨天的条总比一格长。所有月份一样宽，格里的日子按当天
   本数摊开，所以这里只验方向，具体天数乘一格落在轴换算那头 */
const spanRows = rows.filter((r) => !oneDayIds.has(r.id));
check(
  "跨天的条都比一格长",
  spanRows.length > 0 && spanRows.every((r) => r.bar >= 4),
  "最短 " + Math.min(...spanRows.map((r) => r.bar)) + "px"
);
check("有评分的那几条带星", rows.some((r) => r.m.includes("★")), rows.filter((r) => r.m.includes("★")).length + " 条");
/* 一年只有年初那一道年线，一屏装一个多月，得挪到一月那一段才看得见 */
await toDay(janX - 40);
await wait(900);
const vYears = await js("document.querySelectorAll('.rv-tk.year').length");
check("竖轴挪到年初就有年刻度", vYears >= 1, vYears + " 个 · " + janKey);
/* 年线是一条横贯整屏的淡线，位置在一月那道线上；年份写在它头上、贴着左边框，
   后面跟一支朝下的箭头跨过线：「这道线之后的一年归它，往下走」 */
const vYearLook = JSON.parse(
  await js(`JSON.stringify((() => {
    const t = document.querySelector('.rv-tk.year');
    if (!t) return null;
    const c = getComputedStyle(t, '::before');
    const s = t.querySelector('span');
    const a = t.querySelector('.rv-yarw');
    const wrap = document.querySelector('.rv-scale').getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const sr = s ? s.getBoundingClientRect() : null;
    const ar = a ? a.getBoundingClientRect() : null;
    return {
      w: parseFloat(c.width),
      h: parseFloat(c.height),
      op: Number(c.opacity),
      wrapL: Math.round(wrap.left),
      wrapMid: Math.round((wrap.left + wrap.right) / 2),
      tick: Math.round(r.top),
      textL: sr ? Math.round(sr.left) : 0,
      textBottom: sr ? Math.round(sr.bottom) : 0,
      arW: ar ? Math.round(ar.width) : 0,
      arH: ar ? Math.round(ar.height) : 0,
      arTop: ar ? Math.round(ar.top) : 0,
      arBottom: ar ? Math.round(ar.bottom) : 0
    };
  })())`)
);
check(
  "年线横贯整屏，淡得只像背景",
  !!vYearLook && vYearLook.op <= 0.32 && vYearLook.w > 500 && vYearLook.h <= 1.5,
  vYearLook ? "线长 " + Math.round(vYearLook.w) + "px，粗 " + vYearLook.h + "，不透明度 " + vYearLook.op : "找不到年刻度"
);
check(
  "年份贴着左边框，不压在轴上",
  !!vYearLook && vYearLook.textL - vYearLook.wrapL <= 90 && vYearLook.wrapMid - vYearLook.textL > 100,
  vYearLook ? "字离左边框 " + (vYearLook.textL - vYearLook.wrapL) + "px，离轴 " + (vYearLook.wrapMid - vYearLook.textL) + "px" : ""
);
check(
  "年份写在年线上方，后面一支箭头朝下跨过线",
  !!vYearLook && vYearLook.textBottom <= vYearLook.tick + 8 && vYearLook.arW <= 4 && vYearLook.arH >= 10 && vYearLook.arTop < vYearLook.tick && vYearLook.arBottom > vYearLook.tick,
  vYearLook ? "字底差 " + (vYearLook.textBottom - vYearLook.tick) + "px，箭头 " + vYearLook.arW + "×" + vYearLook.arH + "，跨线 " + (vYearLook.arBottom - vYearLook.tick) + "px" : ""
);
await toDay(busyX - 60);
await wait(900);
const vMonths = await js("document.querySelectorAll('.rv-tk.month').length");
const vMonthLab = await js("document.querySelectorAll('.rv-tk.month span').length");
check("竖轴有月刻度，带着月名", vMonths >= 1 && vMonthLab >= 1, vMonths + " 个，带字 " + vMonthLab);
const vmStyle = JSON.parse(
  await js(
    "JSON.stringify((() => { const s = document.querySelector('.rv-tk.month span'); if (!s) return null; const c = getComputedStyle(s); return { fs: parseFloat(c.fontSize), fw: Number(c.fontWeight) }; })())"
  )
);
check("竖轴月刻度字大且加粗", !!vmStyle && vmStyle.fs >= 12 && vmStyle.fw >= 700, vmStyle ? vmStyle.fs + "px / " + vmStyle.fw : "");

const fbooks = await navBooks(".rv-navslot");
check("竖排右边那条总览，每本书一根线", fbooks.length === timeline.length, fbooks.length + " 根 / " + timeline.length + " 本");
/* 条左边竖着写年份，一年一个，点一下滚到那一年 */
const fYears = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rv-navslot .rd-nav-year')].map((b) => +b.dataset.y))")
);
check(
  "竖排那条左边按年写着年份",
  fYears.length >= 3 && fYears.every((y, i) => i === 0 || fYears[i - 1] < y),
  fYears.join(" ")
);
if (fYears.length) {
  const fyBtn = JSON.parse(
    await js(
      `JSON.stringify((() => { const b = document.querySelector('.rv-navslot .rd-nav-year[data-y="${fYears[0]}"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })())`
    )
  );
  const vTop0 = await js("document.querySelector('.scroll').scrollTop");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: fyBtn.x, y: fyBtn.y, button: "none", buttons: 0 });
  await wait(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: fyBtn.x, y: fyBtn.y, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: fyBtn.x, y: fyBtn.y, button: "left", buttons: 0, clickCount: 1 });
  await wait(900);
  const vTop1 = await js("document.querySelector('.scroll').scrollTop");
  check("点最早那个年份字，列表滚回那一年", vTop1 < vTop0 - 100, Math.round(vTop0) + " → " + Math.round(vTop1));
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 300, button: "none", buttons: 0 });
  await wait(250);
  await toDay(busyX - 60);
  await wait(800);
}
/* 条铺的那一段有多长：位置歪了，拖过去就落不到那本书 */
const totalV = navR.b - navR.a;
const fPos = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rv-navslot .rd-nav-book')].map((b) => parseFloat(b.style.top)))")
);
const fErr = fPos.map((v, i) => Math.abs(v - (calcMarks[i].x / totalV) * 100));
check(
  "竖排那条上线的位置与拖动反查对得上",
  fPos.length === calcMarks.length && Math.max(...fErr) < 0.2,
  "最偏 " + Math.max(...fErr).toFixed(3) + "%"
);
check(
  "线从上往下按日期排开",
  fPos.every((v, i) => i === 0 || fPos[i - 1] <= v + 1e-4),
  fPos[0].toFixed(2) + "% → " + fPos[fPos.length - 1].toFixed(2) + "%"
);
const flines = await navLines(".rv-navslot", true);
const fStepV = (12 * scCalc.monthW * 100) / totalV;
const fLineExp = calcBands.slice(1).map((b) => (b.x0 / totalV) * 100);
const ferr = flines.map((v, i) => Math.abs(v - (fLineExp[i] ?? 0)));
check(
  "竖排年界线一年一道、间距相等",
  flines.length === bandN - 1 && flines.every((v, i) => i === 0 || Math.abs(v - flines[i - 1] - fStepV) < 0.4) && Math.max(...ferr) < 0.6,
  "最偏 " + Math.max(...ferr).toFixed(2) + "%，格宽 " + fStepV.toFixed(2) + "%"
);

/* 拖着导航条走：光标旁浮出最近那本书的书名与日期，滚动跟着走 */
const fnav = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.rv-navslot .rd-nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
const scrollBox = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.scroll').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
/* 贴的是滚动框内容区的右沿，不是窗口右沿 —— 滚动框自己有内边距，右边还有竖滚动条，
   所以拿 .rvwrap 的右沿比，别拿窗口宽减一减 */
const wrapRight = await js("(() => Math.round(document.querySelector('.rvwrap').getBoundingClientRect().right))()");
check(
  "竖排那条贴在滚动框最右边",
  fnav.w < 32 && Math.abs(fnav.x + fnav.w - wrapRight) <= 2 && fnav.h > scrollBox.h * 0.6,
  "x " + Math.round(fnav.x) + " 宽 " + Math.round(fnav.w) + " 右沿 " + Math.round(fnav.x + fnav.w) + " / 内容右沿 " + wrapRight
);
const topBefore = await js("document.querySelector('.scroll').scrollTop");
/* 条铺的是整条轴，滑块左沿就是视野起点在整条轴上的分位 —— 跟剪辑软件那条进度条
   同一套。位置与内容一一对应，拖动因此是线性的，不会走两步换一把尺子 */
const vBar = (x) => barP(x, totalV);
const vTh0 = await thumbOf(".rv-navslot", true);
const vz0 = 1 / (Number(await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--zi')) || 0")) || 1);
check(
  "竖排那条铺的是整条轴，滑块左沿就是视野起点",
  Math.abs((vTh0.l / 100) * totalV - topBefore / vz0) < totalV * 0.003,
  "滑块 " + vTh0.l.toFixed(2) + "%，算得 " + Math.round((vTh0.l / 100) * totalV) + "，视野起点 " + Math.round(topBefore / vz0)
);
check(
  "滑块宽就是视野占整条轴的比例",
  Math.abs(vTh0.w / 100 - (await js("document.querySelector('.scroll').clientHeight")) / vz0 / totalV) < 0.01,
  vTh0.w.toFixed(3) + "%"
);
/* 按到条上三成处那本书的线：浮出来该是那本书，松手落到它那一带。
   不取正中的那本 —— 书大半堆在最近几年，正中那本就在开场位置上，
   滚不动，方向那一条验不出来 */
const fPick = calcMarks.filter((m) => vBar(m.x) > 0.06 && vBar(m.x) < 0.9);
const fMidMark = (fPick.length ? fPick : calcMarks).reduce((a, b) =>
  Math.abs(vBar(b.x) - 0.35) < Math.abs(vBar(a.x) - 0.35) ? b : a
);
const fMidP = vBar(fMidMark.x);
const fx = Math.round(fnav.x + fnav.w * 0.5);
const fy = Math.round(fnav.y + fnav.h * fMidP);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
await wait(250);
const fbub = await bubOf(".rv-navslot");
const fBook = fbub && fbub.k === "book" ? timeline.find((e) => e.title === titleOf(fbub.t)) : null;
check(
  "拖到线的位置上，浮出的是那本书的书名与日期",
  !!fBook && titleOf(fMidMark.text) === titleOf(fbub.t),
  fbub ? fbub.t : "没浮出来"
);
const fbubBox = JSON.parse(
  await js("JSON.stringify((() => { const b = document.querySelector('.rd-nav-bub'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, h: r.height }; })())")
);
check(
  "那行字浮在条的左边，不挤出窗口",
  !!fbubBox && fbubBox.right <= fnav.x + 2 && fbubBox.y > fnav.y && fbubBox.y < fnav.y + fnav.h,
  fbubBox ? "右边 " + Math.round(fbubBox.right) + " / 条左 " + Math.round(fnav.x) : "没浮出来"
);
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button: "left", buttons: 0, clickCount: 1 });
await wait(700);
const topAfter = await js("document.querySelector('.scroll').scrollTop");
/* 松手朝最近的线靠一下，落点就是那本书。条铺全轴，滑块中心直接换算出视野正中
   压在哪个世界坐标，跟「占整条轴百分之几」那套已经不搭界了 */
const aTh = await thumbOf(".rv-navslot", true);
const aMid = thumbCenter(aTh, totalV);
check(
  "拖到那本书，竖排跟着滚过去，落点压在正中",
  topAfter < topBefore && Math.abs(aMid - fMidMark.x) < totalV * 0.005,
  Math.round(topBefore) + " → " + Math.round(topAfter) + "（滑块正中 " + Math.round(aMid) + "，那本 " + Math.round(fMidMark.x) + "）"
);
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 200, button: "none", buttons: 0 });
await wait(300);
check("鼠标离开导航条，那行字收起来", (await js("document.querySelectorAll('.rd-nav-bub').length")) === 0);

/* 竖排也是真拖：往上拖一段就往上滚，拖起来之后按住不动不该自己跑。
   竖排的滑块靠 150ms 一轮量测推过来，最容易出现「手不动、它自己往前走」 */
const vTop0 = await js("document.querySelector('.scroll').scrollTop");
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy, button: "none", buttons: 0 });
await wait(120);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
await wait(220);
for (let i = 1; i <= 4; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy - i * 10, button: "left", buttons: 1 });
}
await wait(450);
const vTop1 = await js("document.querySelector('.scroll').scrollTop");
check("竖排往上拖，跟着往上滚", vTop1 < vTop0 - 1000, Math.round(vTop0) + " → " + Math.round(vTop1));
for (let i = 0; i < 14; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy - 40 + (i % 2 ? 1 : -1), button: "left", buttons: 1 });
}
await wait(500);
const vTop2 = await js("document.querySelector('.scroll').scrollTop");
/* 判据按条上一像素值多少定：全轴铺满，条上一像素跨着半天，抖 ±1px 净位移
   不到一个条像素；真要是自反馈那种漂移，抖十四下早跑出几个轴了 */
const vPx = totalV / fnav.h;
check(
  "竖排拖起来按住不动，不自己往前跑",
  Math.abs(vTop2 - vTop1) < vPx * 3,
  Math.round(vTop1) + " → " + Math.round(vTop2) + "（抖 14 下，一个条像素值 " + Math.round(vPx) + "）"
);
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy - 40, button: "left", buttons: 0, clickCount: 1 });
await wait(500);
/* 滑块自己跟着滚动走：滚到底在最下，滚到顶在最上。
   滑块由滚动框里的量测推过来（滚动事件 + 150ms 一轮），一次读往往还停在上一处，
   所以望着目标等它落定再断言 */
const fthumb = async () =>
  js("parseFloat((document.querySelector('.rv-navslot .rd-nav-thumb') || { style: {} }).style.top || '0')");
const waitThumb = async (want) => {
  let v = await fthumb();
  for (let i = 0; i < 16 && !want(v); i++) {
    await wait(200);
    v = await fthumb();
  }
  return v;
};
await js("(() => { const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight; return 1; })()");
const thBottom = await waitThumb((v) => v > 80);
await js("(() => { const s = document.querySelector('.scroll'); s.scrollTop = 0; return 1; })()");
const thTop = await waitThumb((v) => v < 2);
check("滚到底滑块在最下、滚到顶在最上", thBottom > 80 && thTop < 2, thTop.toFixed(2) + "% / " + thBottom.toFixed(2) + "%");

/* Ctrl + 滚轮缩放：不按 Ctrl 只滚动，按了才放大，且光标下那一点不动 */
const zNow = async () => {
  const t = await js("document.querySelector('.rv').style.transform || ''");
  const m = String(t).match(/scale\(([\d.]+)\)/);
  return m ? Number(m[1]) : 1;
};
const boxInfo = JSON.parse(
  await js(
    "JSON.stringify((() => { const b = document.querySelector('.rvwrap').closest('.scroll'); const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })())"
  )
);
const zx = Math.round(boxInfo.left + boxInfo.w / 2);
const zy = Math.round(boxInfo.top + boxInfo.h / 2);
const pyIn = zy - boxInfo.top;
const z0 = await zNow();
const h0 = await js("document.querySelector('.rv').getBoundingClientRect().height");
await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: -220, modifiers: 0 });
await wait(300);
check("不按 Ctrl 滚轮不放大", Math.abs((await zNow()) - z0) < 0.001, "仍然 " + z0);
const st0 = await js("document.querySelector('.rvwrap').closest('.scroll').scrollTop");
await sample(`Number((document.querySelector('.rv').style.transform.match(/scale\\(([\\d.]+)\\)/) || [0, 1])[1])`);
await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: -220, modifiers: 2 });
await wait(900);
const z1 = await zNow();
const h1 = await js("document.querySelector('.rv').getBoundingClientRect().height");
check("Ctrl + 滚轮放大", z1 > z0 + 0.1 && h1 > h0 * 1.05, z0 + " → " + z1 + "，高 " + Math.round(h0) + " → " + Math.round(h1));
const rampZ = rampOk(JSON.parse(await js("JSON.stringify(window.__s)")), 0.01);
check("竖排缩放滑过去，不是一下跳到位", rampZ === true, rampZ === true ? "中间 " + (await js("window.__s.length")) + " 帧" : String(rampZ));
const st1 = await js("document.querySelector('.rvwrap').closest('.scroll').scrollTop");
const expTop = Math.max(0, ((st0 + pyIn) / z0) * z1 - pyIn);
check("放大时光标下那一点停在原处", Math.abs(st1 - expTop) <= 8, "实际 " + Math.round(st1) + " / 期望 " + Math.round(expTop));
await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: 220, modifiers: 2 });
await wait(320);
check("Ctrl + 往回滚还原", Math.abs((await zNow()) - z0) < 0.06, (await zNow()) + "");

/* 放到顶：竖排也要能看清日刻度，而刻度字与封面不能跟着涨成三倍。
   先挪到读得最多的那个月 —— 那里一屏日子铺得开，日刻度才验得出来。
   缩放动画没走完时每一帧都按锚点把 scrollTop 按回去，这一会儿滚过去会被它
   拽回原处，所以先等它停下来，再挪 */
for (let i = 0; i < 12; i++) {
  const a = await zNow();
  await wait(90);
  if (Math.abs((await zNow()) - a) < 1e-4) break;
}
await wait(300);
await toDay(busyX - 40);
await wait(500);
for (let i = 0; i < 14; i++) await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: -200, modifiers: 2 });
await wait(1500);
const zMax = await zNow();
const vDay = await js("document.querySelectorAll('.rv-tk.day').length");
const vDayTxt = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rv-tk.day span')].map((n) => n.textContent.trim()))")
);
check("竖排放到最大能看到日刻度", zMax > 2.5 && vDay > 3, "z " + zMax + "，日刻度 " + vDay + " 根");
/* 库里读得最多的那个月，天天都得有：日刻度只有倍数一条门槛，放大够了
   一天一根，不挑间距也不跳过月初 */
const busiestFirst = R.dayNum(busiest[0] + "-01");
const busiestDays = new Date(Number(busiest[0].slice(0, 4)), Number(busiest[0].slice(5, 7)), 0).getDate();
const realTicks = R.ticks(scCalc, busiestFirst, busiestFirst + busiestDays, 2);
const realDays = realTicks.filter(
  (x) => x.kind === "day" && R.dayStr(scCalc.dayAt(x.x)).slice(0, 7) === busiest[0]
).length;
check("最满那个月每一天都有日刻度", realDays === busiestDays, busiest[0] + "：" + realDays + " / " + busiestDays + " 天");
/* 屏幕上也是这样：最左那根到最右那根之间，天天都得有一根，中间不许挖洞 */
const vDayWx = JSON.parse(
  await js(`JSON.stringify([...document.querySelectorAll('.rv-tk.day')].map((t) => parseFloat(t.style.top)))`)
);
const vGap = (() => {
  if (!vDayWx.length) return "一根都没有";
  const a = scCalc.dayAt(Math.min(...vDayWx));
  const b = scCalc.dayAt(Math.max(...vDayWx));
  return vDayWx.length === b - a + 1 ? true : vDayWx.length + " 根 / 该有 " + (b - a + 1) + " 天";
})();
check("竖排视野里每一天都有一根日刻度", vGap === true, String(vGap));
/* 日刻度只画一道短线，跟横排一样不写字：一天一格，写满就是一排日期 */
check("日刻度只画线，不写日期", vDay > 0 && vDayTxt.length === 0, vDay + " 根，带字 " + vDayTxt.length);
/* 轴上带字的只剩月与年：一根月线配一个「5月」，不留说不清管哪一段的光杆线 */
const bareMonth = await js(
  "(() => { const all = document.querySelectorAll('.rv-tk.month'); const withText = document.querySelectorAll('.rv-tk.month span'); return all.length - withText.length; })()"
);
check("月刻度都带着月名", bareMonth === 0, bareMonth + " 根没有字的月线");
/* 放大之后轴线本身还在。线画在一枚 1px 的伪元素上、按 1/z 压回去抵掉外层缩放；
   要是直接把这枚元素写成 calc(1px * var(--zi)) 这么宽，三倍下只剩零点三像素，
   会被栅格化成零宽，整条轴就没了 */
const axisPaint = JSON.parse(
  await js(`JSON.stringify((() => {
    const a = document.querySelector('.rv-axis');
    if (!a) return null;
    const c = getComputedStyle(a, '::before');
    const m = String(c.transform).match(/matrix\\(([\\d.]+)/);
    return { w: parseFloat(c.width), h: Math.round(a.getBoundingClientRect().height), sx: m ? Number(m[1]) : 0, bg: c.backgroundImage.slice(0, 13) };
  })())`)
);
const ziAxis = await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--zi')) || 0");
check(
  "放大之后轴线还在，屏幕上仍然是一像素",
  !!axisPaint && axisPaint.w >= 1 && axisPaint.h > 100 && Math.abs(axisPaint.sx * zMax - 1) < 0.06,
  axisPaint ? "元素高 " + axisPaint.h + "，线宽 " + axisPaint.w + "，压 " + axisPaint.sx.toFixed(3) + "（--zi " + ziAxis.toFixed(3) + "）" : "找不到轴线"
);
/* 量的是抵缩放的那个倍数：--zi 正好是 1/z，刻度字在屏幕上是恒定大小。
   年份那枚字另走 --zy，不在这条口径里，所以只量月名 */
const ziNow = await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--zi')) || 0");
const vTickFs = await js("(() => { const s = document.querySelector('.rv-tk.month span'); return s ? parseFloat(getComputedStyle(s).fontSize) : 0; })()");
check(
  "刻度字不跟着放大",
  Math.abs(ziNow - 1 / zMax) < 0.02 && (vTickFs === 0 || (vTickFs >= 11 && vTickFs <= 14)),
  "--zi " + ziNow.toFixed(4) + "（1/z 是 " + (1 / zMax).toFixed(4) + "）" + (vTickFs ? "，字 " + vTickFs + "px" : "，视野里没有月名")
);
const vBody = await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--vi')) || 1");
check("封面与文字的放大有封顶", vBody < 0.9 && vBody > 0.15, "--vi " + vBody);
for (let i = 0; i < 14; i++) await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: 200, modifiers: 2 });
/* 缩回 1 倍要等它真落回去：缩放途中条目会重挂，这时候点下去落到的是卸掉的节点 */
await waitFor(async () => js("Number((document.querySelector('.rv').style.transform||'').match(/scale\\(([\\d.]+)/)?.[1] || 1)"), (v) => v < 1.05, 20, 120);
await wait(300);

/* 点一条开抽屉 */
const openOne = async () => {
  const t = (await js("(document.querySelector('.rv-item .rv-t') || {}).textContent || ''")).trim();
  await js("(() => { const r = document.querySelector('.rv-item'); if (r) r.click(); return 1; })()");
  const d = await waitFor(async () => js("((document.querySelector('.drawer.on .dh h2')||{}).textContent||'').trim()"), (v) => !!v, 8, 150);
  return { t, d };
};
let opened = await openOne();
if (!opened.d) opened = await openOne();
check("点一条开的是那本书的详情", !!opened.t && opened.d.includes(opened.t.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, "").slice(0, 6)), opened.d.slice(0, 20));

/* 详情里两行日期都在，且都填着 */
const dayLabels = await js("[...document.querySelectorAll('.drawer.on .kv > div > span:first-child')].map(e => e.textContent.trim())");
check("详情里有阅读开始时间", dayLabels.includes("阅读开始时间"));
check("详情里有阅读结束时间", dayLabels.includes("阅读结束时间"));
const dayInputs = await js(`(() => {
  const rows2 = [...document.querySelectorAll('.drawer.on .kv > div')];
  const one = (name) => {
    const r = rows2.find(x => (x.querySelector('span')||{}).textContent === name);
    const i = r ? r.querySelector('input[type=date]') : null;
    return i ? i.value : '';
  };
  return JSON.stringify([one('阅读开始时间'), one('阅读结束时间')]);
})()`);
const [startV, endV] = JSON.parse(dayInputs);
check("两个日期都填着且开始不晚于结束", /^\d{4}-\d{2}-\d{2}$/.test(startV) && /^\d{4}-\d{2}-\d{2}$/.test(endV) && startV <= endV, startV + " 至 " + endV);
await js("(() => { const m = document.querySelector('.mask'); if (m) m.click(); return 1; })()");
await wait(400);

/* 切走再回来，视图还在阅读这档 */
await clickText(".seg button", "书架");
await wait(800);
await clickText(".seg button", "阅读");
await wait(900);
check("切走再回来还是时间线", (await js("document.querySelectorAll('.rv-item').length")) > 0);
await clickText(".seg button", "书架");
await wait(700);
await keyDown("4", true);
await wait(900);
check("Ctrl+4 落到阅读这一档", (await js("document.querySelectorAll('.rv-item').length")) > 0);

/* 统计条与顶栏 */
const barText = await js("(document.querySelector('.rd-bar')||{}).textContent||''");
check("统计条写着有日期的本数", barText.includes(String(stats.total) + " 本有日期"), barText.slice(0, 24));
check("顶栏不摆媒介段，写着小说", (await js("document.querySelectorAll('.rd-scope').length")) === 1);

}

/* ---- 横排 ---- */
seg = "横排";
console.log("[横排]");
if (want("h")) {
const offNow = () =>
  js("(() => { const t = document.querySelector('.rd-rail').style.transform || ''; const m = t.match(/translate3d\\((-?[\\d.]+)px/); return m ? Math.abs(Number(m[1])) : 0; })()");
const kNow = () => js("Number(getComputedStyle(document.querySelector('.rd-axis')).getPropertyValue('--k')) || 1");
const vNow = () => js("Number(getComputedStyle(document.querySelector('.rd-axis')).getPropertyValue('--v')) || 1");
const axBox = async () =>
  JSON.parse(await js("JSON.stringify((() => { const r = document.querySelector('.rd-axis').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())"));
const wheel = (x, y, dy) => call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });

check("切到横排", await clickText(".rd-switch button", "横排"));
await wait(1200);
const nodeN = await js("document.querySelectorAll('.rd-node').length");
check("横排只挂看得见的那几本", nodeN >= 3 && nodeN < timeline.length / 4, nodeN + " 张 / 共 " + timeline.length);
/* 轴只有内容那么高、在块里居中，但拖动挂在整块 axwrap 上，
   所以封面上下那两片空白也能拖 —— 以前指针只挂在轴上，按在空白里没反应 */
const zone = JSON.parse(
  await js(`JSON.stringify((() => {
    const w = document.querySelector('.rd-axwrap').getBoundingClientRect();
    const a = document.querySelector('.rd-axis').getBoundingClientRect();
    const y = document.querySelector('.rd-nav').getBoundingClientRect();
    return { wt: Math.round(w.top), wb: Math.round(w.bottom), at: Math.round(a.top), ab: Math.round(a.bottom), yb: Math.round(y.bottom) };
  })())`)
);
check(
  "轴在导航条下面居中",
  Math.abs(zone.at - zone.yb - (zone.wb - zone.ab)) <= 3,
  "上 " + (zone.at - zone.yb) + "，下 " + (zone.wb - zone.ab)
);
const blankY = Math.round((zone.wt + zone.at) / 2);
const offZ0 = await offNow();
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: blankY, button: "none", buttons: 0 });
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 700, y: blankY, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700 + i * 16, y: blankY, button: "left", buttons: 1 });
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 796, y: blankY, button: "left", buttons: 0, clickCount: 1 });
await wait(900);
const offZ1 = await offNow();
check("轴上方那片空白里也能拖", offZ1 < offZ0 - 20, Math.round(offZ0) + " → " + Math.round(offZ1));
const abooks = await navBooks(".rd-axwrap");
check("横排导航条与竖排同一批书，每本一根线", abooks.length === timeline.length, abooks.length + " 根 / " + timeline.length + " 本");
const abub = await js("document.querySelectorAll('.rd-nav .rd-nav-year').length");
check("条底下按年写着年份", abub >= 4, abub + " 个");
check("开场落在最右，最近的书先看见", (await offNow()) > 1000, Math.round(await offNow()) + "px");
const lanes = await js("JSON.stringify([document.querySelectorAll('.rd-node.lane0').length, document.querySelectorAll('.rd-node.lane1').length])");
const [l0, l1] = JSON.parse(lanes);
check("封面上下两轨交错", l0 >= 2 && l1 >= 2 && Math.abs(l0 - l1) <= 3, l0 + " / " + l1);
const axisY = await js("(() => { const l = document.querySelector('.rd-line').getBoundingClientRect(); return l.top + l.height / 2; })()");
const k1x = await js("Number(getComputedStyle(document.querySelector('.rd-axis')).getPropertyValue('--k')) || 1");
const bars = JSON.parse(
  await js(`(() => {
    const axisY = ${axisY};
    const k = ${k1x};
    const out = [...document.querySelectorAll('.rd-node')].slice(0, 220).map((n) => {
      const b = n.querySelector('.rd-run');
      const card = n.querySelector('.rd-card');
      const br = b ? b.getBoundingClientRect() : null;
      const bw = parseFloat(n.style.getPropertyValue('--bw')) || 0;
      return {
        id: n.dataset.id,
        span: n.classList.contains('lane1') ? 1 : 0,
        /* 金线收着的时候 rect 是 0 宽，长度按世界坐标乘倍数算 */
        bar: Math.round(bw * k),
        dy: br ? Math.round(br.top + br.height / 2 - axisY) : 0,
        card: Math.round(card.getBoundingClientRect().width)
      };
    });
    return JSON.stringify(out);
  })()`)
);
/* 条数要在同一刻取：裁掉屏外那些之后，DOM 里的节点数跟着拖动变 */
const pairN = JSON.parse(
  await js("JSON.stringify({ run: document.querySelectorAll('.rd-run').length, probe: document.querySelectorAll('.rd-probe').length, node: document.querySelectorAll('.rd-node').length })")
);
check("每本都挂着一根探针与一段金线", pairN.run === pairN.node && pairN.probe === pairN.node, pairN.run + " / " + pairN.probe + " / " + pairN.node);
/* 金线就压在轴线上，上轨下轨都一样，靠封面那根细线连过去 */
const upLane = bars.filter((b) => b.span === 0);
const dnLane = bars.filter((b) => b.span === 1);
check("上轨的金线压在轴上", upLane.every((b) => Math.abs(b.dy) <= 1.5), "最偏 " + Math.max(...upLane.map((b) => Math.abs(b.dy))) + "px");
check("下轨的金线压在轴上", dnLane.every((b) => Math.abs(b.dy) <= 1.5), "最偏 " + Math.max(...dnLane.map((b) => Math.abs(b.dy))) + "px");
/* 平时不画，鼠标停在书上才长出来 */
const litRuns = () =>
  js("(() => [...document.querySelectorAll('.rd-run')].filter((b) => b.getBoundingClientRect().width > 2).length)()");
const litProbesH = () =>
  js("(() => [...document.querySelectorAll('.rd-probe')].filter((b) => b.getBoundingClientRect().height > 20).length)()");
check("金线平时不画", (await litRuns()) === 0, (await litRuns()) + " 条亮着");
const hoverBox = JSON.parse(
  await js(`JSON.stringify((() => {
    const els = [...document.querySelectorAll('.rd-node')];
    const e = els.find((n) => { const r = n.getBoundingClientRect(); return r.left > 20 && r.right < innerWidth - 20; });
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })())`)
);
if (hoverBox) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverBox.x, y: hoverBox.y, button: "none", buttons: 0 });
  const litH = await waitFor(litRuns, (v) => v >= 1);
  check("鼠标停在书上，金线长出来", litH >= 1, litH + " 条亮着");
  const probeH = await waitFor(litProbesH, (v) => v >= 1);
  check("先拉一根线滑到轴上", probeH >= 1, probeH + " 根伸出去");
  const hTip = await js("((document.querySelector('.rd-tip') || {}).textContent || '')");
  check("光标旁的浮层写着起止与用时", /起止/.test(hTip) && /用时/.test(hTip) && /\d{4}-\d{2}-\d{2}/.test(hTip), hTip.slice(0, 36));
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 300, button: "none", buttons: 0 });
  await wait(400);
  check("鼠标移开又收回去", (await litRuns()) === 0, (await litRuns()) + " 条还亮着");
  check("浮层也跟着收起", (await js("document.querySelectorAll('.rd-tip').length")) === 0);
}
const spanIds = new Set(timeline.filter((e) => e.span).map((e) => e.id));
const longBar = bars.filter((b) => spanIds.has(b.id));
const oneDayBar = bars.filter((b) => !spanIds.has(b.id));
check("跨天那几本金线伸得比封面宽", longBar.length > 0 && longBar.some((b) => b.bar > b.card + 4), longBar.length + " 本跨天，最宽 " + Math.max(...longBar.map((b) => b.bar)) + "px");
/* 一格是一天：当天读完的金线正好盖住那一天，长度就是那天在轴上占的宽度 */
const dayErrH = oneDayBar.map((b) => Math.abs(b.bar / k1x - scCalc.slopeAt(midOf.get(b.id))));
check(
  "当天读完的金线正好盖住那一格",
  oneDayBar.length >= 1 && Math.max(...dayErrH) <= 1.5,
  oneDayBar.length + " 条，最大差 " + Math.max(...dayErrH).toFixed(1) + "px（最长 " + Math.max(...oneDayBar.map((b) => b.bar)) + "px）"
);

/* 书名挂在封面外侧，长条两头标日号 */
const labels = JSON.parse(
  await js(`(() => {
    const ns = [...document.querySelectorAll('.rd-node')];
    return JSON.stringify({
      t: ns.filter((n) => (n.querySelector('.rd-t') || {}).textContent).length,
      all: ns.length,
      d0: document.querySelectorAll('.rd-d0').length,
      d1: document.querySelectorAll('.rd-d1').length,
      spans: ${spanIds.size},
      first: (ns.find((n) => n.querySelector('.rd-t')) || {}).textContent || ''
    });
  })()`)
);
check("每本封面外侧都标了书名", labels.t === labels.all, labels.t + " / " + labels.all + " · 例 " + labels.first.slice(0, 12));
check("每本两头都标了起止日期", labels.d0 === labels.all && labels.d1 === labels.all, "起 " + labels.d0 + " / 止 " + labels.d1 + " / 共 " + labels.all);
const hDayTxt = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rd-d0, .rd-d1')].map((n) => n.textContent.trim()))")
);
check("横排长条两头的日期写成 月-日", hDayTxt.length > 0 && hDayTxt.every((s) => /^\d{2}-\d{2}$/.test(s)), hDayTxt.slice(0, 6).join(" / "));

/* 刻度：1 倍按月，放大到 5 倍按日 */
const tk1 = JSON.parse(
  await js(
    "JSON.stringify({y:document.querySelectorAll('.rd-tk.year').length,m:document.querySelectorAll('.rd-tk.month').length,d:document.querySelectorAll('.rd-tk.day').length,dl:[...document.querySelectorAll('.rd-tk.day span')].length,ml:[...document.querySelectorAll('.rd-tk.month span')].length})"
  )
);
check("1 倍下有月刻度且带字", tk1.m > 0 && tk1.ml > 0, "月 " + tk1.m + "，带字 " + tk1.ml);
check("1 倍下没有日刻度", tk1.d === 0, tk1.d + " 个");
const hmStyle = JSON.parse(
  await js(
    "JSON.stringify((() => { const s = document.querySelector('.rd-tk.month span'); if (!s) return null; const c = getComputedStyle(s); return { fs: parseFloat(c.fontSize), fw: Number(c.fontWeight) }; })())"
  )
);
check("横轴月刻度字大且加粗", !!hmStyle && hmStyle.fs >= 12 && hmStyle.fw >= 700, hmStyle ? hmStyle.fs + "px / " + hmStyle.fw : "");
/* 年份注记挂在年线头上：线比月线长一倍，字在轴的上方，后面跟一支朝右的箭头，
   说这一年从这道线往右铺开 */
const yStyle = JSON.parse(
  await js(`JSON.stringify((() => {
    const y = document.querySelector('.rd-tk.year');
    const m = document.querySelector('.rd-tk.month');
    if (!y || !m) return null;
    const ys = y.querySelector('span');
    const a = y.querySelector('.rd-yarw');
    const yr = y.getBoundingClientRect();
    const sr = ys ? ys.getBoundingClientRect() : null;
    const ar = a ? a.getBoundingClientRect() : null;
    return {
      yl: parseFloat(getComputedStyle(y, '::before').height),
      ml: parseFloat(getComputedStyle(m, '::before').height),
      yf: ys ? parseFloat(getComputedStyle(ys).fontSize) : 0,
      above: sr ? Math.round(yr.top - sr.bottom) : -99,
      arW: ar ? Math.round(ar.width) : 0,
      arH: ar ? Math.round(ar.height) : 0
    };
  })())`)
);
check(
  "年线比月线长，年份注记挂在轴上方",
  !!yStyle && yStyle.yl >= yStyle.ml * 1.8 && yStyle.above > 0,
  yStyle ? "线 " + yStyle.yl + " / " + yStyle.ml + "px，字离轴 " + yStyle.above + "px（" + yStyle.yf + "px 字）" : "找不到年刻度"
);
check(
  "年份后面跟一支朝右的箭头",
  !!yStyle && yStyle.arW >= 20 && yStyle.arH <= 2,
  yStyle ? "箭头 " + yStyle.arW + "×" + yStyle.arH + "px" : ""
);

/* 一屏只有一个月左右，先落到读得最多的那个月：放到 5 倍时那一段才铺得开日刻度，
   落在只读了一两本的月份里，一屏就只有寥寥几条线 */
const navSeek = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.rd-axwrap .rd-nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
const seekY = Math.round(navSeek.y + navSeek.h / 2);
/* 条铺的是那一段固定的世界坐标，点哪儿就落到哪儿，一下就到，不用反复贴边挪 */
const seekTotal = navR.b - navR.a;
const seekToBusy = async () => {
  const p = barP(busyX, seekTotal);
  const x = Math.round(navSeek.x + navSeek.w * Math.min(0.98, Math.max(0.02, p)));
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: seekY, button: "none", buttons: 0 });
  await wait(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y: seekY, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: seekY, button: "left", buttons: 0, clickCount: 1 });
  await wait(700);
};
await seekToBusy();
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 300, button: "none", buttons: 0 });
await wait(250);

const bx = await axBox();
const cx = Math.round(bx.x + bx.w * 0.5);
const cy = Math.round(bx.y + bx.h * 0.5);
const fs0 = await js("parseFloat(getComputedStyle(document.querySelector('.rd-t')).fontSize)");
for (let i = 0; i < 12; i++) await wheel(cx, cy, -240);
await wait(900);
const k5 = await kNow();
check("倍数到 5 就顶住", Math.abs(k5 - 5) < 0.02, k5.toFixed(2));
const fs1 = await js("parseFloat(getComputedStyle(document.querySelector('.rd-t')).fontSize)");
const vCap = await vNow();
check("放大时书名字跟着变大", fs1 > fs0 * 1.9, fs0.toFixed(1) + " → " + fs1.toFixed(1) + "px");
check("封面字号到 2.2 倍封顶", Math.abs(vCap - 2.2) < 0.03, vCap.toFixed(2));
const tk5 = JSON.parse(
  await js(
    "JSON.stringify({d:document.querySelectorAll('.rd-tk.day').length,dl:[...document.querySelectorAll('.rd-tk.day span')].length,m:document.querySelectorAll('.rd-tk.month').length,ml:[...document.querySelectorAll('.rd-tk.month span')].length,y:document.querySelectorAll('.rd-tk.year').length,sun:document.querySelectorAll('.rd-tk.day.sun, .rd-tk.sun').length})"
  )
);
check("放大到最大出现日刻度", tk5.d >= 4, tk5.d + " 个");
check("横排日刻度也只画线，不写字", tk5.d > 0 && tk5.dl === 0, tk5.dl + " / " + tk5.d + " 个带字");
/* 与竖排同一条：最左那根到最右那根之间天天都得有，跳一天就算丢 */
const aDayWx = JSON.parse(
  await js(`JSON.stringify([...document.querySelectorAll('.rd-tk.day')].map((t) => parseFloat(t.style.getPropertyValue('--wx'))))`)
);
const aGap = (() => {
  if (!aDayWx.length) return "一根都没有";
  const a = scCalc.dayAt(Math.min(...aDayWx));
  const b = scCalc.dayAt(Math.max(...aDayWx));
  return aDayWx.length === b - a + 1 ? true : aDayWx.length + " 根 / 该有 " + (b - a + 1) + " 天";
})();
check("横排视野里每一天都有一根日刻度", aGap === true, String(aGap));
/* 放到 5 倍一屏只剩半个月，月初那道线多半不在视野里，月份这块不在这里验 ——
   1 倍那条已经验过月刻度带字 */
check("刻度里再没有星期那一档", tk5.sun === 0, tk5.sun + " 根带 sun");

/* 缩回 1 倍 */
for (let i = 0; i < 12; i++) await wheel(cx, cy, 240);
await wait(900);

/* 拖动与惯性 */
const offDrag0 = await offNow();
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + i * 15, y: cy, button: "left", buttons: 1 });
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 120, y: cy, button: "left", buttons: 0, clickCount: 1 });
const offDrag1 = await offNow();
check("按住往右拖，偏移跟着变小", offDrag1 < offDrag0 - 80, Math.round(offDrag0) + " → " + Math.round(offDrag1));
check("拖完不误开详情", (await js("document.querySelectorAll('.drawer.on').length")) === 0);


const offGlideA = await offNow();
await wait(350);
const offGlideB = await offNow();
check("松手之后还滑一段再停", Math.abs(offGlideB - offGlideA) > 6, Math.round(offGlideA) + " → " + Math.round(offGlideB));

/* 屏外那些根本不挂在 DOM 里：拖动一段之后换了一批，DOM 里始终只有几十张 */
const idsNow = async () =>
  JSON.parse(await js("JSON.stringify([...document.querySelectorAll('.rd-node')].map((n) => n.dataset.id))"));
/* 前面那轮已经缩到最小倍数，整条几乎都在视窗里，先双击回 1 倍再验 */
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: cy + 250, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: cy + 250, button: "left", buttons: 0, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: cy + 250, button: "left", buttons: 1, clickCount: 2 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: cy + 250, button: "left", buttons: 0, clickCount: 2 });
await wait(1000);
const beforeIds = await idsNow();
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - i * 60, y: cy, button: "left", buttons: 1 });
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx - 600, y: cy, button: "left", buttons: 0, clickCount: 1 });
await wait(1200);
const afterIds = await idsNow();
check(
  "拖远之后挂着的封面换了一批",
  afterIds.length > 0 && afterIds.length < timeline.length && afterIds.some((id) => !beforeIds.includes(id)),
  afterIds.length + " 张，其中新挂 " + afterIds.filter((i) => !beforeIds.includes(i)).length + " 张"
);

/* 滚轮缩放：先把还在滑的惯性按停 */
await wheel(cx, cy, 0);
await wait(250);
const k0 = await kNow();
const anchor = JSON.parse(
  await js(`(() => {
    let best = null, bd = 1e9;
    for (const n of document.querySelectorAll('.rd-node')) {
      const r = n.getBoundingClientRect();
      if (r.right < 0 || r.left > innerWidth) continue;
      const d = Math.abs(r.left - ${cx});
      if (d < bd) { bd = d; best = { id: n.dataset.id, x: r.left }; }
    }
    return JSON.stringify(best || {});
  })()`)
);
await sample("Number(document.querySelector('.rd-axis').style.getPropertyValue('--k'))");
await wheel(cx, cy, -120);
await wait(900);
const k1 = await kNow();
const rampK = rampOk(JSON.parse(await js("JSON.stringify(window.__s)")), 0.004);
check("横排缩放滑过去，不是一下跳到位", rampK === true, rampK === true ? "中间 " + (await js("window.__s.length")) + " 帧" : String(rampK));
check("滚轮上滚倍数变大", k1 > k0 + 0.001, k0.toFixed(2) + " → " + k1.toFixed(2));
const anchorAfter = await js(
  `(document.querySelector('.rd-node[data-id="${anchor.id}"]')||{getBoundingClientRect:()=>({left:-999})}).getBoundingClientRect().left`
);
const anchorExpect = cx + (anchor.x - cx) * (k1 / k0);
check(
  "光标锚定，缩放前后对得上",
  Math.abs(anchorAfter - anchorExpect) < 2.5,
  anchor.x.toFixed(1) + " → " + Number(anchorAfter).toFixed(1) + "，应到 " + anchorExpect.toFixed(1)
);

/* 下限顶住 */
for (let i = 0; i < 40; i++) await wheel(cx, cy, 240);
await wait(900);
check("倍数到 0.2 就顶住", Math.abs((await kNow()) - 0.2) < 0.02, (await kNow()).toFixed(2));

/* 双击轴面空白回到 1 倍。缩到最小之后封面挤成十几像素宽，空档落点每档都变，
   一次没落准就重来 —— 断言只认最后那一下有没有回到 1 倍 */
let kBack = 1;
for (let round = 0; round < 3; round++) {
  const emptySpot = JSON.parse(
    await js(`(() => {
      const ax = document.querySelector('.rd-axis').getBoundingClientRect();
      for (let x = ax.x + 20; x < ax.right - 20; x += 40) {
        const el = document.elementFromPoint(x, ax.y + 20);
        if (!el || !el.closest('.rd-node, .rd-nav')) return JSON.stringify({ x: Math.round(x), y: Math.round(ax.y + 20) });
      }
      return JSON.stringify({ x: Math.round(ax.x + ax.w / 2), y: Math.round(ax.y + 20) });
    })()`)
  );
  for (const t of [1, 2]) {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: emptySpot.x, y: emptySpot.y, button: "left", buttons: 1, clickCount: t });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: emptySpot.x, y: emptySpot.y, button: "left", buttons: 0, clickCount: t });
  }
  await wait(900);
  kBack = await kNow();
  if (Math.abs(kBack - 1) < 0.02) break;
  await js("(() => { const m = document.querySelector('.mask.on'); if (m) m.click(); return 1; })()");
  await wait(300);
}
check("双击空白回到 1 倍", Math.abs(kBack - 1) < 0.02, kBack.toFixed(2));

/* 条上每本书一根线：扫到线上浮出来的就该是那本书；空档里没有书，退回到
   「哪一年 · 几本」。位置一律拿离线那一份对，扫的点也从那份里挑 ——
   这条轴上早年大半是空年，随手扫几个位置多半落在空档上 */
const navBox = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.rd-axwrap .rd-nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
const navY = Math.round(navBox.y + navBox.h / 2);
const bubbleAt = async (p) => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(navBox.x + navBox.w * p), y: navY, button: "none", buttons: 0 });
  await wait(200);
  return bubOf(".rd-axwrap");
};
/* 条铺的是那一段固定的世界坐标：位置就是它在条上的比例，跟视野无关，挑扫的点
   也不用管眼前露着哪一段 */
const totalA = navR.b - navR.a;
const aBar = (x) => barP(x, totalA);
const aTh0 = await thumbOf(".rd-axwrap");
check(
  "横排那条铺的是整条轴，滑块留在条里",
  !!aTh0 && aTh0.w > 0 && aTh0.l >= -0.01 && aTh0.l + aTh0.w <= 100.5,
  aTh0 ? "左 " + aTh0.l.toFixed(2) + "% 宽 " + aTh0.w.toFixed(3) + "%" : "没有滑块"
);
const aPos = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rd-axwrap .rd-nav-book')].map((b) => parseFloat(b.style.left)))")
);
const aErr = aPos.map((v, i) => Math.abs(v - (calcMarks[i].x / totalA) * 100));
check(
  "横排那条上线的位置对得上",
  aPos.length === calcMarks.length && Math.max(...aErr) < 0.2,
  "最偏 " + Math.max(...aErr).toFixed(3) + "%"
);
const onBar = calcMarks.filter((m) => aBar(m.x) > 0.05 && aBar(m.x) < 0.95);
const nearBar = (q) => onBar.reduce((a, b) => (Math.abs(aBar(b.x) - q) < Math.abs(aBar(a.x) - q) ? b : a), onBar[0]);
const picked = [];
for (const q of [0.08, 0.3, 0.55, 0.8, 0.94]) {
  const m = nearBar(q);
  if (m && !picked.some((x) => x.id === m.id)) picked.push(m);
}
const bubs = [];
for (const m of picked) bubs.push({ p: aBar(m.x), want: m, ...(await bubbleAt(aBar(m.x))) });
const bBooks = bubs.filter((b) => b && b.k === "book");
check(
  "扫到书的线上，浮出的就是那本书",
  picked.length >= 4 && bBooks.length === picked.length,
  bubs.map((b) => (b ? b.k + ":" + b.t.slice(0, 10) : "无")).join(" / ")
);
/* 说的是哪本书，就该是那一点最近的那本：差得远说明线的位置与反查不是同一把尺子 */
const bubErr = bBooks.map((b) => (titleOf(b.t) === titleOf(b.want.text) ? 0 : 9));
check("浮出来的就是那一点最近的书", bubErr.every((d) => d < 0.02), bubErr.join(" / "));
/* 一本没读的那几年，条上是干净的空白，落到那里就报年份与本数 */
const emptyBand = calcBands.find((b) => b.n === 0);
if (emptyBand) {
  const eb = await bubbleAt(aBar((emptyBand.x0 + emptyBand.x1) / 2));
  check("空档处报的是哪一年、几本", !!eb && eb.k === "year" && eb.t === emptyBand.y + " 年 · 0 本", eb ? eb.t : "没浮出来");
}

/* 按到条的最左端：一跳四年，按几下就退到最早那年，偏移归零。
   按之前先把指针挪过去 —— 上一处停在别的地方时，浏览器要先做一次命中测试，
   直接按容易落在上一次的落点上 */
const farLeft = async () => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(navBox.x + 2), y: navY, button: "none", buttons: 0 });
  await wait(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(navBox.x + 2), y: navY, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(navBox.x + 2), y: navY, button: "left", buttons: 0, clickCount: 1 });
  await wait(500);
};
for (let i = 0; i < 10 && (await offNow()) > 60; i++) await farLeft();
check("按到最左，退到最早那年开头", (await offNow()) < 60, Math.round(await offNow()) + "px");

/* 在条上滚轮是翻年份：一路平移，倍数一动不动。条铺全轴，按「一年」定步长 */
const kBeforeNavWheel = await kNow();
const offBeforeNavWheel = await offNow();
await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(navBox.x + navBox.w * 0.5), y: navY, deltaX: 0, deltaY: 120 });
await wait(700);
const offAfterNavWheel = await offNow();
check(
  "在条上滚轮翻年份，不缩放",
  Math.abs((await kNow()) - kBeforeNavWheel) < 0.005 && offAfterNavWheel - offBeforeNavWheel > 4000,
  "k 仍 " + kBeforeNavWheel.toFixed(2) + "，偏移 " + Math.round(offBeforeNavWheel) + " → " + Math.round(offAfterNavWheel)
);
await farLeft();

/* 活动框的宽窄跟着倍数走：缩得越远，框越宽 */
const thW = async () => js("parseFloat((document.querySelector('.rd-axwrap .rd-nav-thumb') || { style: {} }).style.width) || 0");
await wait(400);
const thW1 = await thW();
for (let i = 0; i < 16; i++) await wheel(cx, cy, 240);
await wait(1000);
const kLow = await kNow();
const thW2 = await thW();
check(
  "缩得越远，活动框越宽",
  kLow < 0.32 && thW1 > 0 && thW2 > thW1 * 2.2,
  "k " + kLow.toFixed(2) + "，宽 " + thW1.toFixed(2) + "% → " + thW2.toFixed(2) + "%"
);
for (let i = 0; i < 24 && (await kNow()) < 0.99; i++) await wheel(cx, cy, -120);
await wait(900);

/* 点导航条：按在哪儿，滑块中心就落到哪儿，内容跟着到那一带 —— 跟进度条一个脾气，
   不再是「框永远回正中」。点六成处，滑块中心就该停在六成 */
const navPress = async (x) => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: navY, button: "none", buttons: 0 });
  await wait(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y: navY, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: navY, button: "left", buttons: 0, clickCount: 1 });
  await wait(600);
};
const thumbBox = () => thumbOf(".rd-axwrap");
await navPress(Math.round(navBox.x + navBox.w * 0.6));
const offMid = await offNow();
const th0 = await thumbBox();
check("点导航条，落到那一段", offMid > 300, Math.round(offMid) + "px");
check(
  "滑块中心停在按的那一处",
  Math.abs(th0.l + th0.w / 2 - 60) < 1.5,
  "中心 " + (th0.l + th0.w / 2).toFixed(2) + "%，宽 " + th0.w.toFixed(3) + "%"
);

/* 拖滑块本身。按在滑块上，抓住的就是滑块里那一处 */
const grabX = Math.round(navBox.x + navBox.w * ((th0.l + th0.w / 2) / 100));
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX, y: navY, button: "none", buttons: 0 });
await wait(120);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: grabX, y: navY, button: "left", buttons: 1, clickCount: 1 });
await wait(250);
const offT1 = await offNow();
check("按在滑块上，滑块不被吸到光标正中", Math.abs(offT1 - offMid) <= 2, Math.round(offMid) + " → " + Math.round(offT1));

/* 往左挪 12px */
for (let i = 1; i <= 3; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX - i * 4, y: navY, button: "left", buttons: 1 });
}
await wait(200);
const offT2 = await offNow();
/* 拖起来之后按住不动，指针抖 ±1px 十几个来回：偏移一个像素都不该漂。
   以前是「按绝对分位反查、窗口又按视野中心重算」，抖一下视野就自己往前跑一截 */
for (let i = 0; i < 14; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX - 12 + (i % 2 ? 1 : -1), y: navY, button: "left", buttons: 1 });
}
await wait(400);
const offT3 = await offNow();
/* 判据按「条上一像素值多少」定：抖 ±1px 净位移不到一个条像素，
   真要是自反馈那种漂移，抖十四下早就跑出几个轴了 */
const pxWorld = (totalA / navBox.w) * (await kNow());
check(
  "拖起来之后按住不动，视野不自己往前跑",
  Math.abs(offT3 - offT2) < pxWorld * 3,
  Math.round(offT2) + " → " + Math.round(offT3) + "（抖 14 下，一个条像素值 " + Math.round(pxWorld) + "）"
);
for (let i = 1; i <= 8; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX - 12 - i * 30, y: navY, button: "left", buttons: 1 });
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: grabX - 252, y: navY, button: "left", buttons: 0, clickCount: 1 });
await wait(600);
const th1 = await thumbBox();
const offT4 = await offNow();
check("往左拖滑块，偏移跟着退", offT4 < offT3 - 100, Math.round(offT3) + " → " + Math.round(offT4));
check("滑块自己也跟着挪", th1.l < th0.l, th0.l.toFixed(2) + "% → " + th1.l.toFixed(2) + "%");
/* 拖多远走多远：条上 240px 折成世界坐标该走多少，就走多少。以前是「按位置
   反查」，拖同样的距离能跑出去几十倍，这条钉住 1:1 */
const pxOff = (totalA / navBox.w) * (await kNow());
const wantOff = 240 * pxOff;
check(
  "拖动走的距离与手一致",
  Math.abs(Math.abs(offT4 - offT2) - wantOff) < wantOff * 0.08,
  "走了 " + Math.round(Math.abs(offT4 - offT2)) + "px，该走 " + Math.round(wantOff) + "px"
);
check(
  "蓝框跟着手走，走的距离也对得上",
  Math.abs(th0.l - th1.l - (240 / navBox.w) * 100) < 2,
  "框挪了 " + (th0.l - th1.l).toFixed(2) + "%，手挪了 " + ((240 / navBox.w) * 100).toFixed(2) + "%"
);

/* 拖到条的最右端就是轴的最尾：跟进度条一样，到底就停。再往外拖也不再往前走 */
const stepTo = async (from, to, n) => {
  for (let i = 1; i <= n; i++) {
    await call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(from + ((to - from) * i) / n),
      y: navY,
      button: "left",
      buttons: 1
    });
  }
};
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX, y: navY, button: "none", buttons: 0 });
await wait(120);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: grabX, y: navY, button: "left", buttons: 1, clickCount: 1 });
await wait(220);
const edgeIn = Math.round(navBox.x + navBox.w - 1);
await stepTo(grabX, edgeIn, 12);
await wait(300);
const offEdge = await offNow();
const thEdge = await thumbBox();
check(
  "拖到条的最右端，滑块贴到右沿",
  Math.abs(thEdge.l + thEdge.w - 100) < 1.5,
  "右沿 " + (thEdge.l + thEdge.w).toFixed(2) + "%"
);
const outX = Math.round(navBox.x + navBox.w + 150);
await stepTo(edgeIn, outX, 3);
await wait(300);
const offOut = await offNow();
check("拖出条外就停在轴尾，不再往前跑", Math.abs(offOut - offEdge) < 2, Math.round(offEdge) + " → " + Math.round(offOut));
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: outX, y: navY, button: "left", buttons: 0, clickCount: 1 });
await wait(500);
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 300, button: "none", buttons: 0 });
await wait(250);

/* 点一张封面开抽屉。条铺全轴，一下就能落到读得最多的那个月 */
await seekToBusy();
await wait(500);
const pick = JSON.parse(
  await js(`(() => {
    for (const n of document.querySelectorAll('.rd-node')) {
      const r = n.getBoundingClientRect();
      if (r.left > 6 && r.right < innerWidth - 6 && r.width > 8) return JSON.stringify({ id: n.dataset.id, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: n.dataset.title || "" });
    }
    return JSON.stringify({});
  })()`)
);
if (pick.id) {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pick.x, y: pick.y, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pick.x, y: pick.y, button: "left", buttons: 0, clickCount: 1 });
  await wait(900);
  const axOpen = await js("document.querySelectorAll('.drawer.on').length");
  const axTitle = await js("((document.querySelector('.drawer.on .dh h2')||{}).textContent||'').trim()");
  const pickName = pick.title.split(" · ")[0];
  check("点封面开的是那本书的详情", axOpen === 1 && !!axTitle && axTitle.includes(pickName), axTitle.slice(0, 20));
  await js("(() => { const m = document.querySelector('.mask'); if (m) m.click(); return 1; })()");
  await wait(400);
} else {
  check("横排上找得到能点的封面", false, "一屏内没有落得下的封面");
}

/* 条下面每年一枚年份字，左右居中挂在各自那一段，点一下就跳到那一年 */
const navBarW = await js("document.querySelector('.rd-axwrap .rd-nav').clientWidth");
const navYears = JSON.parse(
  await js(
    "JSON.stringify([...document.querySelectorAll('.rd-axwrap .rd-nav-year')].map((b) => ({ y: +b.dataset.y, x: parseFloat(b.style.left) })))"
  )
);
check(
  "条下面按年写着年份，从早到晚",
  navYears.length >= 4 && navYears.every((v, i) => i === 0 || navYears[i - 1].y < v.y),
  navYears.map((v) => v.y).join(" ")
);
const yErr = [];
for (const b of calcBands) {
  const got = navYears.find((v) => v.y === b.y);
  if (!got) continue;
  const want = (((Math.min(b.x1, navR.b) + Math.max(b.x0, navR.a)) / 2 - navR.a) / (navR.b - navR.a)) * navBarW;
  /* 两头的字被掐在条里，本来就不在正中，不比 */
  if (want < 20 || want > navBarW - 20) continue;
  yErr.push(Math.abs(want - got.x));
}
check("年份字挂在自己那一段的正中", yErr.length >= 3 && Math.max(...yErr) < 2, "最偏 " + Math.max(...yErr).toFixed(1) + "px");

const yPick = navYears[Math.floor(navYears.length / 2)];
const yBtn = JSON.parse(
  await js(
    `JSON.stringify((() => { const b = document.querySelector('.rd-axwrap .rd-nav-year[data-y="${yPick.y}"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })())`
  )
);
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: yBtn.x, y: yBtn.y, button: "none", buttons: 0 });
await wait(120);
const yHit = await waitFor(
  () => js(`(() => { const e = document.elementFromPoint(${yBtn.x}, ${yBtn.y}); return e ? (e.className || e.tagName) : "none"; })()`),
  (v) => String(v).includes("rd-nav-year"),
  8,
  120
);
const yGeo = await js(
  `JSON.stringify((() => {
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return {
      w: [innerWidth, innerHeight],
      nav: r(document.querySelector('.rd-axwrap .rd-nav')),
      ys: r(document.querySelector('.rd-axwrap .rd-nav-years')),
      btn: r(document.querySelector('.rd-axwrap .rd-nav-year[data-y="${yPick.y}"]')),
      ax: r(document.querySelector('.rd-axis'))
    };
  })())`
);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: yBtn.x, y: yBtn.y, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: yBtn.x, y: yBtn.y, button: "left", buttons: 0, clickCount: 1 });
await wait(1000);
const yBand = calcBands.find((b) => b.y === yPick.y) || { x0: 0, x1: 1 };
const yWx = (await offNow()) / (await kNow()) + (await js("document.querySelector('.rd-axis').clientWidth")) / 2 / (await kNow());
check(
  "点年份字，那一年摆到视野正中",
  Math.abs(yWx - (yBand.x0 + yBand.x1) / 2) < (yBand.x1 - yBand.x0) * 0.12,
  "点 " + yPick.y + " 的 " + yBtn.x + "," + yBtn.y + "（命中 " + yHit + " / " + yGeo + "），落在 " + Math.round(yWx) + "，那年中间 " + Math.round((yBand.x0 + yBand.x1) / 2)
);

/* 显示区间：两个年份框直接写四位数字，右边一对上下箭头各调一年；
   写超了两头就夹回去 —— 早于最早那本、晚于今年的都写不进去 */
const withBooks = calcBands.filter((b) => b.n > 0);
if (withBooks.length >= 4) {
  const earliest = Number(R.dayStr(scCalc.first).slice(0, 4));
  const thisYear = new Date().getFullYear();
  const rY0 = Math.min(withBooks[withBooks.length - 4].y, withBooks[withBooks.length - 2].y);
  const rY1 = Math.max(withBooks[withBooks.length - 4].y, withBooks[withBooks.length - 2].y);
  const boxes = async () =>
    JSON.parse(
      await js("JSON.stringify([...document.querySelectorAll('.rd-range .rd-year-in')].map((i) => i.value))")
    );
  /* 当真人打字：先点进框里，塞值发 input，再离框（离框才提交） */
  const typeYear = async (i, y) => {
    await js(`(() => { const el = document.querySelectorAll('.rd-range .rd-year-in')[${i}]; if (!el) return 0;
      el.focus();
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(String(y))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return 1; })()`);
    await wait(700);
  };
  const stepYear = async (i, dir) => {
    await js(
      `(() => { const el = document.querySelectorAll('.rd-range .rd-year-in')[${i}]` +
        `.parentElement.querySelector('.rd-year-step.${dir}'); if (!el || el.disabled) return 0; el.click(); return 1; })()`
    );
    await wait(600);
  };

  const dflt = await boxes();
  check(
    "显示区间一进来就是最早那本到今年",
    dflt[0] === String(earliest) && dflt[1] === String(thisYear),
    dflt.join(" – ") + "（该 " + earliest + " – " + thisYear + "）"
  );

  /* 早于最早那本、晚于今年，两头都夹回来 */
  await typeYear(0, earliest - 6);
  const clampedLo = await boxes();
  check("写的年份早于最早那本，夹回最早那年", clampedLo[0] === String(earliest), clampedLo[0] + " / " + earliest);

  await typeYear(1, thisYear + 9);
  const clampedHi = await boxes();
  check("写的年份晚于今年，夹回今年", clampedHi[1] === String(thisYear), clampedHi[1] + " / " + thisYear);

  /* 换区间前读一次滑块：宽窄只跟「铺开多长」有关，比它才见得着条被摊开了 */
  const thBefore = await thumbOf(".rd-axwrap");

  /* 箭头各调一年 */
  await typeYear(0, rY0);
  await typeYear(1, rY1);
  const beforeStep = await boxes();
  await stepYear(0, "up");
  const upBox = await boxes();
  check(
    "点向上的箭头，开始年份加一年",
    Number(upBox[0]) === Number(beforeStep[0]) + 1,
    beforeStep[0] + " → " + upBox[0]
  );
  await stepYear(0, "down");
  const downBox = await boxes();
  check("点向下的箭头，减回一年", downBox[0] === String(rY0), downBox[0] + " / " + rY0);

  await typeYear(0, rY0);
  await typeYear(1, rY1);
  const rRange = R.yearRange(scCalc, rY0, rY1);
  const wantN = R.navMarks(timeline, scCalc, rRange).length;
  const gotN = await js("document.querySelectorAll('.rd-axwrap .rd-nav-book').length");
  check(
    "换了显示区间，条上只剩那几年的书",
    wantN > 0 && gotN === wantN,
    gotN + " 根 / 该 " + wantN + " 根（全部 " + calcMarks.length + "）"
  );
  const thAfter = await thumbOf(".rd-axwrap");
  const spanAll = navR.b - navR.a;
  const spanIn = rRange.b - rRange.a;
  check(
    "条只铺这几年，同样的视野滑块长得多",
    thAfter.w > thBefore.w && Math.abs(thAfter.w / thBefore.w - spanAll / spanIn) < 0.3,
    "宽 " + thAfter.w.toFixed(3) + "% 对 " + thBefore.w.toFixed(3) + "%（铺开 " + (spanAll / spanIn).toFixed(1) + " 倍窄）"
  );
  const yN = await js("document.querySelectorAll('.rd-axwrap .rd-nav-year').length");
  check("区间里一年一个字", yN >= 2 && yN <= rY1 - rY0 + 1, yN + " 个 / " + (rY1 - rY0 + 1) + " 年");
  const saved = await js("localStorage.getItem('booklib.readRange')");
  check("区间记在本地，下次打开还是这一段", saved === rY0 + "-" + rY1, String(saved));
  /* 重置：回到最早那本到今年，条也回到整条轴 */
  await js("(() => { const b = [...document.querySelectorAll('.rd-range button')].find((x) => x.textContent.trim() === '重置'); if (b) b.click(); return b ? 1 : 0; })()");
  await wait(1000);
  const backBox = await boxes();
  const backN = await js("document.querySelectorAll('.rd-axwrap .rd-nav-book').length");
  const backSaved = await js("localStorage.getItem('booklib.readRange')");
  check(
    "重置回到最早那本到今年",
    backBox[0] === String(earliest) && backBox[1] === String(thisYear) && backN === calcMarks.length && backSaved === "",
    backBox.join(" – ") + "，" + backN + " 根，本地值 " + JSON.stringify(backSaved)
  );
}

/* 切回竖排：同一批书，只是换了排布 */
await clickText(".rd-switch button", "竖排");
await wait(900);
check(
  "切回竖排轴收了、列表还在",
  (await js("document.querySelectorAll('.rd-node').length")) === 0 && (await js("document.querySelectorAll('.rv-item').length")) > 0
);

}

const parts = [...segStat].map(([k, v]) => k + " " + v.ok + "/" + (v.ok + v.bad));
console.log(parts.length > 1 ? "\n" + parts.join(" · ") : "");
console.log("阅读冒烟 " + ok + "/" + (ok + bad) + " 通过" + (ONLY.length ? "（只跑 " + ONLY.join(",") + "）" : ""));
stop();
process.exit(bad ? 1 : 0);
