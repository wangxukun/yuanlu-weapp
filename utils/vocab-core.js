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
 * - splitContext / splitHidden：例句生词高亮 / 填空挖空分词（对齐 renderContext
 *   的 `(word)` 正则切分 + 小写比较）
 * - buildDueQueue / assignMode / generateChoiceOptions / checkAnswer /
 *   summaryStats：复习页四题型纯逻辑（随机性经 rng 参数注入，测试可复现）
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
 * 填空题挖空分词（对齐 renderContext(text, word, true)：命中段变槽位，
 * 槽宽随词长——Web `max(word.length*14, 60)px` 折算 rpx ×2）。
 * 非命中段合并相邻 text 减少节点数。
 * @returns {Array<{type: 'text'|'slot', text: string, width?: number}>}
 */
function splitHidden(text, word) {
  const segs = splitContext(text, word);
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (!seg.hit && last && last.type === 'text') {
      last.text += seg.text;
    } else if (seg.hit) {
      out.push({
        type: 'slot',
        text: seg.text,
        width: Math.max(Math.min(seg.text.length, 16) * 28, 120),
      });
    } else {
      out.push({ type: 'text', text: seg.text });
    }
  }
  return out;
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
    // 猜词题英文释义（对齐 Web definitions.find(d => d.meaning_en)，未必是第 0 条）
    guessDef: dict && dict.definitions
      ? dict.definitions.find((d) => d.meaning_en) || null
      : null,
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

/* ==================== 复习页四题型（ReviewModal 纯逻辑） ==================== */

const REVIEW_MODES = {
  FILL_BLANK: 'fill_blank',
  MULTIPLE_CHOICE: 'choice',
  CN_TO_EN: 'cn_to_en',
  DEF_GUESS: 'def_guess',
};

const MODE_LABELS = {
  fill_blank: '填空',
  choice: '选择',
  cn_to_en: '中译英',
  def_guess: '猜词',
};

/** 到期队列（对齐 Web startReview / 复习页自取筛 due） */
function buildDueQueue(list) {
  return (Array.isArray(list) ? list : []).filter(
    (v) => isDue(v.nextReviewAt) && v.status !== 'MASTERED',
  );
}

/**
 * 四题型按数据可用性随机分配（对齐 Web assignMode）：
 * 填空需 contextSentence；选择需队列 ≥4 且有释义；中译英需中文释义；
 * 猜词需英文释义；全不可用兜底中译英。rng 注入供测试。
 */
function assignMode(item, queueLength, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const dict = item.dictData;
  const available = [];
  if (item.contextSentence) available.push(REVIEW_MODES.FILL_BLANK);
  if (
    queueLength >= 4 &&
    ((dict && dict.definitions && dict.definitions.length) || item.definition)
  ) {
    available.push(REVIEW_MODES.MULTIPLE_CHOICE);
  }
  if (
    (dict && dict.definitions && dict.definitions.some((d) => d.meaning_cn)) ||
    item.definition
  ) {
    available.push(REVIEW_MODES.CN_TO_EN);
  }
  if (dict && dict.definitions && dict.definitions.some((d) => d.meaning_en)) {
    available.push(REVIEW_MODES.DEF_GUESS);
  }
  if (available.length === 0) available.push(REVIEW_MODES.CN_TO_EN);
  return available[Math.floor(rand() * available.length)];
}

/**
 * 选择题选项（对齐 Web generateChoiceOptions）：正确释义 + 队列内干扰项
 * （去重）洗牌取 3，不足补「释义 N」；四选项整体洗牌，记录正确下标。
 */
function generateChoiceOptions(queue, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  };
  return queue.map((item, idx) => {
    const correctDef =
      (item.dictData &&
        item.dictData.definitions &&
        item.dictData.definitions[0] &&
        item.dictData.definitions[0].meaning_cn) ||
      item.definition ||
      item.word;
    const otherDefs = queue
      .filter((_, i) => i !== idx)
      .map(
        (other) =>
          (other.dictData &&
            other.dictData.definitions &&
            other.dictData.definitions[0] &&
            other.dictData.definitions[0].meaning_cn) ||
          other.definition ||
          other.word,
      )
      .filter((d) => d && d !== correctDef);
    const distractors = shuffle(otherDefs.slice()).slice(0, 3);
    while (distractors.length < 3) {
      distractors.push('释义 ' + (distractors.length + 1));
    }
    const allChoices = shuffle([correctDef].concat(distractors));
    return {
      choices: allChoices,
      correctIndex: allChoices.indexOf(correctDef),
    };
  });
}

/** 填空/中译英/猜词答案判定（大小写与首尾空格不敏感，对齐 Web） */
function checkAnswer(input, word) {
  if (!input || !word) return false;
  return (
    input.toLowerCase().trim() === String(word).toLowerCase().trim()
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
  REVIEW_MODES,
  MODE_LABELS,
  isDue,
  deriveStats,
  todayAddedCount,
  formatDate,
  filterAndSort,
  splitContext,
  splitHidden,
  decorateItem,
  quotaTexts,
  buildDueQueue,
  assignMode,
  generateChoiceOptions,
  checkAnswer,
  summaryStats,
};
