import { useEffect, useMemo, useState } from "react";
import api from "../api";
import ReadFeed from "./ReadFeed";
import ReadAxis from "./ReadAxis";
import { buildScale, dayNum, dayStr, midDay, yearBands, yearRange } from "../../shared/readScale";
import type { ReadEntry, ReadStats } from "../../shared/types";

/**
 * 阅读时间线。同一份数据两种排布，右上角切「竖排／横排」，选择记在本地。
 * 只算小说，漫画不进这里，所以没有媒介筛选这一说。
 * 日期到坐标的换算在这里算一次，两屏共用，切排布时落点不跳。
 * 点条目、点横轴上的封面，开的都是书架那个详情抽屉。
 *
 * 顶栏还挂着「显示区间」：两个年份框，直接写四位数字，右边一对上下箭头各调一年。
 * 默认就是最早那本到今年，点重置也回到这一段。只铺那几年时导航条就相应扩充 ——
 * 二十几年摊在一千多像素里一像素跨半个月，只铺三五年就够了，金线散得开、
 * 逐年逐本都拖得准。区间记在本地，下次打开还是这一段。
 */
interface Props {
  /** 写操作之后加一，用来重新取数 */
  ver: number;
  onPick: (id: string) => void;
}

const LAYOUT_KEY = "booklib.readLayout";
const RANGE_KEY = "booklib.readRange";

/** 「2016-2022」这样的串；空的或者不成样子就当没选 */
function parseRange(s: string | null): { y0: number; y1: number } | null {
  const m = /^(\d{4})-(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const y0 = Number(m[1]);
  const y1 = Number(m[2]);
  if (!(y0 >= 1900 && y1 >= y0 && y1 <= 2200)) return null;
  return { y0, y1 };
}

/**
 * 一个四位年份框，右边一对上下箭头各调一年。
 * 手离框（或者按回车）就按上下界夹住 —— 早于最早那本、晚于今年的都写不进去。
 */
function YearBox({
  value,
  min,
  max,
  onChange,
  title
}: {
  value: number;
  min: number;
  max: number;
  onChange: (y: number) => void;
  title: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const put = (y: number) => {
    const v = Math.min(max, Math.max(min, y));
    setText(String(v));
    if (v !== value) onChange(v);
  };
  /* 框里正写着一个像样的年份就跟着它走，别把打字的结果丢掉 */
  const base = () => {
    const n = Number(text.replace(/\D/g, ""));
    return text.trim() && n >= 1900 ? n : value;
  };
  const commit = () => {
    const n = Number(text.replace(/\D/g, ""));
    if (!text.trim() || !Number.isFinite(n)) setText(String(value));
    else put(n);
  };

  return (
    <span className="rd-year" title={title}>
      <input
        className="rd-year-in"
        value={text}
        inputMode="numeric"
        maxLength={4}
        aria-label={title}
        onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            put(base() + 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            put(base() - 1);
          }
        }}
      />
      <span className="rd-year-steps">
        <button
          className="rd-year-step up"
          tabIndex={-1}
          disabled={value >= max}
          title="加一年"
          onClick={() => put(base() + 1)}
        >
          ▲
        </button>
        <button
          className="rd-year-step down"
          tabIndex={-1}
          disabled={value <= min}
          title="减一年"
          onClick={() => put(base() - 1)}
        >
          ▼
        </button>
      </span>
    </span>
  );
}

