/**
 * scripts/test-home-guest.js — 主页登录引导态行为单测（Node 环境，mock wx + Page）
 *
 * 验证目标（RESHAPE-TASK T0.2/T3.1 前置拆除后的主页口径）：
 *   A. 游客 onLoad → 整页引导态（isLoggedIn=false），主页 API 零请求
 *   B. 登录（authStore.subscribe 通道）→ 自动恢复内容态：isLoggedIn=true、拉取数据、isLoading=false
 *   C. onShow 通道重复触发（token 未变）→ 不重拉聚合，仅静默补拉 weekly-activity 一路
 *   D. 登出 → 回到引导态、零请求
 *   E. 重新登录（subscribe + onShow 双通道都触发）→ 只拉一批数据（token 去重）
 *   F. 整集列表已退役：无「继续收听/推荐/最近发布」区块；onShow 恒定 weekly 补拉；
 *      游客态 onShow 零请求
 *
 * 每批数据 = 5 路主页聚合（profile/overview/weekNow/weekLast/vocab）+
 * 1 路 authStore.fetchProfile + 1 路 daily-prescription = 7 个请求
 * （episode/history 两路已随合规重塑退役；处方为 T3.1 新增）。
 * 运行：node scripts/test-home-guest.js
 */

let apiCalls = 0;
let weeklyCalls = 0; // /api/user/stats/weekly-activity 独立计数（onShow 补拉断言）
const navigations = [];

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
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => navigations.push(o.url),
  request(opts) {
    apiCalls++;
    const url = opts.url;
    let data = {};
    if (url.includes('/api/user/stats/weekly-activity')) {
      weeklyCalls++;
      data = { weeklyActivity: [] };
    } else if (url.includes('/api/vocabulary/all')) data = [];
    opts.success({ statusCode: 200, data });
  },
};

// Page 构造器 mock：捕获配置并注入 setData
let page = null;
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  });
};

const fs = require('fs');
const path = require('path');

require('../pages/home/index');
const authStore = require('../store/authStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/home/index.wxml'), 'utf8');

  // —— 场景 A：游客进入主页 ——
  page.onLoad();
  assert(page.data.isLoggedIn === false, 'A 游客 isLoggedIn=false（引导态）');
  assert(page.data.isLoading === false, 'A 游客不进骨架屏（引导态直接渲染）');
  assert(apiCalls === 0, 'A 游客零 API 请求（主页 API 全部不发）');

  // —— 场景 B：登录（subscribe 通道）→ 自动恢复内容态 ——
  authStore.setLoginData('token-1', { userid: 'u1', role: 'USER' });
  await settle();
  assert(page.data.isLoggedIn === true, 'B 登录后 isLoggedIn=true（内容态恢复）');
  assert(page.data.isLoading === false, 'B 数据拉取完成后 isLoading=false');
  assert(apiCalls === 7, 'B 恰好一批请求（5 路聚合 + fetchProfile + 处方），实际 ' + apiCalls);
  assert(
    typeof page.data.greeting === 'string' && page.data.greeting.includes('朋友'),
    'B 首页数据管线完成（问候语已渲染）',
  );

  // —— 场景 C：onShow 通道重复触发（token 未变）→ 不重拉聚合 ——
  const beforeC = apiCalls;
  page.onShow();
  await settle();
  assert(apiCalls === beforeC + 1 && weeklyCalls === 3,
    'C onShow token 未变不重拉聚合（仅 weekly-activity 一路静默补拉；批次内已含 2 路 weekly）');

  // —— 场景 D：登出 → 回到引导态 ——
  authStore.logout();
  await settle();
  assert(page.data.isLoggedIn === false, 'D 登出后回到引导态');
  assert(page.data.isLoading === false && page.data.error === null, 'D 登出清空加载/错误态');

  // —— 场景 E：重新登录，subscribe + onShow 双通道都触发 → 只拉一批 ——
  const beforeE = apiCalls;
  authStore.setLoginData('token-2', { userid: 'u1', role: 'USER' }); // subscribe 通道
  page.onShow(); // onShow 通道（模拟登录页 navigateBack 返回）
  await settle();
  assert(page.data.isLoggedIn === true, 'E 重新登录恢复内容态');
  assert(apiCalls === beforeE + 8, 'E 双通道只拉取一批数据（7 请求 + onShow weekly 1 路），实际 +' + (apiCalls - beforeE));

  // —— 场景 F：整集链路退役后的主页形态 + T3.1 心愿签/处方卡 ——
  assert(page.data.wishChips.length === 3 && page.data.wishChips.every((c) => c.startsWith('#')),
    'F 心愿灵感胶囊：3 枚且带 # 前缀');
  const wxmlHome = fs.readFileSync(path.join(__dirname, '../pages/home/index.wxml'), 'utf8');
  assert(wxmlHome.includes('心愿定制') && wxmlHome.includes('召唤定制') && wxmlHome.includes('onWishGo'),
    'F 心愿定制签卡片（输入 + 胶囊 + 召唤按钮）');
  assert(wxmlHome.includes('今日五分钟') && !wxmlHome.includes('sentence-micro-player'),
    'F 今日五分钟处方卡流（卡内不嵌微播放器，整卡点击进精研）');
  const toastsBefore = 0; // 空心愿 → toast 拦截（wishInput 空）
  page.onWishGo();
  assert(navigations.length === 0, 'F 空心愿召唤被拦截（零跳转）');
  page.setData({ wishInput: '委婉解释项目延期' });
  page.onWishGo();
  assert(
    navigations.length === 1 &&
      navigations[0].indexOf('/pages/library/paths/index?wish=') === 0 &&
      decodeURIComponent(navigations[0].split('wish=')[1]) === '委婉解释项目延期',
    'F 召唤定制 → 心愿工坊（?wish= 全文透传）'
  );
  assert(page.data.continueListening === undefined && page.data.recommended === undefined &&
    page.data.latestEpisodes === undefined && page.data.latestHistory === undefined,
    'F 继续收听/推荐/最近发布数据位已退役（红线 1：零整集列表）');
  assert(!wxml.includes('onPlayEpisode') && !wxml.includes('/pages/episode/episode'),
    'F WXML 零剧集跳转');
  assert(wxml.includes('本周里程') && wxml.includes('我的路'),
    'F 修行骨架保留（本周里程 + 我的路）');
  assert(!fs.existsSync(path.join(__dirname, '../utils/audioManager.js')),
    'F 全局播放内核已退役（播放事件置脏链路不复存在）');
  const apiAfterF = apiCalls;
  page.onShow(); // 登录态 onShow → 恒定 weekly 一路
  await settle();
  assert(apiCalls === apiAfterF + 1, 'F 登录态 onShow 恒定补拉 weekly 一路');
  authStore.logout();
  await settle();
  const apiLoggedOut = apiCalls;
  page.onShow(); // 游客态 onShow → 零请求
  await settle();
  assert(apiCalls === apiLoggedOut, 'F 游客态 onShow 零请求');

  // —— 场景 G：下拉刷新链路（手势开关 + 处理函数收口） ——
  const homeJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/home/index.json'), 'utf8'));
  assert(homeJson.enablePullDownRefresh === true, 'G 页面 json 开启 enablePullDownRefresh（手势可达）');
  assert(typeof page.onPullDownRefresh === 'function', 'G onPullDownRefresh 处理函数存在');

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL HOME GUEST-STATE TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
