/**
 * pages/library/paths/detail.js — 「特训卡册」详情页
 *
 * [RESHAPE T3.2 + 2026-11-05 合规收敛] 心愿卡册（蒙太奇）详情：策展人手记 +
 * 原声切片卡流（批注/微播放/跟读/捕词入口）。「开始精研/整卡/跟读/捕词」全部
 * 走 by-clip 反查微剧场（?sceneId= 精研室/评测室，红线 2 零整集链路）——
 * 未命中回落卡片内微播放器提示，绝不回落 ?id= 剧集模式。
 * 网页版创建的存量「学习路径」（条目无 clip）不再渲染剧集列表（红线 1），
 * 以提示卡承接：完整内容请到网页版打开（小程序不分发整集列表）。
 *
 * API（对齐 Android LearningPathDetailViewModel，后端为 Web service 的 REST 包装）：
 *   GET    /api/learning-paths/{pathid}                 详情（含签名封面/音频+收听态）
 *   POST   /api/learning-paths/{pathid}                 编辑（wx.request 无 PATCH，走 POST 别名）
 *   DELETE /api/learning-paths/{pathid}                 删除（级联清 items）
 *   GET    /api/scenes/by-clip?episodeid=&t=            切片 → 微剧场反查（2026-11-05 主路径）
 */

const theme = require('../../../utils/theme');
const { get, post, delete: del } = require('../../../utils/request');
const authStore = require('../../../store/authStore');


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

/** 详情 DTO → 展示模型（items 已按 order 升序返回；仅条目携带 clip 的
 *  心愿卡册渲染切片卡流；存量网页版路径（零 clip 条目）转 legacy 提示态） */
function mapDetail(raw, currentUserId) {
  const d = raw || {};
  const rawItems = d.items || [];
  const items = rawItems.filter((item) => item && item.clip).map(mapClipCard);
  const isMontage = items.length > 0;
  return {
    pathid: d.pathid,
    userid: d.userid || '',
    pathName: d.pathName || '',
    description: (d.description || '').trim(),
    isPublic: !!d.isPublic,
    coverUrl: d.coverUrl || '',
    creatorName: d.creatorName || '未知用户',
    itemCount: items.length,
    itemCountRaw: rawItems.length,
    metaText: isMontage
      ? items.length + ' 张原声卡'
      : rawItems.length > 0
        ? rawItems.length + ' 个条目 · 网页版创建'
        : '空卡册',
    isMontage,
    isLegacy: !isMontage && rawItems.length > 0,
    curatorIntro: (d.description || '').trim(),
    isOwner: !!d.userid && !!currentUserId && d.userid === currentUserId,
    items,
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
    // ---- 更多菜单 ----
    showMoreMenu: false,
    // ---- 编辑弹窗 ----
    showEditDialog: false,
    editName: '',
    editDesc: '',
    editPublic: false,
    isSaving: false,
    // ---- 删除在途 ----
    isMutating: false,
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

  // ==================== 开始精研（蒙太奇卡册 · 微剧场直达） ====================

  /** 「开始精研」：从第一张原声卡进入微剧场精研室（原整集连播已随合规重塑退役） */
  onPlayAll() {
    const items = (this.data.detail && this.data.detail.items) || [];
    if (items.length === 0) return;
    this._openClipScene(items[0], 'read');
  },

  // ==================== 蒙太奇原声卡（心愿卡册，T3.2） ====================

  /**
   * 切片 → 微剧场反查（2026-11-05 合规收敛）：by-clip?episodeid=&t=startTime
   * 命中 ?sceneId= 直达（精研室/评测室/听写模式），未命中/异常 → 卡内微播放器
   * 提示（该 API 对未收录切片回同集最近微剧场，仅零场景剧集才落空）。
   */
  _openClipScene(item, intent) {
    const episodeid = item.episodeid;
    if (!episodeid) {
      wx.showToast({ title: '这条切片缺少出处信息', icon: 'none' });
      return;
    }
    const params = ['episodeid=' + encodeURIComponent(episodeid)];
    const t = Number(item.startTime);
    if (Number.isFinite(t) && t > 0) params.push('t=' + t);
    get('/api/scenes/by-clip?' + params.join('&'), null, { showError: false })
      .then((body) => {
        const sceneid = body && body.success && body.data && body.data.sceneid;
        if (!sceneid) {
          wx.showToast({ title: '这段暂未编排成微剧场，可先在卡片上试听', icon: 'none' });
          return;
        }
        if (intent === 'shadow') {
          wx.navigateTo({ url: '/pages/speech-eval/index?sceneId=' + sceneid });
        } else {
          const dictate = intent === 'dictate' ? '&mode=dictate' : '';
          wx.navigateTo({
            url: '/pages/intensive-listening/index?sceneId=' + sceneid + dictate,
          });
        }
      })
      .catch(() => {
        wx.showToast({ title: '这段暂未编排成微剧场，可先在卡片上试听', icon: 'none' });
      });
  },

  _findClipCard(dataset) {
    const clipid = dataset.clip;
    return ((this.data.detail && this.data.detail.items) || []).find(
      (it) => it.clipid && it.clipid === clipid
    );
  },

  /** 整卡点击 → 微剧场精研室（点睛批注旁的完整语境） */
  onClipCardTap(e) {
    const item = this._findClipCard(e.currentTarget.dataset);
    if (item) this._openClipScene(item, 'read');
  },

  /** 一键跟读 → 微剧场评测室（原声跟读多维评分） */
  onClipShadow(e) {
    const item = this._findClipCard(e.currentTarget.dataset);
    if (item) this._openClipScene(item, 'shadow');
  },

  /** 盲听捕词 → 微剧场精研室听写模式（盲听捕词闯关） */
  onClipDictation(e) {
    const item = this._findClipCard(e.currentTarget.dataset);
    if (item) this._openClipScene(item, 'dictate');
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
});
