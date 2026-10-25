/**
 * 开发模式：编译主进程 → 起 Vite → 起 Electron，改渲染代码热更新，改主进程代码重跑本脚本。
 * 数据库指向 desktop/data/library.db，不碰 %APPDATA%，方便反复导入。
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electronPath from "electron";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(ROOT, "..");

/* 宿主进程（某些编辑器/工具链）会把 ELECTRON_RUN_AS_NODE 传下来，
   带着它启动 Electron 等于跑了个纯 Node，app 与 protocol 全是 undefined */
function envWithoutRunAsNode() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
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

const server = await createServer({ root: projectRoot, configFile: path.join(projectRoot, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local?.[0] || "http://localhost:5273/";
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
