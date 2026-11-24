import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_VIEW_FILTER, VIEW_PRESETS, newViewId } from "../../shared/types";
import type { CatNode, LibraryView, ReadFilter, ViewLayout, ViewUnit } from "../../shared/types";

interface Props {
  /** 传 null 是新建，否则是在改这一条 */
  initial: LibraryView | null;
  cats: CatNode[];
  onCancel: () => void;
  /** 返回 null 表示保存成功，返回一句话就是失败原因 */
  onSave: (v: LibraryView) => Promise<string | null>;
}

const READS: { value: ReadFilter; label: string }[] = [
  { value: "all", label: "不限阅读状态" },
  { value: "read", label: "已读" },
  { value: "unread", label: "未读" },
  { value: "rated", label: "有评分" }
];

const cloneView = (v: LibraryView): LibraryView => ({
  ...v,
  filter: {
    media: v.filter.media,
    keywords: [...v.filter.keywords],
    categories: [...v.filter.categories],
    read: v.filter.read
  }
});

/** 预设只是填表模板，真正的四条预设由后端初始化，不在这里落配置 */
const PRESET_TEMPLATES: { key: string; label: string; view: Omit<LibraryView, "id" | "ord"> }[] = [
  {
    key: "blank",
    label: "空白",
    view: { name: "", unit: "book", layout: "shelf", filter: { ...EMPTY_VIEW_FILTER } }
  },
  ...VIEW_PRESETS.map((p) => ({ key: p.id, label: p.name, view: { name: p.name, unit: p.unit, layout: p.layout, filter: { ...p.filter } } }))
];

