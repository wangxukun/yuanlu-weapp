/**
 * utils/sentence-core.js — 句子本纯逻辑模型（REVIEW-TASK 阶段 2，T2.1）
 *
 * 把 Web 端句子本的数据语义抽离到独立模块（Node 可直接 require 单测；
 * 页面/组件只做 IO 与 setData），源文件逐一对齐：
 *
 * - parseSentences / normalizeSentence：GET /api/sentences/list → SavedSentenceItem[]
 *   归一（core/sentences/dto.ts 字段形状 + toList createAt desc 服务端排序保持不动）
 * - escapeRegex / filterLinkedVocabWords：生词本 × 收藏句交集（"联动词汇"），
 *   逐行移植 core/sentences/linked-vocab.ts（\b 词边界、忽略大小写、trim、
 *   小写词形去重——vocabulary 表对 word 无唯一约束）
 * - buildHighlightSegments：英文原句生词高亮分词，移植 components/sentence/
 *   VocabularyHighlighter.tsx（trim→过滤空→词长降序拼 \b(?:a|b)\b 组合正则 gi
 *   split，命中段小写等值比较；命中段附 title「生词本收录：释义/已加入生词本」）
 * - decorateSentence：WXML 就绪字段预计算（enParts 高亮段 / startText / 标签 /
 *   hasSubtitle 跟读可用性——WXML 绑定零方法调用红线）
 * - allTags / episodeOptions / deriveStats：统计三格与筛选候选派生
 *   （SentenceNotebook.tsx allTags Set 去重 / episodeOptions 首见 Map 保序）
 * - filterSentences：搜索四路匹配（enText/zhText/note/tags 小写 substring）+
 *   剧集/标签筛选，逐行对齐 Web filteredList（= 服务端 getSavedSentences 的
 *   客户端等价实现）
 * - evalQuotaView / quotaTexts：评测配额展示口径（Math.min(used, limit) 封顶，
 *   +1 buffer 不对外泄露）与容量/日池双栏文案（逐字对齐 Web QuotaStatusCard
 *   调用处——注意与生词本文案的空格/括号差异）
 *
 * 配额常量与 Web lib/quota.ts 同源：FREE_SENTENCE_LIMIT=30、评测日池=5。
 */

const FREE_SENTENCE_LIMIT = 30;
const FREE_REVIEW_EVALUATIONS_PER_DAY = 5;

/** 正则元字符转义（linked-vocab.ts escapeRegex 同款） */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 复选/空值兜底的条目归一（tags 缺省 []、note/zhText null 保持 null 语义） */
function normalizeSentence(item) {
  const src = item || {};
  return {
    id: src.id,
    episodeid: src.episodeid || '',
    episodeTitle: src.episodeTitle || '',
    podcastTitle: src.podcastTitle || null,
    subtitleId: typeof src.subtitleId === 'number' ? src.subtitleId : null,
    startTime: Number(src.startTime) || 0,
    endTime: Number(src.endTime) || 0,
    enText: src.enText || '',
    zhText: src.zhText || null,
    note: src.note || null,
    tags: Array.isArray(src.tags) ? src.tags : [],
    createAt: src.createAt || '',
    updateAt: src.updateAt || '',
  };
}

/** GET /api/sentences/list 信封解析：非数组/失败 → []，逐条归一（排序保持服务端 createAt desc） */
function parseSentences(res) {
  const data = res && res.success && Array.isArray(res.data) ? res.data : [];
  return data.map(normalizeSentence);
}

/**
 * 生词本词汇 × 收藏句子的真实交集（"联动词汇"，linked-vocab.ts 逐行移植）：
 * 小写词形去重后按 \b 词边界、忽略大小写匹配任意句子 enText。
 * @param vocabWords Array<{word, definition?}>
 * @param sentences Array<{enText}>
 */
function filterLinkedVocabWords(vocabWords, sentences) {
  const words = Array.isArray(vocabWords) ? vocabWords : [];
  const sents = Array.isArray(sentences) ? sentences : [];
  if (words.length === 0 || sents.length === 0) return [];

  const regexCache = {};
  const seen = {};

  return words.filter(function (v) {
    const word = String(v.word || '').trim();
    if (!word) return false;

    const key = word.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;

    let re = regexCache[key];
    if (!re) {
      re = new RegExp('\\b' + escapeRegex(word) + '\\b', 'i');
      regexCache[key] = re;
    }
    return sents.some(function (s) {
      return re.test(s.enText || '');
    });
  });
}

