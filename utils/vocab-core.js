/**
 * utils/vocab-core.js — 生词本纯逻辑模型（REVIEW-TASK 阶段 1，T1.1/T1.3/T1.5）
 *
 * 把 Web 端 useVocabularyNotebook / ReviewModal / renderContext 里的纯函数
 * 部分抽离到独立模块（Node 可直接 require 单测；页面/组件只做 IO 与 setData）：
 *
 * - deriveStats / todayAddedCount：统计与「今日新增」派生（与 /api/vocabulary/add
 *   服务端执法同口径：本地 0 点起按 addedDate 计数）
 * - filterAndSort：筛选语义逐行对齐 Web filteredList（状态 + word/translation
 *   搜索 + 三排序：复习时间 nextReviewAt 升序 / 添加时间 addedDate 降序 / A-Z）
 * - decorateItem：把 VocabularyItem 预计算成 WXML 就绪字段（dueText/defText/
 *   phonetic/contextParts…）——WXML 绑定不支持方法调用，一切派生值须先落 data
 * - splitContext：例句生词高亮分词（renderContext 的 `(word)` 正则切分 + 小写比较）
 * - buildDueQueue / nextIntervalLabel 语义复用 utils/srs：闪卡复习页队列与 SRS 间隔预演
 *   （2026-09-23 四题型模式退役，对齐 Android VocabularyReviewScreen 闪卡流）
 *
 * 配额常量与 Web lib/quota.ts 同源：FREE_VOCABULARY_LIMIT=50、DAILY=5。
 */

const { isDue } = require('./srs');

const FREE_VOCABULARY_LIMIT = 50;
const FREE_VOCABULARY_DAILY_LIMIT = 5;

/** 三格统计（对齐 Web stats useMemo）：due = isDue && status!=='MASTERED' */
function deriveStats(list) {
  const arr = Array.isArray(list) ? list : [];
  return {
    total: arr.length,
    due: arr.filter((v) => isDue(v.nextReviewAt) && v.status !== 'MASTERED')
      .length,
    mastered: arr.filter((v) => v.status === 'MASTERED').length,
  };
}

/** 今日已新增（对齐 Web page.tsx：今日 0 点起按 addedDate 计数） */
function todayAddedCount(list, now) {
  const today = now instanceof Date ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);
  return (Array.isArray(list) ? list : []).filter(
    (v) => v.addedDate && new Date(v.addedDate) >= today,
  ).length;
}

/** 日期徽章文案：对齐 Web formatDate（zh-CN numeric → M/D），空值 N/A */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'N/A';
  return d.getMonth() + 1 + '/' + d.getDate();
}

/**
 * 筛选 + 排序（逐行对齐 Web filteredList）：
 * filter = status 匹配（缺省 LEARNING）+ word/translation 小写包含；
 * sort：review → nextReviewAt||0 升序 / added → addedDate||0 降序 / alpha → localeCompare。
 */
function filterAndSort(list, opts) {
  const { status = 'LEARNING', query = '', sort = 'review' } = opts || {};
  const q = String(query).toLowerCase();
  const result = (Array.isArray(list) ? list : []).filter(
    (v) =>
      (v.status || 'LEARNING') === status &&
      (v.word.toLowerCase().includes(q) ||
        (v.translation ? v.translation.includes(query) : false)),
  );
  switch (sort) {
    case 'added':
      result.sort(
        (a, b) =>
          new Date(b.addedDate || 0).getTime() -
          new Date(a.addedDate || 0).getTime(),
      );
      break;
    case 'alpha':
      result.sort((a, b) => a.word.localeCompare(b.word));
      break;
    case 'review':
    default:
      result.sort(
        (a, b) =>
          new Date(a.nextReviewAt || 0).getTime() -
          new Date(b.nextReviewAt || 0).getTime(),
      );
      break;
  }
  return result;
}

/**
 * 例句生词高亮分词（对齐 renderContext：`(word)` 分组捕获切分，命中段小写比较）。
 * @returns {Array<{text: string, hit: boolean}>} text/word 缺失时返回 []
 */
function splitContext(text, word) {
  if (!text || !word) return [];
  const parts = String(text).split(new RegExp('(' + word + ')', 'gi'));
  return parts
    .filter((p) => p !== '')
    .map((p) => ({
      text: p,
      hit: p.toLowerCase() === word.toLowerCase(),
    }));
}

