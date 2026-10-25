import { coverUrl } from "../api";
import type { SeriesInfo } from "../../shared/types";

/** 系列集合视图：一格是一个系列，像影音库的剧集合集 */
export default function SeriesGrid({ list, onOpen }: { list: SeriesInfo[]; onOpen: (s: SeriesInfo) => void }) {
  if (!list.length) return <div className="empty">没有系列</div>;
  return (
    <div className="sgrid">
      {list.map((s) => (
        <div key={s.id} className="scard" onClick={() => onOpen(s)} title={s.name}>
          {s.cover ? <img className="scov" src={coverUrl(s.cover)} alt="" loading="lazy" /> : <div className="scov empty">无封面</div>}
          <div className="st">{s.label}</div>
          <div className="ss">
            {s.n} 册 · 已读 {s.read}
            {s.avg != null ? <b> ★ {s.avg.toFixed(1)}</b> : <span className="dim"> ★ —</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
