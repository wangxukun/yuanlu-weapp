/**
 * pages/library/paths/index.js — 「学习路径」列表页
 *
 * UI 复刻 Android 端 LearningPathsScreen.kt（横向卡片：左封面 PUBLIC 角标 +
 * 右标题/描述/进度/集数与创建者），顶部操作按钮区融合 Web 端 LearningPathsClient
 * 的双按钮设计（紫渐变「AI 生成路径」+ 主题绿「+ 创建新路径」；页面不再放大标题
 * 与副标题，标题由原生导航栏「学习路径」承担）。
 *
 * 数据逻辑（对齐 Android LearningPathsViewModel + Web LearningPathsClient）：
 *   - GET /api/learning-paths/mine    我的集合（含进度/签名封面/创建者）
 *   - GET /api/learning-paths/public  发现（排除自己的公开路径）
 *   两 Tab 并行拉取（对齐 Web Promise.all），Tab 切换为本地态切换不重拉；
 *   搜索为本地过滤（路径名忽略大小写包含）。
 *   - POST /api/learning-paths                 创建（免费配额 1 条，403=PATH_QUOTA_EXCEEDED）
 *   - POST /api/learning-paths/generate        AI 生成（PRO 专属，403=PREMIUM_REQUIRED；
 *                                              422/429/503=降级手动创建并预填主题）
 * 会员判定：role 展示缓存 + /api/user/subscription/status 校正（deriveDisplayRole 口径）。
 */

const theme = require('../../../utils/theme');
const { get, post } = require('../../../utils/request');
const authStore = require('../../../store/authStore');

/** 免费用户路径容量（对齐 Web lib/quota.ts FREE_PATH_LIMIT，双口径同源） */
const FREE_PATH_LIMIT = 1;

