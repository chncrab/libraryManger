import type { DB } from "../db";
import type { CatNode, CatResult } from "../../shared/types";

/** 分类树：一次查全量，带每个分类被多少本在架书引用。前端自己按 parentId 分组 */
export function categoryTree(db: DB): CatNode[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.parent_id AS parentId, c.tier, c.ord,
              (SELECT COUNT(DISTINCT bc.book_id)
                 FROM book_categories bc JOIN books b ON b.id = bc.book_id AND b.deleted_at IS NULL
                WHERE bc.category_id IN (
                  WITH RECURSIVE sub(id) AS (
                    SELECT c.id
                    UNION ALL
                    SELECT cc.id FROM categories cc JOIN sub ON cc.parent_id = sub.id
                  ) SELECT id FROM sub
                )) AS n
         FROM categories c`
    )
    .all() as CatNode[];
  /* ord 全靠手工调，历史数据一堆并列，同 ord 时按名字兜底才稳定 */
  return rows.sort((a, b) => a.tier - b.tier || a.ord - b.ord || a.name.localeCompare(b.name, "zh"));
}

function depthOf(db: DB, id: number | null): number {
  if (!id) return 0;
  const r = db.prepare("SELECT tier FROM categories WHERE id = ?").get(id) as any;
  return r ? Number(r.tier) + 1 : 0;
}

function nameTaken(db: DB, name: string, selfId = 0): boolean {
  const r = db.prepare("SELECT id FROM categories WHERE name = ? AND id <> ?").get(name.trim(), selfId) as any;
  return !!r;
}

function nextOrd(db: DB, parentId: number | null): number {
  const r = db
    .prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM categories WHERE " + (parentId ? "parent_id = ?" : "parent_id IS NULL"))
    .get(...(parentId ? [parentId] : [])) as any;
  return Number(r.m) + 1;
}

export function createCategory(db: DB, name: string, parentId: number | null): CatResult {
  const n = name.trim();
  if (!n) return { ok: false, msg: "名字不能为空" };
  if (nameTaken(db, n)) return { ok: false, msg: "已经有叫「" + n + "」的分类" };
  if (parentId) {
    const p = db.prepare("SELECT tier FROM categories WHERE id = ?").get(parentId) as any;
    if (!p) return { ok: false, msg: "上级分类不存在" };
    /* 最多两级，第三级在左栏和参数里都放不下 */
    if (Number(p.tier) >= 1) return { ok: false, msg: "分类只做两级，小标签下面不能再挂" };
  }
  const id = Number(
    db
      .prepare("INSERT INTO categories (name, tier, ord, parent_id) VALUES (?, ?, ?, ?)")
      .run(n, depthOf(db, parentId), nextOrd(db, parentId), parentId || null).lastInsertRowid
  );
  return { ok: true, id };
}

export function renameCategory(db: DB, id: number, name: string): CatResult {
  const n = name.trim();
  if (!n) return { ok: false, msg: "名字不能为空" };
  if (nameTaken(db, n, id)) return { ok: false, msg: "已经有叫「" + n + "」的分类" };
  const info = db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(n, id);
  return info.changes ? { ok: true, id } : { ok: false, msg: "分类不存在" };
}

/** 收集一个分类的所有后代，防止把它挂到自己子孙下面成环 */
function descendants(db: DB, id: number): number[] {
  const out: number[] = [];
  const walk = (pid: number) => {
    const kids = db.prepare("SELECT id FROM categories WHERE parent_id = ?").all(pid) as any[];
    for (const k of kids) {
      out.push(k.id);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

export function setCategoryParent(db: DB, id: number, parentId: number | null): CatResult {
  if (parentId === id) return { ok: false, msg: "不能挂到自己下面" };
  if (parentId && descendants(db, id).includes(parentId)) return { ok: false, msg: "不能挂到自己的子分类下面" };
  if (parentId) {
    const p = db.prepare("SELECT tier FROM categories WHERE id = ?").get(parentId) as any;
    if (!p) return { ok: false, msg: "上级分类不存在" };
    if (Number(p.tier) >= 1) return { ok: false, msg: "分类只做两级" };
  }
  /* 换了父级，整枝的 tier 都要跟着变 */
  const tier = depthOf(db, parentId);
  const run = db.transaction(() => {
    db.prepare("UPDATE categories SET parent_id = ?, tier = ?, ord = ? WHERE id = ?").run(parentId || null, tier, nextOrd(db, parentId), id);
    for (const k of db.prepare("SELECT id FROM categories WHERE parent_id = ?").all(id) as any[]) {
      db.prepare("UPDATE categories SET tier = ? WHERE id = ?").run(tier + 1, k.id);
    }
  });
  run();
  return { ok: true, id };
}

export function removeCategory(db: DB, id: number): CatResult {
  const used = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM book_categories bc JOIN books b ON b.id = bc.book_id WHERE bc.category_id = ? AND b.deleted_at IS NULL"
      )
      .get(id) as any
  ).n as number;
  const kids = (db.prepare("SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?").get(id) as any).n as number;
  if (kids > 0) return { ok: false, msg: "下面还挂着 " + kids + " 个小标签，先挪走或删掉" };
  if (used > 0) return { ok: false, msg: "有 " + used + " 本书在用这个分类，先去书里摘掉" };
  db.prepare("DELETE FROM book_categories WHERE category_id = ?").run(id);
  const info = db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  return info.changes ? { ok: true, id } : { ok: false, msg: "分类不存在" };
}

/** dir 为 -1 上移、1 下移。先按当前显示顺序把同父兄弟压成连续序号，再和邻居换位，
    否则历史数据里一堆并列的 ord 会让换位后位置乱跳 */
export function moveCategory(db: DB, id: number, dir: -1 | 1): CatResult {
  const cur = db.prepare("SELECT id, parent_id, ord, tier FROM categories WHERE id = ?").get(id) as any;
  if (!cur) return { ok: false, msg: "分类不存在" };
  /* 老数据只带 tier 没有 parent_id，同一 tier 才算同类兄弟，否则三层分类的 ord 会互相插队。
     SQL 的 ORDER BY name 对中文按字节序，界面用 localeCompare 的拼音序，两边不一致会换错对象，
     所以统一用 JS 再排一次 */
  const sibs = (
    cur.parent_id
      ? db.prepare("SELECT id, ord, name, tier FROM categories WHERE parent_id = ?").all(cur.parent_id)
      : db.prepare("SELECT id, ord, name, tier FROM categories WHERE parent_id IS NULL AND tier = ?").all(cur.tier)
  ) as any[];
  sibs.sort((x, y) => x.ord - y.ord || String(x.name).localeCompare(String(y.name), "zh"));
  const i = sibs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return { ok: false, msg: "已经到头了" };
  const run = db.transaction(() => {
    const setOrd = db.prepare("UPDATE categories SET ord = ? WHERE id = ?");
    sibs.forEach((s, k) => setOrd.run(k + 1, s.id));
    setOrd.run(j + 1, sibs[i].id);
    setOrd.run(i + 1, sibs[j].id);
  });
  run();
  return { ok: true, id };
}
