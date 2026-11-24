import type { ReviewFrontmatterField } from "../../shared/types";
import ReviewCoverLink from "./ReviewCoverLink";

interface Props {
  fields: ReviewFrontmatterField[];
  onChange?: (fields: ReviewFrontmatterField[]) => void;
  disabled?: boolean;
  bookId: string | null;
  seriesId: number | null;
  onOpenBook: (id: string) => void;
}

const TEMPLATES = ["作者", "书籍", "系列", "阅读时间", "评分", "分类", "书评等级", "tags"];
const REVIEW_GRADES = { god: "神作", normal: "普通", bad: "扫雷" };

const isMulti = (f: ReviewFrontmatterField) =>
  f.key.toLowerCase() === "tags" || f.value.includes("\n");

export function frontmatterChanges(base: ReviewFrontmatterField[], draft: ReviewFrontmatterField[]) {
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

export default function ReviewFrontmatter({ fields, onChange, disabled, bookId, seriesId, onOpenBook }: Props) {
  const updateValue = (index: number, value: string) =>
    onChange?.(fields.map((field, i) => i === index ? { ...field, value } : field));

  if (!onChange && !fields.length) return null;
  return (
    <div className={"rvm-fm" + (onChange ? " editing" : "")}>
      {onChange ? (
        <div className="rvm-fm-edit">
          {fields.map((f, i) => (
            <div className={"rvm-fm-row" + (isMulti(f) ? " rvm-fm-wide" : "")} key={i}>
              <label className="rvm-fm-v">
                <span className="rvm-fm-k">{f.key}</span>
                {f.key === "书评等级" ? (
                  <select value={f.value} disabled={disabled} onChange={(e) => updateValue(i, e.target.value)}>
                    <option value="">未设置</option>
                    {f.value && !Object.hasOwn(REVIEW_GRADES, f.value) ? <option value={f.value}>{f.value}</option> : null}
                    {Object.entries(REVIEW_GRADES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                ) : isMulti(f) ? (
                  <textarea
                    rows={3}
                    value={f.value}
                    disabled={disabled}
                    onChange={(e) => updateValue(i, e.target.value)}
                  />
                ) : (
                  <input
                    value={f.value}
                    disabled={disabled}
                    onChange={(e) => updateValue(i, e.target.value)}
                  />
                )}
              </label>
              <button
                className="mini rvm-fm-del"
                aria-label={"删除 " + f.key}
                disabled={disabled}
                onClick={() => onChange(fields.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
          ))}
          <div className="rvm-fm-add">
            <span>添加</span>
            {TEMPLATES.filter((k) => !fields.some((f) => f.key === k)).map((k) => (
              <button key={k} className="mini" disabled={disabled} onClick={() => onChange([...fields, { key: k, value: "" }])}>
                {k}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="rvm-fm-list">
          {fields.map((f, i) => {
            const linkedBook = f.key === "书籍" ? bookId : null;
            const linkedSeries = f.key === "系列" ? seriesId : null;
            return (
              <div className={"rvm-fm-item" + (f.value.includes("\n") ? " rvm-fm-wide" : "")} key={f.key + i}>
                <span className="rvm-fm-k">{f.key}</span>
                <span className="rvm-fm-v">
                  {f.value && (linkedBook != null || linkedSeries != null) ? (
                    <ReviewCoverLink
                      key={linkedBook ?? linkedSeries}
                      title={f.value}
                      bookId={linkedBook}
                      seriesId={linkedSeries}
                      onOpenBook={onOpenBook}
                    />
                  ) : f.value}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
