import { useEffect, useRef, useState } from "react";
import api from "../api";
import type { CoverApplyResult, CoverCandidate } from "../../shared/types";

interface Props {
  bookId: string;
  bookTitle: string;
  bookAuthors: string[];
  onApplied: (r: CoverApplyResult) => void;
  onClose: () => void;
}

/**
 * 搜封面。输入框吃书名、作者、ISBN 三种，十三位数字走 ISBN 那条，
 * 其余当关键词。候选铺成网格，点一张就落盘，落盘仍走换封面那条老路，
 * 命名、原图移位、撤销都还是原来那套。
 */
export default function CoverSearch({ bookId, bookTitle, bookAuthors, onApplied, onClose }: Props) {
  const [q, setQ] = useState(bookTitle);
  const [list, setList] = useState<CoverCandidate[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [cached, setCached] = useState(false);
  const [backfill, setBackfill] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const firstRun = useRef(true);

  const run = async (kw: string) => {
    const s = kw.trim();
    if (!s) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.searchCovers(s);
      setList(r.candidates || []);
      setCached(!!r.cached);
      setMsg(r.ok ? (r.candidates.length ? "" : "没搜到。台版书用繁体的原名更容易中，也可以直接填 ISBN") : r.msg || "搜不到");
      setThumbs({});
    } finally {
      setBusy(false);
    }
  };

  /* 打开就用手头的书名搜一遍，多半直接有结果，省一次点击 */
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      void run(bookTitle);
    }
  }, [bookTitle]);

  /* 缩略图逐张去主进程取，取到一张填一张，不必等全部回来 */
  useEffect(() => {
    let alive = true;
    for (const c of list) {
      const key = c.id;
      if (thumbs[key]) continue;
      void api.coverThumb(c.pic || c.image).then((url) => {
        if (alive && url) setThumbs((m) => ({ ...m, [key]: url }));
      });
    }
    return () => {
      alive = false;
    };
  }, [list]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const take = async (c: CoverCandidate) => {
    setApplying(c.id);
    setMsg("");
    try {
      const r = await api.applyCover(bookId, c, backfill);
      if (!r.ok) {
        setMsg(r.msg || "没换成");
        return;
      }
      onApplied(r);
    } finally {
      setApplying(null);
    }
  };

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <div className="csrch">
        <div className="cad-h">
          <h3>找封面</h3>
          <span className="dim">
            {bookTitle}
            {bookAuthors.length ? " · " + bookAuthors.join("、") : ""}
          </span>
          <span className="spacer" />
          <button className="xbtn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="csrch-q">
          <input
            autoFocus
            placeholder="书名、作者，或者 ISBN（连 isbn 三个字母一起粘也行）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run(q);
            }}
          />
          <button className="mini" disabled={busy || !q.trim()} onClick={() => void run(q)}>
            {busy ? "搜…" : "搜索"}
          </button>
        </div>

        <div className="csrch-body">
          {list.length ? (
            <div className="csrch-grid">
              {list.map((c) => (
                <div key={c.id} className={"ccard" + (applying === c.id ? " busy" : "")} onClick={() => void take(c)}>
                  {thumbs[c.id] ? (
                    <img src={thumbs[c.id]} alt="" />
                  ) : (
                    <div className="ccard-no">{busy ? "…" : "无图"}</div>
                  )}
                  <div className="ccard-t">
                    <div className="ccard-name">{c.title || "没有书名"}</div>
                    <div className="dim">{[c.authors, c.year, c.publisher].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="ccard-go">{applying === c.id ? "正在下载" : "用这张"}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">{busy ? "正在搜…" : msg || "还没有结果"}</div>
          )}
        </div>

        <div className="cad-foot">
          <label className="cad-chk">
            <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
            顺带补全书目信息
          </label>
          <span className="dim">只填空着的，已有值不动</span>
          <span className="spacer" />
          {cached ? <span className="dim">用的是二十四小时内的缓存</span> : null}
          {msg && list.length ? <span className="dim">{msg}</span> : null}
        </div>
      </div>
    </>
  );
}
