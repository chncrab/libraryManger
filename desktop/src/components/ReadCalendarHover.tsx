import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { coverUrl } from "../api";
import { dayStr, readBounds } from "../../shared/readScale";
import type { ReadEntry } from "../../shared/types";

/**
 * 日历书目浮层。月历与全年共用：
 *
 * - 悬停：跟着光标，pointer-events: none，鼠标永远不会掉进浮层里与格子的
 *   leave 打架。位置只改 transform，不按像素重渲整张日历。
 * - 固定（pin）：点有书的日期后停在那一刻，role="dialog"，卡片是真按钮；
 *   外部指针按下、Esc、换月换年或换视图才收起。滚动时保持视口定位，
 *   窗口缩放重新夹回视口内。固定后不再按行数截断，全部书目在浮层里滚动。
 *
 * 卡片带真封面；没有封面时用书名首字与纸脊做一个安静的占位。浮层挂在 body
 * 上，避免被日历滚动区裁切。
 */
export interface ReadHoverPinOpts {
  /** 键盘激活时把焦点送进第一张卡片；鼠标固定不抢焦点 */
  keyboard?: boolean;
}

export interface ReadHoverHandle {
  show(day: number, books: ReadEntry[], x: number, y: number): void;
  move(x: number, y: number): void;
  hide(): void;
  pin(day: number, books: ReadEntry[], x: number, y: number, opts?: ReadHoverPinOpts): void;
  unpin(): void;
}

interface Props {
  /** 悬停浮层因滚动、点击、窗口变化自己收起时通知外面清掉悬停标记 */
  onHidden?: () => void;
  /** 固定状态变化；日历据此维护选中格的 aria 与清理时机 */
  onPinChange?: (day: number | null) => void;
  /** 固定浮层里点书：交给 ReadView 打开原来的详情抽屉 */
  onPick?: (id: string) => void;
}

/** 竖版卡片：封面在上，书名/作者/起止日期在下 */
const CARD_W = 150;
const COL_GAP = 10;
/** 一张竖版卡片的保守高度：约 162px 封面、三行标题、作者、可换行日期与内边距 */
const ROW_H = 316;
/** 光标到浮层的间距 */
const GAP = 16;
const MAX_COLS = 4;
/** 浮层左右内边距之和（12 + 12），与 readViews.css 保持一致 */
const POP_PAD = 24;
/** 浮层与视口边缘的最小距离 */
const POP_MARGIN = 16;

function rangeText(e: ReadEntry): string {
  const b = readBounds(e);
  if (!Number.isFinite(b.a) || !Number.isFinite(b.b)) return "日期未填";
  if (b.onlyStart) return "开始于 " + dayStr(b.a);
  if (b.a === b.b) return dayStr(b.a);
  return dayStr(b.a) + " 至 " + dayStr(b.b);
}

function columnsFor(total: number, vw: number): number {
  const want = total <= 3 ? total : total <= 8 ? 2 : total <= 15 ? 3 : MAX_COLS;
  const fit = Math.max(
    1,
    Math.floor((vw - POP_PAD - POP_MARGIN + COL_GAP) / (CARD_W + COL_GAP))
  );
  return Math.max(1, Math.min(want, fit, MAX_COLS));
}

/** 小屏时把列宽压到视口里，封面靠 CSS 等比缩，桌面仍保持 150px 卡宽 */
function cardWidthFor(cols: number, vw: number): number {
  const avail = vw - POP_PAD - POP_MARGIN - (cols - 1) * COL_GAP;
  return Math.max(96, Math.min(CARD_W, Math.floor(avail / cols)));
}

function cardBody(e: ReadEntry) {
  const ch = e.title.trim().slice(0, 1) || "书";
  return (
    <>
      <span className="rd-cal-hover-cover" aria-hidden="true">
        {e.cover ? (
          <img src={coverUrl(e.cover, e.coverV)} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="rd-cal-hover-ph">{ch}</span>
        )}
      </span>
      <span className="rd-cal-hover-btxt">
        <span className="rd-cal-hover-t">{e.title}</span>
        {e.authors.length ? <span className="rd-cal-hover-a">{e.authors.join("、")}</span> : null}
        <span className="rd-cal-hover-d">{rangeText(e)}</span>
      </span>
    </>
  );
}

