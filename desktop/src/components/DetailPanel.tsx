import { Fragment, useEffect, useRef, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookPatch, BookRow, CatNode, FieldDef } from "../../shared/types";
import { gradeIcon } from "./GridView";
import { FieldEditor, patchOf, valuesOf } from "./FieldRenderer";
import CoverSearch from "./CoverSearch";
import CoverViewer from "./CoverViewer";
import Confirm from "./Confirm";

interface Props {
  id: string | null;
  /** 字段定义，详情里的每一行都由它生成 */
  fields: FieldDef[];
  onClose: () => void;
  onSaved: () => void;
}

interface Loaded {
  book: BookRow;
  review: { md: string; grade: string; happenedAt: string } | null;
}

/* 详情是右侧抽屉，点外侧遮罩或按 Esc 收起，和 demo 一致；字段全部可直接改，改完自动落库 */
export default function DetailPanel({ id, fields, onClose, onSaved }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  /* 大图开着的时候，Esc 先收大图，别把整个抽屉一起收掉 */
  const [coverOpen, setCoverOpen] = useState(false);
  const [revTick, setRevTick] = useState(0);

  useEffect(() => {
    setCoverOpen(false);
  }, [id]);

  useEffect(() => api.onReviewsChanged(() => setRevTick((t) => t + 1)), []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.getBook(id).then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [id, revTick]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      /* 正在输入框里按 Esc 是取消输入，不该把抽屉关掉 */
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape" && !coverOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose, coverOpen]);

  const open = !!id && !!data;

  return (
    <>
      <div className={"mask" + (open ? " on" : "")} onClick={onClose} />
      <aside className={"drawer" + (open ? " on" : "")} aria-hidden={!open}>
        {data ? (
          <Body
            key={data.book.id}
            data={data}
            fields={fields}
            coverOpen={coverOpen}
            setCoverOpen={setCoverOpen}
            onClose={onClose}
            onSaved={onSaved}
            onPatched={(nb) => setData((d) => (d ? { ...d, book: nb } : d))}
          />
        ) : null}
      </aside>
    </>
  );
}

function Body({
  data,
  fields,
  coverOpen,
  setCoverOpen,
  onClose,
  onSaved,
  onPatched
}: {
  data: Loaded;
  fields: FieldDef[];
  coverOpen: boolean;
  setCoverOpen: (v: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
  onPatched: (b: BookRow) => void;
}) {
  const b = data.book;
  const [cats, setCats] = useState<CatNode[]>([]);
  const [msg, setMsg] = useState("");
  const [finding, setFinding] = useState(false);
  const [askCover, setAskCover] = useState(false);
  const msgTimer = useRef<number>(0);

  useEffect(() => {
    api.categoryTree().then(setCats);
  }, []);

  const flash = (t: string) => {
    setMsg(t);
    window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(""), 1800);
  };

  const commit = async (p: BookPatch) => {
    const nb = await api.updateBook(b.id, p);
    if (!nb) {
      flash("保存失败");
      return;
    }
    onPatched(nb);
    onSaved();
    flash("已保存");
  };

  /* 某个字段改了就提交，内建走原有补丁键，自定义走 custom */
  const put = (f: FieldDef, vals: string[]) => {
    const p = patchOf(f, vals);
    if (f.patchKey === "isRead" && vals.length && !b.readDate) {
      commit({ ...p, readDate: today() });
      return;
    }
    commit(p);
  };

  const changeCover = async () => {
    const r = await api.pickCover(b.id);
    if (!r.ok) {
      flash(r.msg || "没有更换");
      return;
    }
    const d = await api.getBook(b.id);
    if (d) onPatched(d.book);
    onSaved();
    flash("封面已更换");
  };

  /* 删封面会把图片一起删掉，跟删书一样先问一句 */
  const clearCover = async () => {
    setAskCover(false);
    const r = await api.resetCover(b.id);
    if (!r.ok) {
      flash(r.msg || "没有可移除的封面");
      return;
    }
    const d = await api.getBook(b.id);
    if (d) onPatched(d.book);
    onSaved();
    flash("封面已移除");
  };

  const usable = fields.filter((f) => !f.deletedAt && f.builtin !== 3);
  const head = usable.filter((f) => f.key === "title" || f.key === "subtitle");
  const rest = usable.filter((f) => f.key !== "title" && f.key !== "subtitle");

  const editor = (f: FieldDef) => (
    <FieldEditor
      key={f.key}
      field={f}
      values={valuesOf(f, b)}
      bookId={b.id}
      pickAll={f.patchKey === "categories" ? cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })) : undefined}
      onCommit={(v) => put(f, v)}
    />
  );

  /* 系列与卷在原界面里是一行放两个控件，字段驱动之后照旧并排。
     阅读开始与结束各自成行，两条日期分开看更清楚，不必挤在一行 */
  const PAIRS: Record<string, string[]> = { series: ["index"] };
  const merged = new Set(Object.values(PAIRS).flat());
  const row = (f: FieldDef) => {
    const mates = (PAIRS[f.key] || []).map((k) => rest.find((x) => x.key === k)).filter(Boolean) as FieldDef[];
    /* 系列有两个名字。格子里那个是这本书挂靠的名字，原名是系列自己的身份，
       改原名动的是整个系列，所以单独成一行，走系列改名那条路 */
    if (f.key === "series") {
      return (
        <Fragment key={f.key}>
          <Row label={f.label}>
            <div className="drow2">
              {editor(f)}
              {mates.map((m) => editor(m))}
            </div>
          </Row>
          {b.seriesId ? (
            <Row label="系列原名">
              <SeriesNameField book={b} onPatched={onPatched} onSaved={onSaved} flash={flash} />
            </Row>
          ) : null}
        </Fragment>
      );
    }
    if (mates.length) {
      return (
        <Row key={f.key} label={f.label}>
          <div className="drow2">
            {editor(f)}
            {mates.map((m) => editor(m))}
          </div>
        </Row>
      );
    }
    /* 评分旁边那句范围提示是原界面就有的，字段驱动之后跟着字段走 */
    if (f.patchKey === "rating") {
      return (
        <Row key={f.key} label={f.label}>
          <div className="drow2">
            {editor(f)}
            <span className="dim">0 到 10，空着算未评分</span>
          </div>
        </Row>
      );
    }
    return (
      <Row key={f.key} label={f.label}>
        {editor(f)}
      </Row>
    );
  };

  return (
    <div className="dwrap">
      <div className="dh">
        <h2>
          {gradeIcon(b.reviewGrade)} {b.title}
        </h2>
        <span className="dstat">{msg}</span>
        <button className="xbtn" onClick={onClose} title="关闭（Esc）" aria-label="关闭">
          ×
        </button>
      </div>
      <div className="db">
        <div className="dtop">
          <div className="dcwrap">
            {b.cover ? (
              <img
                className="dc click"
                src={coverUrl(b.cover, b.coverV)}
                alt=""
                title="点击看大图"
                onClick={() => setCoverOpen(true)}
              />
            ) : (
              <div className="dc empty">无封面</div>
            )}
            <div className="dcacts">
              <button className="mini xs" onClick={changeCover} title="选一张本地图片作为封面，旧图会被替换掉">
                换封面
              </button>
              <button className="mini xs" onClick={() => setFinding(true)} title="按书名或 ISBN 去豆瓣找，选一张落盘">
                搜封面
              </button>
              <button className="mini xs" onClick={() => setAskCover(true)} title="删掉这张封面图">
                移除
              </button>
            </div>
          </div>
          <div className="dfields">
            {head.map((f) => (
              <div key={f.key} className="dhead-field">
                <label className="dlab">{f.label}</label>
                <FieldEditor field={f} values={valuesOf(f, b)} bookId={b.id} onCommit={(v) => put(f, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="kv edit">{rest.filter((f) => !merged.has(f.key)).map(row)}</div>

        {data.review && data.review.md ? (
          <>
            <h4 className="dsec">书评</h4>
            <div className="review">{data.review.md}</div>
          </>
        ) : null}
      </div>

      {finding ? (
        <CoverSearch
          bookId={b.id}
          bookTitle={b.title}
          bookAuthors={b.authors || []}
          onClose={() => setFinding(false)}
          onApplied={(r) => {
            setFinding(false);
            void api.getBook(b.id).then((d) => {
              if (d) onPatched(d.book);
            });
            onSaved();
            const extra = r.filled && r.filled.length ? "，补了" + r.filled.join("、") : "";
            flash("封面已换上" + extra);
          }}
        />
      ) : null}

      {askCover ? (
        <Confirm
          text="移除这张封面？封面图片会一起删掉。"
          okText="移除"
          onOk={clearCover}
          onCancel={() => setAskCover(false)}
        />
      ) : null}

      {b.cover && coverOpen ? (
        <CoverViewer src={coverUrl(b.cover, b.coverV)} title={b.title} onClose={() => setCoverOpen(false)} />
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <span className="ctl">{children}</span>
    </div>
  );
}

/**
 * 系列原名。改的是整个系列的身份，同系列的书一起变，系列总评的文件名也跟着改，
 * 所以走 series:update，不走书籍补丁；改完重取这本书，让系列名与原名一起刷新。
 */
function SeriesNameField({
  book,
  onPatched,
  onSaved,
  flash
}: {
  book: BookRow;
  onPatched: (b: BookRow) => void;
  onSaved: () => void;
  flash: (t: string) => void;
}) {
  const cur = book.seriesOriginal || "";
  const [draft, setDraft] = useState(cur);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  /* 换书、或者改完重取回来，输入框跟着库里的值走 */
  useEffect(() => {
    setDraft(cur);
    setErr("");
  }, [cur, book.id]);

  const save = async () => {
    const v = draft.trim();
    if (busy || v === cur) return;
    if (!v) {
      setDraft(cur);
      setErr("系列原名不能空着，它是这个系列的身份");
      return;
    }
    const sid = book.seriesId;
    if (!sid) return;
    setBusy(true);
    try {
      const r = await api.seriesUpdate(sid, { name: v });
      if (!r.ok) {
        setErr(r.msg || "没有改成");
        return;
      }
      const d = await api.getBook(book.id);
      if (d) onPatched(d.book);
      onSaved();
      setErr("");
      flash(r.msg || "系列原名已改");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dcol">
      <input
        value={draft}
        placeholder="原作语言的写法"
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(cur);
            setErr("");
          }
        }}
      />
      {err ? <div className="dcol-err">{err}</div> : <div className="dcol-hint">改的是整个系列的名字，同系列的书一起变</div>}
    </div>
  );
}

function today(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
