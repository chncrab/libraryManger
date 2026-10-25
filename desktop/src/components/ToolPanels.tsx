import type { AdvFilter } from "../../shared/types";
import { COLUMNS, DEFAULT_HIDDEN } from "../columns";

/** 工具栏下方浮出的面板，列设置与高级筛选共用外壳 */
export function ToolPanel({
  title,
  hint,
  onClose,
  children,
  width = 268,
  pos
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  /** 锚在触发按钮下方，跟着按钮走，不压住左侧栏 */
  pos?: { x: number; y: number } | null;
}) {
  return (
    <>
      <div className="tp-mask" onClick={onClose} />
      <div className="tpanel" style={{ width, left: pos ? pos.x : undefined, top: pos ? pos.y : undefined }}>
        <div className="tp-h">
          <b>{title}</b>
          {hint ? <span className="dim">{hint}</span> : null}
          <span className="spacer" />
          <button className="xbtn sm" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="tp-b">{children}</div>
      </div>
    </>
  );
}

export function ColumnPanel({
  hidden,
  onChange,
  onClose,
  pos
}: {
  hidden: string[];
  onChange: (h: string[]) => void;
  onClose: () => void;
  pos?: { x: number; y: number } | null;
}) {
  const toggle = (key: string) => {
    onChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
  };
  return (
    <ToolPanel title="列设置" hint="点一行显示或隐藏" onClose={onClose} width={230} pos={pos}>
      {COLUMNS.map((c) => (
        <div
          key={c.key}
          className={"tp-row" + (c.fixed ? " off" : "") + (hidden.includes(c.key) ? " hide" : "")}
          onClick={() => !c.fixed && toggle(c.key)}
        >
          <span className="tp-tick">{hidden.includes(c.key) ? "" : "✓"}</span>
          <span>{c.label || "操作"}</span>
          {c.fixed ? <span className="dim">固定</span> : null}
        </div>
      ))}
      <div className="tp-foot">
        <button className="mini xs" onClick={() => onChange([])}>
          全部显示
        </button>
        <button className="mini xs" onClick={() => onChange(DEFAULT_HIDDEN)}>
          恢复默认
        </button>
      </div>
    </ToolPanel>
  );
}

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export function AdvPanel({
  adv,
  onChange,
  onClose,
  pos
}: {
  adv: AdvFilter;
  onChange: (a: AdvFilter) => void;
  onClose: () => void;
  pos?: { x: number; y: number } | null;
}) {
  const set = (p: Partial<AdvFilter>) => onChange({ ...adv, ...p });
  const dirty =
    adv.ratingMin != null ||
    adv.ratingMax != null ||
    adv.yearFrom != null ||
    adv.yearTo != null ||
    adv.hasReview !== null ||
    !!adv.note.trim();

  return (
    <ToolPanel title="高级筛选" hint="留空表示不限" onClose={onClose} width={300} pos={pos}>
      <div className="tp-lab">评分区间</div>
      <div className="tp-line">
        <input
          type="number"
          step="0.1"
          min="0"
          max="10"
          placeholder="最低"
          value={adv.ratingMin ?? ""}
          onChange={(e) => set({ ratingMin: num(e.target.value) })}
        />
        <span className="dim">到</span>
        <input
          type="number"
          step="0.1"
          min="0"
          max="10"
          placeholder="最高"
          value={adv.ratingMax ?? ""}
          onChange={(e) => set({ ratingMax: num(e.target.value) })}
        />
      </div>

      <div className="tp-lab">出版年</div>
      <div className="tp-line">
        <input
          type="number"
          placeholder="从"
          value={adv.yearFrom ?? ""}
          onChange={(e) => set({ yearFrom: num(e.target.value) })}
        />
        <span className="dim">到</span>
        <input type="number" placeholder="到" value={adv.yearTo ?? ""} onChange={(e) => set({ yearTo: num(e.target.value) })} />
      </div>

      <div className="tp-lab">书评</div>
      <div className="tp-line">
        {[
          { k: null, label: "不限" },
          { k: true, label: "有书评" },
          { k: false, label: "没书评" }
        ].map((o) => (
          <button
            key={String(o.k)}
            className={"mini xs" + (adv.hasReview === o.k ? " on" : "")}
            onClick={() => set({ hasReview: o.k as boolean | null })}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="tp-lab">备注含关键词</div>
      <div className="tp-line">
        <input value={adv.note} placeholder="例如 限定版" onChange={(e) => set({ note: e.target.value })} />
      </div>

      <div className="tp-foot">
        <button
          className="mini xs"
          disabled={!dirty}
          onClick={() =>
            onChange({ ratingMin: null, ratingMax: null, yearFrom: null, yearTo: null, hasReview: null, note: "" })
          }
        >
          全部清空
        </button>
        <span className="spacer" />
        <button className="mini xs" onClick={onClose}>
          收起
        </button>
      </div>
    </ToolPanel>
  );
}
