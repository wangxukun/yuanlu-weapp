const authStore = require('../../store/authStore');
const membershipStore = require('../../store/membershipStore');
const theme = require('../../utils/theme');
const notificationBadge = require('../../utils/notification-badge');
const { get } = require('../../utils/request');
const profileApi = require('../../utils/api/profile');
const profileCore = require('../../utils/profile-core');

/** 切片特训累计条数：今日挑战 90 天本地流水（studio_daily_history_v2，
 * daily-challenge.js 的 history() 同 key 同结构）里 practicedOn 非空的去重句数 */
function countPracticedClips() {
  let rows;
  try { rows = wx.getStorageSync('studio_daily_history_v2'); } catch (e) { return 0; }
  if (!Array.isArray(rows)) return 0;
  const keys = new Set();
  for (const r of rows) {
    if (r && r.practicedOn && r.key) keys.add(r.key);
  }
  return keys.size;
}

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
    // 用户卡角色角标（预计算，WXML 零方法调用）：ADMIN 优先；非管理员以
    // membershipStore 权威校正为准（checked && isPremium）——DB role 只是
    // 展示缓存，纯小程序付费后不会自动翻，订阅页胶囊同口径（附录 C）。
    roleBadgeText: '普通用户',
    roleBadgeClass: 'normal',
    themeClass: '',
    dark: false,
    unreadCount: 0,
    themeLabel: '跟随系统', // 外观设置行尾值（Android trailing：跟随系统/浅色/深色）
    // 学习成果四宫格（B 工程 ProfileView 口径：跟读连胜/复习单词/发音最高分/切片特训）
    stats: {
      streakDays: 0,
      wordsLearned: 0,
      bestPronunciation: 0,
      shadowingClips: 0
    }
  },

  onLoad() {
    // 监听 store 变化，保存返回的取消订阅函数
    this.unsubscribeAuth = authStore.subscribe(() => {
      this.syncStoreData();
    });
    // 会员态权威校正回调（付费后切回本 tab 角标即时收敛）
    this.unsubscribeMembership = membershipStore.subscribe(() => {
      this.syncStoreData();
    });
  },

  onShow() {
    this.syncStoreData();
    this.syncUnreadCount();
    // 会员权威校正（TTL 内命中缓存）：回包后订阅回调刷角色角标
    membershipStore.ensureFresh();
    // 外观根类：手动模式覆盖令牌（跟随系统返回空类走媒体查询）
    this.setData({ themeClass: theme.rootClass(), dark: theme.getEffective() === 'dark', themeLabel: theme.MODE_LABELS[theme.getMode()] });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏
    this._applyPullTheme();
    this._loadStats();
  },

  /** 下拉刷新：重拉四宫格/会员态/未读角标，全部 settle 后收圈 */
  async onPullDownRefresh() {
    try {
      await Promise.all([
        this._loadStats(),
        Promise.resolve(membershipStore.ensureFresh()),
      ].map((p) => Promise.resolve(p).catch(() => { /* 静默：单项失败不阻塞收圈 */ })));
      this.syncUnreadCount();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 下拉刷新区域跟随主题：浅色深圈/深色浅圈（json 静态配置的运行时校正） */
  _applyPullTheme() {
    const dark = theme.getEffective() === 'dark';
    try {
      wx.setBackgroundColor({ backgroundColor: dark ? '#151310' : '#faf8f3', fail: () => {} });
      wx.setBackgroundTextStyle({ textStyle: dark ? 'light' : 'dark', fail: () => {} });
    } catch (e) { /* 低版本无此 API 忽略 */ }
  },

  onUnload() {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
    }
    if (this.unsubscribeMembership) {
      this.unsubscribeMembership();
    }
  },

  onStoreChange() {
    this.syncStoreData();
  },

  syncStoreData() {
    const state = authStore.getState();
    const membership = membershipStore.getState();
    // 角色角标派生：ADMIN 直通（本地展示缓存仅此一处可信——管理员不靠订阅）；
    // 其余以订阅表权威校正为准，过期会员缓存 role=PREMIUM 也不会误报
    let roleBadgeText = '普通用户';
    let roleBadgeClass = 'normal';
    if (state.userInfo && state.userInfo.role === 'ADMIN') {
      roleBadgeText = '管理员';
      roleBadgeClass = 'admin';
    } else if (membership.checked && membership.isPremium) {
      roleBadgeText = '高级会员';
      roleBadgeClass = 'premium';
    }
    const patch = {
      isLoggedIn: state.isLoggedIn,
      userInfo: state.userInfo,
      roleBadgeText,
      roleBadgeClass
    };
    // 登出即清角标（登录态拉取在 syncUnreadCount）
    if (!state.isLoggedIn) patch.unreadCount = 0;
    this.setData(patch);
  },

  /**
   * 未读数角标：经 Tab 红点服务取数（登录守卫/静默失败在服务内）——一次请求
   * 同时供本页菜单角标与「我的」Tab 红点；从通知页返回时 onShow 自动刷新。
   */
  syncUnreadCount() {
    notificationBadge.syncUnreadBadge().then((n) => {
      this.setData({ unreadCount: n });
    }).catch(() => { /* 静默：角标失败保持旧值 */ });
  },

  /**
   * 学习成果四宫格（复刻 B 工程 ProfileView，生产真实口径）：
   * - 跟读连胜：GET /api/streak（weapp_streak_log 跟读开口口径——与主页连胜卡
   *   同源铁律；overview.streakDays 是网站收听 isActive 口径，不复用）
   * - 复习单词：overview.wordsLearned（生词本词量 = SRS 复习对象规模）
   * - 发音最高分：overview.bestPronunciation（speech_recognition 最高准确分）
   * - 切片特训：本地 studio_daily_history_v2 已练句去重条数（今日挑战 90 天流水）
   * 全部静默失败保持旧值，onShow 每次进页刷新。
   */
  _loadStats() {
    if (!authStore.getState().isLoggedIn) return Promise.resolve();
    const remote = [
      profileApi.getStatsOverview().then((raw) => {
        const s = profileCore.mapStats(raw);
        if (!s) return;
        this.setData({
          'stats.wordsLearned': s.wordsLearned,
          'stats.bestPronunciation': s.bestPronunciation
        });
      }),
      get('/api/streak', null, { showError: false }).then((body) => {
        if (body && body.success && body.data) {
          this.setData({ 'stats.streakDays': body.data.streakDays || 0 });
        }
      }),
    ].map((p) => p.catch(() => { /* 静默：看板单项失败保持旧值 */ }));
    this.setData({ 'stats.shadowingClips': countPracticedClips() });
    return Promise.all(remote);
  },

  /** 消息通知（未读角标随 onShow 静默刷新） */
  onNotifications() {
    wx.navigateTo({ url: '/pages/notifications/index' });
  },

  /** 未登录：去登录页 */
  onLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  /** 已登录：去个人资料编辑页 */
  onProfile() {
    wx.navigateTo({ url: '/pages/profile/index' });
  },

  /**
   * 我的订阅：进订阅页（模块 E 已建，SUBSCRIBE-TASK T2.2 真路由；source 供
   * 订阅页埋点归因）。行仅登录态可见（Android 分组口径：未登录仅剩外观/帮助
   * 两项），游客购买入口 = premium-modal CTA → 订阅页游客横幅 → auth 页闭环。
   */
  onSubscribe() {
    wx.navigateTo({ url: '/pages/subscription/index?source=mine_subscription' });
  },

  /** 控制台（仅管理员入口可见）：小程序端未建管理后台，占位提示 */
  onAdminConsole() {
    wx.showToast({ title: '控制台功能即将上线', icon: 'none' });
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
        this.setData({ themeClass: theme.rootClass(), themeLabel: theme.MODE_LABELS[next] });
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
