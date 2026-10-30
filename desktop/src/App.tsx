import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import Sidebar, { EMPTY_FILTER, type FilterState } from "./components/Sidebar";
import GridView from "./components/GridView";
import TableView from "./components/TableView";
import DetailPanel from "./components/DetailPanel";
import ReviewLib from "./components/ReviewLib";
import CtxMenu, { type CtxItem } from "./components/CtxMenu";
import CategoryAdmin from "./components/CategoryAdmin";
import FieldAdmin from "./components/FieldAdmin";
import CoverBatch from "./components/CoverBatch";
import Confirm from "./components/Confirm";
import SortBar, { DEFAULT_SORTS, normalizeSorts } from "./components/SortBar";
import { ColumnPanel, AdvPanel } from "./components/ToolPanels";
import SeriesGrid from "./components/SeriesGrid";
import SeriesPanel from "./components/SeriesPanel";
import LibraryGate from "./components/LibraryGate";
import { copyText } from "./clip";
import { loadJson, loadStr, saveJson, saveStr } from "./store";
import { DEFAULT_HIDDEN, sortablesOf } from "./columns";
import { EMPTY_ADV } from "../shared/types";
import type {
  AdvFilter,
  AppInfo,
  BookPatch,
  BookRow,
  CatNode,
  Facets,
  FieldDef,
  ReviewRow,
  SeriesInfo,
  SortSpec
} from "../shared/types";

type View = "grid" | "table" | "review";

const PAGE = 120;
const STATES = ["实体", "私印", "预定中", "购物车", "无"];
const MEDIA = ["全部", "小说", "漫画", "系列小说", "系列漫画"];

const baseMedia = (m: string): string => (m === "系列小说" ? "小说" : m === "系列漫画" ? "漫画" : m);
const isSeries = (m: string): boolean => m.startsWith("系列");

type SerSort = "n" | "name" | "rating" | "updated";

