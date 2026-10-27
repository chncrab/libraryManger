import type { DB } from "../db";
import type { FieldDef, FieldInput, FieldOption, FieldPatch, FieldReject, FieldResult, FieldType } from "../../shared/types";
import { rebuildAllFts } from "../db/fts";

/**
 * 字段定义与自定义字段的值。
 * 表格列、详情行、排序键、筛选控件全都读这里，界面不再自己列字段。
 */

const now = () => new Date().toISOString();

interface RawField {
  id: number;
  key: string;
  label: string;
  type: string;
  builtin: number;
  col: string;
  patch_key: string;
  width: number;
  ord: number;
  in_table: number;
  searchable: number;
  filterable: number;
  deleted_at: string | null;
}

function toDef(r: RawField, opts: FieldOption[], filled: number): FieldDef {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type as FieldType,
    builtin: r.builtin,
    col: r.col,
    patchKey: r.patch_key,
    width: r.width,
    ord: r.ord,
    inTable: !!r.in_table,
    searchable: !!r.searchable,
    filterable: !!r.filterable,
    deletedAt: r.deleted_at || null,
    filled,
    options: opts
  };
}

/** 字段清单，含已删除的。带选项与已填条目数 */
export function listFields(db: DB, withDeleted = false): FieldDef[] {
  const rows = db
    .prepare(`SELECT * FROM fields ${withDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY ord, id`)
    .all() as RawField[];
  const opts = db
    .prepare("SELECT id, field_id, name, ord FROM field_options WHERE deleted_at IS NULL ORDER BY ord, id")
    .all() as any[];
  const filled = new Map<number, number>(
    (db.prepare("SELECT field_id, COUNT(DISTINCT book_id) AS n FROM book_field_values GROUP BY field_id").all() as any[]).map(
      (r) => [Number(r.field_id), Number(r.n)]
    )
  );
  return rows.map((r) =>
    toDef(
      r,
      opts.filter((o) => o.field_id === r.id).map((o) => ({ id: o.id, name: o.name, color: "", ord: o.ord })),
      filled.get(r.id) || 0
    )
  );
}

function fieldById(db: DB, id: number): RawField | undefined {
  return db.prepare("SELECT * FROM fields WHERE id = ?").get(id) as RawField | undefined;
}

function fieldByKey(db: DB, key: string): RawField | undefined {
  return db.prepare("SELECT * FROM fields WHERE key = ?").get(key) as RawField | undefined;
}

function optionsOf(db: DB, fieldId: number): string[] {
  return (db.prepare("SELECT name FROM field_options WHERE field_id = ? AND deleted_at IS NULL ORDER BY ord, id").all(fieldId) as any[]).map(
    (r) => String(r.name)
  );
}

/* ---- 值 ---- */

