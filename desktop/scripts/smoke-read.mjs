/*
 * 阅读页冒烟。先 npm run build，再 npm run smoke:read。
 * c、v、h 可单跑日历、竖排、横排，-v 显示逐项结果。
 * 用合成书库启动独立 Electron 验收实例。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedFlag = "--seed-fixture";

if (process.argv[2] === seedFlag) {
  const { openDb, closeDb } = require("../dist-electron/electron/db/index.js");
  const db = openDb(path.join(process.argv[3], "library.db"));
  const insert = db.prepare(
    "INSERT INTO books (id, title, media_type, read_start, read_date, is_read, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const stamp = "2025-01-01T00:00:00Z";
  const add = (id, title, start, end, media = "小说") => insert.run(id, title, media, start, end, end ? 1 : 0, 4, stamp, stamp);
  db.transaction(() => {
    add("leap", "闰日唯一测试书", "", "2024-02-29");
    add("first", "54 周首日", "", "2012-01-01");
    add("last", "54 周末日", "", "2012-12-31");
    add("newyear", "跨年书", "2002-12-20", "2003-01-10");
    add("a", "区间甲", "2025-03-03", "2025-03-12");
    add("b", "区间乙", "2025-03-09", "2025-03-18");
    add("c", "区间丙", "2025-03-10", "2025-03-19");
    add("start", "只有开始日期", "2025-03-11", "");
    add("manga", "同日漫画", "", "2024-02-29", "漫画");
    for (let i = 1; i <= 26; i++) add("dense-" + i, "同日测试书 " + i, "", "2025-03-20");
  })();
  closeDb();
} else {
  await smoke();
}

async function smoke() {
  const args = process.argv.slice(2);
  const cases = (args.find((arg) => !arg.startsWith("-")) || "c,v,h").split(",");
  const wants = (segment) => cases.includes(segment) || cases.includes("all");
  const port = Number(process.env.CDP_PORT || 9339);
  const address = "http://127.0.0.1:" + port;
  const electron = require("electron");

  let inUse = false;
  try { inUse = (await fetch(address + "/json/version", { signal: AbortSignal.timeout(1200) })).ok; } catch {}
  assert(!inUse, "调试端口已被占用 " + port);

  const dataDir = fs.realpathSync(root);
  const work = fs.mkdtempSync(path.join(dataDir, ".smoke-read-"));
  const library = path.join(work, "library");
  const env = { ...process.env, BOOKLIB_ROOT: library };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  let socket;
  let logs = "";
  try {
    const seed = spawnSync(electron, [fileURLToPath(import.meta.url), seedFlag, library], {
      cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true
    });
    assert(seed.status === 0 && fs.existsSync(path.join(library, "library.db")), seed.stderr || seed.error?.message || "合成库生成失败");

    child = spawn(electron, [
      ".", "--user-data-dir=" + path.join(work, "profile"), "--remote-debugging-port=" + port,
      "--disable-gpu", "--in-process-gpu", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling"
    ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => { logs = (logs + chunk).slice(-5000); });
    }

    const until = async (description, read, timeout = 5000) => {
      const limit = Date.now() + timeout;
      while (Date.now() < limit) {
        const result = await read();
        if (result) return result;
        if (child.exitCode != null) throw new Error("Electron 提前退出 " + child.exitCode);
        await wait(75);
      }
      throw new Error("等待超时 " + description);
    };
    const page = await until("Electron 就绪", async () => {
      try {
        const response = await fetch(address + "/json/list", { signal: AbortSignal.timeout(1200) });
        return (await response.json()).find((entry) => entry.type === "page");
      } catch {}
    }, 15000);

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
      pending.get(message.id)?.(message);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const request = ++id;
      const timeout = setTimeout(() => {
        pending.delete(request);
        reject(new Error("调试命令超时 " + method));
      }, 5000);
      pending.set(request, (message) => {
        clearTimeout(timeout);
        pending.delete(request);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
    const evaluate = async (expression) => {
      const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    };
    const run = (fn, ...values) => evaluate("(" + fn.toString() + ")(..." + JSON.stringify(values) + ")");
    const check = (label, value) => {
      assert(value, label);
      if (args.includes("-v")) console.log("PASS " + label);
    };
    const query = (selector) => run((sel) => Boolean(document.querySelector(sel)), selector);
    const click = (selector) => run((sel) => {
      const element = document.querySelector(sel);
      if (!element) return false;
      element.click();
      return true;
    }, selector);
    const button = (label, scope = "button") => run((text, sel) => {
      const button = [...document.querySelectorAll(sel)].find((entry) => entry.textContent.trim() === text);
      if (!button) return false;
      button.click();
      return true;
    }, label, scope);
    const mouseClick = async (selector) => {
      const point = await until("标记可点击 " + selector, () => run((sel) => {
        const element = document.querySelector(sel);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      }, selector));
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, ...point, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
      }
    };
    const resize = (width, height) => call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const year = (value) => run((y) => {
      const el = document.querySelector('.rd-cal-yearpick select');
      el.value = y;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value));
    const cell = (date) => '.rd-cal-cell[data-day="' + date + '"]';
    const selectedDay = () => evaluate("document.querySelector('.rd-cal-cell.sel')?.dataset.day");
    const timelineDay = () => evaluate("document.querySelector('.rd-focus b')?.textContent");
    const dayCount = (date) => run((sel) => Number(document.querySelector(sel)?.dataset.n), cell(date));
    const calendar = async () => {
      await until("日历入口", () => button("日历"));
      await until("热力图渲染", () => query(".rd-cal-grid"));
    };
    const locate = async (layout, date) => {
      await calendar();
      await year(date.slice(0, 4));
      await until("目标日期格", () => click(cell(date)));
      check("能在时间线定位", await button("在时间线定位"));
      await until("切换排布", () => button(layout));
      await until("时间线保留日历日期", async () => await timelineDay() === date);
    };

    await call("Runtime.enable");
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    await resize(1260, 780);
    await until("书架加载", () => query(".card"), 15000);
    check("打开阅读", await button("阅读"));
    const api = await evaluate("(async () => ({ list: await window.api.readTimeline(), stats: await window.api.readStats() }))()");
    check("只有小说进入阅读视图", api.list.length === 34 && !api.list.some((entry) => entry.id === "manga"));
    check("按实际读完日统计", api.stats.byDay.find((entry) => entry.day === "2025-03-20")?.n === 26);
    check("开始日书目仍存在", api.list.some((entry) => entry.id === "start" && !entry.end));

    if (wants("c")) {
      await calendar();
      const today = await evaluate("(() => { const d = new Date(); return [d.getFullYear(), d.getMonth()+1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-'); })()");
      check("日历首次打开选中今天", await selectedDay() === today);
      await year(2012);
      await until("54 周闰年", () => query(cell("2012-12-31")));
      check("闰年显示 366 天且覆盖 54 周", await evaluate("document.querySelectorAll('.rd-cal-cell').length === 366 && document.querySelector('[data-day=\"2012-12-31\"]').style.gridColumn === '54'"));
      await year(2024);
      await until("闰日", () => query(cell("2024-02-29")));
      check("闰日格只数小说", await dayCount("2024-02-29") === 1);
      await click(cell("2024-02-29"));
      await until("单本直接打开详情", () => query(".drawer.on .dhead-field input[value='闰日唯一测试书']"));
      await run(() => {
        const date = document.querySelector('.drawer.on input[type="date"][value="2024-02-29"]');
        date.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(date, "2024-03-01");
        date.dispatchEvent(new Event("input", { bubbles: true }));
        date.blur();
      });
      await until("保存后两个格子同步更新", async () => await dayCount("2024-02-29") === 0 && await dayCount("2024-03-01") === 1);
      await click(".drawer.on .xbtn");
      check("关闭详情保留原日", await selectedDay() === "2024-02-29");
      await year(2025);
      await click(cell("2025-03-20"));
      check("同一天 26 本全部显示", await evaluate("document.querySelectorAll('.rd-cal-book').length") === 26);
      await click(cell("2025-03-11"));
      check("开始日格和书目口径一致", await dayCount("2025-03-11") === 0 && await evaluate("document.querySelectorAll('.rd-cal-book').length") === 0);
      await evaluate("(() => { const el = document.querySelector('.rd-cal-cell.sel'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })); })()");
      check("方向键按格子方向移动", await evaluate("document.activeElement.dataset.day") === "2025-03-12");
      await resize(900, 680);
      check("900 像素下热力图和书目均可见", await evaluate("document.querySelector('.rd-cal-scroll').clientWidth > 0 && document.querySelector('.rd-cal-books').clientWidth > 0"));
      await resize(740, 680);
      check("窄窗热力图可独立横滚", await evaluate("(() => { const el = document.querySelector('.rd-cal-scroll'); return el.scrollWidth > el.clientWidth; })()"));
      await resize(1260, 780);
    }

    if (wants("v")) {
      await locate("竖排", "2025-03-20");
      await until("竖排日期书目", () => query('.rd-vgroup[data-day="2025-03-20"]'));
      check("26 本归为同一日", await evaluate("document.querySelectorAll('.rd-vgroup[data-day=\"2025-03-20\"] .rd-vbook').length") === 26);
      check("竖排标出只填开始日期", await evaluate("document.querySelector('.rd-vbooks').textContent.includes('仅有开始日期')"));
      check("竖排有原年度导航条", await query(".rd-vwrap .rd-nav"));
      await click('.rd-vbook[data-id="dense-1"]');
      await until("竖排书目打开详情", () => query(".drawer.on .dhead-field input[value='同日测试书 1']"));
      await click(".drawer.on .xbtn");
      check("关闭详情保留竖排日期", await timelineDay() === "2025-03-20");
      await button("下月", ".rd-vcontrols button");
      await until("空月显示空状态", () => query(".rd-vempty"));
      await button("跳到最近有记录", ".rd-vempty button");
      await until("空月可回最近的月份", () => query('.rd-vgroup[data-day="2025-03-20"]'));
    }

    if (wants("h")) {
      await locate("横排", "2025-03-20");
      await click('[aria-label="放大"]');
      await mouseClick('.rd-hagg.month[data-day="2025-03-01"]');
      await until("横排按日展示", () => query('.rd-hagg.day[data-day="2025-03-20"]'));
      check("横排重叠区间使用两轨", await until("两条区间轨道", async () => await query('.rd-hbar.lane0') && await query('.rd-hbar.lane1')));
      await mouseClick('.rd-hagg.day[data-day="2025-03-20"]');
      await until("真实鼠标打开读完书目", () => query(".rd-hpanel-row"));
      check("横排聚合仍可展开 26 本", await evaluate("document.querySelectorAll('.rd-hpanel-row').length") === 26);
      await click('[aria-label="关闭书目"]');
      await button("在日历定位");
      await until("时间线反查日历", async () => await selectedDay() === "2025-03-20");
      await locate("横排", "2025-03-20");
      await run(() => {
        const endYear = document.querySelectorAll('.rd-year-in')[1];
        endYear.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(endYear, "2024");
        endYear.dispatchEvent(new Event("input", { bubbles: true }));
        endYear.blur();
      });
      await until("年份区间缩短时焦点停在边界", async () => await timelineDay() === "2024-12-31");
      check("年份范围以外的书目标记隐藏", !(await query('.rd-hagg.day[data-day="2025-03-20"]')));
    }

    check("渲染进程无异常", exceptions.length === 0);
    console.log("阅读视图冒烟通过 " + cases.join(","));
  } catch (error) {
    if (logs) console.error(logs);
    throw error;
  } finally {
    socket?.close();
    if (child?.pid && child.exitCode == null) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    const cleanup = fs.realpathSync(work);
    if (path.dirname(cleanup) === dataDir && path.basename(cleanup).startsWith(".smoke-read-")) {
      fs.rmSync(cleanup, { recursive: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
