/*
 * 只跑阅读时间线这一屏的冒烟。动时间线、阅读起止、阅读视图时用它。
 * 自己起一个 electron 实例，用书库副本，跑完收掉。
 * 用法：node scripts/smoke-read.mjs（npm run smoke:read）
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
  if (cond) {
    ok++;
    console.log("PASS " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("FAIL " + name + (extra ? "  " + extra : ""));
  }
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

/* 一屏只装得下一个多月（一个月一格，全轴按最满的那个月定宽），最近的月份常只有
   一两本。要验金线、日号、两轨那些，先算清轴上的坐标，把视口挪到读得最多的那个
   月 —— 那里一屏铺得满，断言才有东西可验。算的是同一份换算，与服务层无关 */
const R = require("../dist-electron/shared/readScale.js");
const midDays = timeline.map((e) => R.midDay(e));
const midOf = new Map(timeline.map((e) => [e.id, R.midDay(e)]));
const scCalc = R.buildScale(midDays);
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
const busyP = R.navFrac(calcBands, busyX + scCalc.monthW * 0.5);
const toDay = (x) => js(`(() => { const s = document.querySelector('.scroll'); s.scrollTop = ${Math.round(x)}; return Math.round(s.scrollTop); })()`);

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

/* ---- 竖排 ---- */
console.log("[竖排]");
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
const dayTxt = await js(
  "JSON.stringify([...document.querySelectorAll('.rv-d0, .rv-d1')].map((n) => n.textContent.trim()))"
);
const dayNums = JSON.parse(dayTxt);
check("竖排长条两头的日号只写数字", dayNums.length > 0 && dayNums.every((s) => /^\d{1,2}$/.test(s)), dayNums.slice(0, 6).join(" / "));
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
/* 长度是从日期换算里来的，跨天的条总比一格长。挤的地段被撑开、几年的大空档被
   MAX_GAP 压过，所以这里只验方向，具体天数乘一格落在轴换算那头 */
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
/* 右边那条总览：按年等分，一年一格，格里的柱子是那年读完几本。
   年份按钮那一排撤了，改成拖着这条跨年，拖的时候浮出年份与本数。
   竖着摆，所以「长度」是柱子的宽、「格子」是高度 */
const yAll = [...new Set(timeline.map((e) => Number(String(e.anchor).slice(0, 4))))].filter((y) => y > 1900);
const yLo = Math.min(...yAll);
const yHi = Math.max(...yAll);
const bandN = yHi - yLo + 1;
const cntOf = new Map();
for (const e of timeline) {
  const y = Number(String(e.anchor).slice(0, 4));
  cntOf.set(y, (cntOf.get(y) || 0) + 1);
}
const maxCnt = Math.max(...[...cntOf.values()]);
const yearAtP = (p) => yLo + Math.min(bandN - 1, Math.floor(p * bandN));
const navBars = async (sel, vert = false) =>
  JSON.parse(
    await js(`JSON.stringify([...document.querySelectorAll('${sel} .rd-nav-bar')].map((b) => ({
      l: parseFloat(b.style.${vert ? "top" : "left"}), h: parseFloat(b.style.${vert ? "width" : "height"}), o: Number(b.style.opacity)
    })))`)
  );
const navLines = async (sel, vert = false) =>
  JSON.parse(
    await js(
      `JSON.stringify([...document.querySelectorAll('${sel} .rd-nav-line')].map((b) => parseFloat(b.style.${vert ? "top" : "left"})))`
    )
  );

const fbars = await navBars(".rv-navslot", true);
check("竖排右边也有那条总览，一年一格", fbars.length === bandN, fbars.length + " 格 / " + bandN + " 年");
const flines = await navLines(".rv-navslot", true);
const fstep = 100 / bandN;
const ferr = flines.map((v, i) => Math.abs(v - (i + 1) * fstep));
check("竖排年界线等距，一年一道", flines.length === bandN - 1 && Math.max(...ferr) < 0.6, "最偏 " + Math.max(...ferr).toFixed(2) + "%");
/* 柱子长度按平方根压过，一年只读一本的年份也留得下 2px，不然早年那几格等于没有 */
const barH = (n) => (n ? Math.max(2, Math.round(18 * Math.sqrt(n / maxCnt))) : 0);
const fhErr = fbars.map((b, i) => Math.abs(b.h - barH(cntOf.get(yLo + i) || 0)));
check("柱子长短是那年读完的本数", Math.max(...fhErr) <= 1, "最大差 " + Math.max(...fhErr) + "px");
check("一本没读的年份空着", fbars.every((b, i) => (cntOf.get(yLo + i) ? b.h >= 2 : b.h === 0)), "空年的柱宽 " + fbars.filter((b, i) => !cntOf.get(yLo + i)).map((b) => b.h).join(","));

