// pages/review/practice — 发音闯关复习（REVIEW-TASK T4.5）
// 完整复刻 Android WeaknessPracticeScreen.kt + WeaknessPracticeViewModel.kt：
// 四态（loading / 403 整页锁定 / 错误重试 / 空弱项集完成态）→ 主态 = 顶栏
// （返回 + 「发音闯关复习 (i+1/N)」titleMedium 700 + 已达标徽章 primary@0.1
// 全圆 pill 内 CheckCircle 15dp）→ LinearProgressIndicator 6dp 圆头（progress
// = (index+1)/N）→ 评测卡（eval-card 闯关形态：三播放钮 + 最近得分居右，收藏/
// 循环隐藏）→ 底部 Surface tonalElevation 2dp：OutlinedButton(KeyboardArrowLeft
// 上一题，index>0 且非评测中) | Button(下一题/完成复习 + KeyboardArrowRight)。
//
// - 数据：GET /api/speech/errors（weakThreshold/totalErrors/isTrialMode 在信封
//   顶层）；403 → isLocked；records 空 → EmptyPane「没有待复习的弱项」
// - 达标：eval-card evaluate 事件 score ≥ weakThreshold → completed 集合 +
//   （顶栏徽章口径，Android 同为内存态不持久化）
// - 换题：phase 置 IDLE、结果清空（Android switchQuestion 不缓存已答）
// - 深链 ?subtitleId= 定位初始题（未命中回落 0）
// - 【Web 口径恢复 2026-09-27】①复习日池预检 GET /api/speech/quota?scenario=
//   review（入口即知余量；触墙卡置锁；每次评测后经 eval-card quota 事件刷新）；
//   ②配额余量胶囊「今日剩余 N 次免费评测」（非会员且已预检才显示；N < 3 转
//   琥珀 + workspace_premium + 「，明日额度自动就位」）；③试用结算墙「成就
//   先行」——isTrialMode 走到末题：攻克横幅「今日攻克 N/M」+「还有 L 条弱项
//   句子待攻克」+ 右钮变形琥珀「下一关 · 解锁 PRO」→ premium-modal(
//   pronunciation_locked, {totalErrors: lockedCount})（PRO/全量末钮仍为
//   「完成复习」返回）
// - 解锁 CTA：Android 为 toast「订阅功能即将上线」+ 返回；小程序按 T4.4 权限
//   表口径升级为 premium-modal(pronunciation_locked)
const core = require('../../../utils/pron-core');
const theme = require('../../../utils/theme');
const { get } = require('../../../utils/request');

