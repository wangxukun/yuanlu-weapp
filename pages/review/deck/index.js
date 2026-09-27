// pages/review/deck — 刷句复习卡片流（REVIEW-TASK T3.3）
// 复刻 Web app/(main)/library/sentences/review/ReviewDeck.tsx：
// 顺序遍历、到末尾回环；点击卡片翻面（译文/笔记），左滑下一句、右滑重听原音；
// 背景堆叠卡 + 手势角标 + 底部单手操作坞；顶部进度条 + 三模式选择器 + 翻卡成就。
//
// 手势阈值（Web 源码逐字）：rotate = dx/200×15°（±15 封顶）；角标透明度
// 左 [-150,-40]→[1,0] / 右 [40,150]→[0,1]；松手 offset < -90 或 velocity <
// -400px/s → 下一句；offset > 90 或 velocity > 400 → 重听；|dx| < 10 才算点击翻面。
//
// 权限：顺序模式永久免费；tag/srs 为 PRO（免费点击弹 sentence_review_advanced）；
// 连续翻卡成就 PRO 专属（每 10 张 toast），免费点成就入口仅弹会员窗。
const sentenceCore = require('../../../utils/sentence-core');
const audioClip = require('../../../utils/audio-clip');
const membershipStore = require('../../../store/membershipStore');
const theme = require('../../../utils/theme');
const { get } = require('../../../utils/request');

// 手势常量（Web 同源）
const ROTATE_RANGE = 200; // dx ±200 → ±15°
const CUE_NEAR = 40;      // 角标开始显现的位移
const CUE_FULL = 150;     // 角标全显的位移
const SWIPE_OFFSET = 90;  // 松手位移阈值
const SWIPE_VELOCITY = 400; // 松手速度阈值 px/s
const TAP_SLOP = 10;      // 点击防误触位移