/* 拖着导航条走：光标旁浮出哪一年、那年读完几本，滚动跟着走 */
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
const fx = Math.round(fnav.x + fnav.w * 0.5);
const fy = Math.round(fnav.y + fnav.h * 0.5);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", buttons: 1, clickCount: 1 });
await wait(250);
const fbub = await js("((document.querySelector('.rd-nav-bub') || {}).textContent || '').trim()");
const fMidYear = yearAtP(0.5);
check(
  "拖导航条浮出哪一年、那年读了几本",
  fbub === fMidYear + " 年 · " + (cntOf.get(fMidYear) || 0) + " 本",
  fbub || "没浮出来"
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
check("拖到中间那年，竖排跟着滚过去", topAfter < topBefore * 0.5, Math.round(topBefore) + " → " + Math.round(topAfter));
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 200, button: "none", buttons: 0 });
await wait(300);
check("鼠标离开导航条，那行字收起来", (await js("document.querySelectorAll('.rd-nav-bub').length")) === 0);
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
check("竖排放到最大能看到日刻度", zMax > 2.5 && vDay > 5, "z " + zMax + "，日刻度 " + vDay + " 根");
/* 放到 3.2 倍时一屏只剩十来天，月线多半不在视野里，没有月名可量。
   量的是抵缩放的那个倍数：--zi 正好是 1/z，刻度线与刻度字在屏幕上是恒定大小 */
const ziNow = await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--zi')) || 0");
const vTickFs = await js("(() => { const s = document.querySelector('.rv-tk span'); return s ? parseFloat(getComputedStyle(s).fontSize) : 0; })()");
check(
  "刻度字不跟着放大",
  Math.abs(ziNow - 1 / zMax) < 0.02 && (vTickFs === 0 || (vTickFs > 10 && vTickFs < 16)),
  "--zi " + ziNow.toFixed(4) + "（1/z 是 " + (1 / zMax).toFixed(4) + "）" + (vTickFs ? "，字 " + vTickFs + "px" : "，视野里没有月名")
);
const vBody = await js("Number(getComputedStyle(document.querySelector('.rv')).getPropertyValue('--vi')) || 1");
check("封面与文字的放大有封顶", vBody < 0.9 && vBody > 0.15, "--vi " + vBody);
for (let i = 0; i < 14; i++) await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: zx, y: zy, deltaX: 0, deltaY: 200, modifiers: 2 });
await wait(1000);

/* 点一条开抽屉 */
const firstTitle = (await js("(document.querySelector('.rv-item .rv-t') || {}).textContent || ''")).trim();
await js("(() => { const r = document.querySelector('.rv-item'); if (r) r.click(); return 1; })()");
await wait(900);
const drawerTitle = await js("((document.querySelector('.drawer.on .dh h2')||{}).textContent||'').trim()");
check("点一条开的是那本书的详情", !!firstTitle && drawerTitle.includes(firstTitle.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, "").slice(0, 6)), drawerTitle.slice(0, 20));

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

/* ---- 横排 ---- */
console.log("[横排]");
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
const abars = await navBars(".rd-axwrap");
check("横排导航条与竖排同一把尺子，一年一格", abars.length === bandN, abars.length + " 格 / " + bandN + " 年");
const abub = await js("document.querySelectorAll('.rd-nav button').length");
check("那排年份按钮撤了", abub === 0, abub + " 个还在");
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
check("跨天那几本两头都标了日号", labels.d0 === longBar.length && labels.d1 === labels.all, "起 " + labels.d0 + " / 跨天 " + longBar.length + "，止 " + labels.d1);
const hDayTxt = JSON.parse(
  await js("JSON.stringify([...document.querySelectorAll('.rd-d0, .rd-d1')].map((n) => n.textContent.trim()))")
);
check("横排长条两头的日号只写数字", hDayTxt.length > 0 && hDayTxt.every((s) => /^\d{1,2}$/.test(s)), hDayTxt.slice(0, 6).join(" / "));

/* 刻度：1 倍按月，放大到 5 倍按日 */
const tk1 = JSON.parse(
  await js(
    "JSON.stringify({y:document.querySelectorAll('.rd-tk.year').length,m:document.querySelectorAll('.rd-tk.month').length,d:document.querySelectorAll('.rd-tk.day').length,dl:[...document.querySelectorAll('.rd-tk.day span')].length,ml:[...document.querySelectorAll('.rd-tk.month span')].length})"
  )
);
check("1 倍下有月刻度且带字", tk1.m > 0 && tk1.ml > 0, "月 " + tk1.m + "，带字 " + tk1.ml);
const hmStyle = JSON.parse(
  await js(
    "JSON.stringify((() => { const s = document.querySelector('.rd-tk.month span'); if (!s) return null; const c = getComputedStyle(s); return { fs: parseFloat(c.fontSize), fw: Number(c.fontWeight) }; })())"
  )
);
check("横轴月刻度字大且加粗", !!hmStyle && hmStyle.fs >= 12 && hmStyle.fw >= 700, hmStyle ? hmStyle.fs + "px / " + hmStyle.fw : "");

/* 一屏只有两个多月，先落到读得最多的那个月：放到 5 倍时那一段才铺得开日刻度，
   落在几年空档里就只剩一两根线，验不出日刻度 */
