/*
 * 封面识别服务层自测。全程用替身 Http，不走真网络，也不依赖豆瓣那边通不通。
 * 跑法同 test-edit：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/test-cover.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, "data"), { recursive: true });
const file = process.argv[2] || path.join(root, "data", "t3.db");
const src = path.join(root, "我的书库", "library.db");
if (!fs.existsSync(src)) {
  console.log("缺少样本库 " + src + "，本组以本地书库为样本，跳过");
  process.exit(0);
}
for (const suf of ["", "-wal", "-shm"]) fs.rmSync(file + suf, { force: true });
fs.copyFileSync(src, file);
process.env.LIBRARY_DB = file;

const { openDb } = require("../dist-electron/electron/db/index.js");
const { listBooks, getBook } = require("../dist-electron/electron/services/bookService.js");
const { updateBook } = require("../dist-electron/electron/services/editService.js");
const cf = require("../dist-electron/electron/services/coverFetch.js");

const db = openDb(file);
let ok = 0;
let bad = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    ok++;
    console.log("  ok   " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("  FAIL " + name + (extra ? "  " + extra : ""));
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "booklib-cover-"));
const coversDir = path.join(tmp, "covers");
fs.mkdirSync(coversDir, { recursive: true });

/* 一张能读的 png，撑到 1KB 以上好过体积校验 */
const pngBytes = (() => {
  const head = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return new Uint8Array(Buffer.concat([head, Buffer.alloc(1200 - head.length)]));
})();

const SUBJECT_HTML = `<!doctype html><html><head>
<meta property="og:title" content="测试之书" />
<meta property="og:image" content="https://img3.doubanio.com/view/subject/l/public/s111.jpg" />
</head><body><div id="info">
<span class="pl"> 作者</span>: <a>某作者</a><br/>
<span class="pl">出版社:</span> <a>某某出版社</a><br/>
<span class="pl">出版年:</span> 2019-5-1<br/>
<span class="pl">ISBN:</span> 9787000000001<br/>
<span class="pl">页数:</span> 320<br/>
<span class="pl">装帧:</span> 精装<br/>
</div></body></html>`;

const SUGGEST = JSON.stringify([
  {
    title: "测试之书",
    url: "https://book.douban.com/subject/777/",
    pic: "https://img3.doubanio.com/view/subject/s/public/s111.jpg",
    author_name: "某作者",
    year: "2019",
    type: "b",
    id: "777"
  },
  {
    title: "测试之书（新版）",
    url: "https://book.douban.com/subject/778/",
    pic: "https://img3.doubanio.com/view/subject/s/public/s222.jpg",
    author_name: "另一个人",
    year: "2022",
    type: "b",
    id: "778"
  },
  {
    title: "某作者",
    url: "https://book.douban.com/author/9/",
    pic: "https://img3.doubanio.com/view/celebrity/m/public/p9.jpg",
    type: "a",
    id: "9"
  }
]);

/**
 * 站内搜索页的样例。照真页面的结构剪的：
 * window.__DATA__ 一段 JSON，前后还有别的脚本，正则会截错，这里顺便验配平。
 */
const SITE_HTML = `<html><head><script>var x = {a:1};</script></head><body>
<script>
window.__DATA__ = {"count": 2, "items": [
{"abstract": "某作者 / VOFAN / 某某出版社 / 2018-10-18 / NTD450", "cover_url": "https://img3.doubanio.com/view/subject/m/public/9101.jpg", "id": 9101, "title": "測試之書", "url": "https://book.douban.com/subject/9101/"},
{"abstract": "另一个人 / 另一家出版社 / 2016-1-14 / JPY 1296", "cover_url": "https://img9.doubanio.com/view/subject/m/public/9102.jpg", "id": 9102, "title": "測試之書 : 副標題", "url": "https://book.douban.com/subject/9102/"}
]};
</script>
<script>var y = {"z":1};</script>
</body></html>`;

