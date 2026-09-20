/**
 * scripts/test-premium-modal.js — premium-modal 场景化文案与埋点单测（Node 环境，mock wx + Component）
 *
 * 验证目标（REVIEW-TASK.md T0.3，文案单一数据源 yuanlu/premium-modal-scenarios.ts）：
 *   A. 9 个复习场景 + episode_deep_dive 文案/权益/价格锚点/CTA 解析
 *   B. {var} 占位符插值（pronunciation_locked 的 totalErrors / worstPhoneme、review_eval_quota 的 avgScore/streak）
 *   C. 占位符缺值回退 *Fallback；未知 source 回退 DEFAULT_SCENARIO
 *   D. 打开瞬间上报 PREMIUM_MODAL_OPEN（POST /api/track，静默通道）；同开不重报；关闭复位后可再报
 *   E. 有 token 注入 Bearer，游客无 Authorization（后端允许未登录上报）
 *
 * 运行：node scripts/test-premium-modal.js
 */

const trackRequests = [];

global.wx = {
  _storage: {},
  getStorageSync(k) {
    return this._storage[k] !== undefined ? this._storage[k] : '';
  },
  setStorageSync(k, v) {
    this._storage[k] = v;
  },
  removeStorageSync(k) {
    delete this._storage[k];
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } };
  },
  showToast() {},
  request(opts) {
    trackRequests.push(opts);
    opts.success && opts.success({ statusCode: 204 });
  },
};

let componentDef = null;
global.Component = (cfg) => {
  componentDef = cfg;
};

require('../components/premium-modal');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}

// 组件实例 harness：data + setData + methods + 手动驱动 observers
function makeInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(componentDef.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent() {},
  };
  Object.assign(inst, componentDef.methods);
  return inst;
}
function fire(inst, visible, source, vars) {
  componentDef.observers['visible, source, vars'].call(inst, visible, source, vars);
}

const modal = makeInstance();

// —— 场景 A：各 source 文案解析 ——
fire(modal, false, 'vocabulary_total', null);
let s = modal.data.scenario;
assert(s.title === '生词本已经攒满了', 'A vocabulary_total 标题');
assert(s.benefits.length === 3 && s.benefits[0] === '生词无限收藏', 'A vocabulary_total 权益 3 项');
assert(s.priceAnchor === '¥5/7天起 · 低至 ¥0.46/天', 'A vocabulary_total 双价格锚点');
assert(s.cta === '解锁无限收藏', 'A vocabulary_total CTA');

fire(modal, false, 'sentence_quota', null);
assert(modal.data.scenario.cta === '无限收藏 · ¥5/7天起', 'A sentence_quota CTA 含锚点');
fire(modal, false, 'sentence_review_advanced', null);
assert(modal.data.scenario.title === '高级复习模式是 PRO 专属', 'A sentence_review_advanced 标题');
fire(modal, false, 'diagnostic_report', null);
assert(modal.data.scenario.cta === '解锁完整诊断', 'A diagnostic_report CTA');
fire(modal, false, 'episode_deep_dive', null);
assert(modal.data.scenario.title === 'AI 精讲这集播客', 'A episode_deep_dive 保持不变（剧集页兼容）');

// —— 场景 B：占位符插值 ——
fire(modal, true, 'pronunciation_locked', { totalErrors: 7, worstPhoneme: 'θ' });
s = modal.data.scenario;
assert(s.title === '你已发现 7 个发音弱点', 'B totalErrors 插值进标题');
assert(s.description.indexOf('θ 是当前最需攻克的音') !== -1, 'B worstPhoneme 插值进正文');

fire(modal, true, 'review_eval_quota', { avgScore: 82, streak: 4 });
s = modal.data.scenario;
assert(s.description.indexOf('平均 82 分') !== -1 && s.description.indexOf('连续学习 4 天') !== -1, 'B avgScore/streak 插值');

// —— 场景 C：缺值回退与未知 source ——
fire(modal, true, 'pronunciation_locked', { totalErrors: 9 }); // 缺 worstPhoneme
s = modal.data.scenario;
assert(s.title === '你已发现 9 个发音弱点', 'C 标题占位符齐 → 正常填充');
assert(s.description === '每天免费攻克 3 个发音弱点。PRO：全量弱项 + 无限闯关 + 音素专项。', 'C 正文占位符缺 → descriptionFallback');

fire(modal, true, 'pronunciation_locked', null); // 全缺
assert(modal.data.scenario.title === '你的发音弱点已经就位', 'C 标题占位符全缺 → titleFallback');

fire(modal, true, 'review_eval_quota', null);
assert(
  modal.data.scenario.description.indexOf('明日额度自动就位') !== -1,
  'C review_eval_quota 缺 vars → descriptionFallback',
);

fire(modal, true, 'nonexistent_source', null);
assert(modal.data.scenario.title === '这里是会员专享内容', 'C 未知 source → DEFAULT_SCENARIO');

// —— 场景 D：打开埋点（去重/复位） ——
trackRequests.length = 0;
const guestModal = makeInstance();
fire(guestModal, false, 'vocabulary_total', null);
assert(trackRequests.length === 0, 'D 关闭态不埋点');
fire(guestModal, true, 'vocabulary_total', null);
assert(trackRequests.length === 1, 'D 打开瞬间上报一次');
fire(guestModal, true, 'vocabulary_daily', null); // 弹窗开着换场景（source/vars 变化）
assert(trackRequests.length === 1, 'D 同开不重复上报');
fire(guestModal, false, 'vocabulary_daily', null);
fire(guestModal, true, 'vocabulary_daily', null);
assert(trackRequests.length === 2, 'D 关闭复位后再次打开可再报');

const req = trackRequests[1];
assert(req.url.endsWith('/api/track') && req.method === 'POST', 'D POST /api/track');
assert(
  req.data.eventType === 'PREMIUM_MODAL_OPEN' && req.data.source === 'vocabulary_daily',
  'D 载荷 {eventType, source}',
);

// —— 场景 E：鉴权头注入 ——
assert(req.header.Authorization === undefined, 'E 游客无 Authorization（后端允许匿名上报）');
wx.setStorageSync('token', 'tk-1');
fire(guestModal, false, 'vocabulary_daily', null);
fire(guestModal, true, 'dictionary_quota', null);
const authedReq = trackRequests[trackRequests.length - 1];
assert(authedReq.header.Authorization === 'Bearer tk-1', 'E 有 token 注入 Bearer');
assert(
  authedReq.header['content-type'] === 'application/json',
  'E content-type json',
);

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL PREMIUM-MODAL TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
