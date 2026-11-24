import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import api from "../api";
import { mdToHtml } from "../markdown";
import { copyText } from "../clip";
import CtxMenu, { type CtxItem } from "./CtxMenu";
import Confirm from "./Confirm";
import BookPicker from "./BookPicker";
import SeriesPicker from "./SeriesPicker";
import RichEditor, { type RichHandle } from "./RichEditor";
import ReviewFrontmatter, { frontmatterChanges } from "./ReviewFrontmatter";
import type { ReviewFrontmatterField, ReviewIoSummary, ReviewRow } from "../../shared/types";
import "./ReviewLib.css";

interface Props {
  reviews: ReviewRow[];
  q: string;
  onGoto: (bookId: string) => void;
  onOpenBook: (bookId: string) => void;
  onChanged: () => void;
  /** 从系列弹层切过来时指定要选中的那一篇，形如 series:12 */
  focusKey?: string | null;
  onFocusDone?: () => void;
  onSay?: (t: string) => void;
  dirInfo?: { dir: string; exist: boolean; files: number } | null;
  onRefreshDir?: () => void;
}

const GRADES: [string, string, string][] = [
  ["all", "全部", "全部"],
  ["god", "❤️", "神作"],
  ["normal", "🤍", "普通"],
  ["bad", "💣", "扫雷"]
];

const GRADE_NAME: Record<string, string> = { god: "神作", normal: "普通", bad: "扫雷" };
const GRADE_ICON: Record<string, string> = { god: "❤️", normal: "🤍", bad: "💣" };

const gradeOf = (row: ReviewRow): string => {
  if (row.rating != null) return row.rating >= 8 ? "god" : row.rating >= 6 ? "normal" : "bad";
  if (row.grade === "god") return "god";
  return ["bad", "mine", "bomb"].includes(row.grade) ? "bad" : "normal";
};

const keyOf = (r: ReviewRow) => r.kind + ":" + r.id;

const KIND_TAG: Record<string, string> = { series: "系列", draft: "草稿", orphan: "未匹配" };

/* 系列名有的本身自带书名号，外面不要再套一层 */
const bracket = (s: string) => (/^[《〈【]/.test(s || "") ? s : "《" + (s || "") + "》");

type Snap = { md: string; version: string; fileName: string; frontmatter: ReviewFrontmatterField[] };

/** 编辑区的三种看法：所见即所得、源代码分栏、只读预览 */
type EditView = "rich" | "source" | "preview";

const fileNameOf = (r: ReviewRow | null | undefined) =>
  (r as (ReviewRow & { fileName?: string }) | null | undefined)?.fileName || r?.title || "(未命名)";

