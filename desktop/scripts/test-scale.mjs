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

/* ---- 一、日期换算 ---- */
console.log("[1] 日期");
t("日月能来回换", R.dayStr(D("2022-12-01")) === "2022-12-01", R.dayStr(D("2022-12-01")));
t("跨月天数对得上", D("2022-03-01") - D("2022-02-28") === 1);
t("闰年二月有 29 天", D("2024-03-01") - D("2024-02-28") === 2);
t("长条两头的日号只写数字", R.dayLabel(D("2022-12-05")) === "5" && R.dayLabel(D("2022-12-31")) === "31", R.dayLabel(D("2022-12-05")));
t("星期天认得出来", R.isSunday(D("2022-01-02")) === true && R.isSunday(D("2022-01-03")) === false);
t("空串给 NaN", Number.isNaN(D("")));

/* ---- 二、落点：按月排，一个月一格宽 ---- */
console.log("[2] 换算");
const sparse = R.buildScale([D("2020-01-01"), D("2020-02-20")]);
t("有书的月自己撑开一档", sparse.xOf(D("2020-02-20")) > 50 * R.PXD, sparse.xOf(D("2020-02-20")).toFixed(1));
const oneDay = R.buildScale([D("2020-01-01"), D("2020-01-02")]);
t("隔一天也留出一本书的位", oneDay.xOf(D("2020-01-02")) >= R.SLOT / R.LANES - 0.01, oneDay.xOf(D("2020-01-02")).toFixed(1));
const four = R.buildScale([D("2020-01-01"), D("2020-01-01"), D("2020-01-01"), D("2020-01-01"), D("2020-01-02")]);
/* 四本分两轨，每轨两本，一天要占 4 * slot / 2 */
t("同一天四本占两格", Math.abs(four.xOf(D("2020-01-02")) - (4 * R.SLOT) / R.LANES) < 0.5, four.xOf(D("2020-01-02")).toFixed(1));

