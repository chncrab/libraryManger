import { useEffect, useRef, useState } from "react";
import api from "../api";
import type { CatNode } from "../../shared/types";

interface Props {
  onClose: () => void;
  onChanged: () => void;
}

/* 分类管理：大分类下挂小标签，两级。改名就地改，拖不动就用上下箭头顶替 */
export default function CategoryAdmin({ onClose, onChanged }: Props) {
  const [list, setList] = useState<CatNode[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [childOf, setChildOf] = useState<number | null>(null);
  const [childName, setChildName] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [msg, setMsg] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  const load = () => api.categoryTree().then(setList);
  useEffect(() => {
    load();
  }, []);

  const done = (r: { ok: boolean; msg?: string }) => {
    setMsg(r.ok ? "" : r.msg || "操作没成功");
    if (r.ok) {
      load();
      onChanged();
    }
  };

  const roots = list.filter((c) => !c.parentId);
  const kidsOf = (id: number) => list.filter((c) => c.parentId === id);
  /* 父分类被删或数据不规整时，子项也不能丢 */
  const orphans = list.filter((c) => c.parentId && !list.some((p) => p.id === c.parentId));

  /* 能当父级的只有根分类，还要排除自己这一枝，否则成环 */
  const under = (id: number): number[] => {
    const out: number[] = [];
    const walk = (pid: number) => {
      for (const k of kidsOf(pid)) {
        out.push(k.id);
        walk(k.id);
      }
    };
    walk(id);
    return out;
  };
  const parOptions = (c: CatNode) => roots.filter((r) => r.id !== c.id && !under(c.id).includes(r.id));

  const addRoot = async () => {
    if (!newRoot.trim()) return;
    const r = await api.createCategory(newRoot, null);
    done(r);
    if (r.ok) setNewRoot("");
  };

  const addChild = async (pid: number | null) => {
    if (!pid || !childName.trim()) return;
    const r = await api.createCategory(childName, pid);
    done(r);
    if (r.ok) {
      setChildName("");
      setChildOf(null);
    }
  };

  const saveName = async (id: number) => {
    if (!editName.trim()) {
      setEditId(null);
      return;
    }
    const r = await api.renameCategory(id, editName);
    done(r);
    if (r.ok) setEditId(null);
  };

  const row = (c: CatNode, depth: number) => (
    <div key={c.id} className={"cad-r" + (depth ? " sub" : "")}>
      {editId === c.id ? (
        <input
          className="cad-in"
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => saveName(c.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName(c.id);
            if (e.key === "Escape") setEditId(null);
          }}
        />
      ) : (
        <span
          className="cad-n"
          onDoubleClick={() => {
            setEditId(c.id);
            setEditName(c.name);
          }}
          title="双击改名"
        >
          {c.name}
        </span>
      )}
      <span className="cad-num">{c.n}</span>
      <select
        className="cad-par"
        value={c.parentId ?? ""}
        title="挂在哪个大分类下面"
        onChange={(e) => api.setCategoryParent(c.id, e.target.value ? Number(e.target.value) : null).then(done)}
      >
        <option value="">（顶级）</option>
        {parOptions(c).map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <span className="cad-acts">
        <button className="mini" title="上移" onClick={() => api.moveCategory(c.id, -1).then(done)}>
          ↑
        </button>
        <button className="mini" title="下移" onClick={() => api.moveCategory(c.id, 1).then(done)}>
          ↓
        </button>
        <button
          className="mini"
          title="改名"
          onClick={() => {
            setEditId(c.id);
            setEditName(c.name);
          }}
        >
          改
        </button>
        {depth === 0 ? (
          <button
            className="mini"
            title="在这个大分类下加小标签"
            onClick={() => {
              setChildOf(childOf === c.id ? null : c.id);
              setChildName("");
            }}
          >
            ＋
          </button>
        ) : null}
        <button className="mini danger" title="删除" onClick={() => api.removeCategory(c.id).then(done)}>
          删
        </button>
      </span>
      {childOf === c.id ? (
        <div className="cad-add">
          <input
            className="cad-in"
            autoFocus
            placeholder={"在「" + c.name + "」下新建小标签"}
            value={childName}
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addChild(c.id);
              if (e.key === "Escape") setChildOf(null);
            }}
          />
          <button className="mini" onClick={() => addChild(c.id)}>
            建
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="mask on" onClick={onClose} />
      <div className="cadmin" ref={box}>
        <div className="cad-h">
          <h3>分类管理</h3>
          <span className="dim">双击名字也能改，只做两级</span>
          <span className="spacer" />
          <button className="xbtn" onClick={onClose} title="关闭" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="cad-body">
          {msg ? <div className="cad-msg">{msg}</div> : null}

          {roots.map((r) => (
            <div key={r.id} className="cad-grp">
              {row(r, 0)}
              {kidsOf(r.id).map((k) => row(k, 1))}
            </div>
          ))}
          {orphans.map((k) => row(k, 1))}
          {roots.length === 0 ? <div className="dim">还没有分类</div> : null}
        </div>

        <div className="cad-foot">
          <input
            className="cad-in"
            placeholder="新增大分类，回车确认"
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addRoot();
            }}
          />
          <button className="mini" onClick={addRoot}>
            新建
          </button>
        </div>
      </div>
    </>
  );
}
