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
//
// [SRS] 真遗忘曲线（与 Web ReviewDeck / 生词本同口径）：
// - 卡背四档打卡（忘记/模糊/认识/简单 + 间隔预览）三模式通用免费——
//   POST /api/sentences/review 更新 proficiency/nextReviewAt（Leitner 阶梯）
// - srs 模式 = buildDueDeck 到期队列（nextReviewAt 升序）
// - 三模式走完最后一张均进总结屏（四档统计 + 跳过数 + 再来一轮忘记子集；
//   sequential/tag 另有「继续刷」回第 0 张承接原回环浏览）；
//   左滑/下一句 = 跳过不评分
const sentenceCore = require('../../../utils/sentence-core');
const audioClip = require('../../../utils/audio-clip');
const membershipStore = require('../../../store/membershipStore');
const theme = require('../../../utils/theme');
const srs = require('../../../utils/srs');
const { get, post } = require('../../../utils/request');

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

    // [SRS] 打卡会话状态
    submitting: false,       // 四档打卡请求中（按钮置灰防双击）
    sessionDone: false,      // srs 模式走完队列 → 总结屏
    summary: null,           // {forgot,hard,good,easy,forgottenCount,skipped,isRetry}
    srsDueEmpty: false,      // srs 模式到期队列为空 → 「今日已完成」态

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
    this._ratings = []; // 本轮打卡记录 [{id, quality}]（总结统计 + 忘记子集再来一轮）
    this._retryIds = null; // 再来一轮的忘记子集（null = 首轮全量）
    this._deepLinked = !!(options && options.subtitleId); // 深链进入：定位优先，不自动切 srs
    this._autoModePending = true; // 会员/管理员默认 srs（用户手选模式即失效）
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
      this._autoModeByMembership(); // 乐观快照命中时直接以 srs 组卷（免二次重建）
      this._applyMode(true);
      membershipStore.ensureFresh().then(() => {
        const { isPremium } = membershipStore.getState();
        if (isPremium !== this.data.isPremium) this.setData({ isPremium });
        this._autoModeByMembership(); // 快照滞后（本地 role 是展示缓存）时权威校正兜底
      });
    } catch (err) {
      this.setData({ loading: false, loadError: '加载失败，请重试' });
    }
  },

  /**
   * 会员/管理员默认 srs 模式（isPremium = PREMIUM|ADMIN，membershipStore 权威口径）。
   * 越权守卫：用户已手动选过模式（onModeTap 置 _autoModePending=false）或
   * 深链进入（subtitleId 定位优先，srs 队列未必包含目标句）时不覆盖。
   */
  _autoModeByMembership() {
    if (!this._autoModePending || this._deepLinked) return;
    const { isPremium } = membershipStore.getState();
    if (!isPremium) return;
    this._autoModePending = false;
    this.setData({ mode: 'srs' });
    this._applyMode(false);
  },

  /** 模式/标签 → 卡组重算（srs = [SRS] 到期队列 buildDueDeck；tag = 子集组卷；
   *  再来一轮 = 忘记子集内重建。换组即新会话：总结态清零） */
  _applyMode(keepIndex) {
    const mode = this.data.mode;
    const tag = this.data.selectedTag;
    const source = this._retryIds
      ? this._all.filter((s) => this._retryIds.indexOf(s.id) >= 0)
      : this._all;
    let deck = source;
    if (mode === 'tag' && tag) {
      deck = source.filter((s) => (s.tags || []).indexOf(tag) >= 0);
    } else if (mode === 'srs') {
      deck = sentenceCore.buildDueDeck(source);
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
      sessionDone: false,
      summary: null,
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

  /** 当前卡派生 + 进度（WXML 零方法调用；含 [SRS] 间隔预览预计算） */
  _applyCard() {
    const deck = this._deck;
    const index = this.data.currentIndex;
    const card = deck[index] || null;
    if (card) {
      // 四档「下次间隔预览」（vocab-review current.intervalPreviews 同款口径）
      card.intervalPreviews = {
        forgot: srs.getIntervalLabel(card.proficiency || 0, srs.ReviewQuality.FORGOT),
        hard: srs.getIntervalLabel(card.proficiency || 0, srs.ReviewQuality.HARD),
        good: srs.getIntervalLabel(card.proficiency || 0, srs.ReviewQuality.GOOD),
        easy: srs.getIntervalLabel(card.proficiency || 0, srs.ReviewQuality.EASY),
      };
    }
    this.setData({
      card,
      deckCount: deck.length,
      progressPercent: deck.length ? ((index + 1) / deck.length) * 100 : 0,
      indexLabel: (index + 1) + ' / ' + deck.length,
      isEmpty: deck.length === 0,
      // srs 到期队列空 → 「今日已完成」态（区别于句库为空）
      srsDueEmpty: this.data.mode === 'srs' && deck.length === 0,
    });
  },

  /* ---------------- 模式选择器（三模式）与成就 ---------------- */

  onModeTap(e) {
    const next = e.currentTarget.dataset.mode;
    this._autoModePending = false; // 用户显式选择：会员默认 srs 不再越权覆盖
    if (next === this.data.mode) return;
    if (next !== 'sequential' && !this.data.isPremium) {
      // 高级模式 PRO 专属：免费点击弹会员窗，不切换
      this.setData({ showPremiumModal: true, premiumSource: 'sentence_review_advanced' });
      return;
    }
    // 换模式 = 新会话：清打卡记录与忘记子集
    this._ratings = [];
    this._retryIds = null;
    this.setData({ mode: next, selectedTag: next !== 'tag' ? '' : this.data.selectedTag });
    this._applyMode(false);
  },

  onTagTap(e) {
    const tag = e.currentTarget.dataset.tag;
    this._ratings = [];
    this._retryIds = null;
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

  /** 下一句（任意模式走完最后一张 → 总结屏；左滑=跳过不评分；
   *  原回环浏览改由总结屏「继续刷」显式承接） */
  onNext() {
    if (this.data.currentIndex >= this.data.deckCount - 1) {
      this._bumpFlip();
      this._finishSession();
      return;
    }
    this._bumpFlip();
    const next = this.data.currentIndex < this.data.deckCount - 1 ? this.data.currentIndex + 1 : 0;
    this.setData({ currentIndex: next, flipped: false });
    this._applyCard();
    audioClip.stop(); // 切卡停止音频（Web 同款）
  },

  /* ---------------- [SRS] 四档打卡 + 会话收尾 ---------------- */

  /** 卡背四档打卡：乐观更新 → POST /api/sentences/review → 权威覆写 → 前进/收尾 */
  async onQualityTap(e) {
    if (this.data.submitting || !this.data.card) return;
    const quality = Number(e.currentTarget.dataset.q);
    const card = this.data.card;
    this.setData({ submitting: true });
    // 乐观更新（Leitner 前置演算；失败回滚）
    const prev = { proficiency: card.proficiency || 0, nextReviewAt: card.nextReviewAt || null };
    const opt = srs.calculateNextReview(prev.proficiency, quality);
    this._patchItem(card.id, opt.proficiency, opt.nextReviewAt);
    try {
      const res = await post('/api/sentences/review', { id: card.id, quality });
      if (!(res && res.success)) throw new Error('打卡失败'); // 业务失败：request.js 已 toast，catch 回滚
      const d = res.data || {};
      // 服务端权威值覆写（与乐观值同口径；返回缺字段时沿用乐观值防御）
      this._patchItem(
        card.id,
        typeof d.proficiency === 'number' ? d.proficiency : opt.proficiency,
        d.nextReviewAt || opt.nextReviewAt,
      );
      this._ratings.push({ id: card.id, quality });
      this.setData({ flipped: false });
      this._advanceAfterRating();
    } catch (err) {
      this._patchItem(card.id, prev.proficiency, prev.nextReviewAt);
      // 200+success:false 的业务失败 request.js 不提示（仅 4xx/5xx/网络才统一
      // toast），这里补提示；ApiError 说明已提示过，不重复弹
      if (!err || err.name !== 'ApiError') {
        wx.showToast({ title: (err && err.message) || '打卡失败', icon: 'none' });
      }
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 同步 _all/_deck/data.card 三处的调度字段（乐观更新与权威覆写共用） */
  _patchItem(id, proficiency, nextReviewAt) {
    const patch = (s) => (s.id === id
      ? Object.assign({}, s, { proficiency: proficiency, nextReviewAt: nextReviewAt })
      : s);
    this._all = this._all.map(patch);
    this._deck = this._deck.map(patch);
    if (this.data.card && this.data.card.id === id) {
      this.setData({ card: patch(this.data.card) });
    }
  },

  /** 打卡后前进（与 onNext 同款收尾判定：打完最后一张即一轮完成 → 总结屏） */
  _advanceAfterRating() {
    this._bumpFlip();
    if (this.data.currentIndex >= this.data.deckCount - 1) {
      this._finishSession();
      return;
    }
    const next = this.data.currentIndex + 1;
    this.setData({ currentIndex: next, flipped: false });
    this._applyCard();
    audioClip.stop();
  },

  /** 翻卡成就计数（PRO 每 10 张 toast；收尾那张同样计入——Web bumpFlipAchievement 同款） */
  _bumpFlip() {
    const flipCount = this.data.flipCount + 1;
    this.setData({ flipCount });
    if (this.data.isPremium && flipCount % 10 === 0) {
      wx.showToast({ title: '🔥 连续翻卡 ' + flipCount + ' 张，复习节奏稳住了！', icon: 'none' });
    }
    return flipCount;
  },

  /** 会话收尾：总结屏（四档统计 + 跳过数 + 忘记子集计数 + 文案分轨预计算） */
  _finishSession() {
    const r = this._ratings;
    const count = (q) => r.filter((x) => x.quality === q).length;
    const isRetry = !!this._retryIds;
    this.setData({
      sessionDone: true,
      progressPercent: 100,
      summary: {
        forgot: count(0),
        hard: count(1),
        good: count(2),
        easy: count(3),
        forgottenCount: count(0),
        skipped: Math.max(0, this.data.deckCount - r.length),
        isRetry,
        titleText: isRetry ? '忘记的句子重测完毕' : '本轮刷句复习完成',
        subText: isRetry
          ? '忘记的句子已重测完毕。'
          : this.data.mode === 'srs'
            ? '到期队列已清空，下次复习时间已按遗忘曲线排期。'
            : '已刷完一轮 ' + this.data.deckCount + ' 张，翻面打卡的句子已按遗忘曲线排期。',
      },
    });
    audioClip.stop();
  },

  /** 再来一轮：只重测忘记子集（FORGOT 打卡后仍到期；vocab retryForgotten 同款） */
  onRetryTap() {
    const ids = this._ratings
      .filter((x) => x.quality === 0)
      .map((x) => x.id);
    if (!ids.length) return;
    this._retryIds = ids;
    this._ratings = [];
    this._applyMode(false);
  },

  /** 继续刷：回环浏览的显式承接（sequential/tag；回第 0 张开新一轮。
   *  srs 不提供——到期队列已清空，继续走「今日已完成」语义） */
  onContinueBrowse() {
    this._ratings = [];
    this._retryIds = null;
    this._applyMode(false);
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
