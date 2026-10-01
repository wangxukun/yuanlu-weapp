/**
 * scripts/test-notifications.js — 「消息通知」模块自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），三层覆盖：
 *   1. utils/notification-core 纯函数：date-fns zh-CN 相对时间全语义移植
 *      （阈值/文案/日历月差）、TABS/TYPE_LABEL/TYPE_BADGE 映射、targetUrl
 *      路由映射、mapList 未读派生、filterByTab；
 *   2. pages/notifications 页面全链路：登录闸、列表装饰、客户端分页扩窗
 *      （20/页 + 到底闸）、Tab 过滤重置、乐观已读（POST /read 请求体 +
 *      未读数递减 + 已读项不重发）、一键全部已读（{all:true} + 失败 toast）、
 *      长按删除（showModal 确认 + POST /delete 请求体 + 移除 + 未读重算 +
 *      失败 toast）、下拉刷新重拉、可跳转项 navigateTo；
 *   3. mine 入口：登录拉未读角标、登出清零、onNotifications 跳转、wxml
 *      插入位置（外观设置 → 消息通知 → 帮助与支持）与 99+ 角标绑定；
 *   4. 结构红线：WXML 绑定零方法调用、未读红点/双态类名/空态文案、
 *      图标资产与台账登记。
 *
 * 运行：node scripts/test-notifications.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const storage = new Map();
const toasts = [];
const navigations = [];
const modalCalls = [];
const dots = []; // tabBar 红点 API 调用记录（type: show/hide）
const calls = { request: [] };
let requestHandler = null;
let modalConfirm = true;
let pullRefreshStopped = 0;
let dotFailMode = null; // 'show' | 'hide' | null —— 模拟非 Tab 页 "not TabBar page" 失败

// 前台轮询定时器桩（真 setInterval 会挂住 Node 进程；手动 firePoll 驱动节拍）
const pollTimers = []; // { id, fn, ms, cleared }
global.setInterval = (fn, ms) => {
  const id = pollTimers.length + 1;
  pollTimers.push({ id, fn, ms, cleared: false });
  return id;
};
global.clearInterval = (id) => {
  const t = pollTimers.find((x) => x.id === id);
  if (t) t.cleared = true;
};
/** 触发所有在途轮询节拍一次 */
const firePoll = () => pollTimers.filter((t) => !t.cleared).forEach((t) => t.fn());

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  showModal: (o) => {
    modalCalls.push(o);
    o.success({ confirm: modalConfirm });
  },
  navigateTo: (o) => navigations.push(o.url),
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {
    pullRefreshStopped += 1;
  },
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light' }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  showTabBarRedDot: (o) => {
    dots.push({ type: 'show', index: o.index });
    if (dotFailMode === 'show' && o.fail) {
      o.fail({ errMsg: 'showTabBarRedDot:fail not TabBar page' });
    } else if (o.success) {
      o.success();
    }
  },
  hideTabBarRedDot: (o) => {
    dots.push({ type: 'hide', index: o.index });
    if (dotFailMode === 'hide' && o.fail) {
      o.fail({ errMsg: 'hideTabBarRedDot:fail not TabBar page' });
    } else if (o.success) {
      o.success();
    }
  },
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__pageConfig = cfg);

/** 路由感知应答：值可为对象或 (opts)=>resp */
function routeAwareHandler(routes) {
  return (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[p];
    const resp =
      typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

require(path.join(__dirname, '../store/authStore.js'));
const authStore = require(path.join(__dirname, '../store/authStore.js'));
const core = require(path.join(__dirname, '../utils/notification-core.js'));

require(path.join(__dirname, '../pages/notifications/index.js'));
const notifConfig = global.__pageConfig;
require(path.join(__dirname, '../pages/mine/index.js'));
const mineConfig = global.__pageConfig;

const WXML_NOTIF = fs.readFileSync(
  path.join(__dirname, '../pages/notifications/index.wxml'), 'utf8');
const WXML_MINE = fs.readFileSync(
  path.join(__dirname, '../pages/mine/index.wxml'), 'utf8');

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

/** setData 桩：支持 'a.b[0].c' 路径键（真机语义） */
function setPath(obj, key, val) {
  const parts = String(key).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    const m = seg.match(/^([^[\]]+)\[(\d+)\]$/);
    if (m) {
      const name = m[1];
      const idx = Number(m[2]);
      if (!Array.isArray(cur[name])) cur[name] = [];
      if (i === parts.length - 1) cur[name][idx] = val;
      else {
        if (!cur[name][idx]) cur[name][idx] = {};
        cur = cur[name][idx];
      }
    } else if (i === parts.length - 1) {
      cur[seg] = val;
    } else {
      if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
      cur = cur[seg];
    }
  }
}

function makePage(config, extra) {
  const page = Object.assign({}, config, {
    data: JSON.parse(JSON.stringify(config.data)),
  }, extra || {});
  page.setData = function (patch) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') >= 0 || k.indexOf('[') >= 0) setPath(this.data, k, patch[k]);
      else this.data[k] = patch[k];
    });
  };
  return page;
}

