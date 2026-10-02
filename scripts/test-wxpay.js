/**
 * scripts/test-wxpay.js — 微信虚拟支付前端封装套件（Node 环境，mock wx）
 *
 * 覆盖目标（SUBSCRIBE-TASK T5.1 验收：仿真全分支）：
 *   一、版本闸 checkPaymentSupport：iOS 8.0.68 边界/低版本拦截、Android 与
 *      devtools 不设 iOS 闸、基础库 2.19.2 闸（canIUse 旁路）、API 缺失兜底；
 *   二、pay 全链路弱成功：login 恰一次 → bind code 透传 → 下单体
 *      {planKey, buyQuantity}+Bearer → requestVirtualPayment 扁平结构
 *      （signData 逐字节 === 服务端原串，无重序列化）→ 弱提示 toast；
 *   三、支付 fail 分类：取消（errCode -2 / errMsg 含 cancel）静默、限额
 *      兜底文案（附录 B #4）、已知码查表、其余兜底；
 *   四、链路前置失败：版本闸拦截不发请求、login 失败/空 code、bind 4xx
 *      全局文案、order 4xx / 载荷不全不拉起支付；
 *   五、口径常量与「pay 永不 reject」红线；
 *   六、T5.2 收敛轮询：isSettlementConverged 判定 + pollSettlement 节流/
 *      终止条件/瞬时异常容错（sleep 可注入零真实等待）；
 *   七、T5.3 埋点：ORDER_CREATE 下单咽喉点（source=planKey，metadata=
 *      outTradeNo+buyQuantity；下单失败不报）。
 *
 * 运行：node scripts/test-wxpay.js（或 npm test）
 */

// ---- mock 全局 wx（必须在 require 封装之前；口径与 test-subscription 同款） ----
let toastCalls = [];
let loginCalls = [];
let bindRequests = [];
let orderRequests = [];
let payCalls = [];

let wxLoginMode = 'ok';        // 'ok' | 'fail' | 'nocode'
let bindOk = true;
let orderMode = 'ok';          // 'ok' | 'http4xx' | 'badbody'
let payRespond = { type: 'success' }; // { type: 'success' } | { type: 'fail', res }
let sysProfile = { platform: 'android', wxVersion: '8.0.90', sdkVersion: '3.7.12' };
let canIUseFlag = true;
let hasPayApi = true;
const trackRequests = [];      // /api/track 捕获（T5.3 埋点断言）

/** 服务端签好的 signData 原串（含中文/空格/花括号，验逐字节透传不可重序列化） */
const RAW_SIGN_DATA = '{"offerId":"offer-1","buyQuantity":1,"env":0,"currencyType":"CNY","productId":"yuanlu_weekly","goodsPrice":500,"outTradeNo":"YR20261002000000abc123","attach":"src 稳健"}';

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
  _storage: { token: 'token-wxpay' },
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
    return canIUseFlag;
  },
  showToast(opts) {
    toastCalls.push(opts);
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
      if (orderMode === 'http4xx') {
        opts.success({ statusCode: 400, data: { success: false, error: '支付配置未就绪，请稍后再试' } });
      } else if (orderMode === 'badbody') {
        opts.success({ statusCode: 200, data: { success: true, data: { outTradeNo: 'YR-broken' } } });
      } else {
        opts.success({
          statusCode: 200,
          data: {
            success: true,
            data: {
              signData: RAW_SIGN_DATA,
              paySig: 'paysig-hex64',
              signature: 'signature-hex64',
              outTradeNo: 'YR20261002000000abc123',
            },
          },
        });
      }
      return;
    }
    opts.success({ statusCode: 200, data: {} });
  },
};

// requestVirtualPayment 挂为可摘除属性（api-missing 分支用）
Object.defineProperty(global.wx, 'requestVirtualPayment', {
  configurable: true,
  get() {
    return hasPayApi
      ? (opts) => {
          payCalls.push(opts);
          queueMicrotask(() => {
            if (payRespond.type === 'silent') return; // 回调丢失模拟（T5.4 真机实测形态）
            if (payRespond.type === 'success') {
              opts.success && opts.success({});
            } else {
              opts.fail && opts.fail(payRespond.res);
            }
          });
        }
      : undefined;
  },
});

const wxpay = require('../utils/wxpay');

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
const toasts = () => toastCalls.map((t) => t.title);
function reset() {
  toastCalls.length = 0;
  loginCalls.length = 0;
  bindRequests.length = 0;
  orderRequests.length = 0;
  payCalls.length = 0;
  trackRequests.length = 0;
  wxLoginMode = 'ok';
  bindOk = true;
  orderMode = 'ok';
  payRespond = { type: 'success' };
  sysProfile = { platform: 'android', wxVersion: '8.0.90', sdkVersion: '3.7.12' };
  canIUseFlag = true;
  hasPayApi = true;
}

