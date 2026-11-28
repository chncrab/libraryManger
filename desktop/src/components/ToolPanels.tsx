import { EMPTY_ADV, type AdvFilter, type FieldDef } from "../../shared/types";
import { FILTER_OPS, filterOpsFor, ruleHasValue, type BookFilterGroup, type BookFilterRule, type FilterOp } from "../../shared/filterRules";
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
      <div className="tpanel" style={{
        width,
        left: pos ? `min(${pos.x}px, calc(100vw - ${width + 8}px))` : undefined,
        top: pos?.y
      }}>
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

export function AdvPanel({
  adv,
  fields,
  categories = [],
  onChange,
  onClose,
  pos
}: {
  adv: AdvFilter;
  fields: FieldDef[];
  categories?: string[];
  onChange: (a: AdvFilter) => void;
  onClose: () => void;
  pos?: { x: number; y: number } | null;
}) {
  const group = adv.group || { join: "and" as const, rules: [] };
  const available = fields.filter((f) => !f.deletedAt && (f.builtin || f.filterable));
  const publish = available.find((f) => f.key === "publishDate");
  if (publish) available.push({ ...publish, key: "publishYear", label: "出版年", type: "number" });
  const setGroup = (next: BookFilterGroup) => onChange({ ...adv, group: next });
  const setRules = (rules: BookFilterRule[]) => setGroup({ ...group, rules });
  const revise = (index: number, rule: BookFilterRule) =>
    setRules(group.rules.map((entry, i) => i === index ? rule : entry));

  return (
    <ToolPanel title="高级筛选" onClose={onClose} width={520} pos={pos}>
      <div className="tp-line">
        <select
          aria-label="条件组合"
          value={group.join}
          onChange={(e) => setGroup({ ...group, join: e.target.value === "or" ? "or" : "and" })}
        >
          <option value="and">且 · 满足全部条件</option>
          <option value="or">或 · 满足任一条件</option>
        </select>
      </div>
      {group.rules.map((rule, index) => {
        const field = available.find((f) => f.key === rule.key);
        const ops = field ? filterOpsFor(field) : [];
        const options = field?.key === "categories" ? categories
          : field?.type === "switch" ? ["1", "0"]
          : field?.options.map((o) => o.name) || [];
        const type = field?.type === "date" ? "date"
          : field?.type === "number" || field?.type === "rating" ? "number" : "text";
        const suffix = " " + (index + 1);
        return (
          <div className="tp-line" key={index}>
            <select aria-label={"字段" + suffix} value={rule.key} onChange={(e) => {
              const next = available.find((f) => f.key === e.target.value);
              if (next) revise(index, { key: next.key, op: filterOpsFor(next)[0] });
            }}>
              <option value="" disabled>选择字段</option>
              {available.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select
              aria-label={"运算符" + suffix}
              disabled={!field}
              value={field ? rule.op : ""}
              onChange={(e) => revise(index, { ...rule, op: e.target.value as FilterOp })}
            >
              {!field ? <option value="">选择运算符</option> : null}
              {ops.map((op) => <option key={op} value={op}>{FILTER_OPS[op]}</option>)}
            </select>
            {field && ruleHasValue(rule.op) ? (
              options.length ? (
                <select aria-label={"值" + suffix} value={rule.value ?? ""} onChange={(e) => revise(index, { ...rule, value: e.target.value })}>
                  <option value="">选择值</option>
                  {options.map((value) => <option key={value} value={value}>{field.type === "switch" ? (value === "1" ? "是" : "否") : value}</option>)}
                </select>
              ) : (
                <input
                  aria-label={"值" + suffix}
                  type={type}
                  step={type === "number" ? "any" : undefined}
                  placeholder="输入值"
                  value={rule.value ?? ""}
                  onChange={(e) => revise(index, { ...rule, value: e.target.value })}
                />
              )
            ) : <span className="spacer" />}
            <button className="mini xs" aria-label={"删除条件" + suffix} onClick={() => setRules(group.rules.filter((_, i) => i !== index))}>×</button>
          </div>
        );
      })}
      <div className="tp-foot">
        <button className="mini xs" onClick={() => setRules([...group.rules, { key: "", op: "contains" }])}>添加条件</button>
        <button className="mini xs" disabled={!group.rules.length} onClick={() => onChange({ ...EMPTY_ADV })}>全部清空</button>
      </div>
    </ToolPanel>
  );
}
