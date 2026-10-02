/**
 * utils/wxpay.js — 微信虚拟支付前端封装（SUBSCRIBE-TASK T5.1）
 *
 * 官方口径（developers.weixin.qq.com，2026-10-02 核对）：
 *   - 调用结构为【扁平】参数：wx.requestVirtualPayment({ signData（后端签名的
 *     JSON 字符串，逐字节透传不可重序列化）, mode:'short_series_goods',
 *     paySig, signature, success, fail })——T0 清单记录的 payData 包裹结构
 *     系对指引「payData 核心字段」表的误读，以 API 文档为准；
 *   - iOS 端须微信客户端 ≥ 8.0.68（虚拟支付个人主体指引：调用前校验，
 *     不满足时提示更新微信）；基础库 ≥ 2.19.2（官方示例口径，
 *     compareVersion 不够时以 canIUse 作旁路放行）；
 *   - success 回调不可信（可能丢失），发货唯一依据 = 服务端推送 + 兜底查单
 *     （yuanlu T4.4/T4.5），前端只做弱提示，购买后收敛走 T5.2 轮询；
 *   - fail 回调 { errMsg, errCode }：-2 = 支付取消（静默），
 *     -15007 = session_key 过期、-15021 = 频率超限，完整表见 API 文档。
 *
 * 链路（pay）：版本闸 → 静默 wx.login → bind（T3.3 即签即用口径：每次购买
 * 前重走，后端 CREATE 首绑 / REFRESH 幂等刷新 sessionKey）→ POST /api/wxpay/order
 * → wx.requestVirtualPayment。失败分支文案分层：wx.login 失败本地 toast；
 * bind/order 4xx 由 request.js 全局 toast 呈现后端文案（此处静默不叠加）；
 * 支付 fail 按 errCode/errMsg 分类（取消静默、限额兜底文案，附录 B #4）。
 *
 * 收敛轮询（pollSettlement，T5.2）：弱成功后前端轮询 subscription/status
 * （对齐 Web visibilitychange 切回补查口径 P2-2/F5），首次立即查、其后每
 * 2s 一次、至多 8 次（≈16s 窗口）；收敛判定 = 新入会（isPremium 翻转）或
 * 到期日变化（含 null→日期，覆盖续费）。超时交后端兜底查单（yuanlu T4.5）
 * 保证最终一致，前端只提示「订单处理中」。
 *
 * 回调丢失兜底（T5.4 真机首单实测命中的缺陷修复，2026-10-02）：官方口径
 * 「success 回调可能丢失」——真机实测真付后 success/fail 均未回调，pay()
 * 的 Promise 永不 settle（页面无反馈且防重入锁悬挂）。修复：requestVirtual
 * Payment 拉起后 90s（PAY_CALLBACK_TIMEOUT_MS）无回调按 outcome='unknown'
 * 返回交页面进轮询收敛（不臆断成败，发货以服务端为准）——promise 必定
 * settle 是页面 finally 复位锁的依赖红线。
 */

const { post } = require('./request');
const authApi = require('./api/auth');
const { trackEvent } = require('./track');

/** 道具直购模式（个人主体虚拟支付唯一计费模式） */
const PAY_MODE = 'short_series_goods';

/** iOS 微信客户端最低版本（个人主体虚拟支付指引原文） */
const IOS_MIN_WX_VERSION = '8.0.68';

/** 基础库最低版本（官方 API 文档示例口径） */
const MIN_SDK_VERSION = '2.19.2';

/** 版本闸文案 */
const UPGRADE_TOAST_IOS = '当前微信版本过低，请升级至 8.0.68 及以上版本后购买';
const UPGRADE_TOAST_GENERAL = '当前微信版本过低，请升级微信后购买';

/** 已知 fail 错误码 → 用户文案（官方 API 文档错误码表；未列码走兜底） */
const PAY_FAIL_MESSAGES = {
  '-15007': '登录状态已过期，请重新发起支付',
  '-15021': '操作过于频繁，请稍后再试',
};

