# 藏书库

## 简要介绍

藏书库是一款面向个人收藏的 Windows 桌面应用，用于管理小说、漫画及其系列，整理书评与阅读记录。应用采用 Electron、React、TypeScript 和 SQLite。书目数据库、封面图片和 Markdown 书评统一保存在本地书库目录中。

## 功能

- **书目与系列管理。** 记录作者、原作名、系列卷次、出版信息及实体书与电子书的收藏状态。支持分类、自定义字段和表格编辑。
- **自定义书架与检索。** 同一书库可按单册或系列组织书架与表格。支持全文检索、多条件筛选、多字段排序，以及将常用筛选条件保存为视图。
- **Markdown 书评管理。** 支持单册书评和系列总评，可按书名与正文检索。书评正文以本地 Markdown 文件为准，应用会同步识别外部编辑。
- **阅读记录与统计。** 记录阅读起止日期和评分，通过横向或纵向时间线、月历和年历回顾阅读历史，查看按日期汇总的阅读统计。
- **封面维护与书库备份。** 支持封面搜索、批量补全和手动替换，可备份书目数据库及书评文件，也可复制完整书库用于迁移。

## 部署

在 Windows x64 上运行安装包，或解压 ZIP 发行包后启动 `藏书库.exe`。首次启动时可新建书库或打开已有书库目录。

从源码部署时，在 Windows x64 环境准备 Node.js 22.12 或更高版本及 npm，然后在仓库根目录执行以下命令。

```powershell
cd desktop
npm install
npm start
```

如需按 Electron 的运行环境重建 `better-sqlite3`，请在 `desktop` 目录中执行 `node node_modules/@electron/rebuild/lib/cli.js --force --which-module better-sqlite3`。

在 `desktop` 目录执行 `npm run dist` 可生成 Windows x64 安装包和 ZIP 发行包，输出位于 `desktop/release/`。

## 许可证

本项目采用 GNU General Public License v3.0（GPL-3.0-only）。许可证全文见 [LICENSE](LICENSE)。
