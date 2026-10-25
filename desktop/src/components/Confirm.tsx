import { useEffect } from "react";

interface Props {
  text: string;
  okText?: string;
  onOk: () => void;
  onCancel: () => void;
}

/* 二次确认，和右键菜单同一套配色。不用原生 confirm，原生框在 Electron 里样式割裂 */
export default function Confirm({ text, okText = "删除", onOk, onCancel }: Props) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onOk();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onOk, onCancel]);

  return (
    <>
      <div className="mask on" onClick={onCancel} />
      <div className="cfm">
        <div className="cfm-t">{text}</div>
        <div className="cfm-b">
          <button className="mini" onClick={onCancel}>
            取消
          </button>
          <button className="mini danger" onClick={onOk}>
            {okText}
          </button>
        </div>
      </div>
    </>
  );
}