export default function ReviewLib({
  reviews,
  q,
  onGoto,
  onOpenBook,
  onChanged,
  focusKey,
  onFocusDone,
  onSay,
  dirInfo,
  onRefreshDir
}: Props) {
  const [selKey, setSelKey] = useState<string | null>(null);
  const [sort, setSort] = useState<"time" | "title" | "len" | "grade">("time");
  const [grade, setGrade] = useState("all");

  const [editing, setEditing] = useState(false);
  const [editView, setEditView] = useState<EditView>("rich");
  const [saving, setSaving] = useState(false);
  const [fmDraft, setFmDraft] = useState<ReviewFrontmatterField[]>([]);
  const [draft, setDraft] = useState("");
  const [stat, setStat] = useState("");
  const [snap, setSnap] = useState<Snap | null>(null);
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [asideW, setAsideW] = useState(290);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(1);

  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxItem[]; row: ReviewRow } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [del, setDel] = useState<ReviewRow | null>(null);
  const [pick, setPick] = useState<ReviewRow | null>(null);
  const [pickSer, setPickSer] = useState<ReviewRow | null>(null);
  const [stripAsk, setStripAsk] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const richRef = useRef<RichHandle | null>(null);
  const toastTimer = useRef<number | null>(null);

  /* 后一句提示要顶掉前一句，前一句的收尾定时器也得一并撤掉，
     否则它到点会把刚弹出来的新提示一起清掉 */
  const say = (t: string) => {
    setToast(t);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
    onSay?.(t);
  };

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const rank: Record<string, number> = { god: 0, normal: 1, bad: 2 };
    const out = reviews.filter((r) => {
      if (grade !== "all" && gradeOf(r) !== grade) return false;
      if (!k) return true;
      return (
        fileNameOf(r).toLowerCase().indexOf(k) >= 0 ||
        (r.title || "").toLowerCase().indexOf(k) >= 0 ||
        !!hits?.has(keyOf(r))
      );
    });
    out.sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "", "zh");
      if (sort === "len") return (b.length || 0) - (a.length || 0);
      if (sort === "grade") return rank[gradeOf(a)] - rank[gradeOf(b)];
      return String(b.happenedAt || "").localeCompare(String(a.happenedAt || ""));
    });
    return out;
  }, [reviews, q, sort, grade, hits]);

  /* 换筛选后当前选中的那条可能被筛掉，自动落到第一条 */
  const cur = list.find((r) => keyOf(r) === selKey) || list[0] || null;
  const curKey = cur ? keyOf(cur) : "";
  const dirBad = !!dirInfo && !dirInfo.exist;

  const curRef = useRef<ReviewRow | null>(null);
  const snapRef = useRef<Snap | null>(null);
  const editingRef = useRef(false);
  const draftRef = useRef("");
  const dirBadRef = useRef(false);
  const revRef = useRef(0);
  const sentRef = useRef<{ rev: number; md: string } | null>(null);
  const activeKeyRef = useRef("");
  const readSeq = useRef(0);
  const wantEdit = useRef<string | null>(null);
  const sayRef = useRef(say);
  /** 撤销只回到「进入编辑时」或「最近一次显式保存成功」的正文 */
  const undoRef = useRef<{ key: string; md: string } | null>(null);
  /** 显式保存/撤销期间不接收新的暂存写入 */
  const explicitRef = useRef<{ key: string; rev: number } | null>(null);
  /** 显式操作已经自己处理过的 revision，忽略随后迟到的广播 */
  const ignoredRevRef = useRef<number | null>(null);
  const editRootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  curRef.current = cur;
  snapRef.current = snap;
  editingRef.current = editing;
  draftRef.current = draft;
  dirBadRef.current = dirBad;
  sayRef.current = say;
  activeKeyRef.current = curKey;

  useEffect(() => {
    const root = editRootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !e.deltaY || !(e.target instanceof Element)) return;
      if (!e.target.closest(".rve, .rvm-body, .rv-src-ta, .rv-src-prev")) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      setZoom((value) => Math.max(0.8, Math.min(2.4, Math.round(value * 10 + dir) / 10)));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [curKey, dirBad]);

  const flushNow = useCallback(async () => {
    try {
      const r = await api.flushReviews();
      if (r && !r.ok && r.recoveryPath) sayRef.current?.("保存冲突，恢复文件：" + r.recoveryPath);
      return r;
    } catch {
      return null;
    }
  }, []);

  const selectKey = (k: string | null) => {
    if (k === selKey || explicitRef.current) return;
    void flushNow();
    setSelKey(k);
  };

  const loadRow = useCallback(async (row: ReviewRow, key: string, external: boolean) => {
    const seq = ++readSeq.current;
    setLoading(true);
    try {
      const c = await api.readReview(row.kind, row.id);
      if (seq !== readSeq.current || activeKeyRef.current !== key) return;
      const dirtyNow = editingRef.current && draftRef.current !== (snapRef.current?.md ?? "");
      if (dirtyNow || (external && (explicitRef.current || editingRef.current))) return;
      if (!c) {
        setSnap(null);
        setStat(dirBadRef.current ? "书评目录不可用" : "读取失败");
        return;
      }
      const s: Snap = {
        md: c.md || "",
        version: c.version || row.fileVersion || "",
        fileName: fileNameOf(c as any),
        frontmatter: c.frontmatter || []
      };
      if (external && s.version === snapRef.current?.version && s.fileName === snapRef.current.fileName) return;
      setSnap(s);
      snapRef.current = s;
      if (external) setEditorEpoch((e) => e + 1);
      draftRef.current = s.md;
      setDraft(s.md);
      setStat("");
      if (wantEdit.current === key) {
        wantEdit.current = null;
        undoRef.current = { key, md: s.md };
        setFmDraft(s.frontmatter);
        setEditing(true);
        setEditView("rich");
        setDraft(s.md);
        sentRef.current = null;
        setStat("");
        setTimeout(() => richRef.current?.focus(), 60);
      }
    } catch {
      if (seq === readSeq.current) setStat("读取失败");
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const k = q.trim();
    if (!k) {
      setHits(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const ids = await api.searchReviewText(k);
        if (alive) setHits(new Set(ids));
      } catch {
        if (alive) setHits(new Set());
      }
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  /* 从系列弹层切过来，等清单里有了这一篇再选中 */
  useEffect(() => {
    if (!focusKey) return;
    if (reviews.some((r) => keyOf(r) === focusKey)) {
      selectKey(focusKey);
      onFocusDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, reviews, onFocusDone]);

  const enterEdit = (r: ReviewRow, focus = true) => {
    if (explicitRef.current) return;
    const k = keyOf(r);
    if (k === curKey && editing) return;
    wantEdit.current = k;
    if (k !== curKey) {
      selectKey(k);
      return;
    }
    if (!snap) {
      setStat("读取中…");
      void loadRow(r, k, false);
      return;
    }
    wantEdit.current = null;
    undoRef.current = { key: k, md: snap.md };
    setFmDraft(snap.frontmatter);
    setEditing(true);
    setEditView("rich");
    setDraft(snap.md);
    sentRef.current = null;
    setStat("");
    if (focus) setTimeout(() => richRef.current?.focus(), 80);
  };

  const startEdit = () => {
    if (cur) enterEdit(cur);
  };

  /* 切到另一篇时退出编辑。主进程已经持有 staged 草稿，离开前立刻 flush。 */
  useEffect(() => {
    activeKeyRef.current = curKey;
    setEditing(false);
    setEditView("rich");
    setFmDraft([]);
    setDraft("");
    draftRef.current = "";
    setSnap(null);
    undoRef.current = null;
    sentRef.current = null;
    setStat("");
    const row = curRef.current;
    if (row) void loadRow(row, curKey, false);
    return () => {
      if (!explicitRef.current) void flushNow();
    };
  }, [curKey, loadRow, flushNow]);

  /* 外部目录变化才重读当前正文；自己保存后的列表刷新不重挂编辑器，避免光标复位。 */
  useEffect(() => {
    const off = api.onReviewsChanged(() => {
      if (explicitRef.current) return;
      const row = curRef.current;
      const key = activeKeyRef.current;
      if (!row || !key) return;
      if (editingRef.current) return;
      void loadRow(row, key, true);
    });
    return off;
  }, [loadRow]);

  useEffect(() => {
    const off = api.onReviewSaveState((kind, id, result) => {
      const key = kind + ":" + id;
      if (key !== activeKeyRef.current) return;
      /* 显式保存/撤销自己看 flush 的返回值；这条迟到的广播不再重复处理 */
      if (explicitRef.current) return;
      const rev = result.editRevision;
      if (rev != null && (rev === ignoredRevRef.current || rev !== revRef.current)) return;
      if (!result.ok) {
        setStat(result.msg || "保存失败");
        if (result.recoveryPath) sayRef.current?.("保存失败，恢复文件：" + result.recoveryPath);
        return;
      }
      const sent = sentRef.current;
      if (sent && rev != null && sent.rev === rev) {
        setSnap((s) => {
          const next: Snap = {
            md: sent.md,
            version: result.version || "",
            fileName: result.fileName || fileNameOf(curRef.current),
            frontmatter: s?.frontmatter || snapRef.current?.frontmatter || []
          };
          snapRef.current = next;
          return next;
        });
        setStat("已保存");
        onChanged();
        onRefreshDir?.();
        return;
      }
      if (rev == null && result.version) {
        setSnap((s) => {
          if (!s) return s;
          const next = { ...s, version: result.version || s.version, fileName: result.fileName || s.fileName };
          snapRef.current = next;
          return next;
        });
        setStat("已保存");
      }
    });
    return off;
  }, [onChanged, onRefreshDir]);

  /* 自动保存：每次改动只暂存，主进程 2 秒防抖后写盘。显式保存/撤销期间先不动 */
  const stageDraft = useCallback((md: string) => {
    const row = curRef.current;
    if (!row || explicitRef.current) return;
    const base = snapRef.current;
    if (!base) return;
    const key = keyOf(row);
    const rev = ++revRef.current;
    sentRef.current = { rev, md };
    setStat("待写入…");
    void api
      .stageReview(row.kind, row.id, {
        md,
        expectedFileName: base.fileName,
        expectedVersion: base.version,
        editRevision: rev
      })
      .then((r) => {
        if (sentRef.current?.rev !== rev || activeKeyRef.current !== key) return;
        if (!r.ok) {
          setStat(r.msg || "保存失败");
          if (r.recoveryPath) sayRef.current?.("保存冲突，恢复文件：" + r.recoveryPath);
        }
      })
      .catch(() => {
        if (sentRef.current?.rev === rev && activeKeyRef.current === key) setStat("保存失败");
      });
  }, []);

  const onDraft = (md: string) => {
    draftRef.current = md;
    setDraft(md);
    if (explicitRef.current) {
      setStat("保存中…");
      return;
    }
    stageDraft(md);
  };

  /* 保存与撤销在同一次主进程调用中替换待写入正文并落盘。 */
  const explicitSave = useCallback(
    async (md: string, label: "保存" | "撤销", frontmatter: ReviewFrontmatterField[] = []) => {
      const row = curRef.current;
      const base = snapRef.current;
      if (!row || !base || !base.version || explicitRef.current) return;
      const key = keyOf(row);
      const originalDraft = draftRef.current;
      const rev = ++revRef.current;
      explicitRef.current = { key, rev };
      ignoredRevRef.current = rev;
      sentRef.current = { rev, md };
      setSaving(true);
      setStat(label === "撤销" ? "撤销中…" : "写入中…");
      let ok = false;
      try {
        const r = await api.stageReview(row.kind, row.id, {
          md,
          ...(frontmatter.length ? { frontmatter } : {}),
          expectedFileName: base.fileName,
          expectedVersion: base.version,
          editRevision: rev
        }, true);
        if (activeKeyRef.current !== key) return;
        if (!r.ok || !r.version) {
          setStat(r.msg || "保存失败");
          if (r.recoveryPath) sayRef.current("保存冲突，恢复文件：" + r.recoveryPath);
          return;
        }
        const nextKind = r.kind || row.kind;
        const nextId = r.id ?? row.id;
        const nextKey = nextKind + ":" + nextId;
        const saved = label === "保存" && frontmatter.length && nextKey === key
          ? await api.readReview(nextKind, nextId).catch(() => null)
          : null;
        if (activeKeyRef.current !== key) return;
        const next: Snap = {
          md: saved?.md ?? md,
          version: saved?.version || r.version,
          fileName: saved?.fileName || r.fileName || base.fileName,
          frontmatter: saved?.frontmatter ?? base.frontmatter
        };
        snapRef.current = next;
        setSnap(next);
        undoRef.current = { key, md };
        if (label === "保存") {
          editingRef.current = false;
          setEditing(false);
          setEditView("rich");
          setFmDraft([]);
          draftRef.current = md;
          setDraft(md);
          if (nextKey !== key) setSelKey(nextKey);
        } else if (draftRef.current === originalDraft) {
          draftRef.current = md;
          setDraft(md);
          setEditorEpoch((epoch) => epoch + 1);
        }
        setStat("已保存");
        onChanged();
        onRefreshDir?.();
        sayRef.current(label === "撤销" ? "已恢复到保存点" : "已保存");
        ok = true;
      } catch {
        if (activeKeyRef.current === key) setStat("保存失败");
      } finally {
        if (explicitRef.current?.rev === rev) explicitRef.current = null;
        setSaving(false);
        /* 保存期间用户又改了字：马上用刚成功的新版本再暂存一次，不丢输入 */
        if (ok && activeKeyRef.current === key && draftRef.current !== md) stageDraft(draftRef.current);
      }
    },
    [onChanged, onRefreshDir, stageDraft]
  );

  const undoNow = () => {
    const row = curRef.current;
    const base = undoRef.current;
    if (!row || !base || explicitRef.current) return;
    if (base.key !== keyOf(row)) return;
    void explicitSave(base.md, "撤销");
  };

  const addNew = async () => {
    const r = await api.createReview({ name: "新书评", grade: "normal", md: "" });
    if (!r.ok || !r.id) {
      say(r.msg || "新建失败");
      return;
    }
    onChanged();
    wantEdit.current = "draft:" + r.id;
    selectKey("draft:" + r.id);
  };

  const setGradeOf = async (g: string) => {
    if (!cur) return;
    const r = await api.updateReview(cur.kind, cur.id, { grade: g });
    if (r.ok) {
      onChanged();
      say("已标为" + (GRADE_NAME[g] || g));
    }
  };

  const exportMd = async (r: ReviewRow) => {
    const curFile = await api.readReview(r.kind, r.id).catch(() => null);
    if (!curFile) {
      say(dirBad ? "书评目录不可用，读不到磁盘上的 Markdown" : "读不到这篇的 Markdown");
      return;
    }
    const base = fileNameOf(curFile as any) || fileNameOf(r);
    const name = /\.md$/i.test(base) ? base : base + ".md";
    const blob = new Blob([curFile.raw || ""], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, "_");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /* 正文和标签共用当前文件版本，在一次写入中保存。 */
  const saveNow = () => {
    const base = snapRef.current;
    if (base) void explicitSave(draftRef.current, "保存", frontmatterChanges(base.frontmatter, fmDraft));
  };

  const doDelete = async (r: ReviewRow) => {
    /* 未匹配那份在另一张表里，kind 必须一起给，不然会删到同 id 的另一篇书评 */
    const res = await api.deleteReview(r.kind, r.id);
    if (res.ok) {
      if (keyOf(r) === selKey) selectKey(null);
      onChanged();
      onRefreshDir?.();
      say("已删除");
    } else say(res.msg || "删除失败");
  };

  const doAssociate = async (bookId: string) => {
    if (!pick) return;
    const r = pick.kind === "orphan" ? await api.associateOrphan(pick.id, bookId) : await api.moveReview(pick.kind, pick.id, bookId);
    if (r.ok) {
      setPick(null);
      selectKey("book:" + (r.id || ""));
      onChanged();
      onRefreshDir?.();
      say(pick.kind === "orphan" ? "已关联到书籍" : "已绑定到该书");
    } else {
      say(r.msg || "没关联上");
    }
  };

  const doAssociateSeries = async (seriesId: number) => {
    if (!pickSer) return;
    const r = await api.moveReviewToSeries(pickSer.kind, pickSer.id, seriesId);
    if (r.ok) {
      setPickSer(null);
      /* 未匹配那条搬过去会新建一行，选中要跟着新 id 走 */
      selectKey("series:" + (r.id || pickSer.id));
      onChanged();
      onRefreshDir?.();
      say("已挂成系列总评");
    } else {
      say(r.msg || "没关联上");
    }
  };

  /* ---- 导入导出与目录同步 ---- */
  const summarize = (verb: string, r: ReviewIoSummary) => {
    const parts: string[] = [];
    if (r.added) parts.push("新增 " + r.added);
    if (r.updated) parts.push("更新 " + r.updated);
    if (r.orphan) parts.push("未匹配 " + r.orphan);
    if (r.skipped) parts.push("跳过 " + r.skipped);
    if (r.written) parts.push("写入 " + r.written);
    if (r.removed) parts.push("删除 " + r.removed);
    if (r.renamed) parts.push("跟随改名 " + r.renamed);
    say(verb + "：" + (parts.join("，") || "没有变化"));
  };

  const runIo = async (kind: "importFiles" | "importFolder" | "export" | "sync") => {
    if (kind === "sync" && dirBad) {
      say("书评目录不可用，请先检查书评文件夹");
      return;
    }
    setBusy(kind === "sync" ? "同步中…" : "处理中…");
    try {
      const r =
        kind === "importFiles"
          ? await api.importReviewFiles()
          : kind === "importFolder"
            ? await api.importReviewFolder()
            : kind === "export"
              ? await api.exportReviews()
              : await api.syncReviewDir();
      if (!r) return;
      const verb =
        kind === "importFiles" ? "导入文件" : kind === "importFolder" ? "导入文件夹" : kind === "export" ? "导出" : "同步";
      summarize(verb, r);
      if (r.msgs?.length) window.setTimeout(() => say(r.msgs[0]), 2800);
      onChanged();
      onRefreshDir?.();
    } finally {
      setBusy("");
    }
  };

  /* 刷新：重新扫一遍目录再拉清单。外面改过 md、或者监听慢了半拍，点一下就对齐 */
  const doRefresh = async () => {
    if (dirBad) {
      say("书评目录不可用，请先检查书评文件夹");
      return;
    }
    setBusy("刷新中…");
    try {
      const r = await api.syncReviewDir();
      if (!r) {
        say("刷新失败");
        return;
      }
      summarize("刷新", r);
      onChanged();
      onRefreshDir?.();
    } finally {
      setBusy("");
    }
  };

  const doRenameAll = async () => {
    setBusy("重命名中…");
    try {
      const r = await api.renameReviewFiles();
      if (!r) {
        say("重命名失败");
        return;
      }
      const changes = [
        r.renamed ? "已重命名 " + r.renamed + " 篇" : "",
        r.filled ? "已更新 " + r.filled + " 篇系列标签" : ""
      ].filter(Boolean);
      say(changes.join("，") || r.msgs[0] || "文件名和系列标签已符合规范");
      onChanged();
      onRefreshDir?.();
    } finally {
      setBusy("");
    }
  };

  /* 补齐开头那块：阅读时间、评分、书籍或系列、分类。只动开头，正文不碰 */
  const doFillFront = async () => {
    setBusy("补标签中…");
    try {
      const r = await api.fillReviewFront();
      if (!r) {
        say("补标签失败");
        return;
      }
      const n = r.filled || 0;
      say(n ? "补标签：" + n + " 篇补齐，跳过 " + r.skipped + " 篇已齐" : "补标签：都齐了，没动一篇");
      if (r.backup) window.setTimeout(() => say("备份在 " + r.backup), 3000);
      onChanged();
      onRefreshDir?.();
    } finally {
      setBusy("");
    }
  };

  /* 撤销标签：开头那块整段删掉，之后不再自动写 */
  const doStripFront = async () => {
    setBusy("撤销中…");
    try {
      const r = await api.stripReviewFront();
      if (!r) {
        say("撤销失败");
        return;
      }
      const n = r.filled || 0;
      say(n ? "已撤掉 " + n + " 篇的开头标签" : "没有可撤的标签");
      if (r.backup) window.setTimeout(() => say("备份在 " + r.backup), 3000);
      onChanged();
      onRefreshDir?.();
    } finally {
      setBusy("");
    }
  };

  const diag = () => {
    say(
      "桌面版 · 库内 " +
        reviews.length +
        " 篇书评 · 书评文件夹 " +
        (dirInfo?.dir || "未设置") +
        (dirInfo?.dir ? "（" + dirInfo.files + " 个 md）" : "") +
        (busy ? " · " + busy : "")
    );
  };

  const menuItems: CtxItem[] = [
    { key: "importFiles", label: "导入 Markdown 文件…" },
    { key: "importFolder", label: "导入整个文件夹…" },
    { key: "export", label: "导出一份到别处…" },
    { key: "s1", label: "", sep: true },
    { key: "openDir", label: "打开书评文件夹" },
    { key: "s2", label: "", sep: true },
    { key: "fillFront", label: "补齐书评标签…" },
    { key: "stripFront", label: "撤销标签" },
    { key: "s3", label: "", sep: true },
    { key: "rebuild", label: "重建书评索引" },
    { key: "diag", label: "存储自检" }
  ];

  const pickMenu = async (k: string) => {
    if (k === "importFiles" || k === "importFolder" || k === "export") return runIo(k);
    if (k === "rebuild") return doRefresh();
    if (k === "fillFront") return doFillFront();
    if (k === "stripFront") {
      setStripAsk(true);
      return;
    }
    if (k === "openDir") {
      await api.openReviewDir();
      return;
    }
    if (k === "diag") diag();
  };

  const openCtx = (e: React.MouseEvent, r: ReviewRow) => {
    e.preventDefault();
    e.stopPropagation();
    selectKey(keyOf(r));
    /* 正在编辑当前这篇时，右键顺带给排版命令，省得回顶部工具栏 */
    const fmt: CtxItem[] =
      editing && keyOf(r) === curKey
        ? [
            { key: "fmt-bold", label: "加粗" },
            { key: "fmt-it", label: "斜体" },
            { key: "fmt-h1", label: "一级标题" },
            { key: "fmt-h2", label: "二级标题" },
            { key: "fmt-h3", label: "三级标题" },
            { key: "fmt-quote", label: "引用" },
            { key: "fmt-ul", label: "无序列表" },
            { key: "s0", label: "", sep: true }
          ]
        : [];
    const bind: CtxItem[] =
      r.kind === "series"
        ? [
            { key: "assoc", label: "关联到单本书" },
            { key: "assocSer", label: "换绑到其他系列" }
          ]
        : [
            { key: "assoc", label: r.kind === "orphan" ? "关联到书籍" : "绑定其他书籍" },
            { key: "assocSer", label: "关联到系列" }
          ];
    const items: CtxItem[] = [
      { key: "edit", label: "编辑书评" },
      ...fmt,
      ...(r.bookId ? [{ key: "goto", label: "在书库中查看" }] : []),
      ...bind,
      { key: "s1", label: "", sep: true },
      { key: "export", label: "导出为 Markdown" },
      { key: "copy", label: "复制全文" },
      { key: "s2", label: "", sep: true },
      { key: "del", label: "删除书评", danger: true }
    ];
    setCtx({ x: e.clientX, y: e.clientY, items, row: r });
  };

  const FMT: Record<string, [string, string?]> = {
    "fmt-bold": ["bold"],
    "fmt-it": ["italic"],
    "fmt-h1": ["formatBlock", "h1"],
    "fmt-h2": ["formatBlock", "h2"],
    "fmt-h3": ["formatBlock", "h3"],
    "fmt-quote": ["formatBlock", "blockquote"],
    "fmt-ul": ["insertUnorderedList"]
  };

  const pickCtx = (k: string) => {
    const r = ctx?.row;
    if (!r) return;
    if (FMT[k]) {
      const [cmd, arg] = FMT[k];
      /* 点菜单时编辑区已经失焦，编辑器自己存了选区，恢复后再执行 */
      setTimeout(() => richRef.current?.run(cmd, arg), 0);
      return;
    }
    if (k === "edit") enterEdit(r);
    if (k === "goto" && r.bookId) onGoto(r.bookId);
    if (k === "assoc") setPick(r);
    if (k === "assocSer") setPickSer(r);
    if (k === "export") exportMd(r);
    if (k === "copy") {
      void (async () => {
        const t =
          keyOf(r) === curKey
            ? editing
              ? draftRef.current
              : snapRef.current?.md || ""
            : (await api.readReview(r.kind, r.id).catch(() => null))?.md || "";
        copyText(t);
        say("已复制正文");
      })();
    }
    if (k === "del") setDel(r);
  };

  const body = editing ? draft : snap?.md || "";
  const previewing = editView === "preview" || (!editing && editView !== "source");

  return (
    <div className={"rvlib" + (dragging ? " rvlib-dragging" : "")}>
      <aside className="rvs" style={{ width: asideW }}>
        <div className="rvs-h">
          <button className="mini" onClick={addNew} title="新建一篇空书评，写完再挂到书上">
            新建
          </button>
          <button
            className="mini"
            title="导入导出与文件夹同步"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: r.right - 200, y: r.bottom + 6 });
            }}
          >
            更多 ▾
          </button>
          <select className="rvs-sel" aria-label="书评排序" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="time">最近改的</option>
            <option value="title">书名</option>
            <option value="len">字数</option>
            <option value="grade">评价</option>
          </select>
        </div>
        <div className="rvs-grades">
          {GRADES.map(([k, icon, name]) => (
            <button key={k} className={grade === k ? "on" : ""} onClick={() => setGrade(k)} title={name}>
              {k === "all" ? "全部" : icon}
            </button>
          ))}
        </div>
        <div className="rvs-acts">
          <button className="mini" onClick={doRefresh} disabled={!!busy} title="重新扫一遍书评文件夹，与库里对齐">
            刷新
          </button>
          <button
            className="mini"
            onClick={doRenameAll}
            disabled={!!busy || saving}
            title="按已关联的书目或系列重命名"
          >
            重命名
          </button>
          <span className="rvs-cnt" title={dirInfo?.dir || "还没有打开书库"}>
            {dirInfo?.files ?? 0} 个 md
          </span>
        </div>
        <div className="rvs-list">
          {list.map((r) => (
            <div
              key={keyOf(r)}
              className={"rvi" + (cur && curKey === keyOf(r) ? " on" : "")}
              onClick={() => selectKey(keyOf(r))}
              onContextMenu={(e) => openCtx(e, r)}
            >
              <span className="rvi-g">{GRADE_ICON[gradeOf(r)]}</span>
              <div className="rvi-b">
                <div className="rvi-t">
                  <span className="rvi-name">{fileNameOf(r)}</span>
                  {KIND_TAG[r.kind] ? <span className="rvi-badge">{KIND_TAG[r.kind]}</span> : null}
                </div>
                <div className="rvi-m">
                  {r.length ?? 0} 字 · {(r.happenedAt || "").slice(0, 10)}
                </div>
              </div>
            </div>
          ))}
          {list.length === 0 ? <div className="empty">没有符合条件的书评</div> : null}
        </div>
      </aside>

      <div
        className={"rvlib-resizer" + (dragging ? " on" : "")}
        role="separator"
        aria-label="书评列表宽度"
        aria-orientation="vertical"
        title="拖动调整书评列表宽度"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const w = e.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? asideW;
          dragRef.current = { x: e.clientX, w };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          setAsideW(Math.max(210, Math.min(560, drag.w + e.clientX - drag.x)));
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      />

      <section className="rvm">
        {dirBad ? (
          <div className="empty">书评文件夹不可用：{dirInfo?.dir || "未设置"}。请检查目录后点「重建书评索引」。</div>
        ) : cur ? (
          <>
            <div className="rvm-h">
              <span className="rvm-g">{GRADE_ICON[gradeOf(cur)]}</span>
              <h2 title={cur.title}>{fileNameOf(cur)}</h2>
              {cur.rating == null ? (
                <div className="rvm-gs">
                  {["god", "normal", "bad"].map((g) => (
                    <button
                      key={g}
                      className={"gbtn" + (gradeOf(cur) === g ? " on" : "")}
                      title={GRADE_NAME[g]}
                      onClick={() => setGradeOf(g)}
                    >
                      {GRADE_ICON[g]}
                    </button>
                  ))}
                </div>
              ) : null}
              <span className="spacer" />
              {cur.bookId ? (
                <button className="mini" onClick={() => onGoto(cur.bookId as string)}>
                  在书库中查看
                </button>
              ) : (
                <button className="mini" onClick={() => setPick(cur)}>
                  关联到书籍
                </button>
              )}
              {editing ? (
                <>
                  <button className="mini" onClick={saveNow} disabled={saving} title="立刻保存，并把这篇写成书评文件夹里的 md">
                    保存
                  </button>
                  <button
                    className="mini"
                    onClick={undoNow}
                    disabled={saving || !undoRef.current}
                    title="回到进入编辑时或最近一次显式保存成功时的正文"
                  >
                    撤销
                  </button>
                </>
              ) : (
                <button className="mini" disabled={saving || loading} onClick={startEdit}>
                  编辑
                </button>
              )}
            </div>

            <ReviewFrontmatter
              key={curKey}
              fields={editing ? fmDraft : snap?.frontmatter || []}
              onChange={editing ? setFmDraft : undefined}
              disabled={saving}
              bookId={cur.bookId}
              seriesId={cur.seriesId}
              onOpenBook={onOpenBook}
            />

            <div className="rvm-edit" ref={editRootRef} style={{ "--rv-zoom": zoom } as CSSProperties}>
              <div className="rv-views">
                {editView === "source" ? (
                  <div className="rv-src">
                    <textarea
                      className="rv-src-ta"
                      aria-label="Markdown 源代码"
                      value={body}
                      readOnly={!editing || saving}
                      onChange={(e) => onDraft(e.target.value)}
                      spellCheck={false}
                    />
                    <div className="rv-src-prev md" dangerouslySetInnerHTML={{ __html: mdToHtml(body) }} />
                  </div>
                ) : previewing ? (
                  <div className="rvm-body">
                    {body.trim() ? (
                      <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(body) }} />
                    ) : (
                      <div className="empty">{loading ? "读取中…" : "这篇书评暂无正文"}</div>
                    )}
                  </div>
                ) : (
                  <RichEditor key={curKey + ":" + editorEpoch} ref={richRef} md={draft} onChange={onDraft} readOnly={saving} />
                )}
              </div>
              <div className="rvm-foot">
                <button
                  className={"mini" + (editView === "source" ? " on" : "")}
                  aria-pressed={editView === "source"}
                  disabled={saving}
                  onClick={() => setEditView((view) => view === "source" ? (editing ? "rich" : "preview") : "source")}
                >
                  显示源代码
                </button>
                <button
                  className={"mini" + (previewing ? " on" : "")}
                  aria-pressed={previewing}
                  disabled={saving}
                  onClick={() => setEditView((view) => editing && view === "preview" ? "rich" : "preview")}
                >
                  预览
                </button>
                <span className="rvm-stat" role="status">
                  {body.length} 字{stat ? " · " + stat : editing ? " · 2 秒后自动保存" : ""}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty">{busy || (loading ? "读取中…" : "左边挑一篇书评")}</div>
        )}
      </section>

      {ctx ? <CtxMenu x={ctx.x} y={ctx.y} items={ctx.items} onPick={pickCtx} onClose={() => setCtx(null)} /> : null}
      {menu ? <CtxMenu x={menu.x} y={menu.y} items={menuItems} onPick={pickMenu} onClose={() => setMenu(null)} /> : null}

      {del ? (
        <Confirm
          text={
            del.kind === "orphan"
              ? "删除这篇未匹配书评？源数据不动，只是从库里拿掉。"
              : "删除《" + (del.title || "这篇") + "》的书评？源数据不动，只是从库里拿掉。"
          }
          onOk={() => {
            doDelete(del);
            setDel(null);
          }}
          onCancel={() => setDel(null)}
        />
      ) : null}

      {pick ? (
        <BookPicker hint={"为《" + (pick.title || "未命名") + "》选择要绑定的书籍"} onPick={doAssociate} onCancel={() => setPick(null)} />
      ) : null}

      {pickSer ? (
        <SeriesPicker hint={"把《" + (pickSer.title || "未命名") + "》挂成整个系列的总评"} onPick={doAssociateSeries} onCancel={() => setPickSer(null)} />
      ) : null}

      {stripAsk ? (
        <Confirm
          text="把每篇 md 开头那块标签删掉？正文不动，删之前会先整目录备份一份。之后导入的新书评也不再自动加标签，想加回来点「补齐书评标签」。"
          okText="撤掉"
          onOk={() => {
            setStripAsk(false);
            doStripFront();
          }}
          onCancel={() => setStripAsk(false)}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
