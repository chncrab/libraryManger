import { useEffect, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookRow, SeriesInfo, SeriesPatch } from "../../shared/types";

interface Props {
  series: SeriesInfo;
  onClose: () => void;
  onOpenBook: (id: string) => void;
  onWriteReview: (s: SeriesInfo) => void;
  onFilterSeries: (s: SeriesInfo) => void;
  /** 改完名字让外面重取系列网格与左栏分面 */
  onChanged: () => void;
}

/** 点系列卡弹这一层：列出系列里每一本，底部两个动作 */
export default function SeriesPanel({ series, onClose, onOpenBook, onWriteReview, onFilterSeries, onChanged }: Props) {
  const [info, setInfo] = useState<SeriesInfo>(series);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [hasReview, setHasReview] = useState(false);
  /* 编辑态存两个草稿名，保存成功才写库 */
  const [edit, setEdit] = useState<{ name: string; zhName: string } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.seriesBooks(series.id).then((r) => alive && setBooks(r));
    api.seriesReview(series.id).then((r) => alive && setHasReview(!!r));
    return () => {
      alive = false;
    };
  }, [series.id]);

  /* 编辑态里按 Esc 先退出编辑，再按一次才关面板。
     注册在捕获阶段：外面那层 App 的 Esc 监听在冒泡阶段，会直接把面板收掉 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (edit) setEdit(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [edit, onClose]);

  const save = async () => {
    if (!edit || busy) return;
    const patch: SeriesPatch = {};
    if (edit.name !== info.name) patch.name = edit.name;
    if (edit.zhName !== info.zhName) patch.zhName = edit.zhName;
    if (patch.name === undefined && patch.zhName === undefined) {
      setEdit(null);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.seriesUpdate(info.id, patch);
      if (!r.ok) {
        setErr(r.msg || "没有改成");
        return;
      }
      if (r.series) setInfo(r.series);
      setNote(r.msg || "");
      setEdit(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const keyIn = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") void save();
  };

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <aside className="drawer on" aria-label="系列">
        <div className="dwrap">
          <div className="dh">
            <h2>
              {info.label}
              {info.original && info.original !== info.label ? (
                <span className="dim dorig" title="系列原名">
                  {" "}
                  {info.original}
                </span>
              ) : null}
            </h2>
            {edit ? null : (
              <span className="dim">
                {info.n} 册 · 已读 {info.read}
                {info.avg != null ? " · ★ " + info.avg.toFixed(1) : ""}
              </span>
            )}
            {edit ? null : (
              <button
                className="mini xs"
                title="改这个系列的译名与原名"
                onClick={() => {
                  setErr("");
                  setNote("");
                  setEdit({ name: info.name, zhName: info.zhName });
                }}
              >
                改名
              </button>
            )}
            <button className="xbtn" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>

          {edit ? (
            <div className="sedit">
              <div className="sedit-r">
                <span className="sedit-l">系列译名</span>
                <input
                  autoFocus
                  value={edit.zhName}
                  placeholder="没有译名就空着，显示时退回原名"
                  onChange={(e) => setEdit({ ...edit, zhName: e.target.value })}
                  onKeyDown={keyIn}
                />
              </div>
              <div className="sedit-r">
                <span className="sedit-l">系列原名</span>
                <input
                  value={edit.name}
                  placeholder="原作语言的写法"
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  onKeyDown={keyIn}
                />
              </div>
              <p className="sedit-hint">
                原名是系列的身份，也决定系列总评的文件名，改了会连文件一起改名。译名只用于显示与搜索，改它不动文件。
              </p>
              {err ? <p className="sedit-err">{err}</p> : null}
              <div className="sedit-acts">
                <button className="mini" disabled={busy} onClick={() => void save()}>
                  {busy ? "保存中…" : "保存"}
                </button>
                <button className="mini" onClick={() => setEdit(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {note ? <div className="snote">{note}</div> : null}

          <div className="sb-list">
            {books.map((b) => (
              <div key={b.id} className="sb-i" onClick={() => onOpenBook(b.id)}>
                {b.cover ? <img className="sb-cov" src={coverUrl(b.cover, b.coverV)} alt="" loading="lazy" /> : <div className="sb-cov empty" />}
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
            <button className="mini" onClick={() => onWriteReview(info)} title={hasReview ? "去写这个系列的总评" : "为整个系列新建一篇总评"}>
              {hasReview ? "查看系列书评" : "写系列书评"}
            </button>
            <button className="mini" onClick={() => onFilterSeries(info)}>
              只看本系列
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