/** LearningPathSummaryDto → 展示模型（对齐 LearningPathSummaryDto.toDomain） */
function mapPath(raw) {
  const p = raw || {};
  const isOfficial = !!p.isOfficial;
  const isPublic = !!p.isPublic;
  return {
    pathid: p.pathid,
    pathName: p.pathName || '',
    description: (p.description || '').trim() || '暂无描述',
    coverUrl: p.coverUrl || '',
    isOfficial,
    isPublic,
    // 角标（对齐 Android：OFFICIAL 主色 / PUBLIC·PRIVATE 黑底 60%）
    badge: isOfficial ? 'OFFICIAL' : isPublic ? 'PUBLIC' : 'PRIVATE',
    badgeIcon: isOfficial || isPublic ? 'public' : 'lock',
    itemCountText: (Number(p.itemCount) || 0) + ' 集',
    creatorName: p.creatorName || '未知创建者',
    progress: Math.min(100, Math.max(0, Number(p.progress) || 0)),
  };
}

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    // ---- 加载态（对齐 LearningPathsUiState） ----
    isLoading: true,
    isRefreshing: false,
    error: '',
    needLogin: false,
    // ---- 双 Tab + 本地搜索 ----
    activeTab: 'mine', // 'mine' | 'discover'
    searchQuery: '',
    myPaths: [],
    publicPaths: [],
    displayPaths: [], // 渲染源：activeTab 列表经搜索过滤
    // ---- 会员态（AI 生成 / 配额墙判定） ----
    isPremium: false,
    // ---- 创建路径弹窗 ----
    showCreateDialog: false,
    formName: '',
    formDesc: '',
    formPublic: false,
    isSubmitting: false,
    // ---- AI 生成弹窗 ----
    showGenerateDialog: false,
    generateTopic: '',
    isGenerating: false,
    // ---- 会员转化弹窗 ----
    showPremiumModal: false,
    premiumSource: '',
    premiumVars: null,
  },

  onLoad() {
    this._loading = false;
    this._hasLoaded = false;
  },

  onShow() {
    // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();

    // 登录闸：未登录落在引导态（列表接口均需登录）
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, error: '' });
      this._hasLoaded = false;
      return;
    }
    // 会员态：role 展示缓存 + subscription/status 校正（P0-1 事实在订阅表）
    this.syncMembership();

    // 首载全量拉取；详情页变更（脏标记）返回后静默刷新，保留 Tab 与搜索词
    // （对齐 Android LearningPathCenter.revision 驱动的跨页静默刷新）
    if (!this._hasLoaded) this.fetch({ showLoading: true });
    else if (getApp().globalData.pathsDirty) {
      getApp().globalData.pathsDirty = false;
      this.fetch({ silent: true });
    }
  },

  onPullDownRefresh() {
    // 对齐 refresh()：静默重拉，失败保留旧数据仅提示
    this.fetch({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  // ==================== 数据获取（对齐 LearningPathsViewModel.load） ====================

  async fetch(opts = {}) {
    const showLoading = opts.showLoading !== false;
    const silent = !!opts.silent;
    if (this._loading) return;
    this._loading = true;
    if (showLoading) this.setData({ isLoading: true, error: '', needLogin: false });

    try {
      // 我的集合与发现并行拉取（对齐 Web Promise.all / Android async 双拉）
      const [mineRes, publicRes] = await Promise.all([
        get('/api/learning-paths/mine', undefined, { showError: silent ? false : undefined }),
        get('/api/learning-paths/public', undefined, { showError: silent ? false : undefined }),
      ]);
      this._hasLoaded = true;
      this.setData(
        {
          isLoading: false,
          isRefreshing: false,
          error: '',
          myPaths: ((mineRes && mineRes.data) || []).map(mapPath),
          publicPaths: ((publicRes && publicRes.data) || []).map(mapPath),
        },
        () => this.applyFilter()
      );
    } catch (err) {
      // 静默刷新失败保留旧数据仅提示（不打断浏览，对齐 Android silent 分支）
      if (silent) {
        this.setData({ isRefreshing: false });
        wx.showToast({ title: (err && err.message) || '刷新失败', icon: 'none' });
      } else {
        this.setData({
          isLoading: false,
          isRefreshing: false,
          error: (err && err.message) || '学习路径加载失败',
        });
      }
    } finally {
      this._loading = false;
    }
  },

  /** 变更后静默重拉（创建/生成成功后：保持弹窗外本地态） */
  reloadSilent() {
    return this.fetch({ silent: true });
  },

  /** Tab 切换 + 搜索词变更后重算渲染源（对齐 filteredPaths 派生） */
  applyFilter() {
    const source = this.data.activeTab === 'discover' ? this.data.publicPaths : this.data.myPaths;
    const q = this.data.searchQuery.trim().toLowerCase();
    const displayPaths = q
      ? source.filter((p) => p.pathName.toLowerCase().includes(q))
      : source.slice();
    this.setData({ displayPaths });
  },

  /** 切换「我的集合 / 发现」（对齐 selectTab：本地态切换，双列表已并行拉取） */
  onSelectTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab }, () => this.applyFilter());
  },

  onSearchInput(e) {
    this.setData({ searchQuery: e.detail.value }, () => this.applyFilter());
  },

  onClearSearch() {
    this.setData({ searchQuery: '' }, () => this.applyFilter());
  },

  onRetry() {
    this.setData({ isLoading: true, error: '' });
    this.fetch({ showLoading: false });
  },

  /** 登录态错误框的「去登录」 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  // ==================== 会员判定（对齐 ai-deep-dive 的校正口径） ====================

  syncMembership() {
    const state = authStore.getState();
    const role = (state.userInfo && state.userInfo.role) || '';
    this.setData({ isPremium: role === 'PREMIUM' || role === 'ADMIN' });
    // profile 的 role 是 DB 展示缓存，纯移动端付费用户可能滞后为 USER——
    // 用 subscription/status 的派生 role 校正锁态（口径与 Web 会话同步一致）
    get('/api/user/subscription/status', undefined, { showError: false })
      .then((res) => {
        if (res && res.role) {
          this.setData({ isPremium: res.role === 'PREMIUM' || res.role === 'ADMIN' });
        }
      })
      .catch(() => {});
  },

  /** 打开会员弹窗（对齐 Web openPremiumModal：场景承接 + 埋点内置） */
  openPremium(source, vars) {
    this.setData({ showPremiumModal: true, premiumSource: source, premiumVars: vars || null });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },

  /** 弹窗卡片冒泡拦截（catchtap 空串等于未绑定，会透传到遮罩关闭） */
  noop() {},

  // ==================== 创建新路径（对齐 Web handleCreateClick / handleCreatePath） ====================

  /** 「+ 创建新路径」：免费容量已满 → 配额墙弹窗承接（服务端仍兜底拦截） */
  onCreateClick() {
    if (!this.data.isPremium && this.data.myPaths.length >= FREE_PATH_LIMIT) {
      this.openPremium('path_quota', {
        limit: FREE_PATH_LIMIT,
        totalCount: this.data.myPaths.length,
      });
      return;
    }
    this.setData({ showCreateDialog: true, formName: '', formDesc: '', formPublic: false });
  },

  onFormName(e) {
    this.setData({ formName: e.detail.value });
  },
  onFormDesc(e) {
    this.setData({ formDesc: e.detail.value });
  },
  onToggleFormPublic() {
    this.setData({ formPublic: !this.data.formPublic });
  },
  onCloseCreateDialog() {
    if (this.data.isSubmitting) return;
    this.setData({ showCreateDialog: false });
  },

  /** 提交创建：POST /api/learning-paths（对齐 Android createPath + Web 表单） */
  async onSubmitCreate() {
    if (this.data.isSubmitting) return;
    const name = this.data.formName.trim();
    if (!name) {
      wx.showToast({ title: '请输入路径名称', icon: 'none' });
      return;
    }
    this.setData({ isSubmitting: true });
    try {
      const res = await post('/api/learning-paths', {
        pathName: name,
        description: this.data.formDesc.trim() || null,
        isPublic: this.data.formPublic,
      });
      this.setData({ isSubmitting: false });
      if (res && res.success) {
        this.setData({ showCreateDialog: false });
        wx.showToast({ title: '路径已创建', icon: 'success' });
        // 新路径落在「我的集合」语义（对齐 Android 创建后刷新）
        this.setData({ activeTab: 'mine' });
        this.reloadSilent();
      }
    } catch (err) {
      this.setData({ isSubmitting: false });
      // 并发/多端兜底：容量在打开弹窗后被占满（服务端拦截命中）
      if (err && err.code === 'PATH_QUOTA_EXCEEDED') {
        this.setData({ showCreateDialog: false });
        this.openPremium('path_quota', { totalCount: FREE_PATH_LIMIT });
      }
      // 其余错误 request.js 已全局 toast
    }
  },

  // ==================== AI 生成路径（对齐 Web handleGenerateClick / handleGenerate） ====================

  /** 「AI 生成路径」：PRO 专属（LLM 真实边际成本），免费用户弹窗承接 */
  onGenerateClick() {
    if (!this.data.isPremium) {
      this.openPremium('path_ai_generate');
      return;
    }
    this.setData({ showGenerateDialog: true, generateTopic: '' });
  },

  onGenerateTopic(e) {
    this.setData({ generateTopic: e.detail.value });
  },
  onCloseGenerateDialog() {
    if (this.data.isGenerating) return;
    this.setData({ showGenerateDialog: false });
  },

  /** 提交生成：POST /api/learning-paths/generate { topic } */
  async onSubmitGenerate() {
    if (this.data.isGenerating) return;
    const topic = this.data.generateTopic.trim();
    if (!topic) {
      wx.showToast({ title: '请先填写学习主题', icon: 'none' });
      return;
    }
    this.setData({ isGenerating: true });
    let fallbackToCreate = false;
    try {
      const res = await post('/api/learning-paths/generate', { topic }, { showError: false });
      if (res && res.success) {
        this.setData({ isGenerating: false, showGenerateDialog: false, generateTopic: '' });
        const data = res.data || {};
        wx.showToast({
          title: 'AI 已生成「' + (data.pathName || topic) + '」（' + (data.itemCount || 0) + ' 集）',
          icon: 'none',
        });
        this.setData({ activeTab: 'mine' });
        this.reloadSilent();
        return;
      }
      // 200 + success:false 的业务失败（走降级口径）
      wx.showToast({ title: (res && res.message) || 'AI 生成失败，已为你切换到手动创建', icon: 'none' });
      fallbackToCreate = true;
    } catch (err) {
      if (err && err.code === 'PREMIUM_REQUIRED') {
        // 会员态过期（SSR 缓存态与实时态的缝隙）：弹窗承接
        this.setData({ isGenerating: false, showGenerateDialog: false });
        this.openPremium('path_ai_generate');
        return;
      }
      // LLM 失败 / 无匹配 / 频率限制 / 网络异常：降级为手动创建（预填主题），不阻断
      wx.showToast({ title: (err && err.message) || 'AI 生成失败，已为你切换到手动创建', icon: 'none' });
      fallbackToCreate = true;
    }
    if (fallbackToCreate) {
      this.setData({
        isGenerating: false,
        showGenerateDialog: false,
        showCreateDialog: true,
        formName: topic.slice(0, 50),
        formDesc: '',
        formPublic: false,
      });
    }
  },

  // ==================== 跳转 ====================

  onOpenPath(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/library/paths/detail?id=' + id });
  },
});
