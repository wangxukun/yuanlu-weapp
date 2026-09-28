/**
 * scripts/test-paths.js — 「学习路径」列表/详情页自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp），全链路驱动
 * pages/library/paths/index.js 与 detail.js → utils/request.js → wx.request：
 * 覆盖登录闸、双 Tab 并行拉取与本地搜索过滤、DTO 映射（角标/进度钳制/兜底文案）、
 * 免费配额墙与 AI 生成墙（会员弹窗承接）、创建/AI 生成提交（含 403 降级与
 * LLM 失败回退手动创建预填）、卡片跳转；详情页 owner 判定、播放队列专属过滤、
 * 编辑（POST 别名）/删除/添加剧集（防抖搜索+业务失败 toast）/移除/分享。
 *
 * 运行：node scripts/test-paths.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const navigations = [];
const modals = [];
const calls = { request: [] };
let requestHandler = null;
let modalConfirm = true;
let clipboard = '';

function bgmStub() {
  const h = {};
  ['onPlay', 'onPause', 'onStop', 'onEnded', 'onError', 'onWaiting', 'onCanplay',
    'onTimeUpdate', 'onNext', 'onPrev', 'onSeeked'].forEach((k) => { h[k] = () => {}; });
  h.play = () => {};
  h.pause = () => {};
  h.stop = () => {};
  h.seek = () => {};
  return h;
}

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => {
    modals.push(o);
    o.success({ confirm: modalConfirm, cancel: !modalConfirm });
  },
  navigateTo: (o) => navigations.push(o.url),
  switchTab: () => {},
  navigateBack: () => navigations.push('__back__'),
  stopPullDownRefresh: () => {},
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light' }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  setClipboardData: (o) => {
    clipboard = o.data;
    o.success && o.success();
  },
  getBackgroundAudioManager: () => (global.__bgm || (global.__bgm = bgmStub())),
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__pageConfig = cfg);
global.getApp = () => global.__app || (global.__app = { globalData: {} });

/** 路由感知的默认应答：值可为对象或 (opts)=>resp */
function routeAwareHandler(routes) {
  return (opts) => {
    const path = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[path];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

const path = require('path');
const authStore = require(path.join(__dirname, '../store/authStore.js'));
const audioManager = require(path.join(__dirname, '../utils/audioManager.js'));
require(path.join(__dirname, '../pages/library/paths/index.js'));
const listConfig = global.__pageConfig;
global.__pageConfig = null;
require(path.join(__dirname, '../pages/library/paths/detail.js'));
const detailConfig = global.__pageConfig;
audioManager.init();

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

function makePage(config, extra) {
  const page = Object.assign({}, config, {
    data: JSON.parse(JSON.stringify(config.data)),
  }, extra || {});
  page.setData = function (patch, cb) {
    Object.assign(this.data, patch);
    if (typeof cb === 'function') cb();
  };
  return page;
}

function makeListPage() { return makePage(listConfig, { _loading: false, _hasLoaded: false }); }
function makeDetailPage(id) {
  return makePage(detailConfig, { _loadedPathId: null, _searchTimer: null, _searchSeq: 0 });
}

function resetMock() {
  storage.clear();
  toasts.length = 0;
  navigations.length = 0;
  modals.length = 0;
  calls.request.length = 0;
  requestHandler = null;
  modalConfirm = true;
  clipboard = '';
  global.__app = { globalData: {} };
  authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
  // 复位播放器会话（场景间状态不串扰；close 空会话安全）
  audioManager.close();
}

const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 登录态：token + userInfo（role 可覆盖） */
function login(role, userid) {
  storage.set('token', 'test-token');
  authStore.setState({
    isLoggedIn: true,
    token: 'test-token',
    userInfo: { userid: userid || 'u1', role: role || 'USER', nickname: '远路漫漫' },
  });
}

/** 路径摘要 DTO（对齐 LearningPathSummaryDto） */
function summaryDto(over) {
  return Object.assign(
    {
      pathid: 1,
      pathName: '冰谷之死',
      description: '一组关于冰川消融的深度报道',
      isPublic: true,
      itemCount: 12,
      coverUrl: 'https://oss.example/cover.jpg?sig=1',
      creatorName: '远路漫漫',
      creationAt: '2026-09-01T00:00:00.000Z',
      progress: 8,
      isOfficial: false,
    },
    over
  );
}

/** 详情 DTO（对齐 LearningPathDetailDto / getMobileDetail） */
function detailDto(over) {
  return Object.assign(
    {
      pathid: 5,
      userid: 'u1',
      pathName: '冰谷之死',
      description: '一组关于冰川消融的深度报道',
      isPublic: true,
      creationAt: '2026-09-01T00:00:00.000Z',
      coverUrl: 'https://oss.example/cover.jpg?sig=1',
      creatorName: '远路漫漫',
      items: [
        {
          id: 101, episodeid: 'ep1', order: 1, addedAt: null,
          episode: {
            episodeid: 'ep1', title: 'The Death of Ice', coverUrl: 'c1', audioUrl: 'a1',
            duration: 725, isExclusive: false, podcast: { title: 'BBC' },
            progressSeconds: 100.4, isFinished: false,
          },
        },
        {
          id: 102, episodeid: 'ep2', order: 2, addedAt: null,
          episode: {
            episodeid: 'ep2', title: 'Glacier Talk', coverUrl: 'c2', audioUrl: 'a2',
            duration: 300, isExclusive: true, podcast: { title: 'NYT' },
            progressSeconds: 300, isFinished: true,
          },
        },
        {
          id: 103, episodeid: 'ep3', order: 3, addedAt: null,
          episode: {
            episodeid: 'ep3', title: 'Cold World', coverUrl: 'c3', audioUrl: 'a3',
            duration: 0, isExclusive: false, podcast: { title: '' },
            progressSeconds: 0, isFinished: false,
          },
        },
      ],
    },
    over
  );
}

/** 列表页常用应答集（subscription 默认非会员） */
function listRoutes(extra) {
  return Object.assign(
    {
      '/api/user/subscription/status': { statusCode: 200, data: { success: true, role: 'USER' } },
      '/api/learning-paths/mine': { statusCode: 200, data: { success: true, data: [summaryDto()] } },
      '/api/learning-paths/public': {
        statusCode: 200,
        data: { success: true, data: [summaryDto({ pathid: 2, pathName: 'Business English', creatorName: '' })] },
      },
    },
    extra
  );
}

/* ==================== 列表页 ==================== */

(async () => {
section('列表页 · 登录闸与加载');

resetMock();
requestHandler = routeAwareHandler(listRoutes());
{
  const page = makeListPage();
  page.onLoad();
  page.onShow();
  assert(page.data.needLogin === true && page.data.isLoading === false, '未登录落在引导态（不发请求）');
  assert(calls.request.length === 0, '未登录不发任何请求');
}

resetMock();
login();
requestHandler = routeAwareHandler(listRoutes());
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  const urls = calls.request.map((c) => c.url);
  assert(
    urls.includes('https://example.none/api/learning-paths/mine') ||
      calls.request.some((c) => c.url.indexOf('/api/learning-paths/mine') !== -1),
    '我的集合走 GET /api/learning-paths/mine'
  );
  assert(
    calls.request.some((c) => c.url.indexOf('/api/learning-paths/public') !== -1),
    '发现走 GET /api/learning-paths/public（与我的集合并行拉取）'
  );
  assert(page.data.isLoading === false && !page.data.error, '加载完成进入内容态');
  const mapped = page.data.myPaths[0];
  assert(mapped.badge === 'PUBLIC' && mapped.badgeIcon === 'public', '公开路径映射 PUBLIC 角标');
  assert(mapped.itemCountText === '12 集' && mapped.creatorName === '远路漫漫', '集数与创建者文案');
  assert(mapped.progress === 8 && mapped.description.indexOf('冰川') !== -1, '进度与描述透传');
  assert(page.data.displayPaths.length === 1, '默认渲染「我的集合」列表');
  assert(page.data.isPremium === false, 'subscription/status 校正后为非会员');
}

section('列表页 · DTO 映射边界');

resetMock();
login();
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/mine': {
      statusCode: 200,
      data: {
        success: true,
        data: [
          summaryDto({ pathid: 9, pathName: 'Official', isOfficial: true, progress: 150, description: '   ' }),
          summaryDto({ pathid: 10, pathName: 'Private', isPublic: false, isOfficial: false, creatorName: '' }),
        ],
      },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  const official = page.data.myPaths[0];
  const priv = page.data.myPaths[1];
  assert(official.badge === 'OFFICIAL', 'isOfficial 优先映射 OFFICIAL 角标');
  assert(official.progress === 100, 'progress 150 钳制到 100');
  assert(official.description === '暂无描述', '空白描述兜底「暂无描述」');
  assert(priv.badge === 'PRIVATE' && priv.badgeIcon === 'lock', '私有路径映射 PRIVATE + 锁图标');
  assert(priv.creatorName === '未知创建者', '创建者空串兜底「未知创建者」');
}

section('列表页 · Tab 切换与本地搜索');

resetMock();
login();
requestHandler = routeAwareHandler(listRoutes());
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();

  const tabRequests = calls.request.length;
  page.onSelectTab({ currentTarget: { dataset: { tab: 'discover' } } });
  assert(page.data.activeTab === 'discover' && page.data.displayPaths[0].pathid === 2, '切「发现」渲染公开列表');
  assert(calls.request.length === tabRequests, 'Tab 切换为本地态切换（不重发请求）');

  page.onSelectTab({ currentTarget: { dataset: { tab: 'mine' } } });
  page.onSearchInput({ detail: { value: '冰谷' } });
  assert(page.data.displayPaths.length === 1, '搜索「冰谷」命中我的集合路径');
  page.onSearchInput({ detail: { value: 'ICE' } });
  assert(page.data.displayPaths.length === 0, '搜索大小写不敏感（ICE 未命中中文标题）');
  page.onSearchInput({ detail: { value: 'DEATH OF' } });
  assert(page.data.displayPaths.length === 0, '搜索仅匹配路径名（不匹配描述）');
  page.onClearSearch();
  assert(page.data.displayPaths.length === 1, '清空搜索恢复全量列表');
}

section('列表页 · 创建路径（配额墙 + 提交）');

resetMock();
login('USER');
requestHandler = routeAwareHandler(listRoutes());
{
  // 免费用户已有 1 条（FREE_PATH_LIMIT=1）→ 点创建弹会员窗
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.onCreateClick();
  assert(
    page.data.showPremiumModal === true && page.data.premiumSource === 'path_quota',
    '免费容量已满：创建入口弹 path_quota 会员窗（不发创建请求）'
  );
  assert(page.data.showCreateDialog === false, '配额墙不打开创建弹窗');
  assert(calls.request.every((c) => c.method !== 'POST' || c.url.indexOf('/generate') !== -1), '配额墙零创建请求');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(listRoutes());
{
  // 空列表免费用户 → 打开弹窗 → 空名提交被拦
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.setData({ myPaths: [], displayPaths: [] });
  page.onCreateClick();
  assert(page.data.showCreateDialog === true, '容量未满：打开创建弹窗');
  page.onSubmitCreate();
  assert(toasts[0] === '请输入路径名称', '空路径名提交被拦截');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths': {
      statusCode: 200,
      data: { success: true, message: '创建成功', data: { pathid: 3 } },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.setData({ myPaths: [], displayPaths: [], showCreateDialog: true, formName: ' 词汇学习 ', formDesc: ' ', formPublic: true });
  await page.onSubmitCreate();
  const post = calls.request.find((c) => c.url.indexOf('/api/learning-paths') !== -1 && c.method === 'POST');
  assert(!!post, '创建提交 POST /api/learning-paths');
  assert(
    post.data.pathName === '词汇学习' && post.data.description === null && post.data.isPublic === true,
    '创建请求体：名称去空格 / 空描述 null / 公开标记'
  );
  assert(page.data.showCreateDialog === false && toasts.includes('路径已创建'), '创建成功：关弹窗 + toast');
  assert(page.data.activeTab === 'mine', '创建成功后语义停留在「我的集合」');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths': {
      statusCode: 403,
      data: { success: false, code: 'PATH_QUOTA_EXCEEDED', message: '免费用户最多创建 1 条学习路径' },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.setData({ myPaths: [], displayPaths: [], showCreateDialog: true, formName: 'X' });
  await page.onSubmitCreate();
  assert(page.data.showCreateDialog === false, '服务端配额拦截：关闭创建弹窗');
  assert(
    page.data.showPremiumModal === true && page.data.premiumSource === 'path_quota',
    '服务端配额拦截：弹 path_quota 会员窗（并发兜底）'
  );
}

section('列表页 · AI 生成路径（会员墙 + 生成 + 降级）');

resetMock();
login('USER');
requestHandler = routeAwareHandler(listRoutes());
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.onGenerateClick();
  assert(
    page.data.showPremiumModal === true && page.data.premiumSource === 'path_ai_generate',
    '免费用户点 AI 生成：弹 path_ai_generate 会员窗'
  );
  assert(page.data.showGenerateDialog === false, '免费用户不打开生成弹窗');
}

resetMock();
login('PREMIUM');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/user/subscription/status': { statusCode: 200, data: { success: true, role: 'PREMIUM' } },
    '/api/learning-paths/generate': {
      statusCode: 200,
      data: { success: true, data: { pathid: 8, pathName: '商务英语入门', itemCount: 6 } },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  assert(page.data.isPremium === true, 'subscription/status 校正为会员（紫渐变按钮态）');
  page.onGenerateClick();
  assert(page.data.showGenerateDialog === true, '会员点 AI 生成：打开生成弹窗');
  page.onSubmitGenerate();
  assert(toasts[0] === '请先填写学习主题', '空主题提交被拦截');
  page.setData({ generateTopic: '商务英语入门' });
  await page.onSubmitGenerate();
  const gen = calls.request.find((c) => c.url.indexOf('/api/learning-paths/generate') !== -1);
  assert(!!gen && gen.data.topic === '商务英语入门', '生成提交 POST /generate { topic }');
  assert(page.data.showGenerateDialog === false, '生成成功关闭弹窗');
  assert(
    toasts.some((t) => t.indexOf('AI 已生成「商务英语入门」（6 集）') !== -1),
    '成功 toast 带「名称 + 集数」'
  );
  assert(page.data.activeTab === 'mine', '生成成功切回「我的集合」并刷新');
}

resetMock();
login('PREMIUM');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/user/subscription/status': { statusCode: 200, data: { success: true, role: 'PREMIUM' } },
    '/api/learning-paths/generate': {
      statusCode: 403,
      data: { success: false, code: 'PREMIUM_REQUIRED', message: 'PRO 专属' },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.setData({ showGenerateDialog: true, generateTopic: '口语' });
  await page.onSubmitGenerate();
  assert(
    page.data.showPremiumModal === true && page.data.premiumSource === 'path_ai_generate',
    '403 PREMIUM_REQUIRED：会员态过期缝穴位弹会员窗'
  );
}

resetMock();
login('PREMIUM');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/user/subscription/status': { statusCode: 200, data: { success: true, role: 'PREMIUM' } },
    '/api/learning-paths/generate': {
      statusCode: 503,
      data: { success: false, code: 'LLM_UNAVAILABLE', message: '生成失败，请稍后重试' },
    },
  })
);
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.setData({ showGenerateDialog: true, generateTopic: '一个非常非常非常长的学习主题超过五十字符的话题啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊' });
  await page.onSubmitGenerate();
  assert(page.data.showCreateDialog === true, 'LLM 失败：降级打开手动创建弹窗');
  assert(page.data.formName.length === 50, '降级预填主题并截断 50 字符');
}

