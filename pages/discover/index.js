/**
 * pages/discover — 专项特训（第二 Tab，工具化转型重构；2026-11-05 去 mock 接真数据）
 *
 * 三段式（无信息流、无滚动容器）：
 *   1. 发音急救箱：GET /api/speech/notebook 最弱音素诊断（登录）→「立即攻克」
 *      进发音闯关；无画像 → 引导去复习页做跟读；游客 → 登录引导。
 *   2. 语境卡册书架：GET /api/learning-paths/mine 前 4 张真卡册（签名封面/真进度），
 *      点卡片直达卡册详情；「全部」进卡册列表；空态 → 心愿工坊 CTA。
 *   3. 今日一测：GET /api/scenes/feed 前 5 段按日期种子定一段（每天换题、
 *      当天稳定）→ 精研室听写模式（mode=dictate）。
 */
const theme = require('../../utils/theme');
const { get } = require('../../utils/request');
const authStore = require('../../store/authStore');
const pronCore = require('../../utils/pron-core');

/** 书架展示上限（两列网格） */
const SHELF_LIMIT = 4;
/** 今日一测候选池（日期种子从中定一段） */
const DAILY_POOL = 5;
/** 书架空封面按序回退的专属图标批（与真实封面二选一） */
const SHELF_FALLBACK_ICONS = [
  '/assets/icons/work-primary.svg',
  '/assets/icons/record-voice-over-primary.svg',
  '/assets/icons/flight-primary.svg',
  '/assets/icons/history-edu-primary.svg',
];

/** yyyymmdd 当日种子（当天内稳定、跨天换题） */
function daySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 卡册行 → 书架卡 VM（WXML 零方法调用：进度/标题预计算） */
function mapShelfBook(p, index) {
  const progress = Math.min(100, Math.max(0, Math.round(Number(p.progress) || 0)));
  return {
    key: String(p.pathid),
    pathid: p.pathid,
    title: p.pathName || '未命名卡册',
    cover: p.coverUrl || SHELF_FALLBACK_ICONS[index % SHELF_FALLBACK_ICONS.length],
    isIcon: !p.coverUrl,
    progress,
    progressText: '已练 ' + progress + '%',
  };
}

