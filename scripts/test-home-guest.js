/**
 * scripts/test-home-guest.js — 主页登录引导态行为单测（Node 环境，mock wx + Page）
 *
 * 验证目标（见 REVIEW-TASK.md T0.1 同款模式移植到主页）：
 *   A. 游客 onLoad → 整页引导态（isLoggedIn=false），7 路主页 API 零请求
 *   B. 登录（authStore.subscribe 通道）→ 自动恢复内容态：isLoggedIn=true、拉取数据、isLoading=false
 *   C. onShow 通道重复触发（token 未变）→ 不重复拉取
 *   D. 登出 → 回到引导态
 *   E. 重新登录（subscribe + onShow 双通道都触发）→ 只拉取一批数据（token 去重）
 *
 * 每批数据 = 7 路主页聚合 + 1 路 authStore.fetchProfile = 8 个请求。
 * 运行：node scripts/test-home-guest.js
 */

let apiCalls = 0;

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
  navigateTo() {},
  switchTab() {},
  request(opts) {
    apiCalls++;
    const url = opts.url;
    let data = {};
    if (url.includes('/api/user/stats/weekly-activity')) data = { weeklyActivity: [] };
    else if (url.includes('/api/vocabulary/all')) data = [];
    else if (url.includes('/api/episode/list')) data = [];
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
  // —— 场景 A：游客进入主页 ——
  page.onLoad();
  assert(page.data.isLoggedIn === false, 'A 游客 isLoggedIn=false（引导态）');
  assert(page.data.isLoading === false, 'A 游客不进骨架屏（引导态直接渲染）');
  assert(apiCalls === 0, 'A 游客零 API 请求（7 路主页 API 全部不发）');

  // —— 场景 B：登录（subscribe 通道）→ 自动恢复内容态 ——
  authStore.setLoginData('token-1', { userid: 'u1', role: 'USER' });
  await settle();
  assert(page.data.isLoggedIn === true, 'B 登录后 isLoggedIn=true（内容态恢复）');
  assert(page.data.isLoading === false, 'B 数据拉取完成后 isLoading=false');
  assert(apiCalls === 8, 'B 恰好一批请求（7 路聚合 + 1 路 fetchProfile），实际 ' + apiCalls);
  assert(
    typeof page.data.greeting === 'string' && page.data.greeting.includes('朋友'),
    'B 首页数据管线完成（问候语已渲染）',
  );

  // —— 场景 C：onShow 通道重复触发（token 未变）→ 不重复拉取 ——
  page.onShow();
  await settle();
  assert(apiCalls === 8, 'C onShow token 未变不重复拉取');

  // —— 场景 D：登出 → 回到引导态 ——
  authStore.logout();
  await settle();
  assert(page.data.isLoggedIn === false, 'D 登出后回到引导态');
  assert(page.data.isLoading === false && page.data.error === null, 'D 登出清空加载/错误态');
  assert(apiCalls === 8, 'D 登出不发请求');

  // —— 场景 E：重新登录，subscribe + onShow 双通道都触发 → 只拉一批 ——
  authStore.setLoginData('token-2', { userid: 'u1', role: 'USER' }); // subscribe 通道
  page.onShow(); // onShow 通道（模拟登录页 navigateBack 返回）
  await settle();
  assert(page.data.isLoggedIn === true, 'E 重新登录恢复内容态');
  assert(apiCalls === 16, 'E 双通道只拉取一批数据（token 去重），实际 ' + apiCalls);

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL HOME GUEST-STATE TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
