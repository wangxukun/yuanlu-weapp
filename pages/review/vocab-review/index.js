// pages/review/vocab-review — 生词复习·闪卡模式（REVIEW-TASK T1.5，2026-09-23 重构）
// 复刻 yuanlu-android VocabularyReviewScreen.kt（四题型模式已退役删除）：
//
// 状态机（对齐 Android VocabularyUiState）：
// - queue/currentIndex/isFlipped/submitting/results/showSummary 五元组驱动全页
// - 正面（Front）：居中大字单词 + 浅绿圆底发音钮 + 「回忆词义，点击卡片查看答案」
//   + 「来自《剧集名》」；点击卡片任意区域或底部「显示答案」→ 翻面
// - 背面（Back）：可滚动长列表（单词 + US/UK 音标发音 / 释义卡 / 原声出处卡 /
//   词源记忆卡）；3D 翻转 perspective 1200 + rotateY 180° + 0.6s
//   cubic-bezier(0.4,0,0.2,1)（Android FastOutSlowInEasing 同曲线）
// - 左右滑动切换上/下一张（浏览式不评分，阈值 80dp；回到上一张可重看，
//   重评时覆盖旧结果——对齐 Android goToPrev/goToNext + results.filterNot）
// - FSRS 四档提交：POST /api/vocabulary/review {vocabularyid, quality}，
//   成功回写 proficiency/nextReviewAt（乐观更新），失败 toast 不中断；
//   最后一张提交完进入总结页（2×2 四档统计 + 逐词结果 + 再来一轮忘记子集）
// - 开卡/翻面自动播词典发音（音源链 audioUs → audioUk → speakUrl →
//   dictvoice 兜底，对齐 Android LaunchedEffect）
const vocabCore = require('../../../utils/vocab-core');
const srs = require('../../../utils/srs');
const { get, post } = require('../../../utils/request');
const tts = require('../../../utils/tts');
const audioClip = require('../../../utils/audio-clip');

/**
 * 复习状态码 → UI 元数据映射（总结页四宫格主题色 + 逐词列表右侧文本色共用，
 * 颜色口径对齐 Android qualityColor：忘记 error / 模糊 warning(accent) /
 * 认识 success(primary) / 简单 info）。qualityCls 与 WXSS 的 vr-q--N 一一对应。
 */
const QUALITY_META = [
  { quality: 0, label: '忘记', qualityCls: 'vr-q--0' },
  { quality: 1, label: '模糊', qualityCls: 'vr-q--1' },
  { quality: 2, label: '认识', qualityCls: 'vr-q--2' },
  { quality: 3, label: '简单', qualityCls: 'vr-q--3' },
];

/** 把一次评分包装成总结页结果行（word + 状态文案 + 颜色类） */
function decorateResult(vocabularyid, word, quality) {
  const meta = QUALITY_META[quality] || QUALITY_META[2];
  return {
    vocabularyid,
    word,
    quality,
    qualityLabel: meta.label,
    qualityCls: meta.qualityCls,
  };
}

/** 滑动切卡阈值（dp → px 运行时换算；Android detectHorizontalDragGestures 80dp） */
const SWIPE_THRESHOLD_DP = 80;

