/**
 * scripts/test-quota-card.js — quota-card 三态梯度与进度单测（Node 环境，mock Component）
 *
 * 验证目标（REVIEW-TASK.md T0.4，对齐 Web getStatusBarColor / QuotaStatusBar）：
 *   - 三态阈值：full = used>=limit；warning = used >= ceil(limit*0.8) 且未满；safe 其余
 *     （80% 预告与 Web shouldPreviewSentenceQuota 同一条规则：30 容量第 24 条起琥珀）
 *   - 百分比：min(100, used/limit*100)，limit=0 时为 0
 *   - observers：primary/daily 两栏独立联动
 *
 * 运行：node scripts/test-quota-card.js
 */

let componentDef = null;
global.Component = (cfg) => {
  componentDef = cfg;
};

require('../components/common/quota-card');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}

function makeInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(componentDef.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  Object.assign(inst, componentDef.methods);
  return inst;
}
function firePrimary(inst, used, limit) {
  componentDef.observers['primaryUsed, primaryLimit'].call(inst, used, limit);
}
function fireDaily(inst, used, limit) {
  componentDef.observers['dailyUsed, dailyLimit'].call(inst, used, limit);
}

// —— 三态阈值边界 ——
const card = makeInstance();

firePrimary(card, 0, 50);
assert(card.data.primary.level === 'safe' && card.data.primary.percent === 0, '0/50 → safe, 0%');

firePrimary(card, 39, 50);
assert(card.data.primary.level === 'safe', '39/50（78%）→ safe（未达 80%）');
assert(Math.abs(card.data.primary.percent - 78) < 0.001, '39/50 → 78%');

firePrimary(card, 40, 50);
assert(card.data.primary.level === 'warning', '40/50（80%）→ warning（ceil(50*0.8)=40）');

firePrimary(card, 49, 50);
assert(card.data.primary.level === 'warning', '49/50 未满 → warning');

firePrimary(card, 50, 50);
assert(card.data.primary.level === 'full' && card.data.primary.percent === 100, '50/50 → full, 100%');

firePrimary(card, 55, 50);
assert(card.data.primary.level === 'full' && card.data.primary.percent === 100, '55/50 越限 → full，百分比钳制 100%');

// 句子本口径：30 容量第 24 条起 80% 预告（ceil(30*0.8)=24）
firePrimary(card, 23, 30);
assert(card.data.primary.level === 'safe', '23/30 → safe（80% 预告前一天）');
firePrimary(card, 24, 30);
assert(card.data.primary.level === 'warning', '24/30 → warning（第 24 条起预告，对齐 shouldPreviewSentenceQuota）');

// 奇数容量 ceil：limit=5（评测日池），ceil(5*0.8)=4
firePrimary(card, 3, 5);
assert(card.data.primary.level === 'safe', '3/5 → safe');
firePrimary(card, 4, 5);
assert(card.data.primary.level === 'warning', '4/5 → warning（ceil(4)=4）');
firePrimary(card, 5, 5);
assert(card.data.primary.level === 'full', '5/5 → full');

// limit=0 防御
firePrimary(card, 0, 0);
assert(card.data.primary.level === 'safe' && card.data.primary.percent === 0, 'limit=0 → safe, 0%（不除零）');

// —— 双栏独立联动 ——
firePrimary(card, 24, 30);
fireDaily(card, 5, 5);
assert(card.data.primary.level === 'warning' && card.data.daily.level === 'full', 'primary/daily 两栏独立计算');

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL QUOTA-CARD TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
