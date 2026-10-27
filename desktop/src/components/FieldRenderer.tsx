import { useRef, useState } from "react";
import type { BookPatch, BookRow, FieldDef } from "../../shared/types";
import { MultiPick, SinglePick, type PickItem } from "./Pickers";
import { coverUrl } from "../api";

/**
 * 字段的取值、提交、控件三件事都在这里。
 * 表格单元格与详情行共用一套，类型一改两边同时变，不再逐个字段手写。
 */

/** 内建字段的值从 BookRow 的固定属性上取，自定义字段从 custom 里取 */
function builtinValues(f: FieldDef, b: BookRow): string[] {
  const one = (v: unknown) => (v === null || v === undefined || v === "" ? [] : [String(v)]);
  switch (f.patchKey) {
    case "title":
      return one(b.title);
    case "subtitle":
      return one(b.subtitle);
    case "originalTitle":
      return one(b.originalTitle);
    case "originalSubtitle":
      return one(b.originalSubtitle);
    case "mediaType":
      return one(b.mediaType);
    case "seriesName":
      return one(b.seriesName);
    case "seriesIndex":
      return b.seriesIndex == null ? [] : [String(b.seriesIndex)];
    case "country":
      return one(b.country);
    case "publishDate":
      return one(b.publishDate);
    case "isRead":
      return b.isRead ? ["1"] : [];
    case "readDate":
      return one(b.readDate);
    case "rating":
      return b.rating == null || b.rating === 0 ? [] : [String(b.rating)];
    case "ebookState":
      return one(b.ebookState);
    case "note":
      return one(b.note);
    case "authors":
      return b.authors;
    case "categories":
      return b.categories;
    case "states":
      return b.states;
    default:
      return b.custom[f.key] || [];
  }
}

export function valuesOf(f: FieldDef, b: BookRow): string[] {
  return f.builtin === 0 ? b.custom[f.key] || [] : builtinValues(f, b);
}

/** 表格与详情里显示的那一行字 */
export function valuesText(f: FieldDef, b: BookRow): string {
  const v = valuesOf(f, b);
  if (!v.length) return "";
  if (f.type === "switch") return v[0] === "1" ? "✓" : "";
  if (f.type === "rating" || f.type === "number") {
    const n = Number(v[0]);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : v[0];
  }
  return v.join("、");
}

export function optionsOf(f: FieldDef): string[] {
  return f.options.map((o) => o.name);
}

