/**
 * app.js — 远路播客小程序入口
 */
const audioManager = require("./utils/audioManager");
const authStore = require("./store/authStore");

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
  },

  onShow() {
    audioManager.onAppShow();
  },

  onHide() {
    audioManager.onAppHide();
  },
});