Page({
  data: {
    loading: true,
    queue: [],
    index: 0,
    isFlipped: false,
    submitting: false,
    results: [], // [{vocabularyid, word, quality, qualityLabel, qualityCls}]
    showSummary: false,
    summary: { forgot: 0, hard: 0, good: 0, easy: 0, total: 0 },
    progress: 0,
    current: null, // queue[index] 的 decorate 快照（WXML 就绪字段）
    dragOffset: 0, // 跟手横移反馈（px）
  },

  onLoad() {
    this._list = []; // 全量列表（乐观更新 + 再来一轮过滤）
    this._touchStartX = 0;
    this._touchStartY = 0;
    this._touchLocked = false; // 纵向滚动锁定（背面 scroll 区不误触切卡）
    this.initQueue();
    this._unsubTts = tts.subscribe(() => this.syncAudioState());
    this._unsubClip = audioClip.subscribe(() => this.syncAudioState());
    // TTS 配额弹窗自持（朗读句子可能触墙）：入栈保存宿主 handler、退栈恢复
    this._prevQuota = tts.getQuotaHandler();
    tts.setQuotaHandler((source) => {
      this.setData({ showPremiumModal: true, premiumSource: source });
    });
    this.setData({ showPremiumModal: false, premiumSource: '' });
  },

  onUnload() {
    if (this._unsubTts) this._unsubTts();
    if (this._unsubClip) this._unsubClip();
    tts.stop();
    audioClip.stop();
    tts.setQuotaHandler(this._prevQuota || null);
  },

  onModalClose() {
    this.setData({ showPremiumModal: false });
  },

  async initQueue() {
    try {
      const res = await get('/api/vocabulary/all');
      const list = (res && res.success && res.data) || [];
      this._list = list;
      this.setupQueue(vocabCore.buildDueQueue(list));
    } catch (err) {
      // request.js 已 toast；直接退回
      wx.navigateBack();
    }
  },

  /** 组装复习队列（初次与「再来一轮」共用） */
  setupQueue(dueItems) {
    if (!dueItems.length) {
      wx.showToast({ title: '暂无到期生词', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }
    const queue = dueItems.map((item) => {
      const d = vocabCore.decorateItem(item);
      // SRS 四档副文案（对齐 Android nextIntervalLabel：忘记=今天、模糊=1天、
      // 认识/简单=升级后等级阶梯天数封顶 90 天）
      d.intervalPreviews = {
        forgot: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.FORGOT),
        hard: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.HARD),
        good: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.GOOD),
        easy: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.EASY),
      };
      return d;
    });
    this.setData(
      {
        loading: false,
        queue,
        index: 0,
        isFlipped: false,
        results: [],
        showSummary: false,
        summary: vocabCore.summaryStats([]),
      },
      () => this.syncCurrent(true),
    );
  },

  /**
   * 由 index/isFlipped 派生当前卡快照与进度（对齐 Android currentCard +
   * ReviewProgressHeader 的 (index + flipped) / total 口径）并自动播发音。
   */
  syncCurrent(autoPlay) {
    const item = this.data.queue[this.data.index];
    if (!item) return;
    this.setData({
      current: item,
      progress:
        ((this.data.index + (this.data.isFlipped ? 1 : 0)) /
          this.data.queue.length) *
        100,
    });
    if (autoPlay) this.autoPlayWord(item);
  },

  /** 开卡/翻面自动播发音：audioUs → audioUk → speakUrl → dictvoice（Android 同链） */
  autoPlayWord(item) {
    audioClip.stop();
    const dict = item.dictData || {};
    const url =
      (dict.audio_urls && (dict.audio_urls.us || dict.audio_urls.uk)) ||
      item.speakUrl ||
      null;
    // 无词典音源时传词本身：tts.playUrl 无 url 分支会走 TTS 合成（dictvoice）
    tts.playUrl(url, item.word);
  },

  syncAudioState() {
    const { playingText } = tts.getState();
    const { playingKey, loadingKey } = audioClip.getState();
    const patch = {};
    if (playingText !== this.data.playingText) patch.playingText = playingText || '';
    if ((playingKey || '') !== this.data.origKey) patch.origKey = playingKey || '';
    if ((loadingKey || '') !== this.data.origLoading) patch.origLoading = loadingKey || '';
    if (Object.keys(patch).length) this.setData(patch);
  },

  /* ---------------- 翻面与滑动切卡 ---------------- */

  /** 点击卡片 / 显示答案：翻面（对齐 Android flipCard toggle） */
  onFlip() {
    if (this.data.showSummary) return;
    const item = this.data.queue[this.data.index];
    this.setData({ isFlipped: !this.data.isFlipped });
    this.syncCurrent(this.data.isFlipped && !!item); // 翻到背面时自动播一次
  },

  onTouchStart(e) {
    const t = e.touches[0];
    this._touchStartX = t.clientX;
    this._touchStartY = t.clientY;
    this._touchLocked = false;
  },

  onTouchMove(e) {
    if (this._touchLocked) return;
    const t = e.touches[0];
    const dx = t.clientX - this._touchStartX;
    const dy = t.clientY - this._touchStartY;
    // 纵向意图明显（背面滚动区）即锁定，不再切卡
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      this._touchLocked = true;
      if (this.data.dragOffset !== 0) this.setData({ dragOffset: 0 });
      return;
    }
    if (Math.abs(dx) > 10) this.setData({ dragOffset: dx });
  },

  onTouchEnd() {
    const offset = this.data.dragOffset;
    this.setData({ dragOffset: 0 });
    if (this._touchLocked || !offset) return;
    let threshold = SWIPE_THRESHOLD_DP;
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      threshold = (SWIPE_THRESHOLD_DP * win.windowWidth) / 375;
    } catch (e) {
      // 保底 80px
    }
    if (offset <= -threshold) this.goNextCard();
    else if (offset >= threshold) this.goPrevCard();
  },

  /** 浏览式下一张（不评分；对齐 Android goToNextCard） */
  goNextCard() {
    if (this.data.index < this.data.queue.length - 1) {
      this.setData({ index: this.data.index + 1, isFlipped: false });
      this.syncCurrent(true);
    }
  },

  /** 浏览式上一张（重看；重评时覆盖旧结果） */
  goPrevCard() {
    if (this.data.index > 0) {
      this.setData({ index: this.data.index - 1, isFlipped: false });
      this.syncCurrent(true);
    }
  },

  /* ---------------- 发音 ---------------- */

  /** 正面发音钮 / 背面 US·UK 音标喇叭 */
  onPlayWord() {
    const item = this.data.queue[this.data.index];
    if (!item) return;
    this.autoPlayWord(item);
  },

  onPlayPhon(e) {
    const { url, word } = e.currentTarget.dataset;
    tts.playUrl(url, word);
  },

  /* ---------------- FSRS 四档提交（对齐 Android submitReview） ---------------- */

  async onSubmit(e) {
    if (this.data.submitting) return;
    const quality = Number(e.currentTarget.dataset.quality);
    const item = this.data.queue[this.data.index];
    if (!item) return;

    // 同词重评覆盖旧结果（回滑重测场景，对齐 Android results.filterNot）
    const results = this.data.results
      .filter((r) => r.vocabularyid !== item.vocabularyid)
      .concat([decorateResult(item.vocabularyid, item.word, quality)]);
    this.setData({ results, submitting: true });

    try {
      const res = await post('/api/vocabulary/review', {
        vocabularyid: item.vocabularyid,
        quality,
      });
      if (res && res.success && res.data) {
        const updated = res.data;
        // 乐观更新：全量列表与队列内同词同步回写（对齐 Android 双列表回写）；
        // 队列项同时重算 SRS 副文案（回看重评时按新等级预演）
        const applyUpdate = (v) => {
          if (v.vocabularyid !== updated.vocabularyid) return v;
          const merged = Object.assign({}, v, {
            proficiency: updated.proficiency,
            nextReviewAt: updated.nextReviewAt,
          });
          merged.intervalPreviews = {
            forgot: srs.getIntervalLabel(updated.proficiency, 0),
            hard: srs.getIntervalLabel(updated.proficiency, 1),
            good: srs.getIntervalLabel(updated.proficiency, 2),
            easy: srs.getIntervalLabel(updated.proficiency, 3),
          };
          return merged;
        };
        this._list = this._list.map(applyUpdate);
        const queue = this.data.queue.map(applyUpdate);
        this.setData({ queue });
      } else {
        throw new Error('save failed');
      }
    } catch (err) {
      wx.showToast({ title: '网络错误，保存进度失败', icon: 'none' });
    }

    const isLast = this.data.index >= this.data.queue.length - 1;
    if (isLast) {
      // 最后一张：留在当前卡直接进总结（对齐 Android reviewFinished）
      this.setData({
        showSummary: true,
        submitting: false,
        progress: 100,
        summary: vocabCore.summaryStats(results),
      });
      tts.stop();
      audioClip.stop();
    } else {
      this.setData({ submitting: false, index: this.data.index + 1, isFlipped: false });
      this.syncCurrent(true);
    }
  },

  /** 再来一轮：仅重测忘记子集（对齐 retryForgotten） */
  onRetry() {
    const forgottenIds = this.data.results
      .filter((r) => r.quality === srs.ReviewQuality.FORGOT)
      .map((r) => r.vocabularyid);
    const forgotten = this._list.filter((v) => forgottenIds.includes(v.vocabularyid));
    if (!forgotten.length) {
      wx.showToast({ title: '所有生词都已掌握！🎉', icon: 'none' });
      wx.navigateBack();
      return;
    }
    this.setData({ loading: true });
    this.setupQueue(forgotten);
  },

  onFinish() {
    wx.navigateBack();
  },

  onClose() {
    wx.navigateBack();
  },

  /** 背面滚动区 tap 阻断（Android 背面无翻面手势，对齐之） */
  noop() {},
});
