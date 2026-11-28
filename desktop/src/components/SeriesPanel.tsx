import { useEffect, useRef, useState } from "react";
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

type NameKey = "zhName" | "name";

/** 点系列卡弹这一层：列出系列里每一本，底部两个动作 */
export default function SeriesPanel({ series, onClose, onOpenBook, onWriteReview, onFilterSeries, onChanged }: Props) {
  const [info, setInfo] = useState<SeriesInfo>(series);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [hasReview, setHasReview] = useState(false);
  /* 一次只改一个名字：标题里点哪个，哪个原位变输入框 */
  const [editing, setEditing] = useState<NameKey | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [revTick, setRevTick] = useState(0);

  const infoRef = useRef(series);
  const editRef = useRef<{ key: NameKey | null; value: string }>({ key: null, value: "" });
  const busyRef = useRef(false);
  const saveRef = useRef<Promise<boolean> | null>(null);
  /* 正在写库时点了另一个名字，等这次写完再切过去 */
  const pendingRef = useRef<NameKey | null>(null);
  const actingRef = useRef(false);

  useEffect(() => api.onReviewsChanged(() => setRevTick((t) => t + 1)), []);

  useEffect(() => {
    let alive = true;
    api.seriesBooks(series.id).then((r) => alive && setBooks(r));
    api.seriesReview(series.id).then((r) => alive && setHasReview(!!r));
    return () => {
      alive = false;
    };
  }, [series.id, revTick]);

  const openEdit = (key: NameKey) => {
    const cur = infoRef.current[key];
    editRef.current = { key, value: cur };
    setEditing(key);
    setDraft(cur);
    setErr("");
  };

  const cancelEdit = () => {
    if (busyRef.current) return;
    pendingRef.current = null;
    editRef.current = { key: null, value: "" };
    setEditing(null);
    setDraft("");
    setErr("");
  };

  /* 点标题上的某个名字。若另一处正在保存，先记下来，写完再打开；
     已有未保存的草稿（含报错）也先试着提交，成功后才切，失败保留原草稿 */
  const beginEdit = (key: NameKey) => {
    if (editRef.current.key === key) return;
    if (busyRef.current || saveRef.current) {
      pendingRef.current = key;
      return;
    }
    setNote("");
    if (editRef.current.key) {
      pendingRef.current = key;
      void commitCurrent();
      return;
    }
    openEdit(key);
  };

  /* 单字段补丁；名字没变不写，空原名交给后端原有校验拒绝 */
  const saveEdit = async (key: NameKey, raw: string): Promise<boolean> => {
    const cur = infoRef.current[key];
    const value = raw.trim();
    if (value === cur) return true;

    busyRef.current = true;
    setBusy(true);
    setErr("");
    try {
      const patch: SeriesPatch = key === "name" ? { name: value } : { zhName: value };
      const r = await api.seriesUpdate(infoRef.current.id, patch);
      if (!r.ok) {
        setErr(r.msg || "没有改成");
        return false;
      }
      if (r.series) {
        infoRef.current = r.series;
        setInfo(r.series);
      }
      setNote(r.msg || "");
      onChanged();
      return true;
    } catch {
      setErr("没有改成，请稍后再试");
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /* 提交当前输入。同一时刻只跑一次请求；失败时输入框留在原地 */
  const commitCurrent = (): Promise<boolean> => {
    if (saveRef.current) return saveRef.current;
    const { key, value } = editRef.current;
    if (!key) return Promise.resolve(true);

    const p = (async () => {
      const ok = await saveEdit(key, value);
      if (ok) {
        editRef.current = { key: null, value: "" };
        setEditing(null);
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next) openEdit(next);
      } else {
        pendingRef.current = null;
      }
      return ok;
    })();

    saveRef.current = p;
    void p.finally(() => {
      if (saveRef.current === p) saveRef.current = null;
    });
    return p;
  };

  /* 所有会离开当前视图的动作都先提交草稿：成功才执行，失败留在面板里 */
  const runAfterSave = async (action: () => void) => {
    if (actingRef.current) return;
    actingRef.current = true;
    pendingRef.current = null;
    try {
      if (await commitCurrent()) action();
    } finally {
      actingRef.current = false;
    }
  };

  /* 编辑中按 Esc 取消这次输入，不关面板；等外面那层别把面板收掉。
     注册在捕获阶段：App 的 Esc 监听在冒泡阶段 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.isComposing) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      if (editRef.current.key) cancelEdit();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const keyIn = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const input = (key: NameKey) => (
    <input
      className={"sname-in" + (key === "name" ? " sname-orig" : "")}
      autoFocus
      readOnly={busy}
      value={draft}
      placeholder={key === "zhName" ? "没有译名就空着，显示时退回原名" : "原作语言的写法"}
      aria-label={key === "zhName" ? "系列译名" : "系列原名"}
      onChange={(e) => {
        setDraft(e.target.value);
        editRef.current.value = e.target.value;
      }}
      onBlur={() => void commitCurrent()}
      onKeyDown={keyIn}
    />
  );

  return (
    <>
      <div className="mask on drawer-mask" onClick={() => void runAfterSave(onClose)} />
      <aside className="drawer on" aria-label="系列" aria-busy={busy || undefined}>
        <div className="dwrap">
          <div className="dh">
            <div className="dht">
              <h2 className="sname">
                {editing === "zhName" ? (
                  input("zhName")
                ) : (
                  <button
                    className="sname-btn sname-zh"
                    title="编辑系列译名"
                    onClick={() => beginEdit("zhName")}
                  >
                    {info.zhName || <span className="dim">添加译名</span>}
                  </button>
                )}
                {editing === "name" ? (
                  input("name")
                ) : (
                  <button
                    className="sname-btn sname-orig"
                    title="编辑系列原名"
                    onClick={() => beginEdit("name")}
                  >
                    {info.name}
                  </button>
                )}
              </h2>
              {err ? <div className="sname-err">{err}</div> : null}
            </div>
            <span className="dim">
              {info.n} 册 · 已读 {info.read}
              {info.avg != null ? " · ★ " + info.avg.toFixed(1) : ""}
            </span>
            <button className="xbtn" onClick={() => void runAfterSave(onClose)} aria-label="关闭">
              ×
            </button>
          </div>

          {note ? <div className="snote">{note}</div> : null}

          <div className="sb-list">
            {books.map((b) => (
              <div key={b.id} className="sb-i" onClick={() => void runAfterSave(() => onOpenBook(b.id))}>
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
            <button className="mini" onClick={() => void runAfterSave(() => onWriteReview(infoRef.current))} title={hasReview ? "去写这个系列的总评" : "为整个系列新建一篇总评"}>
              {hasReview ? "查看系列书评" : "写系列书评"}
            </button>
            <button className="mini" onClick={() => void runAfterSave(() => onFilterSeries(infoRef.current))} title="打开「全部」表格，临时只看这个系列">
              在表格中查看
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
