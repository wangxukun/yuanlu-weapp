/**
 * scripts/test-orders.js — 订单中心页套件（Node 环境，mock wx/Page）
 *
 * 覆盖目标（微信《小程序订单中心设置规范》合规页，配套后端 GET /api/wxpay/orders）：
 *   一、display.js 纯函数：状态色类映射 / ISO→yyyy-MM-dd HH:mm 等宽时间 /
 *      非法入参兜底不 throw / 列表保序；
 *   二、游客门禁：未登录不发请求（横幅引导，规范=页内引导不跳走）；
 *      onGoLogin → auth 页；
 *   三、登录回流：authStore 登录后 onShow 现拉（Authorization 头、载荷映射、
 *      状态类落位）；已有列表的二次 onShow 静默刷新不闪 loading；
 *   四、错误态：2xx 载荷异常 / HTTP 500 → 页内错误文案 + 重试再请求，
 *      全程零全局 toast（showError:false 红线）；
 *   五、401 会话失效：request.js 全局 toast + authStore.logout 切回游客横幅，
 *      不留死重试态；
 *   六、空态：空列表 + 无错 → 空态分支条件成立，「去订阅」→ 订阅页；
 *   七、防重入与下拉刷新：并发 loadOrders 只发一请求；
 *      onPullDownRefresh 错误路径也恒 stopPullDownRefresh；
 *   八、静态红线：WXML 零方法调用 / app.json 注册 / 路径无中文无参数 /
 *      订阅页入口（onOpenOrders → orders path）/ 图标资产 / 状态类 wxss 对齐。
 *
 * 运行：node scripts/test-orders.js（或 npm test）
 */

// ---- mock 全局 wx（必须在 require 页面/store 之前） ----
let ordersResponse = {
  statusCode: 200,
  data: { success: true, data: { orders: [] } },
};
let ordersRequests = [];
let toastCalls = [];
let navigateCalls = [];
let stopPullDownCalls = 0;

function compareVersion(v1, v2) {
  const a = String(v1).split('.');
  const b = String(v2).split('.');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i] || '0', 10);
    const y = parseInt(b[i] || '0', 10);
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

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
  getAppBaseInfo() {
    return { version: '8.0.90', SDKVersion: '3.7.12' };
  },
  getDeviceInfo() {
    return { platform: 'devtools' };
  },
  compareVersion,
  canIUse() {
    return true;
  },
  showToast(opts) {
    toastCalls.push(opts);
  },
  navigateTo(opts) {
    navigateCalls.push(opts);
  },
  stopPullDownRefresh() {
    stopPullDownCalls++;
  },
  request(opts) {
    if (opts.url.includes('/api/user/profile')) {
      opts.success({ statusCode: 200, data: {} });
      return;
    }
    if (opts.url.includes('/api/wxpay/orders')) {
      ordersRequests.push(opts);
      queueMicrotask(() => opts.success(ordersResponse));
      return;
    }
    opts.success({ statusCode: 200, data: {} });
  },
};

// ---- mock Page：按 require 顺序逐个捕获页面定义 ----
let pageDef = null;
global.Page = (cfg) => {
  pageDef = cfg;
};

const fs = require('fs');
const path = require('path');
require('../pages/subscription/orders/index');
const ordersPageDef = pageDef;
require('../pages/subscription/index');
const subPageDef = pageDef;
const authStore = require('../store/authStore');
const { decorateOrders, formatOrderTime, STATUS_CLASSES } = require('../pages/subscription/orders/display');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}

