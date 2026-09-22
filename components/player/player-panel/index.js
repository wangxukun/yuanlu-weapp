/**
 * components/player/player-panel — 全屏播放详情面板（3.B.3 → 2026-09-22 按 Android 重构）
 *
 * 复刻 yuanlu-android feature/player/FullScreenPlayerScreen.kt（截图口径）：
 *   - 顶部窄栏：expand_more 收起 / close 关闭播放器（+1px 分割线）；
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
      this._sync(playerStore.getState());
      this._unsubscribe = playerStore.subscribe((s) => this._sync(s));
    },
    detached() {
      if (this._unsubscribe) this._unsubscribe();
    },
  },

  methods: {
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

    /** 封面点击：收起面板并进剧集详情页（对齐 Web onClose + router.push）；
     *  栈顶已是目标剧集页时不再入栈（页面栈防重复） */
    onCoverTap() {
      const ep = playerStore.getState().currentEpisode;
      this.triggerEvent('close');
      if (!ep || !ep.episodeid) return;
      try {
        const pages = wx.getCurrentPages();
        const top = pages[pages.length - 1];
        if (top && top.route === 'pages/episode/episode' &&
          top.options && String(top.options.id) === String(ep.episodeid)) {
          return;
        }
      } catch (e) {
        // 页面栈不可用时按常规跳转
      }
      wx.navigateTo({ url: '/pages/episode/episode?id=' + ep.episodeid });
    },

    /**
     * 「精听模式」橙色胶囊（对齐 Android onOpenIntensive → IntensiveListeningNav）：
     * 补精听标记 + 收起面板，跳转本集独立精听工作流页（3.B.4，对齐 Android
     * IntensiveListeningScreen；此前由 episode 页 practice 深链承接）；
     * 栈顶已是本集精听页时 no-op，防重复入栈。
     */
    onOpenIntensive() {
      const ep = playerStore.getState().currentEpisode;
      if (!ep || !ep.episodeid) return;
      audioManager.setIntensiveMode(true); // 对齐 Android：进入精听流时补标记
      this.triggerEvent('close');
      try {
        const pages = wx.getCurrentPages();
        const top = pages[pages.length - 1];
        if (top && top.route === 'pages/intensive-listening/index' &&
          top.options && String(top.options.id) === String(ep.episodeid)) {
          return;
        }
      } catch (e) {
        // 页面栈不可用时按常规跳转
      }
      wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + ep.episodeid });
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
