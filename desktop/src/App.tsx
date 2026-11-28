import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "./api";
import BookSearchInput from "./components/BookSearchInput";
import Sidebar, { EMPTY_FILTER, type FilterState } from "./components/Sidebar";
import GridView from "./components/GridView";
import TableView from "./components/TableView";
import DetailPanel from "./components/DetailPanel";
import ReviewLib from "./components/ReviewLib";
import ReadView from "./components/ReadView";
import CtxMenu, { type CtxItem } from "./components/CtxMenu";
import CategoryAdmin from "./components/CategoryAdmin";
import FieldAdmin from "./components/FieldAdmin";
import CoverBatch from "./components/CoverBatch";
import Confirm from "./components/Confirm";
import SortBar, { DEFAULT_SORTS, normalizeSorts } from "./components/SortBar";
import { ColumnPanel, AdvPanel } from "./components/ToolPanels";
import SeriesGrid from "./components/SeriesGrid";
import SeriesTable from "./components/SeriesTable";
import SeriesPanel from "./components/SeriesPanel";
import ViewTabs from "./components/ViewTabs";
import ViewEditor from "./components/ViewEditor";
import LibraryGate from "./components/LibraryGate";
import NewBookDialog from "./components/NewBookDialog";
import { copyText } from "./clip";
import { loadJson, loadStr, saveJson, saveStr } from "./store";
import { DEFAULT_HIDDEN, sortablesOf } from "./columns";
import { EMPTY_ADV, EMPTY_VIEW_FILTER, FIXED_VIEW_ID } from "../shared/types";
import { loadViews, saveViews } from "./viewBridge";
import { FILTER_OPS, isActiveBookRule } from "../shared/filterRules";
import type { NewBookInput } from "../shared/bookCreation";
import type {
  AdvFilter,
  AppInfo,
  BookPatch,
  BookQuery,
  BookRow,
  CatNode,
  Facets,
  FieldDef,
  LibraryView,
  ReviewRow,
  SeriesInfo,
  SeriesQuery,
  SortSpec
} from "../shared/types";

type Page = "library" | "review" | "read";

const PAGE = 120;

/** 「全部」不存配置，界面按固定规则造一份 */
const ALL_VIEW: LibraryView = {
  id: FIXED_VIEW_ID,
  name: "全部",
  unit: "book",
  layout: "table",
  filter: { ...EMPTY_VIEW_FILTER },
  ord: -1
};

interface TempState {
  q: string;
  qNow: string;
  filter: FilterState;
  adv: AdvFilter;
}

const makeTemp = (): TempState => ({
  q: "",
  qNow: "",
  filter: { ...EMPTY_FILTER },
  adv: { ...EMPTY_ADV, fvals: [] }
});

