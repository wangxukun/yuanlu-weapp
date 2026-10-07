/**
 * scripts/test-visit-reporter.js — 小程序访问上报器测试
 *
 * 把门口径 = Web PageTracker / 服务端 POST /api/track-visit（yuanlu 仓库）：
 *   - Page 劫持：所有页面 onShow 自动上报 route+query，页面自身 onShow 原样保留
 *   - 登录带 Bearer / 游客匿名（无 Authorization 头）
 *   - 同一页面 5s 内重复 onShow 去重；不同页面各自记录
 *   - query 编码 + 空值丢弃 + 240 字符截断（服务端契约）
 *   - 完全静默：wx.request 抛错/fail 不外抛、不影响页面 onShow
 *
 * 运行：node scripts/test-visit-reporter.js
 */

const storage = new Map();
const requests = []; // 捕获的 wx.request 调用

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  request(opt) {
    requests.push(opt);
    setTimeout(() => opt.success({ statusCode: 204 }), 1);
  },
};

// Page 构造器 mock：记录注册的页面定义，供测试手动触发 onShow
const registeredPages = [];
global.Page = function (options) {
  registeredPages.push(options);
};

// wx mock / Page mock 就绪后再 require（require 即安装钩子）
const { report, composePath, installPageHook } = require('../utils/visit-reporter');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}

function lastRequest() {
  return requests[requests.length - 1];
}

console.log('== visit-reporter：Page 劫持 ==');

// 1. 通过被劫持的 Page 定义页面（带用户自身 onShow），触发钩子上报
let userOnShowCalls = 0;
global.Page({ onShow() { userOnShowCalls += 1; } });
ok(registeredPages.length === 1, '经劫持 Page 注册页面');
const page = registeredPages[0];
page.onShow.call({ route: 'pages/episode/detail', options: { id: 'ep123' } });
ok(
  requests.length === 1 &&
    lastRequest().url.endsWith('/api/track-visit') &&
    lastRequest().method === 'POST' &&
    lastRequest().data.path === 'pages/episode/detail?id=ep123',
  'onShow 自动上报 route+query 到 /api/track-visit'
);
ok(userOnShowCalls === 1, '页面自身 onShow 保留并被调用');

// 2. 未定义 onShow 的页面也只上报、不报错
global.Page({});
registeredPages[registeredPages.length - 1].onShow.call({ route: 'pages/home/index' });
ok(
  lastRequest().data.path === 'pages/home/index',
  '无自定义 onShow 的页面照常上报'
);

console.log('== visit-reporter：鉴权与匿名 ==');

// 3. 登录态：Bearer 头自动携带
storage.set('token', 'tok-abc');
report({ route: 'pages/mine/index' });
ok(
  lastRequest().header.Authorization === 'Bearer tok-abc',
  '登录态携带 Authorization: Bearer'
);

// 4. 游客：无 Authorization 头
storage.delete('token');
report({ route: 'pages/discover/index', options: { tag: '科技' } });
ok(
  lastRequest().header.Authorization === undefined &&
    lastRequest().data.path === 'pages/discover/index?tag=' + encodeURIComponent('科技'),
  '游客匿名上报且 query 正确编码'
);

console.log('== visit-reporter：去重窗口 ==');

// 5. 同一页面 5s 内重复 onShow 只记一次
const before = requests.length;
report({ route: 'pages/review/flashcard' });
report({ route: 'pages/review/flashcard' }); // 5s 内重复 → 去重
ok(
  requests.length === before + 1,
  '同一页面 5s 窗口内重复 onShow 去重为一次'
);

// 6. 窗口过后恢复上报（临时接管 Date.now）
const realNow = Date.now;
let fakeNow = realNow() + 6000;
Date.now = () => fakeNow;
try {
  report({ route: 'pages/review/flashcard' });
} finally {
  Date.now = realNow;
}
ok(requests.length === before + 2, '5s 窗口过后同页面恢复上报');

console.log('== visit-reporter：composePath 契约 ==');

// 7. 空值丢弃 / 超长截断
ok(
  composePath('pages/podcast/detail', { id: 'x', empty: '', nil: null, und: undefined, keep: '1' }) ===
    'pages/podcast/detail?id=x&keep=1',
  'composePath 丢弃空值参数'
);
const long = composePath('pages/episode/detail', { id: 'a'.repeat(500) });
ok(long.length <= 240, 'composePath 截断至 240 字符（服务端契约）');
ok(composePath(undefined, undefined) === 'unknown', '无路由兜底 unknown');

console.log('== visit-reporter：静默与幂等 ==');

// 8. wx.request 抛错不外抛
const realRequest = global.wx.request;
global.wx.request = () => { throw new Error('boom'); };
let threw = false;
try { report({ route: 'pages/search/index' }); } catch (e) { threw = true; }
global.wx.request = realRequest;
ok(!threw, 'wx.request 抛错时 report 不外抛');

// 9. installPageHook 幂等（重复调用不再包装）
const pageAfterHook = global.Page;
installPageHook();
ok(global.Page === pageAfterHook, 'installPageHook 幂等（不重复包装）');

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed > 0 ? 1 : 0);
