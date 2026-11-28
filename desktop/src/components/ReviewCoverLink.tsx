import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, MouseEvent } from "react";
import api, { coverUrl } from "../api";
import { createPortal } from "react-dom";
import type { BookRow } from "../../shared/types";
import "./ReviewCoverLink.css";

interface Props {
  title: string;
  bookId?: string | null;
  seriesId?: number | null;
  onOpenBook: (id: string) => void;
}

type Placement = "follow" | "anchor" | "frozen" | "pinned";

interface GalleryLayout {
  cols: number;
  thumbW: number;
  thumbH: number;
  width: number;
  height: number;
  spacing: number;
}

const OPEN_EVENT = "review-cover-open";
const EDGE = 8;
const OFFSET_X = 16;
const OFFSET_Y = 14;
const LEAVE_GRACE = 480;
const POPUP_GRACE = 320;
const GAP = 12;
const PAD = 18;
const TITLE_H = 22;
const MAX_THUMB = 180;
const ASPECT = 245 / 180;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** Fit every book into the viewport without scrolling: pick the layout with the largest thumbnails. */
function galleryLayout(count: number, viewportW: number, viewportH: number): GalleryLayout {
  const maxW = Math.max(160, Math.min(viewportW - 64, 1600));
  const maxH = Math.max(80, viewportH - EDGE * 2);
  const spacing = Math.min(1, Math.sqrt(maxW * maxH / count) / 42);
  const gap = GAP * spacing;
  const pad = PAD * spacing;
  const titleH = TITLE_H * spacing;
  let best = { cols: 1, rows: count, thumbW: 0, empty: 0 };

  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const contentW = maxW - pad * 2 - (cols - 1) * gap;
    const contentH = maxH - pad * 2 - rows * titleH - (rows - 1) * gap;
    if (contentW <= 0 || contentH <= 0) continue;
    let thumbW = Math.min(MAX_THUMB, contentW / cols);
    const heightLimit = contentH / rows;
    if (thumbW * ASPECT > heightLimit) thumbW = heightLimit / ASPECT;
    if (thumbW <= 0) continue;

    const empty = cols * rows - count;
    const better = best.thumbW === 0 || thumbW > best.thumbW + 0.5
      || (Math.abs(thumbW - best.thumbW) <= 0.5 && empty < best.empty)
      || (Math.abs(thumbW - best.thumbW) <= 0.5 && empty === best.empty && rows < best.rows)
      || (Math.abs(thumbW - best.thumbW) <= 0.5 && empty === best.empty && rows === best.rows && cols > best.cols);
    if (better) best = { cols, rows, thumbW, empty };
  }

  const thumbW = Math.floor(best.thumbW * 100) / 100;
  const thumbH = Math.floor(thumbW * ASPECT * 100) / 100;
  return {
    cols: best.cols,
    thumbW,
    thumbH,
    width: Math.ceil(best.cols * thumbW + (best.cols - 1) * gap + pad * 2),
    height: Math.ceil(best.rows * (thumbH + titleH) + (best.rows - 1) * gap + pad * 2),
    spacing
  };
}

