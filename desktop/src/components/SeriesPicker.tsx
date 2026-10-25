import { useEffect, useMemo, useState } from "react";
import api from "../api";
import type { SeriesInfo } from "../../shared/types";

/** 挑一个系列，书评右键「关联到系列」时用。书目弹层与它同构，只是列的东西不同 */
export default function SeriesPicker({
  hint,
  onPick,
  onCancel
}: {
  hint?: string;
  onPick: (id: number) => void;
  onCancel: () => void;
}) {
  const [list, setList] = useState<SeriesInfo[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<SeriesInfo | null>(null);

  useEffect(() => {
    api.seriesList("").then(setList);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return list.filter((s) => !k || s.label.toLowerCase().includes(k) || s.name.toLowerCase().includes(k));
  }, [list, q]);

  return (
    <>
      <div className="mask on" onClick={onCancel} />
      <div className="bpick" role="dialog" aria-label="选择系列">
        <div className="cad-h">
          <h3>选择系列</h3>
          <span className="dim">{hint || "搜系列名"}</span>
          <span className="spacer" />
          <button className="xbtn" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="bp-q">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="系列名" autoFocus />
        </div>
        <div className="bp-list">
          {shown.map((s) => (
            <div
              key={s.id}
              className={"bp-i" + (sel?.id === s.id ? " on" : "")}
              onClick={() => setSel(s)}
              onDoubleClick={() => onPick(s.id)}
            >
              <div className="bp-t">
                <div>
                  {s.label}
                  <span className="dim"> · {s.mediaType}</span>
                </div>
                <div className="dim">{s.n} 册{s.read ? " · 已读 " + s.read : ""}</div>
              </div>
            </div>
          ))}
          {shown.length === 0 ? <div className="empty">没有匹配的系列</div> : null}
        </div>
        <div className="cad-foot">
          <span className="dim">双击直接选定</span>
          <span className="spacer" />
          <button className="mini" disabled={!sel} onClick={() => sel && onPick(sel.id)}>
            就用这个系列
          </button>
        </div>
      </div>
    </>
  );
}