/** 提交只需给出字段与值，内建走原有补丁键，自定义走 custom */
export function patchOf(f: FieldDef, values: string[]): BookPatch {
  const list = (values || []).filter((v) => v !== "");
  if (f.builtin === 0) return { custom: { [f.key]: list } };
  const one = list[0] ?? "";
  switch (f.patchKey) {
    case "seriesIndex":
      return { seriesIndex: one.trim() === "" ? null : Number(one) };
    case "rating":
      return { rating: one.trim() === "" ? null : Number(one) };
    case "isRead":
      return { isRead: list.length > 0 };
    case "authors":
      return {
        authors: list
          .join("、")
          .split(/[、,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      };
    case "categories":
      return { categories: list };
    case "states":
      return { states: list };
    default:
      return { [f.patchKey]: one } as BookPatch;
  }
}

const today = (): string => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

/** <input type=date> 只吃 yyyy-mm-dd，源数据里有 2020-05 这种，截前 10 位再补零 */
function toDate(v: string): string {
  const m = String(v || "").match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (!m) return "";
  return m[1] + "-" + m[2].padStart(2, "0") + "-" + (m[3] || "01").padStart(2, "0");
}

interface EditProps {
  field: FieldDef;
  values: string[];
  onCommit: (values: string[]) => void;
  /** 弹出型控件挂上之后自动展开，表格里点一下就编辑 */
  autoOpen?: boolean;
  onDismiss?: () => void;
  /** 分类这类选项来自别处的字段，把整棵树传进来，没有就用字段自带的选项 */
  pickAll?: PickItem[];
  /** 图片字段要按书落文件，详情里得把书号带进来 */
  bookId?: string;
  /** 表格单元格里的编辑态，输入框要套上格子那套样式 */
  inCell?: boolean;
}

/**
 * 某个字段的编辑器，按类型分派。
 * 文本框一类用失焦提交，日期用选择即提交，开关点一下即提交。
 */
export function FieldEditor({ field, values, onCommit, autoOpen, onDismiss, pickAll, bookId, inCell }: EditProps) {
  const one = values[0] ?? "";
  const [draft, setDraft] = useState(one);
  /* 日期是一次提交一次，记下上次交出去的值，失焦时不再重复提交同一个 */
  const lastDay = useRef(one);

  if (field.type === "longtext") {
    return (
      <textarea
        className="fr-ta"
        rows={3}
        defaultValue={one}
        onBlur={(e) => {
          if (e.target.value !== one) onCommit([e.target.value]);
        }}
      />
    );
  }
  if (field.type === "date") {
    const send = (v: string) => {
      lastDay.current = v;
      onCommit(v ? [v] : []);
    };
    return (
      <input
        type="date"
        defaultValue={toDate(one)}
        onChange={(e) => send(e.target.value)}
        onBlur={(e) => {
          if (e.target.value !== lastDay.current) send(e.target.value);
        }}
      />
    );
  }
  if (field.type === "number" || field.type === "rating") {
    return (
      <input
        className={(inCell ? "tc-in " : "") + "num"}
        type="number"
        step={field.type === "rating" ? "0.1" : "1"}
        min={field.type === "rating" ? "0" : undefined}
        max={field.type === "rating" ? "10" : undefined}
        defaultValue={one}
        placeholder={field.type === "rating" ? "0 到 10" : undefined}
        onBlur={(e) => {
          const v = e.target.value === "" ? [] : [e.target.value];
          if (e.target.value !== one) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }
  if (field.type === "switch") {
    const on = one === "1" || one === "是";
    return (
      <label className="chk">
        <input type="checkbox" checked={on} onChange={(e) => onCommit(e.target.checked ? ["1"] : [])} />
        <span>{on ? "是" : "否"}</span>
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <SinglePick
        options={optionsOf(field)}
        value={one || null}
        autoOpen={autoOpen}
        onDismiss={onDismiss}
        onCommit={(v) => onCommit([v])}
      />
    );
  }
  if (field.type === "multiselect") {
    const all: PickItem[] =
      pickAll && pickAll.length ? pickAll : field.options.map((o) => ({ id: o.id, name: o.name, parentId: null }));
    return (
      <MultiPick
        all={all}
        picked={values}
        autoOpen={autoOpen}
        onDismiss={onDismiss}
        onCommit={(names) => onCommit(names)}
      />
    );
  }
  if (field.type === "image") {
    return (
      <ImageField field={field} value={one} book={bookId || ""} onCommit={(v) => onCommit(v ? [v] : [])} />
    );
  }
  /* 文本与关联都是打字，关联另外给个「去搜」入口由详情面板处理 */
  return (
    <input
      className={inCell ? "tc-in" : ""}
      autoFocus={autoOpen}
      value={draft}
      placeholder={field.type === "ref" ? "名称或编号" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== one) onCommit(draft === "" ? [] : [draft]);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(one);
          onDismiss?.();
        }
      }}
    />
  );
}

/** 图片字段：一张图落到书库的 covers 目录里，与封面同一套显示方式 */
function ImageField({
  field,
  value,
  book,
  onCommit
}: {
  field: FieldDef;
  value: string;
  book: string | null;
  onCommit: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="fr-img">
      {value ? <img src={coverUrl(value)} alt="" className="fr-thumb" /> : <span className="dim">没有图</span>}
      <button
        className="mini xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await window.api.pickFieldImage(field.key, book || "");
            if (r && r.ok && r.name) onCommit(r.name);
          } finally {
            setBusy(false);
          }
        }}
      >
        {value ? "换图" : "选图"}
      </button>
      {value ? (
        <button className="mini xs" onClick={() => onCommit("")} title="清掉这张图">
          清
        </button>
      ) : null}
    </span>
  );
}

/** 表格单元格：平时是文字，点一下换成编辑器 */
export function FieldCell({
  field,
  row,
  pickAll,
  onPatch
}: {
  field: FieldDef;
  row: BookRow;
  pickAll?: PickItem[];
  onPatch: (id: string, p: BookPatch) => void;
}) {
  const [editing, setEditing] = useState(false);
  const values = valuesOf(field, row);
  const text = valuesText(field, row);

  if (field.type === "image") {
    return values.length ? (
      <span className="tc" title={text}>
        <img className="tc-thumb" src={coverUrl(values[0])} alt="" />
      </span>
    ) : (
      <span className="tc dim">—</span>
    );
  }

  if (field.type === "switch") {
    return (
      <span
        className={"tc tick" + (values.length ? " on" : "")}
        title={values.length ? "点一下改成否" : "点一下改成是"}
        onClick={() => {
          const p = patchOf(field, values.length ? [] : ["1"]);
          /* 已读顺手补阅读日期，和详情页一个口径 */
          if (field.patchKey === "isRead" && !values.length && !row.readDate) {
            onPatch(row.id, { ...p, readDate: today() });
            return;
          }
          onPatch(row.id, p);
        }}
      >
        {values.length ? "✓" : ""}
      </span>
    );
  }

  const instant = field.type === "date";
  if (!editing && !instant) {
    return (
      <span
        className={"tc" + (text ? "" : " dim")}
        title={text || "点一下编辑"}
        onClick={() => setEditing(true)}
      >
        {text || "—"}
      </span>
    );
  }
  return (
    <div className={instant ? "tc-date" : "tc-mp"}>
      <FieldEditor
        field={field}
        values={values}
        autoOpen
        inCell
        pickAll={pickAll}
        onDismiss={() => setEditing(false)}
        onCommit={(v) => {
          setEditing(false);
          onPatch(row.id, patchOf(field, v));
        }}
      />
    </div>
  );
}
