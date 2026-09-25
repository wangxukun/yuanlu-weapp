const theme = require('../../utils/theme');
const { get, post, delete: requestDelete } = require('../../utils/request');
const authStore = require('../../store/authStore');

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    podcastid: '',
    podcast: null,
    episodes: [],
    channelPodcasts: [],
    total: 0,
    page: 1,
    hasMore: true,
    isLoading: true,
    isLoadingMore: false,
    error: null,
    introExpanded: false,
    isFavorited: false,
    isFavoriteBusy: false
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
  },

  onLoad(query) {
    this.setData({ podcastid: query.id });
    this.fetchData();
  },

  onPullDownRefresh() {
    this.setData({ page: 1, episodes: [], hasMore: true });
    this.fetchData().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  fetchData() {
    const { podcastid } = this.data;
    this.setData({ isLoading: true, error: null });

    return Promise.all([
      get('/api/podcast/detail?id=' + podcastid),
      get('/api/episode/list-by-podcastid?podcastId=' + podcastid + '&page=1&limit=20')
    ]).then(([detailRes, episodesRes]) => {
      let podcast = detailRes;
      let channelPodcasts = [];
      if (podcast && podcast.channelPodcasts) {
        channelPodcasts = podcast.channelPodcasts;
      }
      
      this.setData({
        podcast,
        channelPodcasts,
        episodes: episodesRes.data.episodes || [],
        total: episodesRes.data.total || 0,
        hasMore: episodesRes.data.hasMore || false,
        page: 1,
        isLoading: false
      });

      this.checkFavorite();
    }).catch(err => {
      this.setData({ error: err.message || '加载失败', isLoading: false });
    });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.isLoadingMore) return;
    this.setData({ isLoadingMore: true });
    
    const nextPage = this.data.page + 1;
    get(`/api/episode/list-by-podcastid?podcastId=${this.data.podcastid}&page=${nextPage}&limit=20`)
      .then(res => {
        this.setData({
          episodes: this.data.episodes.concat(res.data.episodes || []),
          hasMore: res.data.hasMore || false,
          page: nextPage,
          isLoadingMore: false
        });
      })
      .catch(err => {
        this.setData({ isLoadingMore: false });
      });
  },

  checkFavorite() {
    const userInfo = authStore.getState().userInfo;
    if (!userInfo) return;
    const userid = userInfo.userid || userInfo.id;
    if (!userid) return;

    get('/api/podcast/favorite/find-unique?podcastid=' + this.data.podcastid + '&userid=' + userid)
      .then(res => {
        this.setData({ isFavorited: !!res.success });
      })
      .catch(() => {});
  },

  onToggleFavorite() {
    const userInfo = authStore.getState().userInfo;
    if (!userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    const userid = userInfo.userid || userInfo.id;
    if (!userid) return;

    if (this.data.isFavoriteBusy) return;
    this.setData({ isFavoriteBusy: true });

    const { isFavorited, podcastid } = this.data;
    
    const header = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const data = { podcastid, userid };
    
    let promise;
    if (isFavorited) {
      promise = requestDelete('/api/podcast/favorite/delete', data, header);
    } else {
      promise = post('/api/podcast/favorite/insert', data, header);
    }

    promise.then(res => {
      this.setData({ 
        isFavorited: !isFavorited,
        isFavoriteBusy: false
      });
      wx.showToast({ title: isFavorited ? '已取消收藏' : '已收藏', icon: 'none' });
    }).catch(() => {
      this.setData({ isFavoriteBusy: false });
      wx.showToast({ title: '操作失败', icon: 'none' });
    });
  },

  onShare() {
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    wx.showToast({ title: '请点击右上角分享', icon: 'none' });
  },

  onShareAppMessage() {
    const p = this.data.podcast;
    return {
      title: p ? p.title : '播客详情',
      path: '/pages/podcast/podcast?id=' + this.data.podcastid,
      imageUrl: p ? p.coverUrl : ''
    };
  },

  onToggleIntro() {
    this.setData({ introExpanded: !this.data.introExpanded });
  },

  onOpenEpisode(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/episode/episode?id=' + id });
  },

  onOpenPodcast(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/podcast/podcast?id=' + id });
  },

  onOpenChannel() {
    const p = this.data.podcast;
    if (p && p.platform) {
      wx.showToast({ title: '频道开发中', icon: 'none' });
    }
  }
});