section('列表页 · 卡片跳转');

resetMock();
login();
requestHandler = routeAwareHandler(listRoutes());
{
  const page = makeListPage();
  page.onLoad();
  await page.onShow();
  await tick();
  page.onOpenPath({ currentTarget: { dataset: { id: 7 } } });
  assert(navigations[0] === '/pages/library/paths/detail?id=7', '卡片点击跳转详情页（携带 pathid）');
}

/* ==================== 详情页 ===================== */

section('详情页 · 加载与映射');

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({ '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } } })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  assert(page.data.isLoading === false && !!page.data.detail, '详情加载完成');
  const d = page.data.detail;
  assert(d.isOwner === true, 'userid 与当前用户一致 → isOwner（管理入口渲染条件）');
  assert(d.itemCount === 3, '集数统计');
  const [ep1, ep2, ep3] = d.items;
  assert(ep1.durationText === '12:05', '时长格式化 M:SS（725s → 12:05）');
  assert(ep1.progressPercent === 14, '进行中集按进度换算百分比（100.4/725 → 14）');
  assert(ep2.progressPercent === 100, '已听完集百分比 100');
  assert(ep2.isExclusive === true, '专属剧集标记透传');
  assert(ep3.podcastTitle === '' && ep3.progressPercent === 0, '无播客名/无时长集零进度兜底');
}

resetMock();
login('USER', 'u1');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/5': {
      statusCode: 200,
      data: { success: true, data: detailDto({ userid: 'someone-else' }) },
    },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  assert(page.data.detail.isOwner === false, '非拥有者（发现 Tab 进入）无管理入口');
}