const parseKeywords = (s: string): string[] => {
  const out: string[] = [];
  for (const w of s.split(/\s+/)) {
    const t = w.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};

export default function ViewEditor({ initial, cats, onCancel, onSave }: Props) {
  const [draft, setDraft] = useState<LibraryView>(() =>
    initial
      ? cloneView(initial)
      : { id: newViewId(), name: "", unit: "book", layout: "shelf", filter: { ...EMPTY_VIEW_FILTER }, ord: 0 }
  );
  const [kw, setKw] = useState(() => (initial ? initial.filter.keywords.join(" ") : ""));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busy) onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  const presets = PRESET_TEMPLATES;
  const presetOn = (t: (typeof PRESET_TEMPLATES)[number]) =>
    draft.name === t.view.name && draft.unit === t.view.unit && draft.layout === t.view.layout && draft.filter.media === t.view.filter.media;

  const applyPreset = (t: (typeof PRESET_TEMPLATES)[number]) => {
    setErr("");
    setKw(t.view.filter.keywords.join(" "));
    setDraft((d) => ({
      ...d,
      name: t.view.name,
      unit: t.view.unit,
      layout: t.view.layout,
      filter: {
        media: t.view.filter.media,
        keywords: [...t.view.filter.keywords],
        categories: [...t.view.filter.categories],
        read: t.view.filter.read
      }
    }));
  };

  const setFilter = (p: Partial<LibraryView["filter"]>) => setDraft((d) => ({ ...d, filter: { ...d.filter, ...p } }));

  const toggleCat = (name: string) => {
    const has = draft.filter.categories.includes(name);
    setFilter({ categories: has ? draft.filter.categories.filter((x) => x !== name) : [...draft.filter.categories, name] });
  };

  const catRows = useMemo(() => {
    const roots = cats.filter((c) => c.parentId == null);
    const out: { c: CatNode; depth: number }[] = [];
    for (const r of roots) {
      out.push({ c: r, depth: 0 });
      for (const k of cats.filter((c) => c.parentId === r.id)) out.push({ c: k, depth: 1 });
    }
    for (const c of cats) if (!out.some((x) => x.c.id === c.id)) out.push({ c, depth: c.parentId ? 1 : 0 });
    return out;
  }, [cats]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = draft.name.trim();
    if (!name) {
      setErr("名称不能为空");
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr("");
    const next: LibraryView = {
      ...draft,
      name,
      filter: {
        ...draft.filter,
        keywords: parseKeywords(kw),
        categories: draft.filter.categories.filter((x, i, a) => x && a.indexOf(x) === i)
      }
    };
    const msg = await onSave(next);
    if (msg) {
      setErr(msg);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mask on" onClick={busy ? undefined : onCancel} />
      <div className="cadmin vp" role="dialog" aria-modal="true" aria-label={initial ? "编辑视图" : "新建视图"}>
        <div className="cad-h">
          <h3>{initial ? "编辑视图" : "新建视图"}</h3>
          <span className="spacer" />
          <button className="xbtn" aria-label="关闭" onClick={onCancel} disabled={busy}>
            ×
          </button>
        </div>

        <form className="vp-form" onSubmit={submit}>
          <div className="vp-b">
            <div className="vp-row">
              <span className="vp-l">预设</span>
              <div className="vp-c">
                {presets.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={"mini xs" + (presetOn(t) ? " on" : "")}
                    onClick={() => applyPreset(t)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">名称</span>
              <div className="vp-c">
                <input
                  ref={nameRef}
                  className="vp-in"
                  value={draft.name}
                  placeholder="例如：已读漫画"
                  onChange={(e) => {
                    setErr("");
                    setDraft({ ...draft, name: e.target.value });
                  }}
                />
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">对象</span>
              <div className="vp-c">
                <div className="seg vp-seg">
                  {(
                    [
                      ["book", "单册"],
                      ["series", "系列"]
                    ] as [ViewUnit, string][]
                  ).map(([k, label]) => (
                    <button key={k} type="button" className={draft.unit === k ? "on" : ""} onClick={() => setDraft({ ...draft, unit: k })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">布局</span>
              <div className="vp-c">
                <div className="seg vp-seg">
                  {(
                    [
                      ["shelf", "书架"],
                      ["table", "表格"]
                    ] as [ViewLayout, string][]
                  ).map(([k, label]) => (
                    <button key={k} type="button" className={draft.layout === k ? "on" : ""} onClick={() => setDraft({ ...draft, layout: k })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">{draft.unit === "series" ? "系列媒介" : "媒介"}</span>
              <div className="vp-c">
                <select className="vp-in" value={draft.filter.media} onChange={(e) => setFilter({ media: e.target.value })}>
                  <option value="">全媒介</option>
                  <option value="小说">小说</option>
                  <option value="漫画">漫画</option>
                </select>
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">预设关键词</span>
              <div className="vp-c">
                <input
                  className="vp-in"
                  value={kw}
                  placeholder="空格分开，每个词都要命中"
                  onChange={(e) => setKw(e.target.value)}
                />
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">分类</span>
              <div className="vp-c vp-cats">
                {catRows.length ? (
                  catRows.map(({ c, depth }) => (
                    <button
                      key={c.id}
                      type="button"
                      className={"vp-cat" + (depth ? " sub" : "") + (draft.filter.categories.includes(c.name) ? " on" : "")}
                      onClick={() => toggleCat(c.name)}
                    >
                      {c.name}
                    </button>
                  ))
                ) : (
                  <span className="vp-hint">还没有分类</span>
                )}
              </div>
            </div>

            <div className="vp-row">
              <span className="vp-l">阅读状态</span>
              <div className="vp-c">
                <select className="vp-in" value={draft.filter.read} onChange={(e) => setFilter({ read: e.target.value as ReadFilter })}>
                  {READS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="vp-note">
              名称必填。这里存的是视图的预筛选；进视图后顶栏搜索和左栏筛选都是临时条件，清掉就回到这份预筛选。
            </p>
            {err ? <p className="vp-err">{err}</p> : null}
          </div>

          <div className="cad-foot vp-foot">
            <button className="mini" type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </button>
            <button className="mini" type="button" onClick={onCancel} disabled={busy}>
              取消
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