const navSeek = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.rd-axwrap .rd-nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
const seekX = Math.round(navSeek.x + navSeek.w * busyP);
const seekY = Math.round(navSeek.y + navSeek.h / 2);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: seekX, y: seekY, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: seekX, y: seekY, button: "left", buttons: 0, clickCount: 1 });
await wait(900);
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
    "JSON.stringify({d:document.querySelectorAll('.rd-tk.day').length,dl:[...document.querySelectorAll('.rd-tk.day span')].length,m:document.querySelectorAll('.rd-tk.month').length,sun:document.querySelectorAll('.rd-tk.day.sun').length})"
  )
);
check("放大到最大出现日刻度", tk5.d > 10, tk5.d + " 个");
check("日刻度不写日号", tk5.dl === 0, tk5.dl + " 个带字");
check("星期天那几根加粗", tk5.sun >= 1, tk5.sun + " 根");

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

/* 导航条按年等分：扫到哪儿浮出来的就该是那一年，与真实轴长无关 */
const navBox = JSON.parse(
  await js("JSON.stringify((() => { const r = document.querySelector('.rd-axwrap .rd-nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })())")
);
const navY = Math.round(navBox.y + navBox.h / 2);
const bubbleAt = async (p) => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(navBox.x + navBox.w * p), y: navY, button: "none", buttons: 0 });
  await wait(200);
  return js("((document.querySelector('.rd-axwrap .rd-nav-bub') || {}).textContent || '').trim()");
};
const wantAt = (p) => yearAtP(p) + " 年 · " + (cntOf.get(yearAtP(p)) || 0) + " 本";
const bubL = await bubbleAt(0.05);
const bubM = await bubbleAt(0.5);
const bubR = await bubbleAt(0.95);
check(
  "导航条按年等分：扫到哪儿就是那一年",
  bubL === wantAt(0.05) && bubM === wantAt(0.5) && bubR === wantAt(0.95),
  [bubL, bubM, bubR].join(" / ")
);

/* 拖到最左：最早那年，偏移归零。按下之前先把指针挪过去 —— 上一处停在别的地方时，
   浏览器要先做一次命中测试，直接按容易落在上一次的落点上 */
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(navBox.x + 2), y: navY, button: "none", buttons: 0 });
await wait(120);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(navBox.x + 2), y: navY, button: "left", buttons: 1, clickCount: 1 });
await wait(300);
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(navBox.x + 2), y: navY, button: "left", buttons: 0, clickCount: 1 });
await wait(600);
check("拖到最左，落到最早那年开头", (await offNow()) < 60, Math.round(await offNow()) + "px");

/* 点中间：落到中间那几年，滑块跟着过去 */
const navPress = async (x) => {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: navY, button: "none", buttons: 0 });
  await wait(120);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y: navY, button: "left", buttons: 1, clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: navY, button: "left", buttons: 0, clickCount: 1 });
  await wait(600);
};
const thumbBox = async () =>
  JSON.parse(await js("JSON.stringify((() => { const t = document.querySelector('.rd-axwrap .rd-nav-thumb'); return { l: parseFloat(t.style.left), w: parseFloat(t.style.width) }; })())"));
await navPress(Math.round(navBox.x + navBox.w * 0.5));
const offMid = await offNow();
const th0 = await thumbBox();
check("点导航条中间，落到中间那几年", offMid > 300, Math.round(offMid) + "px");
check("滑块跟着挪到中间", th0.l > 20, th0.l.toFixed(2) + "% 处，宽 " + th0.w.toFixed(2) + "%");

/* 拖滑块本身：按下去不被吸到光标正中，往左拖偏移跟着退 */
const grabX = Math.round(navBox.x + navBox.w * ((th0.l + th0.w / 2) / 100));
await call("Input.dispatchMouseEvent", { type: "mousePressed", x: grabX, y: navY, button: "left", buttons: 1, clickCount: 1 });
await wait(300);
const offT1 = await offNow();
check("按在滑块上，滑块不被吸到光标正中", Math.abs(offT1 - offMid) <= 40, Math.round(offMid) + " → " + Math.round(offT1));
for (let i = 1; i <= 8; i++) {
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: grabX - i * 30, y: navY, button: "left", buttons: 1 });
}
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: grabX - 240, y: navY, button: "left", buttons: 0, clickCount: 1 });
await wait(600);
const th1 = await thumbBox();
const offT2 = await offNow();
check("往左拖滑块，偏移跟着退", offT2 < offT1 - 100, Math.round(offT1) + " → " + Math.round(offT2));
check("滑块自己也跟着挪", th1.l < th0.l, th0.l.toFixed(2) + "% → " + th1.l.toFixed(2) + "%");
await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 6, y: 300, button: "none", buttons: 0 });
await wait(250);

/* 点一张封面开抽屉 */
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

/* 切回竖排：同一批书，只是换了排布 */
await clickText(".rd-switch button", "竖排");
await wait(900);
check(
  "切回竖排轴收了、列表还在",
  (await js("document.querySelectorAll('.rd-node').length")) === 0 && (await js("document.querySelectorAll('.rv-item').length")) > 0
);

console.log("\n阅读冒烟 " + ok + "/" + (ok + bad) + " 通过");
stop();
process.exit(bad ? 1 : 0);