section('详情页 · 播放（专属过滤 + 拦截）');

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({ '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } } })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  await page.onPlayAll();
  await tick();
  const st = audioManager.getState();
  assert(
    toasts.includes('已跳过 1 个专属剧集'),
    '非会员播放全部：过滤专属剧集并 toast 跳过数'
  );
  assert(st.currentEpisode && st.currentEpisode.episodeid === 'ep1', '从第一个可播剧集起播');
  assert(st.playlist.length === 2, '播放队列剔除专属剧集（3 → 2）');
  assert(st.playlist[1].episodeid === 'ep3' && st.playlist[1].podcastTitle, '队列条目补齐 podcastTitle 元数据');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/5': {
      statusCode: 200,
      data: {
        success: true,
        data: detailDto({
          items: [
            { id: 1, episodeid: 'epX', order: 1, episode: { episodeid: 'epX', title: 'X', duration: 60, isExclusive: true, coverUrl: 'c', audioUrl: 'a' } },
          ],
        }),
      },
    },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  await page.onPlayAll();
  await tick();
  assert(
    page.data.showPremiumModal === true && page.data.premiumSource === 'exclusive_play',
    '全部为专属且无权限：触发 exclusive_play 会员窗（对齐 Web checkExclusivePlay 兜底）'
  );
  assert(!audioManager.getState().currentEpisode, '无可播剧集不起播');
}

