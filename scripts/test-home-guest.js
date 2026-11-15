/**
 * test-home-guest — 原声工坊主页（2026-11-15 自 yl-weapp A工程 完整迁移，替换
 * 退役的「查词工具首页」）
 *
 * 静态契约断言：四 tab 工坊骨架、全局仪表卡（连胜/三指标/五时段）、今日挑战
 * 评测链模块挂载、下拉刷新配置、合规字样零残留、零旧查词工具残留。
 * 运行时行为由 test-daily-challenge.cjs / test-reels-session.cjs 覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

const wxml = read('pages/home/index.wxml');
const wxss = read('pages/home/index.wxss');
const js = read('pages/home/index.js');
const json = JSON.parse(read('pages/home/index.json'));

// —— 场景 A：页面契约 ——
assert(json.enablePullDownRefresh === true, 'A 原生下拉刷新开启');
assert(!!json.usingComponents && !!json.usingComponents['vocabulary-modal'] &&
  !!json.usingComponents['premium-modal'], 'A 组件注册（词卡/会员弹窗）');
['今日挑战', '跟读接力', '排行榜', '自由定制'].forEach((t) => {
  assert(js.includes("label: '" + t + "'"), 'A tab「' + t + '」注册');
});

// —— 场景 B：全局仪表卡 ——
assert(wxml.includes('每日学习连胜') && wxml.includes('st-sp-week'), 'B 连胜横幅 + 7 日火苗链');
assert(wxml.includes('今日跟读') && wxml.includes('积累单词量') && wxml.includes('原声金句库'),
  'B 三指标格');
assert(js.includes('TIME_SLOTS') && js.includes('morning') && js.includes('night'), 'B 五时段推荐常量');
assert(js.includes('/api/streak') && js.includes('_igniteStreakBySpeech'), 'B 连胜接口与跟读自动点灯');

// —— 场景 C：真实数据模块挂载 ——
[
  ['./daily-challenge', '今日挑战选料 v2'],
  ['./dashboard', '仪表卡'],
  ['./shadowing', '跟读评测'],
  ['./smart-review', '艾宾浩斯复习'],
  ['./relay-api', '接力真实接口'],
  ['./leaderboard-api', '排行榜真实接口'],
].forEach(([m, name]) => {
  assert(js.includes("require('" + m + "')"), 'C 模块挂载：' + name);
});
assert(js.includes('/api/relay/create') || read('pages/home/relay-api.js').includes('/api/relay/create'),
  'C 接力建房接口');
assert(read('pages/home/leaderboard-api.js').includes('/api/speech/leaderboard'), 'C 日榜接口');

// —— 场景 D：合规字样 ——
['播客', '智能', '社区', '大模型'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w), 'D 零「' + w + '」字眼');
});
assert(!/\bAI\b/.test(js) && !/\bAI\b/.test(wxml), 'D 零「AI」字眼');
assert(!js.includes('podcastTitle') && !wxml.includes('podcastTitle'), 'D 零 podcast 标识');
assert(!js.includes('images.unsplash.com') && !wxml.includes('images.unsplash.com'), 'D 零 unsplash 外链');

// —— 场景 E：零旧查词工具残留 ——
['suggestions', '查词记录', 'corpusExamples', '灵感胶囊抽样', 'onDictSearch'].forEach((w) => {
  assert(!js.includes(w), 'E 零旧查词工具残留「' + w + '」');
});
assert(!wxml.includes('搜索') || !wxml.includes('st-search'), 'E 旧搜索骨架清除');

if (failed) {
  console.error('✗ ' + failed + ' 项失败');
  process.exit(1);
}
console.log('✓ home-guest 全部通过');