/** 日期归一成 yyyy-mm-dd，认 2026-5、2026/05/01、2026.5.1 这几种写法 */
export function toDay(v: string): string {
  const m = String(v || "").match(/^(\d{4})[-/.年]?(\d{1,2})?[-/.月]?(\d{1,2})?/);
  if (!m) return "";
  const y = m[1];
  const mo = (m[2] || "1").padStart(2, "0");
  const d = (m[3] || "1").padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export interface ValueRow {
  ord: number;
  val: string;
  num: number | null;
  day: string | null;
  ref: string;
}

/**
 * 把界面传来的字符串按类型摊成值行。
 * 开关只有开才落一行，关就是没有这一行，空数组即关。
 */
export function toValueRows(type: FieldType, values: string[]): ValueRow[] {
  const list = (values || []).map((v) => String(v == null ? "" : v)).filter((v) => v !== "");
  if (type === "switch") {
    const on = list.some((v) => /^(1|true|是|on)$/i.test(v.trim()));
    return on ? [{ ord: 0, val: "1", num: 1, day: null, ref: "" }] : [];
  }
  return list.map((v, i) => {
    const s = v.trim();
    if (type === "number") {
      const n = Number(s);
      return { ord: i, val: s, num: Number.isFinite(n) ? n : null, day: null, ref: "" };
    }
    if (type === "rating") {
      const n = Number(s);
      return { ord: i, val: s, num: Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : null, day: null, ref: "" };
    }
    if (type === "date") {
      const d = toDay(s);
      return { ord: i, val: d || s, num: null, day: d || null, ref: "" };
    }
    if (type === "ref") return { ord: i, val: s, num: null, day: null, ref: s };
    return { ord: i, val: s, num: null, day: null, ref: "" };
  });
}

/** 一批书的自定义字段值，键是字段 key，值一律给数组 */
export function customOfBooks(db: DB, ids: string[]): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT v.book_id, f.key, v.val FROM book_field_values v JOIN fields f ON f.id = v.field_id
        WHERE v.book_id IN (${marks}) AND f.deleted_at IS NULL
        ORDER BY f.ord, v.ord`
    )
    .all(...ids) as any[];
  for (const r of rows) {
    const id = String(r.book_id);
    const key = String(r.key);
    if (!out[id]) out[id] = {};
    if (!out[id][key]) out[id][key] = [];
    out[id][key].push(String(r.val));
  }
  return out;
}

/** 写一本的自定义字段值。传了哪个键就整组重写哪个 */
export function setCustom(db: DB, bookId: string, values: Record<string, string[]>): string[] {
  const touched: string[] = [];
  for (const [key, vals] of Object.entries(values || {})) {
    const f = fieldByKey(db, key);
    if (!f || f.deleted_at || f.builtin !== 0) continue;
    db.prepare("DELETE FROM book_field_values WHERE book_id = ? AND field_id = ?").run(bookId, f.id);
    const ins = db.prepare(
      "INSERT INTO book_field_values (book_id, field_id, ord, val, num, day, ref) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of toValueRows(f.type as FieldType, vals || [])) {
      ins.run(bookId, f.id, row.ord, row.val, row.num, row.day, row.ref);
    }
    touched.push(key);
  }
  return touched;
}

/* ---- 字段增删改 ---- */

function nextOrd(db: DB): number {
  return ((db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM fields").get() as any).m as number) + 1;
}

/** 序号压成 1、2、3 连续，改完顺序不用留空洞 */
function resequence(db: DB): void {
  const all = db.prepare("SELECT id FROM fields ORDER BY ord, id").all() as any[];
  const run = db.transaction(() => {
    all.forEach((r, i) => db.prepare("UPDATE fields SET ord = ? WHERE id = ?").run(i + 1, r.id));
  });
  run();
}

function badType(t: string): boolean {
  return !["text", "longtext", "number", "date", "switch", "rating", "select", "multiselect", "image", "ref"].includes(t);
}

export function createField(db: DB, p: FieldInput): FieldResult {
  const label = String(p.label || "").trim();
  if (!label) return { ok: false, msg: "字段名不能为空" };
  if (badType(p.type)) return { ok: false, msg: "不认识的类型" };
  if ((p.type === "select" || p.type === "multiselect") && !(p.options || []).length) {
    return { ok: false, msg: "单选与多选至少要有一个选项" };
  }
  const hit = db.prepare("SELECT id FROM fields WHERE label = ? AND deleted_at IS NULL").get(label) as any;
  if (hit) return { ok: false, msg: "已经有同名字段了" };

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO fields (key, label, type, builtin, col, patch_key, width, ord, in_table, searchable, filterable)
         VALUES (?, ?, ?, 0, '', '', ?, ?, ?, ?, ?)`
      )
      .run(
        "f_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        label,
        p.type,
        p.width ?? 0,
        nextOrd(db),
        p.inTable === false ? 0 : 1,
        p.searchable ? 1 : 0,
        /* 自定义字段默认可筛，建出来就能在高级筛选里用 */
        p.filterable === false ? 0 : 1
      );
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare("INSERT INTO field_options (field_id, name, ord) VALUES (?, ?, ?)");
    const seen = new Set<string>();
    (p.options || []).forEach((name, i) => {
      const n = String(name || "").trim();
      if (!n || seen.has(n)) return;
      seen.add(n);
      ins.run(id, n, i + 1);
    });
    return id;
  });
  return { ok: true, id: run() };
}