export default function ReadView({ ver, onPick }: Props) {
  const [list, setList] = useState<ReadEntry[]>([]);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<"feed" | "axis">(() =>
    localStorage.getItem(LAYOUT_KEY) === "axis" ? "axis" : "feed"
  );
  /** 显示区间；null 是没动过，按「最早那本到今年」算 */
  const [range, setRange] = useState<{ y0: number; y1: number } | null>(() =>
    parseRange(localStorage.getItem(RANGE_KEY))
  );

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

  useEffect(() => {
    localStorage.setItem(RANGE_KEY, range ? range.y0 + "-" + range.y1 : "");
  }, [range]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.readTimeline(), api.readStats()])
      .then(([l, s]) => {
        if (!alive) return;
        setList(l);
        setStats(s);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ver]);

  /* 换算按每条落点那天（起止的中点）建，两屏共用，切排布时落点不跳。
     轴一直铺到今天，最后一本书之后那段日子也留着位置 */
  const sc = useMemo(() => {
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    return buildScale(list.map(midDay), { until: dayNum(today) });
  }, [list]);

  /* 年份分段与导航条那一段在两屏之间共用一份，切排布时条上的刻度不跳 */
  const bands = useMemo(() => yearBands(list.map((e) => e.anchor), sc), [list, sc]);
  const years = useMemo(() => bands.map((b) => b.y), [bands]);
  /* 两头能写到哪儿：最早有书的那年、今年。框里写超了就夹回来。
     最早那年的口径跟轴一致 —— 取轴开头那一年，不取年段表，免得跨年的那本
     落点在上一年、区间一卡就把它滤掉 */
  const nowY = new Date().getFullYear();
  const yearLo = list.length ? Number(dayStr(sc.first).slice(0, 4)) : nowY;
  const yearHi = Math.max(nowY, yearLo);
  /* 存的区间可能落在书的范围外头（书删了、日期改了），一进来先夹住 */
  const eff = useMemo(() => {
    const r = range ?? { y0: yearLo, y1: yearHi };
    const y0 = Math.min(Math.max(r.y0, yearLo), yearHi);
    return { y0, y1: Math.min(Math.max(r.y1, y0), yearHi) };
  }, [range, yearLo, yearHi]);
  const navRange = useMemo(() => yearRange(sc, eff.y0, eff.y1), [sc, eff]);

  /** 改一头：另一头跟着让开，始终保持「从」不晚于「到」 */
  const setYear = (side: "from" | "to", y: number) => {
    setRange((r) => {
      const cur = r ?? { y0: yearLo, y1: yearHi };
      const v = Math.min(yearHi, Math.max(yearLo, y));
      return side === "from"
        ? { y0: v, y1: Math.max(v, cur.y1) }
        : { y0: Math.min(v, cur.y0), y1: v };
    });
  };

  return (
    <div className="main">
      <div className="toolbar rd-bar">
        {stats ? (
          <>
            <span>
              <b className="rd-n">{stats.total}</b> 本有日期
            </span>
            <span>
              今年读完 <b className="rd-n">{stats.yearRead}</b> 本
            </span>
            {stats.busiest ? (
              <span>
                最忙 <b className="rd-n">{stats.busiest.n}</b> 本在 {stats.busiest.day}
              </span>
            ) : null}
            {stats.avgRating != null ? (
              <span>
                均分 <b className="rd-n">{stats.avgRating}</b>
              </span>
            ) : null}
            {stats.streak.days > 1 ? (
              <span>
                最长连读 <b className="rd-n">{stats.streak.days}</b> 天，止于 {stats.streak.end}
              </span>
            ) : null}
            <span className="spacer" />
            {stats.noDate ? <span className="dim">另有 {stats.noDate} 本标了已读、没填日期，落不到这里</span> : null}
            {years.length ? (
              <div className="rd-range">
                <span className="rd-range-name">显示区间</span>
                <YearBox
                  value={eff.y0}
                  min={yearLo}
                  max={eff.y1}
                  onChange={(y) => setYear("from", y)}
                  title={"从哪一年起，最早 " + yearLo}
                />
                <span className="rd-dash">–</span>
                <YearBox
                  value={eff.y1}
                  min={eff.y0}
                  max={yearHi}
                  onChange={(y) => setYear("to", y)}
                  title={"到哪一年止，最晚 " + yearHi}
                />
                <button className="mini xs" onClick={() => setRange(null)} title={"回到 " + yearLo + " – " + yearHi}>
                  重置
                </button>
              </div>
            ) : null}
            <div className="seg rd-switch">
              <button className={layout === "feed" ? "on" : ""} onClick={() => setLayout("feed")}>
                竖排
              </button>
              <button className={layout === "axis" ? "on" : ""} onClick={() => setLayout("axis")}>
                横排
              </button>
            </div>
          </>
        ) : (
          <span>读取中…</span>
        )}
      </div>

      <div className={"scroll" + (layout === "axis" ? " rd-axscroll" : " rd-feedscroll")}>
        {!list.length ? (
          <div className="empty">{loading ? "读取中…" : "还没有一本填了阅读时间"}</div>
        ) : layout === "axis" ? (
          <ReadAxis list={list} sc={sc} bands={bands} navRange={navRange} onPick={onPick} />
        ) : (
          <ReadFeed list={list} sc={sc} bands={bands} navRange={navRange} onPick={onPick} />
        )}
      </div>
    </div>
  );
}
