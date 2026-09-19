const authStore = require('../../store/authStore');

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
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
  onAppearance() {
    // 小程序暂不实现原生地图级别的多主题切换，这里可以留作跳转
    wx.showToast({ title: '小程序暂不支持主题切换', icon: 'none' });
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
