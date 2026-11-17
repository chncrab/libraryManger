import { useEffect, useMemo, useState } from "react";
import api from "../api";
import ReadFeed from "./ReadFeed";
import ReadAxis from "./ReadAxis";
import { buildScale, midDay } from "../../shared/readScale";
import type { ReadEntry, ReadStats } from "../../shared/types";

/**
 * 阅读时间线。同一份数据两种排布，右上角切「竖排／横排」，选择记在本地。
 * 只算小说，漫画不进这里，所以没有媒介筛选这一说。
 * 日期到坐标的换算在这里算一次，两屏共用，切排布时落点不跳。
 * 点条目、点横轴上的封面，开的都是书架那个详情抽屉。
 */
interface Props {
  /** 写操作之后加一，用来重新取数 */
  ver: number;
  onPick: (id: string) => void;
}

const LAYOUT_KEY = "booklib.readLayout";

export default function ReadView({ ver, onPick }: Props) {
  const [list, setList] = useState<ReadEntry[]>([]);
  const [stats, setStats] = useState<ReadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<"feed" | "axis">(() =>
    localStorage.getItem(LAYOUT_KEY) === "axis" ? "axis" : "feed"
  );

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

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

  /* 换算按每条落点那天（起止的中点）建，两屏共用，切排布时落点不跳 */
  const sc = useMemo(() => buildScale(list.map(midDay)), [list]);

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
          <ReadAxis list={list} sc={sc} onPick={onPick} />
        ) : (
          <ReadFeed list={list} sc={sc} onPick={onPick} />
        )}
      </div>
    </div>
  );
}
