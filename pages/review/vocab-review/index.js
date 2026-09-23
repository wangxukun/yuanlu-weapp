// pages/review/vocab-review — 生词卡片复习（REVIEW-TASK T1.5）
// 复刻 Web ReviewModal.tsx 的全屏复习流（小程序以独立页承载 createPortal 全屏弹层）：
//
// - 入场自拉 /api/vocabulary/all 筛到期词（isDue && !MASTERED，无服务端池一次全量入队）
// - 四题型按数据可用性随机分配（填空/选择/中译英/猜词，对齐 assignMode）
// - 3D 翻卡：perspective 1200 + rotateY 180° + 0.6s cubic-bezier（backface-visibility 隐藏）
// - 换卡/翻面自动播词典发音（uk 优先，dictvoice 失败 TTS 合成兜底）；翻面停原声
// - 填空/中译英/猜词：输入大小写与首尾空格不敏感，答对立即翻面，回车错答 600ms 抖红
// - 选择：2×2 选项，选对 500ms 后翻面、选错标红 800ms 复位可重选
// - 读音提示：显示音标并播放一次发音（不泄露拼写）
// - SRS 四档（忘记/模糊/认识/简单）带下次间隔预览；提交 POST /api/vocabulary/review
//   本地乐观更新（失败 toast 不中断流程）；键盘快捷键为 Web 专属，移动端不移植
// - 总结页：四格统计 + 逐词结果 + 「再来一轮 (N个)」仅重测忘记子集
const vocabCore = require('../../../utils/vocab-core');
const srs = require('../../../utils/srs');
const { get, post } = require('../../../utils/request');
const tts = require('../../../utils/tts');
const audioClip = require('../../../utils/audio-clip');

const QUALITY_LABELS = ['忘记', '模糊', '认识', '简单'];

