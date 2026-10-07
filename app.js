/**
 * app.js — 远路播客小程序入口
 */
const audioManager = require("./utils/audioManager");
const theme = require("./utils/theme");
const listeningReporter = require("./utils/listening-reporter");
const authStore = require("./store/authStore");
const membershipStore = require("./store/membershipStore");
// 播放状态镜像 store：require 即激活订阅（audioManager 事件 → 跨页面可订阅，见 3.B.2）
const playerStore = require("./store/playerStore");
// 「我的」Tab 未读红点服务：登录态联动 + 切回小程序刷新（见 utils/notification-badge.js）
const notificationBadge = require("./utils/notification-badge");
// 小程序访问上报（Web PageTracker 对应物，数据汇入服务端 VisitorLog）：require 即激活——
// 劫持 Page 构造器为所有页面 onShow 串入上报；app.js 求值先于页面文件加载，钩子覆盖全部页面
require("./utils/visit-reporter");

App({
  globalData: {
    // 登录用户信息（{ userid, nickname, avatarFileName, role, ... }）
    userInfo: null,
    // 页面间共享的播放器状态快照（由 audioManager 维护，页面 onShow 时拉取）
    playerSnapshot: null,
  },

  onLaunch() {
    // 1. 初始化全局音频管理器：绑定后台音频事件、恢复上次播放列表
    audioManager.init();

    // 2. 恢复本地登录态
    authStore.init();
    if (authStore.getState().isLoggedIn) {
      this.globalData.userInfo = authStore.getState().userInfo;
    }

    // 3. 会员判定服务：本地 role 乐观 + subscription/status 权威校正
    //    （复习模块 PRO 门禁的事实来源，见 REVIEW-TASK.md T0.2）
    membershipStore.init();

    // 4. 外观主题：系统主题监听（跟随系统模式下联动 chrome 与根类令牌）
    theme.init();

    // 5. 收听时长心跳（打卡数据源）：音频播放状态经 audioManager 联动上报
    listeningReporter.start();

    // 6. 未读红点：订阅登录态变化（登录→后台拉取；登出→清点）
    notificationBadge.init();
  },

  onShow() {
    audioManager.onAppShow();
    // 外观：回前台重申 chrome（手动模式覆盖系统态的 tabBar/导航栏色）
    theme.applyChrome();
    // 未读消息：回前台刷新「我的」Tab 红点（登录守卫在服务内，未登录零请求态收敛）
    notificationBadge.syncUnreadBadge().catch(() => {});
    // 前台 60s 轮询（Web notification-store 同款）：停在前台浏览时管理员发新通知，
    // 红点最多 1 分钟内点亮，无需切 Tab/切后台才触发
    notificationBadge.startPolling();
  },

  onHide() {
    audioManager.onAppHide();
    // 退后台停轮询（后台计时器本就被挂起，停表防空转）
    notificationBadge.stopPolling();
  },
});
