/**
 * 系列名的文字处理。放 shared 里是因为主进程与界面都要用，
 * 放在服务层会让 bookService 反过来依赖 seriesService 成环。
 */

/**
 * 系列名里尾部的「系列 / シリーズ / series」是资料里带的分类词，界面上不显示。
 * 三种写法都要认，拉丁语系的系列名此前没去尾缀，界面上原样带着 series。
 */
export function seriesLabel(name: string): string {
  return (
    String(name || "")
      .replace(/\s*(シリーズ|系列|series)\s*$/i, "")
      .trim() || String(name || "")
  );
}

/** 系列名本身可能已经带书名号，外面就不要再套一层《》 */
export function seriesTitle(name: string): string {
  const s = seriesLabel(name);
  return /^[《〈【]/.test(s) ? s : "《" + s + "》";
}

/**
 * 界面上该显示哪个名字。译名有就用译名，没有就退回原名。
 * 系列有两个名字之后，凡是要给人看的场合都走这里，别直接取 name。
 */
export function seriesDisplay(zhName: string, name: string): string {
  const zh = String(zhName || "").trim();
  return zh || String(name || "");
}
