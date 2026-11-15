/**
 * 打包前清掉 Electron 运行时落在 dist 里的 debug.log。
 * 开发时跑 electron.exe . 会把 Chromium 的日志写到 exe 同目录，
 * 打包机把整个 dist 拷进成品，这份日志就会跟着进安装包。
 */
import fs from "node:fs";
import path from "node:path";

const p = path.resolve("node_modules/electron/dist/debug.log");
if (fs.existsSync(p)) {
  fs.rmSync(p, { force: true });
  console.log("已删除 node_modules/electron/dist/debug.log");
}
const u = path.resolve("release/win-unpacked");
if (fs.existsSync(u)) {
  fs.rmSync(u, { recursive: true, force: true });
  console.log("已清空 release/win-unpacked");
}
