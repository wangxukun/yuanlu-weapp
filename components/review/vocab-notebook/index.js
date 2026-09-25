/**
 * components/review/vocab-notebook — 生词本根视图
 * 复刻 Android feature/vocabulary/VocabularyScreen.kt（WordItemCard +
 * ExpandedWordDetail 最新设计）：
 *
 * - 数据：active 首次激活拉 GET /api/vocabulary/all；页面 onShow 经 refreshSeq
 *   通知轻刷新（保留旧列表直到新数据到达）
 * - 统计三格（总计/待复习/已掌握）+ SRS 复习横幅/全部完成卡 + quota-card 配额双栏卡
 * - 筛选栏：状态 pill（学习中/已掌握）+ 搜索 + 三排序
 * - 卡片紧凑面：单词(titleLarge ExtraBold) + 音标胶囊预览 + FSRS 状态点 +
 *   释义 + 原声引文 + 5 格熟练度竖条 + 已掌握/需要复习/下次复习徽章 + 箭头
 * - 展开面板（对齐 Android，例句/词形变化/短语搭配/扩展词汇已移除）：
 *   US/UK 音标胶囊发音 · 核心释义卡 · 原声出处卡（词高亮）· 词源记忆卡 ·
 *   操作栏（标记已掌握↔重新学习 flex:1 主钮 + 彻底删除常显二次确认）
 * - 删除：wx.showModal 确认 → POST /api/vocabulary/delete → 本地列表/统计刷新
 * - 发音：词典直链 tts.playUrl(url, word)（失败自动 TTS 合成兜底）
 * - TTS 配额触墙（dictionary_quota）统一 premium-modal（本组件自持 visible）
 */