interface CtxState {
  x: number;
  y: number;
  items: CtxItem[];
  book: BookRow;
}

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [dinfo, setDinfo] = useState<{ dir: string; covers: number; books: number; reviews: number } | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [rows, setRows] = useState<BookRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [q, setQ] = useState("");
  const [qNow, setQNow] = useState("");
  const [media, setMedia] = useState(() => loadStr("media", "全部"));
  const [view, setView] = useState<View>(() => (loadStr("view", "grid") as View) || "grid");
  const [sorts, setSorts] = useState<SortSpec[]>(() => normalizeSorts(loadJson<unknown>("sorts", DEFAULT_SORTS)));
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [adv, setAdv] = useState<AdvFilter>(() => ({ ...EMPTY_ADV, ...loadJson<Partial<AdvFilter>>("adv", {}) }));
  const [hidden, setHidden] = useState<string[]>(() => loadJson<string[]>("cols", DEFAULT_HIDDEN));
  const [theme, setTheme] = useState(() => loadStr("theme", "dark"));

  /* 多选：普通点击替换，Shift 或 Ctrl 点击叠加。详情面板认最后一本 */
  const [picked, setPicked] = useState<string[]>([]);
  const selected = picked.length ? picked[picked.length - 1] : null;
  const pickBook = (id: string, multi = false) => {
    if (!multi) {
      setPicked([id]);
      return;
    }
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [cats, setCats] = useState<CatNode[]>([]);
  /* 字段定义：表格列、详情行、排序键、筛选控件全从它来 */
  const [fields, setFields] = useState<FieldDef[]>([]);

  const [seriesList, setSeriesList] = useState<SeriesInfo[]>([]);
  const [serSort, setSerSort] = useState<SerSort>(() => (loadStr("serSort", "n") as SerSort) || "n");
  const [serPanel, setSerPanel] = useState<SeriesInfo | null>(null);

  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [cadmin, setCadmin] = useState(false);
  const [fadmin, setFadmin] = useState(false);
  const [cbatch, setCbatch] = useState(false);
  const [colOpen, setColOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);

  /* 浮层挂在触发按钮正下方，按钮在哪它就在哪 */
  const anchor = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPanelPos({ x: Math.min(r.left, window.innerWidth - 320), y: r.bottom + 6 });
  };
  const [ask, setAsk] = useState<{ text: string; onOk: () => void } | null>(null);
  const [toast, setToast] = useState("");
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [dirInfo, setDirInfo] = useState<{ dir: string; exist: boolean; files: number } | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);

  /* 任何写操作之后 counter 加一，列表、分面、顶栏计数全部重取 */
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);

  const say = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(""), 2200);
  };

  const seriesMode = isSeries(media);
  const sortables = useMemo(() => sortablesOf(fields), [fields]);

  useEffect(() => {
    api.info().then(setInfo);
  }, [tick]);

  useEffect(() => {
    api.dataInfo().then(setDinfo);
  }, [tick]);

  /* 任何写操作之后把书评清单也重拉一遍，删掉的那篇不该还留在左栏 */
  const reloadReviews = useCallback(() => api.reviews().then(setReviews), []);
  useEffect(() => {
    if (view === "review") reloadReviews();
  }, [view, tick, reloadReviews]);

  useEffect(() => {
    api.facets(baseMedia(media)).then(setFacets);
  }, [media, tick]);

  useEffect(() => {
    api.seriesList(baseMedia(media)).then(setSeriesList);
  }, [media, tick]);

  /* 表格里的分类多选要用整棵树，分类管理改完也要跟着变 */
  useEffect(() => {
    api.categoryTree().then(setCats);
  }, [tick]);

  useEffect(() => {
    api.listFields().then(setFields);
  }, [tick]);

  useEffect(() => {
    api.reviewDirInfo().then(setDirInfo);
  }, [tick]);

  /* 在书库的 reviews 文件夹里改了 md，主进程同步完会喊一声，界面这边重取 */
  useEffect(() => api.onReviewsChanged(() => setTick((t) => t + 1)), []);

  useEffect(() => {
    const t = setTimeout(() => setQNow(q.trim()), 220);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => saveStr("media", media), [media]);
  useEffect(() => saveStr("view", view), [view]);
  useEffect(() => saveJson("sorts", sorts), [sorts]);
  useEffect(() => saveJson("adv", adv), [adv]);
  useEffect(() => saveJson("cols", hidden), [hidden]);
  useEffect(() => saveStr("serSort", serSort), [serSort]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveStr("theme", theme);
  }, [theme]);

  const query = useCallback(
    (offset: number) => ({
      q: qNow,
      media: baseMedia(media),
      sorts,
      read: filter.read,
      noCover: filter.noCover,
      categories: filter.categories,
      states: filter.states,
      ebook: filter.ebook,
      decades: filter.decades,
      seriesId: filter.seriesId,
      adv,
      fvals: adv.fvals || [],
      offset,
      limit: PAGE
    }),
    [qNow, media, sorts, filter, adv]
  );

  /* 改一个字段就整表重取，滚动位置与已加载页数要留着重放，否则表格会跳回顶部 */
  const qKey = qNow + "|" + media + "|" + JSON.stringify(sorts) + "|" + JSON.stringify(filter) + "|" + JSON.stringify(adv);
  const lastKey = useRef("");
  const keep = useRef({ top: 0, count: 0 });

  useEffect(() => {
    if (seriesMode || view === "review") return;
    let alive = true;
    const sameQuery = lastKey.current === qKey;
    if (!sameQuery) {
      keep.current = { top: 0, count: 0 };
      lastKey.current = qKey;
    }
    setLoading(true);
    loadingRef.current = true;
    const want = Math.max(PAGE, sameQuery ? keep.current.count : 0);
    api
      .listBooks({ ...query(0), limit: want })
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setTotal(r.total);
        offsetRef.current = r.rows.length;
        keep.current.count = r.rows.length;
        const top = sameQuery ? keep.current.top : 0;
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = top;
        });
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        loadingRef.current = false;
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qKey, tick, seriesMode, view]);

  const loadMore = useCallback(() => {
    if (loadingRef.current) return;
    if (!total || offsetRef.current >= total) return;
    loadingRef.current = true;
    api.listBooks(query(offsetRef.current)).then((r) => {
      setRows((prev) => [...prev, ...r.rows]);
      offsetRef.current += r.rows.length;
      keep.current.count = offsetRef.current;
      loadingRef.current = false;
    });
  }, [query, total]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    keep.current.top = el.scrollTop;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  };

  useEffect(() => {
    if (view === "review") setPicked([]);
  }, [view]);

  /* 全局快捷键：/ 搜书，Ctrl 1/2/3 切视图，Ctrl Shift L 换主题，Esc 收面板 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        setColOpen(false);
        setAdvOpen(false);
        setMore(null);
        setSerPanel(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setTheme((x) => (x === "dark" ? "light" : "dark"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        const v = (["grid", "table", "review"] as View[])[Number(e.key) - 1];
        setMedia((m) => (isSeries(m) ? "全部" : m));
        setView(v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const patch = (p: Partial<FilterState>) => setFilter((f) => ({ ...f, ...p }));

  const switchMedia = (m: string) => {
    setMedia(m);
    /* 系列是按媒介分的，换媒介时旧系列的筛选留着只会筛出空列表 */
    setFilter((f) => ({ ...f, seriesId: null }));
    setSerPanel(null);
  };

  /* 系列模式里点任意一个单本视图按钮，就退回全部藏书 */
  const exitSeriesMode = () => {
    if (isSeries(media)) {
      setMedia("全部");
      setSerPanel(null);
    }
  };

  const openCtx = (e: React.MouseEvent, b: BookRow) => {
    e.preventDefault();
    e.stopPropagation();
    /* 右键落在已多选的条目上，菜单整批生效，不再只对一本 */
    if (picked.length > 1 && picked.includes(b.id)) {
      const items: CtxItem[] = [
        { key: "copyMany", label: "为这 " + picked.length + " 本创建副本" },
        { key: "s1", label: "", sep: true },
        { key: "delMany", label: "删除这 " + picked.length + " 本", danger: true }
      ];
      setCtx({ x: e.clientX, y: e.clientY, items, book: b });
      return;
    }
    const items: CtxItem[] = [
      { key: "open", label: "查看详情" },
      { key: "copy", label: "创建副本" },
      { key: "copyName", label: "复制书名和作者" },
      { key: "s1", label: "", sep: true },
      { key: "series", label: b.seriesName ? "按《" + b.seriesName + "》筛选" : "不属于任何系列", disabled: !b.seriesName },
      ...(b.categories.length ? [{ key: "cat", label: "按「" + b.categories[0] + "」筛选" }] : []),
      { key: "s2", label: "", sep: true },
      { key: "del", label: "删除书籍", danger: true }
    ];
    setCtx({ x: e.clientX, y: e.clientY, items, book: b });
  };

  const pickCtx = async (key: string) => {
    const b = ctx?.book;
    if (!b) return;
    if (key === "open") pickBook(b.id);
    if (key === "copyName") {
      await copyText(b.title + (b.authors.length ? "\t" + b.authors.join("、") : ""));
      say("已复制书名和作者");
    }
    if (key === "copy") {
      const nb = await api.copyBook(b.id);
      if (nb) {
        bump();
        say("已复制成「" + nb.title + "」");
      }
    }
    if (key === "copyMany") {
      const ids = picked.slice();
      const made = await api.copyBooks(ids);
      bump();
      setPicked(made.map((x) => x.id));
      say("已为 " + made.length + " 本创建副本");
    }
    if (key === "delMany") {
      const ids = picked.slice();
      setAsk({
        text: "删除选中的 " + ids.length + " 本书？书评会一起隐藏，源数据不动。",
        onOk: async () => {
          for (const id of ids) await api.deleteBook(id);
          setPicked([]);
          bump();
          say("已删除 " + ids.length + " 本");
        }
      });
    }
    if (key === "series" && b.seriesId) patch({ seriesId: b.seriesId });
    if (key === "cat" && b.categories.length) patch({ categories: [b.categories[0]] });
    if (key === "del") {
      setAsk({
        text: "删除《" + b.title + "》？书评会一起隐藏，源数据不动。",
        onOk: async () => {
          await api.deleteBook(b.id);
          setPicked((p) => p.filter((x) => x !== b.id));
          bump();
          say("已删除");
        }
      });
    }
  };

  const saveAndRefresh = () => bump();

  /* 表格里就地改字段走这条，落库后统一刷新，滚动位置由 keep 还原 */
  const patchBook = async (id: string, p: BookPatch) => {
    const nb = await api.updateBook(id, p);
    if (!nb) {
      say("保存失败");
      return;
    }
    bump();
  };

  /* 从系列弹层进书评库：没有总评就先建一篇空白的，再切过去 */
  const writeSeriesReview = async (s: SeriesInfo) => {
    const cur = await api.seriesReview(s.id);
    let id = cur?.id;
    if (!id) {
      const r = await api.createReview({ seriesId: s.id, name: s.label, grade: "normal", md: "" });
      if (!r.ok || !r.id) {
        say(r.msg || "新建系列书评失败");
        return;
      }
      id = r.id;
    }
    bump();
    exitSeriesMode();
    setView("review");
    setReviewFocus("series:" + id);
  };

  const onlySeries = (s: SeriesInfo) => {
    exitSeriesMode();
    setView("table");
    patch({ seriesId: s.id });
  };

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMore({ x: r.right - 210, y: r.bottom + 6 });
  };

  const moreItems: CtxItem[] = [
    { key: "revealLib", label: "打开书库文件夹" },
    { key: "revealRv", label: "打开书评文件夹" },
    { key: "s0", label: "", sep: true },
    { key: "backup", label: "备份数据库…" },
    { key: "backupDir", label: "打开备份目录" },
    { key: "restore", label: "从备份恢复…" },
    { key: "copyLib", label: "把整个书库另存一份…" },
    { key: "s1", label: "", sep: true },
    { key: "covers", label: "批量找封面…" },
    { key: "fields", label: "字段管理…" },
    { key: "cats", label: "分类管理…" },
    { key: "switch", label: "切换书库…" },
    { key: "theme", label: theme === "dark" ? "切换到浅色主题" : "切换到深色主题" },
    { key: "s2", label: "", sep: true },
    { key: "dbPath", label: "复制书库路径" },
    { key: "about", label: "快捷键与说明" }
  ];

  const pickMore = async (k: string) => {
    if (k === "revealLib") await api.revealLibrary();
    if (k === "revealRv") await api.openReviewDir();
    if (k === "backup") {
      const r = await api.backupDb();
      if (r?.ok) say("已备份到 " + (r.file || ""));
      else if (r) say(r.msg || "备份没成功");
    }
    if (k === "backupDir") await api.openBackupDir();
    if (k === "restore") {
      const r = await api.restoreDb();
      if (r && !r.ok) say(r.msg || "已取消");
    }
    if (k === "covers") setCbatch(true);
    if (k === "fields") setFadmin(true);
    if (k === "cats") setCadmin(true);
    if (k === "theme") setTheme((t) => (t === "dark" ? "light" : "dark"));
    if (k === "copyLib") {
      const r = await api.copyLibraryTo();
      if (r?.ok) say("已复制到 " + (r.dir || "") + "（" + (r.files || 0) + " 个文件）");
      else if (r) say(r.msg || "没复制成");
    }
    if (k === "switch") {
      const r = await api.chooseLibrary();
      if (r?.ok) window.location.reload();
      else if (r) say(r.msg || "已取消");
    }
    if (k === "dbPath") {
      await copyText(dinfo?.dir || info?.libraryRoot || "");
      say("已复制书库路径");
    }
    if (k === "about") {
      setAsk({
        text:
          "快捷键：/ 搜索，Ctrl+1 书架，Ctrl+2 表格，Ctrl+3 书评，Ctrl+Shift+L 换主题，Esc 收面板。\n" +
          "书库文件夹在 " +
          (dinfo?.dir || info?.libraryRoot || "") +
          "，书、封面、书评都在里面，安装包里不含任何书目。换机器整个拷走就行。\n" +
          "书评正文同时存在库里和 reviews 文件夹的 md 里，两边改哪边都行，改完几秒内自动对齐。",
        onOk: () => {}
      });
    }
  };

  const chips: { label: string; clear: () => void }[] = [];
  if (filter.read !== "all")
    chips.push({ label: { read: "已读", unread: "未读", rated: "有评分", all: "" }[filter.read], clear: () => patch({ read: "all" }) });
  if (filter.noCover !== null) chips.push({ label: filter.noCover ? "无封面" : "有封面", clear: () => patch({ noCover: null }) });
  for (const c of filter.categories) chips.push({ label: c, clear: () => patch({ categories: filter.categories.filter((x) => x !== c) }) });
  for (const s of filter.states) chips.push({ label: "实体书 " + s, clear: () => patch({ states: filter.states.filter((x) => x !== s) }) });
  for (const e of filter.ebook) chips.push({ label: "电子书 " + e, clear: () => patch({ ebook: filter.ebook.filter((x) => x !== e) }) });
  for (const d of filter.decades)
    chips.push({ label: d + " 年代", clear: () => patch({ decades: filter.decades.filter((x) => x !== d) }) });
  if (filter.seriesId) {
    const s = facets?.series.find((x) => x.id === filter.seriesId);
    chips.push({ label: "系列 " + (s?.name || ""), clear: () => patch({ seriesId: null }) });
  }
  if (adv.ratingMin != null) chips.push({ label: "评分 ≥ " + adv.ratingMin, clear: () => setAdv({ ...adv, ratingMin: null }) });
  if (adv.ratingMax != null) chips.push({ label: "评分 ≤ " + adv.ratingMax, clear: () => setAdv({ ...adv, ratingMax: null }) });
  if (adv.yearFrom != null) chips.push({ label: "出版 ≥ " + adv.yearFrom, clear: () => setAdv({ ...adv, yearFrom: null }) });
  if (adv.yearTo != null) chips.push({ label: "出版 ≤ " + adv.yearTo, clear: () => setAdv({ ...adv, yearTo: null }) });
  if (adv.hasReview !== null) chips.push({ label: adv.hasReview ? "有书评" : "没书评", clear: () => setAdv({ ...adv, hasReview: null }) });
  if (adv.note.trim()) chips.push({ label: "备注含 " + adv.note.trim(), clear: () => setAdv({ ...adv, note: "" }) });
  for (const fv of adv.fvals || []) {
    const fd = fields.find((f) => f.key === fv.key);
    const label = fd ? fd.label : fv.key;
    chips.push({
      label: label + " " + (fv.op === "between" ? (fv.a || "") + " 到 " + (fv.b || "") : fv.a || ""),
      clear: () => setAdv({ ...adv, fvals: (adv.fvals || []).filter((x) => x.key !== fv.key) })
    });
  }

  const advCount =
    [adv.ratingMin, adv.ratingMax, adv.yearFrom, adv.yearTo].filter((x) => x != null).length +
    (adv.hasReview === null ? 0 : 1) +
    (adv.note.trim() ? 1 : 0) +
    (adv.fvals || []).length;

  /* 系列模式下按名字搜、按册数或均分排，都在内存里做，系列总共一百多个 */
  const shownSeries = useMemo(() => {
    const k = qNow.toLowerCase();
    const out = seriesList.filter((s) => !k || s.label.toLowerCase().includes(k) || s.name.toLowerCase().includes(k));
    const cmp: Record<SerSort, (a: SeriesInfo, b: SeriesInfo) => number> = {
      n: (a, b) => b.n - a.n || a.label.localeCompare(b.label, "zh"),
      name: (a, b) => a.label.localeCompare(b.label, "zh"),
      rating: (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.n - a.n,
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    };
    return out.slice().sort(cmp[serSort]);
  }, [seriesList, qNow, serSort]);

  /* 还没选书库就先把整页换成选择页，主界面一律不铺 */
  if (!info) {
    return (
      <div className="gate">
        <div className="gate-in">
          <div className="gate-lead">正在打开…</div>
        </div>
      </div>
    );
  }
  if (!info.hasLibrary) return <LibraryGate onOpened={() => window.location.reload()} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          藏书库
          <small>
            {info
              ? info.bookCount + " 本 · 书评 " + info.reviewCount + " 篇" + (info.orphanCount ? " · 未匹配 " + info.orphanCount : "")
              : ""}
          </small>
        </div>
        <span className="spacer" />
        <input
          ref={searchRef}
          className="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={seriesMode ? "搜系列名（/ 聚焦）" : "搜书名、作者、原名（/ 聚焦）"}
        />
        <div className="seg">
          {MEDIA.map((m) => (
            <button key={m} className={media === m ? "on" : ""} onClick={() => switchMedia(m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="seg">
          {(
            [
              ["grid", "书架"],
              ["table", "表格"],
              ["review", "书评"]
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={view === k && !seriesMode ? "on" : ""}
              onClick={() => {
                exitSeriesMode();
                setView(k);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="mini" onClick={moreMenu} title="备份、恢复、主题">
          更多 ▾
        </button>
      </header>

      <div className="body">
        {view === "review" ? (
          <ReviewLib
            reviews={reviews}
            focusKey={reviewFocus}
            onFocusDone={() => setReviewFocus(null)}
            onGoto={(id) => {
              setView("grid");
              pickBook(id);
            }}
            onChanged={bump}
            onSay={say}
            dirInfo={dirInfo}
            onRefreshDir={() => api.reviewDirInfo().then(setDirInfo)}
          />
        ) : seriesMode ? (
          <div className="main">
            <div className="toolbar">
              <span>共 {shownSeries.length} 个系列</span>
              <select value={serSort} onChange={(e) => setSerSort(e.target.value as SerSort)}>
                <option value="n">按册数</option>
                <option value="name">按系列名</option>
                <option value="rating">按均分</option>
                <option value="updated">按最近改动</option>
              </select>
              <span className="dim">点一格看系列里的每本书，可写系列总评</span>
              <span className="spacer" />
              <button className="mini xs" onClick={() => switchMedia("全部")}>
                退出系列视图
              </button>
            </div>
            <div className="scroll">
              <SeriesGrid list={shownSeries} onOpen={setSerPanel} />
            </div>
          </div>
        ) : (
          <>
            <Sidebar facets={facets} filter={filter} onChange={patch} onManageCats={() => setCadmin(true)} />

            <div className="main">
              <div className="toolbar">
                <span>共 {total} 本</span>
                {picked.length > 1 ? (
                  <span className="chip on" onClick={() => setPicked([])} title="点掉取消多选">
                    已选 {picked.length} 本 ×
                  </span>
                ) : null}
                <SortBar sorts={sorts} onChange={setSorts} sortables={sortables} />
                {view === "table" ? (
                  <button
                    className={"mini xs" + (hidden.length ? " on" : "")}
                    onClick={(e) => {
                      anchor(e);
                      setColOpen(!colOpen);
                    }}
                    title="选择表格显示哪些列"
                  >
                    列设置{hidden.length ? "（隐藏 " + hidden.length + "）" : ""}
                  </button>
                ) : null}
                <button
                  className={"mini xs" + (advCount ? " on" : "")}
                  onClick={(e) => {
                    anchor(e);
                    setAdvOpen(!advOpen);
                  }}
                  title="评分、出版年、有没有书评"
                >
                  高级筛选{advCount ? "（" + advCount + "）" : ""}
                </button>
                <div className="chips">
                  {chips.map((c) => (
                    <span key={c.label} className="chip on" onClick={c.clear} title="点掉这个条件">
                      {c.label} ×
                    </span>
                  ))}
                </div>
                <span className="spacer" />
                {loading ? <span>读取中…</span> : null}
              </div>

              {colOpen ? (
                <ColumnPanel fields={fields} hidden={hidden} onChange={setHidden} onClose={() => setColOpen(false)} pos={panelPos} />
              ) : null}
              {advOpen ? (
                <AdvPanel adv={adv} fields={fields} onChange={setAdv} onClose={() => setAdvOpen(false)} pos={panelPos} />
              ) : null}

              <div className="scroll" ref={scrollRef} onScroll={onScroll}>
                {rows.length ? (
                  <>
                    {view === "grid" ? (
                      <GridView rows={rows} selected={picked} onSelect={pickBook} onCtx={openCtx} />
                    ) : (
                      <TableView
                        rows={rows}
                        selected={picked}
                        fields={fields}
                        cats={cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }))}
                        hidden={hidden}
                        onSelect={pickBook}
                        onCtx={openCtx}
                        onPatch={patchBook}
                      />
                    )}
                    <div className="loadmore">
                      {rows.length < total ? "往下滚继续加载（已显示 " + rows.length + "）" : "到底了"}
                    </div>
                  </>
                ) : info && info.bookCount === 0 ? (
                  <div className="emptyguide">
                    <div className="eg-t">这个书库还是空的</div>
                    <div className="eg-d">
                      书只存在这个书库文件夹里，程序本身不带任何书目。
                      之前整理好的库放在别处，用「切换书库」指过去；手里只有散的书评，把 md 导进来。
                    </div>
                    <div className="eg-acts">
                      <button className="mini" onClick={() => pickMore("switch")}>
                        切换书库…
                      </button>
                      <button
                        className="mini xs"
                        onClick={async () => {
                          const r = await api.importReviewFiles();
                          if (r) {
                            say("导入：" + (r.added + r.updated + r.orphan) + " 篇");
                            bump();
                          }
                        }}
                      >
                        导入书评 Markdown…
                      </button>
                      <button className="mini xs" onClick={() => api.revealLibrary()}>
                        打开书库文件夹
                      </button>
                    </div>
                    <div className="eg-path">{dinfo?.dir || info.libraryRoot}</div>
                  </div>
                ) : (
                  <div className="empty">{loading ? "读取中…" : "没有符合条件的书"}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <DetailPanel id={selected} fields={fields} onClose={() => setPicked([])} onSaved={saveAndRefresh} />

      {serPanel ? (
        <SeriesPanel
          series={serPanel}
          onClose={() => setSerPanel(null)}
          onOpenBook={(id) => {
            setSerPanel(null);
            pickBook(id);
          }}
          onWriteReview={writeSeriesReview}
          onFilterSeries={onlySeries}
        />
      ) : null}

      {ctx ? <CtxMenu x={ctx.x} y={ctx.y} items={ctx.items} onPick={pickCtx} onClose={() => setCtx(null)} /> : null}
      {more ? <CtxMenu x={more.x} y={more.y} items={moreItems} onPick={pickMore} onClose={() => setMore(null)} /> : null}

      {cadmin ? <CategoryAdmin onClose={() => setCadmin(false)} onChanged={bump} /> : null}
      {fadmin ? <FieldAdmin onClose={() => setFadmin(false)} onChanged={bump} /> : null}
      {cbatch ? <CoverBatch onClose={() => setCbatch(false)} onChanged={bump} /> : null}

      {ask ? (
        <Confirm
          text={ask.text}
          onOk={() => {
            ask.onOk();
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
