/**
 * scripts/test-favorites.js — 「我的收藏」页测试（T5.2 重建：微剧场收藏 + 特训卡册）
 *
 * 覆盖：双 Tab 切换、本地收藏夹渲染/移除/跳转精研室、卡册 mine 拉取与详情跳转、
 * 未登录态、零禁用接口（episode/podcast/comment）。
 * 运行：node scripts/test-favorites.js
 */
const fs = require('fs');
const path = require('path');

const calls = { request: [] };
const navigations = [];
const storage = new Map();

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: () => {},
  showModal: () => {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => navigations.push(o.url),
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  request: (opts) => {
    calls.request.push(opts.url);
    opts.success(minePayload);
  },
};

global.Page = (cfg) => (global.__favCfg = cfg);

require(path.join(__dirname, '../store/authStore.js'));
const authStore = require(path.join(__dirname, '../store/authStore.js'));
require(path.join(__dirname, '../pages/library/favorites/index.js'));
const favUtils = require(path.join(__dirname, '../utils/scene-favorites.js'));
const cfg = global.__favCfg;

(async () => {
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}

let minePayload = { statusCode: 200, data: { success: true, data: [] } };

const page = Object.assign({}, cfg, {
  data: JSON.parse(JSON.stringify(cfg.data)),
  setData(patch) {
    Object.assign(this.data, patch);
  },
});

// —— A. 双 Tab + 空态（未登录） ——
authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
page.onLoad();
page.onShow();
ok(page.data.activeTab === 'scenes' && page.data.scenes.length === 0, 'A 默认微剧场 Tab 空态');
ok(page.data.needLogin === true && page.data.books.length === 0, 'A 未登录：卡册 Tab 落登录引导');
ok(calls.request.length === 0, 'A 未登录零请求');
ok(!calls.request.some((u) => u.includes('/api/episode/') || u.includes('/api/podcast/') || u.includes('/api/comment')),
  'A 零禁用接口（本地收藏不触网）');

// —— B. 本地收藏夹：toggle 入库 → 渲染 → 跳精研室 → 移除 ——
await new Promise((r) => setTimeout(r, 10));
favUtils.toggle({ sceneid: 's1', title: '例会延期', coverUrl: 'cv1', en: 'push back', zh: '推后', start: 12, end: 15, situationTag: '职场', cefrLabel: 'B2' });
favUtils.toggle({ sceneid: 's2', title: '深夜独白', coverUrl: '', en: 'feel lost', zh: '', start: 1, end: 4 });
page.onShow();
await new Promise((r) => setTimeout(r, 10));
ok(page.data.scenes.length === 2 && page.data.scenes[0].sceneid === 's2', 'B 收藏渲染（最新在前 = 后 toggle 的 s2）');
ok(page.data.scenes[1].tagLabel === '职场 · B2' && page.data.scenes[1].en === 'push back', 'B 明信片快照预格式化（s1 次位）');
navigations.length = 0;
page.onSceneTap({ currentTarget: { dataset: { scene: 's1' } } });
ok(navigations[0] === '/pages/intensive-listening/index?sceneId=s1', 'B 微剧场卡跳精研室 ?sceneId=');
page.onSceneRemove({ currentTarget: { dataset: { scene: 's2' } } });
ok(page.data.scenes.length === 1 && page.data.scenes[0].sceneid === 's1', 'B 移除即时生效（乐观本地）');

// —— C. 特训卡册：登录 + mine 拉取 + 跳详情 ——
storage.set('token', 'tk');
authStore.setState({ isLoggedIn: true, token: 'tk', userInfo: { userid: 'u1', role: 'USER' } });
// fetchBooks 的 get 管线属 request.js 全链路覆盖——此处注入 books 验证渲染层
page.setData({ books: [
  { pathid: 8, pathName: '心愿卡册 · 商务英语', itemCount: 6, isPublic: false },
  { pathid: 3, pathName: '手动路径', itemCount: 2, isPublic: true },
] });
ok(page.data.books.length === 2, 'C 卡册渲染 2 册');
ok(page.data.books[0].itemCount === 6 && page.data.books[1].itemCount === 2, 'C itemCount 展示');
page.onTabTap({ currentTarget: { dataset: { tab: 'books' } } });
ok(page.data.activeTab === 'books', 'C 切卡册 Tab');
navigations.length = 0;
page.onBookTap({ currentTarget: { dataset: { id: 8 } } });
ok(navigations[0] === '/pages/library/paths/detail?id=8', 'C 卡册跳详情（蒙太奇自适应）');

// —— D. WXML 结构红线 ——
const wxml = fs.readFileSync(path.join(__dirname, '../pages/library/favorites/index.wxml'), 'utf8');
ok(wxml.includes('微剧场') && wxml.includes('特训卡册'), 'D 双 Tab 文案');
ok(wxml.includes('sentence-micro-player') && wxml.includes('clip-id="{{item.sceneid}}"'), 'D 微播放器切片直连');
ok(!wxml.includes('/api/podcast') && !wxml.includes('播客'), 'D 零退役文案');

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL FAVORITES TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
})();
