import { useEffect, useState, type FormEvent } from "react";
import type { NewBookInput, NewBookOptions, NewBookResult } from "../../shared/bookCreation";
import type { MediaType } from "../../shared/types";

const MODES = [
  ["blank", "新增全新书目"],
  ["series-one", "补充系列单册"],
  ["series-many", "批量补充系列书目"],
  ["author", "补充同作者书目"]
] as const;

interface Props {
  onClose: () => void;
  loadOptions: () => Promise<NewBookOptions>;
  onCreate: (input: NewBookInput) => Promise<NewBookResult>;
}

export default function NewBookDialog({ onClose, loadOptions, onCreate }: Props) {
  const [mode, setMode] = useState<NewBookInput["mode"]>("blank");
  const [options, setOptions] = useState<NewBookOptions | null>(null);
  const [mediaType, setMediaType] = useState<MediaType>("小说");
  const [target, setTarget] = useState("");
  const [search, setSearch] = useState("");
  const [count, setCount] = useState("2");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const series = mode === "series-one" || mode === "series-many";
  const needsTarget = mode !== "blank";
  const choices = series ? options?.series : options?.authors;
  const shown = choices?.filter((choice) => choice.name.toLowerCase().includes(search.trim().toLowerCase())) || [];

  useEffect(() => {
    let active = true;
    loadOptions().then((list) => {
      if (active) setOptions(list);
    }).catch(() => { if (active) setError("无法读取系列和作者"); });
    return () => { active = false; };
  }, [loadOptions]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || (needsTarget && !target)) return;
    setError("");
    setBusy(true);
    try {
      const result = await onCreate({
        mode,
        mediaType,
        seriesId: series ? Number(target) : undefined,
        authorId: mode === "author" ? Number(target) : undefined,
        count: mode === "series-many" ? Number(count) : undefined
      });
      if (!result.ok) setError(result.msg || "新增书目失败");
    } catch (e) {
      setError(e instanceof Error ? e.message : "新增书目失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mask on" onClick={() => { if (!busy) onClose(); }} />
      <div className="cadmin vp" role="dialog" aria-label="新增书目">
        <div className="cad-h">
          <h3>新增书目</h3>
          <span className="spacer" />
          <button className="xbtn" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </div>
        <form className="vp-form" onSubmit={submit}>
          <div className="vp-b">
            <label className="vp-row">
              <span className="vp-l">新增方式</span>
              <select className="vp-in" value={mode} disabled={busy} onChange={(e) => {
                setMode(e.target.value as NewBookInput["mode"]);
                setTarget("");
                setSearch("");
              }}>
                {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {needsTarget ? (
              <div className="vp-row">
                <label className="vp-l" htmlFor="new-book-target">{series ? "系列" : "作者"}</label>
                <div className="vp-c">
                  <input className="vp-in" aria-label={series ? "查找系列" : "查找作者"} value={search} disabled={busy} onChange={(e) => {
                    setSearch(e.target.value);
                    setTarget("");
                  }} />
                  <select id="new-book-target" className="vp-in" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)} required>
                    <option value="">{options ? "请选择" : "读取中…"}</option>
                    {shown.map((item) => <option key={item.id} value={item.id}>
                      {"mediaType" in item ? item.name + " · " + item.mediaType : item.name}
                    </option>)}
                  </select>
                </div>
              </div>
            ) : null}
            {!series ? (
              <label className="vp-row">
                <span className="vp-l">媒介</span>
                <select className="vp-in" value={mediaType} disabled={busy} onChange={(e) => setMediaType(e.target.value as MediaType)}>
                  <option>小说</option>
                  <option>漫画</option>
                </select>
              </label>
            ) : null}
            {mode === "series-many" ? (
              <label className="vp-row">
                <span className="vp-l">册数</span>
                <input className="vp-in" type="number" min="1" max="100" value={count} disabled={busy} onChange={(e) => setCount(e.target.value)} required />
              </label>
            ) : null}
            {error ? <div className="vp-err" role="alert">{error}</div> : null}
          </div>
          <div className="cad-foot vp-foot">
            <button type="button" className="mini" onClick={onClose} disabled={busy}>取消</button>
            <button className="mini" type="submit" disabled={busy || (needsTarget && !target)}>创建书目</button>
          </div>
        </form>
      </div>
    </>
  );
}
