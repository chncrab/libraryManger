import { useEffect, useRef, useState } from "react";

export interface PickItem {
  id: number | string;
  name: string;
  parentId: number | null;
}

/** 点开面板，点面板以外的地方收起 */
function usePopover(auto = false, onDismiss?: () => void) {
  const [open, setOpen] = useState(auto);
  const box = useRef<HTMLDivElement | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        dismiss.current?.();
      }
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  return { open, setOpen, box };
}

/* 单选下拉。详情页的媒介、电子书，表格里的单元格都用它，外观与多选保持一套 */
export function SinglePick({
  options,
  value,
  onCommit,
  placeholder = "未选择",
  title
}: {
  options: string[];
  value: string | null;
  onCommit: (v: string) => void;
  placeholder?: string;
  title?: string;
}) {
  const { open, setOpen, box } = usePopover();
  return (
    <div className="mp" ref={box}>
      <div className="mp-show" onClick={() => setOpen(!open)} title={title || "点开选择"}>
        {value ? <span className="mp-one">{value}</span> : <span className="dim">{placeholder}</span>}
        <span className="mp-arrow">▾</span>
      </div>
      {open ? (
        <div className="mp-pop">
          {options.map((o) => (
            <div
              key={o}
              className={"mp-o" + (o === value ? " on" : "")}
              onClick={() => {
                setOpen(false);
                if (o !== value) onCommit(o);
              }}
            >
              {o}
            </div>
          ))}
          {options.length === 0 ? <div className="dim">没有可选项</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* 多选下拉：点一项勾一项，勾完立刻提交。分类按大分类分组列出，大分类只当标题，不参与勾选 */
export function MultiPick({
  all,
  picked,
  onCommit,
  emptyText = "未选择",
  autoOpen = false,
  onDismiss
}: {
  all: PickItem[];
  picked: string[];
  onCommit: (names: string[]) => void;
  emptyText?: string;
  autoOpen?: boolean;
  onDismiss?: () => void;
}) {
  const { open, setOpen, box } = usePopover(autoOpen, onDismiss);

  const roots = all.filter((x) => !x.parentId);
  const kidsOf = (id: number | string) => all.filter((x) => x.parentId === id);
  const toggle = (name: string) => {
    onCommit(picked.includes(name) ? picked.filter((x) => x !== name) : [...picked, name]);
  };

  /* 父分类没出现在列表里的子项，单独兜底一档，不然选不到 */
  const orphan = all.filter((x) => x.parentId && !all.some((p) => p.id === x.parentId));

  return (
    <div className="mp" ref={box}>
      <div className="mp-show" onClick={() => setOpen(!open)} title="点开选择">
        {picked.length ? (
          picked.map((p) => (
            <span key={p} className="mp-tag">
              {p}
            </span>
          ))
        ) : (
          <span className="dim">{emptyText}</span>
        )}
        <span className="mp-arrow">▾</span>
      </div>
      {open ? (
        <div className="mp-pop">
          {roots.map((r) => (
            <div key={r.id}>
              <div className="mp-g">{r.name}</div>
              {kidsOf(r.id).map((k) => (
                <div key={k.id} className={"mp-i" + (picked.includes(k.name) ? " on" : "")} onClick={() => toggle(k.name)}>
                  {k.name}
                </div>
              ))}
            </div>
          ))}
          {orphan.map((k) => (
            <div key={k.id} className={"mp-i" + (picked.includes(k.name) ? " on" : "")} onClick={() => toggle(k.name)}>
              {k.name}
            </div>
          ))}
          {all.length === 0 ? <div className="dim">还没有分类</div> : null}
        </div>
      ) : null}
    </div>
  );
}
