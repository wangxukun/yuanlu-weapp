/**
 * pages/library/favorites/index — 我的收藏（RESHAPE-TASK T5.2 重建）
 *
 * 双 Tab（复用原页面骨架）：
 *   - 收藏的微剧场：utils/scene-favorites 本地收藏夹（探索画廊一键收藏），
 *     卡片=封面+金句+微播放器切片试听+直达精研室+移除；
 *   - 我的特训卡册：GET /api/learning-paths/mine（后端既有路由），
 *     心愿工坊产物列表 → 详情页（蒙太奇卡册/剧集行自适应）。
 */
const theme = require('../../../utils/theme');
const authStore = require('../../../store/authStore');
const { get } = require('../../../utils/request');
const sceneFavorites = require('../../../utils/scene-favorites');

Page({
  data: {
    themeClass: '',
    dark: false,
    activeTab: 'scenes', // scenes | books
    needLogin: false,
    isLoadingBooks: false,

    scenes: [], // 本地收藏快照（预格式化视图）
    favPlaying: '',
    books: [], // { pathid, pathName, itemCount, isPublic }
  },

  onLoad(options) {
    if (options && options.tab === 'books') this.setData({ activeTab: 'books' });
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    this.refresh();
  },

  refresh() {
    // 微剧场收藏（本地，游客可用）
    const scenes = sceneFavorites.list().map((x) => ({
      sceneid: x.sceneid,
      title: x.title || '',
      coverUrl: x.coverUrl || '',
      en: x.en || '',
      zh: x.zh || '',
      start: x.start || 0,
      end: x.end || 0,
      tagLabel: [x.situationTag, x.cefrLabel].filter(Boolean).join(' · '),
    }));
    this.setData({ scenes });

    // 特训卡册（需登录）
    if (authStore.getState().isLoggedIn) {
      if (this.data.needLogin) this.setData({ needLogin: false });
      this.fetchBooks();
    } else {
      this.setData({ needLogin: true, books: [] });
    }
  },

  fetchBooks() {
    if (this._booksFetching) return;
    this._booksFetching = true;
    this.setData({ isLoadingBooks: true });
    get('/api/learning-paths/mine', null, { showError: false })
      .then((body) => {
        const rows = (body && body.success && Array.isArray(body.data)) ? body.data : [];
        this.setData({
          isLoadingBooks: false,
          books: rows.map((r) => ({
            pathid: r.pathid,
            pathName: r.pathName || '未命名卡册',
            itemCount: r.itemCount != null ? r.itemCount : (r.items ? r.items.length : 0),
            isPublic: !!r.isPublic,
          })),
        });
      })
      .catch(() => {
        this.setData({ isLoadingBooks: false, books: [] });
      })
      .finally(() => {
        this._booksFetching = false;
      });
  },

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab && tab !== this.data.activeTab) this.setData({ activeTab: tab });
  },

  /** 微剧场卡 → 精研室 */
  onSceneTap(e) {
    const sceneid = e.currentTarget.dataset.scene;
    if (sceneid) wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + sceneid });
  },

  /** 移除收藏（乐观，本地集合即刻生效） */
  onSceneRemove(e) {
    const sceneid = e.currentTarget.dataset.scene;
    sceneFavorites.remove(sceneid);
    this.refresh();
  },

  /** 卡册 → 详情（蒙太奇/剧集行自适应） */
  onBookTap(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/library/paths/detail?id=' + id });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },
});
