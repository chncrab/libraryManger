import { useState } from "react";
import type { FacetItem, Facets } from "../../shared/types";

export interface FilterState {
  read: "all" | "read" | "unread" | "rated";
  noCover: boolean | null;
  categories: string[];
  states: string[];
  ebook: string[];
  decades: number[];
  seriesId: number | null;
}

export const EMPTY_FILTER: FilterState = {
  read: "all",
  noCover: null,
  categories: [],
  states: [],
  ebook: [],
  decades: [],
  seriesId: null
};

type MultiKey = "categories" | "states" | "ebook" | "decades";

interface Props {
  facets: Facets | null;
  filter: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  onManageCats: () => void;
}

export default function Sidebar({ facets, filter, onChange, onManageCats }: Props) {
  const [serOpen, setSerOpen] = useState(false);
  if (!facets) return <aside className="side" />;

  /* 和 demo 一样：普通点击是单选替换，再点一次取消；Shift 点击是叠加 */
  const pick = (key: MultiKey, value: string | number, ev: React.MouseEvent) => {
    const cur = filter[key] as (string | number)[];
    let next: (string | number)[];
    if (ev.shiftKey) next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
    else if (cur.length === 1 && cur[0] === value) next = [];
    else next = [value];
    onChange({ [key]: next } as Partial<FilterState>);
  };

  const n = (list: FacetItem[], name: string) => list.find((x) => x.name === name)?.n ?? 0;
  const readN = n(facets.read, "已读");
  const unreadN = n(facets.read, "未读");
  const noCoverN = n(facets.cover, "无封面");
  const hasCoverN = n(facets.cover, "有封面");

  /* 分类按两级摆：大分类在前，它下面的小标签紧跟其后缩进。
     分面给的数字已经是整棵子树去重后的量，点大分类得到的就是这个数 */
  const cats = facets.categories;
  const shown: { c: FacetItem; depth: number }[] = [];
  for (const r of cats.filter((c) => !c.parentId)) {
    shown.push({ c: r, depth: 0 });
    for (const k of cats.filter((c) => c.parentId === r.id)) shown.push({ c: k, depth: 1 });
  }
  for (const c of cats) if (!shown.some((x) => x.c.name === c.name)) shown.push({ c, depth: c.parentId ? 1 : 0 });

  const states = ["实体", "私印", "预定中", "购物车", "无"]
    .map((s) => ({ name: s, n: n(facets.states, s) }))
    .filter((x) => x.n > 0);
  const ebooks = facets.ebook.slice().sort((a, b) => (a.name === "有" ? -1 : b.name === "有" ? 1 : 0));

  return (
    <aside className="side">
      <div className="side-tip">普通点击单选　Shift 点击叠加　再点一次取消</div>

      <h4 className="h4row">
        分类
        <button className="mini xs" onClick={onManageCats} title="新增大分类与小标签">
          管理
        </button>
      </h4>
      {shown.map(({ c, depth }) => (
        <div
          key={c.name}
          className={
            "facet" +
            (depth ? " sub" : cats.some((x) => x.parentId === c.id) ? " grp" : "") +
            (filter.categories.includes(c.name) ? " on" : "")
          }
          onClick={(e) => pick("categories", c.name, e)}
        >
          {c.name}
          <span className="n">{c.n}</span>
        </div>
      ))}

      <h4>封面</h4>
      {[
        { k: null as boolean | null, label: "不限", c: "" },
        { k: true, label: "无封面", c: noCoverN },
        { k: false, label: "有封面", c: hasCoverN }
      ].map((o) => (
        <div
          key={String(o.k)}
          className={"facet" + (filter.noCover === o.k ? " on" : "")}
          onClick={() => onChange({ noCover: o.k })}
        >
          {o.label}
          <span className="n">{o.c}</span>
        </div>
      ))}

      <h4>实体书</h4>
      {states.map((s) => (
        <div
          key={s.name}
          className={"facet" + (filter.states.includes(s.name) ? " on" : "")}
          onClick={(e) => pick("states", s.name, e)}
        >
          {s.name}
          <span className="n">{s.n}</span>
        </div>
      ))}

      <h4>电子书</h4>
      {ebooks.map((e) => (
        <div
          key={e.name}
          className={"facet" + (filter.ebook.includes(e.name) ? " on" : "")}
          onClick={(ev) => pick("ebook", e.name, ev)}
        >
          {e.name}
          <span className="n">{e.n}</span>
        </div>
      ))}

      <h4>阅读状态</h4>
      {(
        [
          ["all", "全部", readN + unreadN],
          ["read", "已读", readN],
          ["unread", "未读", unreadN],
          ["rated", "有评分", n(facets.read, "有评分")]
        ] as const
      ).map(([k, label, c]) => (
        <div key={k} className={"facet" + (filter.read === k ? " on" : "")} onClick={() => onChange({ read: k })}>
          {label}
          <span className="n">{c || ""}</span>
        </div>
      ))}

      <h4>出版年代</h4>
      {facets.decades.map((d) => (
        <div
          key={d.name}
          className={"facet" + (filter.decades.includes(Number(d.name)) ? " on" : "")}
          onClick={(e) => pick("decades", Number(d.name), e)}
        >
          {d.name} 年代
          <span className="n">{d.n}</span>
        </div>
      ))}

      <h4>系列（按册数）</h4>
      {(serOpen ? facets.series : facets.series.slice(0, 24)).map((s) => (
        <div
          key={s.id}
          className={"facet ser" + (filter.seriesId === s.id ? " on" : "")}
          title={s.mediaType}
          onClick={() => onChange({ seriesId: filter.seriesId === s.id ? null : s.id })}
        >
          {s.name}
          <span className="n">{s.n}</span>
        </div>
      ))}
      {facets.series.length > 24 ? (
        <div className="facet more" onClick={() => setSerOpen(!serOpen)}>
          {serOpen ? "收起" : "展开全部（" + facets.series.length + "）"}
        </div>
      ) : null}
    </aside>
  );
}
