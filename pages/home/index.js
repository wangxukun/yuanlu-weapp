const request = require('../../utils/request').request;
const authStore = require('../../store/authStore');
const audioManager = require('../../utils/audioManager');
const theme = require('../../utils/theme');

// 触发「切回主页需刷新最近收听」的播放事件（含 timeupdate——后台连播期间
// 无其他事件但进度在走，处理器仅置一次布尔标记，高频无开销）
const PLAYBACK_DIRTY_EVENTS = ['episodeChange', 'ended', 'pause', 'stop', 'seek', 'timeupdate'];

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

    // 最近收听
    latestHistory: null,

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
    })),

    // 剧集列表
    continueListening: [],
    recommended: [],
    latestEpisodes: []
  },

  onLoad() {
    this._lastToken = undefined;
    this._playbackDirty = false; // 播放过后切回主页 → 静默补拉最近收听

    // 监听 authStore：登录/登出/换号自动切换引导态与内容态
    this.unsubscribeAuth = authStore.subscribe(() => {
      this.syncAuthState();
    });

    // 监听全局播放事件：任一触发置脏，onShow 时补拉「继续收听」卡片/列表
    this._onPlaybackEvent = () => { this._playbackDirty = true; };
    PLAYBACK_DIRTY_EVENTS.forEach((evt) => audioManager.on(evt, this._onPlaybackEvent));

    // 首次同步：已登录直接拉数据；未登录进引导态（不发任何请求）
    this.syncAuthState();
  },

  onShow() {
    // 双通道之二：从登录页 navigateBack 返回时由此恢复内容态
    this.syncAuthState();
    // 播放会话影响过「继续收听」（换了剧集/进度/播完）→ 静默补拉最近收听
    //（仅 history 一路，不重拉 7 路主页聚合；失败保留旧数据）
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏（@navBg 只随系统）
    if (this.data.isLoggedIn && this._playbackDirty) {
      this._playbackDirty = false;
      this._refreshHistory();
    }
  },

  onUnload() {
    if (this.unsubscribeAuth) this.unsubscribeAuth();
    if (this._onPlaybackEvent) {
      PLAYBACK_DIRTY_EVENTS.forEach((evt) => audioManager.off(evt, this._onPlaybackEvent));
    }
  },

  /**
   * 登录态同步（authStore.subscribe + onShow 双通道）：
   * - 未登录：整页引导态，不发 7 路主页 API（游客请求全部 401）
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
      this._playbackDirty = false; // 全量拉取已含 history，避免随后的补拉双请求
      this.fetchHomeData(true);
    }
  },

  /**
   * 静默补拉最近收听 + 今日打卡（onShow 脏标记触发 / 下拉刷新之外的低成本刷新）：
   * 并行请求 /api/user/history（顶卡 + 横向列表）与 weekly-activity（打卡时间/
   * 学习小径今日分钟/里程），任一失败保留旧数据不打扰用户。
   */
  async _refreshHistory() {
    if (this._historyFetching) return;
    this._historyFetching = true;
    try {
      const { get } = require('../../utils/request');
      const [historyRes, weekRes] = await Promise.all([
        get('/api/user/history?page=1&pageSize=5&status=all').catch(() => null),
        get('/api/user/stats/weekly-activity?weekOffset=0').catch(() => null),
      ]);
      if (historyRes) {
        const historyList = historyRes?.data?.items || historyRes?.items || [];
        this.setData({
          latestHistory: historyList[0] || null,
          continueListening: historyList.slice(1, 5)
        });
      }
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
      this._historyFetching = false;
    }
  },

  onPullDownRefresh() {
    this.fetchHomeData(true).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async fetchHomeData(silent = false) {
    // 登录守卫：未登录不发请求（7 路主页 API 对游客全部 401），停在引导态
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false });
      return;
    }
    if (!silent) this.setData({ isLoading: true, error: null });
    try {
      const { get } = require('../../utils/request');

      // 聚合 7 路并发（对齐 Android HomeViewModel 的 coroutineScope）
      const [
        profileRes,
        overviewRes,
        weekNowRes,
        weekLastRes,
        historyRes,
        vocabRes,
        episodesRes
      ] = await Promise.all([
        get('/api/user/profile').catch(() => null),
        get('/api/user/stats/overview').catch(() => null),
        get('/api/user/stats/weekly-activity?weekOffset=0').catch(() => null),
        get('/api/user/stats/weekly-activity?weekOffset=1').catch(() => null),
        get('/api/user/history?page=1&pageSize=5&status=all').catch(() => null),
        get('/api/vocabulary/all').catch(() => null),
        get('/api/episode/list?page=1&pageSize=50').catch(() => null)
      ]);

      const profile = profileRes || {};
      const historyList = historyRes?.data?.items || historyRes?.items || [];
      const baseEpisodes = Array.isArray(episodesRes) ? episodesRes : (episodesRes?.data?.episodes || episodesRes?.episodes || []);
      const stats = overviewRes || {};
      const weekNow = weekNowRes?.weeklyActivity || weekNowRes || [];
      const weekLast = weekLastRes?.weeklyActivity || weekLastRes || [];
      const vocabList = vocabRes?.data || vocabRes || [];

      // 剧集富化：获取剧集的签名封面和其他缺失字段
      let enrichedEpisodes = baseEpisodes;
      const podcastIds = [...new Set(baseEpisodes.map(e => e.podcastid || e.podcast?.podcastid).filter(Boolean))].slice(0, 6);
      if (podcastIds.length > 0) {
        const enrichPromises = podcastIds.map(pid => 
          get(`/api/episode/list-by-podcastid?podcastId=${pid}&page=1&limit=100&ascending=false`).catch(() => null)
        );
        const enrichResults = await Promise.all(enrichPromises);
        const richMap = {};
        enrichResults.forEach(res => {
          const eps = res?.data?.episodes || res?.episodes || [];
          eps.forEach(ep => {
            richMap[ep.episodeid] = ep;
          });
        });
        enrichedEpisodes = baseEpisodes.map(base => {
          const rich = richMap[base.episodeid];
          if (!rich) return base;
          return {
            ...base,
            coverUrl: rich.coverUrl || base.coverUrl,
            duration: rich.duration > 0 ? rich.duration : base.duration,
            playCount: rich.playCount > 0 ? rich.playCount : base.playCount,
            difficulty: rich.difficulty || base.difficulty
          };
        });
      }

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
      this._dailyGoalMins = dailyGoalMins; // _refreshHistory 增量刷新打卡文案用
      const checkInStatus = todayMinutes >= dailyGoalMins ? '今日打卡完成' : `今日打卡还差 ${dailyGoalMins - todayMinutes} 分钟`;

      // 推荐剧集筛选 (基于 CEFR)
      const LEVEL_MAPPING = {
        "Beginner": ["A1", "A2"],
        "Intermediate": ["B1", "B2"],
        "Advanced": ["C1", "C2"]
      };
      const level = profile.learnLevel || "General";
      const targetDifficulties = LEVEL_MAPPING[level] || [];
      
      let recommended = [];
      if (targetDifficulties.length > 0) {
        const matched = enrichedEpisodes.filter(e => targetDifficulties.includes(e.difficulty));
        recommended = matched.length > 0 ? matched.slice(0, 4) : enrichedEpisodes.slice(0, 4);
      } else {
        recommended = enrichedEpisodes.slice(0, 4);
      }

      const rawBio = (profile.bio && profile.bio.trim()) ? profile.bio.trim() : '世界很长，慢慢走';
      const formattedBio = rawBio.length > 15 ? rawBio.slice(0, 15) + '...' : rawBio;

      this.setData({
        greeting: `${timeGreeting}，${displayName}。`,
        bio: formattedBio,
        checkInStatus,
        streakDays: stats.streakDays || profile.streakDays || 0,
        latestHistory: historyList[0] || null,
        continueListening: historyList.slice(1, 5),
        recommended,
        latestEpisodes: enrichedEpisodes.slice(0, 4),
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

  onPlayEpisode(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/episode/episode?id=${id}` });
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },

  /** 未登录引导：去登录页，登录成功 navigateBack 后 onShow 自动恢复内容态 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  onOpenHistory() {
    // wx.navigateTo({ url: '/pages/history/index' })
  },

  onOpenLearningPaths() {
    // wx.navigateTo({ url: '/pages/paths/index' })
  }
});