(async () => {
  // ==================== 一、版本闸（checkPaymentSupport） ====================
  console.log('━━━ 一、版本闸（iOS 8.0.68 / 基础库 2.19.2 / API 存在性） ━━━');
  sysProfile = { platform: 'ios', wxVersion: '8.0.60', sdkVersion: '3.7.12' };
  let s = wxpay.checkPaymentSupport();
  assert(!s.ok && s.reason === 'ios-version' && s.message.includes('8.0.68'), 'iOS 8.0.60 → 拦截并引导升级至 8.0.68');

  sysProfile = { platform: 'ios', wxVersion: '8.0.68', sdkVersion: '3.7.12' };
  s = wxpay.checkPaymentSupport();
  assert(s.ok, 'iOS 恰 8.0.68 → 放行（边界含等号）');

  sysProfile = { platform: 'ios', wxVersion: '8.0.70', sdkVersion: '3.7.12' };
  s = wxpay.checkPaymentSupport();
  assert(s.ok, 'iOS 8.0.70 → 放行');

  sysProfile = { platform: 'android', wxVersion: '8.0.9', sdkVersion: '3.7.12' };
  s = wxpay.checkPaymentSupport();
  assert(s.ok, 'Android 老客户端版本不设 iOS 闸');

  sysProfile = { platform: 'devtools', wxVersion: '', sdkVersion: '3.7.12' };
  s = wxpay.checkPaymentSupport();
  assert(s.ok, 'devtools 平台 → 放行（无 wxVersion 不比较）');

  canIUseFlag = false;
  sysProfile = { platform: 'android', wxVersion: '8.0.90', sdkVersion: '2.19.1' };
  s = wxpay.checkPaymentSupport();
  assert(!s.ok && s.reason === 'sdk', '基础库 2.19.1 且 canIUse=false → 拦截');

  canIUseFlag = true;
  s = wxpay.checkPaymentSupport();
  assert(s.ok, '基础库 2.19.1 但 canIUse 旁路 → 放行（官方示例 OR 口径）');

  canIUseFlag = false;
  sysProfile = { platform: 'android', wxVersion: '8.0.90', sdkVersion: '2.19.2' };
  s = wxpay.checkPaymentSupport();
  assert(s.ok, '基础库恰 2.19.2 → 放行（边界含等号）');
  canIUseFlag = true;

  hasPayApi = false;
  s = wxpay.checkPaymentSupport();
  assert(!s.ok && s.reason === 'api-missing', 'requestVirtualPayment 缺失 → api-missing 兜底');
  hasPayApi = true;

  // ==================== 二、pay 全链路（弱成功） ====================
  console.log('━━━ 二、pay 全链路：login → bind → order → 扁平拉起 → 弱提示 ━━━');
  reset();
  const okResult = await wxpay.pay('WEEKLY', 1);
  assert(okResult.outcome === 'success' && okResult.outTradeNo === 'YR20261002000000abc123', '弱成功 resolve outcome=success + outTradeNo');
  assert(loginCalls.length === 1, 'wx.login 恰一次');
  assert(bindRequests.length === 1 && bindRequests[0].data.code === 'mock-js-code', 'bind 携带一次性 code');
  assert(orderRequests.length === 1, '下单恰一次');
  assert(
    orderRequests[0].data.planKey === 'WEEKLY' && orderRequests[0].data.buyQuantity === 1,
    '下单体 { planKey, buyQuantity }（金额分由后端 SKU 表定价，前端不传价）',
  );
  assert(
    orderRequests[0].header.Authorization === 'Bearer token-wxpay',
    '下单自动携带 Bearer（request.js 默认 needAuth）',
  );
  assert(payCalls.length === 1, 'requestVirtualPayment 恰拉起一次');
  const payArgs = payCalls[0];
  const flatKeys = Object.keys(payArgs).filter((k) => k !== 'success' && k !== 'fail');
  assert(
    flatKeys.sort().join(',') === 'mode,paySig,signData,signature',
    '扁平参数结构（signData/mode/paySig/signature，非 payData 包裹——官方 API 文档口径）',
  );
  assert(payArgs.signData === RAW_SIGN_DATA, 'signData 逐字节 === 服务端原串（无 JSON 重序列化）');
  assert(payArgs.mode === 'short_series_goods', 'mode = short_series_goods（道具直购）');
  assert(payArgs.paySig === 'paysig-hex64' && payArgs.signature === 'signature-hex64', '双签名透传');
  assert(toasts().includes('支付成功，正在确认入账'), 'success 回调只作弱提示（不可信，发货以后端为准）');

  // 份数透传
  reset();
  await wxpay.pay('YEARLY', 3);
  assert(orderRequests[0].data.planKey === 'YEARLY' && orderRequests[0].data.buyQuantity === 3, '多份购买 buyQuantity 透传（步进器份数）');

  // ==================== 三、支付 fail 分类（describePayFail + 链路） ====================
  console.log('━━━ 三、fail 分支：取消静默 / 限额兜底 / 已知码 / 兜底 ━━━');
  reset();
  payRespond = { type: 'fail', res: { errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' } };
  let r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'cancel', 'errCode -2 → outcome=cancel');
  assert(toasts().length === 0, '用户取消静默（无 toast）');

  reset();
  payRespond = { type: 'fail', res: { errCode: -1, errMsg: 'requestVirtualPayment:fail 用户取消支付' } };
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'cancel' && toasts().length === 0, 'errMsg 含 cancel 视同取消（静默优先于 errCode）');

  reset();
  payRespond = { type: 'fail', res: { errCode: -1, errMsg: 'requestVirtualPayment:fail 安卓支付失败' } };
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'fail', '支付失败 → outcome=fail');
  assert(toasts().includes('支付未完成，请稍后重试'), '未知失败码 → 兜底文案');

  reset();
  payRespond = { type: 'fail', res: { errCode: -1, errMsg: 'requestVirtualPayment:fail 超出单月限额' } };
  r = await wxpay.pay('WEEKLY', 1);
  assert(toasts().includes('本月支付额度已满，请下月再购买'), 'errMsg 命中限额 → 月限额兜底文案（附录 B #4）');

  reset();
  payRespond = { type: 'fail', res: { errCode: -15007, errMsg: 'requestVirtualPayment:fail' } };
  r = await wxpay.pay('WEEKLY', 1);
  assert(toasts().includes('登录状态已过期，请重新发起支付'), '-15007 session_key 过期 → 查表文案');

  reset();
  payRespond = { type: 'fail', res: { errCode: -15021, errMsg: 'requestVirtualPayment:fail' } };
  await wxpay.pay('WEEKLY', 1);
  assert(toasts().includes('操作过于频繁，请稍后再试'), '-15021 频率超限 → 查表文案');

  // 纯函数直测（describePayFail）
  assert(wxpay.describePayFail({ errCode: -2 }).silent === true, 'describePayFail(-2) 静默');
  assert(wxpay.describePayFail({ errMsg: 'requestVirtualPayment:fail cancel' }).silent === true, 'describePayFail(errMsg cancel) 静默');
  assert(wxpay.describePayFail({}).message === '支付未完成，请稍后重试', '空载荷走兜底不抛错');

  // ==================== 四、链路前置失败 ====================
  console.log('━━━ 四、前置失败：闸门 / login / bind / order ━━━');
  reset();
  sysProfile = { platform: 'ios', wxVersion: '8.0.50', sdkVersion: '3.7.12' };
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'unsupported' && r.reason === 'ios-version', '版本闸拦截 → outcome=unsupported');
  assert(loginCalls.length === 0 && bindRequests.length === 0 && orderRequests.length === 0 && payCalls.length === 0, '闸门拦截零请求零拉起');
  assert(toasts().includes('当前微信版本过低，请升级至 8.0.68 及以上版本后购买'), '闸门 toast 引导升级');

  reset();
  wxLoginMode = 'fail';
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'login-failed', 'wx.login 失败 → outcome=login-failed');
  assert(bindRequests.length === 0, 'login 失败不发 bind');
  assert(toasts().includes('微信登录失败，请稍后重试'), 'login 失败本地 toast（T3.3 同文案）');

  reset();
  wxLoginMode = 'nocode';
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'login-failed' && bindRequests.length === 0 && toasts().includes('微信登录失败，请稍后重试'), '空 code 视同登录失败');

  reset();
  bindOk = false;
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'bind-failed', 'bind 4xx → outcome=bind-failed');
  assert(toasts().includes('该微信号已绑定其他账号'), 'bind 4xx → 全局 toast 后端文案（request.js）');
  assert(orderRequests.length === 0 && payCalls.length === 0, '绑定失败不下单不拉起支付');

  reset();
  orderMode = 'http4xx';
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'order-failed', '下单 4xx → outcome=order-failed');
  assert(toasts().includes('支付配置未就绪，请稍后再试'), '下单 4xx → 全局 toast 后端文案');
  assert(payCalls.length === 0, '下单失败不拉起支付');

  reset();
  orderMode = 'badbody';
  r = await wxpay.pay('WEEKLY', 1);
  assert(r.outcome === 'order-failed', '2xx 载荷不全 → outcome=order-failed');
  assert(toasts().includes('下单失败，请稍后重试'), '载荷不全 → 本地兜底 toast');
  assert(payCalls.length === 0, '载荷不全不拉起支付');

  // ==================== 五、口径常量与红线 ====================
  console.log('━━━ 五、常量口径与「永不 reject」红线 ━━━');
  assert(wxpay.PAY_MODE === 'short_series_goods', 'PAY_MODE = short_series_goods');
  assert(wxpay.IOS_MIN_WX_VERSION === '8.0.68', 'iOS 客户端门槛 8.0.68');
  assert(wxpay.MIN_SDK_VERSION === '2.19.2', '基础库门槛 2.19.2');
  assert(wxpay.CANCEL_ERRCODE === -2, '取消错误码 -2（官方 API 文档）');
  assert(wxpay.PAY_FAIL_MESSAGES['-15007'] && wxpay.PAY_FAIL_MESSAGES['-15021'], '已知码文案表（-15007/-15021）');
  // pay 永不 reject：全分支均已 await 直收（unsupported/login/bind/order/cancel/fail/success），
  // 此处再以 catch 红线兜一遍最险的 cancel 分支
  reset();
  payRespond = { type: 'fail', res: { errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' } };
  let rejected = false;
  await wxpay.pay('WEEKLY', 1).catch(() => { rejected = true; });
  assert(rejected === false, 'pay 全分支 resolve 不 reject（页面 finally 复位防重入锁依赖此口径）');

  // ==================== 六、支付结果收敛轮询（T5.2） ====================
  console.log('━━━ 六、轮询收敛：判定纯函数 + 节流/终止/容错 ━━━');
  assert(
    wxpay.isSettlementConverged(
      { isPremium: false, expiryDate: null },
      { isPremium: true, expiryDate: '2026年10月9日' },
    ),
    '新入会（isPremium 翻转）= 收敛',
  );
  assert(
    wxpay.isSettlementConverged(
      { isPremium: true, expiryDate: '2026年10月2日' },
      { isPremium: true, expiryDate: '2026年11月1日' },
    ),
    '续费（expiryDate 变化）= 收敛（中文日期串只判不等不作大小比较）',
  );
  assert(
    !wxpay.isSettlementConverged(
      { isPremium: true, expiryDate: '2026年11月1日' },
      { isPremium: true, expiryDate: '2026年11月1日' },
    ),
    '状态未变 = 未收敛',
  );
  assert(
    !wxpay.isSettlementConverged(
      { isPremium: true, expiryDate: null },
      { isPremium: true, expiryDate: null },
    ),
    'ADMIN 快照（null→null）不误判收敛（病态续购走超时口径）',
  );
  assert(
    wxpay.isSettlementConverged(
      { isPremium: true, expiryDate: null },
      { isPremium: true, expiryDate: '2027年1月1日' },
    ),
    'null→日期 = 收敛',
  );
  assert(!wxpay.isSettlementConverged(null, { isPremium: true }), '缺参防御 = 未收敛');

  {
    // 第 3 次尝试收敛：首次立即（不先睡），其后每次间隔常量透传
    const sleeps = [];
    let n = 0;
    const r = await wxpay.pollSettlement({
      baseline: { isPremium: false, expiryDate: null },
      fetchState: () => {
        n += 1;
        return n >= 3
          ? { isPremium: true, expiryDate: '2026年10月9日' }
          : { isPremium: false, expiryDate: null };
      },
      sleepFn: async (ms) => { sleeps.push(ms); },
    });
    assert(r === 'converged' && n === 3, '第 3 次尝试收敛（首次立即查）');
    assert(
      sleeps.length === 2 && sleeps.every((m) => m === wxpay.SETTLE_POLL_INTERVAL_MS),
      '节流：sleep 恰(尝试数-1)次,间隔=2s 常量',
    );
  }
  {
    // 终止条件：永不收敛 → 恰 maxAttempts 次 after timeout
    const sleeps = [];
    let n = 0;
    const r = await wxpay.pollSettlement({
      baseline: { isPremium: true, expiryDate: 'a' },
      fetchState: () => { n += 1; return { isPremium: true, expiryDate: 'a' }; },
      sleepFn: async () => { sleeps.push(1); },
      maxAttempts: 5,
    });
    assert(r === 'timeout' && n === 5 && sleeps.length === 4, '超时终止：恰 maxAttempts 次尝试');
  }
  {
    // 首次即收敛：零 sleep（发货常先于 success 回调返回）
    const sleeps = [];
    const r = await wxpay.pollSettlement({
      baseline: { isPremium: false, expiryDate: null },
      fetchState: () => ({ isPremium: true, expiryDate: 'x' }),
      sleepFn: async () => { sleeps.push(1); },
    });
    assert(r === 'converged' && sleeps.length === 0, '首次立即收敛零等待');
  }
  {
    // 瞬时异常容错：fetchState 抛错一次不中断
    let n = 0;
    const r = await wxpay.pollSettlement({
      baseline: { isPremium: false, expiryDate: null },
      fetchState: () => {
        n += 1;
        if (n === 1) throw new Error('transient');
        return { isPremium: true, expiryDate: 'y' };
      },
      sleepFn: async () => {},
    });
    assert(r === 'converged' && n === 2, '瞬时异常计一次未收敛尝试,不中断轮询');
  }
  assert(
    wxpay.SETTLE_POLL_INTERVAL_MS === 2000 && wxpay.SETTLE_POLL_MAX_ATTEMPTS === 8,
    '轮询口径常量 2s×8 次（≈16s 窗口,超时交兜底查单）',
  );

  // ==================== 七、埋点漏斗（T5.3：ORDER_CREATE 下单咽喉点） ====================
  console.log('━━━ 七、ORDER_CREATE 埋点 ━━━');
  reset();
  await wxpay.pay('MONTHLY', 2);
  const orderEvents = trackRequests.filter((t) => t.data.eventType === 'ORDER_CREATE');
  assert(orderEvents.length === 1, '下单成功恰一条 ORDER_CREATE');
  assert(
    orderEvents.length === 1 && orderEvents[0].data.source === 'MONTHLY' &&
      orderEvents[0].data.metadata.buyQuantity === 2 &&
      orderEvents[0].data.metadata.outTradeNo === 'YR20261002000000abc123',
    'ORDER_CREATE 载荷：source=planKey + metadata={outTradeNo, buyQuantity}',
  );
  assert(
    orderEvents.length === 1 && orderEvents[0].header.Authorization === 'Bearer token-wxpay',
    '埋点自动携带 Bearer（track.js 归因口径）',
  );

  reset();
  orderMode = 'http4xx';
  await wxpay.pay('WEEKLY', 1);
  assert(trackRequests.length === 0, '下单 4xx 不报 ORDER_CREATE（漏斗只计成功落库）');

  reset();
  orderMode = 'badbody';
  await wxpay.pay('WEEKLY', 1);
  assert(trackRequests.length === 0, '下单载荷不全不报 ORDER_CREATE');

  reset();
  payRespond = { type: 'fail', res: { errCode: -2, errMsg: 'requestVirtualPayment:fail cancel' } };
  await wxpay.pay('WEEKLY', 1);
  assert(
    trackRequests.filter((t) => t.data.eventType === 'ORDER_CREATE').length === 1 &&
      trackRequests.every((t) => t.data.eventType !== 'PAY_SUCCESS'),
    '支付取消：ORDER_CREATE 已报（订单已落库不回退）且 wxpay 层无 PAY_SUCCESS（末事件以页面收敛为准,success 回调不可信红线）',
  );

  // ==================== 八、回调丢失兜底（T5.4 真机首单实测缺陷修复） ====================
  console.log('━━━ 八、回调丢失兜底（success/fail 均不回调） ━━━');
  reset();
  payRespond = { type: 'silent' };
  const silentResult = await wxpay.pay('WEEKLY', 1, { callbackTimeoutMs: 5 });
  assert(
    silentResult.outcome === 'unknown' && silentResult.outTradeNo === 'YR20261002000000abc123',
    '超窗无回调 → resolve unknown + outTradeNo（promise 必定 settle 红线）',
  );
  assert(toasts().length === 0, 'unknown 不弹任何提示（不臆断成败，交轮询收敛）');
  assert(wxpay.PAY_CALLBACK_TIMEOUT_MS === 90000, '兜底窗常量 90s（覆盖慢输密场景）');

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL WXPAY TESTS PASSED');
  } else {
    console.log(`${failed} WXPAY TESTS FAILED`);
    process.exit(1);
  }
})();
