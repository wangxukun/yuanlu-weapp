/**
 * pages/library/paths/detail.js — 「学习路径」详情页
 *
 * 严格复刻 Web 端 /library/learning-paths/[id] 移动端（LearningPathDetailClient）：
 * 沉浸式主色头部（封面/公开标签/标题/描述/创建者·集数 + Map 水印）→ 上叠操作栏
 * （播放全部/随机播放；拥有者额外 添加剧集 + 更多菜单〔编辑/删除/分享〕）→
 * 剧集列表（序号/16:9 封面〔PRO 角标+细进度条〕/标题/专栏名·时长；拥有者可移除）。
 * 权限条件渲染：isOwner = detail.userid === 当前登录用户（对齐 Web userid 比对）。
 *
 * API（对齐 Android LearningPathDetailViewModel，后端为 Web service 的 REST 包装）：
 *   GET    /api/learning-paths/{pathid}                 详情（含签名封面/音频+收听态）
 *   POST   /api/learning-paths/{pathid}                 编辑（wx.request 无 PATCH，走 POST 别名）
 *   DELETE /api/learning-paths/{pathid}                 删除（级联清 items）
 *   DELETE /api/learning-paths/{pathid}/episodes/{itemId}
 *
 * [RESHAPE T3.2] 蒙太奇卡册：条目携带 clip（/api/studio/generate 产物）时
 * 渲染「策展人手记 + 原声切片卡流」（批注/微播放/跟读/捕词入口）；普通
 * 路径保持剧集行。「添加剧集搜索」随合规重塑（红线 1）整体移除。
 */

const theme = require('../../../utils/theme');
const { get, post, delete: del } = require('../../../utils/request');
const authStore = require('../../../store/authStore');


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

/** 蒙太奇原声卡 → 展示模型（WXML 零方法调用：时长/序号预格式化） */
function mapClipCard(item, index) {
  const clip = item.clip || {};
  return {
    kind: 'clip',
    no: index + 1,
    itemId: item.id,
    clipid: clip.clipid || '',
    episodeid: item.episodeid || '',
    enText: clip.enText || '',
    zhText: clip.zhText || '',
    note: item.clipNote || '',
    question: item.clipQuestion || '',
    coverUrl: clip.coverUrl || (item.episode && item.episode.coverUrl) || '',
    sourceLabel: clip.sourceLabel || '',
    cefrLabel: clip.cefrLevel || '',
    wpm: clip.wpm || 0,
    durLabel: (Number(clip.duration) || 0).toFixed(1) + 's',
    startTime: Number(clip.startTime) || 0,
    endTime: Number(clip.endTime) || 0,
  };
}

/** 详情 DTO → 展示模型（items 已按 order 升序返回；
 *  携带 clip 的条目（心愿卡册）渲染为蒙太奇原声卡流，其余保持剧集行） */
function mapDetail(raw, currentUserId) {
  const d = raw || {};
  const items = (d.items || []).map((item, idx) => {
    if (item.clip) return mapClipCard(item, idx);
    const ep = item.episode || {};
    const podcastTitle = (ep.podcast && ep.podcast.title) || '';
    return {
      kind: 'episode',
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
  const clipCount = items.filter((it) => it.kind === 'clip').length;
  return {
    pathid: d.pathid,
    userid: d.userid || '',
    pathName: d.pathName || '',
    description: (d.description || '').trim(),
    isPublic: !!d.isPublic,
    coverUrl: d.coverUrl || '',
    creatorName: d.creatorName || '未知用户',
    itemCount: items.length,
    // 蒙太奇卡册（心愿定制产物）：条目过半为原声切片时切换卡册形态
    isMontage: clipCount > 0 && clipCount >= Math.ceil(items.length / 2),
    curatorIntro: (d.description || '').trim(),
    isOwner: !!d.userid && !!currentUserId && d.userid === currentUserId,
    items,
  };
}

/** 剧集条目 → 精研页跳参（原全局播放器播放对象已随整集链路退役） */
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

  // ==================== 逐条精研（原「播放全部/随机」整集连播已随合规重塑退役） ====================

  /** 过滤专属剧集构建可研队列（PREMIUM/ADMIN 放行，对齐 hasExclusivePermission） */
  buildPlayableQueue() {
    const items = (this.data.detail && this.data.detail.items) || [];
    const hasPermission = this.data.isPremium;
    const queue = items.filter((it) => !(it.isExclusive && !hasPermission)).map(toPlayableEpisode);
    return { queue, skipped: items.length - queue.length };
  },

  /** 「开始精研」：从头一条可研条目进入原声精研页（原播放全部） */
  playAll() {
    const items = (this.data.detail && this.data.detail.items) || [];
    if (items.length === 0) return;
    const { queue } = this.buildPlayableQueue();
    if (queue.length === 0) {
      // 全部为专属且无权限：触发拦截承接（对齐 Web checkExclusivePlay 兜底）
      this.openPremium('exclusive_play');
      return;
    }
    wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + queue[0].episodeid });
  },

  onPlayAll() {
    this.playAll(false);
  },

  // ==================== 蒙太奇原声卡（心愿卡册，T3.2） ====================

  /** 整卡点击 → 原声精研页（点睛批注旁的原文语境） */
  onClipCardTap(e) {
    const episodeid = e.currentTarget.dataset.ep;
    if (episodeid) wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + episodeid });
  },

  /** 一键跟读 → 语音评测页（原声跟读多维评分） */
  onClipShadow(e) {
    const episodeid = e.currentTarget.dataset.ep;
    if (episodeid) wx.navigateTo({ url: '/pages/speech-eval/index?id=' + episodeid });
  },

  /** 盲听捕词 → 原声精研页听写模式（盲听捕词闯关） */
  onClipDictation(e) {
    const episodeid = e.currentTarget.dataset.ep;
    if (episodeid) wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + episodeid + '&mode=dictate' });
  },

  /** 剧集行点击：专属拦截 → 进入原声精研页（原直接起播） */
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
    wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + episodeid });
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
