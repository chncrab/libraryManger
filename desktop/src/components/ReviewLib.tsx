import { useEffect, useMemo, useRef, useState } from "react";
import api from "../api";
import { mdToHtml } from "../markdown";
import { copyText } from "../clip";
import CtxMenu, { type CtxItem } from "./CtxMenu";
import Confirm from "./Confirm";
import BookPicker from "./BookPicker";
import SeriesPicker from "./SeriesPicker";
import RichEditor, { type RichHandle } from "./RichEditor";
import type { ReviewIoSummary, ReviewRow } from "../../shared/types";

interface Props {
  reviews: ReviewRow[];
  onGoto: (bookId: string) => void;
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

const keyOf = (r: ReviewRow) => r.kind + ":" + r.id;

const KIND_TAG: Record<string, string> = { series: "系列", draft: "草稿", orphan: "未匹配" };

/* 系列名有的本身自带书名号，外面不要再套一层 */
const bracket = (s: string) => (/^[《〈【]/.test(s || "") ? s : "《" + (s || "") + "》");

/* 书评库：左栏是清单，中间是正文。正文可直接编辑，停手 700 毫秒自动落库 */
export default function ReviewLib({
  reviews,
  onGoto,
  onChanged,
  focusKey,
  onFocusDone,
  onSay,
  dirInfo,
  onRefreshDir
}: Props) {
  const [selKey, setSelKey] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"time" | "title" | "len" | "grade">("time");
  const [grade, setGrade] = useState("all");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [stat, setStat] = useState("");

  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxItem[]; row: ReviewRow } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [del, setDel] = useState<ReviewRow | null>(null);
  const [pick, setPick] = useState<ReviewRow | null>(null);
  const [pickSer, setPickSer] = useState<ReviewRow | null>(null);
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
      if (grade !== "all" && (r.grade || "normal") !== grade) return false;
      if (!k) return true;
      return (r.title || "").toLowerCase().indexOf(k) >= 0 || (r.md || "").toLowerCase().indexOf(k) >= 0;
    });
    out.sort((a, b) => {
      if (sort === "title") return (a.title || "").localeCompare(b.title || "", "zh");
      if (sort === "len") return (b.md || "").length - (a.md || "").length;
      if (sort === "grade") return (rank[a.grade || "normal"] ?? 1) - (rank[b.grade || "normal"] ?? 1);
      return String(b.happenedAt || "").localeCompare(String(a.happenedAt || ""));
    });
    return out;
  }, [reviews, q, sort, grade]);

  /* 换筛选后当前选中的那条可能被筛掉，自动落到第一条 */
  const cur = list.find((r) => keyOf(r) === selKey) || list[0] || null;
  const curKey = cur ? keyOf(cur) : "";

  /* 从系列弹层切过来，等清单里有了这一篇再选中 */
  useEffect(() => {
    if (!focusKey) return;
    if (reviews.some((r) => keyOf(r) === focusKey)) {
      setSelKey(focusKey);
      onFocusDone?.();
    }
  }, [focusKey, reviews, onFocusDone]);

  /* 新建或右键「编辑书评」时，清单要先刷新才会切到那一篇，
     这段时间里 curKey 还会落在旧值上，靠这个记下要进编辑的那条，
     等它真的成为当前项再打开编辑区，否则会被切篇的复位逻辑立刻关掉 */
  const wantEdit = useRef<string | null>(null);
  const enterEdit = (r: ReviewRow, focus = true) => {
    const k = keyOf(r);
    setSelKey(k);
    wantEdit.current = k;
    if (focus) setTimeout(() => richRef.current?.focus(), 80);
  };

  /* 切到另一篇时退出编辑，正文换成新的那一篇 */
  useEffect(() => {
    if (cur && wantEdit.current === keyOf(cur)) {
      wantEdit.current = null;
      setEditing(true);
      setDraft(cur.md || "");
      setStat("");
      setTimeout(() => richRef.current?.focus(), 80);
      return;
    }
    setEditing(false);
    setDraft(cur?.md || "");
    setStat("");
  }, [curKey]);

  useEffect(() => {
    if (!editing || !cur) return;
    if (draft === cur.md) return;
    const t = window.setTimeout(async () => {
      setStat("保存中…");
      const r = await api.updateReview(cur.kind, cur.id, { md: draft });
      setStat(r.ok ? "已保存" : r.msg || "保存失败");
      if (r.ok) {
        onChanged();
        onRefreshDir?.();
      }
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing, curKey]);

  const addNew = async () => {
    const r = await api.createReview({ name: "新书评", grade: "normal", md: "" });
    if (!r.ok || !r.id) {
      say(r.msg || "新建失败");
      return;
    }
    onChanged();
    wantEdit.current = "draft:" + r.id;
    setSelKey("draft:" + r.id);
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
    /* 名字由主进程给，跟落盘那份完全一致，不再在界面自己拼 */
    const got = await api.reviewFileName(r.kind, r.id);
    const base =
      got ||
      (r.kind === "series" ? bracket(r.seriesLabel || r.title) + "系列" : (r.title || "书评") + " - 书评");
    const name = /\.md$/i.test(base) ? base : base + ".md";
    const blob = new Blob([r.md || ""], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, "_");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  /* 手动保存：不等那 0.7 秒，点了就落库并写 md */
  const saveNow = async () => {
    if (!cur) return;
    setStat("保存中…");
    const r = await api.updateReview(cur.kind, cur.id, { md: draft });
    setStat(r.ok ? "已保存" : r.msg || "保存失败");
    if (r.ok) {
      onChanged();
      onRefreshDir?.();
      say("已保存并写入 md");
    }
  };

  const doDelete = async (r: ReviewRow) => {
    /* 未匹配那份在另一张表里，kind 必须一起给，不然会删到同 id 的另一篇书评 */
    const res = await api.deleteReview(r.kind, r.id);
    if (res.ok) {
      if (keyOf(r) === selKey) setSelKey(null);
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
      setSelKey("book:" + (r.id || ""));
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
      setSelKey("series:" + (r.id || pickSer.id));
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

  /* 重命名：已挂到书或系列的那些一律改回「作者-《书名》书评.md」这种规范名 */
  const doRename = async () => {
    setBusy("重命名中…");
    try {
      const r = await api.renameReviewFiles();
      if (!r) {
        say("重命名失败");
        return;
      }
      const n = r.renamed || 0;
      say(n ? "重命名：" + n + " 份 md 已改成规范名" : "重命名：文件名都已经规范");
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
    { key: "diag", label: "存储自检" }
  ];

  const pickMenu = async (k: string) => {
    if (k === "importFiles" || k === "importFolder" || k === "export") return runIo(k);
    if (k === "openDir") {
      await api.openReviewDir();
      return;
    }
    if (k === "diag") diag();
  };

  const openCtx = (e: React.MouseEvent, r: ReviewRow) => {
    e.preventDefault();
    e.stopPropagation();
    setSelKey(keyOf(r));
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
      copyText(r.md || "");
      say("已复制全文");
    }
    if (k === "del") setDel(r);
  };

  const words = (editing ? draft : cur?.md || "").length;

  return (
    <div className="rvlib">
      <aside className="rvs">
        <div className="rvs-h">
          <span className="rvs-t" title={"书评 " + reviews.length + " 篇"}>
            书评 {reviews.length} 篇
          </span>
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
        </div>
        <div className="rvs-tools">
          <input className="rvs-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜书名或正文" />
          <select className="rvs-sel" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
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
            onClick={doRename}
            disabled={!!busy}
            title="把已经挂到书或系列的 md 改回规范名：作者-《书名》书评.md"
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
              onClick={() => setSelKey(keyOf(r))}
              onContextMenu={(e) => openCtx(e, r)}
            >
              <span className="rvi-g">{GRADE_ICON[r.grade || "normal"] || "🤍"}</span>
              <div className="rvi-b">
                <div className="rvi-t">
                  {r.title || "(未命名)"}
                  {KIND_TAG[r.kind] ? <span className="rvi-badge">{KIND_TAG[r.kind]}</span> : null}
                </div>
                <div className="rvi-m">
                  {(r.md || "").length} 字 · {(r.happenedAt || "").slice(0, 10)}
                </div>
              </div>
            </div>
          ))}
          {list.length === 0 ? <div className="empty">没有符合条件的书评</div> : null}
        </div>
      </aside>

      <section className="rvm">
        {cur ? (
          <>
            <div className="rvm-h">
              <span className="rvm-g">{GRADE_ICON[cur.grade || "normal"] || "🤍"}</span>
              <h2>{cur.kind === "series" ? bracket(cur.seriesLabel || cur.title) + "系列书评" : cur.title || "(未命名)"}</h2>
              <div className="rvm-gs">
                {["god", "normal", "bad"].map((g) => (
                  <button
                    key={g}
                    className={"gbtn" + ((cur.grade || "normal") === g ? " on" : "")}
                    title={GRADE_NAME[g]}
                    onClick={() => setGradeOf(g)}
                  >
                    {GRADE_ICON[g]}
                  </button>
                ))}
              </div>
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
              <button className="mini" onClick={() => exportMd(cur)}>
                导出
              </button>
              {editing ? (
                <button className="mini" onClick={saveNow} title="立刻保存，并把这篇写成书评文件夹里的 md">
                  保存
                </button>
              ) : null}
              <button
                className="mini"
                onClick={() => {
                  setEditing(!editing);
                  if (!editing) setTimeout(() => richRef.current?.focus(), 60);
                }}
              >
                {editing ? "预览" : "编辑"}
              </button>
            </div>

            {editing ? (
              <div className="rvm-edit">
                <RichEditor key={curKey} ref={richRef} md={cur.md || ""} onChange={setDraft} />
                <div className="rvm-stat">
                  {words} 字 · {stat || "停手 0.7 秒自动保存"}
                  {dirInfo?.dir ? " · 同步目录已接" : ""}
                </div>
              </div>
            ) : (
              <div className="rvm-body">
                {cur.md && cur.md.trim() ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(cur.md) }} />
                ) : (
                  <div className="empty">这篇没有正文，点「编辑」开始写</div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="empty">{busy || "左边挑一篇书评"}</div>
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

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
