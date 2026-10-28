/**
 * utils/intensive-core.js — 精听模式纯逻辑核心
 *
 * 逐行移植 Web 端 yuanlu 的三个算法源（components/episode/transcript/）：
 *   - findActiveIndex  ← useTranscriptScroll.ts:40-95（增量定位：命中当前句保持 /
 *     晚于当前句向后扫描 / 其余全局回退，避免每 tick 全表 findIndex）
 *   - computeWordSweep  ← components/transcript/useWordHighlight.ts（词级扫光三态：
 *     当前词 accent-100 底光斑 + 已读词 accent-700 字色 + 未读词保持主题色；
 *     rAF 连续插值在小程序离散化为 timeupdate 粒度采样）
 *   - buildDictation   ← DictationItem.tsx:51-91/209-237（去空格切块 + 前缀/全等
 *     三态判定：correct / error / pending，纯标点 token 恒 correct）
 *   - shouldLoopSeek   ← useTranscriptScroll.ts:44-61（单句循环：越过句尾即回跳，
 *     跳转后 500ms 保护窗防抖）
 *
 * 不依赖 wx / 任何页面状态，供 pages/intensive-listening 与
 * scripts/test-intensive-listening.js 共用（模型生成、代码把门的单测口径）。
 */

/** 去掉译文里的说话人标记（[SPEAKER_2]: ），对齐 Web 端各处 replace 口径 */
function stripSpeaker(zh) {
  return String(zh || '').replace(/\[SPEAKER_\d+\]:\s*/g, '').trim();
}

/** mm:ss，分钟补零（"00:09"，对齐 SubtitleItem.formatStartTime） */
function formatStartTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return (
    m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0')
  );
}