const EMPTY_TEMP = makeTemp();

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
  const [scopedFacets, setScopedFacets] = useState<{ media: string; value: Facets } | null>(null);
  const [rows, setRows] = useState<BookRow[]>([]);
  const [total, setTotal] = useState(0);
  /* rows 属于哪个查询 key。key 一变就先不画旧数据，等新请求回来再换 */
  const [rowsKey, setRowsKey] = useState("");
  const [loading, setLoading] = useState(false);

  const [page, setPage] = useState<Page>("library");
  const [reviewQuery, setReviewQuery] = useState("");
  const [views, setViews] = useState<LibraryView[]>([]);
  const [viewsLoaded, setViewsLoaded] = useState(false);
  const [viewId, setViewId] = useState(FIXED_VIEW_ID);
  const [addBookOpen, setAddBookOpen] = useState(false);
  const [firstIds, setFirstIds] = useState<string[]>([]);

  const [temps, setTemps] = useState<Record<string, TempState>>({});

  const [sorts, setSorts] = useState<SortSpec[]>(() => normalizeSorts(loadJson<unknown>("sorts", DEFAULT_SORTS)));
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

  const [seriesRows, setSeriesRows] = useState<SeriesInfo[]>([]);
  const [seriesRowsKey, setSeriesRowsKey] = useState("");
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [serSort, setSerSort] = useState<SerSort>(() => (loadStr("serSort", "n") as SerSort) || "n");
  const [serPanel, setSerPanel] = useState<SeriesInfo | null>(null);

  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [vctx, setVctx] = useState<{ x: number; y: number; view: LibraryView } | null>(null);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [cadmin, setCadmin] = useState(false);
  const [fadmin, setFadmin] = useState(false);
  const [cbatch, setCbatch] = useState(false);
  const [colOpen, setColOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);

  const [editor, setEditor] = useState<{ view: LibraryView | null } | null>(null);
  const [delView, setDelView] = useState<LibraryView | null>(null);

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
  const bookSeq = useRef(0);
  const seriesSeq = useRef(0);
  const lastBookKey = useRef("");
  const keep = useRef({ top: 0, count: 0 });

  const viewsRef = useRef<LibraryView[]>([]);
  const viewIdRef = useRef(viewId);
  useEffect(() => {
    viewIdRef.current = viewId;
  }, [viewId]);

  const say = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(""), 2200);
  };

  const putViews = useCallback((list: LibraryView[]) => {
    viewsRef.current = list;
    setViews(list);
  }, []);

  const currentView = useMemo(() => {
    if (viewId === FIXED_VIEW_ID) return ALL_VIEW;
    return views.find((v) => v.id === viewId) || ALL_VIEW;
  }, [views, viewId]);
  const unit = currentView.unit;
  const layout = currentView.layout;
  const viewMedia = currentView.filter.media;

  const temp = temps[viewId] ?? EMPTY_TEMP;
  const facetMedia = viewMedia || temp.filter.media;
  const facets = scopedFacets?.media === facetMedia ? scopedFacets.value : null;
  const sortables = useMemo(() => sortablesOf(fields), [fields]);

  useEffect(() => {
    api.info().then(setInfo);
  }, [tick]);

  useEffect(() => {
    if (!info?.hasLibrary) return;
    api.dataInfo().then(setDinfo);
  }, [tick, info?.hasLibrary]);

  /* 任何写操作之后把书评清单也重拉一遍，删掉的那篇不该还留在左栏 */
  const reloadReviews = useCallback(() => api.reviews().then(setReviews), []);
  useEffect(() => {
    if (!info?.hasLibrary || page !== "review") return;
    reloadReviews();
  }, [page, tick, reloadReviews, info?.hasLibrary]);

  useEffect(() => {
    if (!info?.hasLibrary || page !== "library") return;
    let alive = true;
    api.facets(facetMedia).then((value) => {
      if (alive) setScopedFacets({ media: facetMedia, value });
    }).catch(() => {
      if (alive) setScopedFacets(null);
    });
    return () => { alive = false; };
  }, [facetMedia, tick, page, info?.hasLibrary]);

  /* 表格里的分类多选要用整棵树，分类管理改完也要跟着变。
     新建视图的编辑器在书评页也能打开，所以这里只按库门禁，不按页面 */
  useEffect(() => {
    if (!info?.hasLibrary) return;
    api.categoryTree().then(setCats);
  }, [tick, info?.hasLibrary]);

  useEffect(() => {
    if (!info?.hasLibrary || page !== "library") return;
    api.listFields().then(setFields);
  }, [tick, page, info?.hasLibrary]);

  useEffect(() => {
    if (!info?.hasLibrary || page !== "review") return;
    api.reviewDirInfo().then(setDirInfo);
  }, [tick, page, info?.hasLibrary]);

  /* 在书库的 reviews 文件夹里改了 md，主进程同步完会喊一声，界面这边重取 */
  useEffect(() => api.onReviewsChanged(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let active = true;
    const off = api.onCategoryRenamed((before, after) => {
      setTemps((prev) => Object.fromEntries(Object.entries(prev).map(([id, state]) => [
        id,
        {
          ...state,
          filter: {
            ...state.filter,
            categories: state.filter.categories.map((name) => name === before ? after : name)
          },
          adv: state.adv.group ? {
            ...state.adv,
            group: {
              ...state.adv.group,
              rules: state.adv.group.rules.map((rule) =>
                rule.key === "categories" && rule.value === before ? { ...rule, value: after } : rule)
            }
          } : state.adv
        }
      ])));
      void loadViews().then((r) => { if (active) putViews(r.views); });
      setTick((t) => t + 1);
    });
    return () => { active = false; off(); };
  }, [info?.libraryRoot, putViews]);

  /* 视图配置按库读一次。空列表就是用户删空了，不补预设 */
  useEffect(() => {
    if (!info?.hasLibrary || !info.libraryRoot) return;
    let alive = true;
    loadViews()
      .then((r) => {
        if (!alive) return;
        putViews(r.views);
        if (r.msg) say(r.msg);
      })
      .finally(() => {
        if (alive) setViewsLoaded(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.hasLibrary, info?.libraryRoot, putViews]);

  /* 当前标签在配置里没了（坏数据或别处删掉）就回「全部」 */
  useEffect(() => {
    if (!viewsLoaded) return;
    if (viewId !== FIXED_VIEW_ID && !views.some((v) => v.id === viewId)) setViewId(FIXED_VIEW_ID);
  }, [viewsLoaded, views, viewId]);

  /* 输入框停顿一下再查，避免一个字一个请求 */
  useEffect(() => {
    const id = viewId;
    const t = window.setTimeout(() => {
      setTemps((prev) => {
        const cur = prev[id];
        if (!cur) return prev;
        const qNow = cur.q.trim();
        if (cur.qNow === qNow) return prev;
        return { ...prev, [id]: { ...cur, qNow } };
      });
    }, 220);
    return () => window.clearTimeout(t);
  }, [temp.q, viewId]);

  useEffect(() => saveJson("sorts", sorts), [sorts]);
  useEffect(() => saveJson("cols", hidden), [hidden]);
  useEffect(() => saveStr("serSort", serSort), [serSort]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveStr("theme", theme);
    void api.setWindowTheme(theme === "light" ? "light" : "dark").catch(() => undefined);
  }, [theme]);

  const setTemp = (p: Partial<TempState>) => {
    const id = viewId;
    setTemps((prev) => ({ ...prev, [id]: { ...(prev[id] || makeTemp()), ...p } }));
  };

  const patch = (p: Partial<FilterState>) => {
    const id = viewId;
    setTemps((prev) => {
      const cur = prev[id] || makeTemp();
      const filter = { ...cur.filter, ...p };
      if (filter.media !== cur.filter.media) filter.seriesId = null;
      return { ...prev, [id]: { ...cur, filter } };
    });
  };

  const setAdv = (a: AdvFilter) => setTemp({ adv: a });

  const clearTemp = () => setTemps((prev) => ({ ...prev, [viewId]: makeTemp() }));

  const presetKey = JSON.stringify(currentView.filter);
  const tempKey = JSON.stringify({ q: temp.qNow, filter: temp.filter, adv: temp.adv });
  const bookKey = page + "|" + viewId + "|" + unit + "|" + presetKey + "|" + tempKey + "|" + JSON.stringify(sorts) + "|" + firstIds.join(",");
  const seriesKey = page + "|" + viewId + "|" + unit + "|" + presetKey + "|" + tempKey;

  /* 旧 key 的 rows/total 一律不画，避免切视图后的那一帧还挂着上一批书 */
  const shownRows = rowsKey === bookKey ? rows : [];
  const shownTotal = rowsKey === bookKey ? total : 0;

  const buildBookQuery = (offset: number, limit: number): BookQuery => {
    const preset = currentView.filter;
    return {
      q: temp.qNow || undefined,
      presetQ: preset.keywords.join(" ").trim() || undefined,
      media: preset.media || temp.filter.media || undefined,
      presetRead: preset.read !== "all" ? preset.read : undefined,
      presetCategories: preset.categories.length ? preset.categories : undefined,
      read: temp.filter.read !== "all" ? temp.filter.read : undefined,
      noCover: temp.filter.noCover,
      categories: temp.filter.categories.length ? temp.filter.categories : undefined,
      states: temp.filter.states.length ? temp.filter.states : undefined,
      ebook: temp.filter.ebook.length ? temp.filter.ebook : undefined,
      decades: temp.filter.decades.length ? temp.filter.decades : undefined,
      seriesId: temp.filter.seriesId,
      sorts,
      firstIds,
      adv: temp.adv,
      fvals: temp.adv.fvals || [],
      offset: offset || undefined,
      limit
    };
  };

  const buildSeriesQuery = (): SeriesQuery => {
    const preset = currentView.filter;
    return {
      q: temp.qNow || undefined,
      presetQ: preset.keywords.join(" ").trim() || undefined,
      media: preset.media || temp.filter.media || undefined,
      presetCategories: preset.categories.length ? preset.categories : undefined,
      categories: temp.filter.categories.length ? temp.filter.categories : undefined,
      presetRead: preset.read !== "all" ? preset.read : undefined,
      read: temp.filter.read !== "all" ? temp.filter.read : undefined,
      states: temp.filter.states.length ? temp.filter.states : undefined,
      ebook: temp.filter.ebook.length ? temp.filter.ebook : undefined,
      decades: temp.filter.decades.length ? temp.filter.decades : undefined,
      adv: temp.adv,
      fvals: temp.adv.fvals || []
    };
  };

  /* 单册分页。请求带序号，切标签或改条件后旧结果直接丢掉 */
  useEffect(() => {
    if (!info?.hasLibrary || page !== "library" || unit !== "book") {
      /* 离开单册模式时把序号推一下，还在飞的分页请求回来也不会再写 rows */
      bookSeq.current++;
      loadingRef.current = false;
      return;
    }
    let alive = true;
    let raf = 0;
    const seq = ++bookSeq.current;
    const sameQuery = lastBookKey.current === bookKey;
    if (!sameQuery) {
      keep.current = { top: 0, count: 0 };
      lastBookKey.current = bookKey;
      /* 换标签或换条件时先把旧结果撤掉，免得新请求回来前还挂着上一批书 */
      setRows([]);
      setTotal(0);
      offsetRef.current = 0;
    }
    setLoading(true);
    loadingRef.current = true;
    const want = Math.max(PAGE, sameQuery ? keep.current.count : 0);
    api
      .listBooks(buildBookQuery(0, want))
      .then((r) => {
        if (!alive || seq !== bookSeq.current) return;
        setRowsKey(bookKey);
        setRows(r.rows);
        setTotal(r.total);
        offsetRef.current = r.rows.length;
        keep.current.count = r.rows.length;
        const top = sameQuery ? keep.current.top : 0;
        raf = requestAnimationFrame(() => {
          if (seq !== bookSeq.current) return;
          if (scrollRef.current) scrollRef.current.scrollTop = top;
        });
      })
      .catch(() => {
        if (!alive || seq !== bookSeq.current) return;
        setRowsKey(bookKey);
        setRows([]);
        setTotal(0);
      })
      .finally(() => {
        if (!alive || seq !== bookSeq.current) return;
        setLoading(false);
        loadingRef.current = false;
      });
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey, tick, info?.hasLibrary]);

  /* 系列不分页，一次取回后在内存里排 */
  useEffect(() => {
    if (!info?.hasLibrary || page !== "library" || unit !== "series") {
      /* 离开系列模式同样让旧请求失效 */
      seriesSeq.current++;
      setSeriesLoading(false);
      return;
    }
    let alive = true;
    const seq = ++seriesSeq.current;
    setSeriesLoading(true);
    api
      .seriesList(buildSeriesQuery())
      .then((list) => {
        if (!alive || seq !== seriesSeq.current) return;
        setSeriesRowsKey(seriesKey);
        setSeriesRows(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!alive || seq !== seriesSeq.current) return;
        setSeriesRowsKey(seriesKey);
        setSeriesRows([]);
      })
      .finally(() => {
        if (!alive || seq !== seriesSeq.current) return;
        setSeriesLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, tick, info?.hasLibrary]);

  const loadMore = useCallback(() => {
    if (page !== "library" || unit !== "book" || loadingRef.current) return;
    /* 新 key 的查询还没落地时不要拿旧偏移去续页 */
    if (lastBookKey.current !== bookKey) return;
    if (!total || offsetRef.current >= total) return;
    loadingRef.current = true;
    const seq = bookSeq.current;
    api
      .listBooks(buildBookQuery(offsetRef.current, PAGE))
      .then((r) => {
        if (seq !== bookSeq.current || lastBookKey.current !== bookKey) return;
        setRows((prev) => [...prev, ...r.rows]);
        offsetRef.current += r.rows.length;
        keep.current.count = offsetRef.current;
      })
      .catch(() => {})
      .finally(() => {
        if (seq === bookSeq.current) loadingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, unit, total, temp, currentView, sorts]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    keep.current.top = el.scrollTop;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
  };

  /* 书评、阅读页不留书库详情，回到书库时保留点开的那本 */
  useEffect(() => {
    if (page !== "library") setPicked([]);
    if (page !== "review") setReviewQuery("");
  }, [page]);

  const selectView = (id: string) => {
    setPage("library");
    setViewId(id);
    setFirstIds([]);
    setSerPanel(null);
    setColOpen(false);
    setAdvOpen(false);
  };

  /* 全局快捷键：/ 聚焦当前搜索，Ctrl 1 第一个自定义书架，Ctrl 2 全部，Ctrl 3 书评，Ctrl 4 阅读 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "/" && !typing && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
        return;
      }
      if (e.key === "Escape") {
        setColOpen(false);
        setAdvOpen(false);
        setMore(null);
        setVctx(null);
        setSerPanel(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setTheme((x) => (x === "dark" ? "light" : "dark"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (e.key === "1") {
          e.preventDefault();
          const first = views.find((v) => v.layout === "shelf");
          selectView(first ? first.id : FIXED_VIEW_ID);
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          selectView(FIXED_VIEW_ID);
          return;
        }
        if (e.key === "3") {
          e.preventDefault();
          setPage("review");
          return;
        }
        if (e.key === "4") {
          e.preventDefault();
          setPage("read");
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, views]);

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

  const addBooks = async (input: NewBookInput) => {
    const result = await api.createBooks(input);
    if (!result.ok || !result.ids?.length) return result;
    if (unit !== "book" || layout !== "table" || tempDirty || viewMedia ||
        currentView.filter.categories.length || currentView.filter.keywords.length || currentView.filter.read !== "all") {
      selectView(FIXED_VIEW_ID);
      setTemps((prev) => ({ ...prev, [FIXED_VIEW_ID]: makeTemp() }));
    }
    setPicked([]);
    setFirstIds(result.ids);
    setAddBookOpen(false);
    say("已新增 " + result.ids.length + " 本书");
    bump();
    return result;
  };

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
    setSerPanel(null);
    setPage("review");
    setReviewFocus("series:" + id);
  };

  /* 从系列详情进「全部」，只保留该系列的临时条件 */
  const onlySeries = (s: SeriesInfo) => {
    setPage("library");
    setViewId(FIXED_VIEW_ID);
    setTemps((prev) => ({
      ...prev,
      [FIXED_VIEW_ID]: {
        q: "",
        qNow: "",
        filter: { ...EMPTY_FILTER, seriesId: s.id },
        adv: { ...EMPTY_ADV, fvals: [] }
      }
    }));
    setSerPanel(null);
    setPicked([]);
    setColOpen(false);
    setAdvOpen(false);
  };

  /* 视图配置整排保存。串行排队，连续操作不会拿旧数组覆盖新数组 */
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const persistViews = (
    op: (cur: LibraryView[]) => LibraryView[] | null,
    onSaved?: (saved: LibraryView[]) => void
  ): Promise<{ ok: boolean; msg?: string }> => {
    const task = saveChain.current.then(async () => {
      const next = op(viewsRef.current);
      if (!next) return { ok: true };
      const r = await saveViews(next, info?.libraryRoot || undefined);
      if (!r.ok) return { ok: false, msg: r.msg || "视图配置没有保存成功" };
      const saved = r.views !== undefined ? r.views : next.map((v, i) => ({ ...v, ord: i }));
      putViews(saved);
      onSaved?.(saved);
      return { ok: true };
    });
    saveChain.current = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  };

  const saveView = async (v: LibraryView): Promise<string | null> => {
    const name = v.name.trim();
    if (!name) return "名称不能为空";
    const clean: LibraryView = { ...v, name };
    const isNew = !viewsRef.current.some((x) => x.id === clean.id);
    const res = await persistViews((cur) => {
      if (cur.some((x) => x.id === clean.id)) return cur.map((x) => (x.id === clean.id ? clean : x));
      return [...cur, { ...clean, ord: cur.length }];
    });
    if (!res.ok) return res.msg || "保存失败";
    if (isNew) {
      /* 从书评或阅读页新建也要落到书库，并直接打开这个新标签 */
      setPage("library");
      setViewId(clean.id);
    }
    setSerPanel(null);
    setEditor(null);
    return null;
  };

  const confirmDeleteView = () => {
    const target = delView;
    setDelView(null);
    if (!target) return;
    /* 右邻下标在真正轮到这条队列任务时才算，避免连续操作时偏一位 */
    let removedAt = -1;
    void persistViews(
      (cur) => {
        removedAt = cur.findIndex((x) => x.id === target.id);
        if (removedAt < 0) return null;
        return cur.filter((x) => x.id !== target.id);
      },
      (saved) => {
        /* 保存成功后才改选中：优先右邻，右侧空了选左侧，都空回「全部」 */
        if (viewIdRef.current === target.id) {
          const nb = removedAt >= 0 ? saved[removedAt] || saved[removedAt - 1] : saved[0];
          setViewId(nb ? nb.id : FIXED_VIEW_ID);
        }
        setTemps((prev) => {
          if (!(target.id in prev)) return prev;
          const n = { ...prev };
          delete n[target.id];
          return n;
        });
      }
    ).then((r) => {
      if (!r.ok) say(r.msg || "删除视图没有保存成功");
    });
  };

  const moveView = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    void persistViews((cur) => {
      const from = cur.findIndex((x) => x.id === fromId);
      const to = cur.findIndex((x) => x.id === toId);
      if (from < 0 || to < 0) return null;
      const next = cur.slice();
      const [it] = next.splice(from, 1);
      let at = next.findIndex((x) => x.id === toId);
      if (at < 0) at = next.length;
      else if (from < to) at += 1;
      next.splice(at, 0, it);
      return next;
    }).then((r) => {
      if (!r.ok) say(r.msg || "调整视图顺序没有保存成功");
    });
  };

  const editCurrentView = () => {
    if (currentView.id === FIXED_VIEW_ID) return;
    setEditor({ view: currentView });
  };

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMore({ x: r.right - 210, y: r.bottom + 6 });
  };

  const moreItems: CtxItem[] = [
    { key: "revealLib", label: "打开书库文件夹" },
    { key: "revealRv", label: "打开书评文件夹" },
    { key: "s0", label: "", sep: true },
    { key: "backup", label: "备份索引数据库…" },
    { key: "backupDir", label: "打开备份目录" },
    { key: "restore", label: "从索引备份恢复…" },
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
          "快捷键：/ 搜索，Ctrl+1 打开第一个书架视图，Ctrl+2 打开全部，Ctrl+3 书评，Ctrl+4 阅读，Ctrl+Shift+L 换主题，Esc 收面板。\n" +
          "书库文件夹在 " +
          (dinfo?.dir || info?.libraryRoot || "") +
          "，书、封面、书评都在里面，安装包里不含任何书目。换机器整个拷走就行。\n" +
          "书评正文只存在 reviews 文件夹的 Markdown 文件里，数据库只保留索引和元数据。改完 md 点「重建书评索引」或等外部监听同步。",
        onOk: () => {}
      });
    }
  };

  const readLabel = (r: string) => ({ read: "已读", unread: "未读", rated: "有评分", all: "" } as Record<string, string>)[r] || "";

  type Chip = { key: string; label: string; clear: () => void; preset?: boolean };
  const chips: Chip[] = [];
  const preset = currentView.filter;
  if (preset.media) chips.push({ key: "p-media", label: "预设媒介 " + preset.media, preset: true, clear: editCurrentView });
  for (const kw of preset.keywords)
    chips.push({ key: "p-kw-" + kw, label: "预设关键词 " + kw, preset: true, clear: editCurrentView });
  for (const c of preset.categories) chips.push({ key: "p-cat-" + c, label: "预设分类 " + c, preset: true, clear: editCurrentView });
  if (preset.read !== "all") chips.push({ key: "p-read", label: "预设 " + readLabel(preset.read), preset: true, clear: editCurrentView });

  if (!preset.media && temp.filter.media)
    chips.push({ key: "media", label: "媒介 " + temp.filter.media, clear: () => patch({ media: "" }) });
  if (temp.filter.read !== "all")
    chips.push({ key: "read", label: readLabel(temp.filter.read), clear: () => patch({ read: "all" }) });
  if (temp.filter.noCover !== null)
    chips.push({ key: "cover", label: temp.filter.noCover ? "无封面" : "有封面", clear: () => patch({ noCover: null }) });
  for (const c of temp.filter.categories) chips.push({ key: "cat-" + c, label: c, clear: () => patch({ categories: temp.filter.categories.filter((x) => x !== c) }) });
  for (const s of temp.filter.states)
    chips.push({ key: "st-" + s, label: "实体书 " + s, clear: () => patch({ states: temp.filter.states.filter((x) => x !== s) }) });
  for (const e of temp.filter.ebook)
    chips.push({ key: "eb-" + e, label: "电子书 " + e, clear: () => patch({ ebook: temp.filter.ebook.filter((x) => x !== e) }) });
  for (const d of temp.filter.decades)
    chips.push({ key: "dec-" + d, label: d + " 年代", clear: () => patch({ decades: temp.filter.decades.filter((x) => x !== d) }) });
  if (temp.filter.seriesId) {
    const s = facets?.series.find((x) => x.id === temp.filter.seriesId) || seriesRows.find((x) => x.id === temp.filter.seriesId);
    chips.push({ key: "series", label: "系列 " + (s?.name || ""), clear: () => patch({ seriesId: null }) });
  }
  if (temp.adv.ratingMin != null)
    chips.push({ key: "rmin", label: "评分 ≥ " + temp.adv.ratingMin, clear: () => setAdv({ ...temp.adv, ratingMin: null }) });
  if (temp.adv.ratingMax != null)
    chips.push({ key: "rmax", label: "评分 ≤ " + temp.adv.ratingMax, clear: () => setAdv({ ...temp.adv, ratingMax: null }) });
  if (temp.adv.yearFrom != null)
    chips.push({ key: "yfrom", label: "出版 ≥ " + temp.adv.yearFrom, clear: () => setAdv({ ...temp.adv, yearFrom: null }) });
  if (temp.adv.yearTo != null)
    chips.push({ key: "yto", label: "出版 ≤ " + temp.adv.yearTo, clear: () => setAdv({ ...temp.adv, yearTo: null }) });
  if (temp.adv.hasReview !== null)
    chips.push({ key: "hasrv", label: temp.adv.hasReview ? "有书评" : "没书评", clear: () => setAdv({ ...temp.adv, hasReview: null }) });
  if (temp.adv.note.trim())
    chips.push({ key: "note", label: "备注含 " + temp.adv.note.trim(), clear: () => setAdv({ ...temp.adv, note: "" }) });
  for (const fv of temp.adv.fvals || []) {
    const fd = fields.find((f) => f.key === fv.key);
    chips.push({
      key: "fv-" + fv.key,
      label: (fd ? fd.label : fv.key) + " " + (fv.op === "between" ? (fv.a || "") + " 到 " + (fv.b || "") : fv.a || ""),
      clear: () => setAdv({ ...temp.adv, fvals: (temp.adv.fvals || []).filter((x) => x.key !== fv.key) })
    });
  }

  for (const [index, rule] of (temp.adv.group?.rules || []).entries()) {
    if (!isActiveBookRule(rule)) continue;
    chips.push({
      key: "rule-" + index,
      label: [fields.find((f) => f.key === rule.key)?.label || "出版年", FILTER_OPS[rule.op], rule.value].filter(Boolean).join(" "),
      clear: () => {
        const group = temp.adv.group;
        if (group) setAdv({ ...temp.adv, group: { ...group, rules: group.rules.filter((_, i) => i !== index) } });
      }
    });
  }
  const advCount =
    [temp.adv.ratingMin, temp.adv.ratingMax, temp.adv.yearFrom, temp.adv.yearTo].filter((x) => x != null).length +
    (temp.adv.hasReview === null ? 0 : 1) +
    (temp.adv.note.trim() ? 1 : 0) +
    (temp.adv.fvals || []).length +
    (temp.adv.group?.rules || []).filter(isActiveBookRule).length;

  const tempDirty =
    !!temp.q.trim() ||
    temp.filter.media !== "" ||
    temp.filter.read !== "all" ||
    temp.filter.noCover !== null ||
    temp.filter.categories.length > 0 ||
    temp.filter.states.length > 0 ||
    temp.filter.ebook.length > 0 ||
    temp.filter.decades.length > 0 ||
    temp.filter.seriesId !== null ||
    advCount > 0;

  /* 系列在内存里按册数、名字、均分或最近改动排 */
  const shownSeries = useMemo(() => {
    if (seriesRowsKey !== seriesKey) return [];
    const cmp: Record<SerSort, (a: SeriesInfo, b: SeriesInfo) => number> = {
      n: (a, b) => b.n - a.n || a.label.localeCompare(b.label, "zh"),
      name: (a, b) => a.label.localeCompare(b.label, "zh"),
      rating: (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.n - a.n,
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    };
    return seriesRows.slice().sort(cmp[serSort]);
  }, [seriesRows, seriesRowsKey, seriesKey, serSort]);

  /* 还没选书库就先把整页换成选择页，主界面一律不铺 */
  if (!info?.hasLibrary) {
    return (
      <div className="app">
        <div className="window-titlebar-placeholder" aria-hidden="true" />
        {info ? (
          <LibraryGate onOpened={() => window.location.reload()} />
        ) : (
          <div className="gate">
            <div className="gate-in">
              <div className="gate-lead">正在打开…</div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const sidebar = (
    <Sidebar
      facets={facets}
      filter={temp.filter}
      presetMedia={viewMedia}
      unit={unit}
      onChange={patch}
      onManageCats={() => setCadmin(true)}
      onCategoryChanged={bump}
    />
  );

  return (
    <div className="app">
      <ViewTabs
        views={views}
        currentId={viewId}
        active={page === "library"}
        onSelect={selectView}
        onAdd={() => setEditor({ view: null })}
        onMenu={(e, v) => setVctx({ x: e.clientX, y: e.clientY, view: v })}
        onDelete={(v) => setDelView(v)}
        onMove={moveView}
        addDisabled={!viewsLoaded}
      />
      <header className="topbar">
        {page === "library" ? (
          <div className="book-search-group">
            <BookSearchInput
              key="book-search"
              ref={searchRef}
              label={unit === "series" ? "搜索系列" : "搜索藏书"}
              value={temp.q}
              onChange={(q) => setTemp({ q })}
              suggest={(field, prefix, remaining) => api.suggestBookField(
                { ...(unit === "series" ? buildSeriesQuery() : buildBookQuery(0, PAGE)), q: remaining },
                field,
                prefix,
                unit === "series"
              )}
              placeholder={unit === "series" ? "搜系列名、原名（@ 选字段）" : "搜书名、作者、原名（@ 选字段）"}
            />
            <button className="mini" onClick={clearTemp} disabled={!tempDirty} title="清空临时条件，回到视图预筛选">
              清除条件
            </button>
          </div>
        ) : page === "review" ? (
          <input
            key="review-search"
            ref={searchRef}
            className="search"
            aria-label="搜索书评"
            value={reviewQuery}
            onChange={(e) => setReviewQuery(e.target.value)}
            placeholder="搜书名或正文"
          />
        ) : null}
        <span className="spacer" />
        <div className="seg">
          <button className={page === "review" ? "on" : ""} onClick={() => setPage("review")}>
            书评
          </button>
          <button className={page === "read" ? "on" : ""} onClick={() => setPage("read")}>
            阅读
          </button>
        </div>
        <button className="mini" onClick={moreMenu} title="备份、恢复、主题">
          更多 ▾
        </button>
      </header>

      <div className="body" onMouseDownCapture={(e) => {
        if (page !== "library" || !e.shiftKey || e.button !== 0 || !(e.target instanceof Element)) return;
        if (e.target.closest("input, textarea, select, [contenteditable=true]")) return;
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
      }}>
        {page === "read" ? (
          <ReadView ver={tick} onPick={(id) => pickBook(id)} />
        ) : page === "review" ? (
          <ReviewLib
            reviews={reviews}
            q={reviewQuery}
            onOpenBook={pickBook}
            focusKey={reviewFocus}
            onFocusDone={() => setReviewFocus(null)}
            onGoto={(id) => {
              setPage("library");
              setViewId(FIXED_VIEW_ID);
              pickBook(id);
            }}
            onChanged={bump}
            onSay={say}
            dirInfo={dirInfo}
            onRefreshDir={() => api.reviewDirInfo().then(setDirInfo)}
          />
        ) : unit === "series" ? (
          <>
            {sidebar}
            <div className="main">
              <div className="toolbar">
                <span>共 {shownSeries.length} 个系列</span>
                <select value={serSort} onChange={(e) => setSerSort(e.target.value as SerSort)}>
                  <option value="n">按册数</option>
                  <option value="name">按系列名</option>
                  <option value="rating">按均分</option>
                  <option value="updated">按最近改动</option>
                </select>
                <span className="dim">点一行或一格看系列详情，可写系列总评</span>
                <button
                  className={"mini xs" + (advCount ? " on" : "")}
                  onClick={(e) => {
                    anchor(e);
                    setAdvOpen(!advOpen);
                  }}
                  title="按字段组合筛选条件"
                >
                  高级筛选{advCount ? "（" + advCount + "）" : ""}
                </button>
                <div className="chips">
                  {chips.map((c) => (
                    <span
                      key={c.key}
                      className={"chip on" + (c.preset ? " preset" : "")}
                      onClick={c.clear}
                      title={c.preset ? "点一下编辑视图的预设" : "点掉这个条件"}
                    >
                      {c.label} ×
                    </span>
                  ))}
                </div>
                <span className="spacer" />
                <button className="mini xs" onClick={() => setAddBookOpen(true)}>新增书目</button>
                {seriesLoading ? <span>读取中…</span> : null}
              </div>

              {advOpen ? (
                <AdvPanel adv={temp.adv} fields={fields} categories={cats.map((c) => c.name)} onChange={setAdv} onClose={() => setAdvOpen(false)} pos={panelPos} />
              ) : null}

              <div className="scroll">
                {layout === "table" ? (
                  <SeriesTable list={shownSeries} onOpen={setSerPanel} />
                ) : (
                  <SeriesGrid list={shownSeries} onOpen={setSerPanel} />
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            {sidebar}
            <div className="main">
              <div className="toolbar">
                <span>共 {shownTotal} 本</span>
                {picked.length > 1 ? (
                  <span className="chip on" onClick={() => setPicked([])} title="点掉取消多选">
                    已选 {picked.length} 本 ×
                  </span>
                ) : null}
                <SortBar sorts={sorts} onChange={(next) => { setFirstIds([]); setSorts(next); }} sortables={sortables} />
                {layout === "table" ? (
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
                  title="按字段组合筛选条件"
                >
                  高级筛选{advCount ? "（" + advCount + "）" : ""}
                </button>
                <div className="chips">
                  {chips.map((c) => (
                    <span
                      key={c.key}
                      className={"chip on" + (c.preset ? " preset" : "")}
                      onClick={c.clear}
                      title={c.preset ? "点一下编辑视图的预设" : "点掉这个条件"}
                    >
                      {c.label} ×
                    </span>
                  ))}
                </div>
                <span className="spacer" />
                <button className="mini xs" onClick={() => setAddBookOpen(true)}>新增书目</button>
                {loading ? <span>读取中…</span> : null}
              </div>

              {colOpen ? (
                <ColumnPanel fields={fields} hidden={hidden} onChange={setHidden} onClose={() => setColOpen(false)} pos={panelPos} />
              ) : null}
              {advOpen ? (
                <AdvPanel adv={temp.adv} fields={fields} categories={cats.map((c) => c.name)} onChange={setAdv} onClose={() => setAdvOpen(false)} pos={panelPos} />
              ) : null}

              <div className="scroll" ref={scrollRef} onScroll={onScroll}>
                {shownRows.length ? (
                  <>
                    {layout === "shelf" ? (
                      <GridView rows={shownRows} selected={picked} onSelect={pickBook} onCtx={openCtx} />
                    ) : (
                      <TableView
                        rows={shownRows}
                        selected={picked}
                        fields={fields}
                        cats={cats}
                        hidden={hidden}
                        onSelect={pickBook}
                        onCtx={openCtx}
                        onPatch={patchBook}
                      />
                    )}
                    <div className="loadmore">
                      {shownRows.length < shownTotal ? "往下滚继续加载（已显示 " + shownRows.length + "）" : "到底了"}
                    </div>
                  </>
                ) : info.bookCount === 0 ? (
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

      <DetailPanel id={selected} fields={fields} cats={cats} onClose={() => setPicked([])} onSaved={saveAndRefresh} />
      {addBookOpen ? <NewBookDialog onClose={() => setAddBookOpen(false)} loadOptions={api.newBookOptions} onCreate={addBooks} /> : null}

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
          onChanged={bump}
        />
      ) : null}

      {ctx ? <CtxMenu x={ctx.x} y={ctx.y} items={ctx.items} onPick={pickCtx} onClose={() => setCtx(null)} /> : null}
      {vctx ? (
        <CtxMenu
          x={vctx.x}
          y={vctx.y}
          items={[{ key: "edit", label: "编辑视图" }]}
          onPick={() => setEditor({ view: vctx.view })}
          onClose={() => setVctx(null)}
        />
      ) : null}
      {more ? <CtxMenu x={more.x} y={more.y} items={moreItems} onPick={pickMore} onClose={() => setMore(null)} /> : null}

      {cadmin ? <CategoryAdmin onClose={() => setCadmin(false)} onChanged={bump} /> : null}
      {fadmin ? <FieldAdmin onClose={() => setFadmin(false)} onChanged={bump} /> : null}
      {cbatch ? <CoverBatch onClose={() => setCbatch(false)} onChanged={bump} /> : null}

      {editor ? (
        <ViewEditor
          key={editor.view?.id || "new"}
          initial={editor.view}
          cats={cats}
          onCancel={() => setEditor(null)}
          onSave={saveView}
        />
      ) : null}

      {delView ? (
        <Confirm
          text={"删除视图「" + delView.name + "」？只删除这条视图配置，书和书评都不动。"}
          okText="删除视图"
          onOk={confirmDeleteView}
          onCancel={() => setDelView(null)}
        />
      ) : null}

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
