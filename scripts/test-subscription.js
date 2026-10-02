/**
 * scripts/test-subscription.js — 订阅页套件（Node 环境，mock wx/Page）
 *
 * 覆盖目标（SUBSCRIBE-TASK T1.1/T1.3/T1.4）：
 *   一、四档位数据逐字（utils/plans.js 单源 vs Web subscribe-client.tsx
 *      AFDIAN_PLANS——期望值系 T1.1 验收时直解 Web tsx 源核对后固化）；
 *   二、定价锚点口径：dailyPrice=(price/days).toFixed(2)、
 *      savings=Math.floor((1-日单价/周卡日单价)*100) 仅年卡展示省%；
 *   三、decoratePlans 纯度：两次调用返回独立数组；
 *   四、数量步进：1-99 钳制、置灰态、合计（天数倍增/总价）联动；
 *   五、三态互斥：游客横幅 / 会员胶囊三文案（ADMIN·到期日·长期有效）/
 *      未开通默认；会员胶囊仅权威校正（checked）后展示；
 *   六、membershipStore expiryDate 回写与换号清空；
 *   七、订阅按钮分流：游客→auth 页，已登录→支付全链路（T3.3 绑定前置 +
 *      T5.1 下单/requestVirtualPayment 拉起 + T5.2 支付中态与轮询收敛，占位
 *      toast 退役）；
 *   八、WXML 零方法调用红线扫描 + app.json 注册。
 *
 * 运行：node scripts/test-subscription.js（或 npm test）
 */

// ---- mock 全局 wx（必须在 require 页面/store 之前） ----
let nextResponse = { statusCode: 200, data: { role: 'USER' } };
let toastCalls = [];
let navigateCalls = [];
// ---- T3.3 绑定链路 mock：wx.login 三态 + bind 接口可编程响应 ----
let wxLoginMode = 'ok'; // 'ok' | 'fail' | 'nocode'
const loginCalls = [];
const bindRequests = [];
let bindOk = true;
// ---- T5.1 支付链路 mock：下单接口 + requestVirtualPayment + 版本闸画像 ----
const orderRequests = [];
const payCalls = [];
let payRespond = { type: 'success' }; // { type: 'success' } | { type: 'fail', res }
let sysProfile = { platform: 'devtools', wxVersion: '8.0.90', sdkVersion: '3.7.12' };
// ---- T5.2 收敛轮询 mock：status 请求计数（轮询节流断言用） ----
const statusRequests = [];
// ---- T5.3 埋点 mock：/api/track 捕获（漏斗三事件断言用） ----
const trackRequests = [];

/** 与真机 wx.compareVersion 同语义（数值段逐位比较） */
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
    return { version: sysProfile.wxVersion, SDKVersion: sysProfile.sdkVersion };
  },
  getDeviceInfo() {
    return { platform: sysProfile.platform };
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
  login(opts) {
    loginCalls.push(opts);
    if (wxLoginMode === 'fail') {
      opts.fail && opts.fail({ errMsg: 'login:fail' });
      return;
    }
    const code = wxLoginMode === 'nocode' ? '' : 'mock-js-code';
    opts.success && opts.success({ code });
  },
  requestVirtualPayment(opts) {
    payCalls.push(opts);
    queueMicrotask(() => {
      if (payRespond.type === 'silent') return; // 回调丢失模拟（T5.4 真机实测形态）
      if (payRespond.type === 'success') {
        opts.success && opts.success({});
      } else {
        opts.fail && opts.fail(payRespond.res);
      }
    });
  },
  request(opts) {
    if (opts.url.includes('/api/track')) {
      trackRequests.push(opts);
      opts.success({ statusCode: 204, data: '' });
      return;
    }
    if (opts.url.includes('/api/user/wx/bind')) {
      bindRequests.push(opts);
      if (bindOk) {
        opts.success({ statusCode: 200, data: { success: true, message: '微信账号绑定成功' } });
      } else {
        opts.success({ statusCode: 400, data: { success: false, error: '该微信号已绑定其他账号' } });
      }
      return;
    }
    if (opts.url.includes('/api/wxpay/order')) {
      orderRequests.push(opts);
      opts.success({
        statusCode: 200,
        data: {
          success: true,
          data: {
            signData: 'SIGN_RAW_{\"offerId\":\"offer-1\"}',
            paySig: 'paysig-hex64',
            signature: 'signature-hex64',
            outTradeNo: 'YR20261002000000abc123',
          },
        },
      });
      return;
    }
    if (opts.url.includes('/api/user/subscription/status')) {
      statusRequests.push(opts);
      opts.success({ statusCode: nextResponse.statusCode, data: nextResponse.data });
      return;
    }
    opts.success({ statusCode: 200, data: {} });
  },
};

