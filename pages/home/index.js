/**
 * pages/home/index — 远路语境词典 · 查词工具首页（工具化转型阶段一）
 *
 * 极致工具化（像背单词 App）：巨型查词/场景搜索框 + 灵感胶囊（静态池
 * 随机抽样、可刷新）+ 4 个纯工具入口（查词记录/生词本/发音笔记本/我的卡册）。
 * 用户不主动搜索（或不点灵感胶囊）→ 页面不展示任何播放内容（合规口径）。
 *
 * 搜索分流：
 *   - 英文单词/短语 → GET /api/dict/[word] → 词典弹层（真实语境例句为
 *     静态文本 + 【前往跟读】→ 训练室；弹层内零播放，隔离式结合）
 *   - 场景/中文意图 → GET /api/scenes/feed?q= → 语境句列表 → 训练室
 *
 * 登录态双通道同步（authStore.subscribe + onShow）与主题三段式沿用项目口径；
 * 游客可搜索（词典匿名限流/语境 feed 公开），保存生词与打卡问候需登录。
 */
const { get, post } = require('../../utils/request');
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const dictTool = require('../../utils/dict-tool');

const SUGGESTIONS_SHOW = 4;
/** 灵感胶囊静态池：查单词（词典直达）+ 场景（语境检索），数十条随机取样 */
const SUGGESTION_POOL = [
  { label: '#查单词: compromise', word: 'compromise' },
  { label: '#查单词: resilient', word: 'resilient' },
  { label: '#查单词: negotiate', word: 'negotiate' },
  { label: '#查单词: appreciate', word: 'appreciate' },
  { label: '#查单词: deadline', word: 'deadline' },
  { label: '#查单词: feedback', word: 'feedback' },
  { label: '#查单词: adventure', word: 'adventure' },
  { label: '#查单词: perspective', word: 'perspective' },
  { label: '#查单词: efficient', word: 'efficient' },
  { label: '#查单词: gorgeous', word: 'gorgeous' },
  { label: '#职场拒绝', scene: '职场' },
  { label: '#机场值机', scene: '机场' },
  { label: '#酒店入住', scene: '酒店' },
  { label: '#面试自我介绍', scene: '面试' },
  { label: '#点咖啡', scene: '咖啡' },
  { label: '#和医生描述症状', scene: '医生' },
  { label: '#表达歉意', scene: '道歉' },
  { label: '#安慰朋友', scene: '安慰' },
  { label: '#谈论天气', scene: '天气' },
  { label: '#购物比价', scene: '购物' },
  { label: '#问路指路', scene: '问路' },
  { label: '#电话预约', scene: '预约' },
  { label: '#连读发音技巧', scene: '连读' },
  { label: '#日常寒暄', scene: '寒暄' },
  { label: '#旅行计划', scene: '旅行' },
  { label: '#健身运动', scene: '健身' },
  { label: '#开会发言', scene: '会议' },
  { label: '#校园生活', scene: '校园' },
  { label: '#科技数码', scene: '科技' },
  { label: '#餐厅点餐', scene: '餐厅' },
];

/** 4 个纯工具入口（grid 定义；查词记录=页内抽屉，其余跳既有页） */
const TOOL_ENTRIES = [
  { key: 'history', label: '查词记录', icon: '/assets/icons/manage-search.svg' },
  { key: 'vocab', label: '生词本', icon: '/assets/icons/menu-book-primary.svg' },
  { key: 'pron', label: '发音笔记本', icon: '/assets/icons/mic-ink.svg' },
  { key: 'packs', label: '我的卡册', icon: '/assets/icons/layers-primary.svg' },
];

