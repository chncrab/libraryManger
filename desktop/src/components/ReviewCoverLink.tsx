import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

export default function ReviewCoverLink({ title, bookId, seriesId, onOpenBook }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expandedSeries, setExpandedSeries] = useState<number | null>(null);
  const [books, setBooks] = useState<BookRow[] | null>(null);
  const [activeBook, setActiveBook] = useState<string | null>(null);
  const gallery = seriesId ?? expandedSeries;

  const cancelLeave = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);

  const close = useCallback(() => {
    cancelLeave();
    setOpen(false);
    setPinned(false);
    setExpandedSeries(null);
    setBooks(null);
    setActiveBook(null);
  }, [cancelLeave]);

  const show = () => {
    cancelLeave();
    setOpen(true);
  };

  const leave = () => {
    if (pinned) return;
    cancelLeave();
    leaveTimer.current = window.setTimeout(close, 220);
  };

  useEffect(() => cancelLeave, [cancelLeave]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const load = gallery != null
      ? api.seriesBooks(gallery)
      : bookId ? api.getBook(bookId).then((entry) => entry ? [entry.book] : []) : Promise.resolve([]);
    load.then((rows) => {
      if (current) setBooks(rows);
    }).catch(() => {
      if (current) setBooks([]);
    });
    return () => { current = false; };
  }, [open, gallery, bookId]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const panel = popup.current;
      if (!anchor || !panel) return;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - panel.offsetWidth - 8));
      const below = anchor.bottom + 8;
      const above = anchor.top - panel.offsetHeight - 8;
      const top = below + panel.offsetHeight <= window.innerHeight - 8 || above < 8 ? below : above;
      panel.style.left = left + "px";
      panel.style.top = Math.max(8, Math.min(top, window.innerHeight - panel.offsetHeight - 8)) + "px";
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, gallery, books]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="rv-cover-name"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-pressed={pinned}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={leave}
        onClick={() => {
          if (pinned) close();
          else {
            show();
            setPinned(true);
            setActiveBook((current) => current ?? books?.[0]?.id ?? null);
          }
        }}
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
          onMouseEnter={cancelLeave}
          onMouseLeave={leave}
          onFocus={cancelLeave}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}
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
                  onFocus={() => setActiveBook(book.id)}
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