export function updateField(db: DB, id: number, p: FieldPatch): FieldResult {
  const f = fieldById(db, id);
  if (!f) return { ok: false, msg: "字段不存在" };
  if (p.label !== undefined) {
    const label = String(p.label).trim();
    if (!label) return { ok: false, msg: "字段名不能为空" };
    const dup = db.prepare("SELECT id FROM fields WHERE label = ? AND id <> ? AND deleted_at IS NULL").get(label, id) as any;
    if (dup) return { ok: false, msg: "已经有同名字段了" };
    db.prepare("UPDATE fields SET label = ? WHERE id = ?").run(label, id);
  }
  if (p.width !== undefined) db.prepare("UPDATE fields SET width = ? WHERE id = ?").run(Number(p.width) || 0, id);
  if (p.inTable !== undefined) db.prepare("UPDATE fields SET in_table = ? WHERE id = ?").run(p.inTable ? 1 : 0, id);
  if (p.searchable !== undefined) {
    db.prepare("UPDATE fields SET searchable = ? WHERE id = ?").run(p.searchable ? 1 : 0, id);
    /* 改了可搜索标记，全库索引要重算，否则搜出来还是老样子 */
    rebuildAllFts(db);
  }
  if (p.filterable !== undefined) db.prepare("UPDATE fields SET filterable = ? WHERE id = ?").run(p.filterable ? 1 : 0, id);
  return { ok: true, id };
}

export function moveField(db: DB, id: number, dir: -1 | 1): FieldResult {
  const all = db.prepare("SELECT id FROM fields ORDER BY ord, id").all() as any[];
  const i = all.findIndex((r) => Number(r.id) === id);
  if (i < 0) return { ok: false, msg: "字段不存在" };
  const j = i + dir;
  if (j < 0 || j >= all.length) return { ok: true, id };
  const run = db.transaction(() => {
    db.prepare("UPDATE fields SET ord = ? WHERE id = ?").run(j + 1, Number(all[i].id));
    db.prepare("UPDATE fields SET ord = ? WHERE id = ?").run(i + 1, Number(all[j].id));
  });
  run();
  resequence(db);
  return { ok: true, id };
}

/** 类型能不能认，逐条试，认不了的原样返回 false，不清空 */
function canHold(type: FieldType, val: string): boolean {
  const v = String(val || "").trim();
  if (v === "") return true;
  switch (type) {
    case "number":
      return Number.isFinite(Number(v));
    case "rating": {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 10;
    }
    case "date":
      return /^\d{4}/.test(toDay(v));
    case "switch":
      return /^(1|0|true|false|是|否|on|off)$/i.test(v);
    case "ref":
      return v !== "";
    default:
      return true;
  }
}

/**
 * 改类型。先把全库的值都试一遍，有不认的就整批拒绝并把清单交回去，
 * 由人决定是清理还是换个类型，绝不静默清空。
 * 内建字段不许改，books 表的列类型跟着 SQLite 走，改了会和现有查询打架。
 */
