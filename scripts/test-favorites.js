/**
 * scripts/test-favorites.js — 「我的收藏」页与收藏链路自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），全链路驱动
 * pages/library/favorites/index.js → utils/request.js → wx.request：
 * 覆盖数据映射（标签大写/收听数缩写/千分位/副标题拼接）、登录闸、
 * 双 Tab 计数、搜索过滤、乐观取消收藏与失败回滚（对齐 FavoriteCenter）。
 *
 * 运行：node scripts/test-favorites.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  showModal: () => {},
  navigateTo: () => {},
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__pageConfig = cfg);

/** 路由感知的默认应答：值可为对象或 (opts)=>resp；未知路径一律 200 { success: true } */
function routeAwareHandler(routes) {
  return (opts) => {
    const path = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[path];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    // 同步应答：测试侧只推进微任务（tick），不跑宏任务定时器
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

const path = require('path');
require(path.join(__dirname, '../store/authStore.js'));
const authStore = require(path.join(__dirname, '../store/authStore.js'));
require(path.join(__dirname, '../pages/library/favorites/index.js'));
const pageConfig = global.__pageConfig;

/* ==================== 工具函数 ==================== */

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

function makePage(initial = {}) {
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    pendingIds: new Set(),
  });
  page.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  Object.assign(page.data, initial);
  return page;
}

function resetMock() {
  storage.clear();
  toasts.length = 0;
  calls.request.length = 0;
  requestHandler = null;
  authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
}

const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const FAVORITES_BODY = {
  success: true,
  data: {
    podcasts: [
      {
        id: 'p1',
        title: 'Words & Their Stories',
        author: 'VOA Learning English',
        thumbnailUrl: 'https://oss/p1.jpg',
        category: [{ name: '词汇故事' }, { name: 'second' }],
        episodeCount: 120,
        plays: 2841,
        followers: 56,
      },
      {
        id: 'p2',
        title: 'Learning English For Work',
        author: 'BBC Learning English',
        category: [{ name: '商务英语' }],
        episodeCount: 3,
        plays: 890,
        followers: 7,
      },
    ],
    episodes: [
      {
        id: 'e1',
        title: 'Can I save this family restaurant?',
        author: 'The Daily',
        platform: 'The New York Times',
        thumbnailUrl: 'https://oss/e1.jpg',
        duration: '33:07',
        playCount: 1234567,
        favoriteCount: 89,
        podcastId: 'pd1',
      },
      {
        id: 'e2',
        title: 'Another Episode',
        author: '6 Minute English',
        platform: '',
        duration: '',
        playCount: 42,
        favoriteCount: 0,
        podcastId: 'pd2',
      },
    ],
  },
};

/* ==================== 用例 ==================== */