resetMock();
login('PREMIUM');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/user/subscription/status': { statusCode: 200, data: { success: true, role: 'PREMIUM' } },
    '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  await page.onPlayEpisode({ currentTarget: { dataset: { id: 'ep2' } } });
  await tick();
  const st = audioManager.getState();
  assert(st.currentEpisode && st.currentEpisode.episodeid === 'ep2', '会员点专属剧集行直接起播');
  assert(st.playlist.length === 3, '会员播放队列不过滤专属剧集');
}

section('详情页 · 编辑 / 删除（PATCH 的 POST 别名）');

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({ '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } } })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  calls.request.length = 0;
  page.onOpenEdit();
  assert(page.data.editName === '冰谷之死' && page.data.editPublic === true, '编辑弹窗预填当前路径元数据');
  page.setData({ editName: '  新标题 ', editDesc: '新描述' });
  await page.onSubmitEdit();
  const edit = calls.request.find(
    (c) => c.url.endsWith('/api/learning-paths/5') && c.method === 'POST'
  );
  assert(!!edit, '编辑提交走 POST /api/learning-paths/{id}（wx.request 无 PATCH，后端别名）');
  assert(
    edit.data.pathName === '新标题' && edit.data.description === '新描述' && edit.data.isPublic === true,
    '编辑请求体：名称/描述去空格 + 公开标记'
  );
  assert(toasts.includes('已保存'), '编辑成功 toast');
  await tick(); // reloadSilent 的 markPathsDirty 在重拉完成后落位
  assert(global.getApp().globalData.pathsDirty === true, '变更置列表页脏标记（返回静默刷新）');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({ '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } } })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  modalConfirm = true;
  page.onDeletePath();
  await tick(); // 确认回调 → doDeletePath 异步链
  const del = calls.request.find((c) => c.method === 'DELETE' && c.url.endsWith('/api/learning-paths/5'));
  assert(!!del && modals.length === 1, '删除确认弹窗 → DELETE /api/learning-paths/{id}');
  assert(navigations.includes('__back__'), '删除成功退回列表页');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({ '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } } })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  modalConfirm = false; // 取消删除
  page.onDeletePath();
  assert(!calls.request.some((c) => c.method === 'DELETE'), '取消确认不发删除请求');
}

section('详情页 · 添加剧集（防抖搜索 + 业务失败）');

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } },
    '/api/episode/search-for-path': {
      statusCode: 200,
      data: {
        success: true,
        data: [
          { id: 'ep1', title: 'The Death of Ice', thumbnailUrl: 't1', author: 'BBC', duration: 725 },
          { id: 'ep9', title: 'Brand New', thumbnailUrl: 't9', author: 'HBR', duration: 61 },
        ],
      },
    },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  page.onOpenAddDialog();
  assert(page.data.addResults.length === 0, '打开弹窗清空搜索态');
  page.onAddQuery({ detail: { value: 'ice' } });
  await sleep(200);
  assert(
    !calls.request.some((c) => c.url.indexOf('search-for-path') !== -1),
    '500ms 防抖内不发搜索请求'
  );
  await sleep(450);
  const search = calls.request.find((c) => c.url.indexOf('search-for-path') !== -1);
  assert(!!search && search.url.indexOf('query=ice') !== -1, '防抖到期 GET /api/episode/search-for-path?query=');
  assert(page.data.isSearching === false, '搜索完成收起转圈');
  const r = page.data.addResults;
  assert(r.length === 2 && r[0].added === true && r[1].added === false, '已在路径中的结果置灰（added 标记）');
  assert(r[1].durationText === '1:01', '搜索结果时长格式化');

  // 业务失败：重复添加（200 + success:false + message）
  calls.request.length = 0;
  page.onAddEpisode({ currentTarget: { dataset: { id: 'ep1' } } });
  await tick();
  assert(toasts[0] === '该剧集已在列表中', '客户端去重先行拦截重复添加');
}

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } },
    '/api/learning-paths/5/episodes': {
      statusCode: 200,
      data: { success: true, message: '已添加' },
    },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  await page.onAddEpisode({ currentTarget: { dataset: { id: 'ep9' } } });
  await tick();
  const add = calls.request.find(
    (c) => c.url.endsWith('/api/learning-paths/5/episodes') && c.method === 'POST'
  );
  assert(!!add && add.data.episodeid === 'ep9', '添加剧集 POST .../episodes { episodeid }');
  assert(toasts.includes('已添加到路径'), '添加成功 toast');
  assert(
    calls.request.some((c) => c.url.indexOf('/api/learning-paths/5') !== -1 && c.method === 'GET'),
    '添加后静默重拉详情'
  );
}

