import { useEffect, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookRow } from "../../shared/types";

interface Props {
  hint?: string;
  onPick: (id: string) => void;
  onCancel: () => void;
}

/* 挑一本书：关联书评、换挂靠都用这个。默认给刚读过的排在前面没意义，
   直接按书名，用户会搜 */
export default function BookPicker({ hint, onPick, onCancel }: Props) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<BookRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.listBooks({ q: q.trim(), limit: 40, sorts: [{ key: "title", dir: 1 }] }).then((r) => setRows(r.rows));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && sel) onPick(sel);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [sel, onPick, onCancel]);

  return (
    <>
      <div className="mask on" onClick={onCancel} />
      <div className="bpick">
        <div className="cad-h">
          <h3>选择书籍</h3>
          <span className="dim">{hint || "搜书名或作者"}</span>
          <span className="spacer" />
          <button className="xbtn" onClick={onCancel} title="关闭（Esc）" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="bp-q">
          <input autoFocus placeholder="书名、作者、原名" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="bp-list">
          {rows.map((b) => (
            <div
              key={b.id}
              className={"bp-i" + (sel === b.id ? " on" : "")}
              onClick={() => setSel(b.id)}
              onDoubleClick={() => onPick(b.id)}
            >
              {b.cover ? <img src={coverUrl(b.cover)} alt="" /> : <div className="bp-cov" />}
              <div className="bp-t">
                <div>{b.title}</div>
                <div className="dim">
                  {b.authors.join("、")}
                  {b.seriesName ? " · " + b.seriesName : ""}
                  {b.reviewGrade ? " · 已有书评" : ""}
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 ? <div className="empty">没搜到</div> : null}
        </div>
        <div className="cad-foot">
          <span className="dim">双击直接选定</span>
          <span className="spacer" />
          <button className="mini" disabled={!sel} onClick={() => sel && onPick(sel)}>
            确定绑定
          </button>
        </div>
      </div>
    </>
  );
}
