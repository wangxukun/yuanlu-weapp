/**
 * pages/library/favorites/index.js — 「我的收藏」
 *
 * 逻辑移植自 Android 端 feature/favorites：
 *   - FavoritesViewModel.kt：UiState（isLoading/error/activeTab/searchQuery/podcasts/episodes）
 *     + 关键字过滤（标题/作者不区分大小写包含匹配）+ 乐观取消收藏；
 *   - FavoriteCenter.kt：取消收藏 = 乐观移除 → 请求失败回滚快照 + 统一 Toast
 *     （显式 remove 语义，不依赖已知收藏态翻转）。
 *
 * API（对齐 ContentApi.kt 收藏段）：
 *   GET  /api/user/favorites                信封 { success, data: { podcasts, episodes } }，需登录
 *   DELETE /api/podcast/favorite/delete     urlencoded 体 { podcastid, userid }（带体 DELETE）
 *   DELETE /api/episode/favorite/delete     urlencoded 体 { episodeid, userid }
 */

const theme = require('../../../utils/theme');
const { get, delete: requestDelete } = require('../../../utils/request');
const authStore = require('../../../store/authStore');

/** 收听数缩写（对齐 Android formatPlaysShort：>999 转 "x.xk"） */
function formatPlaysShort(count) {
  const n = Number(count) || 0;
  return n > 999 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

/** 千分位（对齐 Android String.format(Locale.US, "%,d")） */
function formatThousands(count) {
  return String(Number(count) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 收藏的播客 → 卡片展示模型（对齐 FavoriteSeriesDto.toDomain + 首标签展示） */
function mapPodcast(raw) {
  const tags = (raw && raw.category) || [];
  const firstTag = tags.length ? String(tags[0].name || '').toUpperCase() : '';
  return {
    id: raw.id,
    title: raw.title || '',
    author: raw.author || 'Unknown Author',
    thumbnailUrl: raw.thumbnailUrl || '',
    firstTag,
    episodeCount: Number(raw.episodeCount) || 0,
    playsShort: formatPlaysShort(raw.plays),
    followers: Number(raw.followers) || 0,
  };
}

/** 收藏的单集 → 卡片展示模型（副标题 = 所属播客 · 平台，时长/收听数服务端口径） */
function mapEpisode(raw) {
  const subtitle = [raw.author, raw.platform]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .join(' · ');
  return {
    id: raw.id,
    title: raw.title || '',
    author: raw.author || '',
    subtitle: subtitle || 'Unknown Series',
    thumbnailUrl: raw.thumbnailUrl || '',
    durationText: raw.duration || '--',
    playCountText: formatThousands(raw.playCount),
    favoriteCountText: String(Number(raw.favoriteCount) || 0),
  };
}

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    // ---- FavoritesUiState ----
    isLoading: true,
    error: '',
    needLogin: false, // 错误态区分「去登录」与「重试」
    activeTab: 'podcasts', // 'podcasts' | 'episodes'
    searchQuery: '',
    podcasts: [],
    episodes: [],
    // 搜索过滤结果（wxml 渲染源，对齐 filteredPodcasts/filteredEpisodes）
    filteredPodcasts: [],
    filteredEpisodes: [],
  },

  onLoad() {
    /** 在途的取消收藏 id 集合（对齐 FavoriteCenter.pendingKeys 防重入） */
    this.pendingIds = new Set();
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
    // 每次进入/回到本页都重取（对齐 Android revision 机制：详情页收藏变更后列表自动刷新，
    // 登录页返回后登录态也随之生效）
    this.fetchFavorites({ showLoading: !this._hasLoaded });
  },

  onUnload() {},

  onPullDownRefresh() {
    this.fetchFavorites({ showLoading: false }).then(() => wx.stopPullDownRefresh());
  },

  // ==================== 数据获取 ====================

  async fetchFavorites(opts = {}) {
    const showLoading = opts.showLoading !== false;
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, error: '' });
      return;
    }
    if (showLoading) this.setData({ isLoading: true, error: '', needLogin: false });

    try {
      const res = await get('/api/user/favorites');
      const data = (res && res.data) || {};
      const podcasts = (data.podcasts || []).map(mapPodcast);
      const episodes = (data.episodes || []).map(mapEpisode);
      this._hasLoaded = true;
      this.setData({ isLoading: false, error: '', needLogin: false, podcasts, episodes });
      this.applyFilter();
    } catch (err) {
      this.setData({ isLoading: false, error: err.message || '加载收藏失败' });
    }
  },

  /** 关键字过滤（对齐 FavoritesUiState.filteredXxx：标题/作者不区分大小写包含匹配） */
  applyFilter() {
    const q = (this.data.searchQuery || '').trim().toLowerCase();
    const match = (item) =>
      !q ||
      (item.title || '').toLowerCase().includes(q) ||
      (item.author || '').toLowerCase().includes(q);
    this.setData({
      filteredPodcasts: this.data.podcasts.filter(match),
      filteredEpisodes: this.data.episodes.filter(match),
    });
  },

  onRetry() {
    this.fetchFavorites();
  },

  /** 登录态错误框的「去登录」（对齐 Web 受限页引导） */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  // ==================== Tab / 搜索 ====================

  onSelectTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
  },

  onSearchInput(e) {
    this.setData({ searchQuery: e.detail.value || '' });
    this.applyFilter();
  },

  onClearSearch() {
    this.setData({ searchQuery: '' });
    this.applyFilter();
  },

  // ==================== 取消收藏（乐观移除 + 失败回滚，对齐 FavoriteCenter） ====================

  onRemovePodcast(e) {
    this.removeFavorite('podcasts', e.currentTarget.dataset.id);
  },

  onRemoveEpisode(e) {
    this.removeFavorite('episodes', e.currentTarget.dataset.id);
  },

  /**
   * 乐观取消收藏：先从本地列表移除（Tab 总数随之减少），请求失败回滚快照。
   * 显式 remove 语义：不做「已知状态翻转」，避免把删除误判成插入。
   */
  removeFavorite(listKey, id) {
    if (!id || this.pendingIds.has(id)) return; // 在途防重入

    const snapshot = this.data[listKey];
    if (!snapshot.some((it) => it.id === id)) return;

    const userid = this.getUserId();
    this.pendingIds.add(id);
    this.setData({ [listKey]: snapshot.filter((it) => it.id !== id) });
    this.applyFilter();

    const isPodcast = listKey === 'podcasts';
    const url = isPodcast ? '/api/podcast/favorite/delete' : '/api/episode/favorite/delete';
    const body = isPodcast ? { podcastid: id, userid } : { episodeid: id, userid };

    requestDelete(url, body, {
      // 后端读 urlencoded 表单（对齐 Android @FormUrlEncoded + @HTTP(hasBody=true)）
      header: { 'Content-Type': 'application/x-www-form-urlencoded' },
      showError: false,
    })
      .then(() => {
        wx.showToast({ title: '已取消收藏', icon: 'none' });
      })
      .catch((err) => {
        // 回滚快照（对齐 FavoriteCenter 的失败回滚 + 重取语义）
        this.setData({ [listKey]: snapshot });
        this.applyFilter();
        wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' });
      })
      .then(() => {
        this.pendingIds.delete(id);
      });
  },

  getUserId() {
    const userInfo = authStore.getState().userInfo || {};
    return userInfo.userid || userInfo.id || '';
  },

  // ==================== 跳转 ====================

  onOpenPodcast(e) {
    wx.navigateTo({ url: `/pages/podcast/podcast?id=${e.currentTarget.dataset.id}` });
  },

  onOpenEpisode(e) {
    wx.navigateTo({ url: `/pages/episode/episode?id=${e.currentTarget.dataset.id}` });
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },
});
