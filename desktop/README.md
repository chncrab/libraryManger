# 藏书库 桌面版

Electron + React + TypeScript + Vite + SQLite（better-sqlite3）的正式实现。项目概览与功能清单见上一级 [README.md](../README.md)。

## 跑起来

```bash
npm install
npm run dev             # 起 Vite 再起 Electron，改界面热更新
```

首次启动是选择书库的页面。要导入数据，改 `scripts/import-demo-data.mjs` 的源路径后 `npm run import:demo`。

生产形态：

```bash
npm run build
npx electron .
```

## 书库在哪

书库是一个独立文件夹，默认由启动时选择决定，路径记在 `%APPDATA%/booklib/config.json`。开发时可用环境变量直接指过去。

```bash
BOOKLIB_ROOT=/path/to/我的书库 npm run dev
```

启动顺序为 `BOOKLIB_ROOT`、配置文件、空目录出选择页。主进程的 `db` 与 `lib` 都可能是空值，没打开书库时只渲染选择页，handler 统一走 `requireDb()`。

## 目录

```
electron/
  main.ts               主进程：窗口、cover:// 协议、IPC 注册、书评目录监听
  preload.ts            contextBridge 暴露 window.api
  db/index.ts           连接、WAL、迁移执行
  db/schema.ts          v1 建表 SQL（改结构新增一段，不改旧的）
  services/libraryService  书库路径、结构补齐、整库复制、配置读写
  services/bookService     书目查询、分面
  services/editService     增删改、副本、回收站
  services/categoryService 两级分类树、调序
  services/seriesService   系列聚合、册序、系列作者
  services/reviewService   书评清单、命名、改绑
  services/reviewIo.ts     书评 Markdown 读写、映射、双向同步
  services/coverService    封面命名、替换、撤销、改名
  services/backupService   库备份
  services/settingsService 设置项
shared/types.ts         主进程与界面共用的类型
src/                    React 界面
scripts/                导入、自测、冒烟、截图
```

服务层只吃数据库实例，不碰 Electron API。IPC 只在 `main.ts` 一层薄壳。

## 环境坑

GPU 进程崩溃（远程桌面或老显卡）导致窗口黑屏退出时，加 `--soft` 走软件渲染。

```bash
npm run dev -- --soft
```

跑服务层断言时，宿主注入的 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node，`app` 为 undefined，要显式去掉。命令行里另有一层 `NODE_OPTIONS` 文件垫片，批量删文件会把进程挂住、`fs.cpSync` 直接让进程退出，同样要去掉。

```bash
env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE ELECTRON_RUN_AS_NODE=1 \
  node_modules/electron/dist/electron.exe scripts/test-extra.mjs
```

纯 Node 跑不了这些断言，`better-sqlite3` 的 ABI 与 Electron 主进程对不上。

## 验证

```bash
npm run build:electron

ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-edit.mjs    # 43 条
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-extra.mjs   # 74 条

# 交互冒烟，需应用已带 --remote-debugging-port=9334
BOOKLIB_ROOT=... node_modules/electron/dist/electron.exe . --remote-debugging-port=9334 --disable-gpu --in-process-gpu
CDP_PORT=9334 node scripts/smoke.mjs                                                    # 46 条
```

两组服务层断言以 `我的书库` 为样本，缺样本时自动跳过。冒烟要跑在副本书库上，别指真库。