Page({
  data: {
    themeClass: '',
    isLoggedIn: false,
    greeting: '你好，远路人',
    streakDays: 0,

    // 巨型搜索 + 灵感胶囊
    query: '',
    suggestions: [],
    tools: TOOL_ENTRIES,

    // 场景检索结果（仅搜索后渲染；无搜索零内容）
    searching: false,
    searchDone: false,
    results: [],

    // 词典弹层（真实语境例句为静态文本，播放隔离到训练室）
    wordModal: {
      visible: false, word: '', dictData: null, corpusExamples: [],
      loading: false, saving: false, isSaved: false,
    },

    // 查词记录抽屉（本地存储）
    historyOpen: false,
    history: [],

    showPremiumModal: false,
    premiumSource: 'dictionary_quota',
  },

  onLoad() {
    this._lastToken = undefined;
    this._vocabSet = {};
    this.setData({ suggestions: dictTool.pickSuggestions(SUGGESTION_POOL, SUGGESTIONS_SHOW, []) });
    this.unsubscribeAuth = authStore.subscribe(() => this.syncAuthState());
    this.syncAuthState();
  },

  onShow() {
    this.syncAuthState();
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome();
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
  },

  onPullDownRefresh() {
    const labels = this.data.suggestions.map((s) => s.label);
    this.setData({ suggestions: dictTool.pickSuggestions(SUGGESTION_POOL, SUGGESTIONS_SHOW, labels) });
    this._fetchHeader().then(() => wx.stopPullDownRefresh());
  },

  /** 登录态同步（token 变化才重拉问候/生词集） */
  syncAuthState() {
    const { isLoggedIn } = authStore.getState();
    const currentToken = wx.getStorageSync('token');
    const tokenChanged = this._lastToken !== currentToken;
    this._lastToken = currentToken;
    if (isLoggedIn !== this.data.isLoggedIn) this.setData({ isLoggedIn });
    if (isLoggedIn && tokenChanged) this._fetchHeader();
  },

  /** 问候语 + 连续天数 + 生词集合（保存态判定用），全部静默降级 */
  async _fetchHeader() {
    if (!authStore.getState().isLoggedIn) return;
    const [profileRes, statsRes, vocabRes] = await Promise.all([
      get('/api/user/profile').catch(() => null),
      get('/api/user/stats/overview').catch(() => null),
      get('/api/vocabulary/all').catch(() => null),
    ]);
    const profile = profileRes || {};
    const hour = new Date().getHours();
    const timeGreeting = hour <= 11 ? '早上好' : hour <= 17 ? '下午好' : '晚上好';
    const vocabList = (vocabRes && (vocabRes.data || vocabRes)) || [];
    this._vocabSet = {};
    (Array.isArray(vocabList) ? vocabList : []).forEach((v) => {
      this._vocabSet[String(v.word || '').toLowerCase()] = true;
    });
    this.setData({
      greeting: timeGreeting + '，' + (profile.nickname || '朋友'),
      streakDays: (statsRes && statsRes.streakDays) || profile.streakDays || 0,
    });
  },

  // ==================== 搜索（查词 / 场景分流） ====================

  onSearchInput(e) {
    this.setData({ query: (e.detail && e.detail.value) || '' });
  },

  onSearchConfirm() {
    this._search();
  },

  onClearSearch() {
    this.setData({ query: '', results: [], searchDone: false, searching: false });
  },

  /** 灵感胶囊：一键填入并触发对应查询 */
  onSuggestionTap(e) {
    const s = e.currentTarget.dataset.item;
    if (!s) return;
    this.setData({ query: s.label });
    if (s.word) this._lookupWord(s.word);
    else if (s.scene) this._searchScene(s.scene);
  },

  /** 刷新灵感胶囊：避开当前展示集重抽 */
  onRefreshSuggestions() {
    const labels = this.data.suggestions.map((s) => s.label);
    this.setData({ suggestions: dictTool.pickSuggestions(SUGGESTION_POOL, SUGGESTIONS_SHOW, labels) });
  },

  _search() {
    const q = (this.data.query || '').trim();
    if (!q) {
      wx.showToast({ title: '输入一个单词或想练的场景', icon: 'none' });
      return;
    }
    if (dictTool.isWordQuery(q)) {
      this._lookupWord(q.replace(/^#查单词:\s*/, ''));
    } else {
      this._searchScene(q);
    }
  },

  /** 查词 → 词典弹层（例句静态文本；记录查词历史） */
  async _lookupWord(rawWord) {
    const word = String(rawWord || '').trim().replace(/[.,!?;:"()]/g, '');
    if (!word) return;
    const lower = word.toLowerCase();
    this.setData({
      wordModal: {
        visible: true, word, dictData: null, corpusExamples: [],
        loading: true, saving: false, isSaved: !!this._vocabSet[lower],
      },
      history: dictTool.dictHistoryRecord(word),
      results: [],
      searchDone: true,
    });
    try {
      const body = await get('/api/dict/' + encodeURIComponent(lower), null, { showError: false });
      if (!this.data.wordModal.visible || this.data.wordModal.word.toLowerCase() !== lower) return;
      if (body && body.success && body.data) {
        this.setData({
          'wordModal.dictData': body.data,
          'wordModal.corpusExamples': dictTool.buildCorpusExampleVms(body.data.corpusExamples, word),
          'wordModal.loading': false,
        });
      } else {
        this.setData({ 'wordModal.loading': false });
      }
    } catch (err) {
      if (!this.data.wordModal.visible) return;
      this.setData({ 'wordModal.loading': false });
      if (err && err.code === 'DICTIONARY_QUOTA_EXCEEDED') {
        this.setData({ showPremiumModal: true });
      } else {
        wx.showToast({ title: (err && err.message) || '查询失败，请重试', icon: 'none' });
      }
    }
  },

  /** 场景检索 → 语境句列表（点行进训练室） */
  async _searchScene(q) {
    this.setData({ searching: true, searchDone: true, results: [] });
    try {
      const body = await get(
        '/api/scenes/feed?page=1&pageSize=10&q=' + encodeURIComponent(q),
        null,
        { showError: false },
      );
      const items = ((body && body.success && body.data && body.data.items) || [])
        .filter((it) => it.golden && it.golden.en)
        .map((it) => ({
          sceneid: it.sceneid,
          en: it.golden.en,
          zh: it.golden.zh || '',
          tag: it.situationTag || '',
          durText: Math.round(it.duration || 0) + 's',
        }));
      this.setData({ searching: false, results: items });
    } catch (e) {
      this.setData({ searching: false, results: [] });
      wx.showToast({ title: '检索失败，请重试', icon: 'none' });
    }
  },

  onResultTap(e) {
    const sceneid = e.currentTarget.dataset.scene;
    if (sceneid) wx.navigateTo({ url: '/pages/practice-room/index?sceneId=' + sceneid });
  },

  // ==================== 工具入口 / 查词记录抽屉 ====================

  onToolTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'history') {
      this.setData({ historyOpen: true, history: dictTool.dictHistoryList() });
      return;
    }
    if (key === 'vocab' || key === 'pron') {
      // 复习中心是 tabBar 页（switchTab 不带参）→ 存储预约 Tab，onShow 消费
      wx.setStorageSync('review:pendingTab', key === 'vocab' ? 0 : 2);
      wx.switchTab({ url: '/pages/review/index' });
      return;
    }
    if (key === 'packs') {
      wx.navigateTo({ url: '/pages/library/paths/index' });
    }
  },

  onHistoryClose() {
    this.setData({ historyOpen: false });
  },

  onHistoryWordTap(e) {
    const word = e.currentTarget.dataset.word;
    this.setData({ historyOpen: false });
    if (word) this._lookupWord(word);
  },

  onHistoryClear() {
    this.setData({ history: dictTool.dictHistoryClear() });
  },

  // ==================== 词典弹层（保存/完成/前往跟读） ====================

  onVocabClose() {
    this.setData({ 'wordModal.visible': false });
  },

  onVocabComplete() {
    this.setData({ 'wordModal.visible': false });
  },

  onVocabGoPractice(e) {
    const ex = e.detail && e.detail.example;
    if (!ex) return;
    this.setData({ 'wordModal.visible': false });
    wx.navigateTo({
      url: '/pages/practice-room/index?word=' + encodeURIComponent(this.data.wordModal.word || '') +
        '&clipId=' + encodeURIComponent(ex.clipid),
    });
  },

  onVocabSave() {
    const m = this.data.wordModal;
    const word = m.word;
    if (!word || m.saving) return;
    if (!this.data.isLoggedIn) {
      wx.showToast({ title: '登录后可保存生词', icon: 'none' });
      wx.navigateTo({ url: '/pages/auth/index' });
      return;
    }
    this.setData({ 'wordModal.saving': true });
    const d = m.dictData || {};
    const definition = (d.definitions || [])
      .map((x) => '[' + x.pos + '] ' + x.meaning_cn)
      .join('; ');
    post('/api/vocabulary/add', {
      word,
      definition,
      contextSentence: '',
      translation: '',
      episodeid: null,
      timestamp: null,
      speakUrl: (d.audio_urls && d.audio_urls.us) || '',
      dictUrl: '',
      webUrl: '',
      mobileUrl: '',
    }, { showError: false })
      .then(() => {
        this._vocabSet[word.toLowerCase()] = true;
        this.setData({ 'wordModal.saving': false, 'wordModal.isSaved': true });
        wx.showToast({ title: '已加入生词本', icon: 'none' });
      })
      .catch((err) => {
        this.setData({ 'wordModal.saving': false });
        if (err && err.statusCode === 400) {
          this._vocabSet[word.toLowerCase()] = true;
          this.setData({ 'wordModal.isSaved': true });
          return;
        }
        if (err && err.code === 'VOCABULARY_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'vocabulary_total' });
          return;
        }
        if (err && err.code === 'VOCABULARY_DAILY_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'vocabulary_daily' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
      });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
});
