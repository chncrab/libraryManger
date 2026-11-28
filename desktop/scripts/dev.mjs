/**
 * 开发模式：编译主进程 → 起 Vite → 起 Electron，改渲染代码热更新，改主进程代码重跑本脚本。
 * 数据库指向 desktop/data/library.db，不碰 %APPDATA%，方便反复导入。
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electronPath from "electron";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(ROOT, "..");

/* 只绑本机回环：localhost 在 Windows 上可能解析到 ::1 或触发 EACCES */
const HOST = "127.0.0.1";
const MAX_PORT_RETRIES = 5;

/* Windows 控制台默认 936，Node 与 Electron 写出去的是 UTF-8，日志整行变成乱码。
   码页属于控制台本身，在这里改一次，后面拉起来的进程都跟着用，直接 npm run dev 也一样。
   run-dev.cmd 里也有一句 chcp，双点启动走那条，重复设一次没有副作用 */
if (process.platform === "win32") {
  spawnSync("chcp 65001", { stdio: "ignore", shell: true });
}

/* 宿主进程（某些编辑器/工具链）会把 ELECTRON_RUN_AS_NODE 传下来，
   带着它启动 Electron 等于跑了个纯 Node，app 与 protocol 全是 undefined */
function envWithoutRunAsNode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/* 端口冲突的两种形态：EACCES / EADDRINUSE 带 code；
   Vite strictPort 下端口被占用时抛的是没有 code 的 "Port N is already in use" */
function isPortConflict(err) {
  if (!err) return false;
  if (err.code === "EACCES" || err.code === "EADDRINUSE") return true;
  return typeof err.message === "string" && /^Port \d+ is already in use$/.test(err.message.trim());
}

/* 让系统在回环地址上分配一个空闲端口，拿到后立刻释放，交给 Vite 绑定 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else if (Number.isInteger(port) && port > 0) resolve(port);
        else reject(new Error("未能从系统取得可用端口"));
      });
    });
  });
}

async function closeQuietly(server) {
  if (!server) return;
  try {
    await server.close();
  } catch {
    /* 未成功监听的实例关闭时可能报错，忽略即可 */
  }
}

/* createServer 是异步的，必须等它解析出真正的 ViteDevServer 才能读 config / listen */
async function createDevServer(extraServerOptions) {
  return createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, "vite.config.ts"),
    server: { host: HOST, ...extraServerOptions }
  });
}

/* 正常路径走 resolvedUrls.local[0]；缺失时从 httpServer 的真实端口还原，
   绝不在没有端口时退回 80 */
function resolveUrl(server) {
  const local = server.resolvedUrls?.local?.[0];
  if (local) return local;
  const address = server.httpServer?.address();
  if (address && typeof address === "object" && Number.isInteger(address.port) && address.port > 0) {
    return `http://${HOST}:${address.port}/`;
  }
  throw new Error("Vite 未提供可用端口，无法确定 Electron 加载地址");
}

/* 用一个循环统一首选端口与系统分配端口：create → listen → 失败则 close；
   只有 EACCES/EADDRINUSE 或 "Port N is already in use" 才换端口重试，其他异常直接抛 */
async function startVite() {
  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    let server;
    let port;
    if (attempt === 0) {
      server = await createDevServer({});
    } else {
      port = await findFreePort();
      server = await createDevServer({ port, strictPort: true });
    }
    try {
      await server.listen();
      if (port) console.log(`已改用端口 ${port}`);
      return server;
    } catch (err) {
      await closeQuietly(server);
      if (!isPortConflict(err)) throw err;
      if (attempt === 0) {
        console.warn(`端口 ${server.config.server.port} 不可用（${err.code || err.message}），改用系统分配的端口`);
      }
    }
  }
  throw new Error("未能启动 Vite：端口持续被占用");
}

const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.electron.json"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: true
});
if (tsc.status !== 0) {
  console.error("主进程编译失败");
  process.exit(tsc.status || 1);
}

let server;
let url;
try {
  server = await startVite();
  url = resolveUrl(server);
} catch (err) {
  console.error("Vite 启动失败，未启动 Electron");
  console.error(err);
  process.exit(1);
}

console.log("Vite", url);

const child = spawn(String(electronPath), [".", ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...envWithoutRunAsNode(),
    VITE_DEV_SERVER_URL: url,
    /* 书库根：默认工程里的「我的书库」，测试脚本用 BOOKLIB_ROOT 指到副本库 */
    BOOKLIB_ROOT: process.env.BOOKLIB_ROOT || path.join(projectRoot, "我的书库"),
    ...(process.env.LIBRARY_DB ? { LIBRARY_DB: process.env.LIBRARY_DB } : {})
  }
});

child.on("close", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