/* 一月一格：长月、短月一样宽，全轴取过得最满的那个月 */
const mm = R.buildScale([D("2020-01-05"), D("2020-02-05"), D("2020-03-05")]);
const wJan = mm.xOf(D("2020-02-01")) - mm.xOf(D("2020-01-01"));
const wFeb = mm.xOf(D("2020-03-01")) - mm.xOf(D("2020-02-01"));
t("一月的宽度就是月宽", Math.abs(wJan - mm.monthW) < 0.01, wJan.toFixed(1));
t("二月二十八天也和一月的三十一天一样宽", Math.abs(wJan - wFeb) < 0.01, wJan.toFixed(1) + " / " + wFeb.toFixed(1));
t("月宽不窄于日历上最长的月", mm.monthW >= 31 * R.PXD - 0.01, mm.monthW.toFixed(1));
/* 某天读五本的那个月最挤，全轴就都按它的宽度排 */
const widest = R.buildScale([D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-01-05"), D("2020-02-09")]);
t("最挤的那个月定下全轴月宽", widest.monthW >= (5 * R.SLOT) / R.LANES, widest.monthW.toFixed(1));
t("只读过一本的月也按这个宽排", Math.abs(widest.xOf(D("2020-02-01")) - widest.xOf(D("2020-01-01")) - widest.monthW) < 0.01);
/* 稀疏的月份把日子摊开填满那一格，而不是把空白留在月末 */
const stretched = R.buildScale([
  D("2020-01-05"),
  D("2020-01-05"),
  D("2020-01-05"),
  D("2020-01-05"),
  D("2020-01-05"),
  D("2020-02-09"),
  D("2020-03-20")
]);
const sparseW = stretched.slopeAt(D("2020-02-11"));
t("书少的月份把日子摊开填满一格", sparseW > R.PXD * 1.2, sparseW.toFixed(2));
t(
  "摊开之后二月到三月也正好一格",
  Math.abs(stretched.xOf(D("2020-03-01")) - stretched.xOf(D("2020-02-01")) - stretched.monthW) < 0.01,
  (stretched.xOf(D("2020-03-01")) - stretched.xOf(D("2020-02-01"))).toFixed(1) + " / " + stretched.monthW.toFixed(1)
);
t("摊开之后每天仍是正的、且按天排", sparseW > 0 && stretched.xOf(D("2020-02-11")) < stretched.xOf(D("2020-02-12")));
t(
  "最满的那个月一天也没多摊",
  Math.abs(stretched.slopeAt(D("2020-01-20")) - R.PXD) < 0.01,
  stretched.slopeAt(D("2020-01-20")).toFixed(2)
);

/* 一天是相邻两点之间的一段 */
const stepDay = D("2020-01-11");
t(
  "这天的宽度就是相邻两点的距离",
  Math.abs(mm.xOf(stepDay + 1) - mm.xOf(stepDay) - mm.slopeAt(stepDay)) < 0.01,
  mm.slopeAt(stepDay).toFixed(2)
);
t("没书的一天仍然是一天的宽", Math.abs(mm.slopeAt(D("2020-01-20")) - R.PXD) < 0.01, mm.slopeAt(D("2020-01-20")).toFixed(2));

const hole = R.buildScale([D("2010-01-01"), D("2016-01-01")]);
const holeGap = hole.xOf(D("2016-01-01")) - hole.xOf(D("2010-01-01")) - hole.monthW;
t("几年没读的空档压到上限", Math.abs(holeGap - R.MAX_GAP) < 0.5, holeGap.toFixed(1));
const many = R.buildScale(Array.from({ length: 60 }, (_, i) => D("2022-01-01") + i * 3));
const mono = many.xOf(D("2022-01-01")) < many.xOf(D("2022-06-01")) && many.xOf(D("2022-06-01")) < many.xOf(D("2023-01-01"));
t("同一份换算里点越晚越靠右", mono);
const back = many.dayAt(many.xOf(D("2022-05-05")));
t("坐标能反查回那一天", Math.abs(back - D("2022-05-05")) <= 1, back + " / " + D("2022-05-05"));
const outX = many.xOf(D("2024-01-01"));
t(
  "两端之外按一天一份往外推",
  outX > many.width && Math.abs(many.xOf(D("2024-01-02")) - outX - R.PXD) < 0.01,
  outX.toFixed(1)
);

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
const year = R.buildScale(days);
const at1 = R.ticks(year, D("2022-01-01"), D("2022-03-31"), 1);
t("1 倍下按月标", at1.some((x) => x.kind === "month" && x.label), at1.filter((x) => x.kind === "month").length + " 个");
t("1 倍下也有年刻度", R.ticks(year, D("2022-01-01"), D("2022-03-31"), 1).some((x) => x.kind === "year"));
const at5 = R.ticks(year, D("2022-01-01"), D("2022-02-28"), 5);
t("放到 5 倍出现日刻度", at5.some((x) => x.kind === "day"), at5.filter((x) => x.kind === "day").length + " 个");
const suns = at5.filter((x) => x.kind === "day" && x.sun);
t("日刻度一律不写日号", !at5.some((x) => x.kind === "day" && x.label), at5.filter((x) => x.kind === "day" && x.label).length + " 个带字");
t("星期天那几根单独标出来", suns.length > 5, suns.length + " 根");
const sunDays = suns.map((x) => year.dayAt(x.x));
t("周日之间正好隔七天", sunDays.every((d, i) => i === 0 || d - sunDays[i - 1] === 7), sunDays.slice(0, 4).join(","));
t("月刻度不是周日也照样标月", at5.some((x) => x.kind === "month"));
t("刻度按位置排好队", at5.every((x, i) => i === 0 || at5[i - 1].x <= x.x));
t("标签不叠在一起", (() => {
  const labs = at5.filter((x) => x.label);
  for (let i = 1; i < labs.length; i++) if (labs[i].x * 5 - labs[i - 1].x * 5 < 16) return false;
  return true;
})());
const inHole = R.buildScale([D("2010-01-01"), D("2016-01-01")]);
const holeTicks = R.ticks(inHole, D("2011-01-01"), D("2015-12-31"), 1);
t("压住的空档里只剩年刻度", holeTicks.every((x) => x.kind === "year"), holeTicks.map((x) => x.kind).join(","));

/* ---- 五、刻度管的那一段与导航条 ---- */
console.log("[5] 区间与导航");
const segs = at1.filter((x) => x.kind === "month");
t("月刻度带着它管的那一段宽度", segs.length > 0 && segs.every((x) => x.w > 0), segs.length + " 根");
t("月刻度管的一段就是月宽", Math.abs(segs[0].w - year.monthW) < 0.01, segs[0].w.toFixed(1) + " / " + year.monthW.toFixed(1));
const yTick = at1.find((x) => x.kind === "year");
t("年刻度从一月一号那道线起", !!yTick && Math.abs(yTick.x - year.xOf(D("2022-01-01"))) < 0.01);
t("日刻度管的就是一天", at5.filter((x) => x.kind === "day").every((x) => Math.abs(x.w - year.slopeAt(year.dayAt(x.x))) < 0.01));

const anchors = ["2022-05-01", "2019-03-02", "2022-01-09", "2024-11-30"];
const bands = R.yearBands(anchors, year);
t("一年一格不断档", bands.length === 6, bands.length + " 格");
t("拖到半途是中间那年", R.navBand(bands, 0.5)?.y === 2022, String(R.navBand(bands, 0.5)?.y));
const px = year.xOf(D("2022-05-01"));
t("分位与世界坐标能来回换", Math.abs(R.navX(bands, R.navFrac(bands, px)) - px) < 0.01, R.navFrac(bands, px).toFixed(4));

console.log("\n时间轴换算 " + ok + "/" + (ok + bad) + " 通过");