export function changeFieldType(db: DB, id: number, type: FieldType): FieldResult {
  const f = fieldById(db, id);
  if (!f) return { ok: false, msg: "字段不存在" };
  if (f.builtin !== 0) return { ok: false, msg: "内建字段不能改类型，要别的类型请新建一个字段" };
  if (badType(type)) return { ok: false, msg: "不认识的类型" };
  const old = f.type as FieldType;
  if (old === type) return { ok: true, id };

  const rows = db
    .prepare(
      `SELECT v.book_id, v.ord, v.val, b.title FROM book_field_values v JOIN books b ON b.id = v.book_id
        WHERE v.field_id = ? ORDER BY v.book_id, v.ord`
    )
    .all(id) as any[];

  const byBook = new Map<string, { title: string; vals: string[] }>();
  for (const r of rows) {
    const k = String(r.book_id);
    if (!byBook.has(k)) byBook.set(k, { title: String(r.title || ""), vals: [] });
    byBook.get(k)!.vals.push(String(r.val));
  }

  const rejected: FieldReject[] = [];
  const singles = new Set(["text", "longtext", "number", "date", "switch", "rating", "select", "image", "ref"]);
  for (const [bookId, info] of byBook) {
    const joined = info.vals.join("、");
    if (singles.has(type) && info.vals.length > 1) {
      rejected.push({ bookId, title: info.title, value: joined });
      continue;
    }
    const probe = info.vals.join("\n");
    if (!canHold(type, probe)) rejected.push({ bookId, title: info.title, value: joined });
  }
  if (rejected.length) {
    return { ok: false, msg: `有 ${rejected.length} 本的值改不成${type}，先把它们清掉或者换个类型`, rejected };
  }

  const run = db.transaction(() => {
    for (const [bookId, info] of byBook) {
      db.prepare("DELETE FROM book_field_values WHERE book_id = ? AND field_id = ?").run(bookId, id);
      const ins = db.prepare(
        "INSERT INTO book_field_values (book_id, field_id, ord, val, num, day, ref) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const row of toValueRows(type, info.vals)) ins.run(bookId, id, row.ord, row.val, row.num, row.day, row.ref);
    }
    db.prepare("UPDATE fields SET type = ? WHERE id = ?").run(type, id);
  });
  run();
  return { ok: true, id };
}

/** 删字段只打标记，值一律留着，恢复之后原样回来 */
export function removeField(db: DB, id: number): FieldResult {
  const f = fieldById(db, id);
  if (!f) return { ok: false, msg: "字段不存在" };
  if (f.builtin !== 0) return { ok: false, msg: "内建字段不能删" };
  db.prepare("UPDATE fields SET deleted_at = ? WHERE id = ?").run(now(), id);
  return { ok: true, id };
}

export function restoreField(db: DB, id: number): FieldResult {
  const f = fieldById(db, id);
  if (!f) return { ok: false, msg: "字段不存在" };
  db.prepare("UPDATE fields SET deleted_at = NULL WHERE id = ?").run(id);
  return { ok: true, id };
}

/* ---- 选项 ---- */

export function addFieldOption(db: DB, fieldId: number, name: string): FieldResult {
  const f = fieldById(db, fieldId);
  if (!f) return { ok: false, msg: "字段不存在" };
  const n = String(name || "").trim();
  if (!n) return { ok: false, msg: "选项名不能为空" };
  if (optionsOf(db, fieldId).includes(n)) return { ok: false, msg: "已经有这个选项了" };
  const ord = ((db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM field_options WHERE field_id = ?").get(fieldId) as any).m as number) + 1;
  const info = db.prepare("INSERT INTO field_options (field_id, name, ord) VALUES (?, ?, ?)").run(fieldId, n, ord);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** 改选项名要把已经用了这个名字的值一起改掉，否则书上的标签会指着不存在的选项 */
export function renameFieldOption(db: DB, optionId: number, name: string): FieldResult {
  const o = db.prepare("SELECT * FROM field_options WHERE id = ?").get(optionId) as any;
  if (!o) return { ok: false, msg: "选项不存在" };
  const n = String(name || "").trim();
  if (!n) return { ok: false, msg: "选项名不能为空" };
  if (optionsOf(db, o.field_id).includes(n)) return { ok: false, msg: "已经有这个选项了" };
  const run = db.transaction(() => {
    db.prepare("UPDATE field_options SET name = ? WHERE id = ?").run(n, optionId);
    db.prepare("UPDATE book_field_values SET val = ? WHERE field_id = ? AND val = ?").run(n, o.field_id, o.name);
  });
  run();
  return { ok: true, id: optionId };
}

export function removeFieldOption(db: DB, optionId: number): FieldResult {
  const o = db.prepare("SELECT * FROM field_options WHERE id = ?").get(optionId) as any;
  if (!o) return { ok: false, msg: "选项不存在" };
  db.prepare("UPDATE field_options SET deleted_at = ? WHERE id = ?").run(now(), optionId);
  return { ok: true, id: optionId };
}
