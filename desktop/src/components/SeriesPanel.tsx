import { useEffect, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookRow, SeriesInfo } from "../../shared/types";

interface Props {
  series: SeriesInfo;
  onClose: () => void;
  onOpenBook: (id: string) => void;
  onWriteReview: (s: SeriesInfo) => void;
  onFilterSeries: (s: SeriesInfo) => void;
}

/** 点系列卡弹这一层：列出系列里每一本，底部两个动作 */
export default function SeriesPanel({ series, onClose, onOpenBook, onWriteReview, onFilterSeries }: Props) {
  const [books, setBooks] = useState<BookRow[]>([]);
  const [hasReview, setHasReview] = useState(false);

  useEffect(() => {
    let alive = true;
    api.seriesBooks(series.id).then((r) => alive && setBooks(r));
    api.seriesReview(series.id).then((r) => alive && setHasReview(!!r));
    return () => {
      alive = false;
    };
  }, [series.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <aside className="drawer on" aria-label="系列">
        <div className="dwrap">
          <div className="dh">
            <h2>{series.label}</h2>
            <span className="dim">
              {series.n} 册 · 已读 {series.read}
              {series.avg != null ? " · ★ " + series.avg.toFixed(1) : ""}
            </span>
            <button className="xbtn" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>

          <div className="sb-list">
            {books.map((b) => (
              <div key={b.id} className="sb-i" onClick={() => onOpenBook(b.id)}>
                {b.cover ? <img className="sb-cov" src={coverUrl(b.cover)} alt="" loading="lazy" /> : <div className="sb-cov empty" />}
                <div className="sb-b">
                  <div className="sb-t">{b.title}</div>
                  <div className="sb-m">
                    {b.seriesIndex != null ? "第 " + b.seriesIndex + " 册 · " : ""}
                    {b.authors[0] || "佚名"}
                    {b.isRead ? " · 已读" : ""}
                  </div>
                </div>
                <span className="sb-r">{b.rating != null && b.rating > 0 ? b.rating.toFixed(1) : ""}</span>
              </div>
            ))}
            {books.length === 0 ? <div className="empty">这个系列下暂时没有在架的书</div> : null}
          </div>

          <div className="sb-foot">
            <button className="mini" onClick={() => onWriteReview(series)} title={hasReview ? "去写这个系列的总评" : "为整个系列新建一篇总评"}>
              {hasReview ? "查看系列书评" : "写系列书评"}
            </button>
            <button className="mini" onClick={() => onFilterSeries(series)}>
              只看本系列
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
