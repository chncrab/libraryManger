import { useEffect, useRef, useState } from "react";
import api from "../api";
import type { ReviewFrontmatterField, RvResult } from "../../shared/types";

export interface FrontmatterBaseline {
  key: string;
  frontmatter: ReviewFrontmatterField[];
  expectedFileName: string;
  expectedVersion: string;
}

interface Props {
  kind: string;
  id: number;
  frontmatter: ReviewFrontmatterField[];
  baseline: FrontmatterBaseline | null;
  disabled?: boolean;
  busy?: boolean;
  onRequestEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (r: RvResult) => void;
}

const TEMPLATES = ["作者", "书籍", "系列", "阅读时间", "评分", "分类", "书评等级", "tags"];
const REVIEW_GRADES = { god: "神作", normal: "普通", bad: "扫雷" };

const isMulti = (f: ReviewFrontmatterField) =>
  f.key.toLowerCase() === "tags" || f.value.includes("\n");

function changesOf(base: ReviewFrontmatterField[], draft: ReviewFrontmatterField[]) {
  const out: ReviewFrontmatterField[] = [];
  const baseMap = new Map(base.map((f) => [f.key, f.value]));
  const draftKeys = new Set(draft.map((f) => f.key));
  for (const f of base) {
    if (!draftKeys.has(f.key)) out.push({ key: f.key, value: "" });
  }
  for (const f of draft) {
    if (!f.key) continue;
    if (!baseMap.has(f.key)) {
      if (f.value !== "") out.push({ key: f.key, value: f.value });
    } else if (baseMap.get(f.key) !== f.value) {
      out.push({ key: f.key, value: f.value });
    }
  }
  return out;
}

export default function ReviewFrontmatter({
  kind,
  id,
  frontmatter,
  baseline,
  disabled,
  busy,
  onRequestEdit,
  onCancelEdit,
  onSaved
}: Props) {
  const [draft, setDraft] = useState<ReviewFrontmatterField[]>([]);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  const baselineRef = useRef<FrontmatterBaseline | null>(null);
  baselineRef.current = baseline;

  useEffect(() => {
    if (baseline) setDraft(baseline.frontmatter.map((f) => ({ ...f })));
    setErr("");
    setSaving(false);
  }, [baseline]);

  const add = (key: string) =>
    setDraft((d) => (d.some((f) => f.key === key) ? d : [...d, { key, value: "" }]));

  const updateValue = (index: number, value: string) =>
    setDraft((fields) => fields.map((field, i) => (i === index ? { ...field, value } : field)));

  const save = async () => {
    const b = baselineRef.current;
    if (!b) return;
    const changes = changesOf(b.frontmatter, draft);
    if (!changes.length) {
      onCancelEdit();
      return;
    }
    const my = ++seq.current;
    setSaving(true);
    setErr("");
    try {
      const r = await api.updateReview(kind, id, {
        frontmatter: changes,
        expectedFileName: b.expectedFileName,
        expectedVersion: b.expectedVersion
      });
      if (seq.current !== my || baselineRef.current?.key !== b.key) return;
      if (!r.ok) {
        setErr(r.msg || "保存标签失败");
        setSaving(false);
        return;
      }
      onSaved(r);
    } catch (e) {
      if (seq.current !== my || baselineRef.current?.key !== b.key) return;
      setErr(e instanceof Error ? e.message : "保存标签失败");
      setSaving(false);
    }
  };

  const cancel = () => {
    seq.current++;
    onCancelEdit();
  };

  const editing = !!baseline;

  return (
    <div className={"rvm-fm" + (editing ? " editing" : "")}>
      <div className="rvm-fm-h">
        <span className="rvm-fm-t">标签</span>
        {editing ? (
          <>
            <button className="mini" onClick={() => void save()} disabled={saving}>
              保存标签
            </button>
            <button className="mini" onClick={cancel} disabled={saving}>
              取消
            </button>
          </>
        ) : (
          <button className="mini" onClick={onRequestEdit} disabled={disabled || busy}>
            编辑标签
          </button>
        )}
        {busy && !editing ? <span className="rvm-fm-note">读取中…</span> : null}
      </div>

      {err && editing ? <div className="rvm-fm-err" role="alert">{err}</div> : null}

      {editing ? (
        <div className="rvm-fm-edit">
          {draft.map((f, i) => (
            <div className={"rvm-fm-row" + (isMulti(f) ? " rvm-fm-wide" : "")} key={i}>
              <label className="rvm-fm-v">
                <span className="rvm-fm-k">{f.key}</span>
                {f.key === "书评等级" ? (
                  <select value={f.value} disabled={saving} onChange={(e) => updateValue(i, e.target.value)}>
                    <option value="">未设置</option>
                    {f.value && !Object.hasOwn(REVIEW_GRADES, f.value) ? <option value={f.value}>{f.value}</option> : null}
                    {Object.entries(REVIEW_GRADES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                ) : isMulti(f) ? (
                  <textarea
                    rows={3}
                    value={f.value}
                    disabled={saving}
                    onChange={(e) => updateValue(i, e.target.value)}
                  />
                ) : (
                  <input
                    value={f.value}
                    disabled={saving}
                    onChange={(e) => updateValue(i, e.target.value)}
                  />
                )}
              </label>
              <button
                className="mini rvm-fm-del"
                aria-label={"删除 " + f.key}
                disabled={saving}
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
          ))}
          <div className="rvm-fm-add">
            <span>添加</span>
            {TEMPLATES.filter((k) => !draft.some((f) => f.key === k)).map((k) => (
              <button key={k} className="mini" disabled={saving} onClick={() => add(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="rvm-fm-list">
          {frontmatter.length ? (
            frontmatter.map((f, i) => (
              <div className={"rvm-fm-item" + (f.value.includes("\n") ? " rvm-fm-wide" : "")} key={f.key + i}>
                <span className="rvm-fm-k">{f.key}</span>
                <span className="rvm-fm-v">{f.value}</span>
              </div>
            ))
          ) : (
            <span className="rvm-fm-none">无</span>
          )}
        </div>
      )}
    </div>
  );
}
