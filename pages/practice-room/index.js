/**
 * pages/practice-room — 题库式跟读训练室（工具化转型阶段三·精简版）
 *
 * 摒弃无限上滑卡片流：一题一屏、手动【下一句】翻页，禁止自动连播/手势滑动。
 * 页面不重复展示短句文本、无独立播放钮——eval-card 即答题卡（自带句子
 * 展示 + 原声/慢速/发音示范播放 + 录音评测三指标 + 逐词音素诊断）。
 * 入参（二选一）：
 *   ?word=resilient&clipId=xx  词典例句队列（/api/dict corpusExamples；
 *                              clipId 把该例句置顶）
 *   ?sceneId=xx                 语境句队列（/api/scenes/[sceneid] clips）
 *
 * 切片音频经 /api/clips/{id}/audio 网关按需现切（≤45s 服务端硬闸），
 * 预取直链填入 eval-card 的 subtitle.audioUrl，词级时间轴按 clipOffset
 * 换算切片相对秒。
 */
const { get, post } = require('../../utils/request');
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const audioClip = require('../../utils/audio-clip');
const { buildSentenceTokens } = require('./sentence-tokens');
const dictTool = require('../../utils/dict-tool');

Page({
  data: {
    themeClass: '',
    isLoggedIn: true,
    loading: true,
    loadError: '',

    sourceLabel: '',
    word: '',
    items: [],       // [{clipid, episodeid, subtitleId, textEn, textCn, duration, words, audioUrl, audioOffset, audioReady}]
    index: 0,
    total: 0,

    // 当前题视图模型（WXML 零方法调用：全部预计算）
    current: null,   // {textEn, textCn, durText, evalSubtitle, subtitleId, episodeId}
    wordModal: null,
    lookupQuota: '',

    lastScore: null,
    scores: [],
    finished: false,
    avgText: '',
  },

  onLoad(query) {
    this._lookupId = 0;
    this._unsubAuth = authStore.subscribe(() => {
      this.setData({ isLoggedIn: authStore.getState().isLoggedIn });
      this._syncSavedWords();
    });
    this.setData({ isLoggedIn: authStore.getState().isLoggedIn });
    this._syncSavedWords();

    if (query && query.sceneId) {
      this._loadScene(query.sceneId);
    } else if (query && query.query) {
      this._loadQuerySearch(query.query, query.clipId || '');
    } else if (query && query.word) {
      this._loadWord(query.word, query.clipId || '');
    } else {
      this.setData({ loading: false, loadError: '缺少训练参数' });
    }
  },

  onShow() {
    this._hidden = false;
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome();
    this._resumeLookupPlayback();
  },

  onHide() {
    this._hidden = true;
  },

  onUnload() {
    this._lookupId++;
    this._hidden = true;
    this._lookupPlayback = null;
    this._savedWords = null;
    if (this._unsubAuth) this._unsubAuth();
  },

  // ==================== 队列加载（词典例句 / 语境句） ====================

  async _loadWord(word, preferClipId) {
    try {
      const body = await get(
        '/api/dict/' + encodeURIComponent(String(word).toLowerCase()),
        null,
        { showError: false },
      );
      const examples = (body && body.success && body.data && body.data.corpusExamples) || [];
      if (!examples.length) {
        this.setData({ loading: false, loadError: '该词暂无原声例句，换一个词试试' });
        return;
      }
      let items = examples.filter((e) => e && e.clipid).map((e) => this._mapItem(e));
      if (preferClipId) {
        const i = items.findIndex((it) => it.clipid === preferClipId);
        if (i > 0) items = [items[i]].concat(items.slice(0, i), items.slice(i + 1));
      }
      this._ready(items, '查单词 · ' + word, String(word));
    } catch (e) {
      this.setData({ loading: false, loadError: '例句加载失败，请重试' });
    }
  },

  /**
   * 语义检索模式（首页「语境句」入口）：与首页同一条 semantic-search 链路，
   * 响应自带现签切片直链与词级时间轴，直接装配训练队列（服务端短语缓存，
   * 同词二次请求不重复调 LLM）。
   */
  async _loadQuerySearch(q, preferClipId) {
    try {
      const body = await post(
        '/api/scenes/semantic-search',
        { q },
        { showError: false, timeout: 30000 },
      );
      const items = (body && body.success && body.data && body.data.items) || [];
      if (!items.length) {
        this.setData({ loading: false, loadError: '该场景暂无匹配语境，换个说法试试' });
        return;
      }
      let queue = items.filter((it) => it && it.clipid).map((it) => {
        const m = this._mapItem(it);
        m.audioUrl = it.clipAudioUrl || '';
        m.audioOffset = it.clipOffset || 0;
        m.audioReady = !!it.clipAudioUrl;
        return m;
      });
      if (preferClipId) {
        const i = queue.findIndex((it) => it.clipid === preferClipId);
        if (i > 0) queue = [queue[i]].concat(queue.slice(0, i), queue.slice(i + 1));
      }
      this._ready(queue, '语境特训 · ' + q, '');
    } catch (e) {
      this.setData({ loading: false, loadError: '语境加载失败，请重试' });
    }
  },

  async _loadScene(sceneid) {
    try {
      const body = await get('/api/scenes/' + encodeURIComponent(sceneid), null, { showError: false });
      const scene = body && body.success && body.data && body.data.scene;
      const clips = (scene && scene.clips) || [];
      if (!clips.length) {
        this.setData({ loading: false, loadError: '该语境暂无句子' });
        return;
      }
      this._ready(
        clips.filter((c) => c && c.clipid).map((c) => {
          const it = this._mapItem(c);
          it.episodeid = c.episodeid || scene.episodeid || '';
          return it;
        }),
        scene.title || '语境训练',
        '',
      );
    } catch (e) {
      this.setData({ loading: false, loadError: '语境加载失败，请重试' });
    }
  },

  _mapItem(c) {
    const start = c.startTime != null ? c.startTime : c.start;
    const end = c.endTime != null ? c.endTime : c.end;
    return {
      clipid: c.clipid,
      episodeid: c.episodeid || '',
      subtitleId: c.subtitleId,
      textEn: c.textEn || c.enText || '',
      textCn: c.textCn || c.zhText || '',
      start: Number.isFinite(start) ? start : null,
      duration: c.duration || (end > start ? end - start : 0),
      words: Array.isArray(c.words) ? c.words : [],
      audioUrl: '',
      audioOffset: 0,
      audioReady: false,
    };
  },

  _ready(items, label, word) {
    this.setData({
      loading: false,
      loadError: '',
      items,
      total: items.length,
      index: 0,
      sourceLabel: label,
      word,
      scores: [],
      finished: false,
      lastScore: null,
    });
    this._applyCurrent();
    // 首题预取切片直链（eval-card 原声/慢速/词级播放共用；失败由卡片内提示兜底）
    this._ensureAudio(items[0]);
  },

  /** 当前题视图模型（含 eval-card subtitle：词级时间轴换算切片相对秒） */
  _applyCurrent() {
    const it = this.data.items[this.data.index];
    if (!it) {
      this.setData({ current: null });
      return;
    }
    const offset = it.audioOffset || 0;
    const words = it.words.filter((w) => w && typeof w.word === 'string' &&
      Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.end > offset).map((w) => ({
      word: w.word,
      start: Math.max(0, (w.start || 0) - offset),
      end: Math.max(0, (w.end || 0) - offset),
    }));
    const start = Math.max(0, (it.start || 0) - offset);
    const end = it.duration > 0 ? start + it.duration : (words.length ? words[words.length - 1].end : 0);
    this.setData({
      current: {
        clipid: it.clipid,
        textEn: it.textEn,
        textCn: it.textCn,
        durText: Math.round(it.duration) + 's',
        subtitleId: it.subtitleId,
        episodeId: it.episodeid,
        evalSubtitle: {
          textEn: it.textEn,
          textCn: it.textCn,
          words,
          sentenceTokens: buildSentenceTokens(it.textEn, this.data.word, words, start, end),
          audioUrl: it.audioUrl || '',
          start,
          end,
        },
      },
      lastScore: this.data.scores[this.data.index] != null ? this.data.scores[this.data.index] : null,
    });
  },

  /** 预取切片直链（/api/clips/{id}/audio 现切）+ 词级时间轴对齐 */
  async _ensureAudio(it) {
    if (!it || it.audioReady) return;
    try {
      const resolved = await audioClip.resolveClipSource({ clipId: it.clipid });
      if (!resolved || !resolved.url) return;
      const idx = this.data.items.findIndex((x) => x.clipid === it.clipid);
      if (idx < 0) return;
      const offset = resolved.offset || 0;
      const sourceStart = Math.max(0, (it.start || 0) - offset);
      this.setData({
        ['items[' + idx + '].audioUrl']: resolved.url,
        ['items[' + idx + '].duration']: it.duration || Math.max(0, (resolved.duration || 0) - sourceStart),
        ['items[' + idx + '].audioOffset']: offset,
        ['items[' + idx + '].audioReady']: true,
      });
      // 是当前题则同步刷新 eval-card 的 subtitle
      if (idx === this.data.index) this._applyCurrent();
    } catch (e) {
      /* 静默：中央播放钮的失败分支已兜底提示 */
    }
  },

  // ==================== 训练句点词查词 ====================

  _syncSavedWords() {
    const { token, isLoggedIn } = authStore.getState();
    if (this._savedWords && token === this._vocabOwner) return;
    this._vocabOwner = token;
    const saved = this._savedWords = new Set();
    if (this.data.wordModal) this.setData({ 'wordModal.isSaved': false, 'wordModal.saving': false });
    if (!isLoggedIn) return;
    get('/api/vocabulary/words', null, { showError: false }).then((body) => {
      if (saved !== this._savedWords || !Array.isArray(body && body.data)) return;
      body.data.forEach((word) => saved.add(String(word).toLowerCase()));
      if (this.data.wordModal) this.setData({ 'wordModal.isSaved': saved.has(this.data.wordModal.word) });
    }).catch(() => {});
  },

  async onWordLookup(e) {
    const word = e.detail.word.toLowerCase().replace(/’/g, "'");
    const clip = this.data.items[this.data.index];
    if (!clip || !word || this._hidden || this.data.wordModal || this.data.finished) return;
    const lookupId = ++this._lookupId;
    const card = this.selectComponent('#training-card');
    this._lookupPlayback = { clipid: clip.clipid, playback: card.pauseForLookup() };
    this.setData({ wordModal: {
      word, loading: true, saving: false, dictData: null, isSaved: this._savedWords.has(word),
      examples: dictTool.buildClipCorpusExamples(clip, word),
    } });
    try {
      const body = await get('/api/dict/' + encodeURIComponent(word), null, { showError: false });
      if (lookupId !== this._lookupId) return;
      const entry = body && body.success && body.data;
      this.setData({
        'wordModal.loading': false,
        'wordModal.dictData': entry || null,
        'wordModal.examples': dictTool.buildClipCorpusExamples(clip, word, entry && entry.corpusExamples),
      });
    } catch (err) {
      if (lookupId !== this._lookupId) return;
      this.setData({ 'wordModal.loading': false });
      if (err.code === 'DICTIONARY_QUOTA_EXCEEDED') this.setData({ lookupQuota: 'dictionary_quota' });
      else wx.showToast({ title: '查词失败，请重新点词', icon: 'none' });
    }
  },

  async onVocabSave() {
    const m = this.data.wordModal;
    if (!m || m.saving || m.isSaved || m.loading) return;
    if (!authStore.getState().isLoggedIn) {
      wx.showModal({ title: '请先登录', content: '登录后可将这个词加入生词本', confirmText: '去登录',
        success: (r) => { if (r.confirm) this.onGoLogin(); } });
      return;
    }
    const lookupId = this._lookupId;
    const saved = this._savedWords;
    const entry = dictTool.clipVocabularyEntry(m.word, m.dictData, this.data.items[this.data.index]);
    this.setData({ 'wordModal.saving': true });
    try {
      await post('/api/vocabulary/add', entry, { showError: false });
      saved.add(m.word);
      if (lookupId !== this._lookupId || saved !== this._savedWords) return;
      wx.showToast({ title: '已加入生词本', icon: 'none' });
      this.onVocabClose();
    } catch (err) {
      if (lookupId !== this._lookupId || saved !== this._savedWords) return;
      this.setData({ 'wordModal.saving': false });
      if (err.statusCode === 400 && err.body && err.body.data && err.body.data.word) {
        saved.add(m.word);
        this.setData({ 'wordModal.isSaved': true });
      } else if (err.code === 'VOCABULARY_QUOTA_EXCEEDED' || err.code === 'VOCABULARY_DAILY_QUOTA_EXCEEDED') {
        this.setData({ lookupQuota: err.code === 'VOCABULARY_QUOTA_EXCEEDED' ? 'vocabulary_total' : 'vocabulary_daily' });
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
  },

  onLookupQuotaClose() {
    this.setData({ lookupQuota: '' }, () => this._resumeLookupPlayback());
  },

  onVocabClose() {
    this._lookupId++;
    this.setData({ wordModal: null }, () => this._resumeLookupPlayback());
  },

  _resumeLookupPlayback() {
    const resume = this._lookupPlayback;
    if (!resume || this._hidden || this.data.wordModal || this.data.lookupQuota) return;
    this._lookupPlayback = null;
    if (resume.playback && this.data.current && this.data.current.clipid === resume.clipid) {
      const card = this.selectComponent('#training-card');
      if (card) card.resumeAfterLookup(resume.playback);
    }
  },

  onVocabPractice(e) {
    const example = e.detail.example;
    if (!this.data.wordModal || !example) return;
    if (example.isCurrentClip) return this.onVocabClose();
    const word = this.data.wordModal.word;
    wx.navigateTo({
      url: '/pages/practice-room/index?word=' + encodeURIComponent(word) + '&clipId=' + encodeURIComponent(example.clipid),
      success: () => {
        this._lookupId++;
        this.setData({ wordModal: null });
      },
      fail: () => wx.showToast({ title: '未能打开跟读训练', icon: 'none' }),
    });
  },

  // ==================== 评测回调 / 手动翻页（禁止自动连播） ====================

  onEvaluate(e) {
    const score = e.detail && e.detail.score;
    const idx = this.data.index;
    if (score == null) return;
    this.setData({ ['scores[' + idx + ']']: score, lastScore: score });
  },

  onQuota() {
    /* 配额事件：eval-card 自持锁定与会员转化，页面无额外动作 */
  },

  onPhaseChange() {
    /* 状态机事件保留位 */
  },

  onBookmark() {
    /* 收藏结果由 eval-card 内部 toast，页面不联动 */
  },

  onNext() {
    if (this.data.wordModal) return;
    if (this.data.index >= this.data.total - 1) {
      // 全部完成：结算面板（不自动跳走）
      const scores = this.data.scores.filter((s) => s != null);
      const avg = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;
      this.setData({ finished: true, avgText: scores.length ? avg + ' 分' : '—' });
      return;
    }
    this.setData({ index: this.data.index + 1 });
    this._applyCurrent();
    this._ensureAudio(this.data.items[this.data.index]);
  },

  onRestart() {
    this.setData({ index: 0, scores: [], finished: false, lastScore: null });
    this._applyCurrent();
    this._ensureAudio(this.data.items[0]);
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
});
