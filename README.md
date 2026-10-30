# libraryManger

本地优先的私人藏书管理软件。书库是一整个文件夹，书、封面、书评都在里面，换机器或重装软件都不丢数据。

Windows 桌面程序，Electron + React + TypeScript + SQLite。

## 它解决什么

藏书散在 Excel、Notion、豆瓣和一堆文件夹里，想找某个系列里的第几册，得挨个翻。这个软件把书目、封面、分类、阅读状态、书评收进一个可搜索的本地库，并且按真实藏书习惯做分面，比如按国籍、次分类、细分类三层，按系列聚合册序，按实体书和电子书分别记库存。

书评不锁在数据库里。每篇书评同时是一份 Markdown 文件，放在书库的 `reviews/` 下，用任何编辑器改完存盘，软件里几秒内跟着变；反过来在软件里写，文件也立刻落下。

## 书库是一个文件夹

```
我的书库/
  library.db        书目、分类、系列、书评正文、设置
  covers/           封面图片，文件名由书派生
  reviews/          书评 Markdown，双向同步
  backups/          软件内的备份
  .booklib.json     标识文件，kind=booklib-library
```

首次启动是一本空库，先选一个书库文件夹，也可以在文档目录里新建一个。

`covers/` 和 `reviews/` 里的文件名都由书本身派生，把这两个目录单独拷出去也认得出每份文件对应哪本书。改名是真改名，不重新生成图片，不改书评内容，改书名、换作者、调册序，对应文件跟着走。

## 跑起来

```bash
cd desktop
npm install
npm run dev
```

`npm run dev` 先起 Vite 再起 Electron，界面热更新。首次启动会出选择书库的页面。

想从别的数据源导一批书进来，改 `scripts/import-demo-data.mjs` 里的源路径，然后 `npm run import:demo`。

GPU 进程崩导致窗口黑屏退出时走软件渲染。

```bash
npm run dev -- --soft
```

## 功能

- 三个视图。书架网格、表格、书评库。顶栏切小说与漫画。
- 搜索。三字以上走 FTS5 trigram，两字及以下退回书名、原作名、副标题、作者的 LIKE。
- 分面。阅读状态、有无封面、三层分类、按册数排的系列，计数实时。
- 排序。书名、读完时间、评分、出版年、系列卷序、最近改动，多键叠加。
- 详情面板。原作名、系列卷次、出版信息、评分、阅读日期、分类、实体书与电子书库存、备注、书评正文。
- 就地编辑。表格单元格与详情页走同一条写入路径，改完各视图一起刷新。
- 分类管理。两级，拖拽调序，有子类或有书引用时不许删。
- 字段管理。十八个内建字段之外可自建，十种类型，能控列、控搜索、控筛选，改类型只走收紧方向，认不了的值列成清单不清空。
- 书评库。单本、系列、草稿、未匹配四档，可改绑到别的书或系列，改绑即改名。
- 封面。自定义图替换与撤销，原图留档。走 `cover://` 协议读本地文件，不进数据库。
- 找封面。按书名、作者或 ISBN 去豆瓣搜，候选铺成网格选一张；缺封面的书可批量跑，打分不到阈值的进队列逐条过目，顺带补书目为可选项，只填空字段。
- 备份。整库复制到别处，带封面与书评，不带历史备份目录。
- 回收站。删除进回收站，可还原。

## 技术结构

```
electron/
  main.ts              窗口、cover:// 协议、IPC 注册
  preload.ts           contextBridge 暴露 window.api
  db/                  连接、WAL、迁移、全文索引
  services/            书目、编辑、字段、分类、系列、书评、封面、封面抓取、备份、设置、书库
shared/types.ts        主进程与界面共用类型
src/                   React 界面
scripts/               导入、自测、冒烟、截图
```

服务层只吃数据库实例，不碰 Electron API。IPC 只在 `main.ts` 一层薄壳。

## 验证

服务层两组断言，交互一层 CDP 冒烟。需要一份样本书库在 `desktop/我的书库`，没有则自动跳过。

```bash
cd desktop
npm run build:electron

# 服务层，43 条
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-edit.mjs

# 服务层，127 条
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-extra.mjs

# 服务层，封面的 91 条，全程替身响应不走网络
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/test-cover.mjs

# 交互冒烟，52 条，需先起应用并带 --remote-debugging-port=9334
CDP_PORT=9334 node scripts/smoke.mjs

# 只跑某一块，自己起实例、用副本、跑完收掉
npm run smoke:review   # 书评，13 条
npm run smoke:fields   # 字段，15 条
npm run smoke:cover    # 封面，26 条，网络走假数据
```

宿主若注入 `ELECTRON_RUN_AS_NODE` 或 `NODE_OPTIONS` 垫片，跑之前用 `env -u` 去掉，否则 Electron 会退化成纯 Node、批量删文件会挂住。

## 许可

GNU General Public License v3.0，全文见 [LICENSE](LICENSE)。