const vocabCore = require('../../../utils/vocab-core');
const { get, post } = require('../../../utils/request');
const membershipStore = require('../../../store/membershipStore');
const tts = require('../../../utils/tts');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 当前 Tab 激活（首次激活懒加载，之后激活轻刷新） */
    active: { type: Boolean, value: false },
    /** 宿主页面 onShow 递增序号：通知组件刷新（从复习页返回时同步数据） */
    refreshSeq: { type: Number, value: 0 },
  },

  data: {
    loading: true,
    loaded: false,
    stats: { total: 0, due: 0, mastered: 0 },
    todayAddedCount: 0,
    isPremium: false,
    quota: { primaryStatusText: '', dailyStatusText: '' },
    vocabLimit: vocabCore.FREE_VOCABULARY_LIMIT,
    dailyLimit: vocabCore.FREE_VOCABULARY_DAILY_LIMIT,

    searchQuery: '',
    sortMethod: 'review',
    filterStatus: 'LEARNING',
    filteredList: [],
    expandedId: null,
    scrollInto: '',

    showPremiumModal: false,
    premiumSource: '',

    // 外观（横幅/分段 Tab/图标双态）
    themeClass: '',
    dark: false,
  },

  lifetimes: {
    attached() {
      this._list = []; // 原始 VocabularyItem[]（filteredList 的数据源）
      // TTS 配额触墙 → premium-modal（intensive-listening 页同款模式）；
      // active 变化时重注册，覆盖其他页面注册的 handler（全局单值槽位）
      this._quotaHandler = (source) => {
        this.setData({ showPremiumModal: true, premiumSource: source });
      };
      this._syncTheme();
      if (this.data.active) {
        this.registerQuotaHandler();
        this.loadData();
      }
    },
    detached() {
      // 释放 TTS 配额槽位（复习页 tabBar 常驻，此清理仅在页面卸载时发生）
      tts.setQuotaHandler(null);
    },
  },

  observers: {
    active(v) {
      if (v) {
        this.registerQuotaHandler();
        if (this.data.loaded) this.refresh();
        else this.loadData();
      }
    },
    refreshSeq() {
      this._syncTheme(); // 每次回到生词本同步外观（用户可能在别处切换主题）
      if (this.data.active && this.data.loaded) this.refresh();
    },
  },

  methods: {
    registerQuotaHandler() {
      tts.setQuotaHandler(this._quotaHandler);
    },

    /** 外观根类（手动覆盖）+ 生效深色（横幅/按钮图标变体切换） */
    _syncTheme() {
      this.setData({ themeClass: theme.rootClass(), dark: theme.getEffective() === 'dark' });
    },

    /* ---------------- 数据加载 ---------------- */

    loadData() {
      this.setData({ loading: true });
      this.refresh();
    },

    /** 轻刷新：保留旧列表，新数据到达后整体替换（对齐 Web SSR 重进页面） */
    async refresh() {
      this._loadingNew = true;
      try {
        const res = await get('/api/vocabulary/all');
        const list = (res && res.success && res.data) || [];
        this._list = list;
        this.applyDerived();
        membershipStore.ensureFresh().then(() => {
          const { isPremium } = membershipStore.getState();
          if (isPremium !== this.data.isPremium) {
            this.setData({ isPremium });
          }
        });
      } catch (err) {
        // request.js 已统一 toast；保持旧数据（若有）
      } finally {
        this._loadingNew = false;
        if (this.data.loading) this.setData({ loading: false });
        this.setData({ loaded: true });
      }
    },

    /** 由原始列表派生 stats/today/quota/filteredList 并落 data */
    applyDerived() {
      const list = this._list;
      const stats = vocabCore.deriveStats(list);
      const today = vocabCore.todayAddedCount(list);
      const quota = vocabCore.quotaTexts(stats.total, today);
      const { isPremium } = membershipStore.getState();
      this.setData({
        stats,
        todayAddedCount: today,
        quota,
        isPremium,
        loading: false,
        loaded: true,
        filteredList: this.computeFilteredList(),
      });
    },

    computeFilteredList() {
      return vocabCore
        .filterAndSort(this._list, {
          status: this.data.filterStatus,
          query: this.data.searchQuery,
          sort: this.data.sortMethod,
        })
        .map(vocabCore.decorateItem)
        .map((it) => Object.assign({}, it, {
          // 紧凑面音标胶囊预览：US 优先 UK 兜底（Android phoneticsUs ?: phoneticsUk）
          phonPreview: (it.dictData && it.dictData.phonetics &&
            (it.dictData.phonetics.us || it.dictData.phonetics.uk)) || '',
        }));
    },

    reapplyFilter() {
      this.setData({ filteredList: this.computeFilteredList() });
    },

    /* ---------------- 筛选栏 ---------------- */

    onFilterTap(e) {
      const status = e.currentTarget.dataset.status;
      if (status && status !== this.data.filterStatus) {
        this.setData({ filterStatus: status, expandedId: null });
        this.reapplyFilter();
      }
    },

    onSearchInput(e) {
      const value = e.detail.value || '';
      this.setData({ searchQuery: value });
      this.reapplyFilter();
    },

    onClearSearch() {
      this.setData({ searchQuery: '' });
      this.reapplyFilter();
    },

    onSortTap(e) {
      const sort = e.currentTarget.dataset.sort;
      if (sort && sort !== this.data.sortMethod) {
        this.setData({ sortMethod: sort });
        this.reapplyFilter();
      }
    },

    /* ---------------- 卡片展开（单开手风琴） ---------------- */

    onCardTap(e) {
      const id = Number(e.currentTarget.dataset.id);
      const expanding = this.data.expandedId !== id;
      const next = expanding ? id : null;
      this.setData({ expandedId: next });
      if (expanding) {
        // 展开后滚回卡片顶部（对齐 Web 的滚动补偿；scroll-into-view 在
        // 渲染下一帧生效）
        setTimeout(() => {
          this.setData({ scrollInto: 'vn-top-' + id });
          setTimeout(() => this.setData({ scrollInto: '' }), 400);
        }, 60);
      }
    },

    /* ---------------- 发音 ---------------- */

    findItem(id) {
      return this._list.find((v) => v.vocabularyid === Number(id));
    },

    /** 紧凑面发音钮：词典直链 + TTS 兜底 */
    onPlayWord(e) {
      const id = e.currentTarget.dataset.id;
      const item = this.findItem(id);
      if (!item) return;
      const url =
        (item.dictData &&
          item.dictData.audio_urls &&
          (item.dictData.audio_urls.us || item.dictData.audio_urls.uk)) ||
        item.speakUrl ||
        '';
      tts.playUrl(url, item.word);
    },

    /** 展开面板音标胶囊发音（指定英/美音源） */
    onPlayPhon(e) {
      const { url, word } = e.currentTarget.dataset;
      tts.playUrl(url, word);
    },

    /* ---------------- 卡片操作 ---------------- */

    /** 标记已掌握 ↔ 重新学习（乐观翻转 + 失败回滚，对齐 Web toggleStatus） */
    async onToggleStatus(e) {
      const id = Number(e.currentTarget.dataset.id);
      const item = this.findItem(id);
      if (!item) return;
      const newStatus = item.status === 'MASTERED' ? 'LEARNING' : 'MASTERED';
      // 乐观更新
      item.status = newStatus;
      this.applyDerived();
      try {
        const res = await post('/api/vocabulary/status', {
          vocabularyid: id,
          status: newStatus,
        });
        if (res && res.success) {
          wx.showToast({ title: res.message || '操作成功', icon: 'none' });
        } else {
          throw new Error((res && res.message) || '操作失败');
        }
      } catch (err) {
        // 回滚（request.js 已 toast 失败文案）
        item.status = newStatus === 'MASTERED' ? 'LEARNING' : 'MASTERED';
        this.applyDerived();
      }
    },

    /** 彻底删除（常显；二次确认文案对齐 Android AlertDialog） */
    async onDeleteTap(e) {
      const id = Number(e.currentTarget.dataset.id);
      const item = this.findItem(id);
      if (!item) return;
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '确定要彻底删除该生词吗？',
          content: '「' + item.word + '」将被永久移出生词本，此操作不可恢复。',
          confirmText: '确定删除',
          confirmColor: '#D2503F',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
      try {
        const res = await post('/api/vocabulary/delete', { vocabularyid: id });
        if (res && res.success) {
          this._list = this._list.filter((v) => v.vocabularyid !== id);
          if (this.data.expandedId === id) this.setData({ expandedId: null });
          this.applyDerived();
          wx.showToast({ title: '已从生词本中彻底删除', icon: 'none' });
        } else {
          throw new Error((res && res.message) || '删除失败');
        }
      } catch (err) {
        // request.js 已 toast
      }
    },

    /* ---------------- 复习与导航 ---------------- */

    onStartReview() {
      wx.navigateTo({ url: '/pages/review/vocab-review/index' });
    },

    onGoDiscover() {
      wx.switchTab({ url: '/pages/discover/index' });
    },

    onModalClose() {
      this.setData({ showPremiumModal: false });
    },

    /** 展开面板冒泡阻断（WXML catchtap 占位） */
    noop() {},
  },
});
