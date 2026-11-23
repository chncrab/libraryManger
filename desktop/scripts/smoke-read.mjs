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
  const library = process.argv[3];
  const db = openDb(path.join(library, "library.db"));
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
    add("i", "区间乙", "2025-03-09", "2025-03-18");
    add("c", "区间丙", "2025-03-10", "2025-03-19");
    add("start", "只有开始日期", "2025-03-11", "");
    add("manga", "同日漫画", "", "2024-02-29", "漫画");
    for (let i = 1; i <= 26; i++) add("dense-" + i, "同日测试书 " + i, "", "2025-03-20");
    db.prepare("UPDATE books SET cover_file = 'timeline-test.png' WHERE id IN ('a', 'dense-1')").run();
  })();
  closeDb();
  const coverDir = path.join(library, "covers");
  fs.mkdirSync(coverDir, { recursive: true });
  fs.writeFileSync(path.join(coverDir, "timeline-test.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"
  ));
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
      let previous = null;
      const point = await until("标记停在可点击位置 " + selector, async () => {
        const current = await run((sel) => {
          const element = document.querySelector(sel);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
        }, selector);
        const stationary = current && previous && Math.hypot(current.x - previous.x, current.y - previous.y) < 0.5;
        previous = current;
        return stationary ? current : null;
      });
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, ...point, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
      }
    };
    const booksWheel = async (deltaY) => {
      const point = await evaluate("(() => { const r = document.querySelector('.rd-vbooks').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
      await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
    };
    const resize = (width, height) => call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const year = (value) => run((y) => {
      const el = document.querySelector('.rd-cal-yearpick select[aria-label="选择年份"]');
      el.value = y;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value));
    const cell = (date) => '.rd-cal-cell[data-day="' + date + '"]';
    const selectedDay = () => evaluate("document.querySelector('.rd-cal-cell.sel')?.dataset.day");
    const timelineDay = () => evaluate("document.querySelector('.rd-focus b')?.textContent");
    const dayCount = (date) => run((sel) => Number(document.querySelector(sel)?.dataset.n), cell(date));
    const calendar = async () => {
      await until("日历入口", () => button("日历"));
      await until("日历网格渲染", () => query(".rd-cal-yeargrid, .rd-cal-monthgrid"));
    };
    const locate = async (layout, date) => {
      await calendar();
      await button("全年");
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
      const popup = ".rd-cal-hover";
      const pinned = `${popup}[data-pinned="true"]`;
      const popupCard = `${popup} .rd-cal-hover-card`;
      const monthValue = () => evaluate("document.querySelector('select[aria-label=\"选择月份\"]')?.value");
      const wheelAt = async (selector, deltaY) => {
        const point = await run((sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, selector);
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
      };
      const dayTitles = (date) => run((selector) =>
        [...document.querySelectorAll(selector + ' .rd-cal-bk')].map((label) => label.textContent), cell(date));
      const titlesOnEndpoints = async () => {
        const [start, middle, overlap, finish] = await Promise.all(
          ["2025-03-03", "2025-03-04", "2025-03-09", "2025-03-12"].map(dayTitles)
        );
        return start.join() === "区间甲" && middle.length === 0 &&
          overlap.join() === "区间乙" && finish.join() === "区间甲";
      };
      await calendar();
      const today = await evaluate("(() => { const d = new Date(); return [d.getFullYear(), d.getMonth()+1, d.getDate()].map(n => String(n).padStart(2, '0')).join('-'); })()");
      check("日历首次打开选中今天", await selectedDay() === today);
      check("月历保留大格", await evaluate("document.querySelector('.rd-cal-cell.sel').getBoundingClientRect().width >= 70"));
      await button("全年");
      check("打开年历时从年初显示", await evaluate("document.querySelector('.rd-calscroll').scrollTop === 0"));
      check("年历选中今天并禁用未来日期", await run((today) => {
        const grid = document.querySelector('.rd-cal-yeargrid');
        return grid.querySelector('.rd-cal-cell.today.sel')?.dataset.day === today &&
          [...grid.querySelectorAll('.rd-cal-cell')].every((cell) =>
            cell.dataset.day > today ? cell.disabled && cell.dataset.n === '0' : !cell.disabled
          );
      }, today));
      await year(2002);
      await until("跨年书的开始年份可选", () => query(cell("2002-12-20")));
      check("跨年书从开始日到年末计入当年", await dayCount("2002-12-19") === 0 && await dayCount("2002-12-20") === 1 && await dayCount("2002-12-31") === 1);
      const trackColor = (date, id) => run((sel) => {
        const line = document.querySelector(sel);
        return line ? getComputedStyle(line).backgroundColor : null;
      }, `${cell(date)} .rd-cal-run[data-book="${id}"]`);
      const decemberColor = await trackColor("2002-12-31", "newyear");
      check("同一本跨天书在全年汇总只计一次", await run(() => document.querySelector('.rd-cal-focus').textContent.includes('1 本')));
      await year(2003);
      await until("跨年书的结束年份", () => query(cell("2003-01-10")));
      check("跨年书在下一年计入结束日为止", await dayCount("2003-01-01") === 1 && await dayCount("2003-01-10") === 1 && await dayCount("2003-01-11") === 0);
      check("同一本书跨年保持线色", !!decemberColor && await trackColor("2003-01-01", "newyear") === decemberColor);
      check("跨年中间日不显示书名", (await dayTitles("2003-01-01")).length === 0 && (await dayTitles("2003-01-10")).join() === "跨年书");
      await year(2012);
      await until("完整闰年", () => query(cell("2012-12-31")));
      check("一张年历显示十二个月和 366 个有效日期", await evaluate("document.querySelectorAll('.rd-cal-yeargrid').length === 1 && document.querySelectorAll('.rd-cal-year-month').length === 12 && document.querySelectorAll('.rd-cal-yeargrid .rd-cal-cell').length === 366"));
      check("年历按三列四行排布，日期格可直接辨认", await run(() => {
        const card = (month) => document.querySelector(`.rd-cal-year-month[data-month="${month}"]`).getBoundingClientRect();
        const january = card(1);
        const march = card(3);
        const april = card(4);
        const december = card(12);
        const date = document.querySelector('[data-day="2012-01-31"]');
        const { width, height } = date.getBoundingClientRect();
        return march.x > january.x && march.y === january.y && april.x === january.x &&
          april.y > march.y && december.x === march.x && december.y > april.y &&
          width >= 30 && height >= 26 && date.textContent.trim().startsWith('31');
      }));
      await click(cell("2012-01-29"));
      await run(() => document.querySelector('.rd-cal-cell.sel').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
      await until("年历方向键可跨月移动一周", () => run(() => document.activeElement.dataset.day === '2012-02-05'));
      await year(2024);
      await until("闰日", () => query(cell("2024-02-29")));
      check("闰日格只数小说", await dayCount("2024-02-29") === 1);
      await click(cell("2024-02-29"));
      await until("点闰日固定浮窗", () => query(pinned));
      check("单本日期不直接打开详情", !(await query(".drawer.on")));
      await mouseClick(popupCard);
      await until("点浮窗里的书打开详情", () => query(".drawer.on .dhead-field input[value='闰日唯一测试书']"));
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
      await until("年历显示 2025 年", () => query(cell("2025-03-09")));
      check("年历统计开始日、中途、结束日和区间重叠", await dayCount("2025-03-02") === 0 && await dayCount("2025-03-03") === 1 && await dayCount("2025-03-09") === 2 && await dayCount("2025-03-12") === 3 && await dayCount("2025-03-19") === 1);
      const checkShades = () => run(() => {
        const date = (day) => document.querySelector(`[data-day="2025-03-${day}"]`);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const rgb = (color) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color.trim();
          ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data;
        };
        const base = rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg2'));
        const tone = (day) => {
          const [r, g, b] = rgb(getComputedStyle(date(day)).backgroundColor);
          return Math.hypot(r - base[0], g - base[1], b - base[2]);
        };
        const edge = (day) => Number(date(day).getAttribute('data-edge-count'));
        return edge('03') === 1 && edge('04') === 0 && edge('19') === 1 && edge('20') === 26 &&
          tone('03') > tone('04') && tone('19') > tone('04') && tone('13') > tone('03') &&
          tone('09') > tone('03') && tone('20') > tone('11');
      });
      check("年历底色随起止状态和书本数加深", await checkShades());
      check("年历格只显示当天开始或读完的书名", await titlesOnEndpoints());
      const hoverPoint = async (date) => {
        const selector = cell(date);
        await run((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), selector);
        return until("日期露出可悬停 " + date, () => run((sel) => {
          const cell = document.querySelector(sel);
          const rect = cell.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return cell.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
        }, selector));
      };
      const hoverMiddle = async () => {
        const point = await hoverPoint("2025-03-04");
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
        await until("中间日悬停仍能看到书名", () => run((sel) => {
          const cards = [...document.querySelectorAll(sel)];
          return cards.length === 1 && cards[0].textContent.includes('区间甲');
        }, popupCard));
      };
      await hoverMiddle();
      const point = await hoverPoint("2025-03-09");
      const hoverPosition = () => run(() => {
        const tooltip = document.querySelector('.rd-cal-hover');
        if (!tooltip) return null;
        const rect = tooltip.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
      await until("同一天两本书各自显示浮动卡片", () => run(() => {
        const titles = [...document.querySelectorAll('.rd-cal-hover-card')].map((card) => card.textContent);
        return titles.length === 2 && titles.some((title) => title.includes('区间甲')) && titles.some((title) => title.includes('区间乙'));
      }));
      await until("年历浮窗显示本地封面", () => run((sel) => [...document.querySelectorAll(sel + ' img')].some((img) => img.naturalWidth > 0), popupCard));
      check("浮窗采用大封面和下方文字", await run((sel) => {
        const first = document.querySelector(sel);
        const cover = first.querySelector('.rd-cal-hover-cover').getBoundingClientRect();
        const title = first.querySelector('.rd-cal-hover-t').getBoundingClientRect();
        return cover.width >= 95 && cover.height >= 135 && title.top >= cover.bottom;
      }, popupCard));
      const firstPosition = await hoverPosition();
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x - 6, y: point.y + 6, button: "none" });
      await until("浮窗跟随鼠标移动", async () => {
        const p = await hoverPosition();
        return p && (Math.abs(p.x - firstPosition.x) > 2 || Math.abs(p.y - firstPosition.y) > 2);
      });
      check("窗口右侧的浮窗仍在可视范围内", await run(() => {
        const tip = document.querySelector('.rd-cal-hover');
        const r = tip.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }));
      const press = { x: point.x - 6, y: point.y + 6, button: 'left', clickCount: 1 };
      await run(() => {
        window.calendarPreview = document.querySelector('.rd-cal-hover');
        window.calendarCover = window.calendarPreview.querySelector('img');
      });
      const samePreview = () => run(() => {
        const popup = document.querySelector('.rd-cal-hover');
        return popup === window.calendarPreview && popup.querySelector('img') === window.calendarCover;
      });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
      await wait(140);
      check("按住日期时浮窗保持可见", await samePreview() && !(await query(pinned)));
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
      await until("固定年历浮窗", () => query(pinned));
      check("固定时原浮窗和封面没有重建", await samePreview());
      await mouseClick(cell("2025-03-09"));
      check("再次点击同一日期不重建浮窗", await query(pinned) && await samePreview());
      const pinPosition = await hoverPosition();
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
      check("固定后鼠标移开浮窗不动", await query(pinned) && JSON.stringify(await hoverPosition()) === JSON.stringify(pinPosition));
      for (const type of ["mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, x: 4, y: 4, button: "left", clickCount: 1 });
      }
      await until("点空白关闭固定浮窗", async () => !(await query(popup)));
      const densePoint = await hoverPoint("2025-03-20");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...densePoint, button: "none" });
      await until("多书日期可预览", () => query(popupCard));
      await mouseClick(cell("2025-03-20"));
      await until("固定浮窗可访问同日全部 26 本", () => run((sel) => document.querySelectorAll(sel).length === 26, `${pinned} .rd-cal-hover-card`));
      check("年历保留当日完整书目", await evaluate("document.querySelectorAll('.rd-cal-book').length === 26"));
      check("年历连续阅读线只画真实区间，并区分重叠的书", await run(() => {
        const track = (day, id) => document.querySelector(`[data-day="2025-03-${day}"] .rd-cal-run[data-book="${id}"]`);
        return !track('02', 'a') && !!track('03', 'a') && !!track('07', 'a') && !!track('12', 'a') &&
          !track('13', 'a') && !!track('09', 'i') && !track('11', 'start') &&
          track('03', 'a').dataset.next === 'true' && track('04', 'a')?.dataset.prev === 'true' &&
          track('09', 'a')?.dataset.next === 'false' && track('10', 'a')?.dataset.prev === 'false';
      }));
      const firstColor = await trackColor("2025-03-09", "a");
      const secondColor = await trackColor("2025-03-09", "i");
      check("同月不同书颜色可区分，同一本书保持同色", !!firstColor && !!secondColor &&
        firstColor !== secondColor && await trackColor("2025-03-10", "a") === firstColor);
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
      await button("月历");
      await until("切换月历时关闭旧浮窗", async () => !(await query(popup)));
      await run(() => {
        const months = document.querySelector('select[aria-label="选择月份"]');
        months.value = "3";
        months.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await until("选择 2025 年 3 月", () => click(cell("2025-03-20")));
      check("月历底色也随起止状态和书本数加深", await checkShades());
      check("月历格只显示当天开始或读完的书名", await titlesOnEndpoints());
      check("同一本书在月历和年历线色一致", await trackColor("2025-03-09", "a") === firstColor);
      check("月历从固定浮窗查看同一天的全部 26 本", await run((sel) => document.querySelectorAll(sel).length === 26, `${pinned} .rd-cal-hover-card`));
      check("月历格里能看到书名和剩余数量", await run((sel) => {
        const cell = document.querySelector(sel);
        const visible = [...cell.querySelectorAll('.rd-cal-bk, .rd-cal-more')]
          .filter((el) => el.getClientRects().length > 0);
        const titles = visible.filter((el) => el.matches('.rd-cal-bk'));
        const remainder = visible.find((el) => el.matches('.rd-cal-more'));
        return titles.length > 0 && /同日测试书/.test(titles[0].textContent) &&
          Number(remainder?.textContent) + titles.length === 26 &&
          remainder.getBoundingClientRect().bottom <= cell.getBoundingClientRect().bottom;
      }, cell("2025-03-20")));
      await click(cell("2025-03-01"));
      await until("点空日期取消固定", async () => !(await query(popup)));
      await hoverMiddle();
      const dayFill = () => run((sel) => getComputedStyle(document.querySelector(sel)).backgroundColor, cell("2025-03-09"));
      const fillBeforeHover = await dayFill();
      const monthPoint = await hoverPoint("2025-03-09");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...monthPoint, button: "none" });
      await until("月历也显示带封面的两张浮动卡片", () => run((sel) => document.querySelectorAll(sel).length === 2 && [...document.querySelectorAll(sel + ' img')].some((img) => img.naturalWidth > 0), popupCard));
      check("悬停不盖掉日期原有底色", await dayFill() === fillBeforeHover);
      check("月历同一本书的线段跨过日期格缝隙", await run(() => {
        const track = (day) => document.querySelector(`.rd-cal-monthgrid [data-day="2025-03-${day}"] .rd-cal-run[data-book="a"]`)?.getBoundingClientRect();
        const first = track('03');
        const next = track('04');
        return !!first && !!next && Math.abs(first.right - next.left) < 1 && first.y === next.y;
      }));
      await mouseClick(cell("2025-03-09"));
      await until("月历同样能固定浮窗", () => query(pinned));
      const rangeA = `${pinned} .rd-cal-hover-card`;
      await run((sel) => [...document.querySelectorAll(sel)].find((card) => card.textContent.includes('区间甲')).click(), rangeA);
      await until("月历点浮窗内的书才开对应详情", () => query(".drawer.on .dhead-field input[value='区间甲']"));
      await click(".drawer.on .xbtn");
      await click(cell("2025-03-11"));
      check("月历将只填开始日的书计入当天", await dayCount("2025-03-11") === 4 && await run((sel) => {
        const cell = document.querySelector(sel);
        const titles = [...document.querySelectorAll('.rd-cal-hover[data-pinned="true"] .rd-cal-hover-card')].map((book) => book.textContent);
        return cell.querySelector('.rd-cal-bk')?.textContent === '只有开始日期' &&
          titles.length === 4 && titles.some((title) => title.includes('只有开始日期'));
      }, cell("2025-03-11")));
      await evaluate("(() => { const el = document.querySelector('.rd-cal-cell.sel'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true, cancelable:true })); })()");
      check("月历向下按一周移动焦点", await evaluate("document.activeElement.dataset.day") === "2025-03-18");
      await resize(1040, 640);
      const singleWindow = () => run(() => {
        const panel = document.querySelector('.rd-calscroll');
        const grid = document.querySelector('.rd-cal-monthgrid');
        const legend = document.querySelector('.rd-cal-monthview .rd-cal-legend');
        const last = document.querySelector('.rd-cal-monthgrid [data-day="2025-03-31"]');
        const pane = panel.getBoundingClientRect();
        return grid.getBoundingClientRect().top >= pane.top &&
          last.getBoundingClientRect().bottom <= legend.getBoundingClientRect().top &&
          legend.getBoundingClientRect().bottom <= pane.bottom + 1 &&
          panel.scrollHeight <= panel.clientHeight + 1 && panel.scrollWidth <= panel.clientWidth + 1;
      });
      check("六行月历和图例在最小窗口一次显示完", await singleWindow());
      await wheelAt('.rd-cal-monthgrid', 160);
      await until("滚轮向下切换下个月", async () => await monthValue() === "4");
      await wheelAt('.rd-cal-monthgrid', 120);
      check("同一次滚轮手势不连跳", await monthValue() === "4");
      await wait(220);
      await wheelAt('.rd-cal-monthgrid', -160);
      await until("滚轮向上切换上个月", async () => await monthValue() === "3");
      check("滚轮翻回后月历仍完整显示", await singleWindow());
      await resize(900, 680);
      check("900 像素宽窗口仍显示整月", await singleWindow());
      await resize(740, 680);
      check("窄窗月历仍有七列且不横溢出", await evaluate("(() => { const el = document.querySelector('.rd-cal-monthgrid'); return getComputedStyle(el).gridTemplateColumns.split(' ').length === 7 && el.getBoundingClientRect().right <= innerWidth; })()"));
      await click(cell("2025-03-20"));
      await until("窄窗口固定浮窗", () => query(pinned));
      check("窄窗的多书浮窗只需竖向滚动", await run((sel) => {
        const pop = document.querySelector(sel);
        const body = pop.querySelector('.rd-cal-hover-body');
        const rect = pop.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight &&
          body.scrollHeight > body.clientHeight && body.scrollWidth <= body.clientWidth + 1;
      }, pinned));
      await wheelAt(`${pinned} .rd-cal-hover-body`, 170);
      await until("浮窗内滚轮滚动完整书目", () => run((sel) => document.querySelector(sel)?.scrollTop > 0, `${pinned} .rd-cal-hover-body`));
      check("浮窗滚轮不会翻月", await monthValue() === "3");
      await button("全年");
      check("窄窗年历改为两列且无横向溢出", await run(() => {
        const page = document.querySelector('.rd-calscroll');
        const grid = document.querySelector('.rd-cal-yeargrid');
        const months = [...grid.querySelectorAll('.rd-cal-year-month')];
        const [jan, feb, march] = months.map((month) => month.getBoundingClientRect());
        return jan.y === feb.y && march.y > jan.y &&
          grid.scrollWidth <= grid.clientWidth + 1 && page.scrollWidth <= page.clientWidth + 1;
      }));
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
      const top = () => evaluate("document.querySelector('.rd-vbooks').scrollTop");
      const atBottom = () => evaluate("(() => { const el = document.querySelector('.rd-vbooks'); return el.scrollHeight - el.clientHeight - el.scrollTop < 2; })()");
      await evaluate("document.querySelector('.rd-vbooks').scrollTop = 0");
      await booksWheel(160);
      await until("先在同一个月内向下滚动", async () => await top() > 0 && await query('.rd-vgroup[data-day="2025-03-20"]'));
      await evaluate("document.querySelector('.rd-vbooks').scrollTop = document.querySelector('.rd-vbooks').scrollHeight");
      await until("抵达月内底部", atBottom);
      await booksWheel(160);
      await until("月末继续下滚翻到下月", async () => (await timelineDay())?.startsWith("2025-04") && await query(".rd-vempty"));
      await booksWheel(140);
      check("同一滚轮手势尾波没有连跳", (await timelineDay())?.startsWith("2025-04"));
      await wait(300);
      await booksWheel(-160);
      await until("月初上滚回上月末", async () => await query('.rd-vgroup[data-day="2025-03-20"]') && await atBottom());
    }

    if (wants("h")) {
      await locate("横排", "2025-03-20");
      const denseCovers = '.rd-hcover[data-id^="dense-"]';
      await until("横排默认显示大封面", () => run((sel) => {
        const covers = [...document.querySelectorAll(sel)];
        return covers.length >= 2 && covers.some((el) => el.getBoundingClientRect().width >= 90);
      }, denseCovers));
      await until("真实封面图片可用", () => run((sel) => [...document.querySelectorAll(sel + " img")].some((img) => img.naturalWidth > 0), denseCovers));
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
      const overlap = await until("每叠封面有可悬停的露边", () => run((sel) => {
        const cards = [...document.querySelectorAll(sel)].map((el) => ({ el, r: el.getBoundingClientRect() }));
        for (const { el, r } of cards) {
          const y = r.top + r.height / 2;
          const edge = [0.09, 0.22, 0.78, 0.91].map((p) => r.left + r.width * p)
            .find((x) => el.contains(document.elementFromPoint(x, y)));
          if (edge == null) continue;
          for (const other of cards) {
            if (other.el === el || y < other.r.top || y >= other.r.bottom) continue;
            const left = Math.max(r.left, other.r.left);
            const right = Math.min(r.right, other.r.right);
            if (right - left < 8) continue;
            const x = (left + right) / 2;
            if (other.el.contains(document.elementFromPoint(x, y))) {
              return { id: el.dataset.id, edge: { x: edge, y }, overlap: { x, y } };
            }
          }
        }
        return null;
      }, denseCovers));
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...overlap.edge, button: "none" });
      await until("悬停的封面盖到相邻封面上方", () => run((point, id) => document.elementFromPoint(point.x, point.y)?.closest('.rd-hcover')?.dataset.id === id, overlap.overlap, overlap.id));
      for (const type of ["mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, ...overlap.edge, button: "left", clickCount: 1 });
      }
      await until("叠放封面用真实点击打开对应作品", () => query(".drawer.on .dhead-field input[value='同日测试书 " + overlap.id.slice(6) + "']"));
      await click(".drawer.on .xbtn");
      await mouseClick(".rd-hcover-more");
      await until("叠放的数量按钮可打开未露出的书目", () => evaluate("[...document.querySelectorAll('.rd-hpanel-row')].some(el => el.textContent.includes('同日测试书 26'))"));
      await click('[aria-label="关闭书目"]');
      await click('[aria-label="放大"]');
      await mouseClick('.rd-hagg.month[data-day="2025-03-01"]');
      await until("横排按日展示", () => query('.rd-hagg.day[data-day="2025-03-20"]'));
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