(async () => {
  section('数据映射 · mapPodcast / mapEpisode 展示字段');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init(); // 从 storage 恢复登录态
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
    '/api/user/profile': { statusCode: 404, data: { error: 'Profile not found' } },
  });
  let page = makePage();
  page.onShow();
  await tick();

  assert(calls.request.some((r) => r.url.includes('/api/user/favorites')), 'GET /api/user/favorites 真实请求');
  assert(page.data.isLoading === false && page.data.error === '', '加载完成无错误');
  assert(page.data.podcasts.length === 2 && page.data.episodes.length === 2, '两个列表均渲染');

  const p1 = page.data.podcasts[0];
  assert(p1.firstTag === '词汇故事', '首个分类标签（中文原样展示）');
  assert(p1.playsShort === '2.8k', '收听数 >999 缩写为 x.xk（对齐 formatPlaysShort）');
  assert(page.data.podcasts[1].playsShort === '890', '≤999 原样显示');
  assert(p1.author === 'VOA Learning English', '作者/平台行');

  const e1 = page.data.episodes[0];
  assert(e1.subtitle === 'The Daily · The New York Times', '副标题 = 所属播客 · 平台');
  assert(e1.durationText === '33:07', '时长服务端口径直传（时钟遮罩文本）');
  assert(e1.playCountText === '1,234,567', '收听数千分位（对齐 %,d）');
  const e2 = page.data.episodes[1];
  assert(e2.subtitle === '6 Minute English', '平台为空时只保留播客名');
  assert(e2.durationText === '--', '时长为空降级为 --');

  section('登录闸 · 未登录不发请求');
  resetMock();
  page = makePage();
  page.onShow();
  await tick();
  assert(page.data.needLogin === true, '未登录 → needLogin 错误态');
  assert(!calls.request.some((r) => r.url.includes('/api/user/favorites')), '未登录不请求收藏列表');

  section('Tab 切换 · 计数与过滤');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init();
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
  });
  page = makePage();
  page.onShow();
  await tick();
  assert(page.data.activeTab === 'podcasts', '默认播客 Tab');
  page.onSelectTab({ currentTarget: { dataset: { tab: 'episodes' } } });
  assert(page.data.activeTab === 'episodes', '切到单集 Tab（搜索占位文本随 wxml 绑定切换）');
  page.onSelectTab({ currentTarget: { dataset: { tab: 'episodes' } } });
  assert(
    calls.request.filter((r) => r.url.includes('/api/user/favorites')).length === 1,
    '重复点同 Tab 无副作用（不重发列表请求）',
  );

  // 搜索过滤：标题/作者不区分大小写包含匹配
  page.onSearchInput({ detail: { value: 'VOA' } });
  assert(
    page.data.filteredPodcasts.length === 1 && page.data.filteredPodcasts[0].id === 'p1',
    '按作者 VOA 过滤（大小写不敏感）',
  );
  page.onSearchInput({ detail: { value: 'family restaurant' } });
  assert(
    page.data.filteredEpisodes.length === 1 && page.data.filteredEpisodes[0].id === 'e1',
    '单集 Tab 按标题过滤',
  );
  page.onSearchInput({ detail: { value: '不存在的关键字' } });
  assert(
    page.data.filteredPodcasts.length === 0 && page.data.filteredEpisodes.length === 0,
    '无匹配 → 空态（wxml 渲染收藏空框）',
  );
  page.onClearSearch();
  assert(page.data.filteredPodcasts.length === 2, '清空搜索恢复全量');

  section('乐观取消收藏 · 播客（成功路径）');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init();
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
    '/api/podcast/favorite/delete': { statusCode: 200, data: { success: true } },
  });
  page = makePage();
  page.onShow();
  await tick();
  page.onRemovePodcast({ currentTarget: { dataset: { id: 'p1' } } });
  assert(page.data.podcasts.length === 1 && page.data.podcasts[0].id === 'p2', '点击后本地立即移除（乐观 UI，Tab 计数随之 -1）');
  await tick();
  const delReq = calls.request.find(
    (r) => r.method === 'DELETE' && r.url.includes('/api/podcast/favorite/delete'),
  );
  assert(!!delReq, 'DELETE /api/podcast/favorite/delete');
  assert(delReq.data.podcastid === 'p1' && delReq.data.userid === 'u1', 'urlencoded 体 { podcastid, userid }');
  assert(
    delReq.header['Content-Type'] === 'application/x-www-form-urlencoded',
    '表单编码（对齐 Android @FormUrlEncoded）',
  );
  assert(toasts.some((t) => t === '已取消收藏'), '成功 toast「已取消收藏」');

  section('乐观取消收藏 · 单集 + 失败回滚');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init();
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
    '/api/episode/favorite/delete': { statusCode: 400, data: { error: '收藏记录不存在' } },
  });
  page = makePage();
  page.onShow();
  await tick();
  page.onRemoveEpisode({ currentTarget: { dataset: { id: 'e1' } } });
  assert(page.data.episodes.length === 1, '乐观移除单集');
  await tick();
  const epDel = calls.request.find((r) => r.url.includes('/api/episode/favorite/delete'));
  assert(!!epDel && epDel.data.episodeid === 'e1', 'DELETE /api/episode/favorite/delete');
  assert(page.data.episodes.length === 2 && page.data.episodes[0].id === 'e1', '失败回滚快照（对齐 FavoriteCenter）');
  assert(toasts.some((t) => t.includes('收藏记录不存在')), '失败透出后端文案');
  assert(page.data.filteredEpisodes.length === 2, '回滚同步过滤结果');

  section('防重入 · 在途请求期间重复点击');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init();
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
  });
  page = makePage();
  page.onShow();
  await tick();
  // DELETE 悬挂不回调，模拟慢网络
  const origHandler = requestHandler;
  requestHandler = (opts) => {
    if (opts.url.includes('/api/podcast/favorite/delete')) return; // 悬挂
    origHandler(opts);
  };
  page.onRemovePodcast({ currentTarget: { dataset: { id: 'p1' } } });
  page.onRemovePodcast({ currentTarget: { dataset: { id: 'p1' } } });
  const delCount = calls.request.filter((r) => r.url.includes('/api/podcast/favorite/delete')).length;
  assert(delCount === 1, '在途期间重复点击只发一次（对齐 pendingKeys）');

  section('下拉刷新 · 静默重载');
  resetMock();
  storage.set('token', 'jwt');
  storage.set('userInfo', { userid: 'u1' });
  authStore.init();
  requestHandler = routeAwareHandler({
    '/api/user/favorites': { statusCode: 200, data: FAVORITES_BODY },
  });
  page = makePage();
  page.onShow();
  await tick();
  await page.onPullDownRefresh();
  assert(calls.request.filter((r) => r.url.includes('/api/user/favorites')).length === 2, '下拉触发重取');

  /* ---------- 汇总 ---------- */
  console.log(`\n══════════════════════════════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failed) {
    console.log('失败用例：', failures.join(' | '));
    process.exit(1);
  }
})();
