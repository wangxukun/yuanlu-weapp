/**
 * components/player/player-panel — 全屏播放详情面板（3.B.3 → 2026-09-22 按 Android 重构）
 *
 * 复刻 yuanlu-android feature/player/FullScreenPlayerScreen.kt（截图口径）：
 *   - 顶部窄栏：expand_more 收起 / close 关闭播放器（+1px 分割线）；
 *     沉浸宿主页（精听页 navigationStyle:custom）动态让出状态栏/胶囊（见
 *     _measureHeaderTop：2026-09-23 从精听页迷你条再展开面板时图标顶进
 *     状态栏与胶囊的重叠 bug）；
 *   - 下沉模块：拖把 → 16:9 封面（点击跳剧集详情；精听会话右上角「精听中」角标）→
 *     标题/播客名 → 「播放列表 | 定时关闭」行（进度条正上方）→ 进度条 + 双端时间 →
 *     控制排（倍速 / 上一首 / 播放大钮 / 下一首 / 循环）；
 *   - 页面最底部：橙色「精听模式」胶囊（GraphicEq 图标），点击跳本集精听工作流
 *     （episode 页 practice 深链自动起播；已在剧集页则就地驱动精听起播）；
 *   - 「定时」底部弹层：上次定时（Switch 快捷重开/取消）→ 按时间（播完整集停止 +
 *     15/30/60/90分/自定义）→ 按集数（本集/2/3/5集）→ 定时启播占位；
 *   - 「播放列表」底部弹层：当前播放列表切换（点条目切播，当前集高亮）——
 *     Android 端此处为 toast 占位，小程序按真实播放列表实现。
 *
 * 与迷你条一致的数据命令边界：读 playerStore 镜像，写 audioManager；
 * 定时状态（设置/倒计时/结算）经 audioManager 的 sleepTimer/sleepTimerFired
 * 事件回流镜像 store，面板据此刷新「定时关闭」按钮文案与弹层选中态。
 */
const audioManager = require('../../../utils/audioManager');
const audioBus = require('../../../utils/audio-bus');
const playerStore = require('../../../store/playerStore');
const route = require('../../../utils/route');

// 倍速循环顺序对齐 Web MobilePlayerSheet.cyclePlaybackRate：1 → 1.25 → 1.5 → 2 → 0.75
const PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.75];
// 定时弹层选项（对齐 Android SleepTimerSheet）：按时间 + 按集数
const MINUTE_OPTIONS = [15, 30, 60, 90];
const EPISODE_OPTIONS = [1, 2, 3, 5];
// 纯时间推进（timeupdate）节流间隔
const TIME_TICK = 400;