export default function ReviewCoverLink({ title, bookId, seriesId, onOpenBook }: Props) {
  const id = useId();
  const instance = useRef<object>({}).current;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const placement = useRef<Placement>("anchor");
  const pointer = useRef({ x: 0, y: 0 });
  const suppressFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expandedSeries, setExpandedSeries] = useState<number | null>(null);
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [activeBook, setActiveBook] = useState<string | null>(null);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const gallery = seriesId ?? expandedSeries;

  const cancelLeave = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  const close = useCallback(() => {
    cancelLeave();
    placement.current = "follow";
    setOpen(false);
    setPinned(false);
    setExpandedSeries(null);
    setBooks(null);
    setActiveBook(null);
  }, [cancelLeave]);

  const openPopup = useCallback(() => {
    cancelLeave();
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: instance }));
    setOpen(true);
  }, [cancelLeave, instance]);

  const scheduleClose = useCallback((delay: number) => {
    if (pinned) return;
    cancelLeave();
    leaveTimer.current = window.setTimeout(close, delay);
  }, [cancelLeave, close, pinned]);

  const placeFollow = useCallback(() => {
    const panel = popup.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!panel || !anchor) return;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const { x, y } = pointer.current;
    const roomRight = window.innerWidth - EDGE - anchor.right;
    const roomLeft = anchor.left - EDGE;
    const left = roomRight >= w + OFFSET_X ? x + OFFSET_X
      : roomLeft >= w + OFFSET_X ? x - OFFSET_X - w
      : EDGE + (window.innerWidth - w - EDGE * 2) * (x / window.innerWidth);
    const top = window.innerHeight - EDGE - anchor.bottom >= h + OFFSET_Y
      ? y + OFFSET_Y
      : y - OFFSET_Y - h;
    panel.style.left = clamp(left, EDGE, window.innerWidth - w - EDGE) + "px";
    panel.style.top = Math.round(clamp(top, EDGE, window.innerHeight - h - EDGE)) + "px";
  }, []);

  const placeAnchor = useCallback(() => {
    const panel = popup.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!panel || !anchor) return;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let left = anchor.left + anchor.width / 2 - w / 2;
    let top = anchor.bottom + 8;
    if (top + h > window.innerHeight - EDGE) top = anchor.top - h - 8;
    panel.style.left = Math.round(clamp(left, EDGE, window.innerWidth - w - EDGE)) + "px";
    panel.style.top = Math.round(clamp(top, EDGE, window.innerHeight - h - EDGE)) + "px";
  }, []);

  const holdPosition = useCallback(() => {
    const panel = popup.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    panel.style.left = clamp(rect.left, EDGE, window.innerWidth - w - EDGE) + "px";
    panel.style.top = clamp(rect.top, EDGE, window.innerHeight - h - EDGE) + "px";
  }, []);

  useEffect(() => cancelLeave, [cancelLeave]);

  useEffect(() => {
    const sync = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = gallery != null
      ? api.seriesBooks(gallery)
      : bookId ? api.getBook(bookId).then((entry) => entry ? [entry.book] : []) : Promise.resolve([]);
    load.then((rows) => {
      if (!alive) return;
      setBooks(rows);
      setActiveBook((current) => current && rows.some((book) => book.id === current) ? current : rows[0]?.id ?? null);
    }).catch(() => {
      if (alive) setBooks([]);
    });
    return () => { alive = false; };
  }, [open, gallery, bookId]);

  const layout = useMemo(() => {
    if (gallery == null || !books?.length) return null;
    const anchor = trigger.current?.getBoundingClientRect();
    const availableHeight = anchor
      ? Math.max(anchor.top, viewport.h - anchor.bottom) - OFFSET_Y + EDGE
      : viewport.h;
    return galleryLayout(books.length, viewport.w, availableHeight);
  }, [gallery, books, viewport]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const mode = placement.current;
      if (mode === "follow") placeFollow();
      else if (mode === "anchor") placeAnchor();
      else holdPosition();
    };
    const onScroll = () => {
      if (placement.current === "anchor") placeAnchor();
    };
    place();
    if (pinned && placement.current !== "pinned") placement.current = "pinned";
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, layout, pinned, placeFollow, placeAnchor, holdPosition]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (trigger.current?.contains(event.target) || popup.current?.contains(event.target)) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inside = popup.current?.contains(document.activeElement);
      suppressFocus.current = true;
      close();
      if (inside) trigger.current?.focus({ preventScroll: true });
      window.setTimeout(() => { suppressFocus.current = false; }, 0);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  useEffect(() => {
    const another = (event: Event) => {
      if (!open || (event as CustomEvent<unknown>).detail === instance) return;
      close();
    };
    document.addEventListener(OPEN_EVENT, another);
    return () => document.removeEventListener(OPEN_EVENT, another);
  }, [open, close, instance]);

  const rememberPointer = (event: MouseEvent<HTMLButtonElement>) => {
    pointer.current = { x: event.clientX, y: event.clientY };
  };

  const showFollowing = (event: MouseEvent<HTMLButtonElement>) => {
    if (!pinned && document.querySelector(".rv-cover-pop.pinned")) return;
    rememberPointer(event);
    if (placement.current !== "pinned") placement.current = "follow";
    openPopup();
  };

  const follow = (event: MouseEvent<HTMLButtonElement>) => {
    rememberPointer(event);
    if (pinned) return;
    placement.current = "follow";
    if (open) placeFollow();
  };

  const leaveTitle = () => {
    if (pinned) return;
    placement.current = "frozen";
    scheduleClose(LEAVE_GRACE);
  };

  const showAnchored = (event: FocusEvent<HTMLButtonElement>) => {
    if (suppressFocus.current || pinned) return;
    if (document.querySelector(".rv-cover-pop.pinned")) return;
    if (!event.currentTarget.matches(":focus-visible")) return;
    placement.current = "anchor";
    openPopup();
  };

  const pinOrClose = () => {
    if (pinned) {
      close();
      return;
    }
    if (open) placement.current = "pinned";
    else if (placement.current !== "follow") placement.current = "anchor";
    openPopup();
    setPinned(true);
    setActiveBook((current) => current ?? books?.[0]?.id ?? null);
  };

  const popupStyle = layout ? {
    width: layout.width,
    height: layout.height,
    "--rv-cols": String(layout.cols),
    "--rv-thumb-w": layout.thumbW + "px",
    "--rv-thumb-h": layout.thumbH + "px",
    "--rv-gallery-gap": GAP * layout.spacing + "px",
    "--rv-gallery-pad": PAD * layout.spacing + "px",
    "--rv-title-gap": 6 * layout.spacing + "px",
    "--rv-title-h": 16 * layout.spacing + "px"
  } as CSSProperties : undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="rv-cover-name"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-pressed={pinned}
        onMouseEnter={showFollowing}
        onMouseMove={follow}
        onMouseLeave={leaveTitle}
        onFocus={showAnchored}
        onBlur={() => { if (!pinned) scheduleClose(180); }}
        onClick={pinOrClose}
      >
        {title}
      </button>
      {open ? createPortal(
        <div
          ref={popup}
          className={"rv-cover-pop" + (gallery != null ? " gallery" : "") + (pinned ? " pinned" : "")}
          id={id}
          role="group"
          aria-label={title + "的封面"}
          style={popupStyle}
          onMouseEnter={() => {
            cancelLeave();
            if (placement.current === "follow") placement.current = "frozen";
          }}
          onMouseLeave={() => scheduleClose(POPUP_GRACE)}
          onFocus={cancelLeave}
          onBlur={(event) => {
            if (pinned) return;
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose(180);
          }}
        >
          {books?.length ? (
            <div className="rv-cover-grid">
              {books.map((book) => (
                <button
                  key={book.id}
                  className={"rv-cover-item" + (activeBook === book.id ? " active" : "")}
                  type="button"
                  title={book.title}
                  aria-label={"打开" + book.title + "详情"}
                  onMouseEnter={() => setActiveBook(book.id)}
                  onFocus={(event) => {
                    setActiveBook(book.id);
                    if (gallery == null && book.seriesId != null && event.currentTarget.matches(":focus-visible")) {
                      setExpandedSeries(book.seriesId);
                    }
                  }}
                  onClick={() => {
                    close();
                    onOpenBook(book.id);
                  }}
                >
                  <span
                    className="rv-cover-image"
                    onMouseEnter={() => {
                      if (gallery == null && book.seriesId != null) setExpandedSeries(book.seriesId);
                    }}
                  >
                    无封面
                    {book.cover ? (
                      <img
                        src={coverUrl(book.cover, book.coverV)}
                        alt={book.title + "封面"}
                        onError={(event) => { event.currentTarget.hidden = true; }}
                      />
                    ) : null}
                  </span>
                  <span className="rv-cover-title">{book.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="rv-cover-status" role="status">{books ? "未找到关联书目" : "加载封面…"}</span>
          )}
        </div>,
        document.body
      ) : null}
    </>
  );
}
