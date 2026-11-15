/**
 * test-home-recommend — 原声工坊主页·推荐与身份接线（2026-11-15 迁移配套重写）
 *
 * 静态契约断言：时段推荐双模式应用（今日挑战 tab/自由定制生成）、跨页路由
 * 约定（复习 pendingTab storage、评测/接力去 banned 路由）、登录门禁与
 * request 底座复用。运行时行为由 daily-challenge/reels-session 套件覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

const js = read('pages/home/index.js');
const dashboard = read('pages/home/dashboard.js');
const shadowing = read('pages/home/shadowing.js');

// —— 场景 A：时段推荐应用（onApplyTimeRec） ——
assert(js.includes('onApplyTimeRec'), 'A 时段推荐应用入口');
assert(js.includes("targetMode === 'review'") && js.includes('onMetricVocabulary'), 'A 复习模式→闪卡抽屉');
assert(js.includes("activeTab: 'daily'") && js.includes('isLooping: true'), 'A daily 模式→今日挑战 tab 循环播');
assert(js.includes('this.generate(rec.suggestedPrompt)'), 'A custom 模式→自动生成微场景');
assert(dashboard.includes('recommendations(') && dashboard.includes('suggestedLevel'), 'A 登录态推荐覆写（等级）');

// —— 场景 B：跨页路由约定 ——
assert(js.includes("'review:pendingTab'"), 'B 金句库跳复习走 pendingTab storage（生产约定）');
assert(!js.includes('speech-eval/index?id='), 'B 零已退役 ?id= 整集路由');
assert(!shadowing.includes('speech-eval/index?id='), 'B 发音详情改本卡报告（零 ?id= 路由）');

// —— 场景 C：登录门禁与请求底座 ——
assert(js.includes('_promptLogin') && shadowing.includes('_shadowToken'), 'C 登录门禁工具');
assert(js.includes("require('../../utils/request')"), 'C 复用统一请求底座');
assert(dashboard.includes('/api/user/stats/studio-dashboard'), 'C 仪表卡接口');
assert(dashboard.includes('showError: false'), 'C 静默装载（401 不打扰）');

// —— 场景 D：录音评测链完整性 ——
assert(shadowing.includes('/api/speech/evaluate') && shadowing.includes('/api/speech/quota'), 'D 评测+配额接口');
assert(read('utils/recorder.js').includes('isDevtools'), 'D recorder 带 devtools 兼容分支');
assert(js.includes('_cancelRelayRecording') || shadowing.includes('_cancelShadowing'), 'D 录音取消清理');

if (failed) {
  console.error('✗ ' + failed + ' 项失败');
  process.exit(1);
}
console.log('✓ home-recommend 全部通过');
