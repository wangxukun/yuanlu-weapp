/**
 * utils/srs.js — 间隔重复算法（基于 Leitner System 适配现有 Schema）
 * 逐行对齐 yuanlu/lib/srs.ts（Web 前端与服务端共用同一算法，口径不漂移）：
 *
 *   等级(proficiency) → 复习间隔：
 *   0: 新词/忘记 → 0天   1: → 1天   2: → 3天   3: → 7天
 *   4: → 14天   5: → 30天   6+: → 90天（长期掌握）
 *
 * 四档评分（ReviewQuality）：忘记=0（重置 0 级、留在今日队列，防死循环由
 * 前端「再来一轮只重测忘记的词」承接）/ 模糊=1（降 1 级、明天再见）/
 * 认识=2、简单=3（升 1 级、按阶梯取间隔，本版 EASY 简化为同 GOOD）。
 *
 * 小程序端用途：复习页四档按钮的「下次间隔预览」与列表 stats 派生（isDue）；
 * **服务端 /api/vocabulary/review 仍为权威判定**。
 *
 * 差异说明：Web 端 calculateNextReview 返回 Date；这里返回 ISO 字符串 +
 * daysAdded，与 /api/vocabulary/all、/api/vocabulary/review 响应中的
 * nextReviewAt 字段形状一致，便于本地乐观更新直接写入列表项。
 */

const INTERVALS = [0, 1, 3, 7, 14, 30, 90];

const ReviewQuality = {
  FORGOT: 0, // 忘记
  HARD: 1, // 模糊/困难
  GOOD: 2, // 认识
  EASY: 3, // 简单（本版简化为同 GOOD）
};

const DAY_MS = 24 * 3600 * 1000;

/**
 * 计算下次复习时间。
 * @param {number} currentProficiency 当前等级
 * @param {number} quality ReviewQuality 四档
 * @param {Date} [now] 基准时间（默认当前时间；测试注入用）
 * @returns {{ proficiency: number, nextReviewAt: string, daysAdded: number }}
 */
function calculateNextReview(currentProficiency, quality, now) {
  const base = now instanceof Date ? now : new Date();
  let nextProficiency = currentProficiency;
  let daysAdded = 0;

  if (quality === ReviewQuality.FORGOT) {
    // 忘记：重置回 0 级，nextReviewAt = 当前时间（仍出现在今日待复习队列）
    nextProficiency = 0;
    daysAdded = 0;
  } else if (quality === ReviewQuality.HARD) {
    // 模糊：保持现状或倒退一级，强制明天复习
    nextProficiency = Math.max(0, currentProficiency - 1);
    daysAdded = 1;
  } else {
    // 认识 / 简单：升级；等级超过阶梯长度取末位（90 天）
    nextProficiency = currentProficiency + 1;
    const intervalIndex = Math.min(nextProficiency, INTERVALS.length - 1);
    daysAdded = INTERVALS[intervalIndex];
  }

  return {
    proficiency: nextProficiency,
    nextReviewAt: new Date(base.getTime() + daysAdded * DAY_MS).toISOString(),
    daysAdded,
  };
}

/**
 * 四档按钮的「下次间隔预览」文案（对齐 Web ReviewModal.getIntervalLabel）：
 * ≤0 天 → 今天；1 天 → 1天；N 天 → N天。
 */
function getIntervalLabel(proficiency, quality, now) {
  const base = now instanceof Date ? now.getTime() : Date.now();
  const { nextReviewAt } = calculateNextReview(
    proficiency,
    quality,
    now instanceof Date ? now : new Date(base),
  );
  const days = Math.round((new Date(nextReviewAt).getTime() - base) / DAY_MS);
  if (days <= 0) return '今天';
  if (days === 1) return '1天';
  return days + '天';
}

/**
 * 到期判定（对齐 Web useVocabularyNotebook.isDue）：
 * nextReviewAt 为空视为到期（新词立即进队列），否则 <= 当前时间即到期。
 */
function isDue(dateStr) {
  if (!dateStr) return true;
  return new Date(dateStr) <= new Date();
}

module.exports = {
  INTERVALS,
  ReviewQuality,
  calculateNextReview,
  getIntervalLabel,
  isDue,
};