/**
 * 英文原句生词高亮分词（VocabularyHighlighter.tsx 逐行移植）：
 * 词表 trim→滤空→词长降序拼组合正则 `(\b(?:w1|w2…)\b)` gi 切分；
 * 段命中 = 词表存在小写等值词（split 捕获组保证命中段完整还原）。
 * 命中段附 title：`生词本收录：${definition || '已加入生词本'}`（mark 的 title 提示）。
 * @returns {Array<{text: string, hit: boolean, title?: string}>} 无词表/无命中时整段单条
 */
function buildHighlightSegments(text, linkedWords) {
  const str = String(text || '');
  const words = Array.isArray(linkedWords) ? linkedWords : [];
  if (!str || words.length === 0) {
    return str ? [{ text: str, hit: false }] : [];
  }

  const escapedWords = words
    .map(function (w) {
      return String(w.word || '').trim();
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return b.length - a.length;
    });
  if (escapedWords.length === 0) {
    return [{ text: str, hit: false }];
  }

  const pattern =
    '(\\b(?:' + escapedWords.map(escapeRegex).join('|') + ')\\b)';
  const parts = str.split(new RegExp(pattern, 'gi'));

  const segments = [];
  for (var i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const lower = part.toLowerCase();
    const matched = escapedWords.some(function (w) {
      return w.toLowerCase() === lower;
    });
    if (matched) {
      // Web 查找源是全局镜像 store（只喂联动词）：首个小写等值词的释义
      const vocabItem = words.find(function (w) {
        return String(w.word || '').toLowerCase() === lower;
      });
      segments.push({
        text: part,
        hit: true,
        title:
          '生词本收录：' +
          ((vocabItem && vocabItem.definition) || '已加入生词本'),
      });
    } else {
      segments.push({ text: part, hit: false });
    }
  }
  return segments;
}

/** 秒 → `Ns`（简洁清单元数据行口径，T2.3 使用；恒为整数） */
function secText(n) {
  return Math.round(Number(n) || 0) + 's';
}

/** 把 SavedSentenceItem 预计算成 WXML 就绪展示字段（原字段保留，返回新对象） */
function decorateSentence(item, linkedWords) {
  const s = normalizeSentence(item);
  return Object.assign({}, s, {
    enParts: buildHighlightSegments(s.enText, linkedWords),
    hasZh: !!s.zhText,
    hasNote: !!s.note,
    hasSubtitle: s.subtitleId !== null,
    startText: secText(s.startTime),
    endText: secText(s.endTime),
  });
}

/** 全量标签（SentenceNotebook allTags：Set 去重保首见序，滤空串） */
function allTags(sentences) {
  const set = [];
  const seen = {};
  (Array.isArray(sentences) ? sentences : []).forEach(function (s) {
    (s.tags || []).forEach(function (t) {
      if (t && !seen[t]) {
        seen[t] = true;
        set.push(t);
      }
    });
  });
  return set;
}

/**
 * 标签 pills 云（Web allTags.map 内联 count）：[{name, count}] 首见序。
 * count 与筛选无关，恒为全量命中数（对齐 Web `sentences.filter(...).length`）。
 */
function tagCloud(sentences) {
  return allTags(sentences).map(function (t) {
    return {
      name: t,
      count: (Array.isArray(sentences) ? sentences : []).filter(function (s) {
        return (s.tags || []).indexOf(t) >= 0;
      }).length,
    };
  });
}

/** 剧集筛选候选（episodeOptions：episodeid 首见保序 Map → {value,label}） */
function episodeOptions(sentences) {
  const map = [];
  const seen = {};
  (Array.isArray(sentences) ? sentences : []).forEach(function (s) {
    if (s.episodeid && !seen[s.episodeid]) {
      seen[s.episodeid] = true;
      map.push({ value: s.episodeid, label: s.episodeTitle || s.episodeid });
    }
  });
  return map;
}

