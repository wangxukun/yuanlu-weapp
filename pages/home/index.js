const request = require('../../utils/request').request;
const { get } = require('../../utils/request');
const authStore = require('../../store/authStore');
const theme = require('../../utils/theme');

// 一周 7 天节点坐标（对齐 Android HomeScreen 及 Web JourneyStrip 的波浪起伏路径）
const JOURNEY_COORDS = [
  { x: 7.78, y: 62 },
  { x: 21.85, y: 34 },
  { x: 35.93, y: 59.2 },
  { x: 50.00, y: 34 },
  { x: 64.07, y: 57.8 },
  { x: 78.15, y: 35.4 },
  { x: 92.22, y: 62 }
];

// 心愿灵感胶囊池（每次进入随机抽 3 枚；措辞避开口禁区词汇）
const WISH_POOL = [
  '#委婉拒绝加班',
  '#连读特训',
  '#用我的生词串讲',
  '#高情商反驳',
  '#安慰焦虑的朋友',
  '#学术汇报转折',
  '#地道美式吐槽',
  '#闲聊破冰不冷场',
];

/** 处方卡 → 展示模型（WXML 零方法调用：全部标签/时长预格式化） */
function mapRxCard(raw) {
  if (!raw) return null;
  if (raw.type === 'micro_scene') {
    return {
      kind: 'scene',
      sceneid: raw.sceneid,
      episodeid: '',
      tagLabel: '今日微剧场',
      focusLabel: raw.situationTag || '',
      title: raw.title || '',
      sub: raw.summaryZh || '',
      cefrLabel: raw.cefrLevel || '',
      durLabel: Math.round(raw.duration) + 's',
      coverUrl: raw.coverUrl || '',
      clipid: '',
      startTime: 0,
      endTime: 0,
    };
  }
  return {
    kind: 'clip',
    sceneid: '',
    episodeid: raw.episodeid || '',
    tagLabel: raw.type === 'vocab_revival' ? '跨语境重逢' : '弱音狙击',
    focusLabel: raw.focus || '',
    title: raw.enText || '',
    sub: raw.zhText || '',
    cefrLabel: raw.cefrLevel || '',
    durLabel: Math.round(raw.duration) + 's',
    coverUrl: raw.coverUrl || '',
    clipid: raw.clipid || '',
    startTime: raw.startTime || 0,
    endTime: raw.endTime || 0,
  };
}

