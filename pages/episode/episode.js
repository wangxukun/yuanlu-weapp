const { get, post, delete: requestDelete } = require('../../utils/request');
const authStore = require('../../store/authStore');

Page({
  data: {
    episodeid: '',
    episode: null,
    relatedEpisodes: [],
    comments: [],
    
    isLoading: true,
    error: null,

    // Favorites
    isFavorited: false,
    isFavoriteBusy: false,

    // Comments
    isLoadingComments: false,
    commentText: '',
    isSubmittingComment: false,

    // Intro Expanded
    introExpanded: false,
    
    // AI Modal / Card (Screenshot UI)
    // PRO up-sell card is static layout for now as per Android/Screenshot, just need to render.
    
    // Auth state for interactions
    isLoggedIn: false,
    
    // Translated notes
    translatedDesc: null,
    isTranslatingDesc: false,
    translatedTitle: null,
    isTranslatingTitle: false,
  },

  onLoad(query) {
    this.setData({ episodeid: query.id });
    
    // Subscribe to auth state
    const updateAuth = () => {
      const state = authStore.getState();
      this.setData({ isLoggedIn: state.isLoggedIn });
      if (state.isLoggedIn && !this.data.isFavorited) {
        this.checkFavorite();
      }
    };
    this.unsubscribeAuth = authStore.subscribe(updateAuth);
    updateAuth();

    this.fetchData();
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
  },

  onPullDownRefresh() {
    this.fetchData().then(() => wx.stopPullDownRefresh());
  },

  async fetchData() {
    const { episodeid } = this.data;
    this.setData({ isLoading: true, error: null });

    try {
      // 1. Fetch Episode Detail
      const episode = await get(`/api/episode/detail?id=${episodeid}`);
      this.setData({ episode, isLoading: false });

      // 2. Fetch Related Episodes
      if (episode && episode.podcastid) {
        get(`/api/episode/list-by-podcastid?podcastId=${episode.podcastid}&page=1&limit=20`)
          .then(res => {
            const all = res.data.episodes || [];
            const relatedEpisodes = all
              .filter(ep => ep.episodeid !== episodeid)
              .slice(0, 5);
            this.setData({ relatedEpisodes });
          }).catch(console.error);
      }

      // 3. Fetch Comments
      this.fetchComments();

      // 4. Check Favorite
      this.checkFavorite();

    } catch (err) {
      this.setData({ error: err.message || '加载失败', isLoading: false });
    }
  },

  async fetchComments() {
    this.setData({ isLoadingComments: true });
    try {
      const comments = await get(`/api/comment/list?episodeid=${this.data.episodeid}`);
      this.setData({ comments, isLoadingComments: false });
    } catch (e) {
      this.setData({ isLoadingComments: false });
    }
  },

  checkFavorite() {
    const userInfo = authStore.getState().userInfo;
    if (!userInfo || !userInfo.id && !userInfo.userid) return;
    const userid = userInfo.userid || userInfo.id;

    get(`/api/episode/favorite/find-unique?episodeid=${this.data.episodeid}&userid=${userid}`)
      .then(res => {
        this.setData({ isFavorited: !!res.success });
      })
      .catch(() => {});
  },

  onToggleFavorite() {
    const userInfo = authStore.getState().userInfo;
    if (!userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    const userid = userInfo.userid || userInfo.id;

    if (this.data.isFavoriteBusy) return;
    this.setData({ isFavoriteBusy: true });

    const { isFavorited, episodeid } = this.data;
    const header = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const data = { episodeid, userid };

    const promise = isFavorited 
      ? requestDelete('/api/episode/favorite/delete', data, header)
      : post('/api/episode/favorite/insert', data, header);

    promise.then(() => {
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

  onToggleIntro() {
    this.setData({ introExpanded: !this.data.introExpanded });
  },

  onStartListening() {
    // 触发播放并进入沉浸式播放器，这里可以调用播放器 API 或页面跳转
    wx.showToast({ title: '开始精听 (播放器即将接入)', icon: 'none' });
  },

  onPractice() {
    if (!this.data.isLoggedIn) {
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    if (this.data.episode && this.data.episode.isExclusive) {
      // 检查权限等逻辑
    }
    wx.showToast({ title: '语音评测即将上线', icon: 'none' });
  },

  onDownloadAudio() {
    if (!this.data.isLoggedIn) {
      return wx.showToast({ title: '音频下载仅对会员开放', icon: 'none' });
    }
    wx.showToast({ title: '音频下载功能即将上线', icon: 'none' });
  },

  onTranscript() {
    if (!this.data.isLoggedIn) {
      return wx.showToast({ title: '文稿下载仅对会员开放', icon: 'none' });
    }
    wx.showToast({ title: '文稿弹层功能开发中', icon: 'none' });
  },

  onShare() {
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    wx.showToast({ title: '请点击右上角分享', icon: 'none' });
  },

  onShareAppMessage() {
    const ep = this.data.episode;
    return {
      title: ep ? ep.title : '剧集详情',
      path: '/pages/episode/episode?id=' + this.data.episodeid,
      imageUrl: ep ? ep.coverUrl : ''
    };
  },

  onOpenEpisode(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/episode/episode?id=${id}` });
  },

  onOpenPodcast() {
    if (this.data.episode && this.data.episode.podcastid) {
      wx.navigateTo({ url: `/pages/podcast/podcast?id=${this.data.episode.podcastid}` });
    }
  },

  onTranslateTitle() {
    // 模拟翻译，真实需调用有道接口
    if (!this.data.isLoggedIn) {
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    if (this.data.translatedTitle) {
      this.setData({ translatedTitle: null });
      return;
    }
    this.setData({ isTranslatingTitle: true });
    setTimeout(() => {
      this.setData({ 
        isTranslatingTitle: false, 
        translatedTitle: '我能拯救这家家庭餐厅吗？' // 模拟返回
      });
    }, 1000);
  },

  onTranslateDescription() {
    if (!this.data.isLoggedIn) {
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    if (this.data.translatedDesc) {
      this.setData({ translatedDesc: null });
      return;
    }
    this.setData({ isTranslatingDesc: true });
    setTimeout(() => {
      this.setData({ 
        isTranslatingDesc: false, 
        translatedDesc: '经营餐厅很难。工作时间长，利润微薄，压力持续不断。在本周的节目中，我们将讨论如何拯救家族餐厅的业务。'
      });
    }, 1000);
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
  },

  async onSubmitComment() {
    const text = this.data.commentText.trim();
    if (!text) return;

    this.setData({ isSubmittingComment: true });
    try {
      const userInfo = authStore.getState().userInfo;
      const res = await post('/api/comment/create', {
        episodeid: this.data.episodeid,
        content: text,
        userid: userInfo.userid || userInfo.id
      });
      // 将新评论加入列表
      this.setData({ 
        comments: [res, ...this.data.comments],
        commentText: '',
        isSubmittingComment: false 
      });
      wx.showToast({ title: '评论成功', icon: 'success' });
    } catch (e) {
      this.setData({ isSubmittingComment: false });
      wx.showToast({ title: '评论失败', icon: 'none' });
    }
  }
});
