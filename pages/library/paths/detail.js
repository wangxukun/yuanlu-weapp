/**
 * pages/library/paths/detail.js — 「学习路径」详情页
 *
 * 严格复刻 Web 端 /library/learning-paths/[id] 移动端（LearningPathDetailClient）：
 * 沉浸式主色头部（封面/公开标签/标题/描述/创建者·集数 + Map 水印）→ 上叠操作栏
 * （播放全部/随机播放；拥有者额外 添加剧集 + 更多菜单〔编辑/删除/分享〕）→
 * 剧集列表（序号/16:9 封面〔PRO 角标+细进度条〕/标题/播客名·时长；拥有者可移除）。
 * 权限条件渲染：isOwner = detail.userid === 当前登录用户（对齐 Web userid 比对）。
 *
 * API（对齐 Android LearningPathDetailViewModel，后端为 Web service 的 REST 包装）：
 *   GET    /api/learning-paths/{pathid}                 详情（含签名封面/音频+收听态）
 *   POST   /api/learning-paths/{pathid}                 编辑（wx.request 无 PATCH，走 POST 别名）
 *   DELETE /api/learning-paths/{pathid}                 删除（级联清 items）
 *   POST   /api/learning-paths/{pathid}/episodes        添加剧集（重复=200+success:false）
 *   DELETE /api/learning-paths/{pathid}/episodes/{itemId}
 *   GET    /api/episode/search-for-path?query=          添加弹窗搜索（500ms 防抖）
 */

const theme = require('../../../utils/theme');
const audioBus = require('../../../utils/audio-bus');
const audioManager = require('../../../utils/audioManager');
const { get, post, delete: del } = require('../../../utils/request');
const authStore = require('../../../store/authStore');

const SEARCH_DEBOUNCE_MS = 500;

/** "M:SS"（对齐 Web formatDuration / Android formatMillis） */
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m + ':' + String(ss).padStart(2, '0');
}

/** 已听完或按进度换算的封面进度条百分比（对齐 Web 移动端口径） */
function episodeProgressPercent(episode) {
  if (episode.isFinished) return 100;
  const duration = Number(episode.duration) || 0;
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((Number(episode.progressSeconds) || 0) / duration) * 100)));
}

/** 详情 DTO → 展示模型（items 已按 order 升序返回） */
function mapDetail(raw, currentUserId) {
  const d = raw || {};
  const items = (d.items || []).map((item) => {
    const ep = item.episode || {};
    const podcastTitle = (ep.podcast && ep.podcast.title) || '';
    return {
      itemId: item.id,
      episodeid: item.episodeid || ep.episodeid || '',
      title: ep.title || '',
      coverUrl: ep.coverUrl || '',
      audioUrl: ep.audioUrl || '',
      podcastTitle,
      isExclusive: !!ep.isExclusive,
      isFinished: !!ep.isFinished,
      progressSeconds: Math.round(Number(ep.progressSeconds) || 0),
      duration: Number(ep.duration) || 0,
      durationText: formatDuration(ep.duration),
      progressPercent: episodeProgressPercent(ep),
    };
  });
  return {
    pathid: d.pathid,
    userid: d.userid || '',
    pathName: d.pathName || '',
    description: (d.description || '').trim(),
    isPublic: !!d.isPublic,
    coverUrl: d.coverUrl || '',
    creatorName: d.creatorName || '未知用户',
    itemCount: items.length,
    isOwner: !!d.userid && !!currentUserId && d.userid === currentUserId,
    items,
  };
}

/** 剧集条目 → audioManager 播放对象（playlist 全量传入供上下曲切换） */
function toPlayableEpisode(item) {
  return {
    episodeid: item.episodeid,
    title: item.title,
    podcastTitle: item.podcastTitle || '远路英语',
    coverUrl: item.coverUrl,
    audioUrl: item.audioUrl,
    duration: item.duration,
    progressSeconds: item.progressSeconds,
    isFinished: item.isFinished,
  };
}