section('详情页 · 移除剧集 / 分享');

resetMock();
login('USER');
requestHandler = routeAwareHandler(
  listRoutes({
    '/api/learning-paths/5': { statusCode: 200, data: { success: true, data: detailDto() } },
  })
);
{
  const page = makeDetailPage();
  page.onLoad({ id: '5' });
  await page.onShow();
  await tick();
  modalConfirm = true;
  calls.request.length = 0;
  page.onRemoveEpisode({ currentTarget: { dataset: { item: '102', ep: 'ep2' } } });
  await tick(); // 确认回调 → doRemoveEpisode 异步链
  const del = calls.request.find(
    (c) => c.method === 'DELETE' && c.url.endsWith('/api/learning-paths/5/episodes/102')
  );
  assert(!!del, '移除确认 → DELETE .../episodes/{itemId}（learning_path_items.id）');
  assert(toasts.includes('已从路径移除'), '移除成功 toast');

  page.onShare();
  assert(
    clipboard === 'https://www.wxkzd.com/library/learning-paths/5',
    '分享=复制 Web 落地页链接（对齐 Web clipboard 口径）'
  );
}

/* ==================== 汇总 ===================== */

console.log(`\n========== 学习路径模块测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
})().catch((err) => {
  console.error('测试脚本执行异常：', err);
  process.exit(1);
});