function siteFor(q) {
  /* 查询词就是 ISBN 时，站内搜索页也给一条，验 ISBN 兜底那条 */
  return SITE_HTML.replace(/測試之書/g, q.replace(/[<>&"]/g, ""));
}

/** 按查询词现造一批。批量那组要的是「搜什么就有什么」，好验满分与阈值 */
function suggestFor(q) {
  return JSON.stringify([
    {
      title: q,
      url: "https://book.douban.com/subject/777/",
      pic: "https://img3.doubanio.com/view/subject/s/public/s111.jpg",
      author_name: "某作者",
      year: "2019",
      type: "b",
      id: "777"
    },
    {
      title: q + "（新版）",
      url: "https://book.douban.com/subject/778/",
      pic: "https://img3.doubanio.com/view/subject/s/public/s222.jpg",
      author_name: "另一个人",
      year: "2022",
      type: "b",
      id: "778"
    }
  ]);
}

/** 替身。每个方法都记次数，用来验缓存到底有没有挡住第二次请求 */
function stub(over = {}) {
  const calls = { text: [], bytes: [], headers: [] };
  const http = {
    async text(url) {
      calls.text.push(url);
      if (over.text) {
        const r = over.text(url);
        if (r) return r;
      }
      if (url.includes("/j/subject_suggest")) {
        const q = decodeURIComponent((url.split("q=")[1] || "").split("&")[0]);
        return { status: 200, url, text: suggestFor(q) };
      }
      if (url.includes("/isbn/")) return { status: 200, url: "https://book.douban.com/subject/777/", text: SUBJECT_HTML };
      if (url.includes("/subject_search")) {
        const q = decodeURIComponent((url.split("search_text=")[1] || "").split("&")[0]);
        return { status: 200, url, text: siteFor(q) };
      }
      const m = url.match(/subject\/(\d+)/);
      return { status: 200, url, text: m ? SUBJECT_HTML : "" };
    },
    async bytes(url, headers) {
      calls.bytes.push(url);
      calls.headers.push(headers || {});
      if (over.bytes) {
        const r = over.bytes(url);
        if (r) return r;
      }
      return { status: 200, url, bytes: pngBytes, contentType: "image/png" };
    }
  };
  return { http, calls };
}

/* ---------- 解析与打分，这一层完全不吃网络 ---------- */

console.log("\n[1] 解析");
{
  const list = cf.parseSuggest(SUGGEST);
  t("作者条目被滤掉", list.length === 2, "剩 " + list.length + " 条");
  t("缩略图换成大图", list[0].image.includes("/l/public/") && list[0].pic.includes("/s/public/"));
  t("id 与书名对得上", list[0].id === "777" && list[0].title === "测试之书");

  /* 站内搜索页。豆瓣的 suggest 索引对台版与繁体书名覆盖差，拿繁体原名搜给空数组，
     可站内搜索里有十几条，这条路就是补这个洞的 */
  const site = cf.parseSearchPage(SITE_HTML);
  t("站内搜索页解析出两条", site.length === 2, "条数 " + site.length);
  t("站内页的书名对得上", site[0].title === "測試之書", site[0].title);
  t("作者取第一段", site[0].authors === "某作者", site[0].authors);
  t("日期认出年份", site[0].year === "2018", site[0].year);
  t("出版社取日期前一段", site[0].publisher === "某某出版社", site[0].publisher);
  t("带上条目号", site[0].id === "9101");
  t("中图换大图", site[0].image.includes("/l/public/") && site[0].pic.includes("/m/public/"));
  t("前后别的脚本没干扰", site[1].title === "測試之書 : 副標題", site[1].title);
  t("没有 __DATA__ 不炸", cf.parseSearchPage("<html>什么都没有</html>").length === 0);

  t("坏 JSON 不炸", cf.parseSuggest("{不是数组").length === 0);
  t("不是数组也不炸", cf.parseSuggest('{"a":1}').length === 0);

  const s = cf.parseSubject(SUBJECT_HTML, "777");
  t("取到大图", s.image.endsWith("s111.jpg"));
  t("取到书名", s.title === "测试之书", s.title);
  t("取到出版社", s.publisher === "某某出版社", s.publisher);
  t("取到出版年", s.year === "2019-5-1", s.year);
  t("取到 ISBN 与页数", s.info["ISBN"] === "9787000000001" && s.info["页数"] === "320");
  t("取到装帧", s.info["装帧"] === "精装");

  /* 信息区的切点必须落在开标签之后。曾从 id="info" 本身切，
     把 <div 前缀留在正文里，第一段成了 id="info"> 作者 : xxx，
     字段名超长整行匹配不上，所有书的作者都读不到 */
  const messy = `<div id="info"><span class="pl"> 作者</span>: 甲 / 乙<br/><span class="pl">出版社:</span> 某社<br/></div>`;
  const ms = cf.parseSubject(messy);
  t("开标签残片没混进字段名", ms.authors === "甲 / 乙", JSON.stringify(ms.authors));
  t("同一份里出版社也在", ms.publisher === "某社", JSON.stringify(ms.publisher));
}

console.log("\n[2] 书名归一化与 ISBN 判断");
{
  t("去括号内容", cf.normalizeTitle("测试之书（新版）") === cf.normalizeTitle("测试之书"));
  t("去卷号", cf.normalizeTitle("某某 第3卷") === cf.normalizeTitle("某某"));
  t("去空白与标点", cf.normalizeTitle("测试 之书：") === cf.normalizeTitle("测试之书"));
  t("英文大小写不敏感", cf.normalizeTitle("Blue") === cf.normalizeTitle("blue"));

  t("十三位认成 ISBN", cf.looksLikeIsbn("9787000000001"));
  t("带横杠也认", cf.looksLikeIsbn("978-7-0000-0000-1"));
  t("十位也认", cf.looksLikeIsbn("7301000000"));
  t("书名不当 ISBN", !cf.looksLikeIsbn("测试之书"));

  /* 从网页、Excel 里粘过来的号常带着 isbn 三个字母、全角、各种分隔 */
  t("带 isbn 前缀也认", cf.normIsbn("isbn9787000000001") === "9787000000001");
  t("前缀大写也认", cf.normIsbn("ISBN9787000000001") === "9787000000001");
  t("前缀与横杠一起来也认", cf.normIsbn("ISBN 978-7-0000-0000-1") === "9787000000001");
  t("全角数字也认", cf.normIsbn("９７８７００００００００１") === "9787000000001");
  t("十位带 X 也认", cf.normIsbn("730100000X") === "730100000X");
  t("不是号给空串", cf.normIsbn("測試之書") === "");
}

console.log("\n[3] 打分");
{
  const book = { title: "测试之书", authors: ["某作者"], year: "2019" };
  const cand = { title: "测试之书", authors: "某作者", year: "2019" };
  t("书名相等 60", cf.scoreCandidate({ title: "测试之书" }, { title: "测试之书" }) === 60);
  t("相等加作者 80", cf.scoreCandidate({ title: "测试之书", authors: ["某作者"] }, cand) >= 80);
  t("再加同年 90", cf.scoreCandidate(book, cand) === 90);
  t("差一年算 5 分", cf.scoreCandidate({ title: "测试之书", year: "2019" }, { title: "测试之书", year: "2020" }) === 65);
  t("包含算 35", cf.scoreCandidate({ title: "测试之书新版" }, { title: "测试之书" }) === 35);
  t("一个字都不沾是 0", cf.scoreCandidate({ title: "完全不同的书" }, { title: "测试之书" }) === 0);
  t("空书名是 0", cf.scoreCandidate({ title: "" }, cand) === 0);
}

/* ---------- 网络与缓存 ---------- */

console.log("\n[4] 搜索与缓存");
{
  const { http, calls } = stub();
  const r1 = await cf.search(db, http, "测试之书");
  t("关键词搜到两条", r1.list.length === 2, "条数 " + r1.list.length);
  t("第一次没走缓存", r1.cached === false);
  const r2 = await cf.search(db, http, "测试之书");
  t("第二次走缓存", r2.cached === true);
  t("缓存没有再发请求", calls.text.length === 1, "请求 " + calls.text.length + " 次");

  const { http: h3, calls: c3 } = stub();
  const r3 = await cf.search(db, h3, "9787000000001");
  t("ISBN 走跳转那条", c3.text[0].includes("/isbn/"), c3.text[0].slice(0, 48));
  t("ISBN 拿到一条", r3.list.length === 1 && r3.list[0].id === "777");

  /* 把缓存做成二十五小时前，下一次必须重新请求 */
  db.prepare("UPDATE cover_cache SET fetched_at = ? WHERE kind = 'search'").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  const before = calls.text.length;
  const r4 = await cf.search(db, http, "测试之书");
  t("过期后重新请求", r4.cached === false && calls.text.length === before + 1);

  /* 带 isbn 前缀的号要按 ISBN 走，不能当成关键词扔给 suggest */
  const { http: h5, calls: c5 } = stub();
  const r5 = await cf.search(db, h5, "isbn9789571082944");
  t("带前缀的号走 ISBN 那条", c5.text[0].includes("/isbn/"), c5.text[0].slice(0, 48));
  t("带前缀也能拿到一条", r5.list.length === 1 && r5.list[0].id === "777");

  /* suggest 给空数组时回落到站内搜索，这是搜不到台版书的根因所在 */
  const { http: h6, calls: c6 } = stub({ text: (u) => (u.includes("/j/subject_suggest") ? { status: 200, url: u, text: "[]" } : null) });
  const r6 = await cf.search(db, h6, "只在站内搜得到的书名");
  t("suggest 空了会去站内搜索", c6.text.some((u) => u.includes("/subject_search")), c6.text.map((u) => (u.includes("subject_suggest") ? "suggest" : "站内搜索")).join(" → "));
  t("站内搜索也捞到结果", r6.list.length === 2, "条数 " + r6.list.length);
  t("捞回来的书名是对的", r6.list[0].title === "只在站内搜得到的书名", r6.list[0].title);

  /* ISBN 跳转不到时，站内搜索兜一层，站内搜索是认 ISBN 的 */
  const { http: h7, calls: c7 } = stub({
    text: (u) => (u.includes("/isbn/") ? { status: 200, url: "https://book.douban.com/isbn/", text: "" } : null)
  });
  const r7 = await cf.search(db, h7, "9787000000002");
  t("ISBN 跳转失败会兜一层站内搜索", c7.text.some((u) => u.includes("/subject_search")));
  t("兜回来有结果", r7.list.length > 0, "条数 " + r7.list.length);
}

console.log("\n[5] 详情与缩略图");
{
  const { http, calls } = stub();
  const d = await cf.detailOf(db, http, "777");
  t("详情拿到信息", !!d && d.info["出版社"] === "某某出版社");
  const d2 = await cf.detailOf(db, http, "777");
  t("详情走缓存", !!d2 && calls.text.length === 1, "请求 " + calls.text.length + " 次");
  t("没有 id 返回空", (await cf.detailOf(db, http, "")) === null);
}

/* ---------- 下载 ---------- */

console.log("\n[6] 下载");
{
  const { http, calls } = stub();
  const got = await cf.downloadImage(http, "https://img3.doubanio.com/view/subject/l/public/s111.jpg");
  t("下到本地临时文件", fs.existsSync(got.file) && got.bytes > 1000, got.bytes + " 字节");
  /* 豆瓣图片站认 Referer，不带就是 418，这条写成断言防以后被改掉 */
  t("下载请求带着 Referer", (calls.headers[0] || {}).Referer === "https://book.douban.com/", JSON.stringify(calls.headers[0] || {}));
  t("下载请求带着 UA", /Mozilla/.test((calls.headers[0] || {})["User-Agent"] || ""));
  fs.rmSync(got.file, { force: true });

  const block = stub({ bytes: () => ({ status: 418, url: "", bytes: new Uint8Array(0), contentType: "" }) });
  let blocked = "";
  try {
    await cf.downloadImage(block.http, "https://img3.doubanio.com/view/subject/l/public/s111.jpg");
  } catch (e) {
    blocked = e.message;
  }
  t("418 抛 BlockedError", blocked.includes("418"), blocked);

  const notImg = stub({ bytes: () => ({ status: 200, url: "", bytes: pngBytes, contentType: "text/html" }) });
  let notImgMsg = "";
  try {
    await cf.downloadImage(notImg.http, "https://x/y.jpg");
  } catch (e) {
    notImgMsg = e.message;
  }
  t("不是图片就拒绝", notImgMsg.includes("不是图片"), notImgMsg);

  const small = stub({ bytes: () => ({ status: 200, url: "", bytes: new Uint8Array(10), contentType: "image/png" }) });
  let smallMsg = "";
  try {
    await cf.downloadImage(small.http, "https://x/y.jpg");
  } catch (e) {
    smallMsg = e.message;
  }
  t("太小的也拒绝", smallMsg.includes("太小"), smallMsg);
}

/* ---------- 落盘 ---------- */

console.log("\n[7] 落到书上");
{
  const rows = listBooks(db, { limit: 1 }).rows;
  const book = rows[0];
  const before = String(book.cover || "");

  const { http } = stub();
  const hit = { id: "777", title: book.title, authors: book.authors.join("、"), year: "2019", publisher: "", pic: "", image: "https://img3.doubanio.com/view/subject/l/public/s111.jpg", score: 90 };
  const r = await cf.applyCandidate(db, http, book.id, hit, { coversDir });
  t("落盘成功", r.ok, r.msg || "");
  t("cover_file 变了", !!r.cover && r.cover !== before, r.cover || "");
  t("文件真在 covers 里", fs.existsSync(path.join(coversDir, r.cover || "")));

  const after = getBook(db, book.id);
  t("读回来是新的", !!after && after.cover === r.cover);

  const miss = await cf.applyCandidate(db, http, book.id, { ...hit, image: "" }, { coversDir });
  t("没有图片地址就拒绝", miss.ok === false && !!miss.msg, miss.msg || "");
}

/* ---------- 回填 ---------- */

console.log("\n[8] 顺手补字段");
{
  const rows = listBooks(db, { limit: 20 }).rows;
  const book = rows[1];
  /* 出版日期要验「空着才写」，先把这本清空，别指望样本里正好有空着的 */
  updateBook(db, book.id, { publishDate: "" });

  /* 先自己填一个出版社，看回填会不会踩掉 */
  const f0 = db.prepare("SELECT id FROM fields WHERE key = 'publisher'").get();
  if (!f0) {
    cf.backfill(db, book.id, coversDir, { id: "777", image: "", info: { 出版社: "我自己写的社" } });
  }
  updateBook(db, book.id, { custom: { publisher: ["我自己写的社"] } });

  const out = cf.backfill(db, book.id, coversDir, {
    id: "777",
    image: "",
    info: { 出版社: "豆瓣的社", ISBN: "9787000000001", 页数: "320", 装帧: "精装", 出版年: "2019-5-1" }
  });
  const d = getBook(db, book.id);
  const custom = (d && d.custom) || {};
  t("已有的出版社没被覆盖", (custom.publisher || [])[0] === "我自己写的社", JSON.stringify(custom.publisher));
  t("被跳过的报了出来", out.skipped.includes("出版社"), out.skipped.join("、"));
  t("空的 ISBN 补上了", (custom.isbn || [])[0] === "9787000000001");
  t("页数补上了", (custom.pages || [])[0] === "320");
  t("装帧补上了", (custom.binding || [])[0] === "精装");
  t("出版日期写进去了", !!d && d.publishDate === "2019-05-01", d ? d.publishDate : "");
  t("四个字段都建出来了", ["publisher", "isbn", "pages", "binding"].every((k) => db.prepare("SELECT id FROM fields WHERE key = ? AND deleted_at IS NULL").get(k)));

  /* 已经补过一遍，再来一遍应该全都跳过 */
  const again = cf.backfill(db, book.id, coversDir, {
    id: "777",
    image: "",
    info: { 出版社: "豆瓣的社", ISBN: "9787000000001", 页数: "320", 装帧: "精装", 出版年: "2019-5-1" }
  });
  t("再补一遍全是跳过", again.filled.length === 0, "补了 " + again.filled.join("、"));
}

/* ---------- 队列 ---------- */

console.log("\n[9] 待确认队列");
{
  const rows = listBooks(db, { limit: 2 }).rows;
  const b = rows[rows.length - 1];
  cf.enqueue(db, b.id, { id: "778", title: "某个不像的", authors: "", year: "", publisher: "", pic: "", image: "", score: 35 }, 35);
  const q = cf.listQueue(db);
  const got = q.find((x) => x.bookId === b.id);
  t("进了队列", !!got);
  t("带着候选与分数", !!got && got.score === 35 && got.candidate.id === "778");
  t("带着书名", !!got && got.title === b.title);

  cf.enqueue(db, b.id, null, 0);
  const q2 = cf.listQueue(db).find((x) => x.bookId === b.id);
  t("同书再进队列是覆盖不是新增", !!q2 && q2.candidate === null && cf.listQueue(db).filter((x) => x.bookId === b.id).length === 1);

  cf.dequeue(db, b.id);
  t("跳过就出队", !cf.listQueue(db).some((x) => x.bookId === b.id));
}

/* ---------- 批量 ---------- */

console.log("\n[10] 批量");
{
  const missing = cf.booksWithoutCover(db);
  t("挑出缺封面的书", missing.length > 0, missing.length + " 本");
  t("挑出来的都没有封面", missing.every((b) => !db.prepare("SELECT cover_file FROM books WHERE id = ?").get(b.id).cover_file));
  t("带着作者与年份", missing.every((b) => Array.isArray(b.authors)));

  const { http } = stub();
  const book = missing[0];
  const tick = await cf.bestHit(db, http, book);
  t("批量挑到最高分那张", !!tick.best && tick.score >= 60, tick.score + " 分");
  t("挑的是同名的那个", !!tick.best && tick.best.id === "777");

  /* 搜回来的书名完全对不上时打 0 分，这种要进队列，不能硬配 */
  const fixed = stub({ text: (url) => (url.includes("/j/subject_suggest") ? { status: 200, url, text: SUGGEST } : null) });
  const weird = { id: book.id, title: "zzzz不存在的书名", authors: [], year: "" };
  const none = await cf.bestHit(db, fixed.http, weird);
  t("搜不到分就是 0", none.score === 0 && none.best === null);

  /* 换个没搜过的书名，否则会先命中缓存，根本没发请求 */
  const blocked = stub({ text: () => ({ status: 429, url: "", text: "" }) });
  let threw = "";
  try {
    await cf.bestHit(db, blocked.http, { id: book.id, title: "限速测试专用书名", authors: [], year: "" });
  } catch (e) {
    threw = String(e.message || e);
  }
  t("限速抛给上层去停整批", threw.includes("429"), threw);
}

/* ---------- 收尾 ---------- */

console.log("\n清理");
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
for (const suf of ["", "-wal", "-shm"]) fs.rmSync(file + suf, { force: true });

console.log("\n通过 " + ok + " 条，失败 " + bad + " 条");
process.exit(bad ? 1 : 0);