Page({
  data: {
    themeClass: '',
    dark: false,
    pathId: 0,
    // ---- 加载态 ----
    isLoading: true,
    error: '',
    needLogin: false,
    detail: null,
    // ---- 会员态（专属剧集过滤 + 播放拦截） ----
    isPremium: false,
    // ---- 更多菜单 ----
    showMoreMenu: false,
    // ---- 编辑弹窗 ----
    showEditDialog: false,
    editName: '',
    editDesc: '',
    editPublic: false,
    isSaving: false,
    // ---- 添加剧集弹窗 ----
    showAddDialog: false,
    addQuery: '',
    addResults: [], // [{episodeid,title,author,thumbnailUrl,durationText,added}]
    isSearching: false,
    // ---- 删除 / 移除在途 ----
    isMutating: false,
    // ---- 会员转化弹窗（专属剧集拦截） ----
    showPremiumModal: false,
    premiumSource: '',
    premiumVars: null,
  },

  onLoad(options) {
    const id = Number(options && options.id);
    this.setData({ pathId: Number.isInteger(id) && id > 0 ? id : 0 });
    this._loadedPathId = null;
    this._searchTimer = null;
    this._searchSeq = 0;
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();

    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, error: '' });
      return;
    }
    // 会员态：role 缓存 + subscription/status 校正（专属剧集过滤口径）
    this.syncMembership();
    if (this._loadedPathId !== this.data.pathId && this.data.pathId > 0) {
      this.fetch(this.data.pathId, { showLoading: true });
    }
  },

  onUnload() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  onHide() {
    // 菜单/弹窗随页面隐藏收起
    if (this.data.showMoreMenu) this.setData({ showMoreMenu: false });
  },

  onRetry() {
    this.setData({ isLoading: true, error: '', needLogin: false });
    this.fetch(this.data.pathId, { showLoading: false });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  // ==================== 会员判定（对齐 ai-deep-dive 的校正口径） ====================

  syncMembership() {
    const state = authStore.getState();
    const role = (state.userInfo && state.userInfo.role) || '';
    this.setData({ isPremium: role === 'PREMIUM' || role === 'ADMIN' });
    get('/api/user/subscription/status', undefined, { showError: false })
      .then((res) => {
        if (res && res.role) {
          this.setData({ isPremium: res.role === 'PREMIUM' || res.role === 'ADMIN' });
        }
      })
      .catch(() => {});
  },

  openPremium(source, vars) {
    this.setData({ showPremiumModal: true, premiumSource: source, premiumVars: vars || null });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },

  /** 弹窗卡片冒泡拦截（catchtap 空串等于未绑定，会透传到遮罩关闭） */
  noop() {},

  // ==================== 数据获取（对齐 LearningPathDetailViewModel.load） ====================

  async fetch(pathId, opts = {}) {
    const showLoading = opts.showLoading !== false;
    try {
      const res = await get('/api/learning-paths/' + pathId, undefined, {
        showError: showLoading ? undefined : false,
      });
      const userInfo = authStore.getState().userInfo || {};
      this._loadedPathId = pathId;
      this.setData({
        isLoading: false,
        error: '',
        needLogin: false,
        detail: mapDetail(res && res.data, userInfo.userid),
      });
      // 添加弹窗开着时同步一次 added 标记
      if (this.data.showAddDialog) this.remarkAdded();
    } catch (err) {
      this.setData({
        isLoading: false,
        error: (err && err.message) || '路径加载失败',
      });
    }
  },

  /** 变更后重拉详情（保持弹窗等本地态不重置，对齐 reload()） */
  reloadSilent() {
    if (!this._loadedPathId) return Promise.resolve();
    return this.fetch(this._loadedPathId, { showLoading: false }).then(() => {
      this.markPathsDirty();
    });
  },

  /** 通知列表页静默刷新（对齐 Android LearningPathCenter.notifyChanged） */
  markPathsDirty() {
    getApp().globalData.pathsDirty = true;
  },

  /** 依据当前详情重算搜索结果的 added 标记 */
  remarkAdded() {
    const detail = this.data.detail;
    const added = {};
    (detail && detail.items ? detail.items : []).forEach((it) => {
      added[it.episodeid] = true;
    });
    this.setData({
      addResults: this.data.addResults.map((r) => Object.assign({}, r, { added: !!added[r.episodeid] })),
    });
  },

  // ==================== 播放（对齐 Web handlePlayAll + Android buildPlayQueue） ====================

  /** 过滤专属剧集构建可播队列（PREMIUM/ADMIN 放行，对齐 hasExclusivePermission） */
  buildPlayableQueue() {
    const items = (this.data.detail && this.data.detail.items) || [];
    const hasPermission = this.data.isPremium;
    const queue = items.filter((it) => !(it.isExclusive && !hasPermission)).map(toPlayableEpisode);
    return { queue, skipped: items.length - queue.length };
  },

  playAll(shuffle) {
    const items = (this.data.detail && this.data.detail.items) || [];
    if (items.length === 0) return;
    const { queue, skipped } = this.buildPlayableQueue();
    if (queue.length === 0) {
      // 全部为专属且无权限：触发拦截承接（对齐 Web checkExclusivePlay 兜底）
      this.openPremium('exclusive_play');
      return;
    }
    if (skipped > 0) {
      wx.showToast({ title: '已跳过 ' + skipped + ' 个专属剧集', icon: 'none' });
    }
    let playlist = queue;
    if (shuffle) playlist = queue.slice().sort(() => Math.random() - 0.5);
    audioBus.stopAll(); // 停 TTS / 复习原声片段，防双声
    audioManager.playEpisode(playlist[0], { playlist });
  },

  onPlayAll() {
    this.playAll(false);
  },

  onShuffle() {
    this.playAll(true);
  },

  /** 剧集行点击：专属拦截 → 直接起播（对齐 Web onPlayEpisode） */
  onPlayEpisode(e) {
    const episodeid = e.currentTarget.dataset.id;
    const item = (this.data.detail && this.data.detail.items || []).find(
      (it) => it.episodeid === episodeid
    );
    if (!item) return;
    if (item.isExclusive) {
      if (!this.data.isPremium) {
        this.openPremium('exclusive_play');
        return;
      }
    }
    const { queue } = this.buildPlayableQueue();
    audioBus.stopAll();
    audioManager.playEpisode(toPlayableEpisode(item), { playlist: queue });
  },

  // ==================== 更多菜单（编辑 / 删除 / 分享） ====================

  onToggleMoreMenu() {
    this.setData({ showMoreMenu: !this.data.showMoreMenu });
  },

  onCloseMoreMenu() {
    this.setData({ showMoreMenu: false });
  },

  onShare() {
    this.onCloseMoreMenu();
    const pathid = this.data.detail && this.data.detail.pathid;
    if (!pathid) return;
    // Web 分享=复制链接；移动端复制 Web 落地页地址（对齐 Android sharePathLink）
    wx.setClipboardData({
      data: 'https://www.wxkzd.com/library/learning-paths/' + pathid,
      success: () => wx.showToast({ title: '路径链接地址已复制', icon: 'none' }),
    });
  },

  // ==================== 编辑路径（对齐 Web handleOpenEdit / handleUpdatePath） ====================

  onOpenEdit() {
    this.onCloseMoreMenu();
    const d = this.data.detail;
    if (!d) return;
    this.setData({
      showEditDialog: true,
      editName: d.pathName,
      editDesc: d.description,
      editPublic: d.isPublic,
    });
  },

  onEditName(e) {
    this.setData({ editName: e.detail.value });
  },
  onEditDesc(e) {
    this.setData({ editDesc: e.detail.value });
  },
  onToggleEditPublic() {
    this.setData({ editPublic: !this.data.editPublic });
  },
  onCloseEditDialog() {
    if (this.data.isSaving) return;
    this.setData({ showEditDialog: false });
  },

  /** 提交编辑：POST /api/learning-paths/{id}（后端 PATCH 的 POST 别名） */
  async onSubmitEdit() {
    if (this.data.isSaving) return;
    const name = this.data.editName.trim();
    if (!name) {
      wx.showToast({ title: '请输入路径名称', icon: 'none' });
      return;
    }
    this.setData({ isSaving: true });
    try {
      await post('/api/learning-paths/' + this.data.pathId, {
        pathName: name,
        description: this.data.editDesc.trim() || null,
        isPublic: this.data.editPublic,
      });
      this.setData({ isSaving: false, showEditDialog: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.reloadSilent();
    } catch (err) {
      this.setData({ isSaving: false });
      // 错误文案 request.js 已全局 toast
    }
  },

  // ==================== 删除路径（对齐 Web handleDeletePath） ====================

  onDeletePath() {
    this.onCloseMoreMenu();
    const d = this.data.detail;
    if (!d || this.data.isMutating) return;
    wx.showModal({
      title: '删除学习路径',
      content: '确定删除「' + d.pathName + '」吗？该操作无法撤销。',
      confirmColor: '#e0403f',
      confirmText: '删除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this.doDeletePath();
      },
    });
  },

  async doDeletePath() {
    if (this.data.isMutating) return;
    this.setData({ isMutating: true });
    try {
      await del('/api/learning-paths/' + this.data.pathId);
      this.setData({ isMutating: false });
      this.markPathsDirty();
      wx.navigateBack();
    } catch (err) {
      this.setData({ isMutating: false });
    }
  },

  // ==================== 添加剧集弹窗（对齐 Web Add Episode Modal） ====================

  onOpenAddDialog() {
    // 打开即清搜索态，下次从干净状态开始（对齐 setAddDialogOpen）
    this.setData({ showAddDialog: true, addQuery: '', addResults: [], isSearching: false });
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  onCloseAddDialog() {
    this.setData({ showAddDialog: false });
    if (this._searchTimer) clearTimeout(this._searchTimer);
  },

  /** 搜索输入：500ms 防抖（对齐 Web useDebounce / Android updateSearchQuery） */
  onAddQuery(e) {
    const query = e.detail.value;
    this.setData({ addQuery: query });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    const trimmed = query.trim();
    if (!trimmed) {
      this.setData({ addResults: [], isSearching: false });
      return;
    }
    this._searchTimer = setTimeout(() => this.searchEpisodes(trimmed), SEARCH_DEBOUNCE_MS);
  },

  async searchEpisodes(query) {
    const seq = ++this._searchSeq;
    this.setData({ isSearching: true });
    try {
      const res = await get(
        '/api/episode/search-for-path?query=' + encodeURIComponent(query),
        undefined,
        { showError: false }
      );
      if (seq !== this._searchSeq) return; // 过期响应丢弃
      const added = {};
      ((this.data.detail && this.data.detail.items) || []).forEach((it) => {
        added[it.episodeid] = true;
      });
      const results = ((res && res.data) || []).map((r) => ({
        episodeid: r.id,
        title: r.title || '',
        author: r.author || '未知播客',
        thumbnailUrl: r.thumbnailUrl || '',
        durationText: formatDuration(r.duration),
        added: !!added[r.id],
      }));
      this.setData({ isSearching: false, addResults: results });
    } catch (err) {
      if (seq !== this._searchSeq) return;
      this.setData({ isSearching: false });
    }
  },

  /** 添加剧集到路径末尾（客户端先去重置灰，对齐 Web handleAddEpisode） */
  async onAddEpisode(e) {
    const episodeid = e.currentTarget.dataset.id;
    if (!episodeid) return;
    const detail = this.data.detail;
    if (detail && detail.items.some((it) => it.episodeid === episodeid)) {
      wx.showToast({ title: '该剧集已在列表中', icon: 'none' });
      return;
    }
    try {
      const res = await post('/api/learning-paths/' + this.data.pathId + '/episodes', { episodeid });
      if (res && res.success === false) {
        // 业务失败（如已在列表中）直接 toast message
        wx.showToast({ title: res.message || '添加失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已添加到路径', icon: 'success' });
      this.reloadSilent();
    } catch (err) {
      // 403/400 等由 request.js 全局 toast
    }
  },

  // ==================== 移除剧集（对齐 Web handleRemoveItem + Android 确认弹窗） ====================

  onRemoveEpisode(e) {
    const itemId = Number(e.currentTarget.dataset.item);
    const episodeid = e.currentTarget.dataset.ep;
    const item = (this.data.detail && this.data.detail.items || []).find(
      (it) => it.episodeid === episodeid
    );
    if (!item || this.data.isMutating) return;
    wx.showModal({
      title: '移除剧集',
      content: '确定从播放列表中移除「' + item.title + '」吗？',
      confirmColor: '#e0403f',
      confirmText: '移除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        this.doRemoveEpisode(item.itemId);
      },
    });
  },

  async doRemoveEpisode(itemId) {
    if (this.data.isMutating) return;
    this.setData({ isMutating: true });
    try {
      await del('/api/learning-paths/' + this.data.pathId + '/episodes/' + itemId);
      this.setData({ isMutating: false });
      wx.showToast({ title: '已从路径移除', icon: 'none' });
      this.reloadSilent();
    } catch (err) {
      this.setData({ isMutating: false });
    }
  },
});