Page({
  data: {
    themeClass: '',
    dark: false,
    isLoggedIn: false,

    // ---- 1. 发音急救箱 ----
    aid: {
      state: 'loading', // loading | ready | empty | guest
      weakLabel: '',    // '/θ/' + 平均分
      weakDesc: '',
    },

    // ---- 2. 语境卡册书架 ----
    shelf: {
      state: 'loading', // loading | ready | empty | guest
      books: [],
    },

    // ---- 3. 今日一测 ----
    testBusy: false,
  },

  onLoad() {
    this._unsubAuth = authStore.subscribe(() => this._syncAuthState());
  },

  onUnload() {
    if (this._unsubAuth) this._unsubAuth();
  },

  onShow() {
    this.setData({ themeClass: theme.rootClass(), dark: theme.getState().effective === 'dark' });
    theme.applyChrome();
    this._syncAuthState();
  },

  _syncAuthState() {
    const loggedIn = authStore.getState().isLoggedIn;
    const wasLoggedIn = this.data.isLoggedIn;
    this.setData({ isLoggedIn: loggedIn });
    // 登录态翻转时重拉个性化段（急救箱/书架）；今日一测公开无须经登录
    if (loggedIn !== wasLoggedIn || this._aidState === undefined) {
      this._loadAid();
      this._loadShelf();
    }
  },

  // ==================== 1. 发音急救箱（真发音画像） ====================

  async _loadAid() {
    if (!authStore.getState().isLoggedIn) {
      this._aidState = 'guest';
      this.setData({ aid: { state: 'guest', weakLabel: '', weakDesc: '' } });
      return;
    }
    this._aidState = 'loading';
    this.setData({ 'aid.state': 'loading' });
    try {
      const body = await get('/api/speech/notebook', null, { showError: false });
      const notebook = pronCore.parseNotebook(body);
      const stats = (notebook && Array.isArray(notebook.phonemeStats)) ? notebook.phonemeStats : [];
      const first = stats[0];
      if (first && first.phoneme) {
        const score = Math.round(Number(first.avgScore) || 0);
        this._aidState = 'ready';
        this.setData({
          aid: {
            state: 'ready',
            weakLabel: '/' + first.phoneme + '/ ' + score + ' 分',
            weakDesc: '系统诊断：你的 /' + first.phoneme + '/ 平均 ' + score + ' 分，最容易失分',
          },
        });
      } else {
        this._aidState = 'empty';
        this.setData({
          aid: {
            state: 'empty',
            weakLabel: '',
            weakDesc: '还没有发音画像——完成几句跟读评分，就能定位你的薄弱音素',
          },
        });
      }
    } catch (e) {
      // 画像接口异常按无画像承接（不阻塞页面）
      this._aidState = 'empty';
      this.setData({
        aid: { state: 'empty', weakLabel: '', weakDesc: '还没有发音画像——完成几句跟读评分，就能定位你的薄弱音素' },
      });
    }
  },

  /** 急救箱 CTA：有画像 → 发音闯关；无画像 → 复习页发音 Tab；游客 → 登录 */
  onPhonemeGo() {
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/auth/index' });
      return;
    }
    if (this._aidState === 'ready') {
      wx.navigateTo({ url: '/pages/review/practice/index' });
      return;
    }
    try { wx.setStorageSync('review:pendingTab', 2); } catch (e) { /* 静默 */ }
    wx.switchTab({ url: '/pages/review/index' });
  },

  // ==================== 2. 语境卡册书架（真卡册） ====================

  async _loadShelf() {
    if (!authStore.getState().isLoggedIn) {
      this._shelfLoaded = 'guest';
      this.setData({ shelf: { state: 'guest', books: [] } });
      return;
    }
    this.setData({ 'shelf.state': 'loading' });
    try {
      const body = await get('/api/learning-paths/mine', null, { showError: false });
      const rows = (body && body.success && Array.isArray(body.data)) ? body.data : [];
      const books = rows.slice(0, SHELF_LIMIT).map(mapShelfBook);
      this.setData({
        shelf: { state: books.length > 0 ? 'ready' : 'empty', books },
      });
    } catch (e) {
      // 拉取失败按空态承接（不阻塞三段布局）
      this.setData({ shelf: { state: 'empty', books: [] } });
    }
  },

  /** 书架卡片 → 卡册详情（真 pathid） */
  onBookTap(e) {
    const pathid = e.currentTarget.dataset.pathid;
    if (pathid) wx.navigateTo({ url: '/pages/library/paths/detail?id=' + pathid });
  },

  /** 空态「去定制」/ 尾部「全部卡册」→ 卡册列表页 */
  onAllBooks() {
    wx.navigateTo({ url: '/pages/library/paths/index' });
  },

  // ==================== 3. 今日一测（日期种子换题） ====================

  /** 今日一测：feed 候选池按日期种子定一段 → 精研室听写模式（失败 toast） */
  async onDailyTestTap() {
    if (this.data.testBusy) return;
    this.setData({ testBusy: true });
    try {
      const body = await get('/api/scenes/feed?page=1&pageSize=' + DAILY_POOL, null, { showError: false });
      const items = body && body.success && body.data && body.data.items;
      const pick = Array.isArray(items) && items.length > 0
        ? items[daySeed() % items.length]
        : null;
      if (pick && pick.sceneid) {
        wx.navigateTo({
          url: '/pages/intensive-listening/index?sceneId=' + pick.sceneid + '&mode=dictate',
        });
      } else {
        wx.showToast({ title: '今日题库准备中，稍后再来', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '题库加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ testBusy: false });
    }
  },
});
