import type { DB } from "../db";
import type { FieldDef } from "../../shared/types";
import { filterOpsFor, ruleHasValue, type BookFilterGroup } from "../../shared/filterRules";
import { listFields } from "./fieldService";

type Param = string | number;
type Condition = { sql: string; params: Param[] };
type FieldSource = { value: string; rows?: string; params?: Param[] };

const BOOK_COLUMNS: Record<string, string> = {
  title: "title",
  subtitle: "subtitle",
  originalTitle: "original_title",
  originalSubtitle: "original_subtitle",
  media: "media_type",
  index: "series_index",
  country: "country",
  publishDate: "publish_date",
  publishYear: "publish_year",
  read: "is_read",
  readStart: "read_start",
  readDate: "read_date",
  rating: "rating",
  ebook: "ebook_state",
  note: "note"
};

function sourceFor(field: FieldDef, alias: string): FieldSource | null {
  switch (field.key) {
    case "grade":
      return { value: "r.id", rows: `FROM reviews r WHERE r.book_id = ${alias}.id AND r.deleted_at IS NULL` };
    case "authors":
      return { value: "a.name", rows: `FROM book_authors ba JOIN authors a ON ba.author_id = a.id WHERE ba.book_id = ${alias}.id` };
    case "categories":
      return { value: "c.name", rows: `FROM book_categories bc JOIN categories c ON bc.category_id = c.id WHERE bc.book_id = ${alias}.id` };
    case "states":
      return { value: "bs.state", rows: `FROM book_states bs WHERE bs.book_id = ${alias}.id` };
    case "series":
      return { value: "COALESCE(NULLIF(ss.zh_name, ''), ss.name)", rows: `FROM series ss WHERE ss.id = ${alias}.series_id` };
  }
  if (field.builtin) {
    const column = Object.hasOwn(BOOK_COLUMNS, field.key) ? BOOK_COLUMNS[field.key] : "";
    if (!column) return null;
    return { value: field.key === "rating" ? `NULLIF(${alias}.rating, 0)` : `${alias}.${column}` };
  }
  if (field.type === "switch") {
    return {
      value: `COALESCE((SELECT fv.num FROM book_field_values fv WHERE fv.book_id = ${alias}.id AND fv.field_id = ? LIMIT 1), 0)`,
      params: [field.id]
    };
  }
  const column = field.type === "rating" || field.type === "number" ? "num" : field.type === "date" ? "day" : "val";
  return {
    value: "fv." + column,
    rows: `FROM book_field_values fv WHERE fv.book_id = ${alias}.id AND fv.field_id = ?`,
    params: [field.id]
  };
}

const COMPARISONS = { eq: "=", neq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

export function filterRulesWhere(db: DB, group: BookFilterGroup | undefined, alias: string): Condition {
  if (!Array.isArray(group?.rules) || !group.rules.length) return { sql: "", params: [] };
  const fields = listFields(db).filter((f) => f.builtin || f.filterable);
  const publish = fields.find((f) => f.key === "publishDate");
  if (publish) fields.push({ ...publish, key: "publishYear", type: "number" });
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const conditions: string[] = [];
  const params: Param[] = [];
  for (const rule of group.rules) {
    const field = byKey.get(rule?.key);
    if (!field || !filterOpsFor(field).includes(rule.op)) continue;
    const source = sourceFor(field, alias);
    if (!source) continue;
    const expr = source.value;
    const raw = typeof rule.value === "string" ? rule.value.trim() : "";
    const numeric = field.type === "number" || field.type === "rating" || field.type === "switch";
    const value = numeric ? Number(raw) : raw;
    let condition: string;
    if (!ruleHasValue(rule.op)) {
      condition = `(${expr} IS NOT NULL AND ${expr} <> '')`;
    } else {
      if (!raw || (numeric && !Number.isFinite(value))) continue;
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      if (rule.op === "contains" || rule.op === "notContains") {
        condition = `INSTR(LOWER(${expr}), LOWER(?)) > 0`;
      } else {
        const comparison = COMPARISONS[rule.op as keyof typeof COMPARISONS];
        condition = `${expr}${numeric ? "" : " COLLATE NOCASE"} ${comparison} ?`;
      }
    }
    const negative = rule.op === "empty" || rule.op === "neq" || rule.op === "notContains";
    const positive = source.rows ? `EXISTS (SELECT 1 ${source.rows} AND ${condition})` : `COALESCE(${condition}, 0)`;
    conditions.push(negative ? `NOT ${positive}` : positive);
    params.push(...(source.params || []));
    if (ruleHasValue(rule.op)) params.push(value);
  }
  return {
    sql: conditions.length ? "(" + conditions.join(group.join === "or" ? " OR " : " AND ") + ")" : "",
    params
  };
}
