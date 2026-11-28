import { useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import api from "../api";

export function categoryTagStyle(color?: string): CSSProperties | undefined {
  if (!color || !/^#[\da-f]{6}$/i.test(color)) return;
  const rgb = Number.parseInt(color.slice(1), 16);
  const luminance = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
  return { backgroundColor: color, color: luminance >= 145 ? "#181818" : "#fff" };
}

interface Props {
  tag: { id: number; name: string; color?: string };
  mode: "color" | "name";
  onClose: () => void;
  onSaved: () => void;
}

export default function CategoryTagDialog({ tag, mode, onClose, onSaved }: Props) {
  const [value, setValue] = useState(mode === "name" ? tag.name : tag.color || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = mode === "name" ? "重命名标签" : "修改标签背景色";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = mode === "name"
        ? await api.renameCategory(tag.id, value)
        : await api.setCategoryColor(tag.id, value);
      if (!result.ok) { setError(result.msg || "保存失败"); return; }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <div className="mask on cat-tag-mask" onClick={() => { if (!busy) onClose(); }} />
      <div className="cadmin vp" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (!busy) onClose();
      }}>
        <div className="cad-h"><h3>{title}</h3></div>
        <form className="vp-form" onSubmit={submit}>
          <div className="vp-b">
            <label className="vp-row">
              <span className="vp-l">{mode === "name" ? "标签名称" : tag.name}</span>
              {mode === "name" ? (
                <input className="vp-in" value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} required />
              ) : (
                <input type="color" aria-label="标签背景色" value={value || "#856142"} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} />
              )}
            </label>
            {mode === "color" ? <button type="button" className="mini" disabled={busy || !value} onClick={() => setValue("")}>恢复默认颜色</button> : null}
            {error ? <div className="vp-err" role="alert">{error}</div> : null}
          </div>
          <div className="cad-foot vp-foot">
            <button type="button" className="mini" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="mini" disabled={busy}>保存</button>
          </div>
        </form>
      </div>
    </>,
    document.body
  );
}
