/**
 * utils/notification-badge.js — 「我的」Tab 未读红点服务
 *
 * 目标：有未读通知时在底部导航「我的」Tab 图标上渲染红点，读完后自动消失
 * （Web 端对应物 = NotificationBell / HomeNotificationBell 的未读标记；
 * tabBar 红点是小程序原生等价物）。
 *
 * 未读数来源：GET /api/notification/list 回包的 unreadCount 字段（唯一来源，
 * 与 Web notification-store 轮询同源；后端无独立 unread-count 端点）。
 *
 * 用法（app.js onLaunch 调 init，此后全局单例）：
 *   const notificationBadge = require('./utils/notification-badge');
 *   notificationBadge.init();                    // 登录态变化联动（登出清点停表）
 *   notificationBadge.syncUnreadBadge();          // 拉取并应用（app.onShow 等）
 *   notificationBadge.applyUnreadBadge(n);        // 已有未读数时直接应用（零请求）
 *   notificationBadge.clearUnreadBadge();         // 强制清除
 *   notificationBadge.startPolling();             // 前台 60s 轮询（app.onShow）
 *   notificationBadge.stopPolling();              // 停表（app.onHide / 登出）
 *
 * 红点仅表达「有无未读」（数量展示由 mine 页菜单角标承担），故取
 * wx.showTabBarRedDot 而非 setTabBarBadge（免 99+ 封顶逻辑）。
 * 所有 tabBar 调用 fail 静默：非 tabBar 场景/时序竞态不该抛错打扰。
 */
const authStore = require('../store/authStore');
const notificationApi = require('./api/notification');

/** 「我的」在 app.json tabBar.list 的索引（home 0 / discover 1 / review 2 / mine 3） */
const MINE_TAB_INDEX = 3;

let current = -1; // 最近一次应用的未读态（-1 = 未知；态未变不重复调 tabBar API）
let lastLoggedIn = false;
let inited = false;

function show() {
  wx.showTabBarRedDot({
    index: MINE_TAB_INDEX,
    success: () => {
      current = 1; // 成功才提交去重态（失败保持旧态，下次同值 apply 自动重试）
    },
    fail: (e) => console.warn('[notification-badge] showTabBarRedDot:', e && e.errMsg),
  });
}

function hide() {
  wx.hideTabBarRedDot({
    index: MINE_TAB_INDEX,
    success: () => {
      current = 0;
    },
    fail: (e) => console.warn('[notification-badge] hideTabBarRedDot:', e && e.errMsg),
  });
}

/**
 * 应用未读态：count > 0 显示红点，否则隐藏（去重——同态重复调用零开销）。
 *
 * 平台限制：tabBar 红点 API 在非 Tab 页（navigateTo 子页）调用会报
 * "not TabBar page" 直接失败——因此去重态只在 success 回调提交：通知页里
 * 的隐藏失败不会被记成「已隐藏」，回到 Tab 页后（mine onShow / app onShow /
 * 通知页 onUnload 的重拉）同值 apply 会自动重试，红点不会钉死。
 */
function applyUnreadBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  if ((n > 0 ? 1 : 0) === current) return;
  if (n > 0) show();
  else hide();
}

/** 强制清除红点（登出联动 / 通知页清空后） */
function clearUnreadBadge() {
  applyUnreadBadge(0);
}

/**
 * 拉取未读数并应用。失败 reject 透传——调用方 catch 后各自保持旧值
 * （mine 菜单角标保旧值、红点保现状，均零打扰）。
 * @returns {Promise<number>} 未读数（成功时）
 */
function syncUnreadBadge() {
  if (!authStore.getState().isLoggedIn) {
    applyUnreadBadge(0); // 未登录容错：确无红点（幂等，首次也无害）
    return Promise.resolve(0);
  }
  return notificationApi.getNotifications().then((dto) => {
    const n = (dto && dto.unreadCount) || 0;
    applyUnreadBadge(n);
    return n;
  });
}

/**
 * app.js onLaunch 调用：订阅登录态变化——登录/换号后台拉取并启动轮询，
 * 登出清点停表；profile 刷新等未变登录态的 setState 不触发（避免重复请求）。
 */
function init() {
  if (inited) return;
  inited = true;
  lastLoggedIn = authStore.getState().isLoggedIn;
  authStore.subscribe(() => {
    const now = authStore.getState().isLoggedIn;
    if (now === lastLoggedIn) return;
    lastLoggedIn = now;
    if (now) {
      syncUnreadBadge().catch(() => {});
      startPolling();
    } else {
      applyUnreadBadge(0);
      stopPolling();
    }
  });
}

/* ==================== 前台轮询（Web notification-store 60s 同款） ====================
 *
 * 动机：用户停在前台浏览（不在「我的」Tab、小程序不切后台）时，管理员发新
 * 通知没有任何触发点会刷新红点——app.onShow 只在切回小程序时触发、mine.onShow
 * 只在进「我的」时触发。对齐 Web 端 notification-store.initPolling 的 60s 轮询：
 * 前台每分钟静默拉一次，新通知最多 1 分钟内点亮红点；退后台/登出停表防空转
 * （后台计时器本就被微信挂起，停表是电量与语义双保险）。
 */

const POLL_INTERVAL_MS = 60 * 1000;
let pollTimer = null;

/** 启动前台轮询（幂等；未登录时 sync 内部零请求，轮询空转无害） */
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    syncUnreadBadge().catch(() => {});
  }, POLL_INTERVAL_MS);
}

/** 停止轮询（app onHide / 登出） */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  MINE_TAB_INDEX,
  init,
  syncUnreadBadge,
  applyUnreadBadge,
  clearUnreadBadge,
  startPolling,
  stopPolling,
};
