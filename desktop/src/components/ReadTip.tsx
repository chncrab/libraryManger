import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { gradeIcon, ratingText } from "./GridView";
import type { ReadEntry } from "../../shared/types";

/**
 * 时间线上鼠标停在一本上时浮出来的小卡，横排竖排共用。
 *
 * 位置钉在封面外侧，不跟光标：横排上轨朝上、下轨朝下，竖排左列朝左、
 * 右列朝右，正好落在整块外头的空白里，不压住正在看的那本。
 * 贴着窗口边就收回来一点，免得半截露在外面。
 * 挂在 body 上：轴那块 overflow 裁得紧，rail 又带 transform，
 * 固定定位落在里面会跟着一起动。
 */
export interface TipAnchor {
  x: number;
  y: number;
  side: "top" | "bottom" | "left" | "right";
}

interface Props {
  e: ReadEntry | null;
  anchor: TipAnchor | null;
}

const GAP = 10;

export default function ReadTip({ e, anchor }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  const place = () => {
    const el = boxRef.current;
    if (!el || !anchor) return;
    const r = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor.side === "top") {
      left = anchor.x - r.width / 2;
      top = anchor.y - r.height - GAP;
    } else if (anchor.side === "bottom") {
      left = anchor.x - r.width / 2;
      top = anchor.y + GAP;
    } else if (anchor.side === "right") {
      left = anchor.x + GAP;
      top = anchor.y - r.height / 2;
    } else {
      left = anchor.x - r.width - GAP;
      top = anchor.y - r.height / 2;
    }
    left = Math.min(Math.max(8, left), window.innerWidth - r.width - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - r.height - 8);
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.visibility = "visible";
  };

  useLayoutEffect(place, [e, anchor]);

  if (!e) return null;

  const grade = gradeIcon(e.reviewGrade);
  const rating = ratingText(e.rating);
  const series = e.seriesName ? e.seriesName + (e.seriesIndex != null ? " " + e.seriesIndex : "") : "";

  return createPortal(
    <div className="rd-tip" ref={boxRef}>
      <div className="rd-tip-h">
        <span className="rd-tip-t">{e.title}</span>
        {grade ? <span className="rd-tip-g">{grade}</span> : null}
      </div>
      {e.authors.length || series ? (
        <div className="rd-tip-a">{[e.authors.join("、"), series].filter(Boolean).join(" · ")}</div>
      ) : null}
      <div className="rd-tip-kv">
        <span>起止</span>
        <b>{e.span ? e.start + " 至 " + e.end : e.anchor}</b>
        <span>用时</span>
        <b>{e.span ? e.days + " 天" : "当天读完"}</b>
        {rating ? (
          <>
            <span>评分</span>
            <b className="rd-tip-r">★ {rating}</b>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
