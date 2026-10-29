/**
 * utils/dict-tool — 查词工具纯函数（工具化转型）
 *
 * - splitHighlight：例句中命中词的三段切分（WXML 零方法调用红线，
 *   高亮段由 JS 预计算为 parts 数组）
 * - buildCorpusExampleVms：/api/dict 响应 corpusExamples → 弹层视图模型
 *   （弹层内只展示静态文本，播放隔离到训练室）
 * - pickSuggestions：首页灵感胶囊随机抽样（不重复、避开当前展示集）
 * - isWordQuery：搜索分流判定（英文单词/短语 → 词典；其余 → 语境检索）
 *
 * 查词记录走本地存储（dictHistory*），最多 50 条、新查置顶去重。
 */

const HISTORY_KEY = 'dict-history';
const HISTORY_MAX = 50;

/** 例句命中词三段切分：before / hit(高亮) / after；未命中返回整句单段 */
function splitHighlight(text, word) {
  const t = String(text || '');
  const w = String(word || '').trim();
  if (!t || !w) return [{ t, hl: false }];
  const idx = t.toLowerCase().indexOf(w.toLowerCase());
  if (idx < 0) return [{ t, hl: false }];
  return [
    { t: t.slice(0, idx), hl: false },
    { t: t.slice(idx, idx + w.length), hl: true },
    { t: t.slice(idx + w.length), hl: false },
  ].filter((p) => p.t !== '');
}

/** corpusExamples（后端字段）→ 弹层视图模型：{clipid, zh, parts} */
function buildCorpusExampleVms(examples, word) {
  if (!Array.isArray(examples)) return [];
  return examples
    .filter((e) => e && e.clipid && e.enText)
    .slice(0, 2)
    .map((e) => ({
      clipid: e.clipid,
      enText: e.enText,
      zh: e.zhText || '',
      parts: splitHighlight(e.enText, word),
    }));
}

/** 灵感胶囊随机抽样：count 枚、不重复、尽量避开 excludeLabels */
function pickSuggestions(pool, count, excludeLabels) {
  const exclude = excludeLabels || [];
  const avail = (pool || []).filter((p) => exclude.indexOf(p.label) < 0);
  const src = (avail.length >= count ? avail : (pool || [])).slice();
  const out = [];
  while (out.length < count && src.length > 0) {
    out.push(src.splice(Math.floor(Math.random() * src.length), 1)[0]);
  }
  return out;
}

/** 英文单词/短语判定（≤40 字符，字母开头，允许空格/连字符/撇号） */
function isWordQuery(q) {
  return /^[a-zA-Z][a-zA-Z'\- ]{0,39}$/.test(String(q || '').trim());
}

/**
 * 统一下游 Query（语义搜索改造）：剥离装饰前缀，提取最干净的意图词。
 * - 任意数量的前导 # 一律剥掉（灵感胶囊 label 直接入检索）
 * - 「#查单词: xxx / 查单词：xxx」保留查单词语义 → 返回英文词本体
 */
function cleanSearchQuery(raw) {
  const q = String(raw || '').trim();
  const wordMatch = q.match(/^#+\s*查单词[:：]\s*(.+)$/);
  if (wordMatch) return wordMatch[1].trim();
  return q.replace(/^#+\s*/, '').trim();
}

/* ─────────── 查词记录（本地存储） ─────────── */

function dictHistoryList(storage) {
  try {
    const raw = (storage || wx).getStorageSync(HISTORY_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

/** 记录一次查词：置顶去重，最多 50 条；返回最新列表 */
function dictHistoryRecord(word, storage) {
  const w = String(word || '').trim();
  if (!w) return dictHistoryList(storage);
  const list = dictHistoryList(storage).filter((x) => x !== w);
  list.unshift(w);
  const capped = list.slice(0, HISTORY_MAX);
  try {
    (storage || wx).setStorageSync(HISTORY_KEY, capped);
  } catch (e) {
    /* 存储失败静默 */
  }
  return capped;
}

function dictHistoryClear(storage) {
  try {
    (storage || wx).removeStorageSync(HISTORY_KEY);
  } catch (e) {
    /* 静默 */
  }
  return [];
}

module.exports = {
  splitHighlight,
  buildCorpusExampleVms,
  pickSuggestions,
  isWordQuery,
  cleanSearchQuery,
  dictHistoryList,
  dictHistoryRecord,
  dictHistoryClear,
  HISTORY_MAX,
};
