import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { BOOK_SEARCH_FIELDS, parseBookSearch, type BookSearchField } from "../../shared/bookSearch";

interface Props {
  value: string;
  onChange: (value: string) => void;
  suggest: (field: BookSearchField, prefix: string, remaining: string) => Promise<string[]>;
  label: string;
  placeholder: string;
}

interface FieldToken {
  start: number;
  end: number;
  prefix: string;
  remaining: string;
  field?: BookSearchField;
}

function tokenAt(value: string, caret: number): FieldToken | null {
  const pattern = /(^|\s)(@([^:\s：]*)(?:[:：]("(?:\\.|""|[^"])*"?|[^\s]*))?)/g;
  for (const match of value.matchAll(pattern)) {
    const start = match.index! + match[1].length;
    const end = start + match[2].length;
    if (caret <= start || caret > end) continue;
    const typed = value.slice(start + 1, caret);
    const colon = typed.search(/[:：]/);
    const remaining = (value.slice(0, start) + value.slice(end)).trim();
    if (colon < 0) return { start, end, prefix: typed, remaining };
    const field = BOOK_SEARCH_FIELDS.find((label) => label === typed.slice(0, colon));
    if (!field) return null;
    const prefix = parseBookSearch("@" + typed).fields[0]?.value || "";
    return { start, end, prefix, remaining, field };
  }
  return null;
}

function quoteValue(value: string): string {
  return /[\s"\\]/.test(value) ? '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '""') + '"' : value;
}

export default forwardRef<HTMLInputElement, Props>(function BookSearchInput({ value, onChange, suggest, label, placeholder }, ref) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!, []);
  const listId = useId();
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [matches, setMatches] = useState<{ key: string; items: string[] }>({ key: "", items: [] });

  const token = useMemo(() => focused && !dismissed && !composing ? tokenAt(value, caret) : null,
    [value, caret, focused, dismissed, composing]);
  const key = token ? JSON.stringify(token) : "";
  const options = !token ? [] : token.field
    ? matches.key === key ? matches.items : []
    : BOOK_SEARCH_FIELDS.filter((field) => field.startsWith(token.prefix));
  const selected = Math.min(active, options.length - 1);

  useEffect(() => {
    if (!token?.field) return;
    const field = token.field;
    let activeRequest = true;
    const timer = window.setTimeout(() => {
      suggest(field, token.prefix, token.remaining).then((items) => {
        if (!activeRequest) return;
        setMatches({ key, items });
        setActive(0);
      }).catch(() => {
        if (activeRequest) setMatches({ key, items: [] });
      });
    }, 140);
    return () => {
      activeRequest = false;
      window.clearTimeout(timer);
    };
  }, [token, key, suggest]);

  const select = (option: string) => {
    if (!token) return;
    const insert = token.field ? "@" + token.field + ":" + quoteValue(option) + " " : "@" + option + ":";
    const tail = value.slice(token.end);
    const nextCaret = token.start + insert.length;
    onChange(value.slice(0, token.start) + insert + (token.field ? tail.trimStart() : tail));
    setCaret(nextCaret);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  return (
    <div className="book-search-box">
      <input
        ref={input}
        className="search"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={selected >= 0 ? listId + "-" + selected : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onFocus={(e) => { setFocused(true); setDismissed(false); setCaret(e.currentTarget.selectionStart ?? value.length); }}
        onBlur={() => setFocused(false)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
          setDismissed(false);
          setActive(0);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(e) => {
          setComposing(false);
          setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
        }}
        onKeyDown={(e) => {
          if (composing || e.nativeEvent.isComposing || !token) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(true);
          } else if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((selected + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
          } else if (e.key === "Enter" && selected >= 0) {
            e.preventDefault();
            e.stopPropagation();
            select(options[selected]);
          }
        }}
      />
      {options.length > 0 ? (
        <div className="book-search-options" id={listId} role="listbox" aria-label={token?.field || "搜索字段"}>
          {options.map((option, index) => (
            <button
              key={option}
              id={listId + "-" + index}
              role="option"
              type="button"
              tabIndex={-1}
              aria-selected={index === selected}
              className={index === selected ? "on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
