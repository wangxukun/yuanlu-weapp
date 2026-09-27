/**
 * scripts/test-history.js — 「收听历史」页自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），全链路驱动
 * pages/library/history/index.js → utils/request.js → wx.request：
 * 覆盖登录闸、DTO 映射（Float 秒取整/比例钳制/时长回退/"已听 M:SS" 文本）、
 * 今天/昨天/具体日期/更早 分组、三段过滤切换重置重拉、分页拼接与到底闸、
 * 在途防重入、错误重试、下拉刷新回第 1 页。
 *
 * 运行：node scripts/test-history.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const navigations = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  showModal: () => {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light' }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__pageConfig = cfg);

/** 路由感知的默认应答：值可为对象或 (opts)=>resp */
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
require(path.join(__dirname, '../pages/library/history/index.js'));
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

function makePage() {
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    _loading: false,
    _hasLoaded: false,
  });
  page.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

function resetMock() {
  storage.clear();
  toasts.length = 0;
  navigations.length = 0;
  calls.request.length = 0;
  requestHandler = null;
  authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
}

const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 构造历史条目 DTO（对齐 HistoryItemDto：progressSeconds 为 Float） */
function dto(over) {
  return Object.assign(
    {
      historyid: 1,
      listenAt: '2026-09-04T07:00:00.123Z',
      progressSeconds: 101.767,
      isFinished: false,
      episode: {
        id: 'ep1',
        title: 'How to talk about the future',
        author: 'BBC',
        category: '6 Minute English',
        thumbnailUrl: 'https://oss/ep1.jpg',
        duration: '6:14',
        durationSeconds: 374,
      },
    },
    over
  );
}

