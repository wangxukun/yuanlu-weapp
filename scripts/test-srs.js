/**
 * scripts/test-srs.js — SRS 间隔算法单测（双份对照：Web 源码字面转录 vs weapp 移植）
 *
 * 验证目标（REVIEW-TASK.md T0.5，对齐 yuanlu/lib/srs.ts + ReviewModal.getIntervalLabel
 * + useVocabularyNotebook.isDue）：
 *   1. 三分支语义：FORGOT 重置 0 级当天 / HARD 降级明天 / GOOD·EASY 升级按阶梯
 *   2. 阶梯表 [0,1,3,7,14,30,90] 与 6+ 级 90 天封顶
 *   3. 返回形状与 API 对齐（nextReviewAt ISO 字符串 + daysAdded）
 *   4. getIntervalLabel 文案（今天/1天/N天）
 *   5. isDue 三态（空=到期、过去=到期、未来=未到期）
 *   6. 全等级 × 全档位 与参考实现（TS 字面转录）逐项一致
 *
 * 运行：node scripts/test-srs.js
 */

const assertModule = (() => {
  let failed = 0;
  return {
    ok(cond, msg) {
      if (cond) console.log('PASS:', msg);
      else {
        console.error('FAIL:', msg);
        failed++;
      }
    },
    done() {
      console.log('----------------------------------------');
      if (failed === 0) console.log('ALL SRS TESTS PASSED');
      else {
        console.error(failed + ' TEST(S) FAILED');
        process.exitCode = 1;
      }
    },
  };
})();

const srs = require('../utils/srs');
const { ReviewQuality, INTERVALS } = srs;

const NOW = new Date('2026-09-20T08:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const iso = (d) => d.toISOString();

// ---- 参考实现：yuanlu/lib/srs.ts 的字面转录（Date 版）----
function refCalculateNextReview(currentProficiency, quality) {
  let nextProficiency = currentProficiency;
  let nextReviewDate = new Date(NOW);
  if (quality === ReviewQuality.FORGOT) {
    nextProficiency = 0;
    nextReviewDate = new Date(NOW);
  } else if (quality === ReviewQuality.HARD) {
    nextProficiency = Math.max(0, currentProficiency - 1);
    nextReviewDate = new Date(NOW.getTime() + 1 * DAY_MS);
  } else {
    nextProficiency = currentProficiency + 1;
    const intervalIndex = Math.min(nextProficiency, INTERVALS.length - 1);
    const daysToAdd = INTERVALS[intervalIndex];
    nextReviewDate = new Date(NOW.getTime() + daysToAdd * DAY_MS);
  }
  return { proficiency: nextProficiency, nextReviewAt: nextReviewDate };
}

// —— 1. 三分支语义 ——
let r = srs.calculateNextReview(5, ReviewQuality.FORGOT, NOW);
assertModule.ok(
  r.proficiency === 0 && r.daysAdded === 0 && r.nextReviewAt === iso(new Date(NOW)),
  'FORGOT(5级) → 重置 0 级、当天再见',
);
r = srs.calculateNextReview(3, ReviewQuality.HARD, NOW);
assertModule.ok(
  r.proficiency === 2 && r.daysAdded === 1 && r.nextReviewAt === iso(new Date(NOW.getTime() + DAY_MS)),
  'HARD(3级) → 降 1 级、明天',
);
r = srs.calculateNextReview(0, ReviewQuality.HARD, NOW);
assertModule.ok(r.proficiency === 0, 'HARD(0级) → 等级下限钳制 0');

r = srs.calculateNextReview(2, ReviewQuality.GOOD, NOW);
assertModule.ok(
  r.proficiency === 3 && r.daysAdded === 7,
  'GOOD(2级) → 升 3 级、+7 天（INTERVALS[3]）',
);
r = srs.calculateNextReview(1, ReviewQuality.EASY, NOW);
assertModule.ok(r.proficiency === 2 && r.daysAdded === 3, 'EASY(1级) → 同 GOOD、+3 天');

r = srs.calculateNextReview(5, ReviewQuality.GOOD, NOW);
assertModule.ok(r.proficiency === 6 && r.daysAdded === 90, 'GOOD(5级) → 升 6 级、+90 天');
r = srs.calculateNextReview(6, ReviewQuality.GOOD, NOW);
assertModule.ok(r.proficiency === 7 && r.daysAdded === 90, 'GOOD(6级) → 7 级封顶、仍 +90 天（min(idx,6)）');

// 非枚举 quality 走升级分支（与 Web else 分支同款行为）
r = srs.calculateNextReview(2, 99, NOW);
assertModule.ok(r.proficiency === 3, '非枚举 quality(99) → 走 GOOD 分支（对齐 Web else）');

// —— 2. 阶梯全表 ——
const expectedLadder = [1, 3, 7, 14, 30, 90, 90]; // 升级后 1..7 级对应天数
let ladderOk = true;
for (let p = 0; p <= 6; p++) {
  const res = srs.calculateNextReview(p, ReviewQuality.GOOD, NOW);
  if (res.daysAdded !== expectedLadder[p]) ladderOk = false;
}
assertModule.ok(ladderOk, '阶梯全表：0-6 级 GOOD → [1,3,7,14,30,90,90] 天');

// —— 3. 全等级 × 全档位双份对照 ——
let allMatch = true;
const mismatches = [];
for (let p = 0; p <= 8; p++) {
  for (const q of [0, 1, 2, 3]) {
    const mine = srs.calculateNextReview(p, q, NOW);
    const ref = refCalculateNextReview(p, q);
    if (
      mine.proficiency !== ref.proficiency ||
      mine.nextReviewAt !== ref.nextReviewAt.toISOString()
    ) {
      allMatch = false;
      mismatches.push(`p=${p},q=${q}`);
    }
  }
}
assertModule.ok(
  allMatch,
  '全等级(0-8) × 全档位(0-3) 与 Web 参考实现逐项一致' +
    (allMatch ? '' : '，失配: ' + mismatches.join(', ')),
);

// —— 4. getIntervalLabel ——
assertModule.ok(srs.getIntervalLabel(5, ReviewQuality.FORGOT, NOW) === '今天', 'label: FORGOT → 今天');
assertModule.ok(srs.getIntervalLabel(3, ReviewQuality.HARD, NOW) === '1天', 'label: HARD → 1天');
assertModule.ok(srs.getIntervalLabel(2, ReviewQuality.GOOD, NOW) === '7天', 'label: GOOD(2级) → 7天');
assertModule.ok(srs.getIntervalLabel(1, ReviewQuality.EASY, NOW) === '3天', 'label: EASY(1级) → 3天');
assertModule.ok(srs.getIntervalLabel(5, ReviewQuality.GOOD, NOW) === '90天', 'label: GOOD(5级) → 90天');

// —— 5. isDue ——
assertModule.ok(srs.isDue(null) === true, 'isDue: 空 → 到期（新词立即进队列）');
assertModule.ok(srs.isDue(undefined) === true, 'isDue: undefined → 到期');
assertModule.ok(srs.isDue('') === true, 'isDue: 空串 → 到期');
// 相对当前时间动态构造，避免硬编码日期跨天后翻转（原 2026-09-21 用例次日即失败）
assertModule.ok(srs.isDue(new Date(Date.now() - 86400000).toISOString()) === true, 'isDue: 过去 → 到期');
assertModule.ok(srs.isDue(new Date(Date.now() + 86400000).toISOString()) === false, 'isDue: 未来 → 未到期');

assertModule.done();
