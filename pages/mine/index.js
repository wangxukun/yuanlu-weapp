const authStore = require('../../store/authStore');
const theme = require('../../utils/theme');

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
    themeClass: '',
    // 数据轨迹宫格（对齐 Web GRID_ENTRIES）
    gridEntries: [
      { name: '学习路径', url: '/pages/library/paths/index', icon: '/assets/icons/route.png' },
      { name: '收听历史', url: '/pages/library/history/index', icon: '/assets/icons/history.png' },
      { name: '我的收藏', url: '/pages/library/favorites/index', icon: '/assets/icons/bookmark.png' },
      { name: '我的订阅', url: '/pages/library/subscribe/index', icon: '/assets/icons/credit-card.png' }
    ]
  },

  onLoad() {
    // 监听 store 变化，保存返回的取消订阅函数
    this.unsubscribeAuth = authStore.subscribe(() => {
      this.syncStoreData();
    });
  },

  onShow() {
    this.syncStoreData();
    // 外观根类：手动模式覆盖令牌（跟随系统返回空类走媒体查询）
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏
  },

  onUnload() {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
    }
  },

  onStoreChange() {
    this.syncStoreData();
  },

  syncStoreData() {
    const state = authStore.getState();
    this.setData({
      isLoggedIn: state.isLoggedIn,
      userInfo: state.userInfo
    });
  },

  /** 未登录：去登录页 */
  onLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  /** 已登录：去个人资料编辑页 */
  onProfile() {
    wx.navigateTo({ url: '/pages/profile/index' });
  },

  /** 外观设置 */
  /**
   * 外观设置（对齐 Web next-themes 三模式）：ActionSheet 三选一，
   * 「（当前）」标记现行模式；选择后持久化并即时生效（本页 setData 根类 +
   * chrome 同步，其余页面下次 onShow 刷新）。
   */
  onAppearance() {
    const current = theme.getMode();
    const modes = theme.MODES;
    wx.showActionSheet({
      itemList: modes.map((m) => theme.MODE_LABELS[m] + (m === current ? '（当前）' : '')),
      success: (res) => {
        const next = modes[res.tapIndex];
        if (!next || next === current) return;
        theme.setMode(next);
        this.setData({ themeClass: theme.rootClass() });
        wx.showToast({ title: '已切换为' + theme.MODE_LABELS[next], icon: 'none' });
      },
      fail: () => { /* 取消选择 */ },
    });
  },

  /** 退出登录 */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmColor: '#e0403f',
      success: (res) => {
        if (res.confirm) {
          authStore.logout();
          wx.showToast({ title: '已退出', icon: 'success' });
          // 清空数据状态会通过 store 的 subscribe 自动触发 syncStoreData()
        }
      }
    });
  }
});
