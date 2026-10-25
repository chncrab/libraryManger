import { coverUrl } from "../api";
import type { BookRow } from "../../shared/types";

const GRADE_ICON: Record<string, string> = { god: "❤️", normal: "🤍", mine: "💣", bomb: "💣" };

export function gradeIcon(grade: string | null): string {
  if (!grade) return "";
  return GRADE_ICON[grade] || (grade === "bad" ? "💣" : "");
}

export function ratingText(v: number | null): string {
  return v && v > 0 ? v.toFixed(1) : "";
}

interface GridProps {
  rows: BookRow[];
  selected: string[];
  onSelect: (id: string, multi?: boolean) => void;
  onCtx: (e: React.MouseEvent, b: BookRow) => void;
}

export default function GridView({ rows, selected, onSelect, onCtx }: GridProps) {
  return (
    <div className="grid">
      {rows.map((b) => (
        <div
          key={b.id}
          className={"card" + (selected.includes(b.id) ? " on" : "")}
          onClick={(e) => onSelect(b.id, e.shiftKey || e.ctrlKey || e.metaKey)}
          onContextMenu={(e) => onCtx(e, b)}
          title={b.title}
        >
          {b.cover ? (
            <img className="cov" src={coverUrl(b.cover)} alt="" loading="lazy" />
          ) : (
            <div className="cov empty">无封面</div>
          )}
          <div className="t">
            {gradeIcon(b.reviewGrade) && <span className="grade">{gradeIcon(b.reviewGrade)}</span>}
            {b.title}
          </div>
          <div className="s">{b.authors[0] || b.seriesName}</div>
        </div>
      ))}
    </div>
  );
}
