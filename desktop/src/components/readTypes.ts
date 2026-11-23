/** 横排、竖排共用的命令句柄。ReadView 的「今天 / ± / 日期定位」按当前排布调它 */
export interface ReadTimelineHandle {
  /** 把某一天摆到视野中间 */
  seekDay(day: number): void;
  /** 以视野中心为锚缩放一档 */
  zoomBy(factor: number): void;
}