/** 构造页面实例：data 深拷贝 + 方法挂载（this 指向实例），setData 兼容路径表达式 */
function makePage(def) {
  const inst = {
    data: JSON.parse(JSON.stringify(def.data)),
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        const m = k.match(/^([\w$]+)\[(\d+)\]\.([\w$]+)$/);
        if (m) {
          this.data[m[1]][Number(m[2])][m[3]] = v;
        } else {
          this.data[k] = v;
        }
      }
    },
  };
  for (const k of Object.keys(def)) {
    if (k === 'data') continue;
    inst[k] = def[k];
  }
  return inst;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  // ==================== 一、display.js 纯函数 ====================
  console.log('━━━ 一、display 纯函数（状态类/等宽时间/兜底） ━━━');
  assert(STATUS_CLASSES.ACTIVATED === 'status-done' &&
    STATUS_CLASSES.PENDING === 'status-pending' &&
    STATUS_CLASSES.AMOUNT_MISMATCH === 'status-processing' &&
    STATUS_CLASSES.REFUNDED === 'status-muted' &&
    STATUS_CLASSES.CLOSED === 'status-muted', '五态色类映射（AMOUNT_MISMATCH 走 processing 特例轨）');
  const d1 = new Date(2026, 9, 3, 9, 5, 0); // 本机时区 2026-10-03 09:05
  assert(formatOrderTime(d1.toISOString()) === '2026-10-03 09:05', 'ISO → yyyy-MM-dd HH:mm（本机时区、补零）');
  assert(formatOrderTime('') === '' && formatOrderTime(null) === '' &&
    formatOrderTime('not-a-date') === '' && formatOrderTime(123) === '', '非法入参返空串不 throw');
  assert(decorateOrders(null).length === 0 && decorateOrders(undefined).length === 0, '非数组入参返 []');
  const dec = decorateOrders([
    { outTradeNo: 'YR1', planKey: 'WEEKLY', planName: '周卡', buyQuantity: 2, amountYuan: '10.00', daysGranted: 14, status: 'PENDING', statusLabel: '待支付', createAt: d1.toISOString() },
    null,
    { outTradeNo: 'YR2' },
  ]);
  assert(dec.length === 3 && dec[0].statusClass === 'status-pending' &&
    dec[0].timeText === '2026-10-03 09:05' && dec[0].amountYuan === '10.00', '常规行装饰（色类/时间/金额直传）');
  assert(dec[1].outTradeNo === '' && dec[1].statusClass === 'status-muted', 'null 行全字段兜底（弱化灰）');
  assert(dec[2].statusClass === 'status-muted' && dec[2].amountYuan === '0.00' && dec[2].timeText === '', '未知状态按弱化灰、缺金额兜底 0.00');
  assert(dec.map((o) => o.outTradeNo).join('|') === 'YR1||YR2', '列表保序（后端 createAt 倒序即展示序）');

  // ==================== 二、游客门禁（规范：页内引导登录） ====================
  console.log('━━━ 二、游客门禁 ━━━');
  const g = makePage(ordersPageDef);
  g.onShow();
  await settle();
  assert(g.data.guest === true, '未登录 onShow → 游客态');
  assert(ordersRequests.length === 0, '游客不发订单请求（401 噪音零化）');
  g.onGoLogin();
  assert(navigateCalls.length === 1 && navigateCalls[0].url === '/pages/auth/index', '游客横幅 → auth 页（登录后返回本页停留）');

  // ==================== 三、登录回流拉列表 ====================
  console.log('━━━ 三、登录回流与载荷映射 ━━━');
  const d2 = new Date(2026, 9, 3, 17, 30, 0);
  const FIX = [
    { outTradeNo: 'YR20261003090000AAAAAA', planKey: 'YEARLY', planName: '年卡', buyQuantity: 1, amountYuan: '168.00', daysGranted: 365, status: 'ACTIVATED', statusLabel: '已完成', createAt: d2.toISOString() },
    { outTradeNo: 'YR20260920120000BBBBBB', planKey: 'WEEKLY', planName: '周卡', buyQuantity: 2, amountYuan: '10.00', daysGranted: 14, status: 'PENDING', statusLabel: '待支付', createAt: d1.toISOString() },
  ];
  ordersResponse = { statusCode: 200, data: { success: true, data: { orders: FIX } } };
  authStore.setLoginData('tok-orders-1', { email: 'a@b.c' });
  await settle(); // fetchProfile 静默链路收口

  const p = makePage(ordersPageDef);
  p.onShow();
  await settle();
  assert(p.data.guest === false && ordersRequests.length === 1, '登录后 onShow 现拉（authStore 登录态驱动）');
  assert(ordersRequests[0].header.Authorization === 'Bearer tok-orders-1', '请求携带 Bearer token');
  assert(p.data.loading === false && p.data.error === '' && p.data.orders.length === 2, '成功载荷 → 列表落位、加载/错误态复位');
  assert(p.data.orders[0].statusClass === 'status-done' && p.data.orders[1].statusClass === 'status-pending', '状态类落位（已完成/待支付）');
  assert(p.data.orders[0].timeText === '2026-10-03 17:30', '时间文案等宽口径');
  assert(p.data.orders[0].amountYuan === '168.00', '金额服务端格式化直传（前端不除法）');

  // 二次 onShow：列表非空 → 不闪 loading（同步断言在 mock 微任务响应前）
  p.onShow();
  assert(p.data.loading === false, '已有列表的后台刷新不置 loading（防闪断）');
  await settle();
  assert(ordersRequests.length === 2 && p.data.orders.length === 2, '二次 onShow 静默刷新成功');

  // ==================== 四、错误态与重试（零全局 toast 红线） ====================
  console.log('━━━ 四、错误态与重试 ━━━');
  toastCalls.length = 0;
  const e = makePage(ordersPageDef);
  ordersResponse = { statusCode: 200, data: { success: true, data: {} } }; // 2xx 但 orders 缺失
  e.onShow();
  await settle();
  assert(e.data.error === '订单数据格式异常，请稍后重试', '2xx 载荷异常 → 结构兜底文案（不静默）');
  ordersResponse = { statusCode: 500, data: { error: '服务器开小差' } };
  e.onRetry();
  await settle();
  assert(e.data.error === '服务器开小差', 'HTTP 500 → 后端文案透传（ApiError.message）');
  assert(toastCalls.length === 0, '错误态全程零全局 toast（showError:false，页内展示）');
  ordersResponse = { statusCode: 200, data: { success: true, data: { orders: FIX } } };
  e.onRetry();
  await settle();
  assert(e.data.error === '' && e.data.orders.length === 2, '重试成功 → 错误态清空列表恢复');

  // ==================== 五、401 会话失效（不留死重试） ====================
  console.log('━━━ 五、401 会话失效 ━━━');
  toastCalls.length = 0;
  const u = makePage(ordersPageDef);
  ordersResponse = { statusCode: 401, data: {} };
  u.onShow();
  await settle();
  assert(toastCalls.some((t) => t.title === '登录已过期，请重新登录'), '401 全局 toast（request.js 既有行为）');
  assert(u.data.guest === true && u.data.error === '' && u.data.orders.length === 0, 'authStore.logout 切回游客横幅（错误态与旧列表清空）');
  u.onShow(); // 游客分支：不再发请求
  await settle();
  assert(ordersRequests.length === 6, '游客态复检零请求（三节 2 次+四节 3 次+401 本身 1 次，此后不再加）');

  // ==================== 六、空态 ====================
  console.log('━━━ 六、空态 ━━━');
  authStore.setLoginData('tok-orders-2', { email: 'a@b.c' });
  await settle();
  const n = makePage(ordersPageDef);
  ordersResponse = { statusCode: 200, data: { success: true, data: { orders: [] } } };
  n.onShow();
  await settle();
  assert(n.data.orders.length === 0 && n.data.loading === false && n.data.error === '' && n.data.guest === false, '空列表三条件齐 → wxml 空态分支成立');
  n.onGoSubscribe();
  assert(navigateCalls[navigateCalls.length - 1].url === '/pages/subscription/index', '空态「去订阅」→ 订阅页');

  // ==================== 七、防重入与下拉刷新 ====================
  console.log('━━━ 七、防重入与下拉刷新 ━━━');
  const before = ordersRequests.length;
  const r = makePage(ordersPageDef);
  r.onShow();
  r.loadOrders(); // 微任务响应未达窗口内的并发调用
  await settle();
  assert(ordersRequests.length === before + 1, '并发 loadOrders 防重入（只发一请求）');
  ordersResponse = { statusCode: 500, data: { error: 'x' } };
  const spBefore = stopPullDownCalls;
  await r.onPullDownRefresh();
  assert(stopPullDownCalls === spBefore + 1, '下拉刷新错误路径也恒 stopPullDownRefresh（finally 收口）');
  ordersResponse = { statusCode: 200, data: { success: true, data: { orders: FIX } } };
  await r.onPullDownRefresh();
  assert(r.data.orders.length === 2 && stopPullDownCalls === spBefore + 2, '下拉刷新成功路径同样收口且列表恢复');

  // ==================== 八、静态红线 ====================
  console.log('━━━ 八、静态红线（注册/零方法调用/入口/资产） ━━━');
  const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  assert(appJson.pages.includes('pages/subscription/orders/index'), 'app.json 已注册订单中心页');
  const ORDER_CENTER_PATH = 'pages/subscription/orders/index';
  assert(!/[^\x00-\x7F]/.test(ORDER_CENTER_PATH) && !ORDER_CENTER_PATH.includes('?'), '订单中心 path 无中文无参数（规范硬性）');
  const pageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/subscription/orders/index.json'), 'utf8'));
  assert(pageJson.navigationBarTitleText === '订单中心' && pageJson.enablePullDownRefresh === true, '导航栏标题=订单中心 + 下拉刷新开启');
  const owxml = fs.readFileSync(path.join(__dirname, '../pages/subscription/orders/index.wxml'), 'utf8');
  const mustaches = [...owxml.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]);
  assert(mustaches.filter((m) => /[A-Za-z_$][\w$]*\s*\(/.test(m)).length === 0, '订单页 WXML 零方法调用（展示态全预计算）');
  assert(owxml.includes('wx:if="{{guest}}"') && owxml.includes('onGoLogin'), '游客横幅页内引导（规范：不跳走）');
  assert(owxml.includes('wx:elif="{{error}}"') && owxml.includes('bindtap="onRetry"'), '错误态含重试');
  assert(owxml.includes('wx:elif="{{orders.length === 0}}"'), '空态分支');
  assert(owxml.includes('wx:key="outTradeNo"') && owxml.includes('{{item.statusLabel}}') && owxml.includes('{{item.amountYuan}}'), '订单明细卡（单号键/状态/金额）');
  const swxml = fs.readFileSync(fs.readFileSync ? path.join(__dirname, '../pages/subscription/index.wxml') : '', 'utf8');
  assert(swxml.includes('orders-entry') && swxml.includes('bindtap="onOpenOrders"'), '订阅页「订单记录」入口绑定');
  assert(typeof subPageDef.onOpenOrders === 'function', '订阅页 onOpenOrders 处理器存在');
  subPageDef.onOpenOrders.call({});
  assert(navigateCalls[navigateCalls.length - 1].url === '/pages/subscription/orders/index', 'onOpenOrders → 订单中心页路径逐字');
  const owxss = fs.readFileSync(path.join(__dirname, '../pages/subscription/orders/index.wxss'), 'utf8');
  for (const cls of ['.status-done', '.status-pending', '.status-processing', '.status-muted']) {
    assert(owxss.includes(cls + ' {'), `wxss 色类 ${cls} 与 display.js 映射对齐`);
  }
  assert(owxss.includes('.orders-page.theme-dark') && owxss.includes('@media (prefers-color-scheme: dark)'), '特例色三轨声明（深色手动+系统）');
  for (const icon of ['receipt-long-onsurface.svg', 'receipt-long-onsurface-dark.svg']) {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', icon)), `图标资产 ${icon}`);
  }

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL ORDERS-CENTER TESTS PASSED');
  } else {
    console.log(`${failed} ORDERS-CENTER TESTS FAILED`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('SUITE CRASH:', err);
  process.exit(1);
});
