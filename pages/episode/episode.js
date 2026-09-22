const { get, post, delete: requestDelete } = require('../../utils/request');
const authStore = require('../../store/authStore');
const audioManager = require('../../utils/audioManager');
const audioBus = require('../../utils/audio-bus');

Page({
  data: {
    episodeid: '',
    episode: null,
    relatedEpisodes: [],
    comments: [],

    isLoading: true,
    error: null,

    // 精听深链（全屏播放面板「精听模式」按钮 / 外部分享链 practice=true）：
    // 详情与相关剧集就绪后自动起播精听（见 _maybeAutoPractice）
    autoPractice: false,

    isCurrentPlaying: false, // 「本剧集」正在播放（主按钮/hero 封面播放钮的图标文案切换依据；
                             // 播放控制收敛到全局迷你条 + 全屏面板，见 3.B.3 方案 B）

    // Favorites
    isFavorited: false,
    isFavoriteBusy: false,

    // Comments
    isLoadingComments: false,
    commentText: '',
    isSubmittingComment: false,

    // Intro Expanded
    introExpanded: false,

    // scroll-into-view 锚点（AI 精讲收起时回滚到卡片顶部）
    scrollIntoView: '',
    
    // AI Modal / Card (Screenshot UI)
    // PRO up-sell card is static layout for now as per Android/Screenshot, just need to render.
    
    // Auth state for interactions
    isLoggedIn: false,
    
    // Translated notes
    translatedDesc: null,
    isTranslatingDesc: false,
    translatedTitle: null,
    isTranslatingTitle: false,

    // 词典/翻译配额超限时的会员转化弹窗（对齐 Web openPremiumModal("dictionary_quota")）
    showPremiumModal: false,
  },

  onLoad(query) {
    this.setData({
      episodeid: query.id,
      autoPractice: query.practice === 'true' || query.practice === true,
    });
    
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

    // 订阅全局播放器事件（audioManager 事件总线），维护「本集在播」派生态
    // （isCurrentPlaying：主按钮/封面 FAB 图标文案切换；控制 UI 在迷你条/全屏面板）
    this._onPlayerEvent = (s) => this.syncPlayerState(s);
    ['play', 'pause', 'stop', 'ended', 'waiting', 'episodeChange', 'modeChange', 'seek', 'error'].forEach(
      (evt) => audioManager.on(evt, this._onPlayerEvent)
    );
    // timeupdate 高频且不影响 isCurrentPlaying，不订阅

    // 页面可能带着既有播放会话进入（迷你条跳转/返回），先同步一次快照
    this.syncPlayerState(audioManager.getState());

    this.fetchData();
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
    if (this._onPlayerEvent) {
      ['play', 'pause', 'stop', 'ended', 'waiting', 'episodeChange', 'modeChange', 'seek', 'error'].forEach(
        (evt) => audioManager.off(evt, this._onPlayerEvent)
      );
    }
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
      // 剧集到达后重算「本集在播」态（播放会话可能早于详情加载建立）
      this.syncPlayerState(audioManager.getState());

      // 2. Fetch Related Episodes（就绪后处理精听深链自动起播）
      if (episode && episode.podcastid) {
        get(`/api/episode/list-by-podcastid?podcastId=${episode.podcastid}&page=1&limit=20`)
          .then(res => {
            const all = res.data.episodes || [];
            const relatedEpisodes = all
              .filter(ep => ep.episodeid !== episodeid)
              .slice(0, 5);
            this.setData({ relatedEpisodes });
          }).catch(console.error)
          .then(() => this._maybeAutoPractice());
      } else {
        this._maybeAutoPractice();
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

  /** AI 精讲收起：回滚到卡片锚点（对齐 Web 端 scrollIntoView） */
  onDeepDiveCollapse() {
    this.setData({ scrollIntoView: '' });
    // 下一帧再设置锚点，确保同名锚点重复触发的滚动生效
    setTimeout(() => {
      this.setData({ scrollIntoView: 'ai-dive-anchor' });
    }, 50);
  },

  // ==================== 播放接入（3.B.1 起播链路；控制 UI 在迷你条/全屏面板） ====================

  /** audioManager 快照 → 本集在播派生态（主按钮/封面 FAB 图标文案切换依据） */
  syncPlayerState(s) {
    if (!s) return;
    const ep = this.data.episode;
    const isCurrentPlaying = !!(
      s.hasEpisode && s.isPlaying && ep && s.currentEpisode &&
      s.currentEpisode.episodeid === ep.episodeid
    );
    this.setData({ isCurrentPlaying });
  },

  /**
   * 开始精听（hero 封面 / 主按钮共用）：
   * 先经 audio-bus 停掉 TTS/原声片段（同一时刻只有一个声音），
   * 再走全局后台播放器起播；已在播本集则切换播放/暂停。
   * 播放列表 = 当前剧集 + 同播客相关剧集（ended 自动连播 / 锁屏上一首下一首）。
   */
  onStartListening() {
    const { episode, relatedEpisodes } = this.data;
    if (!episode) return;

    const current = audioManager.getState().currentEpisode;
    if (current && current.episodeid === episode.episodeid) {
      audioManager.togglePlay();
      return;
    }

    audioBus.stopAll(); // 停 TTS / 复习原声片段，防双声
    // 播放列表条目补齐 podcastTitle/coverUrl：list-by-podcastid 返回的剧集对象
    // 可能缺这两字段（与相关剧集行的兜底链一致），否则播放列表切播后
    // 迷你条副标题/锁屏元数据会回落「远路播客」兜底
    const podcastTitle = episode.podcastTitle ||
      (episode.podcast && episode.podcast.title) ||
      (episode.podcast && episode.podcast.name) || '远路英语';
    const fallbackCover = episode.coverUrl || episode.podcastCoverUrl ||
      (episode.podcast && episode.podcast.coverUrl);
    const playlist = [
      episode,
      ...relatedEpisodes.map((ep) => ({
        ...ep,
        podcastTitle: ep.podcastTitle ||
          (ep.podcast && ep.podcast.title) ||
          (ep.podcast && ep.podcast.name) || podcastTitle,
        coverUrl: ep.coverUrl || ep.podcastCoverUrl ||
          (ep.podcast && ep.podcast.coverUrl) || fallbackCover,
      })),
    ];
    // 「开始精听」是精听入口：置位精听标记（迷你条「精听」标签/面板「精听中」角标），
    // 对齐 Android PlayerController.play(episode, intensive = true)
    audioManager.playEpisode(episode, { playlist, intensive: true }); // 无 audioUrl 时 manager 内部解析签名直链
  },

  /** 精听深链：practice=true 进入时自动起播精听（相关剧集就绪后调用，列表完整） */
  _maybeAutoPractice() {
    if (!this.data.autoPractice) return;
    this.setData({ autoPractice: false });
    const episode = this.data.episode;
    if (!episode) return;
    const current = audioManager.getState().currentEpisode;
    if (current && current.episodeid === episode.episodeid) {
      // 已在播本集（如携带会话从面板进入）：仅补精听标记，不打断播放
      audioManager.setIntensiveMode(true);
      return;
    }
    this.onStartListening();
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

  // ==================== 标题 / 节目介绍翻译（对齐 Web 端真实链路） ====================
  // Android 端 Episode 模型不含中文翻译字段，翻译是登录用户的按次操作：
  // Web 端 ShowNotes.tsx / useEpisodeSummarize.ts 均调用有道翻译代理
  // POST /api/dictionary/youdao { word: 原文 }，成功返回 { definition: 中文翻译 }。

  /**
   * 调用有道翻译代理，resolve 中文译文（失败 resolve null 并自行提示）。
   * 403 配额超限（code=DICTIONARY_QUOTA_EXCEEDED）对齐 Web handleDictionaryQuotaBlock：
   * toast 后端配额文案 + 拉起会员转化弹窗。
   */
  translateText(text) {
    return post('/api/dictionary/youdao', { word: text }, { showError: false })
      .then((data) => {
        const definition = data && data.definition;
        if (!definition) {
          wx.showToast({ title: '翻译失败，请稍后重试', icon: 'none' });
          return null;
        }
        return definition;
      })
      .catch((err) => {
        const body = err && err.body;
        if (body && body.code === 'DICTIONARY_QUOTA_EXCEEDED') {
          wx.showToast({
            title: body.message || '今日免费词典查询次数已用完',
            icon: 'none',
            duration: 2500,
          });
          this.setData({ showPremiumModal: true });
        } else {
          // 401「登录已过期」等已由 request 层全局提示，这里兜底其余网络/服务错误
          wx.showToast({ title: (err && err.message) || '翻译请求出错', icon: 'none' });
        }
        return null;
      });
  },

  onTranslateTitle() {
    if (!this.data.isLoggedIn) {
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    if (this.data.translatedTitle) {
      // 再次点击收起译文（对齐 Web toggle），标题区随 wx:if 隐藏译文行
      this.setData({ translatedTitle: null });
      return;
    }
    if (this.data.isTranslatingTitle) return; // 防重入

    const title = this.data.episode && this.data.episode.title;
    if (!title) return; // 判空降级：无标题不发请求，译文区不渲染

    this.setData({ isTranslatingTitle: true });
    this.translateText(title).then((translatedTitle) => {
      this.setData({ isTranslatingTitle: false, translatedTitle: translatedTitle || null });
    });
  },

  onTranslateDescription() {
    if (!this.data.isLoggedIn) {
      return wx.navigateTo({ url: '/pages/auth/index' });
    }
    if (this.data.translatedDesc) {
      this.setData({ translatedDesc: null });
      return;
    }
    if (this.data.isTranslatingDesc) return; // 防重入

    const description = this.data.episode && this.data.episode.description;
    if (!description) return; // 判空降级：无介绍不发请求，展示区维持「暂无介绍」兜底

    this.setData({ isTranslatingDesc: true });
    this.translateText(description).then((translatedDesc) => {
      this.setData({ isTranslatingDesc: false, translatedDesc: translatedDesc || null });
    });
  },

  onPremiumModalClose() {
    this.setData({ showPremiumModal: false });
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
