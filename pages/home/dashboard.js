// Native mini-program adapter for yuanlu's authenticated, read-only dashboard.
const { get } = require('../../utils/request');
const authStore = require('../../store/authStore');

function chinaClock(now) {
  const d = new Date((now == null ? Date.now() : now) + 8 * 3600000);
  const h = d.getUTCHours();
  return {
    date: d.toISOString().slice(0, 10),
    label: String(h).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'),
    slot: h >= 5 && h < 10 ? 'morning' : h >= 10 && h < 14 ? 'noon' : h >= 14 && h < 18 ? 'afternoon' : h >= 18 && h < 22 ? 'evening' : 'night',
  };
}

/** 7 日火苗链默认格：按真实最近 7 天（中国时区）生成星期标签，全未点亮
 *  （装载前占位；点亮态以 /api/streak week 为准——真实数据非装饰） */
function defaultStreakWeek() {
  const now = new Date(Date.now() + 8 * 3600000);
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (6 - i)));
    week.push({
      date: d.toISOString().slice(0, 10),
      label: i === 6 ? '今日' : labels[d.getUTCDay()],
      lit: false,
      today: i === 6,
    });
  }
  return week;
}

function emptyData() {
  return {
    dashboardStatus: 'guest', dashboardMessage: '登录后查看真实学习进度',
    // 连胜 = 小程序跟读开口口径（GET /api/streak），与网站收听打卡分离
    streakGoal: null, streakDays: 0, streakIgnited: false, streakPercentile: 0,
    streakBadge: '🌱 从今天开始积累',
    streakMilestone: 14, streakRemain: 14, streakProgress: 0,
    streakWeek: defaultStreakWeek(), streakSubmitting: false,
    streakCheerText: '', dailyGoalMins: 0, remainingMins: 0,
    metricShadowCount: 0, metricDoneCount: 0, metricMyRank: null,
    metricVocabCount: 0, metricMasteredCount: 0, metricReviewPending: 0,
    metricReviewTotal: 0, metricSentenceCount: 0,
  };
}

function recommendations(slots, snapshot) {
  return slots.map((base) => {
    const rec = Object.assign({}, base);
    if (!snapshot) {
      rec.reason = '按北京时间提供时段学习建议；登录并同步进度后，将结合你的生词复习任务与学习等级调整。';
      return rec;
    }
    rec.suggestedLevel = snapshot.recommendation.level;
    const due = snapshot.vocabulary.due;
    const count = snapshot.shadowing.count;
    const levelReason = snapshot.recommendation.hasProfileLevel ? '已结合你的账号学习等级。' : '暂未设置学习等级，先从 B1 开始。';
    if (due > 0 && ['morning', 'noon', 'night'].includes(rec.key)) {
      rec.targetMode = 'review';
      rec.studyType = '到期生词复习 & 原声语境回顾';
      rec.reason = '生词本中有 ' + due + ' 个词已到复习时间，建议先完成这一轮复习。' + levelReason;
      rec.actionText = '复习 ' + due + ' 个到期生词';
    } else {
      // 文案只陈述真实事实：小程序无收听目标概念，不引用 study.goalMins/remainingMins
      rec.reason =
        (count > 0
          ? '今日已完成 ' + count + ' 次真实跟读评测。'
          : '今天还没有跟读记录，开口练一句就算开张。') + levelReason;
    }
    return rec;
  });
}

function viewData(s) {
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (!s || !s.study || !s.shadowing || !s.vocabulary || !s.sentences || !s.recommendation ||
      !Array.isArray(s.study.week) || s.study.week.length !== 7 ||
      ![s.study.streakDays, s.study.goalMins, s.study.remainingMins, s.shadowing.count, s.shadowing.passed,
        s.vocabulary.total, s.vocabulary.mastered, s.vocabulary.due, s.sentences.total].every(count) ||
      !['A2', 'B1', 'B2', 'C1'].includes(s.recommendation.level)) {
    throw new Error('学习进度返回异常，请重试');
  }
  return {
    dashboardStatus: 'ready', dashboardMessage: '已同步账号数据 · 北京时间 ' + s.date,
    // study.streakDays/achieved/week（网站收听口径）不再注入连胜区——
    // 连胜字段由 _loadWeappStreak（/api/streak 跟读开口口径）独立供给
    dailyGoalMins: s.study.goalMins, remainingMins: s.study.remainingMins,
    metricShadowCount: s.shadowing.count, metricDoneCount: s.shadowing.passed, metricMyRank: s.shadowing.rank,
    metricVocabCount: s.vocabulary.total, metricMasteredCount: s.vocabulary.mastered,
    metricReviewPending: s.vocabulary.due, metricReviewTotal: s.vocabulary.total,
    metricSentenceCount: s.sentences.total,
  };
}

