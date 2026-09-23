/**
 * components/review/vocab-notebook — 生词本根视图
 * 复刻 Web 端 app/(main)/library/vocabulary（VocabularyNotebook + Stats +
 * Controls + List 移动端形态），REVIEW-TASK 阶段 1（T1.1–T1.4）：
 *
 * - 数据：active 首次激活拉 GET /api/vocabulary/all；页面 onShow 经 refreshSeq
 *   通知轻刷新（保留旧列表直到新数据到达，对齐 Web「返回时重拉」）
 * - 统计三格（总计/待复习/已掌握）+ SRS 复习横幅/全部完成卡 + quota-card
 *   配额双栏卡（免费 50 容量 + 今日 5 次；PRO 无限态）
 * - 筛选栏：状态 pill（学习中/已掌握）+ 搜索（word/translation）+ 三排序
 * - 卡片：紧凑面（due 脉冲点 + 词 + 释义 + 5 格熟练度竖条 + 日期徽章 +
 *   发音钮）+ 单开手风琴展开（scroll-into-view 滚动补偿）
 * - 展开面板：有 dictData 渲染富视图（US/UK 音标胶囊/核心释义/原声出处卡/
 *   字典例句/词形变化/词源记忆/短语搭配/同反义），否则旧版降级视图；
 *   底部操作：标记已掌握↔重新学习 / 彻底删除（仅 MASTERED）/ 复制词典链接
 * - 发音：词典直链 tts.playUrl(url, word)（失败自动 TTS 合成兜底）；
 *   例句朗读 tts.speak（toggle 高亮）；剧集原声 audio-clip（字幕对齐片段）
 * - TTS 配额触墙（dictionary_quota）统一 premium-modal（本组件自持 visible）
 */
const vocabCore = require('../../../utils/vocab-core');
const { get, post } = require('../../../utils/request');
const membershipStore = require('../../../store/membershipStore');
const tts = require('../../../utils/tts');
const audioClip = require('../../../utils/audio-clip');

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
    playText: '', // tts 播放中的例句文本（朗读钮高亮）
    origKey: '', // audio-clip 播放中的 key（原声钮高亮）
    origLoading: '',

    showPremiumModal: false,
    premiumSource: '',
  },

  lifetimes: {
    attached() {
      this._list = []; // 原始 VocabularyItem[]（filteredList 的数据源）
      this._unsubTts = tts.subscribe(() => this.syncAudioState());
      this._unsubClip = audioClip.subscribe(() => this.syncAudioState());
      // TTS 配额触墙 → premium-modal（intensive-listening 页同款模式）；
      // active 变化时重注册，覆盖其他页面注册的 handler（全局单值槽位）
      this._quotaHandler = (source) => {
        this.setData({ showPremiumModal: true, premiumSource: source });
      };
      if (this.data.active) {
        this.registerQuotaHandler();
        this.loadData();
      }
    },
    detached() {
      if (this._unsubTts) this._unsubTts();
      if (this._unsubClip) this._unsubClip();
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
      if (this.data.active && this.data.loaded) this.refresh();
    },
  },

  methods: {
    registerQuotaHandler() {
      tts.setQuotaHandler(this._quotaHandler);
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
        .map(vocabCore.decorateItem);
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

    /* ---------------- 发音与原声 ---------------- */

    syncAudioState() {
      const { playingText } = tts.getState();
      const { playingKey, loadingKey } = audioClip.getState();
      const patch = {};
      if (playingText !== this.data.playText) patch.playText = playingText || '';
      if ((playingKey || '') !== this.data.origKey) patch.origKey = playingKey || '';
      if ((loadingKey || '') !== this.data.origLoading) patch.origLoading = loadingKey || '';
      if (Object.keys(patch).length) this.setData(patch);
    },

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

    /** AI 朗读例句/上下文句（toggle 高亮） */
    onPlayContext(e) {
      const text = e.currentTarget.dataset.text;
      if (text) tts.speak(text);
    },

    /** 剧集原声片段（字幕对齐，audio-clip 定位） */
    onPlayOriginal(e) {
      const { episodeid, word, timestamp, context } = e.currentTarget.dataset;
      if (!episodeid) return;
      audioClip.play({
        key: episodeid + ':' + word,
        episodeid: String(episodeid),
        timestamp: timestamp ? Number(timestamp) : null,
        contextSentence: context || null,
        onBeforePlay: () => tts.stop(),
      });
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

    /** 彻底删除（仅 MASTERED 态显示；两段式确认，对齐 Web dialog） */
    async onDeleteTap(e) {
      const id = Number(e.currentTarget.dataset.id);
      const item = this.findItem(id);
      if (!item) return;
      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '确认彻底删除',
          content: '确定要彻底删除该生词吗？此操作不可恢复。',
          confirmText: '确定删除',
          confirmColor: '#DC2626',
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

    /** webUrl 外链词典 → 小程序无法开网页，复制链接（REVIEW-TASK 1.3 映射） */
    onCopyDict(e) {
      const url = e.currentTarget.dataset.url;
      if (!url) return;
      wx.setClipboardData({
        data: url,
        success: () =>
          wx.showToast({ title: '词典链接已复制', icon: 'none' }),
      });
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
