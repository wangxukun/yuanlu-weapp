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

// —— 场景 E1：仪表卡入口「切 tab/展开 + 锚点置顶」契约 ——
const wxmlHome = read('pages/home/index.wxml');
assert(js.includes('_scrollAnchorToTop') && js.includes("wx.pageScrollTo"), 'E1 置顶滚动助手存在');
assert(wxmlHome.includes('id="stTabsRow"') && wxmlHome.includes('id="stReviewDeck"'), 'E1 锚点 id（tab 栏/闪卡清单）');
assert(js.split("_scrollAnchorToTop('#stTabsRow')").length - 1 >= 4, 'E1 四入口滚动 tab 栏（今日跟读/思辨特训/跟读冲刺/发起接力）');
assert(js.includes("_scrollAnchorToTop('#stReviewDeck')"), 'E1 展开闪卡清单滚动置顶（积累单词量/到期生词复习）');

// —— 场景 E2：趣味合集连播链契约（T11——连播态不被单棒播放路径清空） ——
assert(js.includes('if (!(opts && opts.compilation)) this._stopCompilation()'), 'E2 连播链内旁路清连播态');
assert(js.split('compilation: true').length - 1 >= 2, 'E2 连播两调用点（起播/棒次推进）携 compilation 标记');
assert(js.includes('_advanceBaton') && js.includes('_armBatonFallback') && !js.includes('_scheduleBaton(room'),
  'E2 连播推进=自然播完事件驱动（_advanceBaton）+时长兜底（_armBatonFallback），固定 5.2s 定时器退役');

// —— 场景 E：榜「挑战同款」加练契约（课外金句 → 今日挑战第 6+ 句） ——
const lbApi = read('pages/home/leaderboard-api.js');
assert(lbApi.includes('featuredClip: e.featuredClip'), 'E 映射层透传 featuredClip（丢弃即退化为仅播放）');
assert(js.includes('_appendDailyBonus') && js.includes('entry.featuredClip && entry.featuredClip.clipid'),
  'E onLbPractice 加练分支接入');
assert(read('pages/home/daily-challenge.js').includes('isBonus'), 'E 加练句 isBonus 标记');

if (failed) {
  console.error('✗ ' + failed + ' 项失败');
  process.exit(1);
}
console.log('✓ home-recommend 全部通过');
