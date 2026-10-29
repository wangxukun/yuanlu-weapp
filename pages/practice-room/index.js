/**
 * pages/practice-room — 题库式跟读训练室（工具化转型阶段三）
 *
 * 摒弃无限上滑卡片流：一题一屏、手动【下一句】翻页，禁止自动连播/手势滑动。
 * 入参（二选一）：
 *   ?word=resilient&clipId=xx  词典例句队列（/api/dict corpusExamples；
 *                              clipId 把该例句置顶）
 *   ?sceneId=xx                 语境句队列（/api/scenes/[sceneid] clips）
 *
 * 每题结构（自上而下）：
 *   1. 短句文本（word 模式命中词三段高亮）
 *   2. 中央独立播放大按钮（audio-clip 切片直连：/api/clips/{id}/audio 现切
 *      ≤45s 硬闸；loading/playing/idle 三态）
 *   3. eval-card 跟读评测（录音→评测→三指标，复用发音闯关同款组件；词级
 *      时间轴按 clipOffset 换算切片相对秒）
 *   4. 底部【下一句】手动翻页（评测完成不自动切换）
 */
const { get } = require('../../utils/request');
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const dictTool = require('../../utils/dict-tool');
const audioClip = require('../../utils/audio-clip');

Page({
  data: {
    themeClass: '',
    isLoggedIn: true,
    loading: true,
    loadError: '',

    sourceLabel: '',
    word: '',
    items: [],       // [{clipid, episodeid, subtitleId, textEn, textCn, duration, words, audioUrl, audioOffset, audioReady, parts}]
    index: 0,
    total: 0,

    // 当前题视图模型（WXML 零方法调用：全部预计算）
    current: null,   // {textEn, textCn, parts, durText, evalSubtitle, subtitleId, episodeId}

    playState: 'idle', // idle | loading | playing
    lastScore: null,
    scores: [],
    finished: false,
    avgText: '',
  },

  onLoad(query) {
    this._unsubClip = audioClip.subscribe(() => this._syncPlayState());
    this._unsubAuth = authStore.subscribe(() => {
      this.setData({ isLoggedIn: authStore.getState().isLoggedIn });
    });
    this.setData({ isLoggedIn: authStore.getState().isLoggedIn });

    if (query && query.sceneId) {
      this._loadScene(query.sceneId);
    } else if (query && query.word) {
      this._loadWord(query.word, query.clipId || '');
    } else {
      this.setData({ loading: false, loadError: '缺少训练参数' });
    }
  },

  onShow() {
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome();
  },

  onUnload() {
    audioClip.stop();
    if (this._unsubClip) this._unsubClip();
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
    return {
      clipid: c.clipid,
      episodeid: c.episodeid || '',
      subtitleId: c.subtitleId,
      textEn: c.textEn || c.enText || '',
      textCn: c.textCn || c.zhText || '',
      duration: c.duration || (c.end && c.start ? c.end - c.start : 0),
      words: c.words || [],
      audioUrl: '',
      audioOffset: 0,
      audioReady: false,
      parts: null,
    };
  },

  _ready(items, label, word) {
    items.forEach((it) => {
      it.parts = word ? dictTool.splitHighlight(it.textEn, word) : null;
    });
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
    // 首题预取切片直链（中央播放与 eval-card 原声共用；失败由播放态兜底）
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
    const words = (it.words || []).map((w) => ({
      word: w.word,
      start: Math.max(0, (w.start || 0) - offset),
      end: Math.max(0, (w.end || 0) - offset),
    }));
    this.setData({
      current: {
        clipid: it.clipid,
        textEn: it.textEn,
        textCn: it.textCn,
        parts: it.parts,
        durText: Math.round(it.duration) + 's',
        subtitleId: it.subtitleId,
        episodeId: it.episodeid,
        evalSubtitle: {
          textEn: it.textEn,
          textCn: it.textCn,
          words,
          audioUrl: it.audioUrl || '',
          start: 0,
          end: it.duration,
        },
      },
      playState: 'idle',
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
      this.setData({
        ['items[' + idx + '].audioUrl']: resolved.url,
        ['items[' + idx + '].audioOffset']: resolved.offset || 0,
        ['items[' + idx + '].audioReady']: true,
      });
      // 是当前题则同步刷新 eval-card 的 subtitle
      if (idx === this.data.index) this._applyCurrent();
    } catch (e) {
      /* 静默：中央播放钮的失败分支已兜底提示 */
    }
  },

  // ==================== 中央独立播放钮（切片直连，≤45s 服务端硬闸） ====================

  onPlayTap() {
    const it = this.data.items[this.data.index];
    if (!it) return;
    audioClip.play({
      key: 'pr:' + it.clipid,
      clipId: it.clipid,
      clipDuration: it.duration,
      clipOffset: 0,
    });
    this._ensureAudio(it);
  },

  _syncPlayState() {
    const st = audioClip.getState() || {};
    const it = this.data.items[this.data.index];
    const key = st.loadingKey || st.playingKey || '';
    const mine = it && key === 'pr:' + it.clipid;
    const playState = mine ? (st.loadingKey === key ? 'loading' : 'playing') : 'idle';
    if (playState !== this.data.playState) this.setData({ playState });
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
    if (this.data.index >= this.data.total - 1) {
      // 全部完成：结算面板（不自动跳走）
      const scores = this.data.scores.filter((s) => s != null);
      const avg = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;
      audioClip.stop();
      this.setData({ finished: true, avgText: scores.length ? avg + ' 分' : '—' });
      return;
    }
    audioClip.stop();
    this.setData({ index: this.data.index + 1 });
    this._applyCurrent();
    this._ensureAudio(this.data.items[this.data.index]);
  },

  onRestart() {
    audioClip.stop();
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
