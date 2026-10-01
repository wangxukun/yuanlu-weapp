const theme = require('../../utils/theme');
const { get, post, delete: requestDelete } = require('../../utils/request');
const { BASE_URL } = require('../../utils/config');
const { trackEvent } = require('../../utils/track');
const authStore = require('../../store/authStore');
const audioManager = require('../../utils/audioManager');
const audioBus = require('../../utils/audio-bus');
const membershipStore = require('../../store/membershipStore');
const downloadManager = require('../../utils/download-manager');

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
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

    // 会员态（DOWNLOAD-TASK T1.2）：membershipStore 唯一事实来源，
    // 下载/文稿门禁分流（T1.3）与后续阶段共用
    isPremium: false,
    
    // Translated notes
    translatedDesc: null,
    isTranslatingDesc: false,
    translatedTitle: null,
    isTranslatingTitle: false,

    // 词典/翻译配额超限时的会员转化弹窗（对齐 Web openPremiumModal("dictionary_quota")）
    showPremiumModal: false,
    // 弹窗场景源（T1.3：下载门禁复用弹窗，episode_audio_download；词典配额默认场景）
    premiumSource: 'dictionary_quota',

    // 非会员文稿预览弹层（T1.4：对齐 Web 非会员点文稿 = 预览 5 句 + 拦截卡转化）
    showTranscriptPreview: false,
    transcriptPreview: null,

    // 会员文稿 PDF 在途标记（T2.1：在途双击防抖；T2.2 补按钮视觉态）
    isGeneratingPdf: false,

    // 音频离线缓存按钮三态（T3.3）：idle 未下载 / downloading 进度 / downloaded 已缓存
    audioDlState: 'idle',
    audioDlProgress: 0,
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
      // 会员态重同步（订阅购买返回/登录登出换页返回时收敛）
      this._syncMembership();
      // 离线缓存态重同步（LRU 驱逐/其他页面删除后收敛；下载中态不被冲掉）
      this._syncDlState();
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

    // 离线缓存事件订阅（T3.3：progress/downloaded/error/removed/cleared 驱动按钮三态；
    // 他集事件忽略，LRU 驱逐本集或全局清空即时收敛）
    this._onDlEvent = (e) => this._handleDlEvent(e);
    this._unsubDl = downloadManager.subscribe(this._onDlEvent);

    this._syncMembership();
    this.fetchData();
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
    if (this._unsubDl) {
      this._unsubDl();
      this._unsubDl = null;
    }
    if (this._onPlayerEvent) {
      ['play', 'pause', 'stop', 'ended', 'waiting', 'episodeChange', 'modeChange', 'seek', 'error'].forEach(
        (evt) => audioManager.off(evt, this._onPlayerEvent)
      );
    }
  },

  onPullDownRefresh() {
    this.fetchData().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 会员态同步（DOWNLOAD-TASK T1.2）：membershipStore 是唯一事实来源，
   * 本页不自调订阅状态接口（ai-deep-dive 旧做法不复制）。
   * role 展示缓存可能滞后（纯移动端付费用户 role 仍是 USER），
   * ensureFresh 权威校正后收敛；登出/换号由 store→authStore 联动复位，
   * onShow 重入时重新同步。
   */
  _syncMembership() {
    membershipStore.ensureFresh().then(() => {
      const { isPremium } = membershipStore.getState();
      if (isPremium !== this.data.isPremium) this.setData({ isPremium });
    });
  },

  /** 单例回退换集刷新（utils/route.singletonNavigateTo 回退/命中本页实例时
   *  调用；同集 no-op，避免无谓重载闪烁） */
  singletonReload(query) {
    const id = query && query.id;
    if (!id || String(id) === String(this.data.episodeid)) return;
    this.setData({ episodeid: id });
    this.fetchData();
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
      // 单例回退换集（singletonReload）后缓存态跟随新 episodeid 收敛
      this._syncDlState();

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
    // 语音评测页（复刻 Android SpeechEvalScreen：单句录音 → 有道 ISE 评测 → 逐词/音素诊断）
    wx.navigateTo({ url: '/pages/speech-eval/index?id=' + this.data.episodeid });
  },

  /** 音频下载门禁（T1.3，对齐 Web handleDownloadAudio :144-185）：
   *  未登录 → toast（不跳页）；非会员 → premium-modal episode_audio_download；
   *  会员 → 离线缓存三态分流（T3.3）：idle 发起 / downloading 在途 / downloaded 管理菜单。 */
  onDownloadAudio() {
    if (!this.data.isLoggedIn) {
      return wx.showToast({ title: '音频下载仅对会员开放', icon: 'none' });
    }
    if (!this.data.isPremium) {
      this.setData({ showPremiumModal: true, premiumSource: 'episode_audio_download' });
      return;
    }
    if (this.data.audioDlState === 'downloaded') {
      this._showAudioDlSheet();
      return;
    }
    if (this.data.audioDlState === 'downloading') return; // 在途（dm 并发去重兜底）
    this._downloadAudio();
  },

  /** 发起离线缓存下载（状态由 download-manager 事件流驱动） */
  _downloadAudio() {
    const episode = this.data.episode;
    if (!episode || !episode.episodeid) return;
    this.setData({ audioDlState: 'downloading', audioDlProgress: 0 });
    downloadManager.download(episode)
      .then(() => wx.showToast({ title: '已可离线播放', icon: 'none' }))
      .catch((err) => {
        // 状态复位由 error 事件统一驱动，这里只提示
        wx.showToast({ title: (err && err.message) || '下载失败，请稍后重试', icon: 'none' });
      });
  },

  /** 已下载态管理菜单（T3.3 UI 决策：action sheet；T4.1 增「发送给好友」，T4.2 PC 端增「保存到电脑」） */
  _showAudioDlSheet() {
    const episodeid = this.data.episodeid;
    const canDisk = this._canSaveToDisk();
    const items = ['播放', '重新下载', '发送给好友'];
    if (canDisk) items.push('保存到电脑');
    items.push('删除离线缓存');
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const idx = res.tapIndex;
        if (idx === 0) {
          this.onStartListening();
        } else if (idx === 1) {
          // 缓存命中会短路 download，须先删再下
          downloadManager.remove(episodeid);
          this._downloadAudio();
        } else if (idx === 2) {
          this._shareAudio();
        } else if (canDisk && idx === 3) {
          this._saveAudioToDisk();
        } else {
          // 删除离线缓存（末项）
          downloadManager.remove(episodeid); // removed 事件驱动回 idle
          wx.showToast({ title: '已删除离线缓存', icon: 'none' });
        }
      },
    });
  },

  /**
   * saveFileToDisk 可用性（T4.2）：仅 PC 端微信。canIUse 对「已定义但仅 PC 可用」
   * 的 API 在手机上可能误报真，叠加 platform（windows/mac）双保险；任何异常视为不可用。
   */
  _canSaveToDisk() {
    try {
      if (!wx.canIUse || !wx.canIUse('saveFileToDisk')) return false;
      const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
      return info.platform === 'windows' || info.platform === 'mac';
    } catch (e) {
      return false;
    }
  },

  /**
   * 保存音频到电脑磁盘（T4.2，仅 PC 端微信；菜单项由 _canSaveToDisk 控制）。
   * 无 10MB 分享限制（saveFileToDisk 是大文件的导出通道）；未缓存先静默补下
   * （与 _shareAudio 同兜底）；取消保存静默不算失败。
   */
  _saveAudioToDisk() {
    const episode = this.data.episode;
    const episodeid = this.data.episodeid;
    if (!episode || !episodeid) return;

    const save = (filePath) => {
      wx.saveFileToDisk({
        filePath,
        success: () => wx.showToast({ title: '已保存到电脑', icon: 'none' }),
        fail: (err) => {
          const msg = (err && err.errMsg) || '';
          if (msg.indexOf('cancel') === -1) {
            wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' });
          }
        },
      });
    };

    const cached = downloadManager.getCachedPath(episodeid);
    if (cached) {
      save(cached);
      return;
    }
    wx.showToast({ title: '正在准备文件...', icon: 'none' });
    downloadManager.download(episode)
      .then(save)
      .catch((err) => wx.showToast({ title: (err && err.message) || '文件准备失败', icon: 'none' }));
  },

  /**
   * 音频文件导出发送（T4.1）：取离线缓存文件 → wx.shareFileMessage 发给聊天
   * （好友/文件传输助手由系统分享面板选择）。单文件 ≤10MB 硬限（官方 API 限制，
   * 附录 B 第 1 条：25 分钟级整集会超限），超限降级文案不发；
   * 未缓存先经 download-manager 静默补下（菜单打开瞬间被 LRU 驱逐的极端兜底）；
   * 取消分享（errMsg 含 cancel）不算失败不提示。
   */
  _shareAudio() {
    const episode = this.data.episode;
    const episodeid = this.data.episodeid;
    if (!episode || !episodeid) return;

    const share = (filePath) => {
      const entry = downloadManager.getEntry(episodeid) || {};
      if ((entry.size || 0) > 10 * 1024 * 1024) {
        return wx.showToast({ title: '文件较大，暂不支持直接发送', icon: 'none' });
      }
      const ext = (filePath.split('.').pop() || 'm4a').toLowerCase();
      wx.shareFileMessage({
        filePath,
        fileName: `${episode.title || '远路播客'}.${ext}`,
        fail: (err) => {
          const msg = (err && err.errMsg) || '';
          if (msg.indexOf('cancel') === -1) {
            wx.showToast({ title: '发送失败，请稍后重试', icon: 'none' });
          }
        },
      });
    };

    const cached = downloadManager.getCachedPath(episodeid);
    if (cached) {
      share(cached);
      return;
    }
    wx.showToast({ title: '正在准备文件...', icon: 'none' });
    downloadManager.download(episode)
      .then(share)
      .catch((err) => wx.showToast({ title: (err && err.message) || '文件准备失败', icon: 'none' }));
  },

  /** 离线缓存事件 → 本页按钮三态（他集事件忽略；cleared 全局收敛） */
  _handleDlEvent(e) {
    if (e.type === 'cleared') {
      this._syncDlState();
      return;
    }
    if (!e.episodeid || e.episodeid !== this.data.episodeid) return;
    if (e.type === 'progress') {
      this.setData({ audioDlState: 'downloading', audioDlProgress: Math.round(e.progress) || 0 });
    } else if (e.type === 'retry') {
      this.setData({ audioDlState: 'downloading' });
    } else if (e.type === 'downloaded') {
      this.setData({ audioDlState: 'downloaded', audioDlProgress: 100 });
    } else if (e.type === 'error' || e.type === 'removed') {
      // 失败/被删（LRU/其他页面）：按缓存实况收敛
      this.setData({ audioDlState: this._cachedDlState() });
    }
  },

  _cachedDlState() {
    return downloadManager.getCachedPath(this.data.episodeid) ? 'downloaded' : 'idle';
  },

  /** 缓存态同步（onShow/fetchData）：下载中态不被误清 */
  _syncDlState() {
    if (downloadManager.getCachedPath(this.data.episodeid)) {
      if (this.data.audioDlState !== 'downloaded') this.setData({ audioDlState: 'downloaded' });
    } else if (this.data.audioDlState !== 'downloading') {
      this.setData({ audioDlState: 'idle', audioDlProgress: 0 });
    }
  },

  /** 文稿下载门禁（T1.4，对齐 Web handleDownloadTranscript :187-252）：
   *  未登录 → toast；非会员 → 预览弹层（非直接弹会员窗，Web 同源）；
   *  会员 → PDF 下载与打开（T2.1）。 */
  onTranscript() {
    if (!this.data.isLoggedIn) {
      return wx.showToast({ title: '文稿下载仅对会员开放', icon: 'none' });
    }
    if (!this.data.isPremium) {
      this._openTranscriptPreview();
      return;
    }
    this._downloadTranscriptPdf();
  },

  /**
   * 会员文稿 PDF 下载与打开（T2.1，对齐 Web handleDownloadTranscript 会员分支 :216-241）。
   * transcript-pdf 是鉴权接口，wx.downloadFile 不走 request.js 出口 → 手动注入 Bearer；
   * 恒 A5（Web 以 innerWidth<768 判手机，小程序恒手机口径）；成功 → openDocument
   * （showMenu 开右上角转发/保存，iOS 可存「文件」App）。
   * 非 2xx 的错误体是 JSON 流、downloadFile 不便解析，按 statusCode 映射后端
   * route 既有文案（与 Web 展示的服务端 error 逐字一致）；401 对齐 request.js
   * 全局口径（清 token + 重登提示）。
   */
  _downloadTranscriptPdf() {
    if (this.data.isGeneratingPdf) return; // 在途双击防抖
    this.setData({ isGeneratingPdf: true });
    wx.showToast({ title: '正在生成文稿 PDF，请稍候...', icon: 'none' });
    trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'start', { episodeid: this.data.episodeid });

    const token = authStore.getState().token || wx.getStorageSync('token') || '';
    wx.downloadFile({
      url: `${BASE_URL}/api/episode/transcript-pdf?episodeid=${this.data.episodeid}&format=A5`,
      header: { Authorization: `Bearer ${token}` },
      success: (res) => {
        if (res.statusCode === 200) {
          trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'success', { episodeid: this.data.episodeid });
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'pdf',
            showMenu: true,
            success: () => wx.showToast({ title: '文稿已打开', icon: 'none' }),
            fail: () => {
              trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_open', { episodeid: this.data.episodeid });
              wx.showToast({ title: '文稿打开失败', icon: 'none' });
            },
          });
        } else if (res.statusCode === 401) {
          trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_401', { episodeid: this.data.episodeid });
          wx.removeStorageSync('token');
          wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
        } else if (res.statusCode === 403) {
          trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_403', { episodeid: this.data.episodeid });
          wx.showToast({ title: '权限不足，需要高级会员权限', icon: 'none' });
        } else if (res.statusCode === 404) {
          trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_404', { episodeid: this.data.episodeid });
          wx.showToast({ title: '未找到字幕数据，无法生成文稿', icon: 'none' });
        } else {
          trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_server', { episodeid: this.data.episodeid });
          wx.showToast({ title: '文稿生成失败', icon: 'none' });
        }
      },
      fail: () => {
        trackEvent('TRANSCRIPT_PDF_DOWNLOAD', 'fail_network', { episodeid: this.data.episodeid });
        wx.showToast({ title: '文稿下载失败，请稍后重试', icon: 'none' });
      },
      complete: () => {
        this.setData({ isGeneratingPdf: false });
      },
    });
  },

  /**
   * 拉取非会员文稿预览并开弹层（对齐 Web 非会员分支：GET transcript-preview
   * 失败静默、弹层照开走「暂无预览数据」空态，不阻断转化路径）
   */
  _openTranscriptPreview() {
    get(`/api/episode/transcript-preview?episodeid=${this.data.episodeid}`, null, { showError: false })
      .catch(() => null)
      .then((body) => {
        this.setData({
          transcriptPreview: (body && body.data) || null,
          showTranscriptPreview: true,
        });
      });
  },

  onTranscriptPreviewClose() {
    this.setData({ showTranscriptPreview: false });
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
          this.setData({ showPremiumModal: true, premiumSource: 'dictionary_quota' });
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