Page({
  data: {
    loading: true,
    queue: [],
    modes: [],
    choiceOptions: [],
    index: 0,
    flipped: false,
    inputValue: '',
    showHint: false,
    selectedChoice: null, // 当前选中选项下标（答对锁定 / 答错短暂标红）
    inputWrong: false,
    submitting: false,
    results: [], // {vocabularyid, word, quality, qualityLabel, qualityCls}
    showSummary: false,
    summary: { forgot: 0, hard: 0, good: 0, easy: 0, total: 0 },
    progress: 0,
    modeLabel: '',
    inputSlotWidth: 160, // 填空输入框宽度（rpx，随词长）
    playingText: '',
    origKey: '',
    origLoading: '',
    showPremiumModal: false,
    premiumSource: '',
  },

  onLoad() {
    this._list = []; // 全量列表（乐观更新 + 再来一轮过滤）
    this.initQueue();
    this._unsubTts = tts.subscribe(() => this.syncAudioState());
    this._unsubClip = audioClip.subscribe(() => this.syncAudioState());
    // TTS 配额弹窗自持（朗读句子可能触墙）：入栈保存宿主 handler、退栈恢复
    this._prevQuota = tts.getQuotaHandler();
    tts.setQuotaHandler((source) => {
      this.setData({ showPremiumModal: true, premiumSource: source });
    });
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

  /** 组装复习队列（初次与「再来一轮」共用）：题型分配 + 选项 + 间隔预览 */
  setupQueue(dueItems) {
    if (!dueItems.length) {
      wx.showToast({ title: '暂无到期生词', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }
    const queue = dueItems.map((item) => {
      const d = vocabCore.decorateItem(item);
      d.hiddenParts = vocabCore.splitHidden(item.contextSentence, item.word);
      d.intervalPreviews = {
        forgot: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.FORGOT),
        hard: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.HARD),
        good: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.GOOD),
        easy: srs.getIntervalLabel(item.proficiency, srs.ReviewQuality.EASY),
      };
      return d;
    });
    const modes = queue.map((item) => {
      let m = vocabCore.assignMode(item, queue.length, Math.random);
      // 防御降级（assignMode 已按数据可用性分配，此处兜底数据残缺的边缘态）：
      // 猜词无英文释义 / 填空句挖不出槽 → 回落中译英（Web renderDefGuess 同款后路）
      if (m === 'def_guess' && !item.guessDef) m = 'cn_to_en';
      if (
        m === 'fill_blank' &&
        !item.hiddenParts.some((seg) => seg.type === 'slot')
      ) {
        m = 'cn_to_en';
      }
      return m;
    });
    const choiceOptions = vocabCore.generateChoiceOptions(queue, Math.random);
    this.setData(
      {
        loading: false,
        queue,
        modes,
        choiceOptions,
        index: 0,
        flipped: false,
        results: [],
        showSummary: false,
        summary: vocabCore.summaryStats([]),
      },
      () => this.resetPerCard(true),
    );
  },

  /** 换卡复位 + 自动播发音（对齐 Web useEffect [currentReviewIndex, isCardFlipped]） */
  resetPerCard(autoPlay) {
    const item = this.data.queue[this.data.index];
    if (!item) return;
    const mode = this.data.modes[this.data.index] || 'cn_to_en';
    const slot = item.word
      ? Math.max(Math.min(item.word.length, 16) * 28, 120)
      : 160;
    this.setData({
      inputValue: '',
      showHint: false,
      selectedChoice: null,
      inputWrong: false,
      flipped: false,
      modeLabel: vocabCore.MODE_LABELS[mode] || '复习',
      inputSlotWidth: slot,
      progress: ((this.data.index + 0) / this.data.queue.length) * 100,
    });
    if (autoPlay) this.autoPlayWord(item);
  },

  /** 换卡/翻面自动播发音：uk 优先 us 兜底（对齐 Web audioUrl 取值顺序） */
  autoPlayWord(item) {
    audioClip.stop();
    const dict = item.dictData || {};
    const url =
      (dict.audio_urls && (dict.audio_urls.uk || dict.audio_urls.us)) || null;
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

  /* ---------------- 正面交互 ---------------- */

  onShowAnswer() {
    this.setData({
      flipped: true,
      progress: ((this.data.index + 1) / this.data.queue.length) * 100,
    });
    // 翻面自动播发音（对齐 Web effect）
    const item = this.data.queue[this.data.index];
    if (item) this.autoPlayWord(item);
  },

  /** 填空/中译英/猜词共用输入：答对立即翻面（实时判定，对齐 handleInputChange） */
  onAnswerInput(e) {
    const val = e.detail.value || '';
    const item = this.data.queue[this.data.index];
    this.setData({ inputValue: val, inputWrong: false });
    if (item && vocabCore.checkAnswer(val, item.word)) {
      this.setData({
        flipped: true,
        progress: ((this.data.index + 1) / this.data.queue.length) * 100,
      });
      this.autoPlayWord(item);
    }
  },

  /** 回车确认：错答 600ms 抖红（对齐 handleInputKeyDown） */
  onAnswerConfirm(e) {
    const val = (e.detail.value || '').trim();
    const item = this.data.queue[this.data.index];
    if (!item) return;
    if (val && !vocabCore.checkAnswer(val, item.word)) {
      this.setData({ inputWrong: true });
      if (this._wrongTimer) clearTimeout(this._wrongTimer);
      this._wrongTimer = setTimeout(
        () => this.setData({ inputWrong: false }),
        600,
      );
    }
  },

  /** 选择题：对 500ms 翻面 / 错 800ms 复位（对齐 handleChoiceSelect） */
  onChoiceTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const options = this.data.choiceOptions[this.data.index];
    if (!options) return;
    // 已答对锁定
    if (this.data.selectedChoice === options.correctIndex) return;
    if (idx === options.correctIndex) {
      this.setData({ selectedChoice: idx });
      if (this._choiceTimer) clearTimeout(this._choiceTimer);
      this._choiceTimer = setTimeout(() => {
        this.setData({
          flipped: true,
          progress: ((this.data.index + 1) / this.data.queue.length) * 100,
        });
        const item = this.data.queue[this.data.index];
        if (item) this.autoPlayWord(item);
      }, 500);
    } else {
      this.setData({ selectedChoice: idx });
      if (this._choiceTimer) clearTimeout(this._choiceTimer);
      this._choiceTimer = setTimeout(
        () => this.setData({ selectedChoice: null }),
        800,
      );
    }
  },

  /** 读音提示：显示音标并播一次发音（不泄露拼写） */
  onHintTap() {
    const item = this.data.queue[this.data.index];
    if (!item) return;
    audioClip.stop();
    const dict = item.dictData || {};
    const url =
      (dict.audio_urls && (dict.audio_urls.us || dict.audio_urls.uk)) ||
      item.speakUrl ||
      null;
    this.setData({ showHint: true });
    tts.playUrl(url, item.word);
  },

  /** 读音提示后再次播放 */
  onHintPlay() {
    const item = this.data.queue[this.data.index];
    if (!item) return;
    const dict = item.dictData || {};
    const url =
      (dict.audio_urls && (dict.audio_urls.us || dict.audio_urls.uk)) ||
      item.speakUrl ||
      null;
    tts.playUrl(url, item.word);
  },

  onPlaySentence(e) {
    const text = e.currentTarget.dataset.text;
    if (text) tts.speak(text);
  },

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

  onPlayPhon(e) {
    const { url, word } = e.currentTarget.dataset;
    tts.playUrl(url, word);
  },

  onCopyDict(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '词典链接已复制', icon: 'none' }),
    });
  },

  /* ---------------- SRS 提交与流转 ---------------- */

  async onQualityTap(e) {
    if (this.data.submitting) return;
    const quality = Number(e.currentTarget.dataset.quality);
    const item = this.data.queue[this.data.index];
    if (!item) return;

    const results = this.data.results.concat([
      {
        vocabularyid: item.vocabularyid,
        word: item.word,
        quality,
        qualityLabel: QUALITY_LABELS[quality] || '',
        qualityCls: 'vr-q--' + quality,
      },
    ]);
    this.setData({ results, submitting: true });

    // POST 复习打卡：成功本地乐观更新（失败 toast 不中断，对齐 handleSRS）
    try {
      const res = await post('/api/vocabulary/review', {
        vocabularyid: item.vocabularyid,
        quality,
      });
      if (res && res.success && res.data) {
        const updated = res.data;
        this._list = this._list.map((v) =>
          v.vocabularyid === updated.vocabularyid
            ? Object.assign({}, v, {
                proficiency: updated.proficiency,
                nextReviewAt: updated.nextReviewAt,
              })
            : v,
        );
      } else {
        throw new Error('save failed');
      }
    } catch (err) {
      wx.showToast({ title: '网络错误，保存进度失败', icon: 'none' });
    }

    const isLast = this.data.index >= this.data.queue.length - 1;
    if (isLast) {
      this.setData({
        showSummary: true,
        submitting: false,
        progress: 100,
        summary: vocabCore.summaryStats(results),
      });
      tts.stop();
      audioClip.stop();
    } else {
      this.setData({
        submitting: false,
        index: this.data.index + 1,
      });
      this.resetPerCard(true);
    }
  },

  /** 再来一轮：仅重测忘记子集（对齐 retryForgotten，从乐观更新后的全量列表取） */
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
});