// ---- mock Page 捕获页面定义 ----
let pageDef = null;
global.Page = (cfg) => {
  pageDef = cfg;
};

const fs = require('fs');
const path = require('path');
const plansCore = require('../utils/plans');
const wxpay = require('../utils/wxpay');
require('../pages/subscription/index');
const authStore = require('../store/authStore');
const membershipStore = require('../store/membershipStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}

/** 构造页面实例：data 深拷贝 + 顶层方法挂载（属性调用保证 this 指向实例）。
 *  setData 兼容小程序路径表达式（plans[3].qty 形态），普通 key 直接合入。 */
function makePage() {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
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
  for (const k of Object.keys(pageDef)) {
    if (k === 'data') continue;
    inst[k] = pageDef[k];
  }
  inst.setData({ plans: plansCore.decoratePlans() });
  return inst;
}

const evt = (key, delta) => ({ currentTarget: { dataset: { key, delta: String(delta) } } });

(async () => {
  // ==================== 一、四档位数据逐字 ====================
  console.log('━━━ 一、四档位数据逐字（Web AFDIAN_PLANS 单源） ━━━');
  const expectedPlans = [
    {
      key: 'WEEKLY', name: '周度会员', price: 5, days: 7,
      desc: '7天高级会员权益，低门槛体验所有专业功能',
      features: ['7天会员特权', '无限次语音评测', '完整句子跟读练习', '音频、文稿 PDF 下载', '生词无限收藏', '词典无限查询', '发音弱项本与诊断'],
    },
    {
      key: 'MONTHLY', name: '月度会员', price: 18, days: 30,
      desc: '30天高级会员权益，适合中短期高强度需求',
      features: ['30天会员特权', '无限次语音评测', '完整句子跟读练习', '音频、文稿 PDF 下载', '生词无限收藏', '词典无限查询', '发音弱项本与诊断'],
    },
    {
      key: 'QUARTERLY', name: '季度会员', price: 48, days: 90,
      desc: '90天高级会员权益，季付更划算，效率倍增',
      features: ['90天会员特权', '无限次语音评测', '完整句子跟读练习', '音频、文稿 PDF 下载', '生词无限收藏', '词典无限查询', '发音弱项本与诊断'],
    },
    {
      key: 'YEARLY', name: '年度会员', price: 168, days: 365,
      desc: '365天终极会员权益，超值优待，一年无忧',
      features: ['365天至尊全权', '无限次语音评测', '完整句子跟读练习', '音频、文稿 PDF 下载', '生词无限收藏', '词典无限查询', '发音弱项本与诊断'],
    },
  ];
  assert(JSON.stringify(plansCore.PLANS) === JSON.stringify(expectedPlans), '四档 key/名称/价格/天数/描述/权益逐字');
  assert(plansCore.PLANS.every((p) => p.features.length === 7), '每档权益七项');

  // ==================== 二、定价锚点口径 ====================
  console.log('━━━ 二、定价锚点口径（P2-1/F7） ━━━');
  const dec = plansCore.decoratePlans();
  assert(dec.map((p) => p.dailyPrice).join(',') === '0.71,0.60,0.53,0.46', '日均价 0.71/0.60/0.53/0.46（toFixed(2)）');
  assert(dec.map((p) => p.savingsVsWeekly).join(',') === '0,16,25,35', '较周卡省 0/16/25/35（Math.floor 同式）');
  assert(dec.map((p) => p.popular).join(',') === 'false,false,false,true', '推荐徽章与高亮仅年卡');
  assert(dec.map((p) => p.showSaving).join(',') === 'false,false,false,true', '省% 仅年卡展示（月/季算出不展示）');
  assert(dec.map((p) => p.badgeText).join(',') === '7 天,30 天,90 天,365 天', '天数徽章文案（含空格）');
  assert(dec.map((p) => p.badgeHot).join(',') === 'false,true,false,false', '月卡徽章 accent 特例');
  assert(dec.map((p) => p.priceFen).join(',') === '500,1800,4800,16800', 'priceFen 分单位（虚拟支付 SKU）');
  assert(plansCore.QTY_MIN === 1 && plansCore.QTY_MAX === 99, 'buyQuantity 边界 1-99');

  // ==================== 三、decoratePlans 纯度 ====================
  console.log('━━━ 三、decoratePlans 纯度 ━━━');
  const a = plansCore.decoratePlans();
  const b = plansCore.decoratePlans();
  a[0].qty = 42;
  assert(b[0].qty === 1 && plansCore.PLANS[0].qty === undefined, '两次调用返回独立数组（实例互不污染）');

  // ==================== 四、数量步进 ====================
  console.log('━━━ 四、数量步进（buyQuantity 语义） ━━━');
  const page = makePage();
  const yearly = () => page.data.plans[3];
  assert(yearly().qty === 1 && yearly().canDec === false && yearly().canInc === true, '初始 1 份（减钮置灰）');
  page.onQtyChange(evt('YEARLY', 1));
  assert(yearly().qty === 2 && yearly().canDec === true, '+1 → 2 份（减钮解禁）');
  assert(yearly().totalDays === 730 && yearly().totalPrice === 336, '2 份年卡 = 730 天 / ¥336（天数倍增）');
  page.onQtyChange(evt('YEARLY', 1));
  assert(yearly().qty === 3, '+1 → 3 份');
  page.onQtyChange(evt('YEARLY', -1));
  page.onQtyChange(evt('YEARLY', -1));
  assert(yearly().qty === 1 && yearly().canDec === false, '回到 1 份（减钮再置灰）');
  for (let i = 0; i < 200; i++) page.onQtyChange(evt('YEARLY', 1));
  assert(yearly().qty === 99 && yearly().canInc === false, '上界钳制 99（加钮置灰）');
  for (let i = 0; i < 200; i++) page.onQtyChange(evt('YEARLY', -1));
  assert(yearly().qty === 1, '下界钳制 1');
  const before = JSON.stringify(page.data.plans);
  page.onQtyChange(evt('NO_SUCH_KEY', 1));
  page.onQtyChange(evt('YEARLY', 0));
  assert(JSON.stringify(page.data.plans) === before, '未知 key / delta=0 静默无副作用');
  const weekly = page.data.plans[0];
  assert(weekly.qty === 1, '档位间数量独立（年卡拉满不串周卡）');
  page.onUnload();

  // ==================== 五、三态互斥 ====================
  console.log('━━━ 五、三态（游客 / 会员胶囊 / 未开通默认） ━━━');
  // 5.1 游客态
  membershipStore.init();
  const p1 = makePage();
  p1.syncAuthState();
  assert(p1.data.guest === true && p1.data.memberBadgeText === '', '游客：横幅态 + 无会员胶囊');
  assert(membershipStore.getState().expiryDate === null, '游客 store expiryDate 空');

  // 5.2 未开通（已登录 USER）
  nextResponse = { statusCode: 200, data: { role: 'USER', expiryDate: null } };
  authStore.setLoginData('token-sub1', { userid: 'u-sub1', role: 'USER' });
  await membershipStore.ensureFresh();
  p1.syncAuthState();
  assert(p1.data.guest === false && p1.data.memberBadgeText === '', '未开通：无横幅无胶囊（默认态）');
  p1.onUnload();

  // 5.3 会员态·到期日（中文格式化串直接展示）
  nextResponse = { statusCode: 200, data: { role: 'PREMIUM', expiryDate: '2026年11月1日' } };
  authStore.setLoginData('token-sub2', { userid: 'u-sub2', role: 'USER' });
  await membershipStore.ensureFresh();
  const p2 = makePage();
  p2.syncAuthState();
  assert(membershipStore.getState().expiryDate === '2026年11月1日', 'store 回写 expiryDate（status 接口值）');
  assert(p2.data.memberBadgeText === '您的高级会员有效期至：2026年11月1日', '会员胶囊·到期日文案（全角冒号）');
  assert(p2.data.guest === false, '会员态非游客');

  // 5.4 换号乐观期不误报（checked 随身份失效）
  authStore.setLoginData('token-sub3', { userid: 'u-sub3', role: 'PREMIUM' });
  const m3 = membershipStore.getState();
  assert(m3.checked === false && m3.expiryDate === null, '换号清空 checked/expiryDate（乐观期）');
  p2.syncAuthState();
  assert(p2.data.memberBadgeText === '', '乐观期不展示胶囊（防过期缓存误报长期有效）');
  await membershipStore.ensureFresh(); // 吸收换号触发的在途校正（旧 5.3 响应）

  // 5.5 ADMIN 永久（force 强刷：TTL 内非 force 会命中缓存）
  nextResponse = { statusCode: 200, data: { role: 'ADMIN', expiryDate: null } };
  await membershipStore.ensureFresh(true);
  p2.syncAuthState();
  assert(p2.data.memberBadgeText === '您是系统管理员（永久高级权限）', '会员胶囊·ADMIN 文案');

  // 5.6 会员无到期日
  nextResponse = { statusCode: 200, data: { role: 'PREMIUM', expiryDate: null } };
  await membershipStore.ensureFresh(true);
  p2.syncAuthState();
  assert(p2.data.memberBadgeText === '您的高级会员已激活（长期有效）', '会员胶囊·长期有效文案');
  p2.onUnload();

  // ==================== 六、（expiryDate 回写已并入五） ====================

  // ==================== 七、购买链路（T3.3 绑定前置 + T5.1 支付拉起） ====================
  console.log('━━━ 七、绑定链路/支付拉起/失败分支/回流 ━━━');
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const subEvt = (key) => ({ currentTarget: { dataset: { key } } });
  const p3 = makePage();
  p3._pollSleepFn = async () => {}; // 成功路径进入轮询时零真实等待（T5.2）
  p3.setData({ guest: true });
  toastCalls.length = 0;
  navigateCalls.length = 0;
  p3.onSubscribe(subEvt('WEEKLY'));
  assert(navigateCalls.length === 1 && navigateCalls[0].url === '/pages/auth/index', '游客点订阅 → auth 页');
  assert(toastCalls.length === 0 && loginCalls.length === 0, '游客点订阅不触发购买链路');
  assert(trackRequests.length === 0, '游客点订阅不报 ORDER_CREATE');
  p3.onGoLogin();
  assert(navigateCalls.length === 2 && navigateCalls[1].url === '/pages/auth/index', '游客横幅按钮 → auth 页');

  // 登录回流：source 留存本页（订阅页在栈内，navigateBack 即回，source 不丢）
  const p3s = makePage();
  trackRequests.length = 0;
  pageDef.onLoad.call(p3s, { source: 'episode_deep_dive' });
  assert(p3s.data.source === 'episode_deep_dive', '登录回流保 source（onLoad 留存）');
  assert(
    trackRequests.length === 1 && trackRequests[0].data.eventType === 'SUBSCRIBE_PAGE_VIEW' &&
      trackRequests[0].data.source === 'episode_deep_dive',
    'onLoad → SUBSCRIBE_PAGE_VIEW（source 归因透传，T5.3 漏斗首事件）',
  );
  trackRequests.length = 0;
  pageDef.onLoad.call(makePage(), {});
  assert(
    trackRequests.length === 1 && trackRequests[0].data.source === 'unknown',
    '无 source 进入 → SUBSCRIBE_PAGE_VIEW 兜底 unknown（PREMIUM_MODAL_OPEN 同口径）',
  );

  // 已登录 + bind 成功 → 下单 + 拉起 requestVirtualPayment（T5.1，占位 toast 退役）
  p3.setData({ guest: false });
  loginCalls.length = 0;
  bindRequests.length = 0;
  orderRequests.length = 0;
  payCalls.length = 0;
  toastCalls.length = 0;
  bindOk = true;
  p3.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(loginCalls.length === 1, '已登录点订阅 → wx.login 恰一次');
  assert(
    bindRequests.length === 1 && bindRequests[0].data.code === 'mock-js-code' &&
      bindRequests[0].url.includes('/api/user/wx/bind'),
    'bind 请求携带一次性 code',
  );
  assert(
    orderRequests.length === 1 && orderRequests[0].data.planKey === 'WEEKLY' &&
      orderRequests[0].data.buyQuantity === 1,
    'bind 成功 → 下单（档位 key + 份数，金额分后端 SKU 表定价）',
  );
  assert(
    payCalls.length === 1 && payCalls[0].signData === 'SIGN_RAW_{\"offerId\":\"offer-1\"}' &&
      payCalls[0].mode === 'short_series_goods' && payCalls[0].paySig === 'paysig-hex64',
    '下单成功 → 拉起 requestVirtualPayment（扁平结构，signData 原串透传）',
  );
  assert(
    toastCalls.some((t) => t.title === '支付成功，正在确认入账'),
    'success 回调弱提示（不可信口径）',
  );
  assert(!toastCalls.some((t) => t.title === '支付功能即将上线'), '占位 toast 退役红线（T5.1）');
  assert(p3._purchasing === false, '购买流程退出后防重入锁复位');

  // 步进器份数 → 下单 buyQuantity 透传（按钮 dataset.key 与卡内 qty 联动）
  p3.onQtyChange(evt('YEARLY', 1));
  p3.onQtyChange(evt('YEARLY', 1));
  loginCalls.length = 0;
  bindRequests.length = 0;
  orderRequests.length = 0;
  payCalls.length = 0;
  toastCalls.length = 0;
  p3.onSubscribe(subEvt('YEARLY'));
  await settle();
  assert(
    orderRequests.length === 1 && orderRequests[0].data.planKey === 'YEARLY' &&
      orderRequests[0].data.buyQuantity === 3,
    '年卡 3 份 → 下单 { planKey: YEARLY, buyQuantity: 3 }',
  );

  // ---- T5.2 支付中态与结果收敛 ----
  // 收敛成功：弱成功 → payPending 置位（sleep 桩内观察）→ 第 2 次轮询翻 PREMIUM
  // → 成功 toast + ensureFresh(true) 权威刷新（胶囊经 store 订阅自动更新）
  nextResponse = { statusCode: 200, data: { role: 'USER', expiryDate: null } };
  await membershipStore.ensureFresh(true);
  const p5 = makePage();
  p5.syncAuthState();
  let pendingSeen = false;
  p5._pollSleepFn = async () => {
    pendingSeen = pendingSeen || p5.data.payPending === true;
    nextResponse = { statusCode: 200, data: { role: 'PREMIUM', expiryDate: '2026年10月9日' } };
  };
  statusRequests.length = 0;
  toastCalls.length = 0;
  trackRequests.length = 0;
  p5.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(pendingSeen, '轮询期 payPending 态置位（支付处理中横幅展示）');
  assert(p5.data.payPending === false, '收敛后支付中态复位');
  assert(toastCalls.some((t) => t.title === '支付成功，会员已激活'), '收敛成功 toast（两态其一）');
  assert(
    trackRequests.some((t) => t.data.eventType === 'ORDER_CREATE' && t.data.source === 'WEEKLY' &&
      t.data.metadata.outTradeNo === 'YR20261002000000abc123' && t.data.metadata.buyQuantity === 1),
    '漏斗中段：ORDER_CREATE（wxpay 咽喉点,source=planKey）',
  );
  assert(
    trackRequests.some((t) => t.data.eventType === 'PAY_SUCCESS' && t.data.source === 'WEEKLY' &&
      t.data.metadata.outTradeNo === 'YR20261002000000abc123' && t.data.metadata.buyQuantity === 1),
    '漏斗末段：PAY_SUCCESS 以后端发货收敛为准上报（success 回调不可信）',
  );
  assert(
    membershipStore.getState().expiryDate === '2026年10月9日',
    '收敛 = ensureFresh(true) 权威刷新（附录 C：不信本地 role）',
  );
  p5.syncAuthState();
  assert(
    p5.data.memberBadgeText === '您的高级会员有效期至：2026年10月9日',
    '成功态：会员胶囊到期日刷新（store 订阅联动）',
  );
  assert(statusRequests.length === 2, '轮询恰 2 次 status（首次立即 + 翻态后收敛）');
  assert(p5._purchasing === false, '收敛后防重入锁复位');

  // 超时：状态恒不变 → 恰 maxAttempts 次轮询后「订单处理中」（兜底查单保证最终一致）
  nextResponse = { statusCode: 200, data: { role: 'USER', expiryDate: null } };
  await membershipStore.ensureFresh(true);
  statusRequests.length = 0;
  toastCalls.length = 0;
  trackRequests.length = 0;
  const sleepCount = { n: 0 };
  p5._pollSleepFn = async () => { sleepCount.n += 1; };
  p5.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(
    statusRequests.length === wxpay.SETTLE_POLL_MAX_ATTEMPTS,
    `超时终止条件：恰 ${wxpay.SETTLE_POLL_MAX_ATTEMPTS} 次轮询`,
  );
  assert(sleepCount.n === wxpay.SETTLE_POLL_MAX_ATTEMPTS - 1, '节流：间隔次数 = 尝试数 - 1');
  assert(
    trackRequests.some((t) => t.data.eventType === 'ORDER_CREATE') &&
      !trackRequests.some((t) => t.data.eventType === 'PAY_SUCCESS'),
    '超时未收敛不报 PAY_SUCCESS（发货未确认,兜底查单口径）',
  );
  assert(
    toastCalls.some((t) => t.title === '订单处理中，稍后在我的订阅查看'),
    '超时提示（订单处理中,稍后在我的订阅查看）',
  );
  assert(!toastCalls.some((t) => t.title === '支付成功，会员已激活'), '超时不得报成功');
  assert(p5.data.payPending === false && p5._purchasing === false, '超时后支付中态与锁均复位');
  p5.onUnload();

  // ---- T5.4 真机首单实测缺陷修复：回调丢失兜底（真付后 success/fail 均未回调→无反馈） ----
  nextResponse = { statusCode: 200, data: { role: 'USER', expiryDate: null } };
  await membershipStore.ensureFresh(true);
  const p6 = makePage();
  p6.syncAuthState();
  p6._payCallbackTimeoutMs = 5; // 兜底窗压缩到 5ms（运行时缺省 90s）
  p6._pollSleepFn = async () => {
    nextResponse = { statusCode: 200, data: { role: 'PREMIUM', expiryDate: '2026年10月16日' } };
  };
  payRespond = { type: 'silent' };
  statusRequests.length = 0;
  toastCalls.length = 0;
  trackRequests.length = 0;
  p6.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(p6.data.payPending === true, '拉起即置横幅：回调丢失静默窗内保持「支付处理中」');
  await new Promise((resolve) => setTimeout(resolve, 25)); // 兜底窗 5ms + 轮询链
  await settle();
  assert(p6.data.payPending === false, 'unknown → 轮询收敛后横幅复位');
  assert(
    toastCalls.some((t) => t.title === '支付成功，会员已激活'),
    '回调丢失仍以收敛为准报成功（发货以服务端为准）',
  );
  assert(
    trackRequests.some((t) => t.data.eventType === 'PAY_SUCCESS'),
    'PAY_SUCCESS 漏斗末事件不受回调丢失影响',
  );
  assert(p6._purchasing === false, '兜底路径防重入锁复位（promise 必定 settle 红线）');
  // 购买在途 onShow 强制权威刷新（Web 切回补查同款；须绕过 TTL 缓存）
  p6._purchasing = true;
  statusRequests.length = 0;
  p6.onShow();
  await settle();
  assert(statusRequests.length === 1, '购买在途 onShow → ensureFresh(true) 绕过 TTL 强刷');
  p6._purchasing = false;
  p6.onUnload();
  payRespond = { type: 'success' };

  // 支付取消 → 静默退出，防重入锁复位（pay 永不 reject 口径）
  payRespond = { type: 'fail', res: { errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' } };
  loginCalls.length = 0;
  bindRequests.length = 0;
  orderRequests.length = 0;
  payCalls.length = 0;
  toastCalls.length = 0;
  statusRequests.length = 0;
  trackRequests.length = 0;
  p3.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(p3._purchasing === false, '支付取消后防重入锁复位（finally 口径）');
  assert(!toastCalls.some((t) => t.title.includes('支付')), '用户取消静默（无任何支付 toast）');
  assert(statusRequests.length === 0, '取消不进入收敛轮询（无 status 请求）');
  assert(p3.data.payPending === false, '取消后支付中态复位（拉起即置位、取消即清）');
  assert(
    trackRequests.some((t) => t.data.eventType === 'ORDER_CREATE') &&
      !trackRequests.some((t) => t.data.eventType === 'PAY_SUCCESS'),
    '取消漏斗口径：ORDER_CREATE 已报（订单已落库）+ 无 PAY_SUCCESS',
  );
  payRespond = { type: 'success' };

  // bind 4xx（REJECT_OWNER 文案）→ 全局 toast 后端文案，不下单不拉起支付
  bindOk = false;
  loginCalls.length = 0;
  bindRequests.length = 0;
  orderRequests.length = 0;
  payCalls.length = 0;
  toastCalls.length = 0;
  trackRequests.length = 0;
  p3.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(loginCalls.length === 1 && bindRequests.length === 1, '失败分支仍走完 login+bind');
  assert(
    toastCalls.some((t) => t.title === '该微信号已绑定其他账号'),
    'bind 4xx → 全局 toast 后端文案（一号多绑口径）',
  );
  assert(orderRequests.length === 0 && payCalls.length === 0, '绑定失败不下单不拉起支付');
  assert(trackRequests.length === 0, '绑定失败不报 ORDER_CREATE（漏斗只进到达用户）');

  // wx.login fail → 本地 toast
  wxLoginMode = 'fail';
  loginCalls.length = 0;
  bindRequests.length = 0;
  toastCalls.length = 0;
  p3.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(bindRequests.length === 0, 'wx.login 失败不发 bind 请求');
  assert(toastCalls.some((t) => t.title === '微信登录失败，请稍后重试'), 'wx.login 失败 → 本地 toast');

  // wx.login 成功但无 code → 同失败分支
  wxLoginMode = 'nocode';
  toastCalls.length = 0;
  p3.onSubscribe(subEvt('WEEKLY'));
  await settle();
  assert(bindRequests.length === 0 && toastCalls.some((t) => t.title === '微信登录失败，请稍后重试'), '空 code 视同登录失败');
  wxLoginMode = 'ok';
  p3.onUnload();

  // ==================== 八、红线扫描与注册 ====================
  console.log('━━━ 八、WXML 零方法调用红线 + 注册 ━━━');
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/subscription/index.wxml'), 'utf8');
  const mustaches = [...wxml.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]);
  const methodCalls = mustaches.filter((m) => /[A-Za-z_$][\w$]*\s*\(/.test(m));
  assert(methodCalls.length === 0, 'WXML 零方法调用（展示态全预计算）');
  assert(wxml.includes("{{guest ? '登录后订阅' : '一键订阅'}}"), '按钮文案随登录态分流');
  assert(
    wxml.includes('class="pay-pending-row"') && wxml.includes('{{payPending}}') &&
      wxml.includes('pay-pending-spinner') && wxml.includes('支付处理中，正在确认入账'),
    '支付处理中胶囊结构（T5.2：横幅+CSS spinner+文案）',
  );
  const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  assert(appJson.pages.includes('pages/subscription/index'), 'app.json 已注册订阅页');
  // 标题口径（2026-10-02 用户走查）：导航栏「我的订阅」，页内无「赞助方案」大标题
  const pageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/subscription/index.json'), 'utf8'));
  assert(pageJson.navigationBarTitleText === '我的订阅', '导航栏标题 = 我的订阅');
  assert(!wxml.includes('sub-title') && !wxml.includes('>赞助方案<'), '页内「赞助方案」大标题已删除（标题由原生导航栏承担）');

  // ==================== 九、会员订阅服务协议（2026-10-02 用户指令） ====================
  console.log('━━━ 九、协议全文复刻与弹层开关 ━━━');
  const { SUBSCRIPTION_AGREEMENT } = require('../pages/subscription/agreement');
  assert(SUBSCRIPTION_AGREEMENT.title === '会员订阅服务协议', '协议标题逐字');
  assert(SUBSCRIPTION_AGREEMENT.lastUpdated === '最后更新：2026年6月', '最后更新逐字');
  const blocks = SUBSCRIPTION_AGREEMENT.blocks;
  const headings = blocks.filter((b) => b.type === 'heading');
  const bullets = blocks.filter((b) => b.type === 'bullets');
  assert(headings.length === 8, '八节标题（1.–8.）');
  assert(headings.map((h) => h.text).join('|').includes('1. 服务内容') &&
    headings.map((h) => h.text).join('|').includes('8. 争议解决'), '首末节标题逐字');
  assert(bullets.reduce((n, b) => n + b.items.length, 0) === 13, '五组列表共 13 条（3+2+3+3+2，对齐 Web li 计数）');
  const allText = JSON.stringify(blocks);
  assert(allText.includes('本协议是您（下称“用户”）与《远路播客》（下称“本平台”）'), '首段文案逐字（全角引号）');
  assert(allText.includes('通过“微信虚拟支付”完成交易处理'), '第 2 节支付口径 = 微信虚拟支付（2026-10-02 用户拍板改写）');
  assert(allText.includes('时长自动入账，无需填写任何凭证信息'), '自动激活口径 = 微信账号自动匹配');
  assert(!allText.includes('爱发电') && !allText.includes('预留邮箱'), '协议全文无爱发电/邮箱凭证残留（防回退红线）');
  assert(allText.includes('周度（7天）、月度（30天）、季度（90天）及年度（365天）'), '四档口径与 plans 单源一致');
  assert(allText.includes('（用户通过“微信虚拟支付”完成支付，即视为完全理解并自愿遵守本协议所有内容。）'), '尾段逐字（微信虚拟支付口径）');
  // 弹层开关逻辑（auth 页同款 setData 模式）
  const p4 = makePage();
  p4.onOpenAgreement();
  assert(p4.data.agreementDoc && p4.data.agreementDoc.title === '会员订阅服务协议' &&
    p4.data.agreementDoc.blocks.length === blocks.length, 'onOpenAgreement → 协议文档进 data');
  p4.onCloseAgreement();
  assert(p4.data.agreementDoc === null, 'onCloseAgreement → 弹层关闭复位');
  // 入口绑定与弹层结构红线
  assert(wxml.includes('catchtap="onOpenAgreement"') && wxml.includes('《会员订阅服务协议》'), '底部协议名可点（catchtap 防冒泡）');
  assert(wxml.includes('class="agreement-dialog"') && wxml.includes('bindtap="onCloseAgreement"') &&
    wxml.includes('doc-title') && wxml.includes('关闭页面'), '弹层结构与关闭按钮（auth 用户协议同款）');
  p4.onUnload();
  for (const icon of ['workspace-premium-amber.svg', 'workspace-premium-amber-dark.svg', 'help-outline-accent.svg', 'help-outline-accent-dark.svg']) {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', icon)), `图标资产 ${icon}`);
  }

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL SUBSCRIPTION TESTS PASSED');
  } else {
    console.log(`${failed} SUBSCRIPTION TESTS FAILED`);
    process.exit(1);
  }
})();
