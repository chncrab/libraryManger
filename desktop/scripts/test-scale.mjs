/*
 * 时间轴换算的自测。只测纯函数，不碰库也不碰界面。
 * 跑法：node scripts/test-scale.mjs（npm run test:scale）
 * 需要先 npm run build:electron，读的是 dist-electron 里编出来的那份。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../dist-electron/shared/readScale.js");

let ok = 0;
let bad = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    ok++;
    console.log("  ok   " + name + (extra ? "  " + extra : ""));
  } else {
    bad++;
    console.log("  FAIL " + name + (extra ? "  " + extra : ""));
    process.exitCode = 1;
  }
};
const D = R.dayNum;
const U = D("2020-06-01");

/* ---- 一、日期换算 ---- */
console.log("[1] 日期");
t("日月能来回换", R.dayStr(D("2022-12-01")) === "2022-12-01", R.dayStr(D("2022-12-01")));
t("跨月天数对得上", D("2022-03-01") - D("2022-02-28") === 1);
t("闰年二月有 29 天", D("2024-03-01") - D("2024-02-28") === 2);
t("两头的日期写成月-日", R.dayLabel(D("2022-12-05")) === "12-05" && R.dayLabel(D("2022-01-01")) === "01-01", R.dayLabel(D("2022-12-05")));
t("星期天认得出来", R.isSunday(D("2022-01-02")) === true && R.isSunday(D("2022-01-03")) === false);
t("空串给 NaN", Number.isNaN(D("")));

/* ---- 二、连续日历：所有年所有月一样宽 ---- */
console.log("[2] 换算");
const mm = R.buildScale([D("2020-01-05"), D("2020-02-05"), D("2020-03-05")], { until: U });
const wJan = mm.xOf(D("2020-02-01")) - mm.xOf(D("2020-01-01"));
const wFeb = mm.xOf(D("2020-03-01")) - mm.xOf(D("2020-02-01"));
const wJun = mm.xOf(D("2020-07-01")) - mm.xOf(D("2020-06-01"));
t("轴从最早那本书那年的元旦起", mm.xOf(D("2020-01-01")) === 0, mm.xOf(D("2020-01-01")).toFixed(1));
t("一月的宽度就是月宽", Math.abs(wJan - mm.monthW) < 0.01, wJan.toFixed(1));
t("二月二十八天也和一月一样宽", Math.abs(wJan - wFeb) < 0.01, wJan.toFixed(1) + " / " + wFeb.toFixed(1));
t("一本没读的月份照样占满一格", Math.abs(wJun - mm.monthW) < 0.01, wJun.toFixed(1) + " / " + mm.monthW.toFixed(1));
t("月宽不窄于日历上最长的月", mm.monthW >= 31 * R.PXD - 0.01, mm.monthW.toFixed(1));
t("网格一直铺到今年十二月", mm.xOf(D("2020-12-01")) === 11 * mm.monthW, mm.xOf(D("2020-12-01")).toFixed(1));
t("轴只画到今天，不把没到的月份画出来", Math.abs(mm.width - mm.xOf(U + 1)) < 0.01 && mm.width < 12 * mm.monthW, mm.width.toFixed(1));
t("今天就是轴的最后一天", mm.last === U, R.dayStr(mm.last));

