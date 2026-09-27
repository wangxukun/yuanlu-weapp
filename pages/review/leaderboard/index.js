// pages/review/leaderboard — 发音达人榜（REVIEW-TASK T4.5）
// 完整复刻 Android SpeechLeaderboardScreen.kt + SpeechLeaderboardViewModel.kt：
// 顶栏（返回 + 30dp secondary@0.12 圆角8 盒内 EmojiEvents 18dp +「发音达人榜」
// titleMedium 700 + 副行「榜单按{ruleText}排名」labelSmall osv@0.7 start-pad
// 38dp）→ 双 SegmentedPill（周期 近7天/今日 = primary 实底；维度 平均分榜/
// 勤奋榜 = secondary 实底；surface 底圆角12 pad3 内选项 labelMedium 700 圆角9
// v-pad6）→ 榜单卡（surface 圆角16 outline@0.4 边；行 = 30dp 排名位〔#1
// EmojiEvents 金 22dp / #2#3 MilitaryTech 银铜 / 其余数字 titleMedium Black
// osv@0.6〕+ 40dp 圆头像〔失败回退 primaryContainer 圆 + 首字母〕+ 昵称 +
// 右列主/副指标〕→ 吸底「我的排名」卡（primary@0.06 底 primary@0.25 边）。
//
// 四象限（period × metric）各自缓存，Tab 来回切换即时呈现；loadingKey 竞态
// 护栏（快速切换时旧响应不落地——Android 同款）；401 → toast「请先登录后查看
// 排行榜」+ 空榜呈现（Web 口径，不进错误重试态）。
const core = require('../../../utils/pron-core');
const theme = require('../../../utils/theme');
const config = require('../../../utils/config');
const { get } = require('../../../utils/request');

Page({
  data: {
    periods: core.LEADERBOARD_PERIODS,
    metrics: core.LEADERBOARD_METRICS,
    period: 'weekly',
    metric: 'score',
    ruleText: '平均综合分（≥5次评测）',
    entries: [],
    me: null,
    isLoading: true,
    loadError: '',
    themeClass: '',
    dark: false,
    statusBarH: 20,
  },

  onLoad() {
    this._boards = {};      // period|metric → { entries, me }（四象限缓存）
    this._loadingKey = '';  // 进行中请求所属象限（竞态护栏）
    this._syncTheme();
    try {
      this.setData({ statusBarH: wx.getWindowInfo().statusBarHeight || 20 });
    } catch (e) { /* 基础库兜底 */ }
    this.fetch('weekly', 'score');
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

  /* ---------------- 象限加载 ---------------- */

  selectPeriod(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.period) return;
    const metric = this.data.metric;
    this.setData({ period: key, loadError: '' });
    this._ensureLoaded(key, metric);
  },

  selectMetric(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.metric) return;
    const period = this.data.period;
    const rule = core.LEADERBOARD_METRICS.find((m) => m.key === key);
    this.setData({ metric: key, ruleText: rule ? rule.ruleText : '', loadError: '' });
    this._ensureLoaded(period, key);
  },

  onRetry() {
    this._ensureLoaded(this.data.period, this.data.metric);
  },

  _ensureLoaded(period, metric) {
    const cached = this._boards[period + '|' + metric];
    if (cached) {
      this._present(cached);
      return;
    }
    this.fetch(period, metric);
  },

  _present(board) {
    this.setData({ entries: board.entries, me: board.me, isLoading: false, loadError: '' });
  },

  fetch(period, metric) {
    const key = period + '|' + metric;
    this._loadingKey = key;
    // 未缓存象限：先清旧榜（Android board==null 语义——加载中/失败不呈现
    // 其他象限的陈旧数据）
    this.setData({ isLoading: true, loadError: '', entries: [], me: null });
    get('/api/speech/leaderboard?period=' + period + '&metric=' + metric)
      .then((res) => {
        if (this._loadingKey !== key) return; // 已切走：丢弃旧象限响应
        const parsed = core.parseLeaderboard(res);
        if (!parsed) {
          this.setData({ isLoading: false, loadError: '排行榜加载失败' });
          return;
        }
        const board = {
          entries: core.decorateLeaderboardRows(parsed.entries, metric).map((row) => ({
            ...row,
            avatar: this._absoluteAvatar(row.avatar),
          })),
          me: parsed.me,
        };
        this._boards[key] = board;
        // 呈现前再校验选中象限（fetch 期间可能已切换）
        if (this.data.period + '|' + this.data.metric === key) this._present(board);
      })
      .catch((err) => {
        if (this._loadingKey !== key) return;
        if (err && err.statusCode === 401) {
          // 未登录（Web 口径：toast + 空榜呈现，不进错误重试态）
          wx.showToast({ title: '请先登录后查看排行榜', icon: 'none' });
          this.setData({ isLoading: false, loadError: '', entries: [], me: null });
          return;
        }
        this.setData({
          isLoading: false,
          loadError: (err && err.message) || '排行榜加载失败',
        });
      });
  },

  /** 相对头像路径（/static/...）补后端源；空串走首字母回退 */
  _absoluteAvatar(url) {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    return config.BASE_URL + url;
  },

  /* ---------------- 视图动作 ---------------- */

  /** 头像加载失败 → 首字母占位（Android AsyncImage onError 同款回退） */
  onAvatarError(e) {
    const i = Number(e.currentTarget.dataset.index);
    const row = this.data.entries[i];
    if (!row || row.avatarFailed) return;
    this.setData({ ['entries[' + i + '].avatarFailed']: true });
  },

  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/review/index' }),
    });
  },
});
