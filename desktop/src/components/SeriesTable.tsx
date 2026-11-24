import type { SeriesInfo } from "../../shared/types";

/** 系列表格：一行一个系列。册数、已读、均分与系列卡一致，点行开系列详情 */
export default function SeriesTable({ list, onOpen }: { list: SeriesInfo[]; onOpen: (s: SeriesInfo) => void }) {
  if (!list.length) return <div className="empty">没有符合条件的系列</div>;
  return (
    <table className="table sertable">
      <thead>
        <tr>
          <th>系列名</th>
          <th>原名</th>
          <th className="sertable-num">册数</th>
          <th className="sertable-num">已读</th>
          <th className="sertable-num">均分</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => (
          <tr
            key={s.id}
            tabIndex={0}
            title="打开系列详情"
            onClick={() => onOpen(s)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(s);
              }
            }}
          >
            <td className="title">{s.label}</td>
            <td className="dim">{s.original && s.original !== s.label ? s.original : ""}</td>
            <td className="sertable-num">{s.n}</td>
            <td className="sertable-num">{s.read}</td>
            <td className="sertable-num">{s.avg != null ? s.avg.toFixed(1) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