const methods = {
  _initDashboard() {
    this._dashboardDisposed = false;
    this._dashboardSeq = 0;
    this._dashboardBaseSlots = this.data.timeSlots;
    this._dashboardToken = '';
    this._dashboardSnapshot = null;
    this.setData(emptyData());
    this._dashboardUnsubscribe = authStore.subscribe(() => {
      if (this._dashboardToken !== this._dashboardAuthToken()) this._loadDashboard();
    });
    this._tickDashboardClock();
  },

  _dashboardAuthToken() {
    const auth = authStore.getState();
    return auth.isLoggedIn ? (auth.token || '') : '';
  },

  /** 连胜状态装载（跟读开口口径 /api/streak）：静默失败维持现值（emptyData 兜底 0 天） */
  _loadWeappStreak() {
    if (this._dashboardDisposed) return;
    const token = this._dashboardAuthToken();
    if (!token) return; // 未登录不发请求（401 会全局 toast）
    const seq = this._streakReadSeq = (this._streakReadSeq || 0) + 1;
    return get('/api/streak', null, { showError: false })
      .then((body) => {
        if (this._dashboardDisposed || seq !== this._streakReadSeq || token !== this._dashboardAuthToken()) return;
        if (!body || !body.success || !body.data) throw new Error('streak unavailable');
        const week = Array.isArray(body.data.week) && body.data.week.length === 7
          ? body.data.week : this.data.streakWeek;
        this.setData({
          streakGoal: body.data.dailyGoal || null,
          streakDays: body.data.streakDays || 0,
          streakIgnited: !!body.data.ignitedToday,
          streakPercentile: body.data.percentile || 0,
          streakWeek: week, // 真实最近 7 天：真星期标签 + 真实点亮态
        });
        this._syncStreakDerived();
      })
      .catch(() => { /* 连胜区块维持当前展示 */ });
  },

  _loadDashboard(force) {
    if (this._dashboardDisposed) return Promise.resolve();
    const token = this._dashboardAuthToken();
    const changed = token !== this._dashboardToken;
    if (changed || !token) {
      this._dashboardToken = token;
      this._dashboardSeq++;
      this._dashboardPending = null;
      this._dashboardSnapshot = null;
      this.setData(emptyData());
      this._syncDashboardRecommendation();
    }
    if (!token) return Promise.resolve();
    // 连胜（跟读开口口径）独立装载：覆盖 onLoad/onShow/登录态变化/跨天/
    // 评测后强刷全部入口（不走 studio-dashboard 的 pending 去重）
    this._loadWeappStreak();
    if (this._dashboardPending && !force) return this._dashboardPending;
    const seq = ++this._dashboardSeq;
    this.setData({ dashboardStatus: 'loading', dashboardMessage: '正在同步学习进度…' });
    const current = () => !this._dashboardDisposed && seq === this._dashboardSeq && token === this._dashboardAuthToken();
    const pending = get('/api/user/stats/studio-dashboard', null, { showError: false })
      .then((body) => {
        if (!current()) return;
        if (!body || !body.success) throw new Error('学习进度暂时无法加载，请重试');
        const patch = viewData(body.data);
        this._dashboardSnapshot = body.data;
        this.setData(patch);
        this._syncStreakDerived();
        this._syncDashboardRecommendation();
      })
      .catch((err) => {
        if (!current()) return;
        this._dashboardSnapshot = null;
        this.setData(Object.assign(emptyData(), {
          dashboardStatus: err && err.statusCode === 401 ? 'guest' : 'error',
          dashboardMessage: err && err.statusCode === 401 ? '登录已过期，请重新登录' : '学习进度加载失败，点击重试',
        }));
        this._syncDashboardRecommendation();
      })
      .finally(() => { if (seq === this._dashboardSeq) this._dashboardPending = null; });
    this._dashboardPending = pending;
    return pending;
  },

  _syncDashboardRecommendation() {
    const slots = recommendations(this._dashboardBaseSlots || this.data.timeSlots, this._dashboardSnapshot);
    this.setData({ timeSlots: slots, activeTimeRec: slots.find((s) => s.key === this.data.selectedTimeSlot) || slots[0] });
  },

  _tickDashboardClock() {
    const clock = chinaClock();
    const follow = !this._manualTimeSlot || this.data.selectedTimeSlot === this.data.currentTimeSlot;
    const changedDay = this._dashboardDate && this._dashboardDate !== clock.date;
    this._dashboardDate = clock.date;
    this.setData({ currentTimeLabel: clock.label, currentTimeSlot: clock.slot,
      selectedTimeSlot: follow ? clock.slot : this.data.selectedTimeSlot });
    this._syncDashboardRecommendation();
    if (changedDay) {
      if (this._syncShadowIdentity) this._syncShadowIdentity();
      if (this._loadDaily) this._loadDaily(false);
      this._loadDashboard(true);
      if (this._loadSmartReview) this._loadSmartReview(true);
    }
  },

  onDashboardRetry() {
    if (this.data.dashboardStatus === 'guest') {
      wx.navigateTo({ url: '/pages/auth/index' });
      return;
    }
    return this._loadDashboard();
  },

  _disposeDashboard() {
    this._dashboardDisposed = true;
    this._dashboardSeq++;
    if (this._dashboardUnsubscribe) this._dashboardUnsubscribe();
  },
};

module.exports = { chinaClock, emptyData, recommendations, viewData, methods };