/** mm:ss（分钟定时按钮倒计时展示） */
function formatTime(seconds) {
  const t = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
}

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    visible: {
      type: Boolean,
      value: false,
      observer(v) {
        if (v) {
          // 每次展开都从事实源重同步（面板关闭期间可能已换集/换态）
          this._snapshot = null;
          this._lastTickAt = 0;
          // 宿主页可能已切换（如从默认导航页进入精听页），安全区每次展开重测
          this._measureHeaderTop();
          this._sync(playerStore.getState());
        }
      },
    },
  },

  data: {
    episodeid: '',
    title: '',
    podcastTitle: '',
    coverUrl: '',
    isPlaying: false,
    isLoading: false,
    isIntensiveMode: false,

    // 进度条：拖动中显示拖动值，松手才 seek
    sliderMax: 100,
    sliderValue: 0,
    isSeeking: false,
    dragTime: 0,
    timeLabel: '00:00',
    remainLabel: '-00:00',

    // 顶部控制栏安全区留白（px，_measureHeaderTop 动态计算，内联 padding-top 应用）
    headerPadTop: 0,

    rateLabel: '1x',
    loopMode: 'none',
    isShuffle: false,

    // 定时关闭按钮（激活时倒计时/描述文案 + 主题色）
    sleepText: '定时关闭',
    sleepActive: false,

    // 定时弹层
    sleepSheetVisible: false,
    minuteOptions: MINUTE_OPTIONS,
    episodeOptions: EPISODE_OPTIONS,
    selectedSleep: null, // { mode, minutes?, count? }——sleepTimer.config 的镜像
    sleepChecked: false, // 上次定时 Switch（checked = sleepTimer != null）
    lastSleepDesc: '未设置过定时',

    // 播放列表弹层
    playlistSheetVisible: false,
    playlist: [],
    currentEpisodeId: '',
  },

  lifetimes: {
    attached() {
      this._snapshot = null;
      this._lastTickAt = 0;
      this._measureHeaderTop();
      this._sync(playerStore.getState());
      this._unsubscribe = playerStore.subscribe((s) => this._sync(s));
    },
    detached() {
      if (this._unsubscribe) this._unsubscribe();
    },
  },

  methods: {
    // ==================== 顶部安全区（状态栏/胶囊避让，2026-09-23） ====================

    /**
     * 计算顶部控制栏的留白（px），WXML 内联 padding-top 强制应用。
     *
     * 根因：面板 fixed top:0——默认导航宿主页的视口本就从原生导航栏下缘
     * 开始，无需留白；但精听页（navigationStyle:custom）视口顶到屏幕物理
     * 顶端，收起/关闭图标会顶进系统状态栏与胶囊按钮。故留白必须按宿主页
     * 导航模式区分，且每次面板展开都重测（从任意路由返回即自愈）。
     *
     * 口径：胶囊底缘（wx.getMenuButtonBoundingClientRect，屏幕坐标）+ 与
     * 胶囊自身顶缘等宽的呼吸间隙，减去视口顶缘的屏幕 Y（≈ screenHeight -
     * windowHeight，非 tab 宿主页成立）。默认导航页算出负值钳 0，保持
     * 「原生导航栏即安全区」的原有布局；API 不可得时按沉浸页口径兜底，
     * 宁多留不重叠。
     */
    _measureHeaderTop() {
      let statusBarHeight = 20;
      let screenHeight = 0;
      let windowHeight = 0;
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        statusBarHeight = info.statusBarHeight || 20;
        screenHeight = info.screenHeight || 0;
        windowHeight = info.windowHeight || 0;
      } catch (e) {
        // 系统信息不可得：statusBar 兜底 20，按沉浸页口径留白
      }

      let capsuleBottom = statusBarHeight + 32; // 胶囊标准高度 32px 近似
      let gap = 8;
      try {
        const rect = wx.getMenuButtonBoundingClientRect
          ? wx.getMenuButtonBoundingClientRect()
          : null;
        if (rect && rect.top > 0 && rect.height > 0) {
          capsuleBottom = rect.bottom != null ? rect.bottom : rect.top + rect.height;
          gap = Math.max(4, rect.top - statusBarHeight); // 胶囊与状态栏的间隙作呼吸位
        }
      } catch (e) {
        // 胶囊不可得：沿用 statusBar + 32 近似
      }

      const viewportTop = screenHeight > 0 ? Math.max(0, screenHeight - windowHeight) : 0;
      this.setData({ headerPadTop: Math.max(0, capsuleBottom + gap - viewportTop) });
    },

    /** playerStore 快照 → 面板 data；面板未展开时只挂订阅不渲染 */
    _sync(s) {
      if (!s || !this.data.visible) return;
      const prev = this._snapshot;
      const structural = !prev ||
        s.currentEpisode !== prev.currentEpisode ||
        s.isPlaying !== prev.isPlaying ||
        s.isLoading !== prev.isLoading ||
        s.playbackRate !== prev.playbackRate ||
        s.loopMode !== prev.loopMode ||
        s.isShuffle !== prev.isShuffle ||
        s.isIntensiveMode !== prev.isIntensiveMode ||
        s.sleepTimer !== prev.sleepTimer ||
        s.lastSleepConfig !== prev.lastSleepConfig ||
        s.playlist !== prev.playlist;
      const now = Date.now();
      if (!structural && now - this._lastTickAt < TIME_TICK) return;
      this._lastTickAt = now;
      this._snapshot = s;

      const ep = s.currentEpisode;
      const duration = s.duration || 0;
      const displayTime = this.data.isSeeking ? this.data.dragTime : (s.currentTime || 0);
      const timer = s.sleepTimer;

      // 「定时关闭」按钮文案：分钟模式显示剩余倒计时，其余显示 describe 文案
      let sleepText = '定时关闭';
      if (timer) {
        if (timer.mode === 'minutes') {
          const remainMs = timer.remainingMs != null
            ? timer.remainingMs
            : Math.max(0, timer.endsAt - Date.now());
          sleepText = formatTime(Math.ceil(remainMs / 1000));
        } else {
          sleepText = timer.label;
        }
      }

      this.setData({
        episodeid: (ep && ep.episodeid) || '',
        title: (ep && ep.title) || '',
        podcastTitle: (ep && (ep.podcastTitle || (ep.podcast && ep.podcast.title))) || '远路播客',
        coverUrl: (ep && ep.coverUrl) || '',
        isPlaying: !!s.isPlaying,
        isLoading: !!s.isLoading,
        isIntensiveMode: !!s.isIntensiveMode,
        sliderMax: duration > 0 ? Math.floor(duration) : 100,
        sliderValue: Math.floor(displayTime),
        timeLabel: formatTime(displayTime),
        remainLabel: '-' + formatTime(Math.max(0, duration - displayTime)),
        rateLabel: s.playbackRate + 'x',
        loopMode: s.loopMode,
        isShuffle: !!s.isShuffle,
        sleepText,
        sleepActive: !!timer,
        sleepChecked: !!timer,
        selectedSleep: timer
          ? { mode: timer.mode, minutes: timer.minutes, count: timer.count }
          : null,
        lastSleepDesc: s.lastSleepConfig
          ? audioManager.describeSleepConfig(s.lastSleepConfig)
          : '未设置过定时',
        playlist: s.playlist || [],
        currentEpisodeId: (ep && ep.episodeid) || '',
      });
    },

    // ==================== 播放控制（命令一律走 audioManager） ====================

    onTogglePlay() {
      if (!playerStore.getState().isPlaying) {
        audioBus.stopAll(); // 恢复播放前停 TTS/复习原声片段，防双声
      }
      audioManager.togglePlay();
    },

    onPrev() {
      audioManager.playPrevious();
    },

    onNext() {
      audioManager.playNext();
    },

    /** 倍速循环：1 → 1.25 → 1.5 → 2 → 0.75（Web cyclePlaybackRate 同序） */
    onCycleRate() {
      const cur = playerStore.getState().playbackRate;
      const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(cur) + 1) % PLAYBACK_RATES.length];
      audioManager.setPlaybackRate(next);
    },

    /** 循环模式：不循环 → 列表循环 → 单曲循环 → 随机 */
    onCycleMode() {
      audioManager.cyclePlayMode();
    },

    /** 进度条拖动中：只更新拖动值与时间标签，不 seek */
    onSeekChanging(e) {
      const duration = (this._snapshot && this._snapshot.duration) || 0;
      const v = e.detail.value;
      this.setData({
        isSeeking: true,
        dragTime: v,
        sliderValue: v,
        timeLabel: formatTime(v),
        remainLabel: '-' + formatTime(Math.max(0, duration - v)),
      });
    },

    /** 松手 seek（对齐 Web handleSeekEnd：拖动值落盘 + 退出拖动态） */
    onSeekChanged(e) {
      const time = e.detail.value;
      audioManager.seek(time);
      this.setData({ isSeeking: false, dragTime: time });
    },

    // ==================== 定时关闭弹层 ====================

    onOpenSleepSheet() {
      this.setData({ sleepSheetVisible: true });
    },

    onCloseSleepSheet() {
      this.setData({ sleepSheetVisible: false });
    },

    /** 按时间：15/30/60/90 分钟胶囊 */
    onSelectSleepMinutes(e) {
      const minutes = Number(e.currentTarget.dataset.minutes);
      if (!minutes) return;
      audioManager.applySleepConfig({ mode: 'minutes', minutes });
    },

    /** 按时间：自定义分钟数（Android 端为 toast 占位，小程序做成真实输入） */
    onSelectSleepCustom() {
      wx.showModal({
        title: '自定义定时',
        editable: true,
        placeholderText: '输入分钟数（1-480）',
        success: (res) => {
          if (!res.confirm) return;
          const minutes = parseInt(res.content, 10);
          if (!minutes || minutes < 1 || minutes > 480) {
            wx.showToast({ title: '请输入 1-480 之间的分钟数', icon: 'none' });
            return;
          }
          audioManager.applySleepConfig({ mode: 'minutes', minutes });
        },
      });
    },

    /** 按集数：播完 N 集胶囊 */
    onSelectSleepEpisodes(e) {
      const count = Number(e.currentTarget.dataset.count);
      if (!count) return;
      audioManager.applySleepConfig({ mode: 'episodes', count });
    },

    /** 按时间行右侧单选：播完整集声音再停止 */
    onSelectEpisodeEnd() {
      audioManager.applySleepConfig({ mode: 'episodeEnd' });
    },

    /** 上次定时 Switch：开 = 按上次配置（兜底 15 分钟）重开，关 = 取消定时 */
    onSleepSwitchChange(e) {
      if (e.detail.value) {
        const last = playerStore.getState().lastSleepConfig;
        audioManager.applySleepConfig(last || { mode: 'minutes', minutes: 15 });
      } else {
        audioManager.cancelSleepTimer();
      }
    },

    /** 定时启播占位入口（对齐 Android：toast 即将上线） */
    onStartLaterToast() {
      wx.showToast({ title: '定时启播功能即将上线', icon: 'none' });
    },

    // ==================== 播放列表弹层 ====================

    onOpenPlaylistSheet() {
      this.setData({ playlistSheetVisible: true });
    },

    onClosePlaylistSheet() {
      this.setData({ playlistSheetVisible: false });
    },

    /** 点列表条目切播（播放列表即当前会话队列，切换不重置队列）；
     *  切曲是同一精听会话内的换集，透传当前精听标记（普通起播才会复位标记） */
    onPlaylistItemTap(e) {
      const id = e.currentTarget.dataset.id;
      const item = (this.data.playlist || []).find((ep) => ep.episodeid === id);
      if (!item) return;
      if (item.episodeid === this.data.currentEpisodeId) {
        // 点当前集：等价于重新播放本集（对齐 Android SkipPrevious 语义）
        audioManager.seek(0);
        audioManager.play();
        return;
      }
      audioBus.stopAll();
      audioManager.playEpisode(item, {
        intensive: playerStore.getState().isIntensiveMode,
      });
    },

    // ==================== 精听模式 / 面板导航 ====================

    /** 封面点击：收起面板并进剧集详情页（对齐 Web onClose + router.push）。
     *  单例跳转（utils/route）：栈内已有剧集页实例（剧集 ↔ 精听页经面板
     *  乒乓切换的重复层）→ navigateBack 回退到最深处实例并按需换集刷新，
     *  杜绝重复压栈触顶 10 层页面栈 */
    onCoverTap() {
      const ep = playerStore.getState().currentEpisode;
      this.triggerEvent('close');
      if (!ep || !ep.episodeid) return;
      route.singletonNavigateTo('/pages/episode/episode?id=' + ep.episodeid);
    },

    /**
     * 「精听模式」橙色胶囊（对齐 Android onOpenIntensive → IntensiveListeningNav）：
     * 补精听标记 + 收起面板，跳转本集独立精听工作流页（3.B.4，对齐 Android
     * IntensiveListeningScreen；此前由 episode 页 practice 深链承接）。
     * 单例跳转（utils/route）：栈内已有精听页实例 → navigateBack 回退
     * （换集时经 singletonReload 就地重指）；栈顶已是本集精听页 → no-op。
     */
    onOpenIntensive() {
      const ep = playerStore.getState().currentEpisode;
      if (!ep || !ep.episodeid) return;
      audioManager.setIntensiveMode(true); // 对齐 Android：进入精听流时补标记
      this.triggerEvent('close');
      const r = route.singletonNavigateTo('/pages/intensive-listening/index?id=' + ep.episodeid);
      // 栈顶已是精听页：单例 no-op（面板收起即止），toast 点明当前已在精听页
      if (r.action === 'noop') {
        wx.showToast({ title: '已在精听页', icon: 'none' });
      }
    },

    /** header chevron-down：仅收起面板（会话保留） */
    onCollapse() {
      this.triggerEvent('close');
    },

    /** header close：收起面板并关闭播放器 */
    onClosePlayer() {
      this.triggerEvent('close');
      audioManager.close();
    },
  },
});