Page({
  data: {
    loading: true,
    loadError: '',
    isEmpty: false,
    isPremium: false,

    mode: 'sequential', // sequential | tag | srs
    selectedTag: '',
    tagOptions: [], // [{name, count}] 计数降序
    currentIndex: 0,
    deckCount: 0,
    progressPercent: 0,
    indexLabel: '1 / 1',

    flipped: false,
    flipCount: 0,
    playingKey: '',

    // 当前卡（WXML 就绪：enParts accent 高亮分词 + meta）
    card: null,

    // 手势跟手状态（touchmove 高频 setData 只下发这四个标量）
    dx: 0,
    rotate: 0,
    cueLeftOp: 0,
    cueRightOp: 0,
    dragging: false,

    showPremiumModal: false,
    premiumSource: '',
    showHelp: false,

    themeClass: '',
    dark: false,
  },

  onLoad(options) {
    this._all = []; // 全量 SavedSentenceItem（服务端收藏序）
    this._vocab = []; // {word, definition}[]
    this._linked = []; // 联动词汇（统计与高亮同源）
    this._deck = []; // 当前模式卡组（装饰后）
    this._initialSubtitleId = (options && options.subtitleId) || '';
    this._unsubClip = audioClip.subscribe((s) => {
      const k = (s && s.playingKey) || '';
      if (k !== this.data.playingKey) this.setData({ playingKey: k });
    });
    this._syncTheme();
    this.loadData();
  },

  onUnload() {
    if (this._unsubClip) this._unsubClip();
    audioClip.stop();
  },

  onShow() {
    this._syncTheme();
    // 影子跟读返回带回的句定位（globalData 暂存，消费即清）
    try {
      const app = getApp();
      const focus = app && app.globalData && app.globalData.deckFocusSubtitleId;
      if (focus && this._deck.length) {
        app.globalData.deckFocusSubtitleId = '';
        const idx = this._deck.findIndex(
          (s) => s.subtitleId !== null && String(s.subtitleId) === String(focus),
        );
        if (idx >= 0 && idx !== this.data.currentIndex) {
          this.setData({ currentIndex: idx, flipped: false });
          this._applyCard();
        }
      }
    } catch (e) { /* globalData 不可用时忽略 */ }
  },

  _syncTheme() {
    this.setData({
      themeClass: theme.rootClass(),
      dark: theme.getEffective() === 'dark',
    });
    // 手动深/浅色下重申原生导航栏（胶囊/标题行背景），对齐 vocab-review 等页
    theme.applyChrome();
  },

  /* ---------------- 数据加载 ---------------- */

  async loadData() {
    try {
      const [sentencesRes, vocabRes] = await Promise.all([
        get('/api/sentences/list').catch(() => null),
        get('/api/vocabulary/all').catch(() => null),
      ]);
      if (sentencesRes && sentencesRes.success && Array.isArray(sentencesRes.data)) {
        this._all = sentenceCore.parseSentences(sentencesRes);
      }
      if (vocabRes && vocabRes.success && Array.isArray(vocabRes.data)) {
        this._vocab = vocabRes.data.map((v) => ({ word: v.word, definition: v.definition || null }));
      }
      this._linked = sentenceCore.filterLinkedVocabWords(this._vocab, this._all);
      this.setData({ loading: false, isEmpty: this._all.length === 0 });
      if (!this._all.length) return;
      this._applyMode(true);
      membershipStore.ensureFresh().then(() => {
        const { isPremium } = membershipStore.getState();
        if (isPremium !== this.data.isPremium) this.setData({ isPremium });
      });
    } catch (err) {
      this.setData({ loading: false, loadError: '加载失败，请重试' });
    }
  },

  /** 模式/标签 → 卡组重算（srs = 最久收藏优先 createAt 升序；tag = 子集组卷） */
  _applyMode(keepIndex) {
    const mode = this.data.mode;
    const tag = this.data.selectedTag;
    let deck = this._all;
    if (mode === 'tag' && tag) {
      deck = this._all.filter((s) => (s.tags || []).indexOf(tag) >= 0);
    } else if (mode === 'srs') {
      deck = this._all.slice().sort((a, b) => String(a.createAt).localeCompare(String(b.createAt)));
    }
    this._deck = deck.map((s) => sentenceCore.decorateSentence(s, this._linked));

    // 标签候选：句库实际出现的标签（计数降序）
    const countMap = {};
    this._all.forEach((s) => (s.tags || []).forEach((t) => {
      countMap[t] = (countMap[t] || 0) + 1;
    }));
    const tagOptions = Object.keys(countMap)
      .map((name) => ({ name, count: countMap[name] }))
      .sort((a, b) => b.count - a.count);

    let index = keepIndex ? this._initialIndex() : 0;
    if (index >= this._deck.length) index = 0;
    this._initialSubtitleId = ''; // 深链只用于首次定位
    this.setData({
      tagOptions,
      currentIndex: index,
      flipped: false,
    });
    this._applyCard();
  },

  /** 深链定位：findIndex(String(s.subtitleId) === id)，未命中回落 0 */
  _initialIndex() {
    if (!this._initialSubtitleId) return 0;
    const idx = this._deck.findIndex(
      (s) => s.subtitleId !== null && String(s.subtitleId) === String(this._initialSubtitleId),
    );
    return idx >= 0 ? idx : 0;
  },

  /** 当前卡派生 + 进度（WXML 零方法调用） */
  _applyCard() {
    const deck = this._deck;
    const index = this.data.currentIndex;
    const card = deck[index] || null;
    this.setData({
      card,
      deckCount: deck.length,
      progressPercent: deck.length ? ((index + 1) / deck.length) * 100 : 0,
      indexLabel: (index + 1) + ' / ' + deck.length,
      isEmpty: deck.length === 0,
    });
  },

  /* ---------------- 模式选择器（三模式）与成就 ---------------- */

  onModeTap(e) {
    const next = e.currentTarget.dataset.mode;
    if (next === this.data.mode) return;
    if (next !== 'sequential' && !this.data.isPremium) {
      // 高级模式 PRO 专属：免费点击弹会员窗，不切换
      this.setData({ showPremiumModal: true, premiumSource: 'sentence_review_advanced' });
      return;
    }
    this.setData({ mode: next, selectedTag: next !== 'tag' ? '' : this.data.selectedTag });
    this._applyMode(false);
  },

  onTagTap(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({ selectedTag: this.data.selectedTag === tag ? '' : tag });
    this._applyMode(false);
  },

  /** 连续翻卡成就：PRO 点击看会话计数；免费仅弹会员窗 */
  onAchievementTap() {
    if (!this.data.isPremium) {
      this.setData({ showPremiumModal: true, premiumSource: 'sentence_review_advanced' });
      return;
    }
    wx.showToast({ title: '本会话已连翻 ' + this.data.flipCount + ' 张', icon: 'none' });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },

  /* ---------------- 卡片交互 ---------------- */

  /** 重听原音（audio-clip 显式窗口 + 互斥；再点停止 toggle） */
  onReplay() {
    const card = this.data.card;
    if (!card) return;
    audioClip.play({
      key: 'deck:' + card.id,
      episodeid: card.episodeid,
      startTime: card.startTime,
      endTime: card.endTime,
    });
  },

  /** 底坞翻转钮（卡片点击翻面走手势 tap 判定） */
  onFlipToggle() {
    this.setData({ flipped: !this.data.flipped });
  },

  /** 下一句（末尾回环；翻卡成就 PRO 每 10 张 toast） */
  onNext() {
    const next = this.data.currentIndex < this.data.deckCount - 1 ? this.data.currentIndex + 1 : 0;
    const flipCount = this.data.flipCount + 1;
    this.setData({ currentIndex: next, flipped: false, flipCount });
    this._applyCard();
    audioClip.stop(); // 切卡停止音频（Web 同款）
    if (this.data.isPremium && flipCount % 10 === 0) {
      wx.showToast({ title: '🔥 连续翻卡 ' + flipCount + ' 张，复习节奏稳住了！', icon: 'none' });
    }
  },

  /** 跟读 → 影子跟读评测页（subtitleId 缺失不渲染本钮，防御同判 hasSubtitle） */
  onShadow() {
    const card = this.data.card;
    if (!card || !card.hasSubtitle) return;
    wx.navigateTo({ url: '/pages/review/shadowing/index?subtitleId=' + card.subtitleId });
  },

  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/review/index' }),
    });
  },

  /* ---------------- 拖拽手势（framer-motion drag 等价移植） ---------------- */

  onCardTouchStart(e) {
    const t = e.touches[0];
    this._drag = {
      startX: t.clientX,
      startY: t.clientY,
      prevX: t.clientX,
      prevT: Date.now(),
      lastX: t.clientX,
      lastT: Date.now(),
      locked: false, // 横向锁定（纵向手势让位页面滚动）
      moved: false,
    };
    this.setData({ dragging: true });
  },

  onCardTouchMove(e) {
    if (!this._drag) return;
    const t = e.touches[0];
    const dx0 = t.clientX - this._drag.startX;
    const dy = t.clientY - this._drag.startY;
    // 纵向手势优先（纵向位移 ≥ 横向 1.5 倍且横向未拖出阈值）：让位页面滚动
    if (!this._drag.locked) {
      if (Math.abs(dy) > Math.abs(dx0) * 1.5 && Math.abs(dx0) < SWIPE_OFFSET) {
        this._resetDrag();
        return;
      }
      if (Math.abs(dx0) > TAP_SLOP) this._drag.locked = true;
    }
    if (!this._drag.locked) return;

    const dx = dx0;
    this._drag.moved = true;
    this._drag.prevX = this._drag.lastX;
    this._drag.prevT = this._drag.lastT;
    this._drag.lastX = t.clientX;
    this._drag.lastT = Date.now();
    // rotate = dx/200×15°（±15 封顶）；角标透明度 左 [-150,-40]→[1,0] 右 [40,150]→[0,1]
    const rotate = Math.max(-15, Math.min(15, (dx / ROTATE_RANGE) * 15));
    const cueLeftOp = Math.max(0, Math.min(1, (-dx - CUE_NEAR) / (CUE_FULL - CUE_NEAR)));
    const cueRightOp = Math.max(0, Math.min(1, (dx - CUE_NEAR) / (CUE_FULL - CUE_NEAR)));
    this.setData({ dx, rotate, cueLeftOp, cueRightOp });
  },

  onCardTouchEnd() {
    if (!this._drag) return;
    const dx = this.data.dx;
    // 速度：末段位移/末段时长（px/s，framer-motion velocity 口径的近似）
    const dt = Math.max(16, this._drag.lastT - this._drag.prevT);
    const velocity = ((this._drag.lastX - this._drag.prevX) / dt) * 1000;
    const tapSlopOk = Math.abs(dx) < TAP_SLOP;
    this._resetDrag();

    if (tapSlopOk) {
      // 点击翻面（防误触：位移 < 10px）
      this.setData({ flipped: !this.data.flipped });
      return;
    }
    if (dx < -SWIPE_OFFSET || velocity < -SWIPE_VELOCITY) {
      this.onNext(); // 左滑 → 下一句
    } else if (dx > SWIPE_OFFSET || velocity > SWIPE_VELOCITY) {
      this.onReplay(); // 右滑 → 重听原音
    }
  },

  /** 手势状态归零（松手后 CSS transition 复位） */
  _resetDrag() {
    this._drag = null;
    this.setData({ dx: 0, rotate: 0, cueLeftOp: 0, cueRightOp: 0, dragging: false });
  },

  /* ---------------- 帮助弹窗 ---------------- */

  onHelpToggle() {
    this.setData({ showHelp: !this.data.showHelp });
  },

  /** 事件 noop：弹窗面板阻断冒泡用（catchtap 空字符串在部分基础库不拦截，
   *  「知道了」关掉后冒泡到遮罩再翻转一次，净效果为点不掉——走查修复） */
  noop() {},
});
