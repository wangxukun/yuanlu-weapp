/**
 * app.js — 远路听说小程序入口
 */
const theme = require("./utils/theme");
const listeningReporter = require("./utils/listening-reporter");
const authStore = require("./store/authStore");
const membershipStore = require("./store/membershipStore");
// 「我的」Tab 未读红点服务：登录态联动 + 切回小程序刷新（见 utils/notification-badge.js）
const notificationBadge = require("./utils/notification-badge");
// 小程序访问上报（Web PageTracker 对应物，数据汇入服务端 VisitorLog）：require 即激活——
// 劫持 Page 构造器为所有页面 onShow 串入上报；app.js 求值先于页面文件加载，钩子覆盖全部页面
require("./utils/visit-reporter");
// 启动来源捕获（注册归因）：扫码进入时记录 scene/src（如 gzh_follow），
// 建号请求经 utils/api/auth.js 携带给后端落 User.signupSource
const entrySource = require("./utils/entry-source");

App({
  globalData: {
    // 登录用户信息（{ userid, nickname, avatarFileName, role, ... }）
    userInfo: null,
  },

  onLaunch(options) {
    // 0. 启动入口：扫码来源捕获（归因）+ episode 型 scene 直达精研页
    entrySource.handleEntry(options && options.query);

    // 1. 恢复本地登录态
    authStore.init();
    if (authStore.getState().isLoggedIn) {
      this.globalData.userInfo = authStore.getState().userInfo;
    }

    // 2. 会员判定服务：本地 role 乐观 + subscription/status 权威校正
    //    （复习模块 PRO 门禁的事实来源，见 REVIEW-TASK.md T0.2）
    membershipStore.init();

    // 3. 外观主题：系统主题监听（跟随系统模式下联动 chrome 与根类令牌）
    theme.init();

    // 4. 收听时长心跳（打卡数据源）：精研页本地播放器经 onPlaybackState 联动上报
    listeningReporter.start();

    // 5. 未读红点：订阅登录态变化（登录→后台拉取；登出→清点）
    notificationBadge.init();
  },

  onShow(options) {
    // 热启动扫码（小程序码长按进入已运行实例）走 onShow 投递，同款入口处理
    entrySource.handleEntry(options && options.query);

    // 外观：回前台重申 chrome（手动模式覆盖系统态的 tabBar/导航栏色）
    theme.applyChrome();
    // 未读消息：回前台刷新「我的」Tab 红点（登录守卫在服务内，未登录零请求态收敛）
    notificationBadge.syncUnreadBadge().catch(() => {});
    // 前台 60s 轮询（Web notification-store 同款）：停在前台浏览时管理员发新通知，
    // 红点最多 1 分钟内点亮，无需切 Tab/切后台才触发
    notificationBadge.startPolling();
  },

  onHide() {
    // 退后台停轮询（后台计时器本就被挂起，停表防空转）
    notificationBadge.stopPolling();
  },
});
