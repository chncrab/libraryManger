import { useEffect, useRef, useState } from "react";
import api, { coverUrl } from "../api";
import type { BookPatch, BookRow, CatNode } from "../../shared/types";
import { gradeIcon } from "./GridView";
import { MultiPick, SinglePick } from "./Pickers";

interface Props {
  id: string | null;
  onClose: () => void;
  onSaved: () => void;
}

interface Loaded {
  book: BookRow;
  review: { md: string; grade: string; happenedAt: string } | null;
}

const STATES = ["实体", "私印", "预定中", "购物车", "无"];
const EBOOK = ["有", "无"];
const MEDIA = ["小说", "漫画"];

/* 详情是右侧抽屉，点外侧遮罩或按 Esc 收起，和 demo 一致；字段全部可直接改，改完自动落库 */
export default function DetailPanel({ id, onClose, onSaved }: Props) {
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
  onClose,
  onSaved,
  onPatched
}: {
  data: Loaded;
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
            <Field label="书名" value={b.title} onCommit={(v) => commit({ title: v })} />
            <Field label="副标题" value={b.subtitle} onCommit={(v) => commit({ subtitle: v })} />
          </div>
        </div>

        <div className="kv edit">
          <Row label="原作名">
            <Field value={b.originalTitle} onCommit={(v) => commit({ originalTitle: v })} />
          </Row>
          <Row label="原作副标题">
            <Field value={b.originalSubtitle} onCommit={(v) => commit({ originalSubtitle: v })} />
          </Row>
          <Row label="作者">
            <Field
              value={b.authors.join("、")}
              placeholder="多位用、分隔"
              onCommit={(v) =>
                commit({
                  authors: v
                    .split(/[、,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                })
              }
            />
          </Row>
          <Row label="媒介">
            <SinglePick options={MEDIA} value={b.mediaType} title="小说或漫画" onCommit={(v) => commit({ mediaType: v })} />
          </Row>
          <Row label="系列">
            <div className="drow2">
              <Field value={b.seriesName} placeholder="不属于系列就留空" onCommit={(v) => commit({ seriesName: v })} />
              <Field
                className="num"
                value={b.seriesIndex == null ? "" : String(b.seriesIndex)}
                placeholder="册"
                onCommit={(v) => commit({ seriesIndex: v.trim() ? Number(v) : null })}
              />
            </div>
          </Row>
          <Row label="国籍">
            <Field value={b.country} onCommit={(v) => commit({ country: v })} />
          </Row>
          <Row label="出版日期">
            <input type="date" value={toDate(b.publishDate)} onChange={(e) => commit({ publishDate: e.target.value })} />
          </Row>
          <Row label="已读">
            <div className="drow2">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={b.isRead}
                  onChange={(e) => {
                    const on = e.target.checked;
                    commit({ isRead: on, readDate: on && !b.readDate ? today() : b.readDate });
                  }}
                />
                <span>读过</span>
              </label>
              <input type="date" value={toDate(b.readDate)} onChange={(e) => commit({ readDate: e.target.value })} />
            </div>
          </Row>
          <Row label="评分">
            <div className="drow2">
              <input
                className="num"
                type="number"
                step="0.1"
                min="0"
                max="10"
                defaultValue={b.rating == null ? "" : b.rating}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== (b.rating == null ? null : b.rating)) commit({ rating: v });
                }}
              />
              <span className="dim">0 到 10，空着算未评分</span>
            </div>
          </Row>
          <Row label="分类">
            <MultiPick
              all={cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))}
              picked={b.categories}
              onCommit={(names) => commit({ categories: names })}
            />
          </Row>
          <Row label="实体书">
            <MultiPick
              all={STATES.map((s) => ({ id: s, name: s, parentId: null }))}
              picked={b.states}
              onCommit={(names) => commit({ states: names })}
            />
          </Row>
          <Row label="电子书">
            <SinglePick
              options={EBOOK}
              value={b.ebookState === "有" ? "有" : "无"}
              title="有电子版还是没有"
              onCommit={(v) => commit({ ebookState: v })}
            />
          </Row>
          <Row label="备注">
            <textarea rows={3} defaultValue={b.note} onBlur={(e) => commit({ note: e.target.value })} />
          </Row>
        </div>

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

function Field({
  label,
  value,
  placeholder,
  className,
  onCommit
}: {
  label?: string;
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (v: string) => void;
}) {
  return (
    <>
      {label ? <label className="dlab">{label}</label> : null}
      <input
        className={className}
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </>
  );
}

/* <input type=date> 只吃 yyyy-mm-dd，源数据里有 2020-05 这种，截前 10 位再补零 */
function toDate(v: string): string {
  const m = String(v || "").match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (!m) return "";
  return m[1] + "-" + m[2].padStart(2, "0") + "-" + (m[3] || "01").padStart(2, "0");
}

function today(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