/** 服务端应答体 */
function pageBody(items, total, hasMore) {
  return { statusCode: 200, data: { success: true, data: { items, total, hasMore } } };
}

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- 1. 登录闸 ---------- */
  section('登录闸：未登录不发请求');
  resetMock();
  {
    const page = makePage();
    page.onLoad();
    await page.onShow();
    assert(calls.request.length === 0, '未登录不发出任何请求');
    assert(page.data.needLogin === true && page.data.isLoading === false, '落在未登录引导态');
  }

  /* ---------- 2. 首载映射 + 分组 ---------- */
  section('首载：DTO 映射与 今天/昨天/具体日期/更早 分组');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: { id: 'u1' } });
  {
    const nowIso = new Date().toISOString();
    const yestIso = new Date(Date.now() - 86400000).toISOString();
    requestHandler = routeAwareHandler({
      '/api/user/history': () =>
        pageBody(
          [
            dto({ historyid: 1, listenAt: nowIso, progressSeconds: 77.4, episode: Object.assign(dto().episode, { duration: '6:14', durationSeconds: 374 }) }),
            dto({ historyid: 2, listenAt: yestIso, progressSeconds: 374, isFinished: true }),
            dto({ historyid: 3, listenAt: '2026-09-04T07:00:00.123Z' }),
            dto({ historyid: 4, listenAt: 'not-a-date' }),
          ],
          11,
          true
        ),
    });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();

    const url = calls.request[0] && calls.request[0].url;
    assert(/\/api\/user\/history\?page=1&pageSize=20&status=all/.test(url), '请求参数 page=1&pageSize=20&status=all');

    const it1 = page.data.items[0];
    assert(it1.progressSeconds === 77, 'Float 秒取整（77.4 → 77）');
    assert(it1.percent === 21 && Math.abs(it1.ratio - 77 / 374) < 1e-9, '比例与百分比（77/374 → 21%）');
    assert(it1.progressText === '已听 1:17 / 6:14', '进度文本 "已听 1:17 / 6:14"（服务端 duration 优先）');
    assert(page.data.items[1].isFinished === true, 'isFinished 透传');

    const labels = page.data.groups.map((g) => g.label);
    assert(labels[0] === '今天' && labels[1] === '昨天', '今天/昨天分组');
    assert(labels[2] === '2026年9月4日', '更早显示具体日期（月/日无前导零）');
    assert(labels[3] === '更早', '解析失败归入「更早」');
    assert(page.data.groups[0].items.length === 1, '组内条目归属正确');
    assert(page.data.total === 11 && page.data.page === 1 && page.data.endReached === false, 'total/page/hasMore 状态');
    assert(page.data.isLoadingMore === false, '首载不落 isLoadingMore');
  }

  /* ---------- 3. 时长回退与边界 ---------- */
  section('映射边界：duration 缺失回退 / 比例钳制 / 零时长');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    requestHandler = routeAwareHandler({
      '/api/user/history': () =>
        pageBody(
          [
            dto({ historyid: 1, progressSeconds: 500, episode: { id: 'e', title: 'T', category: '', thumbnailUrl: '', duration: '', durationSeconds: 374 } }),
            dto({ historyid: 2, progressSeconds: 30, episode: { id: 'e2', title: 'T2', category: 'C', thumbnailUrl: '', duration: '', durationSeconds: 0 } }),
          ],
          2,
          false
        ),
    });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    assert(page.data.items[0].progressText === '已听 8:20 / 6:14', 'duration 缺失回退 formatMillis(durationSeconds)');
    assert(page.data.items[0].ratio === 1 && page.data.items[0].percent === 100, '比例钳制上界 1');
    assert(page.data.items[1].ratio === 0 && page.data.items[1].percent === 0 && page.data.items[1].progressText === '已听 0:30 / 0:00', '零时长 → 0% 且文本回退 0:00');
  }

  /* ---------- 4. 过滤切换 ---------- */
  section('过滤切换：重置分页重拉（对齐 selectFilter）');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    requestHandler = routeAwareHandler({
      '/api/user/history': (opts) => {
        const status = (opts.url.match(/status=([a-z-]+)/) || [])[1];
        return pageBody(status === 'finished' ? [dto({ historyid: 9, isFinished: true })] : [dto()], 11, false);
      },
    });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    assert(page.data.items.length === 1 && page.data.total === 11, 'all 首载就绪');

    await page.onSelectFilter({ currentTarget: { dataset: { key: 'finished' } } });
    await tick();
    const last = calls.request[calls.request.length - 1];
    assert(/status=finished/.test(last.url), '切换后按 status=finished 重拉');
    assert(page.data.items[0].historyid === 9, '列表被替换（非拼接）');
    assert(page.data.page === 1, '页码重置为 1');

    await page.onSelectFilter({ currentTarget: { dataset: { key: 'finished' } } });
    await tick();
    assert(calls.request.length === 2, '重复点击当前 Tab 不重拉');
  }

  /* ---------- 5. 分页加载与到底闸 ---------- */
  section('分页：loadMore 拼接 / endReached / 到底后不再请求');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    requestHandler = routeAwareHandler({
      '/api/user/history': (opts) => {
        const p = Number((opts.url.match(/page=(\d+)/) || [])[1]);
        return p === 1 ? pageBody([dto({ historyid: 1 }), dto({ historyid: 2 })], 3, true) : pageBody([dto({ historyid: 3 })], 3, false);
      },
    });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();

    page.onReachBottom();
    await tick();
    assert(page.data.items.length === 3 && page.data.items[2].historyid === 3, '第二页拼接在尾部');
    assert(page.data.page === 2 && page.data.endReached === true, 'hasMore=false → endReached');

    page.onReachBottom();
    await tick();
    assert(calls.request.length === 2, '到底后 loadMore 不再发请求');
  }

  /* ---------- 6. 在途防重入 ---------- */
  section('在途防重入：加载中重复 onReachBottom 只发一请求');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    let release;
    requestHandler = (opts) => {
      const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (p === '/api/user/history') {
        release = () => opts.success(pageBody([dto()], 1, false));
        // 挂起不答，模拟在途
      }
    };
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    assert(calls.request.length === 1, '首载在途');
    page.onReachBottom(); // isLoading=true 期间 → 应被闸住
    await tick();
    assert(calls.request.length === 1, '在途期间 loadMore 被防重入闸挡下');
    release && release();
    await tick();
    assert(page.data.items.length === 1 && page.data.isLoading === false, '释放后正常落库');
  }

  /* ---------- 7. 错误态与重试 ---------- */
  section('错误态：业务失败文案 + 重试恢复');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    let fail = true;
    requestHandler = (opts) => {
      const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (p === '/api/user/history') {
        opts.success(fail ? { statusCode: 500, data: { success: false, error: '服务器开小差了' } } : pageBody([dto()], 1, false));
      }
    };
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    assert(page.data.error === '服务器开小差了' && page.data.isLoading === false, '错误文案落到错误态');
    page.onReachBottom();
    await tick();
    assert(calls.request.length === 1, '错误态下 loadMore 被闸（对齐 loadMore 的 error 闸）');

    fail = false;
    await page.onRetry();
    await tick();
    assert(page.data.error === '' && page.data.items.length === 1, '重试成功恢复列表');
  }

  /* ---------- 8. 下拉刷新 ---------- */
  section('下拉刷新：回第 1 页并替换列表');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    let page1Calls = 0;
    requestHandler = routeAwareHandler({
      '/api/user/history': (opts) => {
        const p = Number((opts.url.match(/page=(\d+)/) || [])[1]);
        if (p === 1) {
          page1Calls += 1;
          // 首次第 1 页返回两条且还有更多；刷新后的第 1 页返回单条新数据
          return page1Calls === 1 ? pageBody([dto({ historyid: 1 }), dto({ historyid: 2 })], 3, true) : pageBody([dto({ historyid: 100 })], 1, false);
        }
        return pageBody([dto({ historyid: 3 })], 3, false);
      },
    });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    assert(page.data.items.length === 2 && page.data.endReached === false, '首载 2 条未到底');
    page.onReachBottom();
    await tick();
    assert(page.data.items.length === 3, '拼上第 2 页共 3 条');

    await page.onPullDownRefresh();
    await tick();
    const last = calls.request[calls.request.length - 1];
    assert(/page=1/.test(last.url), '刷新重拉第 1 页');
    assert(page.data.items.length === 1 && page.data.items[0].historyid === 100, '列表被第 1 页新数据替换（非拼接）');
    assert(page.data.page === 1, '页码归位 1');
  }

  /* ---------- 9. 跳转 ---------- */
  section('卡片点击跳转剧集详情');
  resetMock();
  authStore.setState({ isLoggedIn: true, token: 't', userInfo: null });
  {
    requestHandler = routeAwareHandler({ '/api/user/history': () => pageBody([dto()], 1, false) });
    const page = makePage();
    page.onLoad();
    await page.onShow();
    await tick();
    page.onOpenEpisode({ currentTarget: { dataset: { id: 'ep1' } } });
    assert(navigations[0] === '/pages/episode/episode?id=ep1', '跳转 /pages/episode/episode?id=ep1');
    page.onOpenEpisode({ currentTarget: { dataset: {} } });
    assert(navigations.length === 1, '缺 id 不跳转');
  }

  /* ---------- 汇总 ---------- */
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('失败项：' + failures.join(' / '));
    process.exit(1);
  }
})();
