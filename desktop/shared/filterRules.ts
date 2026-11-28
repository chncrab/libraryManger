import type { FieldDef } from "./types";

export const FILTER_OPS = {
  contains: "包含",
  notContains: "不包含",
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于或等于",
  lt: "小于",
  lte: "小于或等于",
  empty: "为空",
  notEmpty: "不为空"
} as const;

export type FilterOp = keyof typeof FILTER_OPS;

export interface BookFilterRule {
  key: string;
  op: FilterOp;
  value?: string;
}

export interface BookFilterGroup {
  join: "and" | "or";
  rules: BookFilterRule[];
}

export function ruleHasValue(op: FilterOp): boolean {
  return op !== "empty" && op !== "notEmpty";
}

export function filterOpsFor(field: Pick<FieldDef, "type" | "key">): FilterOp[] {
  if (field.key === "grade") return ["notEmpty", "empty"];
  if (field.type === "image") return ["notEmpty", "empty"];
  const comparison: FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
  const options: FilterOp[] = ["eq", "neq"];
  const text: FilterOp[] = ["contains", "notContains", ...options];
  if (field.type === "number" || field.type === "date" || field.type === "rating") return [...comparison, "empty", "notEmpty"];
  if (field.type === "switch") return options;
  if (field.type === "select" || field.key === "states" || field.key === "categories") return [...options, "empty", "notEmpty"];
  return [...text, "empty", "notEmpty"];
}

export function isActiveBookRule(rule: BookFilterRule): boolean {
  return !!rule.key && (!ruleHasValue(rule.op) || !!rule.value?.trim());
}