function resetMock() {
  storage.clear();
  toasts.length = 0;
  navigations.length = 0;
  modalCalls.length = 0;
  dots.length = 0;
  calls.request.length = 0;
  requestHandler = null;
  modalConfirm = true;
  pullRefreshStopped = 0;
  dotFailMode = null;
  authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
}

const tick = async (n = 16) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/** 通知 DTO 工厂 */
function dto(id, over) {
  return Object.assign(
    {
      notificationid: id,
      notificationText: '通知正文 ' + id,
      notificationAt: '2026-09-30T04:00:00.000Z',
      isRead: false,
      type: 'SYSTEM',
      targetUrl: null,
      referenceId: null,
      referenceType: null,
    },
    over || {}
  );
}

/** 构造 N 条列表（前 unreadUnread 条未读，类型轮换七类） */
function buildListDto(n, unread) {
  const types = ['COMMENT', 'REPLY', 'LIKE', 'SYSTEM', 'EPISODE_UPDATE', 'ACHIEVEMENT', 'STUDY'];
  const notifications = [];
  for (let i = 0; i < n; i += 1) {
    notifications.push(
      dto(i + 1, {
        type: types[i % types.length],
        isRead: i >= (unread === undefined ? 0 : unread),
        notificationAt: '2026-09-30T04:00:00.000Z',
      })
    );
  }
  return { unreadCount: unread === undefined ? 0 : unread, notifications };
}

/** 取某路径的请求体（method 过滤） */
function bodies(method, p) {
  return calls.request
    .filter((r) => (method ? r.method === method : true) && (!p || r.url.indexOf(p) >= 0))
    .map((r) => r.data);
}