/**
 * 把 VocabularyItem 预计算成 WXML 就绪的展示字段（原字段保留不动）。
 * 返回新对象（不 mutate 入参，便于列表 diff）。
 */
function decorateItem(item) {
  const dict = item.dictData || null;
  const due = isDue(item.nextReviewAt);
  const mastered = item.status === 'MASTERED';
  const usPhon = (dict && dict.phonetics && dict.phonetics.us) || '';
  const ukPhon = (dict && dict.phonetics && dict.phonetics.uk) || '';
  const inflections = (dict && dict.inflections) || null;
  const ety = (dict && dict.etymology) || null;
  return Object.assign({}, item, {
    due,
    mastered,
    phonetic: usPhon || ukPhon,
    defText:
      (dict && dict.definitions && dict.definitions[0] && dict.definitions[0].meaning_cn) ||
      item.definition ||
      '暂无定义',
    dateText: mastered ? '' : due ? '需要复习' : formatDate(item.nextReviewAt),
    playUrl:
      (dict && dict.audio_urls && (dict.audio_urls.us || dict.audio_urls.uk)) ||
      item.speakUrl ||
      '',
    contextParts: item.contextSentence
      ? splitContext(item.contextSentence, item.word)
      : [],
    // 字典例句的生词高亮分词（WXML 无法方法调用，须预计算）
    dictExamples: (dict && dict.examples
      ? dict.examples
      : []
    ).map((ex) => ({ en: ex.en, cn: ex.cn, context: ex.context, parts: splitContext(ex.en, item.word) })),
    // 原声播放 key（惯例 `${episodeid}:${word}`，WXML 直接比较高亮）
    origKey: item.episodeid ? item.episodeid + ':' + item.word : '',
    // 词形变化 chips：label + 值（Web 五种逐一判空渲染）
    inflChips: !inflections
      ? []
      : [
          { label: '过去式', value: inflections.past_tense },
          { label: '现在分词', value: inflections.present_participle },
          { label: '第三人称单数', value: inflections.third_person_singular },
          { label: '复数', value: inflections.plural },
          { label: '形容词', value: inflections.adjective_form },
        ].filter((c) => !!c.value),
    hasEty: !!(
      ety &&
      (ety.breakdown || ety.mnemonic || ety.root)
    ),
    mmss: item.timestamp
      ? Math.floor(item.timestamp / 60) +
        ':' +
        String(item.timestamp % 60).padStart(2, '0')
      : '',
  });
}

/** 配额双栏卡状态文本（逐字对齐 Web QuotaStatusCard columns 调用处） */
function quotaTexts(total, today) {
  const t = Number(total) || 0;
  const n = Number(today) || 0;
  return {
    primaryStatusText:
      t < FREE_VOCABULARY_LIMIT
        ? t + '/' + FREE_VOCABULARY_LIMIT + ' · 还能收藏' + (FREE_VOCABULARY_LIMIT - t) + '个'
        : t + '/' + FREE_VOCABULARY_LIMIT + ' · 已满 (删除腾位或升级无限)',
    dailyStatusText:
      n >= FREE_VOCABULARY_DAILY_LIMIT
        ? FREE_VOCABULARY_DAILY_LIMIT + '/' + FREE_VOCABULARY_DAILY_LIMIT + ' · 已用完 (升级无限)'
        : n + '/' + FREE_VOCABULARY_DAILY_LIMIT + ' · 剩' + (FREE_VOCABULARY_DAILY_LIMIT - n) + '次',
  };
}

/** 到期队列（对齐 Web startReview / 复习页自取筛 due） */
function buildDueQueue(list) {
  return (Array.isArray(list) ? list : []).filter(
    (v) => isDue(v.nextReviewAt) && v.status !== 'MASTERED',
  );
}

/** 总结页四格统计（对齐 Web summaryStats） */
function summaryStats(results) {
  const arr = Array.isArray(results) ? results : [];
  const count = (q) => arr.filter((r) => r.quality === q).length;
  return {
    forgot: count(0),
    hard: count(1),
    good: count(2),
    easy: count(3),
    total: arr.length,
  };
}

module.exports = {
  FREE_VOCABULARY_LIMIT,
  FREE_VOCABULARY_DAILY_LIMIT,
  isDue,
  deriveStats,
  todayAddedCount,
  formatDate,
  filterAndSort,
  splitContext,
  decorateItem,
  quotaTexts,
  buildDueQueue,
  summaryStats,
};
