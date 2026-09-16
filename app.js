/**
 * app.js — 远路播客小程序入口
 */
const audioManager = require("./utils/audioManager");
const { getToken, getUserInfo } = require("./utils/request");

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

    // 2. 恢复本地登录态（token 本体由 request.js 管理，这里只预热用户信息）
    if (getToken()) {
      this.globalData.userInfo = getUserInfo();
    }
  },

  onShow() {
    audioManager.onAppShow();
  },

  onHide() {
    audioManager.onAppHide();
  },
});