(async () => {
  /* ==================== 一、纯函数 ==================== */

  section('一、常量映射（TABS / TYPE_LABEL / TYPE_BADGE）');
  {
    assert(core.TABS.length === 6 &&
      core.TABS[0].id === 'ALL' && core.TABS[0].label === '全部' &&
      core.TABS[5].id === 'EPISODE_UPDATE' && core.TABS[5].label === '更新',
      'TABS 六段顺序与文案（全部→更新）');
    assert(core.TYPE_LABEL.COMMENT === '评论' && core.TYPE_LABEL.STUDY === '学习' &&
      Object.keys(core.TYPE_LABEL).length === 7, 'TYPE_LABEL 七类型中文标签');
    assert(core.TYPE_BADGE.REPLY === 'primary' && core.TYPE_BADGE.SYSTEM === 'neutral' &&
      Object.keys(core.TYPE_BADGE).length === 7, 'TYPE_BADGE 七类型徽章键');
  }

  section('二、formatDistanceZh（date-fns zh-CN 全语义）');
  {
    // 固定参考钟（显式 now 参数，不依赖 Date.now——跨天翻转红线）
    const NOW = new Date('2026-09-30T12:00:00'); // 本地时区参考时刻
    const at = (minutesBefore) =>
      new Date(NOW.getTime() - minutesBefore * 60000).toISOString();
    const zh = (min) => core.formatDistanceZh(at(min), NOW);

    assert(core.formatDistanceZh(null, NOW) === '', '空时间 → 空串');
    assert(core.formatDistanceZh('not-a-date', NOW) === '', '非法时间 → 空串');
    assert(zh(0.2) === '不到 1 分钟前', '12 秒 → 不到 1 分钟前');
    assert(zh(1.2) === '1 分钟前', '72 秒 → 1 分钟前');
    assert(zh(5) === '5 分钟前', '5 分钟 → 5 分钟前');
    assert(zh(44) === '44 分钟前', '44 分钟 → 44 分钟前');
    assert(zh(50) === '大约 1 小时前', '50 分钟 → 大约 1 小时前');
    assert(zh(130) === '大约 2 小时前', '2h10m → 大约 2 小时前');
    assert(zh(1200) === '大约 20 小时前', '20 小时 → 大约 20 小时前');
    assert(zh(1500) === '1 天前', '25 小时 → 1 天前');
    assert(zh(3 * 1440) === '3 天前', '3 天 → 3 天前');
    assert(zh(40 * 1440) === '大约 1 个月前', '40 天 → 大约 1 个月前');
    assert(zh(100 * 1440) === '3 个月前', '100 天 → 3 个月前（日历月差）');

    // 年档：日历月差驱动（rem<3 大约 / <9 超过 / ≥9 将近 N+1）——
    // 以 NOW 为基做 setMonth 回退再序列化（Z 串），避免裸 ISO 的 UTC 错位
    const isoMonthsAgo = (m) => {
      const d = new Date(NOW.getTime());
      d.setMonth(d.getMonth() - m);
      return d.toISOString();
    };
    assert(core.formatDistanceZh(isoMonthsAgo(13), NOW) === '大约 1 年前',
      '13 个月 → 大约 1 年前');
    assert(core.formatDistanceZh(isoMonthsAgo(19), NOW) === '超过 1 年前',
      '19 个月 → 超过 1 年前');
    assert(core.formatDistanceZh(isoMonthsAgo(21), NOW) === '将近 2 年前',
      '21 个月 → 将近 2 年前');
    assert(core.formatDistanceZh('2026-12-30T04:00:00.000Z', NOW) === '',
      '未来时间 → 空串（收敛口径）');

    // parseIso：毫秒/Z 截断 + 本地时区换算
    const parsed = core.parseIso('2026-09-30T04:00:00.000Z');
    assert(parsed instanceof Date && !isNaN(parsed.getTime()), 'parseIso 毫秒/Z 兼容');
    assert(core.parseIso('') === null && core.parseIso(42) === null, 'parseIso 非法输入 → null');
  }

  section('三、resolveTarget（Web 路由 → 小程序路由）');
  {
    assert(core.resolveTarget('/episode/abc123') === '/pages/episode/episode?id=abc123',
      '/episode/{id} → 剧集页');
    assert(core.resolveTarget('/charts') === '/pages/profile/learning-report/index',
      '/charts → 学习报表页');
    assert(core.resolveTarget('/charts?tab=week') === '/pages/profile/learning-report/index',
      '/charts?query → 学习报表页（query 剥离）');
    assert(core.resolveTarget('https://example.com/promo') === '' &&
      core.resolveTarget(null) === '', '管理端任意 URL / 空 → 不映射');
  }

  section('四、mapItem / mapList / filterByTab');
  {
    const item = core.mapItem(
      dto(7, { type: 'LIKE', isRead: true, notificationAt: null, targetUrl: '/episode/xyz' }),
      new Date()
    );
    assert(item.typeLabel === '点赞' && item.badge === 'like', 'LIKE 类型标签+徽章映射');
    assert(item.timeText === '' && item.isRead === true, '空时间 → 空文案；isRead 透传');
    assert(item.target === '/pages/episode/episode?id=xyz', 'target 路由预派生');

    const unknown = core.mapItem(dto(8, { type: 'PROMO' }), new Date());
    assert(unknown.typeLabel === 'PROMO' && unknown.badge === 'neutral', '未知类型 → 原值标签 + neutral 徽章');

    const list = core.mapList(buildListDto(5, 2), new Date());
    assert(list.items.length === 5 && list.unreadCount === 2, 'mapList unreadCount 透传');
    const noCount = core.mapList({ notifications: buildListDto(4, 3).notifications }, new Date());
    assert(noCount.unreadCount === 3, 'unreadCount 缺失 → 本地派生');

    const all = core.mapList(buildListDto(7, 0), new Date()).items;
    assert(core.filterByTab(all, 'ALL').length === 7, 'ALL → 全量');
    assert(core.filterByTab(all, 'COMMENT').every((n) => n.type === 'COMMENT') &&
      core.filterByTab(all, 'COMMENT').length === 1, 'COMMENT → 仅该类型（7 类轮换各 1 条）');
    assert(core.filterByTab(all, 'NOPE').length === 0, '未知 Tab → 空');
  }

  /* ==================== 二、通知页全链路 ==================== */

  section('五、登录闸与首载');
  {
    resetMock();
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    assert(page.data.needLogin === true && calls.request.length === 0, '未登录 → 引导态零请求');

    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: { role: 'USER' } });
    requestHandler = routeAwareHandler({ '/api/notification/list': { statusCode: 200, data: buildListDto(3, 2) } });
    const p2 = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    p2.onShow();
    await tick();
    assert(calls.request.length === 1 && calls.request[0].url.indexOf('/api/notification/list') >= 0,
      '首载 GET /api/notification/list');
    assert(p2.data.isLoading === false && p2.data.items.length === 3, '列表装饰 3 条');
    assert(p2.data.unreadCount === 2, '未读数 = 本地重算 2');
    assert(p2.data.items[0].timeText.length > 0, '相对时间文案已派生');
  }

  section('六、客户端分页（20/页 + 扩窗 + 到底闸）');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({ '/api/notification/list': { statusCode: 200, data: buildListDto(45, 3) } });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    assert(page.data.items.length === 20 && page.data.total === 45 && page.data.endReached === false,
      '首窗 20 条 / 总 45 / 未到底');
    page.loadMore();
    assert(page.data.items.length === 40 && page.data.page === 1, '扩窗 → 40 条（第 2 页）');
    page.loadMore();
    assert(page.data.items.length === 45 && page.data.endReached === true && page.data.page === 2,
      '再扩 → 45 条到底');
    const before = page.data.items.length;
    page.loadMore();
    assert(page.data.items.length === before, '到底后 loadMore no-op');
  }

  section('七、Tab 过滤（客户端切换 + 重置窗口）');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({ '/api/notification/list': { statusCode: 200, data: buildListDto(45, 3) } });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    page.onSelectTab({ currentTarget: { dataset: { id: 'COMMENT' } } });
    assert(page.data.tab === 'COMMENT' && page.data.items.every((n) => n.type === 'COMMENT'),
      '切评论 Tab → 仅评论类型');
    assert(page.data.items.length === 7 && page.data.total === 7 && page.data.endReached === true,
      '过滤后窗口重置（45 条轮换中评论 7 条，单窗到底）');
    page.onSelectTab({ currentTarget: { dataset: { id: 'ALL' } } });
    assert(page.data.items.length === 20 && page.data.page === 0, '切回全部 → 窗口复位第 1 页');
    page.onSelectTab({ currentTarget: { dataset: { id: 'ALL' } } });
    assert(calls.request.length === 1, 'Tab 切换零额外请求（客户端过滤）');
  }

  section('八、乐观已读（单条点击）');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(3, 2) },
      '/api/notification/read': { statusCode: 200, data: { success: true } },
    });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    calls.request.length = 0;

    // 点击未读第 1 条（无 targetUrl → 不跳转）
    page.onItemTap({ currentTarget: { dataset: { id: 1 } } });
    await tick();
    assert(page.data.items[0].isRead === true && page.data.unreadCount === 1,
      '未读点击 → 乐观置已读 + 未读数 2→1');
    assert(bodies('POST', '/api/notification/read').length === 1 &&
      bodies('POST', '/api/notification/read')[0].notificationId === 1,
      'POST /read {notificationId:1}（PATCH 别名链路）');
    assert(navigations.length === 0, '无可映射 targetUrl → 不跳转');

    // 点击已读条目 → 不重发
    page.onItemTap({ currentTarget: { dataset: { id: 1 } } });
    await tick();
    assert(bodies('POST', '/api/notification/read').length === 1, '已读项点击零重发');
  }

  section('九、targetUrl 跳转映射');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': {
        statusCode: 200,
        data: { unreadCount: 1, notifications: [dto(9, { type: 'EPISODE_UPDATE', targetUrl: '/episode/ep-42' })] },
      },
      '/api/notification/read': { statusCode: 200, data: { success: true } },
    });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    page.onItemTap({ currentTarget: { dataset: { id: 9 } } });
    await tick();
    assert(navigations[0] === '/pages/episode/episode?id=ep-42',
      '/episode 深链 → wx.navigateTo 剧集页');
    assert(page.data.items[0].isRead === true, '跳转同时乐观置已读');
  }

  section('十、一键全部已读');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(4, 3) },
      '/api/notification/read': { statusCode: 200, data: { success: true } },
    });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    page.onMarkAll();
    await tick();
    assert(bodies('POST', '/api/notification/read').length === 1 &&
      bodies('POST', '/api/notification/read')[0].all === true,
      'POST /read {all:true}');
    assert(page.data.unreadCount === 0 && page.data.items.every((n) => n.isRead === true),
      '整列表置已读 + 未读清零');

    // 失败分支：接口 500 → toast + 状态回滚（未读保持）
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(4, 3) },
      '/api/notification/read': { statusCode: 500, data: { error: 'boom' } },
    });
    const p2 = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    p2.onShow();
    await tick();
    toasts.length = 0;
    p2.onMarkAll();
    await tick();
    assert(toasts.includes('操作失败，请重试') && p2.data.unreadCount === 3 &&
      p2.data.items.some((n) => !n.isRead), '全部已读失败 → toast + 本地状态不变');
  }

  section('十一、长按删除（二次确认 + 乐观移除）');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(3, 2) },
      '/api/notification/delete': { statusCode: 200, data: { success: true, count: 1 } },
    });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();

    // 取消分支：不发请求
    modalConfirm = false;
    page.onLongPressItem({ currentTarget: { dataset: { id: 1 } } });
    await tick();
    assert(calls.request.filter((r) => r.url.indexOf('/delete') >= 0).length === 0,
      'showModal 取消 → 零删除请求');

    // 确认分支：删除未读第 1 条 → 移除 + 未读 2→1
    modalConfirm = true;
    page.onLongPressItem({ currentTarget: { dataset: { id: 1 } } });
    await tick();
    const dels = bodies('POST', '/api/notification/delete');
    assert(dels.length === 1 && dels[0].notificationIds[0] === 1,
      'POST /delete {notificationIds:[1]}（DELETE 别名链路）');
    assert(page.data.items.length === 2 && page.data.total === 2, '本地移除后 2 条');
    assert(page.data.unreadCount === 1, '删未读项 → 未读数重算 2→1');
    assert(modalCalls.length === 2 && modalCalls[1].title === '删除通知' &&
      modalCalls[1].confirmColor === '#d2503f', 'showModal 危险确认口径（标题/红确认）');

    // 失败分支：toast 固定文案
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(3, 2) },
      '/api/notification/delete': { statusCode: 500, data: { error: 'boom' } },
    });
    const p2 = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    p2.onShow();
    await tick();
    toasts.length = 0;
    p2.onLongPressItem({ currentTarget: { dataset: { id: 2 } } });
    await tick();
    assert(toasts.includes('删除失败，请重试') && p2.data.items.length === 3,
      '删除失败 → toast + 列表不变');
  }

  section('十二、下拉刷新与错误重试');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    let failFirst = true;
    requestHandler = routeAwareHandler({
      '/api/notification/list': () =>
        failFirst
          ? { statusCode: 500, data: { error: 'server down' } }
          : { statusCode: 200, data: buildListDto(2, 1) },
    });
    const page = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    page.onShow();
    await tick();
    assert(page.data.error.indexOf('server down') >= 0 && page.data.items.length === 0,
      '列表失败 → 错误态（后端文案透传）');

    page.onRetry();
    await tick();
    failFirst = false; // 重试仍走旧 handler 应答，先恢复再刷新验证
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(2, 1) },
    });
    page.onRetry();
    await tick();
    assert(page.data.error === '' && page.data.items.length === 2, '重试 → 恢复列表');

    page.onPullDownRefresh();
    await tick();
    assert(pullRefreshStopped === 1 && calls.request.length >= 3,
      '下拉刷新重拉 + stopPullDownRefresh 恰一次');
  }

  /* ==================== 三、mine 入口 ==================== */

  section('十三、mine 页入口与未读角标');
  {
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: { role: 'USER' } });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 120, notifications: [] } },
    });
    const page = makePage(mineConfig, { unsubscribeAuth: null });
    page.onLoad();
    page.onShow();
    await tick();
    const listCalls = calls.request.filter((r) => r.url.indexOf('/api/notification/list') >= 0);
    assert(listCalls.length === 1, 'onShow 静默拉取未读数（零打扰）');
    assert(page.data.unreadCount === 120, '角标数 = 接口 unreadCount');

    page.onNotifications();
    assert(navigations[0] === '/pages/notifications/index', '点击 → 跳转消息通知页');

    // 登出 → 角标清零（subscribe 通道）
    authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
    await tick();
    assert(page.data.unreadCount === 0, '登出 → 角标清零');

    // 静默失败：接口挂 → 保持旧值不 toast
    resetMock();
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 500, data: { error: 'x' } },
    });
    const p2 = makePage(mineConfig, { unsubscribeAuth: null });
    p2.onLoad();
    p2.data.unreadCount = 7;
    p2.onShow();
    await tick();
    assert(p2.data.unreadCount === 7 && toasts.length === 0, '角标拉取失败 → 静默保持旧值');
  }

  /* ==================== 四、结构红线 ==================== */

  section('十四、WXML 结构与资产红线');
  {
    const methodCall = /\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|split|find)\(/;
    assert(!methodCall.test(WXML_NOTIF) && !methodCall.test(WXML_MINE),
      'WXML 绑定零方法调用（indexOf/includes/map/...）');
    assert(WXML_NOTIF.indexOf('nrow--unread') >= 0 && WXML_NOTIF.indexOf('nrow--read') >= 0,
      '未读/已读双态类名');
    assert(WXML_NOTIF.indexOf('wx:if="{{!item.isRead}}" class="nrow-dot"') >= 0,
      '未读红点 wx:if 绑定');
    assert(WXML_NOTIF.indexOf('>全部已读</view>') >= 0 && WXML_NOTIF.indexOf('onMarkAll') >= 0,
      '一键全部已读按钮');
    assert(WXML_NOTIF.indexOf("bindlongpress=\"onLongPressItem\"") >= 0,
      '长按删除绑定');
    assert(WXML_NOTIF.indexOf('暂无{{tab === \'ALL\' ? \'\' : \'此类\'}}通知记录') >= 0,
      '空态文案（全部/此类双态）');
    assert(WXML_NOTIF.indexOf('wx:key="id"') >= 0 && WXML_NOTIF.indexOf('wx:for="{{tabs}}"') >= 0,
      'Tab 行渲染 wx:key');

    const iAppearance = WXML_MINE.indexOf('外观设置');
    const iNotif = WXML_MINE.indexOf('消息通知');
    const iHelp = WXML_MINE.indexOf('帮助与支持');
    assert(iAppearance >= 0 && iNotif > iAppearance && iHelp > iNotif,
      'mine 菜单插入位置：外观设置 → 消息通知 → 帮助与支持');
    assert(WXML_MINE.indexOf("unreadCount > 99 ? '99+' : unreadCount") >= 0 &&
      WXML_MINE.indexOf('unread-badge') >= 0,
      '未读角标 99+ 封顶绑定');
    assert(WXML_MINE.indexOf('notifications-ink.svg') >= 0, '入口 Material 图标引用');

    assert(fs.existsSync(path.join(__dirname, '../assets/icons/notifications-ink.svg')),
      'notifications-ink.svg 资产在盘');
    const ledger = fs.readFileSync(path.join(__dirname, '../Android-Meterial.md'), 'utf8');
    assert(ledger.indexOf('notifications-ink.svg') >= 0, '图标台账已登记');
    assert(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')
      .indexOf('pages/notifications/index') >= 0, 'app.json 已注册通知页');
  }

  section('十五、TabBar 未读红点服务与三端联动');
  {
    const badge = require(path.join(__dirname, '../utils/notification-badge.js'));
    const APP_JS = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const lastDot = () => dots[dots.length - 1] || null;
    const showCount = () => dots.filter((d) => d.type === 'show').length;
    const hideCount = () => dots.filter((d) => d.type === 'hide').length;
    const listCount = () =>
      calls.request.filter((r) => r.url.indexOf('/api/notification/list') >= 0).length;

    assert(badge.MINE_TAB_INDEX === 3, '「我的」Tab 索引 = 3（app.json tabBar 第 4 项）');

    // ---- apply / clear：显示、隐藏、去重、幂等 ----
    resetMock();
    badge.applyUnreadBadge(0); // 归一已知态（前序节页面驱动可能已置 current）
    dots.length = 0;
    badge.applyUnreadBadge(1);
    assert(lastDot() && lastDot().type === 'show' && lastDot().index === 3,
      'applyUnreadBadge(1) → showTabBarRedDot(index 3)');
    badge.applyUnreadBadge(1);
    assert(dots.length === 1, '同态去重（重复 apply 零重复 tabBar 调用）');
    badge.applyUnreadBadge(0);
    assert(lastDot().type === 'hide', 'applyUnreadBadge(0) → hideTabBarRedDot');
    badge.clearUnreadBadge();
    assert(dots.length === 2, '已隐藏态 clearUnreadBadge 幂等零调用');

    // ---- sync：未登录容错（零请求 + 确认无红点） ----
    resetMock();
    badge.applyUnreadBadge(1); // 先置已知显示态，确保隐藏是一次态迁移
    dots.length = 0;
    const loggedOut = await badge.syncUnreadBadge();
    assert(loggedOut === 0 && listCount() === 0 && lastDot() && lastDot().type === 'hide',
      '未登录 sync → 零请求 + 红点确无');

    // ---- sync：登录态取数（show）→ 同值去重 → 归零（hide）→ 失败 reject ----
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 2, notifications: [] } },
    });
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: null });
    dots.length = 0;
    const n2 = await badge.syncUnreadBadge();
    assert(n2 === 2 && lastDot().type === 'show' && lastDot().index === 3,
      '登录态 sync：unreadCount=2 → 我的 Tab 显示红点');
    await badge.syncUnreadBadge();
    assert(listCount() === 2 && showCount() === 1,
      '再 sync：重新拉取（红点去重不重复调用）');
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 0, notifications: [] } },
    });
    await badge.syncUnreadBadge();
    assert(lastDot().type === 'hide', '未读归零 sync → 红点隐藏');
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 500, data: { error: 'x' } },
    });
    let rejected = false;
    await badge.syncUnreadBadge().catch(() => {
      rejected = true;
    });
    assert(rejected === true && hideCount() === 1,
      'sync 失败 → reject 透传（调用方保旧值）+ 红点保持现状不再调用');

    // ---- init：登录态变化联动（登出清点 / 登录拉取 / profile 刷新不触发） ----
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 5, notifications: [] } },
    });
    badge.init(); // 快照当前登录态
    calls.request.length = 0;
    authStore.setState({ isLoggedIn: true, token: 'T', userInfo: { nickname: 'x' } });
    assert(listCount() === 0, '登录态未变的 setState（profile 刷新）零拉取');
    authStore.setState({ isLoggedIn: false, token: '', userInfo: null });
    assert(lastDot().type === 'hide', '登出 → 红点即时清除');
    authStore.setState({ isLoggedIn: true, token: 'T2', userInfo: null });
    await tick();
    assert(listCount() === 1 && lastDot().type === 'show',
      '登录/换号 → 后台自动拉取并显示红点');

    // ---- mine 页联动：一次请求同时供菜单角标与 Tab 红点 ----
    // （init 订阅已激活：resetMock 的登出 setState 会触发 hide、登录 setState 会
    //  触发后台拉取——handler 先挂保证后台链路确定收敛，再清基线后驱动页面）
    resetMock();
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 120, notifications: [] } },
    });
    authStore.setState({ isLoggedIn: true, token: 'T3', userInfo: { role: 'USER' } });
    await tick(); // 登录联动后台拉取收敛（show 120）
    badge.applyUnreadBadge(0); // 置已知隐藏态
    dots.length = 0;
    calls.request.length = 0;
    const minePage = makePage(mineConfig, { unsubscribeAuth: null });
    minePage.onLoad();
    minePage.onShow();
    await tick();
    assert(listCount() === 1 && minePage.data.unreadCount === 120 && lastDot().type === 'show',
      'mine onShow：一次请求 → 菜单角标 120 + Tab 红点显示');

    // ---- 通知页联动：读取后红点即时消失 ----
    resetMock();
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: buildListDto(3, 2) },
      '/api/notification/read': { statusCode: 200, data: { success: true } },
    });
    authStore.setState({ isLoggedIn: true, token: 'T4', userInfo: null });
    await tick(); // 登录联动后台拉取收敛
    badge.applyUnreadBadge(0); // 置已知隐藏态（此后页面 fetch 的 show 必为迁移）
    dots.length = 0;
    const nPage = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    nPage.onShow();
    await tick();
    assert(lastDot() && lastDot().type === 'show', '进通知页（未读 2）→ 红点显示');
    nPage.onItemTap({ currentTarget: { dataset: { id: 1 } } });
    await tick();
    assert(lastDot().type === 'show' && hideCount() === 0,
      '读 1 条（剩 1 未读）→ 红点保持显示（未消失）');
    nPage.onMarkAll();
    await tick();
    assert(lastDot().type === 'hide', '全部已读 → 红点即时消失');

    // ---- BUG 回归：非 Tab 页（通知页）里 hide 报 "not TabBar page" 失败 →
    //      去重态不得记成已隐藏，回到 Tab 页上下文后同值 apply 自动重试收敛 ----
    resetMock();
    badge.applyUnreadBadge(1); // show 成功（current=1）
    dots.length = 0;
    dotFailMode = 'hide'; // 模拟通知页内隐藏失败
    badge.applyUnreadBadge(0);
    assert(dots.length === 1 && dots[0].type === 'hide',
      '非 Tab 页隐藏尝试发出（fail 静默不抛）');
    dotFailMode = null; // 回到 Tab 页上下文（mine onShow / 通知页 onUnload 重拉后）
    dots.length = 0;
    badge.applyUnreadBadge(0);
    assert(dots.length === 1 && dots[0].type === 'hide',
      '隐藏失败后同值 apply 重试（去重不掩盖失败，红点不钉死）');

    // ---- 通知页 onUnload 兜底：返回 Tab 页时后台重拉未读态 ----
    resetMock();
    badge.applyUnreadBadge(1); // 归一为显示态，确保后续 hide 是一次态迁移
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 0, notifications: [] } },
    });
    authStore.setState({ isLoggedIn: true, token: 'T5', userInfo: null });
    await tick(); // 登录联动后台拉取收敛
    calls.request.length = 0;
    const uPage = makePage(notifConfig, { _loading: false, _hasLoaded: false, _all: [], _deleting: false });
    uPage.onUnload();
    await tick();
    assert(listCount() === 1 && lastDot() && lastDot().type === 'hide',
      '通知页 onUnload → 后台重拉一次并收敛红点（返回任意 Tab 均兜底）');

    // ---- app.js 接线静态断言 ----
    assert(APP_JS.indexOf('utils/notification-badge') >= 0 &&
      APP_JS.indexOf('notificationBadge.init()') >= 0,
      'app.js onLaunch：init（登录态联动）');
    assert(APP_JS.indexOf('notificationBadge.syncUnreadBadge()') >= 0,
      'app.js onShow：切回小程序刷新红点');
  }

  section('十六、前台 60s 轮询（停在前台不切 Tab 也能点亮红点）');
  {
    const badge = require(path.join(__dirname, '../utils/notification-badge.js'));
    const APP_JS = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const lastDot = () => dots[dots.length - 1] || null;
    const liveTimers = () => pollTimers.filter((t) => !t.cleared);
    const listCount = () =>
      calls.request.filter((r) => r.url.indexOf('/api/notification/list') >= 0).length;

    // ---- 启停与幂等 ----
    badge.stopPolling(); // 归一
    const before = liveTimers().length;
    badge.startPolling();
    assert(liveTimers().length === before + 1 && liveTimers()[liveTimers().length - 1].ms === 60000,
      'startPolling 注册 60s 间隔定时器');
    badge.startPolling();
    assert(liveTimers().length === before + 1, '重复 startPolling 幂等（不重复注册）');
    badge.stopPolling();
    assert(liveTimers().length === before, 'stopPolling 停表');

    // ---- 用户报障场景：已登录用户停在前台（不在「我的」Tab），管理员发新通知 →
    //      轮询节拍内点亮红点，无需点击「我的」 ----
    resetMock();
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 0, notifications: [] } },
    });
    authStore.setState({ isLoggedIn: true, token: 'T6', userInfo: null });
    await tick(); // 登录联动后台拉取收敛：无未读，红点隐藏
    badge.applyUnreadBadge(0); // 归一隐藏态
    badge.stopPolling();
    dots.length = 0;
    calls.request.length = 0;
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 3, notifications: [] } }, // 管理员发新通知
    });
    badge.startPolling();
    firePoll(); // 模拟 60s 节拍到
    await tick();
    assert(listCount() === 1 && lastDot() && lastDot().type === 'show' && lastDot().index === 3,
      '前台轮询节拍 → 拉到新未读 3 → 「我的」Tab 红点点亮（零点击）');

    // ---- 停表后节拍不再发请求 ----
    badge.stopPolling();
    calls.request.length = 0;
    firePoll();
    await tick();
    assert(listCount() === 0, '停表后节拍零请求');

    // ---- 登录态联动启停表（init 订阅在十五节已激活） ----
    resetMock();
    requestHandler = routeAwareHandler({
      '/api/notification/list': { statusCode: 200, data: { unreadCount: 1, notifications: [] } },
    });
    badge.stopPolling(); // 归一
    const liveBefore = liveTimers().length;
    authStore.setState({ isLoggedIn: true, token: 'T7', userInfo: null }); // 登录迁移
    await tick();
    assert(liveTimers().length === liveBefore + 1, '登录 → 轮询自动启表');
    authStore.setState({ isLoggedIn: false, token: '', userInfo: null }); // 登出迁移
    await tick();
    assert(liveTimers().length === liveBefore, '登出 → 轮询自动停表');

    // ---- app.js 接线静态断言 ----
    assert(APP_JS.indexOf('notificationBadge.startPolling()') >= 0,
      'app.js onShow：回前台启表');
    assert(APP_JS.indexOf('notificationBadge.stopPolling()') >= 0,
      'app.js onHide：退后台停表');
  }

  /* ==================== 汇总 ==================== */

  console.log('\n========== 消息通知测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  if (failed > 0) {
    console.log('✗ ' + failed + ' 项失败：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试驱动异常：', e);
  process.exit(1);
});