/** 听写比对清洗：小写 + 去常见标点（DictationItem.clean） */
function cleanWord(s) {
  return String(s).toLowerCase().replace(/[.,!?;:"()]/g, '');
}

/** 听写目标词：整句按空白切分（全部挖空，非仅关键词） */
function splitTargetWords(textEn) {
  return String(textEn || '')
    .trim()
    .split(/\s+/)
    .filter(function (w) {
      return w.length > 0;
    });
}

/**
 * 增量定位当前字幕句（useTranscriptScroll.loop 的核心查找，去 rAF 化）。
 * @param {Array} subs [{start,end,...}]
 * @param {number} t 当前播放秒
 * @param {number} fromIndex 上一次命中句下标（-1 表示无）
 * @returns {number} 命中下标，未命中 -1
 */
function findActiveIndex(subs, t, fromIndex) {
  if (!Array.isArray(subs) || subs.length === 0) return -1;

  const cur = fromIndex >= 0 ? subs[fromIndex] : null;
  if (cur && t >= cur.start && t <= cur.end) return fromIndex;

  if (cur && t > cur.end) {
    // 播放自然向后推进：从上次命中的下一句向后扫到首个时间窗包含 t 的句子
    for (let i = fromIndex + 1; i < subs.length; i++) {
      if (t >= subs[i].start && t <= subs[i].end) return i;
      if (t < subs[i].start) break;
    }
    return -1;
  }

  // 回退（seek 向后 / 首帧）：全局查找
  for (let i = 0; i < subs.length; i++) {
    if (t >= subs[i].start && t <= subs[i].end) return i;
  }
  return -1;
}

/**
 * 词级扫光三态定位（Web components/transcript/useWordHighlight.ts 的离散移植）。
 *
 * Web 端由 rAF 直接改 DOM 做 60fps 平滑扫光；小程序以 timeupdate 粒度（约
 * 250-500ms/帧）离散采样，返回 {idx, on} 两个标量供 setData 最小差量下发：
 *   - t < 句首                → {idx:-1, on:false}     全部未读
 *   - 命中词窗 [start,end]    → {idx:k,  on:true}      k 为当前朗读词
 *   - 词间间隙                → prev→next 半程切换当前词（对齐 Web 间隙交叉过渡）
 *     · prev=-1（句首词前）   → {idx:-1, on:false}     全部未读
 *     · next=末词后/句尾      → {idx:len,on:false}     全部已读、无光斑
 *   - t >= 句 end（整句读完）  → {idx:len,on:false}     全部已读（Web: applyReadColor 1）
 * 视图层映射：wi<idx 或 (wi===idx 且 !on) → 已读；wi===idx 且 on → 当前；wi>idx → 未读。
 */
function computeWordSweep(words, t, start, end) {
  if (!Array.isArray(words) || words.length === 0) return { idx: -1, on: false };
  if (t < start) return { idx: -1, on: false };
  if (t >= end) return { idx: words.length, on: false };

  // 定位当前词：首个时间窗包含 t 的词
  for (let i = 0; i < words.length; i++) {
    if (t >= words[i].start && t <= words[i].end) return { idx: i, on: true };
  }

  // 词间间隙：prev = 已读最后一个（end < t）、next = 未读第一个（start > t）
  let prev = -1;
  let next = words.length;
  for (let i = 0; i < words.length; i++) {
    if (words[i].end < t) prev = i;
    if (words[i].start > t && next === words.length) next = i;
  }
  if (prev === -1) return { idx: -1, on: false };
  if (next === words.length) return { idx: words.length, on: false };

  // 光斑在 prev→next 间隙内移动（Web 为连续插值），离散取过渡半程切换
  const gap = words[next].start - words[prev].end;
  const p = gap > 0 ? Math.min(1, Math.max(0, (t - words[prev].end) / gap)) : 1;
  return p < 0.5 ? { idx: prev, on: true } : { idx: next, on: true };
}

/**
 * 单句循环回跳判定（useTranscriptScroll 的 loop 分支语义）：
 * 已越过循环句句尾、且距上次跳转超过保护窗（500ms）时应 seek 回句首。
 */
function shouldLoopSeek(t, sub, lastSeekAt, now, guardMs) {
  if (!sub) return false;
  const guard = guardMs == null ? 500 : guardMs;
  return now - lastSeekAt > guard && t >= sub.end;
}

/**
 * 听写状态机（DictationItem 的 targetWords/inputWords/status 全量移植）。
 * @param {string} textEn 英文原句
 * @param {string} inputValue 用户原始输入（含空格）
 * @returns {{
 *   targetWords: string[],
 *   slots: Array<{status:'correct'|'error'|'pending', input: string, target: string, punct: boolean}>,
 *   isCorrect: boolean
 * }}
 */
function buildDictation(textEn, inputValue) {
  const targetWords = splitTargetWords(textEn);
  const rawInput = String(inputValue || '').replace(/\s+/g, '');

  // 输入切块：按每个目标词 clean 后的长度顺序切（标点词零长度不耗输入）
  const inputWords = [];
  let cursor = 0;
  for (let i = 0; i < targetWords.length; i++) {
    const tLen = cleanWord(targetWords[i]).length;
    if (tLen === 0) {
      inputWords.push('');
      continue;
    }
    if (cursor >= rawInput.length) break;
    const chunk = rawInput.slice(cursor, cursor + tLen);
    inputWords.push(chunk);
    cursor += chunk.length;
  }

  // 逐词三态判定
  const slots = targetWords.map(function (target, i) {
    const cw = cleanWord(target);
    const punct = cw.length === 0;
    const input = inputWords[i] == null ? '' : inputWords[i];
    let status = 'pending';

    if (punct) {
      status = 'correct'; // 纯标点 token 恒 correct
    } else if (input.length > 0) {
      const inputLower = input.toLowerCase();
      if (input.length >= cw.length) {
        status = inputLower === cw ? 'correct' : 'error';
      } else {
        status = inputLower === cw.slice(0, input.length) ? 'pending' : 'error';
      }
    }

    return { status: status, input: input, target: target, punct: punct };
  });

  // 全部对齐才算完成（未输入完 inputWords 短于目标词数 → false）
  const isCorrect =
    inputWords.length === targetWords.length &&
    slots.every(function (s) {
      return s.status === 'correct';
    });

  return { targetWords: targetWords, slots: slots, isCorrect: isCorrect };
}

/**
 * 声学显微镜（RESHAPE-TASK T2.2 / 创想三）：榨干词级时间戳的纯函数族。
 *   - analyzeWordAcoustics：单句每词持续毫秒 / 语速热力三档 / 极速连读词块
 *     （功能词 <130ms 且与相邻词间隙 <20ms → ⚡连读吞音闪电标数据源）
 *   - slicePhraseWindow：词块点读窗口（选中 2-4 词的精确起止秒，供
 *     clip-player 局部慢放三连剖析）
 */

/** 功能词表（虚词/助动词/代词/介词——母语者口语中被极速压缩的高频词） */
var FUNCTION_WORDS = {
  a: 1, an: 1, the: 1, and: 1, or: 1, but: 1, nor: 1, so: 1, yet: 1,
  of: 1, to: 1, in: 1, on: 1, at: 1, for: 1, with: 1, from: 1, by: 1,
  up: 1, out: 1, off: 1, outta: 1, into: 1, about: 1, over: 1, under: 1,
  that: 1, this: 1, these: 1, those: 1, there: 1, here: 1, than: 1, then: 1,
  is: 1, am: 1, are: 1, was: 1, were: 1, be: 1, been: 1, being: 1,
  do: 1, does: 1, did: 1, done: 1, has: 1, have: 1, had: 1,
  will: 1, would: 1, can: 1, could: 1, should: 1, shall: 1, may: 1, might: 1, must: 1,
  not: 1, no: 1, "don't": 1, "doesn't": 1, "didn't": 1, "won't": 1, "can't": 1, "couldn't": 1, "wouldn't": 1, "shouldn't": 1, "isn't": 1, "wasn't": 1, "aren't": 1, "weren't": 1, "hasn't": 1, "haven't": 1, "hadn't": 1,
  it: 1, its: 1, he: 1, him: 1, his: 1, she: 1, her: 1, we: 1, us: 1, our: 1,
  they: 1, them: 1, their: 1, you: 1, your: 1, i: 1, me: 1, my: 1,
  what: 1, which: 1, who: 1, whom: 1, whose: 1, how: 1, when: 1, where: 1, why: 1,
  all: 1, any: 1, both: 1, each: 1, few: 1, more: 1, most: 1, other: 1, some: 1, such: 1,
  just: 1, only: 1, very: 1, too: 1, got: 1, get: 1, gonna: 1, wanna: 1, gotta: 1,
  kind: 1, sort: 1, lot: 1, bit: 1, going: 1, want: 1, because: 1, as: 1, if: 1, at: 1,
};

/** 极速词阈值（毫秒）：低于此值的功能词视作被母语者"吞掉" */
var FAST_LINK_MS = 130;
/** 连读间隙阈值（毫秒）：相邻极速词间隙小于此值才并块 */
var FAST_LINK_GAP_MS = 20;

/** 词长清洗（连读闪电标的功能词判定用，复用听写 cleanWord 口径） */
function isFunctionWord(word) {
  return Object.prototype.hasOwnProperty.call(
    FUNCTION_WORDS,
    String(word || '').toLowerCase().replace(/[.,!?;:"()']/g, '')
  );
}

/** 英文音节估算：连续元音组计数；>1 组且尾部静音 e（辅音+e，-le 除外——
 *  table/little 的 le 自成音节）则减一；最少 1 */
function estimateSyllables(word) {
  var w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  var groups = w.match(/[aeiouy]+/g);
  var n = groups ? groups.length : 1;
  if (n > 1 && /[^aeiouyl]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 单句声学分析（纯函数，无 wx 依赖）。
 * @param {Array} words [{word, start, end}]（毫秒级词级时间戳）
 * @returns {{
 *   words: Array<{word,start,end,durationMs,gapMs,syllables,sps,speedTier,isFastLink}>,
 *   wpm: number,                 // 句真实语速（词/分钟，按首词起~末词止）
 *   medianSps: number,           // 句内音节/秒 中位数（热力基准）
 *   fastLinks: Array<{startIdx,endIdx,text,durationSec}>  // ⚡连读吞音词块（≥1 词）
 * }}
 */
function analyzeWordAcoustics(words) {
  var list = (Array.isArray(words) ? words : []).filter(function (w) {
    return w && isFinite(w.start) && isFinite(w.end) && w.end >= w.start;
  });
  if (list.length === 0) {
    return { words: [], wpm: 0, medianSps: 0, fastLinks: [] };
  }

  var items = list.map(function (w, i) {
    var durationMs = (w.end - w.start) * 1000;
    return {
      word: w.word || '',
      start: w.start,
      end: w.end,
      durationMs: round1(durationMs),
      gapMs: i > 0 ? round1(Math.max(0, (w.start - list[i - 1].end) * 1000)) : 0,
      syllables: estimateSyllables(w.word),
      isFastLink: false,
    };
  });

  // 每秒音节数（SPS）与句内热力基准（中位数，免疫个别超长词拉偏）
  var sps = items.map(function (it) {
    return it.durationMs > 0 ? it.syllables / (it.durationMs / 1000) : 0;
  });
  var positive = sps.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
  var medianSps = positive.length > 0 ? positive[Math.floor(positive.length / 2)] : 0;
  items.forEach(function (it, i) {
    it.sps = round2(sps[i]);
    if (medianSps <= 0 || sps[i] <= 0) {
      it.speedTier = 'normal';
    } else if (sps[i] >= medianSps * 1.3) {
      it.speedTier = 'fast';
    } else if (sps[i] <= medianSps * 0.7) {
      it.speedTier = 'slow';
    } else {
      it.speedTier = 'normal';
    }
  });

  // 句真实语速：总词数 / 首词起~末词止时长
  var spanSec = list[list.length - 1].end - list[0].start;
  var wpm = spanSec > 0 ? Math.round(list.length / (spanSec / 60)) : 0;

  // ⚡连读吞音词块：功能词且 <130ms；相邻块内词间隙 <20ms 才并块
  var fastLinks = [];
  var blockStart = -1;
  function flush(endIdx) {
    if (blockStart < 0) return;
    fastLinks.push({
      startIdx: blockStart,
      endIdx: endIdx,
      text: list.slice(blockStart, endIdx + 1).map(function (w) { return w.word || ''; }).join(' '),
      durationSec: round2(list[endIdx].end - list[blockStart].start),
    });
    for (var k = blockStart; k <= endIdx; k++) items[k].isFastLink = true;
    blockStart = -1;
  }
  items.forEach(function (it, i) {
    var qualifies = isFunctionWord(it.word) && it.durationMs > 0 && it.durationMs < FAST_LINK_MS;
    if (qualifies) {
      if (blockStart < 0 || it.gapMs >= FAST_LINK_GAP_MS) {
        flush(i - 1); // 间隙过大：前块收口，本词开新块
        blockStart = i;
      }
    } else {
      flush(i - 1);
    }
  });
  flush(items.length - 1);

  return { words: items, wpm: wpm, medianSps: round2(medianSps), fastLinks: fastLinks };
}

/**
 * 词块点读窗口（纯函数）：选中 [startIdx, endIdx] 连续词块的精确起止秒。
 * 起点前让 0.06s / 终点后让 padSec（默认 0.08s），保证爆破音起振与尾音完整。
 * @returns {{startSec,endSec,phraseText,wordCount} | null}（越界/缺时间戳返回 null）
 */
function slicePhraseWindow(words, startIdx, endIdx, padSec) {
  if (!Array.isArray(words) || words.length === 0) return null;
  var i = Math.max(0, Math.min(Number(startIdx) || 0, words.length - 1));
  var j = Math.max(i, Math.min(Number(endIdx) == null || !isFinite(Number(endIdx)) ? i : Number(endIdx), words.length - 1));
  var a = words[i];
  var b = words[j];
  if (!a || !b || !isFinite(a.start) || !isFinite(b.end)) return null;
  var pad = padSec == null ? 0.08 : Number(padSec) || 0;
  return {
    startSec: Math.max(0, a.start - 0.06),
    endSec: b.end + pad,
    phraseText: words.slice(i, j + 1).map(function (w) { return (w && w.word) || ''; }).join(' ').trim(),
    wordCount: j - i + 1,
  };
}

module.exports = {
  stripSpeaker,
  formatStartTime,
  cleanWord,
  splitTargetWords,
  findActiveIndex,
  computeWordSweep,
  shouldLoopSeek,
  buildDictation,
  analyzeWordAcoustics,
  slicePhraseWindow,
  estimateSyllables,
  isFunctionWord,
};