/** fail 分类（导出供测试锁定口径） */
const CANCEL_ERRCODE = -2;
const FAIL_FALLBACK_MESSAGE = '支付未完成，请稍后重试';
const LIMIT_MESSAGE = '本月支付额度已满，请下月再购买';

/**
 * 系统画像（新 API 优先，getSystemInfoSync 回退——theme.js:72 同款模式）：
 * platform（ios/android/devtools）、wxVersion（微信客户端版本）、sdkVersion。
 */
function _systemProfile() {
  const profile = { platform: '', wxVersion: '', sdkVersion: '' };
  try {
    if (wx.getAppBaseInfo) {
      const info = wx.getAppBaseInfo();
      profile.wxVersion = info.version || '';
      profile.sdkVersion = info.SDKVersion || '';
    } else if (wx.getSystemInfoSync) {
      const info = wx.getSystemInfoSync();
      profile.wxVersion = info.version || '';
      profile.sdkVersion = info.SDKVersion || '';
    }
    if (wx.getDeviceInfo) {
      profile.platform = wx.getDeviceInfo().platform || '';
    } else if (wx.getSystemInfoSync) {
      profile.platform = (wx.getSystemInfoSync().platform) || profile.platform;
    }
  } catch (e) {
    // 保持空串：版本信息不可得时不拦截（API 存在性检查兜底）
  }
  return profile;
}

/**
 * 支付能力闸门：API 存在性 → 基础库版本（canIUse 旁路）→ iOS 客户端版本。
 * 返回 { ok, reason, message }；reason ∈ '' | 'api-missing' | 'sdk' | 'ios-version'。
 */
function checkPaymentSupport() {
  if (typeof wx.requestVirtualPayment !== 'function') {
    return { ok: false, reason: 'api-missing', message: UPGRADE_TOAST_GENERAL };
  }
  const profile = _systemProfile();
  const canIUsePay = !!(wx.canIUse && wx.canIUse('requestVirtualPayment'));
  if (profile.sdkVersion && wx.compareVersion &&
      wx.compareVersion(profile.sdkVersion, MIN_SDK_VERSION) < 0 && !canIUsePay) {
    return { ok: false, reason: 'sdk', message: UPGRADE_TOAST_GENERAL };
  }
  if (profile.platform === 'ios' && profile.wxVersion && wx.compareVersion &&
      wx.compareVersion(profile.wxVersion, IOS_MIN_WX_VERSION) < 0) {
    return { ok: false, reason: 'ios-version', message: UPGRADE_TOAST_IOS };
  }
  return { ok: true, reason: '', message: '' };
}

/** wx.login → 一次性 code（失败/空 code 统一「微信登录失败」口径，T3.3 同文案） */
function _wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res && res.code) resolve(res.code);
        else reject(new Error('微信登录失败，请稍后重试'));
      },
      fail: () => reject(new Error('微信登录失败，请稍后重试')),
    });
  });
}

/**
 * 购买前绑定（T3.3 链路迁入）：wx.login → bind。失败分层——login 失败/空 code
 * 本地 toast；bind 4xx/网络错由 request.js 全局 toast 呈现（此处静默）。
 * 返回 'ok' | 'login-failed' | 'bind-failed'。
 */
async function _ensureWxBound() {
  let code;
  try {
    code = await _wxLogin();
  } catch (err) {
    wx.showToast({ title: err.message, icon: 'none' });
    return 'login-failed';
  }
  try {
    await authApi.bindWxAccount(code);
    return 'ok';
  } catch (err) {
    return 'bind-failed'; // 全局 toast 已呈现后端文案（错误码/换绑口径）
  }
}

