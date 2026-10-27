import type { AdvFilter, FieldDef, FieldFilter } from "../../shared/types";
import { DEFAULT_HIDDEN } from "../columns";

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

/** 列设置读字段表，字段管理里加的字段这里立刻就有 */
export function ColumnPanel({
  fields,
  hidden,
  onChange,
  onClose,
  pos
}: {
  fields: FieldDef[];
  hidden: string[];
  onChange: (h: string[]) => void;
  onClose: () => void;
  pos?: { x: number; y: number } | null;
}) {
  const toggle = (key: string) => {
    onChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
  };
  const list = fields.filter((f) => !f.deletedAt);
  return (
    <ToolPanel title="列设置" hint="点一行显示或隐藏" onClose={onClose} width={230} pos={pos}>
      {list.map((c) => (
        <div
          key={c.key}
          className={"tp-row" + (c.inTable ? "" : " off") + (hidden.includes(c.key) ? " hide" : "")}
          onClick={() => c.inTable && toggle(c.key)}
        >
          <span className="tp-tick">{c.inTable && !hidden.includes(c.key) ? "✓" : ""}</span>
          <span>{c.label}</span>
          {c.inTable ? null : <span className="dim">不出列</span>}
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

/** 一个字段的筛选行，控件按类型分派 */
function FilterRow({
  field,
  cur,
  onChange
}: {
  field: FieldDef;
  cur: FieldFilter | undefined;
  onChange: (f: FieldFilter | null) => void;
}) {
  const set = (p: Partial<FieldFilter>) => onChange({ ...(cur || { key: field.key, op: "like" }), ...p });

  if (field.type === "switch") {
    const v = cur ? cur.op : "";
    return (
      <div className="tp-line">
        <button className={"mini xs" + (v === "yes" ? " on" : "")} onClick={() => onChange({ key: field.key, op: "yes" })}>
          是
        </button>
        <button className={"mini xs" + (v === "no" ? " on" : "")} onClick={() => onChange({ key: field.key, op: "no" })}>
          否
        </button>
        <button className={"mini xs" + (v === "" ? " on" : "")} onClick={() => onChange(null)}>
          不限
        </button>
      </div>
    );
  }

  if (field.type === "number" || field.type === "rating" || field.type === "date") {
    const isDate = field.type === "date";
    return (
      <div className="tp-line">
        <input
          type={isDate ? "date" : "number"}
          placeholder="从"
          value={cur?.a ?? ""}
          onChange={(e) => set({ op: "between", a: e.target.value })}
        />
        <span className="dim">到</span>
        <input
          type={isDate ? "date" : "number"}
          placeholder="到"
          value={cur?.b ?? ""}
          onChange={(e) => set({ op: "between", b: e.target.value })}
        />
      </div>
    );
  }

  if (field.type === "select" || field.type === "multiselect") {
    return (
      <div className="tp-line">
        <select value={cur?.a ?? ""} onChange={(e) => (e.target.value ? set({ op: "has", a: e.target.value }) : onChange(null))}>
          <option value="">不限</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="tp-line">
      <input
        placeholder="含关键词"
        value={cur?.a ?? ""}
        onChange={(e) => (e.target.value ? set({ op: "like", a: e.target.value }) : onChange(null))}
      />
    </div>
  );
}

export function AdvPanel({
  adv,
  fields,
  onChange,
  onClose,
  pos
}: {
  adv: AdvFilter;
  fields: FieldDef[];
  onChange: (a: AdvFilter) => void;
  onClose: () => void;
  pos?: { x: number; y: number } | null;
}) {
  const set = (p: Partial<AdvFilter>) => onChange({ ...adv, ...p });
  const fvals = adv.fvals || [];
  const setField = (key: string, f: FieldFilter | null) => {
    const rest = fvals.filter((x) => x.key !== key);
    set({ fvals: f ? [...rest, f] : rest });
  };
  const dirty =
    adv.ratingMin != null ||
    adv.ratingMax != null ||
    adv.yearFrom != null ||
    adv.yearTo != null ||
    adv.hasReview !== null ||
    !!adv.note.trim() ||
    fvals.length > 0;

  const filtrable = fields.filter((f) => !f.deletedAt && f.filterable);

  return (
    <ToolPanel title="高级筛选" hint="留空表示不限" onClose={onClose} width={312} pos={pos}>
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

      {filtrable.length ? (
        <>
          <div className="tp-lab">字段</div>
          {filtrable.map((f) => (
            <div key={f.key} className="tp-field">
              <span className="tp-fname">{f.label}</span>
              <FilterRow field={f} cur={fvals.find((x) => x.key === f.key)} onChange={(x) => setField(f.key, x)} />
            </div>
          ))}
        </>
      ) : null}

      <div className="tp-foot">
        <button
          className="mini xs"
          disabled={!dirty}
          onClick={() =>
            onChange({ ratingMin: null, ratingMax: null, yearFrom: null, yearTo: null, hasReview: null, note: "", fvals: [] })
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
