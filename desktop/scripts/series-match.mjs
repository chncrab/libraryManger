/**
 * 把「【未匹配】《X》系列书评」这类条目挂回它所属的系列。
 *
 * 书评文件名是人手起的，系列名是 Notion 抄来的，两边常差一个字，
 * 同一个词在日文汉字与简体字下写法不同。这里只做保守匹配：去掉书名号与「系列」后缀、
 * 把日文繁体异体字归一之后完全相同才算命中，命中多于一本书的系列一律不挂，
 * 宁可留在未匹配池里让人自己点。
 */

/* 常见日文汉字与简体的对应，只收书库里真出现过的字 */
const VARIANTS = {
  戯: "戏", 駆: "驱", 偵: "侦", 暁: "晓", 霧: "雾", 龍: "龙", 黒: "黑",
  讀: "读", 謎: "谜", 劍: "剑", 學: "学", 國: "国", 會: "会", 體: "体",
  點: "点", 無: "无", 時: "时", 島: "岛", 戀: "恋", 澤: "泽", 邊: "边",
  實: "实", 藝: "艺", 醫: "医", 樂: "乐", 車: "车", 馬: "马", 鳥: "鸟"
};

/* 开头的分级词，判等级用，不参与名字比对 */
const GRADE_PREFIX = [
  { p: "神作：", g: "god" },
  { p: "神作:", g: "god" },
  { p: "扫雷：", g: "bomb" },
  { p: "扫雷:", g: "bomb" }
];

export function splitGrade(name) {
  let s = String(name || "").trim();
  for (const { p, g } of GRADE_PREFIX) {
    if (s.startsWith(p)) return { grade: g, name: s.slice(p.length).trim() };
  }
  return { grade: "normal", name: s };
}

export function normalizeSeriesName(name) {
  let s = String(name || "");
  /* 未匹配池里的名字后面还缀着导出时的哈希文件名，先摘掉 */
  s = s.replace(/[【\[]未匹配[】\]]/g, "");
  s = s.replace(/[\s_]*[0-9a-f]{16,}\.md\s*$/i, "");
  s = s.replace(/\.md\s*$/i, "");
  s = s.replace(/[\s_]*[0-9a-f]{16,}\s*$/i, "");
  /* 日文异体字与全角符号先归一到同一套字符 */
  s = s.replace(/[\u3000-\u303f\uff00-\uffef]/g, (c) => c);
  s = s.split("").map((c) => VARIANTS[c] || c).join("");
  /* 书名号、括号、空白都不算信息 */
  s = s.replace(/[《》〈〉【】\[\]（）()「」『』\s·・\-—、,，.。:：&+＋]/g, "");
  /* 尾部的「系列」当作量词剥掉，シリーズ 同理 */
  s = s.replace(/(シリーズ|系列|series|丛书|叢書)+$/i, "");
  return s;
}

/** 一篇书评名跨了多本书或跨了多个系列的，不参与自动挂靠 */
export function isMultiBookName(name) {
  const s = String(name || "");
  return /[-—&+＋]/.test(s) || (s.match(/《/g) || []).length > 1;
}

/**
 * 计算挂靠方案，不改数据。
 * @returns {{id, name, seriesId, seriesName, grade}[]} 能挂的
 */
export function planSeriesMatches(orphans, seriesList) {
  const byName = new Map();
  for (const s of seriesList) {
    for (const raw of [s.name, s.display_name]) {
      const k = normalizeSeriesName(raw);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      if (!byName.get(k).includes(s.id)) byName.get(k).push(s.id);
    }
  }
  const out = [];
  for (const o of orphans) {
    if (!o || !o.md) continue;
    const { grade, name } = splitGrade(o.name);
    if (isMultiBookName(name)) continue;
    const k = normalizeSeriesName(name);
    if (!k) continue;
    const hits = byName.get(k) || [];
    /* 同名系列分属小说与漫画时不知道挂哪边，留给人挑 */
    if (hits.length !== 1) continue;
    const target = seriesList.find((s) => s.id === hits[0]);
    out.push({ id: o.id, name: o.name, seriesId: hits[0], seriesName: target ? target.name : "", grade });
  }
  return out;
}

/** 按方案把未匹配条目改成系列书评，返回实际搬过去的条目 */
export function applySeriesMatches(db, plan) {
  const ins = db.prepare(
    `INSERT INTO reviews (book_id, series_id, md, name, grade, happened_at, file_name, origin, created_at, updated_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const pick = db.prepare("SELECT * FROM orphan_reviews WHERE id = ? AND deleted_at IS NULL");
  const del = db.prepare("UPDATE orphan_reviews SET deleted_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  const done = [];
  const run = db.transaction(() => {
    for (const p of plan) {
      const o = pick.get(p.id);
      if (!o) continue;
      ins.run(p.seriesId, o.md, p.name, o.grade || p.grade, o.happened_at || "", o.file_name || "", o.path || "demo-seed", o.created_at || now, now);
      del.run(now, p.id);
      done.push(p);
    }
  });
  run();
  return done;
}