/**
 * 统计三格（SentenceStats props 口径）：关键句 / 联动词汇 / 分类标签。
 * @returns {sentenceCount, vocabCount, tagCount}
 */
function deriveStats(sentences, linkedVocabWords) {
  const arr = Array.isArray(sentences) ? sentences : [];
  return {
    sentenceCount: arr.length,
    vocabCount: (Array.isArray(linkedVocabWords) ? linkedVocabWords : []).length,
    tagCount: allTags(arr).length,
  };
}

/**
 * 筛选 + 四路搜索（Web filteredList 逐行对齐）：
 * searchQuery 小写 substring 命中 enText / zhText / note / tags 任一；
 * filterEpisode（episodeid 全等）/ filterTag（tags 包含）先行短路。
 * 'ALL' 为不筛（Web 哨兵值同款）。
 */
function filterSentences(sentences, opts) {
  const o = opts || {};
  const q = String(o.query || '').trim().toLowerCase();
  const episode = o.episode || 'ALL';
  const tag = o.tag || 'ALL';
  return (Array.isArray(sentences) ? sentences : []).filter(function (s) {
    if (episode !== 'ALL' && s.episodeid !== episode) return false;
    if (tag !== 'ALL' && (s.tags || []).indexOf(tag) < 0) return false;
    if (q) {
      const inEn = (s.enText || '').toLowerCase().indexOf(q) >= 0;
      const inZh = (s.zhText || '').toLowerCase().indexOf(q) >= 0;
      const inNote = (s.note || '').toLowerCase().indexOf(q) >= 0;
      const inTags = (s.tags || []).some(function (t) {
        return (t || '').toLowerCase().indexOf(q) >= 0;
      });
      if (!inEn && !inZh && !inNote && !inTags) return false;
    }
    return true;
  });
}

/**
 * 评测配额展示口径（Web useEffect 封顶逻辑）：
 * used 按 limit 封顶——buffer 期的第 6 次评测不显示为 6/5（+1 buffer 不对外泄露）；
 * limit 缺省回落 5；未加载 used=null（文案显示 "…"）。
 */
function evalQuotaView(data) {
  const d = data || {};
  const limit =
    typeof d.limit === 'number' && d.limit > 0
      ? d.limit
      : FREE_REVIEW_EVALUATIONS_PER_DAY;
  if (typeof d.used !== 'number') {
    return { used: null, limit: limit };
  }
  return { used: Math.min(d.used, limit), limit: limit };
}

/** 容量/日池双栏状态文本（逐字对齐 Web QuotaStatusCard columns 调用处） */
function quotaTexts(sentenceCount, evalUsed, evalLimit) {
  const n = Number(sentenceCount) || 0;
  const limit = Number(evalLimit) || FREE_REVIEW_EVALUATIONS_PER_DAY;
  let evalStatusText = '…';
  if (evalUsed !== null && evalUsed !== undefined) {
    const used = Number(evalUsed) || 0;
    evalStatusText =
      used >= limit
        ? limit + '/' + limit + ' · 已用完 (升级无限)'
        : used + '/' + limit + ' · 剩' + (limit - used) + '次';
  }
  return {
    // 注意：句子本容量文案是全角括号 + 「还能收藏 N 句」带空格（与生词本半角不同）
    primaryStatusText:
      n < FREE_SENTENCE_LIMIT
        ? n + '/' + FREE_SENTENCE_LIMIT + ' · 还能收藏 ' + (FREE_SENTENCE_LIMIT - n) + ' 句'
        : n + '/' + FREE_SENTENCE_LIMIT + ' · 已满（删除腾位或升级无限）',
    dailyStatusText: evalStatusText,
  };
}

module.exports = {
  FREE_SENTENCE_LIMIT,
  FREE_REVIEW_EVALUATIONS_PER_DAY,
  escapeRegex,
  normalizeSentence,
  parseSentences,
  filterLinkedVocabWords,
  buildHighlightSegments,
  secText,
  decorateSentence,
  allTags,
  tagCloud,
  episodeOptions,
  deriveStats,
  filterSentences,
  evalQuotaView,
  quotaTexts,
};
