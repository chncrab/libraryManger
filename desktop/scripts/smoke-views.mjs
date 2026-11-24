/*
 * 自定义书库视图冒烟。先 npm run build，再 node scripts/smoke-views.mjs（或 npm run smoke:views）。
 * 自己生成一份小合成书库，起独立 Electron 实例，跑完连同 profile 一起删掉，不碰真实书库。
 * 覆盖：默认标签与「全部」、四个预设范围、新增表格/书架、系列名与成员筛选、
 * 预设与临时关键词 AND、临时条件隔离、编辑/拖动/确认删除与取消、顺序与删除持久化、
 * 删空只剩「全部」、以及两个书库的配置互不影响。
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
const STAMP = "2025-01-01T00:00:00Z";

if (process.argv[2] === seedFlag) {
  seed(process.argv[3]);
} else {
  await smoke();
}

/* 合成库的规模是固定的，断言里直接写数字：
   小说 8 本（银河英雄传说 2 本、星海纪行 2 本、无读系列 2 本、单本 2 本），
   漫画 3 本（苍蓝钢铁 2 本、单本 1 本），共 11 本；小说系列 3 个，漫画系列 1 个。 */
function seed(work) {
  const { openDb, closeDb } = require("../dist-electron/electron/db/index.js");
  const library = path.join(work, "library");
  const empty = path.join(work, "empty-library");

  const db = openDb(path.join(library, "library.db"));
  const addSeries = db.prepare("INSERT INTO series (media_type, name, zh_name) VALUES (?, ?, ?)");
  const addBook = db.prepare(
    `INSERT INTO books
       (id, title, media_type, series_id, series_index, is_read, read_start, read_date, rating, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addCat = db.prepare("INSERT INTO categories (name, tier, ord, parent_id) VALUES (?, ?, ?, ?)");
  const link = db.prepare("INSERT INTO book_categories (book_id, category_id) VALUES (?, ?)");

  db.transaction(() => {
    const topic = db.prepare("SELECT id FROM categories WHERE name = ?").get("题材").id;
    const mystery = addCat.run("推理", 1, 0, topic).lastInsertRowid;
    const scifi = addCat.run("科幻", 1, 1, topic).lastInsertRowid;

    const ginga = addSeries.run("小说", "Ginga Eiyuu Densetsu", "银河英雄传说").lastInsertRowid;
    const hoshi = addSeries.run("小说", "星海纪行", "").lastInsertRowid;
    const nothing = addSeries.run("小说", "无读系列", "").lastInsertRowid;
    const aoki = addSeries.run("漫画", "Aoki Hagane", "苍蓝钢铁").lastInsertRowid;

    const add = (id, title, media, seriesId, index, read, rating, cats) => {
      addBook.run(
        id,
        title,
        media,
        seriesId,
        index,
        read ? 1 : 0,
        read ? "2025-01-01" : "",
        read ? "2025-01-05" : "",
        rating,
        STAMP,
        STAMP
      );
      for (const c of cats) link.run(id, c);
    };

    add("n1", "银河英雄传说 1 黎明篇", "小说", ginga, 1, true, 9, [scifi]);
    add("n2", "银河英雄传说 2 野望篇", "小说", ginga, 2, false, null, [scifi]);
    add("n3", "星海孤舟", "小说", null, null, true, 8, [mystery]);
    add("n4", "星海回响", "小说", null, null, false, null, [mystery]);
    add("n5", "星海纪行 前篇", "小说", hoshi, 1, true, 6, [mystery]);
    add("n6", "星海纪行 后篇", "小说", hoshi, 2, false, null, [scifi]);
    add("n7", "无读系列 一", "小说", nothing, 1, false, null, []);
    add("n8", "无读系列 二", "小说", nothing, 2, false, null, []);
    add("m1", "苍蓝钢铁 1", "漫画", aoki, 1, true, 7, [scifi]);
    add("m2", "苍蓝钢铁 2", "漫画", aoki, 2, false, null, []);
    add("m3", "星海漫画短篇", "漫画", null, null, false, null, [mystery]);
  })();
  closeDb();

  /* 第二个库只建库不铺书，用来验空库也有五个标签、配置各存各的 */
  const other = openDb(path.join(empty, "library.db"));
  closeDb();
  assert(!!other || fs.existsSync(path.join(empty, "library.db")), "空书库没建出来");
}

async function smoke() {
  const port = Number(process.env.CDP_PORT || 9341);
  const address = "http://127.0.0.1:" + port;
  const electron = require("electron");

  let inUse = false;
  try {
    inUse = (await fetch(address + "/json/version", { signal: AbortSignal.timeout(1200) })).ok;
  } catch {}
  assert(!inUse, "调试端口已被占用 " + port);

  const dataDir = fs.realpathSync(root);
  const work = fs.mkdtempSync(path.join(dataDir, ".smoke-views-"));
  const library = path.join(work, "library");
  const empty = path.join(work, "empty-library");
  const env = { ...process.env, BOOKLIB_ROOT: library };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;

  let app = null;

  const launch = async () => {
    const child = spawn(
      electron,
      [
        ".",
        "--user-data-dir=" + path.join(work, "profile"),
        "--remote-debugging-port=" + port,
        "--disable-gpu",
        "--in-process-gpu",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling"
      ],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    let logs = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        logs = (logs + chunk).slice(-6000);
      });
    }

    const until = async (label, read, timeout = 8000) => {
      const limit = Date.now() + timeout;
      while (Date.now() < limit) {
        let result;
        try {
          result = await read();
        } catch {
          /* 页面重载或上下文切换时读一次失败，继续等 */
          result = null;
        }
        if (result) return result;
        if (child.exitCode != null) throw new Error("Electron 提前退出 " + child.exitCode + "\n" + logs);
        await wait(80);
      }
      throw new Error("等待超时 " + label + "\n" + logs);
    };

    const page = await until(
      "Electron 就绪",
      async () => {
        const response = await fetch(address + "/json/list", { signal: AbortSignal.timeout(1200) });
        return (await response.json()).find((entry) => entry.type === "page");
      },
      20000
    );

    const socket = new WebSocket(page.webSocketDebuggerUrl);
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
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error("调试命令超时 " + method));
        }, 8000);
        pending.set(request, (message) => {
          clearTimeout(timer);
          pending.delete(request);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id: request, method, params }));
      });
    const js = async (expression) => {
      const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    };
    const run = (fn, ...values) => js("(" + fn.toString() + ")(..." + JSON.stringify(values) + ")");

    const close = async () => {
      try {
        socket.close();
      } catch {}
      if (child.pid && child.exitCode == null) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          child.kill();
        }
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), wait(8000)]);
      }
      for (let i = 0; i < 80; i++) {
        try {
          const response = await fetch(address + "/json/version", { signal: AbortSignal.timeout(500) });
          if (!response.ok) return;
        } catch {
          return;
        }
        await wait(100);
      }
    };

    await call("Runtime.enable");
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    await call("Emulation.setDeviceMetricsOverride", { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });

    return { child, socket, call, js, run, until, exceptions, close, logs: () => logs };
  };

  const js = (expression) => app.js(expression);
  const run = (fn, ...values) => app.run(fn, ...values);
  const until = (label, read, timeout) => app.until(label, read, timeout);
  const query = (selector) => run((sel) => Boolean(document.querySelector(sel)), selector);
  const count = (selector) => run((sel) => document.querySelectorAll(sel).length, selector);

  const check = (label, value, extra = "") => {
    assert(value, "断言失败：" + label + (extra ? "（" + extra + "）" : ""));
    console.log("PASS " + label + (extra ? "  " + extra : ""));
  };
  const checkNoExceptions = () => check("渲染进程无异常", app.exceptions.length === 0);

  const BOOK_ROWS = ".table:not(.sertable) tbody tr";
  const SERIES_ROWS = ".sertable tbody tr";

  const tabNames = () => run(() => [...document.querySelectorAll(".viewtabs .vt-tab .vt-name")].map((e) => e.textContent.trim()));
  const viewsApi = () => run(async () => await window.api.views());
  const activeTab = () => run(() => document.querySelector(".viewtabs .vt-tab.on .vt-name")?.textContent?.trim() || "");
  const cardTitles = () => run(() => [...document.querySelectorAll(".card .t")].map((e) => e.textContent.trim()));
  const scardTitles = () => run(() => [...document.querySelectorAll(".scard .st")].map((e) => e.textContent.trim()));
  const totalText = () => run(() => (document.querySelector(".toolbar") || {}).textContent || "");

  const clickTab = async (name) => {
    const found = await run((n) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab")].find((t) => (t.querySelector(".vt-name") || {}).textContent?.trim() === n);
      if (!tab) return false;
      tab.click();
      return true;
    }, name);
    assert(found, "标签栏里没有「" + name + "」");
    await until("切到标签「" + name + "」", async () => (await activeTab()) === name);
  };

  const tabGesture = (name, event, button) =>
    run((n, type, whichButton) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab")].find((t) => t.querySelector(".vt-name")?.textContent?.trim() === n);
      if (!tab) return false;
      tab.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: whichButton }));
      return true;
    }, name, event, button);

  const requestTabDelete = async (name, button = 0) => {
    assert(await tabGesture(name, button === 1 ? "auxclick" : "dblclick", button), "找不到标签「" + name + "」");
    await until("删除确认框", () => query(".cfm"));
  };

  const confirmDialog = (okay) =>
    run((yes) => {
      const box = document.querySelector(".cfm");
      if (!box) return false;
      const button = [...box.querySelectorAll(".cfm-b .mini")].find((b) =>
        yes ? b.classList.contains("danger") : b.textContent.trim() === "取消"
      );
      if (!button) return false;
      button.click();
      return true;
    }, okay);

  const openTabMenu = async (name) => {
    const found = await run((n) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab.custom")].find((t) => (t.querySelector(".vt-name") || {}).textContent?.trim() === n);
      if (!tab) return false;
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 })
      );
      return true;
    }, name);
    assert(found, "找不到标签「" + name + "」");
    await until("视图右键菜单", () => query(".ctx-i"));
  };

  const menuItem = (text) =>
    run((label) => {
      const item = [...document.querySelectorAll(".ctx-i")].find((e) => e.textContent.trim() === label);
      if (!item) return false;
      item.click();
      return true;
    }, text);

  const setSearch = async (text) => {
    const ok = await run((value) => {
      const input = document.querySelector(".search");
      if (!input) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, text);
    assert(ok, "顶栏没有搜索框");
    await wait(500);
  };
  const searchValue = () => run(() => document.querySelector(".search")?.value ?? null);

  const clickRowButton = async (label, text) => {
    const ok = await run((rowLabel, rowText) => {
      const rows = [...document.querySelectorAll(".cadmin.vp .vp-row")];
      const row = rows.find((r) => (r.querySelector(".vp-l") || {}).textContent?.trim() === rowLabel);
      const button = row && [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === rowText);
      if (!button) return false;
      button.click();
      return true;
    }, label, text);
    assert(ok, "视图弹窗找不到「" + label + " / " + text + "」");
    await wait(120);
  };
  const setRowInput = async (label, value) => {
    const ok = await run((rowLabel, rowValue) => {
      const rows = [...document.querySelectorAll(".cadmin.vp .vp-row")];
      const row = rows.find((r) => (r.querySelector(".vp-l") || {}).textContent?.trim() === rowLabel);
      const input = row && row.querySelector("input");
      if (!input) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, rowValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, label, value);
    assert(ok, "视图弹窗找不到输入框「" + label + "」");
    await wait(100);
  };
  const rowInputValue = (label) =>
    run((rowLabel) => {
      const rows = [...document.querySelectorAll(".cadmin.vp .vp-row")];
      const row = rows.find((r) => (r.querySelector(".vp-l") || {}).textContent?.trim() === rowLabel);
      return row?.querySelector("input")?.value ?? "";
    }, label);
  const setRowSelect = async (label, value) => {
    const ok = await run((rowLabel, rowValue) => {
      const rows = [...document.querySelectorAll(".cadmin.vp .vp-row")];
      const row = rows.find((r) => (r.querySelector(".vp-l") || {}).textContent?.trim() === rowLabel);
      const select = row && row.querySelector("select");
      if (!select) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      set.call(select, rowValue);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, label, value);
    assert(ok, "视图弹窗找不到下拉「" + label + "」");
    await wait(100);
  };

  const createView = async ({ preset, name, unit, layout, keywords, read }) => {
    await until("新建视图按钮可用", () =>
      run(() => {
        const button = document.querySelector(".vt-plus");
        return !!button && !button.disabled;
      })
    );
    await run(() => document.querySelector(".vt-plus").click());
    await until("新建视图弹窗", () => query(".cadmin.vp"));
    if (preset) await clickRowButton("预设", preset);
    if (unit) await clickRowButton("对象", unit);
    if (layout) await clickRowButton("布局", layout);
    await setRowInput("名称", name);
    if (keywords !== undefined) await setRowInput("预设关键词", keywords);
    if (read) await setRowSelect("阅读状态", read);
    const saved = await run(() => {
      const button = [...document.querySelectorAll(".cadmin.vp .vp-foot .mini")].find((b) => b.textContent.trim() === "保存");
      if (!button) return false;
      button.click();
      return true;
    });
    assert(saved, "视图弹窗没有保存按钮");
    await until(
      "视图保存并选中「" + name + "」",
      async () => (await tabNames()).includes(name) && (await activeTab()) === name,
      10000
    );
    const error = await run(() => (document.querySelector(".cadmin.vp .vp-err") || {}).textContent || "");
    check("视图「" + name + "」保存成功", error === "", error);
  };

  const dragTab = async (from, to) => {
    const started = await run((fromName) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab.custom")].find((t) => (t.querySelector(".vt-name") || {}).textContent?.trim() === fromName);
      if (!tab) return false;
      window.__viewDrag = new DataTransfer();
      tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: window.__viewDrag }));
      return true;
    }, from);
    assert(started, "拖动起点「" + from + "」不存在");
    await wait(150);
    await run((toName) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab.custom")].find((t) => (t.querySelector(".vt-name") || {}).textContent?.trim() === toName);
      if (!tab) return false;
      tab.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__viewDrag }));
      return true;
    }, to);
    await wait(150);
    await run((toName) => {
      const tab = [...document.querySelectorAll(".viewtabs .vt-tab.custom")].find((t) => (t.querySelector(".vt-name") || {}).textContent?.trim() === toName);
      if (!tab) return false;
      tab.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__viewDrag }));
      return true;
    }, to);
  };

  const reload = async () => {
    await js("setTimeout(() => location.reload(), 0)");
    await wait(600);
    await until("页面重新载入", async () => (await run(() => document.readyState)) === "complete", 15000);
    await until("标签栏重新出现", () => query(".viewtabs"), 15000);
  };

  const waitForApp = async () => {
    await until("标签栏出现", () => query(".viewtabs"), 15000);
    await until("视图配置载入", () => query(".vt-plus:not(:disabled)"), 10000);
  };

  try {
    const seedRun = spawnSync(electron, [fileURLToPath(import.meta.url), seedFlag, work], {
      cwd: root,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      windowsHide: true
    });
    assert(
      seedRun.status === 0 && fs.existsSync(path.join(library, "library.db")) && fs.existsSync(path.join(empty, "library.db")),
      seedRun.stderr || seedRun.error?.message || "合成库生成失败"
    );

    app = await launch();
    await waitForApp();

    /* ---- 一、默认清单与「全部」 ---- */
    const defaults = await tabNames();
    check(
      "新库初始化五个标签",
      defaults.join("|") === "全部|小说|漫画|系列小说|系列漫画",
      defaults.join(" / ")
    );
    check("标签上没有删除叉号", !(await query(".vt-x")));
    const chrome = await run(() => {
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      const tab = rect(".vt-all .vt-tab");
      const last = rect(".vt-scroll .vt-tab:last-child");
      const plus = rect(".vt-plus");
      const row = rect(".viewtabs");
      const search = rect(".topbar .search");
      const safe = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      return {
        aligned: Math.abs(tab.height - plus.height) < 1 && Math.abs(tab.top - plus.top) < 1,
        nextToTabs: plus.left >= last.right && plus.left - last.right <= 10,
        searchBelow: search.top >= row.bottom && search.left < 30,
        overlay: !!navigator.windowControlsOverlay?.visible && !!safe && plus.right < safe.right && safe.right < innerWidth
      };
    });
    check("加号与标签等高并紧跟最后一个标签", chrome.aligned && chrome.nextToTabs);
    check("搜索在第二行左侧", chrome.searchBelow);
    if (process.platform === "win32") check("标签避开 Windows 原生窗口按钮", chrome.overlay);
    await until("全部默认表格", async () => (await count(BOOK_ROWS)) === 11, 10000);
    const allTitles = await run(() => [...document.querySelectorAll(".table:not(.sertable) tbody td.title")].map((e) => e.textContent.trim()));
    check("「全部」表格含所有媒介", allTitles.includes("银河英雄传说 1 黎明篇") && allTitles.includes("苍蓝钢铁 1"));
    check("「全部」工具栏计数一致", (await totalText()).includes("共 11 本"), await totalText());
    await run(() =>
      document.querySelector(".vt-all .vt-tab").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 90 })
      )
    );
    await wait(250);
    check("「全部」不弹视图菜单", (await query(".ctx-i")) === false);
    await tabGesture("全部", "dblclick", 0);
    await tabGesture("全部", "auxclick", 1);
    check("「全部」对双击和中键都不弹删除确认", !(await query(".cfm")));

    const fixedRejected = await run(async () => {
      const r = await window.api.saveViews([
        { id: "all", name: "全部", unit: "book", layout: "table", filter: { media: "", keywords: [], categories: [], read: "all" }, ord: 0 }
      ]);
      return r.ok;
    });
    check("固定 ID 不能写进配置", fixedRejected === false);
    check("失败的写入没有动原配置", (await viewsApi()).views.length === 4);

    /* ---- 二、四个预设范围 ---- */
    await clickTab("小说");
    await until("小说书架 8 张卡", async () => (await count(".card")) === 8, 10000);
    const novels = await cardTitles();
    check("小说预设含系列里的单册", novels.includes("银河英雄传说 1 黎明篇"));
    check("小说预设不含漫画", !novels.some((t) => t.includes("苍蓝")));

    await clickTab("漫画");
    await until("漫画书架 3 张卡", async () => (await count(".card")) === 3, 10000);
    check("漫画预设只出漫画", (await totalText()).includes("共 3 本"), await totalText());

    await clickTab("系列小说");
    await until("系列小说 3 个系列", async () => (await count(".scard")) === 3, 10000);
    const novelSeries = await scardTitles();
    check("系列小说按系列聚合", novelSeries.includes("银河英雄传说") && novelSeries.includes("星海纪行") && novelSeries.includes("无读"));
    check("系列小说不含漫画系列", !novelSeries.some((t) => t.includes("苍蓝")));

    await clickTab("系列漫画");
    await until("系列漫画 1 个系列", async () => (await count(".scard")) === 1, 10000);
    check("系列漫画只出漫画系列", (await scardTitles()).includes("苍蓝钢铁"));

    await clickTab("全部");
    await until("回到全部表格", async () => (await count(BOOK_ROWS)) === 11, 10000);

    /* ---- 三、新增单册表格与系列表格 ---- */
    await createView({ preset: "小说", name: "甲单册表格", layout: "表格" });
    await until("甲表格 8 行", async () => (await count(BOOK_ROWS)) === 8, 10000);
    check("新增单册表格沿用列与范围", (await totalText()).includes("共 8 本"), await totalText());

    await createView({ preset: "系列小说", name: "乙系列表格", layout: "表格" });
    await until("乙表格 3 行", async () => (await count(SERIES_ROWS)) === 3, 10000);
    const heads = await run(() => [...document.querySelectorAll(".sertable thead th")].map((e) => e.textContent.trim()));
    check("系列表格列出约定的五列", heads.join("|") === "系列名|原名|册数|已读|均分", heads.join("|"));
    const firstCells = await run(() => [...document.querySelectorAll(".sertable tbody tr:first-child td")].map((e) => e.textContent.trim()));
    check("系列表格一行五格，册数与已读是数字", firstCells.length === 5 && /^\d+$/.test(firstCells[2]) && /^\d+$/.test(firstCells[3]), firstCells.join(" / "));
    await run(() => document.querySelector(".sertable tbody tr").click());
    await until("点行打开系列详情", () => query(".drawer.on"), 8000);
    check("系列详情标题非空", (await run(() => (document.querySelector(".drawer.on .dh h2") || {}).textContent || "")).length > 0);
    await run(() => document.querySelector(".drawer.on .xbtn").click());
    await until("关闭系列详情", async () => (await query(".drawer.on")) === false);

    /* ---- 四、预设关键词与临时关键词 AND ---- */
    await createView({ preset: "小说", name: "丙星海", keywords: "星海" });
    await until("丙预设关键词命中 4 本", async () => (await count(".card")) === 4, 10000);
    const presetChips = await run(() => [...document.querySelectorAll(".chip.preset")].map((e) => e.textContent.trim()));
    check("预设关键词进入视图后仍是条件", presetChips.some((t) => t.includes("预设关键词 星海")), presetChips.join("|"));

    await setSearch("回响");
    await until("预设与临时关键词同时命中 1 本", async () => (await count(".card")) === 1, 10000);
    check("AND 结果只剩星海回响", (await cardTitles()).join("") === "星海回响", (await cardTitles()).join("/"));

    await setSearch("银河");
    await until("两组关键词不相交时为空", async () => (await count(".card")) === 0, 10000);
    check("空结果给出提示", await run(() => document.body.textContent.includes("没有符合条件的书")));
    await setSearch("钢铁");
    await until("媒介外的关键词仍为空", async () => (await count(".card")) === 0, 10000);
    await setSearch("");
    await until("清空临时词回到预设 4 本", async () => (await count(".card")) === 4, 10000);

    /* ---- 五、临时条件按标签隔离 ---- */
    await setSearch("回响");
    await until("丙临时词生效", async () => (await count(".card")) === 1, 10000);
    await clickTab("全部");
    await until("全部标签没有继承临时词", async () => (await searchValue()) === "" && (await count(BOOK_ROWS)) === 11, 10000);
    await clickTab("小说");
    await until("小说标签也没有继承", async () => (await searchValue()) === "" && (await count(".card")) === 8, 10000);
    await clickTab("丙星海");
    await until("切回丙时临时词还在", async () => (await searchValue()) === "回响" && (await count(".card")) === 1, 10000);
    check("临时条件没有写回视图配置", (await viewsApi()).views.find((v) => v.name === "丙星海").filter.keywords.join(" ") === "星海");
    await setSearch("");
    await until("清空丙的临时词", async () => (await count(".card")) === 4, 10000);

    /* ---- 六、系列名与成员筛选 ---- */
    await createView({ preset: "系列小说", name: "丁已读系列", read: "read" });
    await until("已读系列只剩 2 个", async () => (await count(".scard")) === 2, 10000);
    const readSeries = await scardTitles();
    check("成员筛选保留有已读册的系列", readSeries.includes("银河英雄传说") && readSeries.includes("星海纪行"), readSeries.join("/"));
    check("成员筛选去掉全未读的系列", !readSeries.includes("无读"));

    await openTabMenu("丁已读系列");
    const menuTexts = await run(() => [...document.querySelectorAll(".ctx-i")].map((e) => e.textContent.trim()));
    check("标签右键菜单只提供编辑", menuTexts.join("|") === "编辑视图", menuTexts.join("|"));
    assert(await menuItem("编辑视图"), "点不到「编辑视图」");
    await until("编辑视图弹窗", () => query(".cadmin.vp"));
    check("编辑弹窗带回原名称", (await rowInputValue("名称")) === "丁已读系列", await rowInputValue("名称"));
    await setRowInput("名称", "丁已读系列改");
    await setRowInput("预设关键词", "星海");
    await run(() => [...document.querySelectorAll(".cadmin.vp .vp-foot .mini")].find((b) => b.textContent.trim() === "保存").click());
    await until("编辑后标签改名", async () => (await activeTab()) === "丁已读系列改", 10000);
    await until("编辑后的规则生效", async () => (await count(".scard")) === 1, 10000);
    check("系列预设关键词与成员条件同时生效", (await scardTitles()).join("") === "星海纪行", (await scardTitles()).join("/"));

    await setSearch("银河");
    await until("系列预设与临时词不相交", async () => (await count(".scard")) === 0, 10000);
    await setSearch("纪行");
    await until("系列预设与临时词相交", async () => (await count(".scard")) === 1, 10000);
    await setSearch("");
    await until("清空系列临时词", async () => (await count(".scard")) === 1, 10000);
    await clickTab("系列小说");
    await setSearch("苍蓝");
    await until("非系列预设里搜不到漫画系列", async () => (await count(".scard")) === 0, 10000);
    await setSearch("");
    await until("系列小说恢复 3 个", async () => (await count(".scard")) === 3, 10000);

    await clickTab("系列漫画");
    await setSearch("银河");
    await until("系列漫画不受小说系列关键词影响", async () => (await count(".scard")) === 0, 10000);
    await setSearch("Aoki");
    await until("系列原名能搜到", async () => (await count(".scard")) === 1, 10000);
    await setSearch("苍蓝");
    await until("系列译名能搜到", async () => (await count(".scard")) === 1, 10000);
    await setSearch("");
    await until("清空系列关键词", async () => (await count(".scard")) === 1, 10000);

    /* ---- 七、拖动、取消删除、确认删除 ---- */
    await dragTab("丙星海", "甲单册表格");
    await until(
      "拖动后顺序",
      async () =>
        (await tabNames()).join("|") === "全部|小说|漫画|系列小说|系列漫画|丙星海|甲单册表格|乙系列表格|丁已读系列改",
      10000
    );
    check("拖动没有动四个预设", (await tabNames()).slice(0, 5).join("|") === "全部|小说|漫画|系列小说|系列漫画");

    await clickTab("丙星海");
    await until("丙星海仍能打开", async () => (await count(".card")) === 4, 10000);
    const beforeDelete = (await viewsApi()).views.length;
    await requestTabDelete("丙星海");
    check("删除弹窗写着视图名", (await run(() => (document.querySelector(".cfm") || {}).textContent || "")).includes("丙星海"));
    assert(await confirmDialog(false), "点不到取消");
    await until("取消后弹窗收起", async () => (await query(".cfm")) === false);
    check("取消删除保留标签", (await tabNames()).includes("丙星海") && (await viewsApi()).views.length === beforeDelete);

    await requestTabDelete("丙星海", 1);
    assert(await confirmDialog(true), "点不到确认删除");
    await until("确认后标签消失", async () => !(await tabNames()).includes("丙星海"), 10000);
    await until("删除当前标签后选中右侧", async () => (await activeTab()) === "甲单册表格", 10000);
    check("确认删除只少一条配置", (await viewsApi()).views.length === beforeDelete - 1);
    check("删视图不动书", (await run(async () => (await window.api.listBooks({ limit: 1 })).total)) === 11);

    await clickTab("丁已读系列改");
    await requestTabDelete("丁已读系列改");
    assert(await confirmDialog(true), "点不到确认删除");
    await until("删除末位后选中左侧", async () => (await activeTab()) === "乙系列表格", 10000);
    check(
      "删除末位标签后顺序正确",
      (await tabNames()).join("|") === "全部|小说|漫画|系列小说|系列漫画|甲单册表格|乙系列表格",
      (await tabNames()).join(" / ")
    );
    await requestTabDelete("甲单册表格", 1);
    assert(await confirmDialog(true), "点不到确认删除");
    await until("后台标签被删除", async () => !(await tabNames()).includes("甲单册表格"), 10000);
    check("中键删除后台标签保留当前页", (await activeTab()) === "乙系列表格");

    /* ---- 八、顺序与删除落到配置 ---- */
    const namesBefore = await tabNames();
    const orderBefore = (await viewsApi()).views.map((v) => v.name);
    checkNoExceptions();
    await app.close();
    app = await launch();
    await waitForApp();
    await until("重启后全部表格", async () => (await count(BOOK_ROWS)) === 11, 15000);
    check("重启后标签顺序不变", (await tabNames()).join("|") === namesBefore.join("|"), (await tabNames()).join(" / "));
    check("重启后配置顺序不变", (await viewsApi()).views.map((v) => v.name).join("|") === orderBefore.join("|"));
    check("重启默认打开全部", (await activeTab()) === "全部");
    await clickTab("乙系列表格");
    await until("重启后系列表格仍可用", async () => (await count(SERIES_ROWS)) === 3, 10000);

    /* ---- 九、两个书库的配置互不影响 ---- */
    const switched = await run(async (rootPath) => JSON.stringify(await window.api.openLibrary(rootPath)), empty);
    check("切到空书库", JSON.parse(switched).ok === true, switched);
    await reload();
    await waitForApp();
    check("空库同样初始化五个标签", (await tabNames()).join("|") === "全部|小说|漫画|系列小说|系列漫画");
    check("空库没有任何书", (await run(async () => (await window.api.listBooks({ limit: 1 })).total)) === 0);
    check("空库显示空库引导", await query(".emptyguide"));
    check("空库视图配置是首次初始化", (await viewsApi()).views.length === 4);
    await createView({ preset: "漫画", name: "乙库视图" });
    check("空库里能建独立视图", (await tabNames()).includes("乙库视图"));

    const back = await run(async (rootPath) => JSON.stringify(await window.api.openLibrary(rootPath)), library);
    check("切回原书库", JSON.parse(back).ok === true, back);
    await reload();
    await waitForApp();
    await until("原书库表格回来", async () => (await count(BOOK_ROWS)) === 11, 15000);
    check("另一个书库的标签没有跟过来", !(await tabNames()).includes("乙库视图"), (await tabNames()).join(" / "));
    check("原书库的已保存视图与后台删除都保留", !(await tabNames()).includes("甲单册表格") && (await tabNames()).includes("乙系列表格"));

    /* ---- 十、删空自定义视图，重启仍只见「全部」 ---- */
    const cleared = await run(async () => (await window.api.saveViews([])).ok);
    check("能整排清空视图", cleared === true);
    await reload();
    await waitForApp();
    await until("只剩全部", async () => (await tabNames()).join("") === "全部", 10000);
    check("删空后配置状态是 empty", (await viewsApi()).status === "empty");
    await until("删空后全部仍显示所有书", async () => (await count(BOOK_ROWS)) === 11, 10000);

    await app.close();
    app = await launch();
    await waitForApp();
    await until("重开后只剩全部", async () => (await count(BOOK_ROWS)) === 11, 15000);
    check("删空后重开不补预设", (await tabNames()).join("|") === "全部", (await tabNames()).join(" / "));
    check("删空后重开配置仍为空", (await viewsApi()).status === "empty");

    /* ---- 十一、书库和书评共用搜索位置，各自搜索 ---- */
    const created = await run(async () => Promise.all([
      window.api.createReview({ bookId: "n1", md: "窗口测试唯一正文" }),
      window.api.createReview({ bookId: "m1", md: "另一篇合成书评" })
    ]));
    check("创建合成书评", created.every((r) => r.ok));
    await setSearch("星海");
    await until("书库关键词生效", async () => (await count(BOOK_ROWS)) === 5, 10000);
    const openPage = (label) => run((name) => {
      const button = [...document.querySelectorAll(".topbar .seg button")].find((b) => b.textContent.trim() === name);
      if (!button) return false;
      button.click();
      return true;
    }, label);
    assert(await openPage("书评"), "找不到书评入口");
    await until("书评列表加载", async () => (await count(".rvi")) === 2, 10000);
    check("书评仅保留第二行搜索框", (await count(".topbar .search[aria-label='搜索书评']")) === 1 && !(await query(".rvs-q")));
    await setSearch("测试唯一正文");
    await until("书评正文关键词生效", async () => (await count(".rvi")) === 1, 10000);
    check("按正文过滤出对应书评", (await run(() => document.querySelector(".rvi-t").textContent)).includes("银河英雄传说"));
    assert(await openPage("阅读"), "找不到阅读入口");
    await until("阅读页无通用搜索框", async () => !(await query(".topbar .search")));
    await clickTab("全部");
    await until("切回书库时临时搜索保留", async () => (await count(BOOK_ROWS)) === 5 && (await searchValue()) === "星海", 10000);
    checkNoExceptions();

    console.log("\n视图冒烟通过");
  } catch (error) {
    if (app?.logs()) console.error(app.logs());
    throw error;
  } finally {
    await app?.close();
    const cleanup = fs.realpathSync(work);
    if (path.dirname(cleanup) === dataDir && path.basename(cleanup).startsWith(".smoke-views-")) {
      fs.rmSync(cleanup, { recursive: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
