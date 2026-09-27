/**
 * components/review/sentence-notebook — 句子本根视图
 * 复刻 Web app/(main)/library/sentences/SentenceNotebook.tsx。
 *
 * T2.1（数据接入与生词高亮联动）：
 * - 数据：active 首次激活并发拉 GET /api/sentences/list（全量，服务端
 *   createAt desc）+ GET /api/vocabulary/all（{word, definition} 高亮联动集）
 *   + GET /api/speech/quota?scenario=review（评测日池，展示口径 min(used,5)
 *   封顶不泄露 buffer）；页面 onShow 经 refreshSeq 轻刷新（对齐 vocab-notebook）
 * - 联动词汇：filterLinkedVocabWords（\b 词边界 × 句子交集，小写去重）；
 *   高亮只喂联动词（对齐 Web vocab-highlight-store 只喂真实出现在句子中的词）
 * - 失败口径：request.js 已统一 toast，保持旧数据；vocab/quota 子请求失败
 *   不拖垮主列表（高亮/日池各自降级）
 *
 * T2.2（统计 + 配额 + 搜索筛选根视图）：
 * - 统计三格（关键句/联动词汇/分类标签，count>0 才渲染，文案逐字对齐
 *   Web SentenceStats）+ 复习横幅（卡片复习已就绪 → pages/review/deck）
 * - quota-card 双栏（句子本容量 N/30 三态梯度内聚组件 + 今日复习评测 N/5，
 *   PRO 无限态「PRO 无限收藏 · 已收 N 句」）
 * - 搜索四路匹配（enText/zhText/note/tags 小写 substring）+ 剧集筛选
 *   （picker，客户端派生）+ 标签 pills（含计数 + 清除筛选）+ 视图切换
 *   （卡片详情 / 简洁清单）；筛选空态与全局空态严格区分（Web 双空态同款）
 *
 * T2.3（句子卡片 + 微播放器 + 标签抽屉）：
 * - 卡片：衬线原句 + meta（出处胶囊→剧集详情 / indigo 标签）+ 底栏整行居右
 *   （sentence-micro-player + 跟读/编辑/删除裸图标）+「查看中文翻译 & 笔记」
 *   折叠（灰底展开区：参考译文/暂无翻译 + 笔记白卡或「+ 添加你的第一条学习笔记」）
 * - 简洁清单：右列微播放器 + 操作图标；meta 行补时间切片/#标签/笔记摘要
 * - 删除两段式（wx.showModal 文案逐字）→ POST /api/sentences/delete → 本地过滤
 * - 编辑复用 components/sentence-tag-drawer（精听页同款）；updated → tags/note 本地同步
 */
