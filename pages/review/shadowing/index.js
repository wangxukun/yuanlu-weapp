// pages/review/shadowing — 原声影子跟读（REVIEW-TASK T3.4）
// 复刻 Web SentenceShadowingPractice.tsx：复用 T3.2 语音评测卡（录音 → 有道
// ISE → 逐词/音素评分），按收藏句列表逐句跟读。
//
// - 深链：?id=（收藏句 id，优先）/ ?subtitleId=（兜底）定位初始句，未命中回落 0
// - 语料切片注入：优先消费收藏句内联 clipAudioUrl 或凭 clipId 经 /api/clips/{id}/audio
//   解析物理切片直链，按 clipOffset 对齐 start/end/words（零整集请求）
// - quota 预检：GET /api/speech/quota?scenario=review，exhausted → 卡置锁；
//   每次评测后经 eval-card quota 事件刷新（used+1 触墙则下一句置锁）
// - 结果缓存：evaluate 事件按句存 previousResult，切回该句恢复结果态
// - 完成/返回：navigateBack 前 globalData.deckFocusSubtitleId 带回句定位
//   （deck onShow 消费后清空）
const sentenceCore = require('../../../utils/sentence-core');
const audioClip = require('../../../utils/audio-clip');
const theme = require('../../../utils/theme');
const { get } = require('../../../utils/request');

Page({
  data: {
    loading: true,
    isEmpty: false,
    index: 0,
    total: 0,
    progressPercent: 0,
    // eval-card props（换句整体替换，组件 observers 响应 subtitle 变化）
    subtitle: null,
    subtitleId: null,
    episodeId: '',
    episodeTitle: '',
    quotaLocked: false,
    previousResult: null,
    cardKey: '',
    themeClass: '',
  },

  onLoad(options) {
    this._sentences = []; // 收藏句全量（收藏序）
    this._results = {}; // id → 评测结果（切回恢复）
    this._deepLinkId = options && options.id ? String(options.id) : '';
    this._deepLinkSubtitleId = options && options.subtitleId ? String(options.subtitleId) : '';
    this._syncTheme();
    this.loadData();
  },

  onShow() {
    this._syncTheme();
  },

  _syncTheme() {
    this.setData({
      themeClass: theme.rootClass(),
      dark: theme.getEffective() === 'dark',
    });
    theme.applyChrome();
  },

  /* ---------------- 数据加载 ---------------- */

  async loadData() {
    try {
      const res = await get('/api/sentences/list');
      if (res && res.success && Array.isArray(res.data)) {
        this._sentences = sentenceCore.parseSentences(res);
      }
      if (!this._sentences.length) {
        this.setData({ loading: false, isEmpty: true });
        return;
      }
      // 深链定位：id 优先 / subtitleId 兜底 / 未命中回落 0
      // （index 必须初始化 -1：初始 0 会让 subtitleId 兜底分支被 index<0 短路，
      //  deck 跟读只传 subtitleId 时恒落第 1 句——刷句卡片与跟读句错位根因）
      let index = -1;
      if (this._deepLinkId) {
        index = this._sentences.findIndex((s) => String(s.id) === this._deepLinkId);
      }
      if (index < 0 && this._deepLinkSubtitleId) {
        index = this._sentences.findIndex((s) => String(s.subtitleId) === String(this._deepLinkSubtitleId));
      }
      this.setData({ loading: false, index: index >= 0 ? index : 0 });
      await this._applySentence();
      this._preflightQuota();
    } catch (err) {
      this.setData({ loading: false, isEmpty: true });
    }
  },

  /** 组装当前句 subtitle prop（走语料切片直链 clipAudioUrl / clipId 懒解析，零整集请求） */
  async _applySentence() {
    const s = this._sentences[this.data.index];
    if (!s) return;
    this.setData({ subtitle: null }); // 换句先置空（eval-card observers 重置态）
    let audioUrl = '';
    let off = typeof s.clipOffset === 'number' ? s.clipOffset : 0;
    const rawWords = Array.isArray(s.clipWords) ? s.clipWords : [];
    const textEn = s.enText;
    const textCn = s.zhText;
    const subtitleId = s.subtitleId;

    const clipPromise = audioClip.resolveClipSource({
      clipId: s.clipId,
      clipAudioUrl: s.clipAudioUrl,
      clipOffset: s.clipOffset,
      clipDuration: s.clipDuration,
    });
    if (clipPromise) {
      try {
        const resolved = await clipPromise;
        if (resolved && resolved.url) {
          audioUrl = resolved.url;
          off = typeof resolved.offset === 'number' ? resolved.offset : off;
        }
      } catch (e) {
        // 切片解析失败：收藏句字段兜底（无原声，仍可录音评测）
      }
    }

    const start = audioUrl ? Math.max(0, (Number(s.startTime) || 0) - off) : (Number(s.startTime) || 0);
    const rawEnd = Number(s.endTime) || (Number(s.startTime) || 0) + 3;
    const end = audioUrl ? Math.max(start + 0.5, rawEnd - off) : rawEnd;
    const words = audioUrl
      ? rawWords.map((w) => ({
          word: w.word,
          start: Math.max(0, (Number(w.start) || 0) - off),
          end: Math.max(0, (Number(w.end) || 0) - off),
        }))
      : rawWords;

    this.setData({
      subtitle: { textEn, textCn, words, audioUrl, start, end },
      subtitleId,
      episodeId: s.episodeid,
      episodeTitle: s.episodeTitle,
      previousResult: this._results[s.id] || null,
      cardKey: 'sh-' + s.id,
      total: this._sentences.length,
      progressPercent: ((this.data.index + 1) / this._sentences.length) * 100,
    });
  },

  /** 评测日池预检：exhausted → 本卡置锁（eval-card 锁定态） */
  async _preflightQuota() {
    try {
      const res = await get('/api/speech/quota?scenario=review');
      if (res && res.success && res.data) {
        this.setData({ quotaLocked: !!res.data.exhausted });
      }
    } catch (e) {
      // 预检失败不置锁（403 评测时 eval-card 自会永久置锁）
    }
  },

  /* ---------------- eval-card 事件 ---------------- */

  /** 评测完成：缓存结果（切回恢复） */
  onEvaluate(e) {
    const s = this._sentences[this.data.index];
    if (s && e.detail) {
      this._results[s.id] = e.detail.details;
    }
  },

  /** 配额刷新（每次评测后）：触墙 → 置锁；余量恢复 → 解锁（跨天场景） */
  onQuota(e) {
    const q = e.detail || {};
    if (q.exhausted) {
      this.setData({ quotaLocked: true });
    } else if (this.data.quotaLocked && q.used < q.limit) {
      this.setData({ quotaLocked: false });
    }
  },

  /* ---------------- 句导航 ---------------- */

  onPrev() {
    if (this.data.index <= 0) return;
    this.setData({ index: this.data.index - 1 });
    this._applySentence();
  },

  onNext() {
    if (this.data.index >= this.data.total - 1) {
      this.onFinish();
      return;
    }
    this.setData({ index: this.data.index + 1 });
    this._applySentence();
  },

  /** 完成跟读：navigateBack 前把当前句 subtitleId 带回 deck 定位 */
  onFinish() {
    const s = this._sentences[this.data.index];
    const app = getApp();
    if (s && app) {
      app.globalData = app.globalData || {};
      app.globalData.deckFocusSubtitleId = s.subtitleId !== null ? String(s.subtitleId) : '';
    }
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/review/index' }),
    });
  },

  /** 空态返回 */
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/review/index' }),
    });
  },
});