Page({
  data: {
    loading: true,
    isLocked: false,
    loadError: '',
    isEmpty: false,
    // 主态
    index: 0,
    total: 0,
    progressPercent: 0,
    isCompleted: false,
    isLast: false,
    evaluating: false, // 评测中（底部两钮禁用，Android EVALUATING 口径）
    prevDisabled: true,
    weakThreshold: 80, // 达标分数线（errors 信封顶层；卡片 Excellent 档同源）
    // 配额（Web [P3-c] 口径：预检 + 余量胶囊 + 触墙置锁）
    quotaRemaining: null,
    quotaIsPremium: true,
    quotaLocked: false,
    quotaWarn: false,  // 余量 < 闯完一关题量（3）→ 琥珀预警 + 皇冠 + 明日提示
    showQuota: false,
    quotaText: '',
    // 试用结算（Web [P3-c] 成就先行：isTrialMode 走到末题触发）
    showSettlement: false,
    completedCount: 0,
    lockedCount: 0,
    premiumVars: null,
    // eval-card props
    subtitle: null,
    subtitleId: null,
    episodeId: '',
    episodeTitle: '',
    cardKey: '',
    // 会员窗（锁定态解锁 CTA）
    showPremiumModal: false,
    // 外观
    themeClass: '',
    dark: false,
    statusBarH: 20,
  },

  onLoad(options) {
    this._records = [];
    this._completed = new Set(); // 已达标题目下标集
    this._weakThreshold = core.DEFAULT_WEAK_SCORE_THRESHOLD;
    this._totalErrors = 0;
    this._isTrialMode = false;
    this._deepLinkSubtitleId = options && options.subtitleId ? String(options.subtitleId) : '';
    this._syncTheme();
    try {
      this.setData({ statusBarH: wx.getWindowInfo().statusBarHeight || 20 });
    } catch (e) { /* 基础库兜底 */ }
    this.load();
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

  async load() {
    this.setData({ loading: true, isLocked: false, loadError: '', isEmpty: false });
    try {
      const res = await get('/api/speech/errors');
      const parsed = core.parseErrors(res);
      if (!parsed) {
        this.setData({ loading: false, loadError: '弱项本数据加载失败' });
        return;
      }
      this._records = parsed.records;
      this._weakThreshold = parsed.weakThreshold;
      this._totalErrors = parsed.totalErrors;
      this._isTrialMode = parsed.isTrialMode;
      this.setData({
        weakThreshold: parsed.weakThreshold,
        isTrialMode: parsed.isTrialMode,
        totalErrors: parsed.totalErrors,
      });
      if (!this._records.length) {
        // 空弱项集：仅停 loading（Android 同款，EmptyPane 接管）
        this.setData({ loading: false, isEmpty: true });
        return;
      }
      // 深链定位（subtitleId 命中；未命中回落 0）
      let index = 0;
      if (this._deepLinkSubtitleId) {
        index = this._records.findIndex(
          (r) => r.subtitleId !== null && String(r.subtitleId) === this._deepLinkSubtitleId,
        );
      }
      this.setData({ loading: false, isEmpty: false });
      this._applyQuestion(index >= 0 ? index : 0);
      this._preflightQuota();
    } catch (err) {
      if (err && err.statusCode === 403) {
        // 403 = 弱项练习为 PRO 会员功能（整页锁定态）
        this.setData({ loading: false, isLocked: true });
        return;
      }
      this.setData({
        loading: false,
        loadError: (err && err.statusCode === 401 && '请先登录后查看') ||
          (err && err.message) || '弱项本数据加载失败',
      });
    }
  },

  /** 换题（Android switchQuestion：phase IDLE / 结果清空 / 不缓存已答） */
  _applyQuestion(index) {
    const rec = this._records[index];
    if (!rec) return;
    // 换句先置空（eval-card observers 重置录音/结果态）
    this.setData({ subtitle: null });
    const card = core.buildPracticeCard(rec);
    const completed = this._completed.has(index);
    this.setData({
      index,
      total: this._records.length,
      progressPercent: ((index + 1) / this._records.length) * 100,
      isCompleted: completed,
      isLast: index === this._records.length - 1,
      evaluating: false,
      prevDisabled: index <= 0,
      subtitle: card.subtitle,
      subtitleId: card.subtitleId,
      episodeId: card.episodeId,
      episodeTitle: card.episodeTitle,
      cardKey: 'pr-' + rec.recognitionid,
    });
    this._syncSettlement();
  },

  /* ---------------- 配额（Web [P3-c] 口径恢复） ---------------- */

  /** 复习日池预检：入口即知余量，避免半路触墙；触墙 → 卡置锁 */
  async _preflightQuota() {
    try {
      const res = await get('/api/speech/quota?scenario=review');
      if (res && res.success && res.data) this._applyQuota(res.data);
    } catch (e) {
      // 预检失败不置锁（评测 403 时 eval-card 自会永久置锁）
    }
  },

  /**
   * 配额状态归一（Web refreshQuota：remaining/isPremium/exhausted 三字段）。
   * 余量 < 闯完一关的题量（FREE_VISIBLE_ERRORS=3）转琥珀预警。
   */
  _applyQuota(q) {
    const src = q || {};
    const remaining = typeof src.remaining === 'number'
      ? src.remaining : this.data.quotaRemaining;
    const isPremium = typeof src.isPremium === 'boolean'
      ? src.isPremium : this.data.quotaIsPremium;
    const warn = !isPremium && remaining !== null &&
      remaining < core.FREE_VISIBLE_ERRORS;
    this.setData({
      quotaRemaining: remaining,
      quotaIsPremium: isPremium,
      quotaLocked: !!src.exhausted,
      quotaWarn: warn,
      showQuota: !isPremium && remaining !== null,
      quotaText: '今日剩余 ' + remaining + ' 次免费评测' +
        (warn ? '，明日额度自动就位' : ''),
    });
  },

  /** eval-card quota 事件（每次评测后余量刷新；403 触墙仅 {exhausted:true}） */
  onQuota(e) {
    this._applyQuota(e.detail || {});
  },

  /** 试用结算派生（Web showSettlement = isLast && isTrialMode；
   *  lockedCount = totalErrors − 可见切片数） */
  _syncSettlement() {
    const lockedCount = Math.max(0, this._totalErrors - this._records.length);
    this.setData({
      completedCount: this._completed.size,
      lockedCount,
      showSettlement: this.data.isLast && this._isTrialMode,
    });
  },

  /* ---------------- eval-card 事件 ---------------- */

  /** 评测完成：score ≥ weakThreshold → 达标集合 +（顶栏徽章 + 结算横幅计数） */
  onEvaluate(e) {
    const detail = e.detail || {};
    if (typeof detail.score === 'number' && detail.score >= this._weakThreshold) {
      this._completed.add(this.data.index);
      this.setData({ isCompleted: true });
      this._syncSettlement();
    }
  },

  /** 相变联动底部导航（Android enabled = phase != EVALUATING） */
  onPhaseChange(e) {
    const evaluating = (e.detail || {}).phase === 'processing';
    if (evaluating !== this.data.evaluating) this.setData({ evaluating });
  },

  /* ---------------- 题目流转 ---------------- */

  onPrev() {
    if (this.data.index <= 0 || this.data.evaluating) return;
    this._applyQuestion(this.data.index - 1);
  },

  onNext() {
    if (this.data.evaluating) return;
    if (this.data.isLast) {
      // 试用结算（Web [P3-c] 成就先行）：末钮转 PRO → 会员转化；
      // 全量/会员仍为「完成复习」返回弱项本
      if (this.data.showSettlement) {
        this.setData({
          showPremiumModal: true,
          premiumVars: { totalErrors: this.data.lockedCount },
        });
        return;
      }
      this.onExit();
      return;
    }
    this._applyQuestion(this.data.index + 1);
  },

  /* ---------------- 通用动作 ---------------- */

  onExit() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/review/index' }),
    });
  },

  onRetry() {
    this.load();
  },

  onUnlock() {
    this.setData({ showPremiumModal: true, premiumVars: null });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },
});