/**
 * 下单：POST /api/wxpay/order { planKey, buyQuantity }（金额分恒由后端 SKU
 * 表定价，前端只传档位与份数）。成功返回四件套 + ORDER_CREATE 埋点（漏斗
 * 中段咽喉点，T5.3：订单落库即上报，支付取消/失败不回退——后端可凭
 * outTradeNo 关联 wxpay_orders 补金额）；2xx 但载荷不全属服务端异常，本地
 * toast 兜底（网络/4xx 的 toast 由 request.js 全局承担）。
 */
async function createOrder(planKey, buyQuantity) {
  const body = await post('/api/wxpay/order', { planKey, buyQuantity });
  const data = body && body.data;
  if (!body || !body.success || !data ||
      typeof data.signData !== 'string' || !data.paySig || !data.signature) {
    wx.showToast({ title: '下单失败，请稍后重试', icon: 'none' });
    throw new Error('invalid order payload');
  }
  trackEvent('ORDER_CREATE', planKey, { outTradeNo: data.outTradeNo, buyQuantity });
  return {
    signData: data.signData,
    paySig: data.paySig,
    signature: data.signature,
    outTradeNo: data.outTradeNo,
  };
}

/**
 * fail 分类：取消（errCode -2 或 errMsg 含 cancel/取消——含中文本地化
 * 变体）静默；errMsg 命中限额/额度走月限额兜底文案（附录 B #4）；
 * 已知码查表；其余兜底。
 */
function describePayFail(res) {
  const errCode = res && res.errCode;
  const errMsg = (res && res.errMsg) || '';
  const isCancel = errCode === CANCEL_ERRCODE ||
    /cancel/i.test(errMsg) || errMsg.includes('取消');
  if (isCancel) return { silent: true, message: '' };
  if (/限额|额度/.test(errMsg)) return { silent: false, message: LIMIT_MESSAGE };
  const mapped = PAY_FAIL_MESSAGES[String(errCode)];
  if (mapped) return { silent: false, message: mapped };
  return { silent: false, message: FAIL_FALLBACK_MESSAGE };
}

/** 回调丢失兜底窗：拉起后超窗无任何回调按 unknown 处理（90s 覆盖慢输密） */
const PAY_CALLBACK_TIMEOUT_MS = 90 * 1000;

/** 拉起支付（扁平结构；signData 逐字节透传）；resolve 结果对象，不 reject。
 * 回调丢失兜底（T5.4 实测修复）：success/fail 均可能不回——超窗 settle
 * 'unknown'，页面据此照常轮询收敛（发货以服务端为准，不臆断成败）。 */
function _invokeVirtualPayment(order, callbackTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    timer = setTimeout(() => {
      console.warn('[wxpay] requestVirtualPayment 回调超窗，按 unknown 进轮询收敛:', order.outTradeNo);
      finish({ outcome: 'unknown', outTradeNo: order.outTradeNo });
    }, callbackTimeoutMs || PAY_CALLBACK_TIMEOUT_MS);
    wx.requestVirtualPayment({
      signData: order.signData,
      mode: PAY_MODE,
      paySig: order.paySig,
      signature: order.signature,
      success: () => {
        // success 回调不可信：仅弱提示，发货以后端推送/查单为准
        wx.showToast({ title: '支付成功，正在确认入账', icon: 'none' });
        finish({ outcome: 'success', outTradeNo: order.outTradeNo });
      },
      fail: (res) => {
        console.warn('[wxpay] requestVirtualPayment fail:', errSummary(res));
        const { silent, message } = describePayFail(res);
        if (!silent && message) wx.showToast({ title: message, icon: 'none' });
        finish({ outcome: silent ? 'cancel' : 'fail', outTradeNo: order.outTradeNo });
      },
    });
  });
}

/** fail 日志摘要（T5.4 真机首单联调排障线索） */
function errSummary(res) {
  if (!res) return '(empty)';
  return `errCode=${res.errCode} errMsg=${res.errMsg || ''}`;
}

// ==================== 支付结果收敛轮询（T5.2） ====================

/** 轮询口径：首次立即，其后每 2s，至多 8 次（≈16s 窗口，超时交兜底查单） */
const SETTLE_POLL_INTERVAL_MS = 2000;
const SETTLE_POLL_MAX_ATTEMPTS = 8;

