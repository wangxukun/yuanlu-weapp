/**
 * scripts/test-discover-tags.js — 探索画廊（阶段 0 过渡态）合规把门
 *
 * 原发现页「分类标签/热门榜/频道列表/播客搜索」已随去播客化红线整体退役
 * （RESHAPE-TASK T0.2；T4.2 将以后端 /api/scenes/*、/api/studio/* 落地
 * 心愿定制栏、声音明信片与主题专栏）。本套件改守过渡态红线：
 *   A. 零播客数据面：不发 /api/podcast/*、/api/channels、/api/episode/* 请求
 *   B. 零死跳转：无 podcast/channel/search 页 navigateTo 残留
 *   C. 过渡态骨架：主题根类挂载 + 静态预告卡（心愿场景胶囊）
 *   D. app.json：发现页仍是 tabBar 页（入口保留）；channel-card 组件资产保留
 *      （T4.2 主题专栏复用，其单测 test-channel-card.js 独立把门）
 *
 * 运行：node scripts/test-discover-tags.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const calls = { request: [] };

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: () => {},
  navigateTo: () => {},
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  request: (opts) => {
    calls.request.push(opts);
  },
  getSystemInfoSync: () => ({ statusBarHeight: 20, theme: 'light' }),
  onThemeChange: () => {},
};

global.Page = (cfg) => (global.__discoverCfg = cfg);

require(path.join(__dirname, '../pages/discover/index.js'));
const pageConfig = global.__discoverCfg;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}

/* ==================== 断言 ==================== */

const wxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../pages/discover/index.js'), 'utf8');
const json = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/discover/index.json'), 'utf8'));
const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));

// —— A. 零播客数据面 ——
ok(calls.request.length === 0, 'A 页面加载零网络请求（数据面整体退役）');
ok(!js.includes('/api/podcast/'), 'A JS 零 /api/podcast/* 调用');
ok(!js.includes('/api/channels'), 'A JS 零 /api/channels 调用');
ok(!js.includes('/api/episode/'), 'A JS 零 /api/episode/* 调用');
ok(!js.includes('fetchChannels'), 'A 频道聚合数据源已移除');

// —— B. 零死跳转 ——
ok(!js.includes('navigateTo'), 'B JS 零 navigateTo（podcast/channel/search 全退役）');
ok(!wxml.includes('/pages/podcast') && !wxml.includes('/pages/channel') && !wxml.includes('/pages/search'),
  'B WXML 零退役页跳转');

// —— C. 过渡态骨架 ——
ok(wxml.includes('{{themeClass}}'), 'C 根视图挂 themeClass（主题三轨不回归）');
ok(wxml.includes('探索画廊'), 'C 静态预告卡标题');
ok(wxml.includes('#高频连读'), 'C 心愿场景胶囊（T4.2 心愿定制栏预告）');
ok(typeof pageConfig.onShow === 'function', 'C onShow 主题态接线');
const pageInstance = Object.assign({}, pageConfig, {
  data: JSON.parse(JSON.stringify(pageConfig.data || {})),
  setData(patch) {
    Object.assign(this.data, patch);
  },
});
pageInstance.onShow();
ok(pageInstance.data.themeClass !== undefined, 'C onShow 后 themeClass 已置位（手动根类口径）');
ok(json.usingComponents && Object.keys(json.usingComponents).length === 0,
  'C 组件注册清空（channel-card 等 T4.2 回归时再挂）');

// —— D. 入口与资产保留 ——
ok(appJson.tabBar.list.some((t) => t.pagePath === 'pages/discover/index'),
  'D 发现页仍是 tabBar 入口');
ok(fs.existsSync(path.join(__dirname, '../components/common/channel-card/index.wxml')),
  'D channel-card 组件资产保留（T4.2 主题微剧场专栏复用）');

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL DISCOVER TRANSITION TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