const ReadCalendarHover = forwardRef<ReadHoverHandle, Props>(function ReadCalendarHover(
  { onHidden, onPinChange, onPick },
  ref
) {
  const [group, setGroup] = useState<{ day: number; books: ReadEntry[] } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [vp, setVp] = useState(() => ({
    w: typeof window === "undefined" ? 1280 : window.innerWidth,
    h: typeof window === "undefined" ? 800 : window.innerHeight
  }));
  const groupRef = useRef<{ day: number; books: ReadEntry[] } | null>(null);
  const pinnedRef = useRef(false);
  const focusFirst = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onHiddenRef = useRef(onHidden);
  const onPinChangeRef = useRef(onPinChange);
  const onPickRef = useRef(onPick);

  useEffect(() => {
    onHiddenRef.current = onHidden;
    onPinChangeRef.current = onPinChange;
    onPickRef.current = onPick;
  });

  /** 指针是否落在浮层对应的那个日期格上：同一天按下不收起，交给 click 去固定 */
  const onSourceDay = useCallback((t: EventTarget | null) => {
    const g = groupRef.current;
    if (!g || !(t instanceof Element)) return false;
    const cell = t.closest(".rd-cal-cell[data-day]");
    return !!cell && cell.getAttribute("data-day") === dayStr(g.day);
  }, []);

  const place = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { x, y } = posRef.current;
    let left = x + GAP;
    let top = y + GAP;
    /* 贴着右边/下边就翻到光标另一侧，再夹回视口内 */
    if (left + w > vw - 8) left = x - w - GAP;
    if (top + h > vh - 8) top = y - h - GAP;
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8));
    el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }, []);

  const hide = useCallback(() => {
    if (pinnedRef.current) return;
    if (!groupRef.current) return;
    groupRef.current = null;
    setGroup(null);
    onHiddenRef.current?.();
  }, []);

  const show = useCallback((day: number, books: ReadEntry[], x: number, y: number) => {
    /* 固定期间任何鼠标移动都不改浮层 */
    if (pinnedRef.current || !books.length) return;
    posRef.current = { x, y };
    const next = { day, books };
    groupRef.current = next;
    setGroup(next);
  }, []);

  const move = useCallback(
    (x: number, y: number) => {
      if (pinnedRef.current) return;
      posRef.current = { x, y };
      place();
    },
    [place]
  );

  const pin = useCallback(
    (day: number, books: ReadEntry[], x: number, y: number, opts?: ReadHoverPinOpts) => {
      if (!books.length) return;
      /* 已经固定在同一天：保留原位置与原 DOM，不重放入场动画 */
      if (pinnedRef.current && groupRef.current?.day === day) return;
      posRef.current = { x, y };
      focusFirst.current = !!opts?.keyboard;
      returnFocus.current = opts?.keyboard && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setVp({ w: window.innerWidth, h: window.innerHeight });
      const next = { day, books };
      groupRef.current = next;
      pinnedRef.current = true;
      setPinned(true);
      setGroup(next);
      onPinChangeRef.current?.(day);
    },
    []
  );

  const unpin = useCallback(() => {
    if (!pinnedRef.current) return;
    pinnedRef.current = false;
    groupRef.current = null;
    setPinned(false);
    setGroup(null);
    onPinChangeRef.current?.(null);
  }, []);

  useImperativeHandle(ref, () => ({ show, move, hide, pin, unpin }), [show, move, hide, pin, unpin]);

  useLayoutEffect(place, [group, place, vp]);

  /* 键盘固定后把焦点送进第一张卡；鼠标固定不抢焦点，也没有焦点陷阱 */
  useLayoutEffect(() => {
    if (!pinned || !focusFirst.current) return;
    focusFirst.current = false;
    const el = boxRef.current?.querySelector<HTMLElement>(".rd-cal-hover-card");
    el?.focus({ preventScroll: true });
  }, [group, pinned]);

  /* 悬停时滚动、窗口变化收起；指针按下只收不在当前日期格上的，免得点日期时先闪掉 */
  useEffect(() => {
    if (!group || pinned) return;
    const close = () => hide();
    const onDown = (ev: PointerEvent) => {
      if (onSourceDay(ev.target)) return;
      hide();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", close);
    };
  }, [group, pinned, hide, onSourceDay]);

  /* 固定时：只在浮层外按下才收起；源日期格上再按一次保留浮层，由 click 原样重固定 */
  useEffect(() => {
    if (!pinned) return;
    const onDown = (ev: PointerEvent) => {
      const el = boxRef.current;
      const t = ev.target;
      if (el && t instanceof Node && el.contains(t)) return;
      if (onSourceDay(t)) return;
      unpin();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      unpin();
      returnFocus.current?.focus({ preventScroll: true });
    };
    const onResize = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      place();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [pinned, unpin, place, onSourceDay]);

  if (!group) return null;

  const total = group.books.length;
  const vw = pinned ? vp.w : window.innerWidth || 1280;
  const vh = pinned ? vp.h : window.innerHeight || 800;
  const cols = columnsFor(total, vw);
  const cardW = cardWidthFor(cols, vw);
  /* 固定后不截断：全部书目都在可滚动的浮层里；悬停只放得下几行就封顶 */
  const rows = pinned ? total : Math.max(1, Math.floor((vh - 140) / ROW_H));
  const maxCards = pinned ? total : Math.min(total, cols * rows);
  const shown = group.books.slice(0, maxCards);
  const rest = total - shown.length;

  return createPortal(
    <div
      className="rd-cal-hover"
      ref={boxRef}
      data-pinned={pinned ? "true" : undefined}
      role={pinned ? "dialog" : undefined}
      aria-label={pinned ? `${dayStr(group.day)} 在读书目` : undefined}
      aria-hidden={pinned ? undefined : true}
      id={pinned ? "rd-cal-popup" : undefined}
      tabIndex={pinned ? -1 : undefined}
    >
      <div className="rd-cal-hover-head">
        <b>{dayStr(group.day)}</b>
        <span>在读 {total} 本</span>
        {pinned ? <span className="rd-cal-hover-hint">点卡片打开详情 · Esc 关闭</span> : null}
      </div>
      <div
        className="rd-cal-hover-body"
        style={{ gridTemplateColumns: `repeat(${cols}, ${cardW}px)` }}
      >
        {shown.map((e) => (
          <button
            type="button"
            className="rd-cal-hover-card"
            key={e.id}
            data-book={e.id}
            tabIndex={pinned ? 0 : -1}
            onClick={
              pinned
                ? () => {
                    onPickRef.current?.(e.id);
                    unpin();
                  }
                : undefined
            }
          >
            {cardBody(e)}
          </button>
        ))}
      </div>
      {rest > 0 ? (
        <div className="rd-cal-hover-more">
          还有 {rest} 本，点日期固定后可查看全部
        </div>
      ) : null}
    </div>,
    document.body
  );
});

export default ReadCalendarHover;
