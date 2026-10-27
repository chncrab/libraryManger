import { useEffect, useRef, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookPatch, BookRow, CatNode, FieldDef } from "../../shared/types";
import { gradeIcon } from "./GridView";
import { FieldEditor, patchOf, valuesOf } from "./FieldRenderer";

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

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api.getBook(id).then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      /* 正在输入框里按 Esc 是取消输入，不该把抽屉关掉 */
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, onClose]);

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
  onClose,
  onSaved,
  onPatched
}: {
  data: Loaded;
  fields: FieldDef[];
  onClose: () => void;
  onSaved: () => void;
  onPatched: (b: BookRow) => void;
}) {
  const b = data.book;
  const [cats, setCats] = useState<CatNode[]>([]);
  const [msg, setMsg] = useState("");
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

  const undoCover = async () => {
    const r = await api.resetCover(b.id);
    if (!r.ok) {
      flash(r.msg || "没有可撤销的封面");
      return;
    }
    const d = await api.getBook(b.id);
    if (d) onPatched(d.book);
    onSaved();
    flash("已撤销自定义封面");
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

  /* 系列与卷、已读与阅读日期在原界面里各占一行放两个控件，字段驱动之后照旧并排 */
  const PAIRS: Record<string, string[]> = { series: ["index"], read: ["readDate"] };
  const merged = new Set(Object.values(PAIRS).flat());
  const row = (f: FieldDef) => {
    const mates = (PAIRS[f.key] || []).map((k) => rest.find((x) => x.key === k)).filter(Boolean) as FieldDef[];
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
            {b.cover ? <img className="dc" src={coverUrl(b.cover)} alt="" /> : <div className="dc empty">无封面</div>}
            <div className="dcacts">
              <button className="mini xs" onClick={changeCover} title="选一张本地图片作为封面，原图会记下来">
                换封面
              </button>
              <button className="mini xs" onClick={undoCover} title="退回换之前那张">
                撤销
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

function today(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