/**
 * 收敛判定（纯函数）：与购买前基线相比——
 *   新入会 = isPremium 翻转；续费 = expiryDate 变化（null→日期 或 日期前移，
 *   中文格式化串不作大小比较只判不等，任何权威变化即视为收敛）。
 * ADMIN 基线（isPremium 且 expiryDate null）续买且状态不变时不误判——
 * 该极端情形走超时口径（管理员续购属病态用例，登记于收口记录）。
 */
function isSettlementConverged(baseline, current) {
  if (!baseline || !current) return false;
  if (!baseline.isPremium && current.isPremium) return true;
  return baseline.expiryDate !== current.expiryDate;
}

/**
 * 轮询直至收敛或超时。fetchState 每次返回最新会员态（页面侧 =
 * membershipStore.ensureFresh(true) + getState，附录 C：收敛一律权威校正，
 * 不信本地 role）；瞬时异常计一次未收敛尝试不中断。resolve 永不 reject：
 *   'converged' | 'timeout'
 * sleepFn/intervalMs/maxAttempts 可注入（测试用；缺省真实 setTimeout+常量）。
 */
async function pollSettlement(opts) {
  const fetchState = opts.fetchState;
  const baseline = opts.baseline;
  const intervalMs = opts.intervalMs === undefined
    ? SETTLE_POLL_INTERVAL_MS : opts.intervalMs;
  const maxAttempts = opts.maxAttempts || SETTLE_POLL_MAX_ATTEMPTS;
  const sleepFn = opts.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleepFn(intervalMs);
    let current = null;
    try {
      current = await fetchState();
    } catch (err) {
      current = null; // 瞬时网络错不中断轮询（ensureFresh 本身不 reject，双保险）
    }
    if (isSettlementConverged(baseline, current)) return 'converged';
  }
  return 'timeout';
}

/**
 * 购买全链路（T5.1 主入口）：版本闸 → 绑定 → 下单 → 拉起支付。
 * 永不 reject，统一 resolve { outcome, outTradeNo?, reason? }：
 *   'unsupported'（版本闸）/ 'login-failed' / 'bind-failed' /
 *   'order-failed' / 'success'（弱）/ 'cancel' / 'fail' /
 *   'unknown'（回调丢失兜底，T5.4——success/fail 均超窗未回，页面照常轮询）。
 * 防重入由页面持锁（订阅页 _purchasing，T3.3 口径）；T5.2 以 outTradeNo
 * 衔接轮询收敛，T5.3 以 outcome 衔接埋点漏斗。
 * options.callbackTimeoutMs 测试注入口（缺省 PAY_CALLBACK_TIMEOUT_MS）。
 */
async function pay(planKey, buyQuantity, options) {
  const support = checkPaymentSupport();
  if (!support.ok) {
    wx.showToast({ title: support.message, icon: 'none' });
    return { outcome: 'unsupported', reason: support.reason };
  }
  const bindState = await _ensureWxBound();
  if (bindState !== 'ok') return { outcome: bindState };
  let order;
  try {
    order = await createOrder(planKey, buyQuantity);
  } catch (err) {
    return { outcome: 'order-failed' }; // toast 已按层呈现（全局/载荷兜底）
  }
  return _invokeVirtualPayment(order, options && options.callbackTimeoutMs);
}

module.exports = {
  PAY_MODE,
  IOS_MIN_WX_VERSION,
  MIN_SDK_VERSION,
  CANCEL_ERRCODE,
  PAY_FAIL_MESSAGES,
  SETTLE_POLL_INTERVAL_MS,
  SETTLE_POLL_MAX_ATTEMPTS,
  PAY_CALLBACK_TIMEOUT_MS,
  checkPaymentSupport,
  createOrder,
  describePayFail,
  pay,
  isSettlementConverged,
  pollSettlement,
};
