import { useEffect, useState } from "react";
import api from "../api";
import { FIELD_TYPES, type FieldDef, type FieldReject, type FieldResult, type FieldType } from "../../shared/types";

interface Props {
  onClose: () => void;
  onChanged: () => void;
}

/* 字段管理：新建、改名、改类型、管选项、删与恢复。
   内建字段不许删也不许改类型，那是 books 表的列，改了会和现有查询打架 */
export default function FieldAdmin({ onClose, onChanged }: Props) {
  const [list, setList] = useState<FieldDef[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<FieldType>("text");
  const [newOptions, setNewOptions] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [optOpen, setOptOpen] = useState<number | null>(null);
  const [optName, setOptName] = useState("");
  const [msg, setMsg] = useState("");
  const [rejected, setRejected] = useState<FieldReject[]>([]);

  const load = () =>
    api.listFields(true).then((f) => {
      /* 已删除的也调回来，给恢复入口 */
      setList(f);
    });
  useEffect(() => {
    load();
  }, []);

  const done = (r: FieldResult, okText = "") => {
    setRejected(r.rejected || []);
    setMsg(r.ok ? okText : r.msg || "操作没成功");
    if (r.ok) {
      load();
      onChanged();
    }
  };

  const add = async () => {
    if (!newLabel.trim()) return;
    const options = newOptions
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await api.createField({ label: newLabel, type: newType, options });
    done(r);
    if (r.ok) {
      setNewLabel("");
      setNewOptions("");
    }
  };

  const saveName = async (id: number) => {
    if (!editName.trim()) {
      setEditId(null);
      return;
    }
    const r = await api.updateField(id, { label: editName });
    done(r);
    if (r.ok) setEditId(null);
  };

  const row = (f: FieldDef) => (
    <div key={f.key} className={"cad-r" + (f.deletedAt ? " off" : "")}>
      {editId === f.id ? (
        <input
          className="cad-in"
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => saveName(f.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName(f.id);
            if (e.key === "Escape") setEditId(null);
          }}
        />
      ) : (
        <span
          className="cad-n"
          onDoubleClick={() => {
            if (f.builtin) return;
            setEditId(f.id);
            setEditName(f.label);
          }}
          title={f.builtin ? "内建字段" : "双击改名"}
        >
          {f.label}
        </span>
      )}

      <select
        className="cad-par"
        value={f.type}
        disabled={!!f.builtin}
        title={f.builtin ? "内建字段的类型固定" : "改类型会先试一遍全库的值"}
        onChange={(e) => api.changeFieldType(f.id, e.target.value as FieldType).then((r) => done(r))}
      >
        {FIELD_TYPES.map((t) => (
          <option key={t.type} value={t.type}>
            {t.label}
          </option>
        ))}
      </select>

      <label className="cad-chk" title="表格里出不出这一列">
        <input type="checkbox" checked={f.inTable} disabled={!!f.builtin} onChange={(e) => api.updateField(f.id, { inTable: e.target.checked }).then((r) => done(r))} />
        <span>列</span>
      </label>
      <label className="cad-chk" title="全文搜索能不能搜到这一项">
        <input type="checkbox" checked={f.searchable} onChange={(e) => api.updateField(f.id, { searchable: e.target.checked }).then((r) => done(r))} />
        <span>搜</span>
      </label>
      <label className="cad-chk" title="高级筛选里出不出现">
        <input type="checkbox" checked={f.filterable} onChange={(e) => api.updateField(f.id, { filterable: e.target.checked }).then((r) => done(r))} />
        <span>筛</span>
      </label>

      <span className="cad-num">{f.builtin ? "内建" : f.filled + " 本"}</span>

      <span className="cad-acts">
        <button className="mini" title="上移" onClick={() => api.moveField(f.id, -1).then((r) => done(r))}>
          ↑
        </button>
        <button className="mini" title="下移" onClick={() => api.moveField(f.id, 1).then((r) => done(r))}>
          ↓
        </button>
        {f.type === "select" || f.type === "multiselect" ? (
          <button className="mini" title="管理选项" onClick={() => setOptOpen(optOpen === f.id ? null : f.id)}>
            项
          </button>
        ) : null}
        {!f.builtin && !f.deletedAt ? (
          <button className="mini danger" title="删除，值会留着" onClick={() => api.removeField(f.id).then((r) => done(r))}>
            删
          </button>
        ) : null}
        {f.deletedAt ? (
          <button className="mini" title="恢复这个字段与它的值" onClick={() => api.restoreField(f.id).then((r) => done(r))}>
            恢复
          </button>
        ) : null}
      </span>

      {optOpen === f.id ? (
        <div className="cad-add">
          <input
            className="cad-in"
            placeholder="新选项，回车确认"
            value={optName}
            onChange={(e) => setOptName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !optName.trim()) return;
              const r = await api.addFieldOption(f.id, optName);
              done(r);
              if (r.ok) setOptName("");
            }}
          />
          <button
            className="mini"
            onClick={async () => {
              if (!optName.trim()) return;
              const r = await api.addFieldOption(f.id, optName);
              done(r);
              if (r.ok) setOptName("");
            }}
          >
            加
          </button>
          <div className="cad-opts">
            {f.options.map((o) => (
              <span key={o.id} className="cad-opt">
                <input
                  className="cad-opt-in"
                  defaultValue={o.name}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== o.name) api.renameFieldOption(o.id, e.target.value).then((r) => done(r));
                  }}
                />
                <button className="mini danger" title="删掉这个选项" onClick={() => api.removeFieldOption(o.id).then((r) => done(r))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <div className="cadmin">
        <div className="cad-h">
          <h3>字段管理</h3>
          <span className="dim">改类型会先试一遍全库的值，认不了的就列出来等你定</span>
          <span className="spacer" />
          <button className="xbtn" onClick={onClose} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="cad-body">
          {msg ? <div className="cad-msg">{msg}</div> : null}
          {rejected.length ? (
            <div className="cad-rej">
              <b>改不成，这些书的值对不上</b>
              {rejected.slice(0, 12).map((r) => (
                <div key={r.bookId}>
                  《{r.title}》 {r.value}
                </div>
              ))}
              {rejected.length > 12 ? <div className="dim">还有 {rejected.length - 12} 本</div> : null}
            </div>
          ) : null}
          {list.map(row)}
          {list.length === 0 ? <div className="dim">还没有字段</div> : null}
        </div>

        <div className="cad-foot">
          <input
            className="cad-in"
            placeholder="新字段名，例如 译者"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <select value={newType} onChange={(e) => setNewType(e.target.value as FieldType)}>
            {FIELD_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          {newType === "select" || newType === "multiselect" ? (
            <input
              className="cad-in"
              placeholder="选项，用、分隔"
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
            />
          ) : null}
          <button className="mini" onClick={add}>
            新建
          </button>
        </div>
      </div>
    </>
  );
}
