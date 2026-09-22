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

module.exports = {
  stripSpeaker,
  formatStartTime,
  cleanWord,
  splitTargetWords,
  findActiveIndex,
  computeWordSweep,
  shouldLoopSeek,
  buildDictation,
};
