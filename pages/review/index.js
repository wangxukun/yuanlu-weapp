// pages/review/index — 复习中心（tabBar 页）
// 顶部三 Tab：生词本 / 句子本 / 发音弱项本，对齐 Web 端 components/main/review/ReviewTabs.tsx。
// 未登录渲染整页登录引导态（Web 端为 redirect("/")，tabBar 页不可重定向的等价替代）。
const authStore = require('../../store/authStore');
const theme = require('../../utils/theme');

// 顶部 Tab 栏高度（rpx，含底部描边），用于换算 swiper 内容区高度
const TAB_HEADER_RPX = 89;

// 三 Tab 图标严格复刻 Web 端 ReviewTabs 的 lucide 图标（yuanlu node_modules/lucide-react@0.562.0 原始 path）：
// BookA / TextQuote / Mic；未激活 ink-400 + 线宽 1.75，激活 primary-600 + 线宽 2.25（对齐 strokeWidth 切换）。
const TABS = [
  {
    name: '生词本',
    icon: '/assets/icons/book-a.svg',
    activeIcon: '/assets/icons/book-a-active.svg'
  },
  {
    name: '句子本',
    icon: '/assets/icons/text-quote.svg',
    activeIcon: '/assets/icons/text-quote-active.svg'
  },
  {
    name: '发音弱项本',
    icon: '/assets/icons/mic-ink.svg',
    activeIcon: '/assets/icons/mic-ink-active.svg'
  }
];

Page({
  data: {
    themeClass: '',
    isLoggedIn: false,
    tabs: TABS,
    activeTab: 0,
    swiperHeight: 600,
    refreshSeq: 0,
  },

  onLoad() {
    this._seq = 0;
    this.unsubscribeAuth = authStore.subscribe(() => {
      this.syncAuthState();
    });
    this.computeSwiperHeight();
  },

  onShow() {
    this.syncAuthState();
    // 外观根类：手动模式覆盖令牌（跟随系统返回空类走媒体查询）
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏
    // 从复习/剧集等子页返回时通知各 notebook 重拉数据（vocab-notebook 等
    // swiper 常驻组件无法感知页面 onShow，经 refreshSeq 属性变化触发）
    if (this.data.isLoggedIn) {
      this.setData({ refreshSeq: ++this._seq });
    }
  },

  onUnload() {
    if (this.unsubscribeAuth) {
      this.unsubscribeAuth();
    }
  },

  syncAuthState() {
    const { isLoggedIn } = authStore.getState();
    this.setData({ isLoggedIn });
  },

  // swiper 高度 = 视口高度 − 顶部 Tab 栏。
  // tabBar 页的 windowHeight 已扣除原生 tabBar，无需再减。
  computeSwiperHeight() {
    let win = null;
    try {
      win = wx.getWindowInfo();
    } catch (e) {
      win = wx.getSystemInfoSync();
    }
    if (!win || !win.windowHeight) return;
    const tabHeaderPx = Math.ceil((TAB_HEADER_RPX * win.windowWidth) / 750);
    this.setData({ swiperHeight: win.windowHeight - tabHeaderPx });
  },

  onTabTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index !== this.data.activeTab) {
      this.setData({ activeTab: index });
    }
  },

  onSwiperChange(e) {
    this.setData({ activeTab: e.detail.current });
  },

  /** 未登录引导：去登录页，登录成功 navigateBack 后 onShow 自动恢复内容态 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  }
});
