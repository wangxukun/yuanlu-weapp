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
 *   七、订阅按钮分流：游客→auth 页，已登录→占位 toast；
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
  request(opts) {
    if (opts.url.includes('/api/user/wx/bind')) {
      bindRequests.push(opts);
      if (bindOk) {
        opts.success({ statusCode: 200, data: { success: true, message: '微信账号绑定成功' } });
      } else {
        opts.success({ statusCode: 400, data: { success: false, error: '该微信号已绑定其他账号' } });
      }
      return;
    }
    if (opts.url.includes('/api/user/subscription/status')) {
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

  // ==================== 七、购买前置绑定链路（T3.3） ====================
  console.log('━━━ 七、绑定链路/失败分支/回流 ━━━');
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const p3 = makePage();
  p3.setData({ guest: true });
  toastCalls.length = 0;
  navigateCalls.length = 0;
  p3.onSubscribe();
  assert(navigateCalls.length === 1 && navigateCalls[0].url === '/pages/auth/index', '游客点订阅 → auth 页');
  assert(toastCalls.length === 0 && loginCalls.length === 0, '游客点订阅不触发绑定链路');
  p3.onGoLogin();
  assert(navigateCalls.length === 2 && navigateCalls[1].url === '/pages/auth/index', '游客横幅按钮 → auth 页');

  // 登录回流：source 留存本页（订阅页在栈内，navigateBack 即回，source 不丢）
  const p3s = makePage();
  pageDef.onLoad.call(p3s, { source: 'episode_deep_dive' });
  assert(p3s.data.source === 'episode_deep_dive', '登录回流保 source（onLoad 留存）');

  // 已登录 + bind 成功 → 占位支付 toast（支付链路阶段 5 接入）
  p3.setData({ guest: false });
  loginCalls.length = 0;
  bindRequests.length = 0;
  toastCalls.length = 0;
  bindOk = true;
  p3.onSubscribe();
  await settle();
  assert(loginCalls.length === 1, '已登录点订阅 → wx.login 恰一次');
  assert(
    bindRequests.length === 1 && bindRequests[0].data.code === 'mock-js-code' &&
      bindRequests[0].url.includes('/api/user/wx/bind'),
    'bind 请求携带一次性 code',
  );
  assert(
    toastCalls.length === 1 && toastCalls[0].title === '支付功能即将上线',
    'bind 成功 → 支付占位 toast（T5.1 接支付）',
  );
  assert(p3._purchasing === false, '购买流程退出后防重入锁复位');

  // bind 4xx（REJECT_OWNER 文案）→ 全局 toast 后端文案，不进支付占位
  bindOk = false;
  loginCalls.length = 0;
  toastCalls.length = 0;
  p3.onSubscribe();
  await settle();
  assert(loginCalls.length === 1 && bindRequests.length === 2, '失败分支仍走完 login+bind');
  assert(
    toastCalls.some((t) => t.title === '该微信号已绑定其他账号'),
    'bind 4xx → 全局 toast 后端文案（一号多绑口径）',
  );
  assert(!toastCalls.some((t) => t.title === '支付功能即将上线'), '绑定失败不进支付占位');

  // wx.login fail → 本地 toast
  wxLoginMode = 'fail';
  loginCalls.length = 0;
  bindRequests.length = 0;
  toastCalls.length = 0;
  p3.onSubscribe();
  await settle();
  assert(bindRequests.length === 0, 'wx.login 失败不发 bind 请求');
  assert(toastCalls.some((t) => t.title === '微信登录失败，请稍后重试'), 'wx.login 失败 → 本地 toast');

  // wx.login 成功但无 code → 同失败分支
  wxLoginMode = 'nocode';
  toastCalls.length = 0;
  p3.onSubscribe();
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
