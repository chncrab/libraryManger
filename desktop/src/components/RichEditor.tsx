import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { mdToHtml } from "../markdown";
import { htmlToMd } from "../html2md";

export interface RichHandle {
  /* 供右键菜单与工具栏调用，参数同 document.execCommand */
  run: (cmd: string, arg?: string) => void;
  focus: () => void;
}

interface Props {
  /** 只用来定初值，之后编辑区内的一切以 DOM 为准 */
  md: string;
  onChange: (md: string) => void;
}

type Tool = { cmd: string; arg?: string; label: string; title: string; wide?: boolean };

const TOOLS: Tool[] = [
  { cmd: "bold", label: "B", title: "加粗（Ctrl+B）" },
  { cmd: "italic", label: "I", title: "斜体（Ctrl+I）" },
  { cmd: "formatBlock", arg: "h1", label: "H1", title: "一级标题" },
  { cmd: "formatBlock", arg: "h2", label: "H2", title: "二级标题" },
  { cmd: "formatBlock", arg: "h3", label: "H3", title: "三级标题" },
  { cmd: "formatBlock", arg: "p", label: "正文", title: "恢复成正文段落", wide: true },
  { cmd: "formatBlock", arg: "blockquote", label: "引用", title: "引用块", wide: true },
  { cmd: "insertUnorderedList", label: "• 列表", title: "无序列表", wide: true },
  { cmd: "formatBlock", arg: "pre", label: "</>", title: "代码块" },
  { cmd: "removeFormat", label: "清格式", title: "去掉选中文字的格式", wide: true }
];

/**
 * 所见即所得编辑区。DOM 里的 HTML 是唯一事实，输入时转成 markdown 往外抛，
 * 外部不再往回流，否则每次保存回来光标就被顶到开头。
 */
const RichEditor = forwardRef<RichHandle, Props>(function RichEditor({ md, onChange }, ref) {
  const box = useRef<HTMLDivElement | null>(null);
  const saved = useRef<Range | null>(null);
  /* 初值只算一次，父组件重渲染时不能把 innerHTML 重新灌进去 */
  const boot = useMemo(() => mdToHtml(md), []);

  const emit = () => {
    const el = box.current;
    if (!el) return;
    onChange(htmlToMd(el.innerHTML));
  };

  /* contenteditable 失焦后选区会丢，点工具栏或右键菜单前得先记住它 */
  useEffect(() => {
    const onSel = () => {
      const s = window.getSelection();
      if (!s || !s.rangeCount || !box.current) return;
      const r = s.getRangeAt(0);
      if (box.current.contains(r.commonAncestorContainer)) saved.current = r.cloneRange();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const run = (cmd: string, arg?: string) => {
    const el = box.current;
    if (!el) return;
    el.focus();
    const s = window.getSelection();
    if (s && saved.current) {
      try {
        s.removeAllRanges();
        s.addRange(saved.current);
      } catch {
        /* 存的区间已经随旧节点废掉，直接用当前光标 */
      }
    }
    document.execCommand(cmd, false, arg);
    if (s && s.rangeCount) saved.current = s.getRangeAt(0).cloneRange();
    emit();
  };

  useImperativeHandle(ref, () => ({ run, focus: () => box.current?.focus() }));

  const link = () => {
    const url = window.prompt("链接地址", "https://");
    if (url && url !== "https://") run("createLink", url);
  };

  return (
    <div className="rve-wrap">
      <div className="rvt" onMouseDown={(e) => e.preventDefault()}>
        {TOOLS.map((t) => (
          <button
            key={t.label}
            className={"rvt-b" + (t.wide ? " wide" : "")}
            title={t.title}
            onClick={() => run(t.cmd, t.arg)}
            type="button"
          >
            {t.label}
          </button>
        ))}
        <button className="rvt-b wide" title="插入链接" onClick={link} type="button">
          链接
        </button>
      </div>
      <div
        ref={box}
        className="md rve"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={emit}
        onBlur={emit}
        dangerouslySetInnerHTML={{ __html: boot }}
      />
    </div>
  );
});

export default RichEditor;