Page({
  data: {
    themeClass: '',
    // 登录态：未登录渲染整页引导（tabBar 页等价 Web redirect("/")），双通道同步见 syncAuthState
    isLoggedIn: false,
    isLoading: true,
    error: null,
    isRefreshing: false,

    // Header 数据
    greeting: '早上好，远路人',
    bio: '世界很长，慢慢走',
    checkInStatus: '今日学习 +15 分钟',
    streakDays: 3,

    // 心愿定制签（输入 + 随机灵感胶囊 + 一键召唤 → 心愿工坊）
    wishInput: '',
    wishChips: [],

    // 今日五分钟靶向处方（后端 /api/studio/daily-prescription）
    rxCards: [],

    // 本周里程
    mileage: {
      weeklyProgress: 12,
      kmCurrent: 5.2,
      kmGoal: 10,
      remainingMins: 45,
      wordsCurrent: 120,
      wordsGoal: 300
    },

    // 学习小径 (7天带波浪坐标)
    journeyDays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, i) => ({
      label,
      minutes: 0,
      isToday: i === ((new Date().getDay() + 6) % 7),
      x: JOURNEY_COORDS[i].x,
      y: JOURNEY_COORDS[i].y
    }))
  },

  onLoad() {
    this._lastToken = undefined;

    // 心愿灵感胶囊：随机抽 3 枚（无重复）
    const pool = WISH_POOL.slice();
    const chips = [];
    while (chips.length < 3 && pool.length > 0) {
      chips.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    this.setData({ wishChips: chips });

    // 监听 authStore：登录/登出/换号自动切换引导态与内容态
    this.unsubscribeAuth = authStore.subscribe(() => {
      this.syncAuthState();
    });

    // 首次同步：已登录直接拉数据；未登录进引导态（不发任何请求）
    this.syncAuthState();
  },

  onShow() {
    // 双通道之二：从登录页 navigateBack 返回时由此恢复内容态
    this.syncAuthState();
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏（@navBg 只随系统）
    // 精研/复习产生的学习时长可能推进打卡与学习小径 → 静默补拉本周活动
    //（仅 weekly-activity 一路，不重拉主页聚合；失败保留旧数据）
    if (this.data.isLoggedIn) this._refreshWeekly();
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
  },

  /**
   * 登录态同步（authStore.subscribe + onShow 双通道）：
   * - 未登录：整页引导态，不发主页 API（游客请求全部 401）
   * - 登录返回/换号（token 变化）：自动拉取数据恢复内容态
   */
  syncAuthState() {
    const { isLoggedIn } = authStore.getState();
    const currentToken = wx.getStorageSync('token');
    const tokenChanged = this._lastToken !== currentToken;
    this._lastToken = currentToken;

    if (isLoggedIn !== this.data.isLoggedIn) {
      this.setData({ isLoggedIn });
    }
    if (!isLoggedIn) {
      if (this.data.isLoading || this.data.error) {
        this.setData({ isLoading: false, error: null });
      }
      return;
    }
    if (tokenChanged) {
      this.setData({ isLoading: true, error: null });
      this.fetchHomeData(true);
      this._fetchRx();
    }
  },

  /**
   * 今日五分钟靶向处方（GET /api/studio/daily-prescription）：
   * 尽力而为——未登录/语料未就绪(422)/网络异常一律静默隐藏区块，
   * 换号重拉（token 变化时 syncAuthState 触发）。
   */
  async _fetchRx() {
    if (!authStore.getState().isLoggedIn) {
      if (this.data.rxCards.length) this.setData({ rxCards: [] });
      return;
    }
    try {
      const body = await get('/api/studio/daily-prescription', null, { showError: false });
      const cards = (body && body.success && Array.isArray(body.data && body.data.cards))
        ? body.data.cards.map(mapRxCard).filter(Boolean)
        : [];
      this.setData({ rxCards: cards });
    } catch (e) {
      if (this.data.rxCards.length) this.setData({ rxCards: [] });
    }
  },

  /**
   * 静默补拉本周活动（onShow 触发 / 下拉刷新之外的低成本刷新）：
   * 打卡时间/学习小径今日分钟/里程，失败保留旧数据不打扰用户。
   */
  async _refreshWeekly() {
    if (this._weeklyFetching) return;
    this._weeklyFetching = true;
    try {
      const { get } = require('../../utils/request');
      const weekRes = await get('/api/user/stats/weekly-activity?weekOffset=0').catch(() => null);
      if (weekRes) {
        // 打卡时间/学习小径今日分钟/里程与收听时长心跳同源（listeningSeconds）
        const weekNow = weekRes?.weeklyActivity || weekRes || [];
        if (Array.isArray(weekNow) && weekNow.length === 7) {
          const todayIndex = (new Date().getDay() + 6) % 7;
          const todayMinutes = weekNow[todayIndex]?.minutes || 0;
          const patch = {
            journeyDays: weekNow.map((d, i) => ({
              label: d.day || this.data.journeyDays[i]?.label,
              minutes: d.minutes || 0,
              isToday: i === todayIndex,
              x: this.data.journeyDays[i]?.x || 0,
              y: this.data.journeyDays[i]?.y || 0,
            })),
          };
          if (this.data.checkInStatus && this.data.checkInStatus.indexOf('今日打卡') === 0) {
            const dailyGoalMins = this._dailyGoalMins || 20;
            patch.checkInStatus = todayMinutes >= dailyGoalMins
              ? '今日打卡完成'
              : `今日打卡还差 ${dailyGoalMins - todayMinutes} 分钟`;
          }
          this.setData(patch);
        }
      }
    } finally {
      this._weeklyFetching = false;
    }
  },

  onPullDownRefresh() {
    this.fetchHomeData(true).then(() => {
      wx.stopPullDownRefresh();
    });
    this._fetchRx();
  },

  async fetchHomeData(silent = false) {
    // 登录守卫：未登录不发请求（主页 API 对游客全部 401），停在引导态
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false });
      return;
    }
    if (!silent) this.setData({ isLoading: true, error: null });
    try {
      const { get } = require('../../utils/request');

      // 聚合并发（对齐 Android HomeViewModel 的 coroutineScope；整集列表已
      // 随合规重塑退役，保留个人学习资产四路）
      const [
        profileRes,
        overviewRes,
        weekNowRes,
        weekLastRes,
        vocabRes
      ] = await Promise.all([
        get('/api/user/profile').catch(() => null),
        get('/api/user/stats/overview').catch(() => null),
        get('/api/user/stats/weekly-activity?weekOffset=0').catch(() => null),
        get('/api/user/stats/weekly-activity?weekOffset=1').catch(() => null),
        get('/api/vocabulary/all').catch(() => null)
      ]);

      const profile = profileRes || {};
      const stats = overviewRes || {};
      const weekNow = weekNowRes?.weeklyActivity || weekNowRes || [];
      const weekLast = weekLastRes?.weeklyActivity || weekLastRes || [];
      const vocabList = vocabRes?.data || vocabRes || [];

      // 计算本周里程
      const thisWeekMinutes = weekNow.reduce((acc, curr) => acc + curr.minutes, 0);
      const lastWeekMinutes = weekLast.reduce((acc, curr) => acc + curr.minutes, 0);
      const goalHours = Math.max(profile.weeklyListeningGoalHours || 2, 0);

      let weeklyProgress = 0;
      if (lastWeekMinutes > 0) {
        weeklyProgress = Math.floor((thisWeekMinutes - lastWeekMinutes) * 100 / lastWeekMinutes);
      } else if (thisWeekMinutes > 0) {
        weeklyProgress = 100;
      }

      const wordsGoal = Math.max(profile.weeklyWordsGoal || 50, 0);

      // 计算本周新增单词数
      let wordsCurrent = 0;
      if (vocabList.length > 0) {
        const now = new Date();
        // 找到本周一 00:00:00 的时间戳
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(now.setDate(diff));
        monday.setHours(0, 0, 0, 0);
        const weekStart = monday.getTime();

        wordsCurrent = vocabList.filter(v => {
          if (!v.addedDate) return false;
          const time = new Date(v.addedDate).getTime();
          return !isNaN(time) && time >= weekStart;
        }).length;
      }

      // 计算问候语
      const hour = new Date().getHours();
      let timeGreeting = '晚上好';
      if (hour >= 0 && hour <= 11) timeGreeting = '早上好';
      else if (hour >= 12 && hour <= 17) timeGreeting = '下午好';
      const displayName = profile.nickname || '朋友';

      // 今日打卡
      const todayIndex = (new Date().getDay() + 6) % 7;
      const todayMinutes = weekNow[todayIndex]?.minutes || 0;
      const dailyGoalMins = Math.max(profile.dailyStudyGoalMins || 20, 0);
      this._dailyGoalMins = dailyGoalMins; // _refreshWeekly 增量刷新打卡文案用
      const checkInStatus = todayMinutes >= dailyGoalMins ? '今日打卡完成' : `今日打卡还差 ${dailyGoalMins - todayMinutes} 分钟`;

      const rawBio = (profile.bio && profile.bio.trim()) ? profile.bio.trim() : '世界很长，慢慢走';
      const formattedBio = rawBio.length > 15 ? rawBio.slice(0, 15) + '...' : rawBio;

      this.setData({
        greeting: `${timeGreeting}，${displayName}。`,
        bio: formattedBio,
        checkInStatus,
        streakDays: stats.streakDays || profile.streakDays || 0,
        mileage: {
          weeklyProgress,
          kmCurrent: (thisWeekMinutes / 60) * 5.0,
          kmGoal: goalHours * 5.0,
          remainingMins: Math.max(goalHours * 60 - thisWeekMinutes, 0),
          wordsCurrent,
          wordsGoal
        },
        journeyDays: (weekNow.length === 7 ? weekNow : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(label => ({ day: label, minutes: 0 }))).map((d, i) => ({
          label: d.day || d.label,
          minutes: d.minutes || 0,
          isToday: i === todayIndex,
          x: JOURNEY_COORDS[i].x,
          y: JOURNEY_COORDS[i].y
        })),
        isLoading: false
      });
    } catch (err) {
      this.setData({ error: err.message || '加载失败', isLoading: false });
    }
  },

  /** 未登录引导：去登录页，登录成功 navigateBack 后 onShow 自动恢复内容态 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  /** 「我的路」右上角 → 学习路径页 */
  onOpenLearningPaths() {
    wx.navigateTo({ url: '/pages/library/paths/index' });
  },

  // ==================== 心愿定制签（T3.1） ====================

  onWishInput(e) {
    this.setData({ wishInput: (e.detail && e.detail.value) || '' });
  },

  /** 灵感胶囊：一键填入输入框（可再改写） */
  onWishChipTap(e) {
    const chip = e.currentTarget.dataset.chip || '';
    this.setData({ wishInput: chip });
  },

  /** 一键召唤定制：心愿文本带入心愿工坊（生成弹窗预填并自动打开） */
  onWishGo() {
    const wish = (this.data.wishInput || '').trim();
    if (!wish) {
      wx.showToast({ title: '先写下一个小心愿吧', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/library/paths/index?wish=' + encodeURIComponent(wish),
    });
  },

  // ==================== 今日五分钟处方（T3.1） ====================

  /** 处方卡点击：进入原声精研页继续闯关（微剧场模式随 T4.1 落地） */
  onRxCardTap(e) {
    const ds = e.currentTarget.dataset;
    // 微剧场卡（episodeid 为空）走 sceneId 深链，其余切片卡走剧集精研
    if (ds.kind === 'scene' && ds.sceneid) {
      wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + ds.sceneid });
      return;
    }
    if (ds.episodeid) {
      wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + ds.episodeid });
    }
  }
});