const oneDay = R.buildScale([D("2020-01-01"), D("2020-01-02")], { until: U });
/* 一天正好一格：相邻两天的间隔就是那天的宽度，不再给书让出额外的地方 */
t(
  "隔一天也正好一格",
  Math.abs(oneDay.xOf(D("2020-01-02")) - oneDay.xOf(D("2020-01-01")) - oneDay.slopeAt(D("2020-01-01"))) < 0.01,
  oneDay.slopeAt(D("2020-01-01")).toFixed(2)
);
const four = R.buildScale([D("2020-01-01"), D("2020-01-01"), D("2020-01-01"), D("2020-01-01"), D("2020-01-02")], { until: U });
/* 同一天四本不把那一天撑开：那天和别人一样宽，只是把整月的月宽撑大 */
t(
  "同一天四本不把那天撑开",
  Math.abs(four.slopeAt(D("2020-01-01")) - four.slopeAt(D("2020-01-15"))) < 0.01 && four.monthW > oneDay.monthW,
  four.slopeAt(D("2020-01-01")).toFixed(2) + " / 月宽 " + four.monthW.toFixed(1)
);
const widest = R.buildScale([D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-02-09")], { until: U });
t("最挤的那个月定下全轴月宽", widest.monthW >= (5 * R.SLOT) / R.LANES, widest.monthW.toFixed(1));
t("只读过一本的月也按这个宽排", Math.abs(widest.xOf(D("2020-02-01")) - widest.xOf(D("2020-01-01")) - widest.monthW) < 0.01);
const stretched = R.buildScale(
  [D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-02-09"), D("2020-03-20")],
  { until: U }
);
t("书少的月份把日子摊开填满一格", stretched.slopeAt(D("2020-02-11")) > R.PXD * 1.2, stretched.slopeAt(D("2020-02-11")).toFixed(2));
t("摊开之后二月到三月也正好一格", Math.abs(stretched.xOf(D("2020-03-01")) - stretched.xOf(D("2020-02-01")) - stretched.monthW) < 0.01);
t("摊开之后每天仍是正的、且按天排", stretched.slopeAt(D("2020-02-11")) > 0 && stretched.xOf(D("2020-02-11")) < stretched.xOf(D("2020-02-12")));
/* 挤的那一天也照样只是一个格：月内每天一律 monthW ÷ 天数，谁都不多占 */
t(
  "最满的那个月也是每天一样宽",
  Math.abs(stretched.slopeAt(D("2020-01-20")) - stretched.slopeAt(D("2020-01-05"))) < 0.01,
  stretched.slopeAt(D("2020-01-05")).toFixed(2) + " / " + stretched.slopeAt(D("2020-01-20")).toFixed(2)
);

/* 没读书的年份不压缩，一年正好十二格 */
const hole = R.buildScale([D("2010-01-01"), D("2016-01-01")], { until: D("2016-06-01") });
t("空档里的年份一样宽", Math.abs(hole.xOf(D("2013-01-01")) - hole.xOf(D("2012-01-01")) - 12 * hole.monthW) < 0.01);
t("几年没读也不压成一截", Math.abs(hole.xOf(D("2016-01-01")) - hole.xOf(D("2010-01-01")) - 6 * 12 * hole.monthW) < 0.01, (hole.xOf(D("2016-01-01")) - hole.xOf(D("2010-01-01"))).toFixed(1));
t("空月也按同一月宽排", Math.abs(hole.xOf(D("2011-08-01")) - hole.xOf(D("2011-07-01")) - hole.monthW) < 0.01);

const stepDay = D("2020-01-11");
t("这天的宽度就是相邻两点的距离", Math.abs(mm.xOf(stepDay + 1) - mm.xOf(stepDay) - mm.slopeAt(stepDay)) < 0.01, mm.slopeAt(stepDay).toFixed(2));
t("没书的一天仍然是一天的宽", mm.slopeAt(D("2020-01-20")) > 0 && mm.slopeAt(D("2020-01-20")) <= mm.monthW, mm.slopeAt(D("2020-01-20")).toFixed(2));

const many = R.buildScale(Array.from({ length: 60 }, (_, i) => D("2022-01-01") + i * 3), { until: D("2023-02-01") });
t("同一份换算里点越晚越靠下", many.xOf(D("2022-01-01")) < many.xOf(D("2022-06-01")) && many.xOf(D("2022-06-01")) < many.xOf(D("2023-01-01")));
const back = many.dayAt(many.xOf(D("2022-05-05")));
t("坐标能反查回那一天", Math.abs(back - D("2022-05-05")) <= 1, back + " / " + D("2022-05-05"));
const outX = many.xOf(D("2024-01-01"));
t("两端之外按一天一份往外推", outX > many.width && Math.abs(many.xOf(D("2024-01-02")) - outX - R.PXD) < 0.01, outX.toFixed(1));

/* ---- 三、封面落在起止的中点 ---- */
console.log("[3] 落点那天");
const oneDayBook = R.midDay({ start: "2022-12-01", end: "2022-12-01", anchor: "2022-12-01" });
t("当天读完落在当天", oneDayBook === D("2022-12-01"));
const spanBook = R.midDay({ start: "2022-11-01", end: "2022-12-01", anchor: "2022-12-01" });
t("跨天的落在中间那天", spanBook === D("2022-11-16"), R.dayStr(spanBook));
const onlyStart = R.midDay({ start: "2022-11-01", end: "", anchor: "2022-11-01" });
t("只填了开始就按开始算", onlyStart === D("2022-11-01"));

/* ---- 四、刻度 ---- */
console.log("[4] 刻度");
const days = [];
for (let d = D("2021-06-01"); d <= D("2022-06-30"); d++) days.push(d);
const year = R.buildScale(days, { until: D("2022-06-30") });
const at1 = R.ticks(year, D("2022-01-01"), D("2022-03-31"), 1);
t("1 倍下按月标", at1.some((x) => x.kind === "month" && x.label), at1.filter((x) => x.kind === "month").length + " 个");
t("1 倍下也有年刻度", at1.some((x) => x.kind === "year"));
t("1 倍下没有日刻度", !at1.some((x) => x.kind === "day"), at1.filter((x) => x.kind === "day").length + " 个");
const jan = at1.filter((x) => Math.abs(x.x - year.xOf(D("2022-01-01"))) < 0.01);
t("一月和别的月一样有月刻度", jan.some((x) => x.kind === "month" && x.label === "1月"), jan.map((x) => x.kind + ":" + x.label).join(" / "));
t("一月的年刻度也还在", jan.some((x) => x.kind === "year" && x.label === "2022"));
const at5 = R.ticks(year, D("2022-01-01"), D("2022-02-28"), 5);
t("放大后出现日刻度", at5.some((x) => x.kind === "day"), at5.filter((x) => x.kind === "day").length + " 个");
t("放大后月刻度也还在", at5.some((x) => x.kind === "month"));
t("日刻度只画线，不写字", at5.filter((x) => x.kind === "day").every((x) => x.label === ""), at5.filter((x) => x.kind === "day").length + " 个");
/* 日刻度只有一条门槛：够倍数就天天都画。不挑间距、不看那天多宽、月初也照画 */
t("日刻度一天一根，一根不落", (() => {
  const ds = at5.filter((x) => x.kind === "day");
  const from = Math.floor(D("2022-01-01")) - 1;
  const to = Math.ceil(D("2022-02-28")) + 1;
  if (ds.length !== to - from + 1) return false;
  return ds.every((x) => Math.abs(x.x - year.xOf(year.dayAt(x.x))) < 1e-6);
})(), at5.filter((x) => x.kind === "day").length + " 个");
/* 一个月里只有两天有书，其余日子按 pxd 摊得很细 —— 细日子也一根不少 */
const thin = R.buildScale([D("2023-05-03"), D("2023-05-17")], { until: D("2023-06-30") });
const thinTicks = R.ticks(thin, D("2023-05-01"), D("2023-05-31"), 2);
const inMay = (sc, list) =>
  list.filter((x) => x.kind === "day" && R.dayStr(sc.dayAt(x.x)).startsWith("2023-05")).length;
t("月里每一天都有日刻度", inMay(thin, thinTicks) === 31, inMay(thin, thinTicks) + " 根 / 31 天");
/* 有书的那个月每天都盖着线，也一样天天地画，不因为书挤就跳着来 */
const densed = [];
for (let d = D("2023-05-01"); d <= D("2023-05-31"); d++) densed.push(d);
for (let i = 0; i < 10; i++) densed.push(D("2023-05-12"));
const dense = R.buildScale(densed, { until: D("2023-06-30") });
const denseTicks = R.ticks(dense, D("2023-05-01"), D("2023-05-31"), 2);
t("书挤的那一个月也是每天都画", inMay(dense, denseTicks) === 31, inMay(dense, denseTicks) + " 根 / 31 天");
t("倍数不到就不画日刻度", R.ticks(thin, D("2023-05-01"), D("2023-05-31"), 1).every((x) => x.kind !== "day"));
t("刻度上再没有星期标记", at5.every((x) => x.sun === undefined));
t("刻度按位置排好队", at5.every((x, i) => i === 0 || at5[i - 1].x <= x.x));
t("标签不叠在一起", (() => {
  const labs = at5.filter((x) => x.label && x.kind === "month");
  for (let i = 1; i < labs.length; i++) if (labs[i].x * 5 - labs[i - 1].x * 5 < 16) return false;
  return true;
})());
const holeTicks = R.ticks(hole, D("2012-03-01"), D("2012-06-30"), 1);
t("一本书没读的年份照样有月刻度", holeTicks.some((x) => x.kind === "month" && x.label), holeTicks.map((x) => x.kind).join(",").slice(0, 40));

/* ---- 五、刻度管的那一段与导航条 ---- */
console.log("[5] 区间与导航");
const segs = at1.filter((x) => x.kind === "month");
t("月刻度带着它管的那一段宽度", segs.length > 0 && segs.every((x) => x.w > 0), segs.length + " 根");
t("月刻度管的一段就是月宽", Math.abs(segs[0].w - year.monthW) < 0.01, segs[0].w.toFixed(1) + " / " + year.monthW.toFixed(1));
const yTick = at1.find((x) => x.kind === "year" && x.label === "2022");
t("年刻度从一月一号那道线起", !!yTick && Math.abs(yTick.x - year.xOf(D("2022-01-01"))) < 0.01);
t("年刻度管的是整整一年", !!yTick && Math.abs(yTick.w - 12 * year.monthW) < 0.01, yTick ? yTick.w.toFixed(1) : "");
/* 一屏只装一个多月，年线早就滚出去了，这枚淡字还得在，靠的是按整年判交集 */
const midYear = R.ticks(year, D("2022-07-01"), D("2022-07-31"), 1);
t("滚到年中，这一年照样挂着年刻度", midYear.some((x) => x.kind === "year" && x.label === "2022"), midYear.filter((x) => x.kind === "year").map((x) => x.label).join("/"));
t("日刻度管的就是一天", at5.filter((x) => x.kind === "day").every((x) => Math.abs(x.w - year.slopeAt(year.dayAt(x.x))) < 0.01));
const monthTick = segs[0];
t("月刻度的落点就是月初", Math.abs(monthTick.x - year.xOf(D("2022-01-01"))) < 0.01, monthTick.label);

const anchors = ["2022-05-01", "2019-03-02", "2022-01-09", "2024-11-30"];
/* 导航条另用一份覆盖 2019 到 2024 的换算，最后一年只到「今天」所以不等宽 */
const navSc = R.buildScale([D("2019-03-02"), ...days, D("2024-11-30")], { until: D("2024-11-30") });
const bands = R.yearBands(anchors, navSc);
t("一年一格不断档", bands.length === 6, bands.length + " 格");
const midX = navSc.xOf(D("2022-05-01"));
t("落点落在哪一年认得出来", R.navBandAt(bands, midX)?.y === 2022, String(R.navBandAt(bands, midX)?.y));
t("中间那些年也是一年一整格", bands.slice(1, -1).every((b) => Math.abs(b.x1 - b.x0 - 12 * navSc.monthW) < 0.01));

/* 条铺的是一段固定的世界坐标（默认整条轴），滑块左沿就是视野起点在条上的分位。
   跟剪辑软件那条进度条同一套：位置与内容一一对应，拖多少走多少，不存在边走边
   换尺子 */
const winSc = R.buildScale([D("2010-01-05"), ...days, D("2024-11-30")], { until: D("2024-11-30") });
const yrW = 12 * winSc.monthW;
const wmid = winSc.xOf(D("2019-06-01"));
const vw0 = 220;
const v0 = wmid - vw0 / 2;
const full = R.fullRange(winSc.width);
const th = R.navThumb(full, v0, vw0);
t("滑块宽就是视野占整条轴的分位", Math.abs(th.w - vw0 / winSc.width) < 1e-9, (th.w * 100).toFixed(3) + "%");
t("滑块左沿就是视野起点的分位", Math.abs(th.l - v0 / winSc.width) < 1e-9, (th.l * 100).toFixed(2) + "%");
t("滑块中心对着视野中心", Math.abs((th.l + th.w / 2) * winSc.width - wmid) < 0.01);
t(
  "视野到轴尽头时滑块正好贴到右端",
  Math.abs(R.navThumb(full, winSc.width - vw0, vw0).l - (1 - vw0 / winSc.width)) < 1e-9
);
const thOver = R.navThumb(full, winSc.width + 500, vw0);
t("滑块不越出条外", R.navThumb(full, -500, vw0).l === 0 && thOver.l + thOver.w <= 1.0000001);
t("缩得越远滑块越长", R.navThumb(full, wmid, vw0 * 3).w > th.w * 2.9, (R.navThumb(full, wmid, vw0 * 3).w * 100).toFixed(3) + "%");
/* 拖动是线性的：手在条上挪一成，内容也挪一成。这一条要是破了，拖起来就会加速 */
const thA = R.navThumb(full, winSc.width * 0.3, vw0);
const thB = R.navThumb(full, winSc.width * 0.4, vw0);
t("手挪一成，内容也挪一成", Math.abs(thB.l - thA.l - 0.1) < 1e-9, ((thB.l - thA.l) * 100).toFixed(3) + "%");
t("分位与世界坐标来回换", Math.abs(R.navX(full, R.navAt(full, wmid)) - wmid) < 0.01);
t("年宽度没变过，条长与视野无关", Math.abs(yrW - 12 * winSc.monthW) < 1e-9);

/* ---- 六、导航条上每本书那根线 ---- */
console.log("[6] 导航条的书线");
const navList = [
  { id: "a", title: "甲", start: "2019-03-02", end: "2019-03-02", anchor: "2019-03-02" },
  { id: "b", title: "乙", start: "2021-08-01", end: "2021-09-01", anchor: "2021-09-01" },
  { id: "c", title: "丙", start: "2022-05-01", end: "2022-05-01", anchor: "2022-05-01" },
  { id: "d", title: "丁", start: "2024-11-30", end: "2024-11-30", anchor: "2024-11-30" }
];
const fullNav = R.fullRange(navSc.width);
const mk = R.navMarks(navList, navSc, fullNav);
t("每本书都有一根线", mk.length === navList.length, mk.length + " 根");
t("线按位置排队", mk.every((m, i) => i === 0 || mk[i - 1].p <= m.p), mk.map((m) => m.p.toFixed(3)).join(" / "));
t("线的分位就是它在整条轴上的位置", mk.every((m) => Math.abs(m.p - m.x / navSc.width) < 1e-6));
t("线的位置与拖动反查是同一把尺子", mk.every((m) => Math.abs(R.navX(fullNav, R.navAt(fullNav, m.x)) - m.x) < 0.01));
t("线落在书落点那天", navList.every((e) => {
  const m = mk.find((x) => x.id === e.id);
  return !!m && Math.abs(m.x - navSc.xOf(R.midDay(e))) < 0.01;
}), mk.map((m) => m.p.toFixed(3)).join(" / "));
t("气泡里写着书名与月-日", /^丙 · 05-01$/.test(mk[2].text), mk[2].text);
const tol = (5 / 300) * navSc.width;
t("最近的线认得出来", R.nearestMark(mk, mk[2].x + 40, tol)?.id === "c", String(R.nearestMark(mk, mk[2].x + 40, tol)?.id));
t("隔得远就不认", R.nearestMark(mk, mk[2].x + 4000, tol) === null);
t("没有书的时候给空", R.navMarks([], navSc, fullNav).length === 0);

/* ---- 七、选了一段年份，条就只铺那几年 ---- */
console.log("[7] 显示区间");
const yrWin = R.yearRange(navSc, 2020, 2022);
t(
  "区间从那年一月铺到末年十二月",
  Math.abs(yrWin.a - navSc.xOf(D("2020-01-01"))) < 0.01 && Math.abs(yrWin.b - navSc.xOf(D("2023-01-01"))) < 0.01,
  Math.round(yrWin.a) + "–" + Math.round(yrWin.b)
);
/* 区间短了，同样的视野在条上占得更长 —— 这就是「条会相应扩充」的意思 */
const thYear = R.navThumb(yrWin, navSc.xOf(D("2021-06-01")) - vw0 / 2, vw0);
t("只铺这几年，同样的视野滑块长得多", thYear.w > th.w * 2, (thYear.w * 100).toFixed(2) + "% 对 " + (th.w * 100).toFixed(3) + "%");
t("区间里滑块左沿按那几年算", Math.abs(R.navAt(yrWin, navSc.xOf(D("2020-01-01"))) - 0) < 1e-9);
const mkWin = R.navMarks(navList, navSc, yrWin);
t(
  "区间外的书不给线",
  mkWin.length === 2 && mkWin.every((m) => m.id === "b" || m.id === "c"),
  mkWin.map((m) => m.id).join(" / ")
);
t("区间里书的分位按那几年算", mkWin.every((m) => Math.abs(R.navX(yrWin, m.p) - m.x) < 1));
t("两头颠倒也认", Math.abs(R.yearRange(navSc, 2022, 2020).a - yrWin.a) < 0.01);
/* 区间里有几年：年份字那一层按这个挑，写不下就隔几个写一个 */
const bandYears = R.yearBands(navList.map((e) => e.anchor), navSc).filter(
  (b) => b.x1 > yrWin.a && b.x0 < yrWin.b
);
t("区间里有几年的数得出来", bandYears.length === 3, bandYears.map((b) => b.y).join(" / "));

console.log("\n时间轴换算 " + ok + "/" + (ok + bad) + " 通过");
