const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const DEFAULT_FILTERS = Object.freeze({ maxWords: 10, maxWpm: 100, level: 'A2,B1,B2' });
const RANGES = [
  ['minWords', 'maxWords', '单词数'],
  ['minWpm', 'maxWpm', '原声语速'],
];

function parseFilters(draft = {}) {
  const filters = {};
  for (const [low, high, label] of RANGES) {
    for (const field of [low, high]) {
      const raw = String(draft[field] == null ? '' : draft[field]).trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || n < 1 || n > 2147483647) {
        return { error: label + '请填写有效正整数', field: low };
      }
      filters[field] = n;
    }
    if (filters[low] > filters[high]) return { error: label + '下限不能大于上限', field: low };
  }
  const selected = String(draft.level || '').split(',');
  const levels = LEVELS.filter((level) => selected.includes(level));
  if (levels.length) filters.level = levels.join(',');
  return { filters };
}

function filterKey(filters) {
  return Object.keys(filters).map((k) => k + '=' + encodeURIComponent(filters[k])).join('&');
}

// 与卡片渲染顺序一致：有词级时间轴时展示 word，否则展示英文字幕。
// 单条时间戳可能包含整段短语，不能以数组长度作为词数。
function matchesFilters(clip, filters = {}) {
  if (filters.level && !filters.level.split(',').includes(clip.difficulty)) return false;
  if (filters.minWpm || filters.maxWpm) {
    const wpm = Number(clip.wpm);
    if (!Number.isFinite(wpm) || wpm <= 0 || wpm < filters.minWpm || wpm > filters.maxWpm) return false;
  }
  if (filters.minWords || filters.maxWords) {
    const line = Array.isArray(clip.words) && clip.words.length
      ? clip.words.map((w) => w && w.word).join(' ')
      : clip.textEn || '';
    const words = line.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:['’‐‑-][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*/g);
    if (!words || words.length < filters.minWords || words.length > filters.maxWords) return false;
  }
  return true;
}

module.exports = { LEVELS, DEFAULT_FILTERS, parseFilters, filterKey, matchesFilters };
