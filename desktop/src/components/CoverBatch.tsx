import { useEffect, useState } from "react";
import api from "../api";
import type { CoverBatchState, CoverQueueItem } from "../../shared/types";

interface Props {
  onClose: () => void;
  /** 批量落了封面，书架和表格要重取 */
  onChanged: () => void;
}

const EMPTY: CoverBatchState = {
  running: false,
  total: 0,
  done: 0,
  applied: 0,
  queued: 0,
  failed: 0,
  current: "",
  stopReason: ""
};

/**
 * 批量找封面。只跑没有封面的书，串行，每本之间停一会儿。
 * 打分到阈值的直接落盘，不到的进左边那张队列表，等你逐条接受或跳过，
 * 不按相似度硬配。撞上豆瓣限速就整批停下，剩下的一本不动。
 */
export default function CoverBatch({ onClose, onChanged }: Props) {
  const [st, setSt] = useState<CoverBatchState>(EMPTY);
  const [queue, setQueue] = useState<CoverQueueItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const pullQueue = async () => {
    const list = await api.coverQueue();
    setQueue(list || []);
    return list || [];
  };

  useEffect(() => {
    void api.coverBatchState().then((s) => s && setSt(s));
    void pullQueue();
    /* 主进程每走一本推一次，关了面板就退订 */
    return api.onCoverProgress((s) => {
      setSt(s);
      if (!s.running) void pullQueue();
    });
  }, []);

  /* 队列里的缩略图一样要经主进程取，豆瓣图片站不给直连 */
  useEffect(() => {
    let alive = true;
    for (const it of queue) {
      const url = it.candidate?.pic || "";
      if (!url || thumbs[it.bookId]) continue;
      void api.coverThumb(url).then((d) => {
        if (alive && d) setThumbs((m) => ({ ...m, [it.bookId]: d }));
      });
    }
    return () => {
      alive = false;
    };
  }, [queue]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const start = async () => {
    setMsg("");
    const s = await api.startCoverBatch(backfill);
    if (s) setSt(s);
    if (s && s.total === 0) setMsg(s.stopReason || "没有缺封面的书");
  };

  const stop = async () => {
    const s = await api.stopCoverBatch();
    if (s) setSt(s);
  };

  const accept = async (it: CoverQueueItem) => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.acceptQueuedCover(it.bookId, backfill);
      if (!r.ok) {
        setMsg(r.msg || "没换成");
        return;
      }
      await pullQueue();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const skip = async (it: CoverQueueItem) => {
    await api.skipQueuedCover(it.bookId);
    await pullQueue();
  };

  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <div className="cbatch">
        <div className="cad-h">
          <h3>批量找封面</h3>
          <span className="dim">只跑没有封面的书</span>
          <span className="spacer" />
          <button className="xbtn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="cb-top">
          <button className="mini" disabled={st.running} onClick={() => void start()}>
            {st.running ? "正在跑" : "开始识别"}
          </button>
          <button className="mini" disabled={!st.running} onClick={() => void stop()}>
            停止
          </button>
          <label className="cad-chk">
            <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
            顺带补全书目信息
          </label>
          <span className="spacer" />
          <span className="dim">
            {st.total
              ? `${st.done} / ${st.total}，配上 ${st.applied}，进队列 ${st.queued}，出错 ${st.failed}`
              : queue.length
                ? `队列里留着上次的 ${queue.length} 条`
                : "还没跑过"}
          </span>
        </div>

        {st.total ? (
          <div className="cb-bar">
            <div className="cb-bar-in" style={{ width: pct + "%" }} />
          </div>
        ) : null}
        <div className="cb-now">
          {st.running ? "正在处理 " + (st.current || "…") : st.stopReason || (msg || "")}
        </div>

        <div className="cb-list">
          <div className="cb-lh">
            待确认 <span className="dim">{queue.length} 条</span>
          </div>
          {queue.map((it) => (
            <div key={it.bookId} className="cb-i">
              <div className="cb-cov">{thumbs[it.bookId] ? <img src={thumbs[it.bookId]} alt="" /> : <span className="dim">无图</span>}</div>
              <div className="cb-t">
                <div className="cb-name">{it.title}</div>
                <div className="dim">
                  {it.authors || "没有作者"}
                  {it.candidate ? " → " + it.candidate.title : " → 没搜到匹配的"}
                  {it.score ? " · " + it.score + " 分" : ""}
                </div>
              </div>
              <div className="cb-acts">
                <button className="mini xs" disabled={!it.candidate || busy} onClick={() => void accept(it)}>
                  用这张
                </button>
                <button className="mini xs" onClick={() => void skip(it)}>
                  跳过
                </button>
              </div>
            </div>
          ))}
          {queue.length === 0 ? <div className="empty">队列是空的。跑到低于阈值或者搜不到的书会进这里</div> : null}
        </div>

        <div className="cad-foot">
          <span className="dim">每本之间停一点五秒，撞上豆瓣限速会整批停下，剩下的留到下次</span>
        </div>
      </div>
    </>
  );
}