const sentenceCore = require('../../../utils/sentence-core');
const { get, post } = require('../../../utils/request');
const membershipStore = require('../../../store/membershipStore');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 当前 Tab 激活（首次激活懒加载，之后激活轻刷新） */
    active: { type: Boolean, value: false },
    /** 宿主页面 onShow 递增序号：通知组件刷新（从子页返回时同步数据） */
    refreshSeq: { type: Number, value: 0 },
  },

  data: {
    loading: true,
    loaded: false,
    // 统计三格（Web SentenceStats props 口径）
    stats: { sentenceCount: 0, vocabCount: 0, tagCount: 0 },
    // WXML 就绪列表（decorateSentence：enParts 高亮段等；未筛选时 = filteredList）
    list: [],
    // 评测日池展示口径（未加载 used=null → 文案 …）
    evalQuota: { used: null, limit: sentenceCore.FREE_REVIEW_EVALUATIONS_PER_DAY },
    isPremium: false,
    // quota-card 双栏文案（quotaTexts 逐字）
    quota: { primaryStatusText: '', dailyStatusText: '…' },
    sentenceLimit: sentenceCore.FREE_SENTENCE_LIMIT,

    // ── 筛选与视图（T2.2；语义与 Web filteredList 一致，逻辑在 sentence-core）──
    searchQuery: '',
    filterEpisode: 'ALL', // episodeid 或 'ALL'（Web 哨兵同款）
    filterTag: 'ALL',
    viewMode: 'cards', // cards = 卡片详情 / compact = 简洁清单
    tagCloud: [], // [{name, count}] 首见序
    episodeNames: [], // picker range：[全部播客来源 (N), ...剧集名]
    episodeIdx: 0,
    hasFilter: false,
    filteredList: [],

    // ── 卡片交互（T2.3）：折叠展开 / 标签抽屉 ──
    expandedId: null,
    editSentence: null,

    // 视图切换图标（JS 预计算：选中/深色变体随 viewMode 与 dark 变化）
    viewCardsSrc: '/assets/icons/grid-view-gray.svg',
    viewCompactSrc: '/assets/icons/list-gray.svg',

    // 外观（图标深色变体）
    themeClass: '',
    dark: false,
  },

  lifetimes: {
    attached() {
      this._sentences = []; // 原始 SavedSentenceItem[]
      this._vocabWords = []; // {word, definition}[]（生词本联动集，未过滤）
      this._linkedWords = []; // 联动词汇（真实出现在句子中的词）
      this._episodeValues = ['ALL']; // picker 索引 → episodeid 映射（首项 ALL 哨兵）
      this._syncTheme();
      if (this.data.active) {
        this.loadData();
      }
    },
  },

  observers: {
    active(v) {
      if (v) {
        if (this.data.loaded) this.refresh();
        else this.loadData();
      }
    },
    refreshSeq() {
      this._syncTheme();
      if (this.data.active && this.data.loaded) this.refresh();
    },
  },

  methods: {
    /** 外观根类（手动覆盖令牌；跟随系统返回空类走媒体查询）+ 生效深色（图标变体） */
    _syncTheme() {
      this.setData({
        themeClass: theme.rootClass(),
        dark: theme.getEffective() === 'dark',
      });
      this._syncViewIcons();
    },

    /** 视图切换图标变体：选中 = 墨色（深色 = 浅墨），未选中 = 灰 */
    _syncViewIcons() {
      const on = this.data.dark
        ? { cards: '/assets/icons/grid-view-ink100.svg', compact: '/assets/icons/list-ink100.svg' }
        : { cards: '/assets/icons/grid-view-ink.svg', compact: '/assets/icons/list-ink.svg' };
      const off = { cards: '/assets/icons/grid-view-gray.svg', compact: '/assets/icons/list-gray.svg' };
      this.setData({
        viewCardsSrc: this.data.viewMode === 'cards' ? on.cards : off.cards,
        viewCompactSrc: this.data.viewMode === 'compact' ? on.compact : off.compact,
      });
    },

    /* ---------------- 数据加载 ---------------- */

    loadData() {
      this.setData({ loading: true });
      this.refresh();
    },

    /**
     * 轻刷新：三路并发（句子全量 / 生词本联动集 / 评测日池），保留旧数据
     * 直到新数据到达；子请求各自降级，互不拖垮（Web SSR 三路 Promise.all
     * 的小程序等价——但任何一路失败不清空其余两路）。
     */
    async refresh() {
      this._loadingNew = true;
      const [sentencesRes, vocabRes, quotaRes] = await Promise.all([
        get('/api/sentences/list').catch(() => null),
        get('/api/vocabulary/all').catch(() => null),
        get('/api/speech/quota?scenario=review').catch(() => null),
      ]);

      // 主列表：成功才替换，失败保持旧数据（request.js 已 toast）
      if (sentencesRes && sentencesRes.success && Array.isArray(sentencesRes.data)) {
        this._sentences = sentenceCore.parseSentences(sentencesRes);
      }

      // 联动集：失败不动（沿用上次，仅失去新词高亮，不影响句子列表）
      if (vocabRes && vocabRes.success && Array.isArray(vocabRes.data)) {
        this._vocabWords = vocabRes.data.map(function (v) {
          return { word: v.word, definition: v.definition || null };
        });
      }

      // 评测日池：失败沿用上次（初始未加载 used=null → 文案 …）
      if (quotaRes && quotaRes.success && quotaRes.data) {
        this.setData({ evalQuota: sentenceCore.evalQuotaView(quotaRes.data) });
      }

      // 联动词汇 = 生词本 × 句子的真实交集（统计与高亮共用同一口径）
      this._linkedWords = sentenceCore.filterLinkedVocabWords(
        this._vocabWords,
        this._sentences,
      );

      this.applyDerived();

      membershipStore.ensureFresh().then(() => {
        const { isPremium } = membershipStore.getState();
        if (isPremium !== this.data.isPremium) {
          this.setData({ isPremium });
        }
      });

      this._loadingNew = false;
    },

    /** 由原始数据派生 stats/配额/筛选候选/列表并落 data（刷新与筛选共用出口） */
    applyDerived() {
      const stats = sentenceCore.deriveStats(this._sentences, this._linkedWords);
      const quota = sentenceCore.quotaTexts(
        stats.sentenceCount,
        this.data.evalQuota.used,
        this.data.evalQuota.limit,
      );
      const cloud = sentenceCore.tagCloud(this._sentences);
      const episodes = sentenceCore.episodeOptions(this._sentences);
      // picker：首项 ALL 哨兵「全部播客来源 (N)」；索引 → episodeid 映射存 JS 侧
      this._episodeValues = ['ALL'].concat(episodes.map(function (e) { return e.value; }));
      const names = ['全部播客来源 (' + episodes.length + ')'].concat(
        episodes.map(function (e) { return e.label; }),
      );
      // 当前筛选若已失效（剧集被删）回落 ALL
      let filterEpisode = this.data.filterEpisode;
      if (this._episodeValues.indexOf(filterEpisode) < 0) filterEpisode = 'ALL';

      this.setData({
        stats,
        quota,
        tagCloud: cloud,
        episodeNames: names,
        filterEpisode,
        episodeIdx: this._episodeValues.indexOf(filterEpisode),
        loading: false,
        loaded: true,
        // 装饰后的 WXML 就绪列表（enParts 高亮段等）；筛选也基于它，
        // 保证 filteredList 条目同样带派生字段（卡片/简洁清单直接渲染）
        list: (this._decorated = this._sentences.map((s) =>
          sentenceCore.decorateSentence(s, this._linkedWords),
        )),
      });
      this.applyFilter();
    },

    /** 筛选/搜索变更 → filteredList + hasFilter（基于装饰列表，派生字段随行；逻辑在 sentence-core） */
    applyFilter() {
      const filteredList = sentenceCore.filterSentences(this._decorated || [], {
        query: this.data.searchQuery,
        episode: this.data.filterEpisode,
        tag: this.data.filterTag,
      });
      this.setData({
        filteredList,
        hasFilter:
          !!this.data.searchQuery ||
          this.data.filterEpisode !== 'ALL' ||
          this.data.filterTag !== 'ALL',
      });
    },

    /* ---------------- 筛选与视图交互（T2.2） ---------------- */

    onSearchInput(e) {
      this.setData({ searchQuery: e.detail.value });
      this.applyFilter();
    },

    onClearSearch() {
      this.setData({ searchQuery: '' });
      this.applyFilter();
    },

    /** 剧集筛选 picker（Web select 的等价控件；索引 → episodeid 走 JS 映射） */
    onEpisodeChange(e) {
      const idx = Number(e.detail.value) || 0;
      this.setData({
        episodeIdx: idx,
        filterEpisode: this._episodeValues[idx] || 'ALL',
      });
      this.applyFilter();
    },

    /** 标签 pill：全部（'ALL'）或具体标签（Web pill 点击即切换 filterTag） */
    onTagTap(e) {
      const tag = e.currentTarget.dataset.tag || 'ALL';
      if (tag !== this.data.filterTag) {
        this.setData({ filterTag: tag });
        this.applyFilter();
      }
    },

    /** 清除筛选（Web resetFilter：搜索/剧集/标签一并复位） */
    onClearFilter() {
      this.setData({
        searchQuery: '',
        filterEpisode: 'ALL',
        filterTag: 'ALL',
        episodeIdx: 0,
      });
      this.applyFilter();
    },

    onViewTap(e) {
      const mode = e.currentTarget.dataset.view;
      if (mode && mode !== this.data.viewMode) {
        this.setData({ viewMode: mode });
        this._syncViewIcons();
      }
    },

    /* ---------------- 卡片操作坞（T2.3） ---------------- */

    /** meta 出处胶囊 → 剧集详情页（Web Link /episode/{episodeid}） */
    onEpisodeTap(e) {
      const id = e.currentTarget.dataset.episodeid;
      if (id) wx.navigateTo({ url: '/pages/episode/episode?id=' + id });
    },

    /** 影子跟读：subtitleId 缺失时禁用并提示（Web title 提示的小程序等价） */
    onShadowTap(e) {
      const ds = e.currentTarget.dataset;
      if (!ds.ok) {
        wx.showToast({ title: '该句缺少字幕定位信息，无法跟读', icon: 'none' });
        return;
      }
      wx.navigateTo({ url: '/pages/review/shadowing/index?id=' + ds.id });
    },

    /** 编辑标签与笔记 → quick-tag-drawer（sentence 非 null 即开） */
    onEditTap(e) {
      const id = Number(e.currentTarget.dataset.id);
      const item = this._decorated
        ? this._decorated.find((s) => s.id === id)
        : null;
      if (item) this.setData({ editSentence: item });
    },

    /** 删除两段式确认（Web DaisyUI modal 文案逐字）→ POST /api/sentences/delete */
    onDeleteTap(e) {
      const id = Number(e.currentTarget.dataset.id);
      const item = this._decorated
        ? this._decorated.find((s) => s.id === id)
        : null;
      if (!item) return;
      wx.showModal({
        title: '从句子本移除',
        content: '确定要移除这个句子吗？移除后需要重新收藏。',
        confirmText: '确认移除',
        cancelText: '取消',
        confirmColor: '#DC2626',
        success: (res) => {
          if (res.confirm) this.confirmDelete(item);
        },
      });
    },

    async confirmDelete(item) {
      try {
        const res = await post('/api/sentences/delete', { id: item.id });
        if (!(res && res.success)) return; // 失败 toast 由 request.js 统一
        this._sentences = this._sentences.filter((s) => s.id !== item.id);
        if (this.data.expandedId === item.id) this.setData({ expandedId: null });
        if (this.data.editSentence && this.data.editSentence.id === item.id) {
          this.setData({ editSentence: null });
        }
        this.applyDerived();
        wx.showToast({ title: '已从句子本中移除', icon: 'none' });
      } catch (err) {
        // request.js 已统一 toast，保持旧数据
      }
    },

    /** 折叠「查看中文翻译 & 笔记」（单开手风琴） */
    onToggleExpand(e) {
      const id = Number(e.currentTarget.dataset.id);
      this.setData({ expandedId: this.data.expandedId === id ? null : id });
    },

    /** 抽屉保存成功：本地同步 tags/note（对齐 Web onUpdated setSentences map） */
    onDrawerUpdated(e) {
      const { id, tags, note } = e.detail || {};
      this._sentences = this._sentences.map((s) =>
        s.id === id ? Object.assign({}, s, { tags: tags || [], note: note || null }) : s,
      );
      this.applyDerived();
      // 抽屉里编辑的可能正是展开卡——重新定位句对象（applyDerived 重建了 _decorated）
      if (this.data.expandedId === id) {
        const fresh = this._decorated.find((s) => s.id === id);
        if (fresh) this.setData({ editSentence: fresh });
      }
    },

    onDrawerClose() {
      this.setData({ editSentence: null });
    },

    /* ---------------- 横幅与空态 ---------------- */

    /** 复习横幅：卡片复习模式 → pages/review/deck（Web Link `${base}/review`） */
    onStartDeck() {
      wx.navigateTo({ url: '/pages/review/deck/index' });
    },

    /** 去发现页收藏句子（Web 空态 Link /discover 的小程序等价） */
    onGoDiscover() {
      wx.switchTab({ url: '/pages/discover/index' });
    },
  },
});
