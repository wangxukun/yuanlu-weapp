/**
 * components/player/mini-player — 跨页迷你播放条（3.B.3）
 *
 * 复刻 Web 端 components/player/MobilePlayerBar.tsx（app/(main)/layout 全局挂载的
 * #mobile-mini-player）：顶缘 2px 渐变进度线 + 封面缩略图（播放中叠黑色遮罩与
 * 4 根白色均衡器条）+ 标题/播客名 + 播放暂停圆钮（primary-600 底 + 白色 FILL
 * 图标）+ 关闭播放器钮。点条身展开全屏播放详情（player-panel）。
 *
 * 数据与命令的边界（3.B.2 口径）：
 *   - 读：playerStore（audioManager 只读镜像）subscribe 感知播放态；
 *   - 写：播放命令一律走 utils/audioManager；关闭会话 audioManager.close()；
 *   - 互斥：恢复播放前先 audioBus.stopAll() 停掉 TTS/复习原声片段——
 *     反向（片段开播停 BGM）由 audio-bus 内置的 pauseGlobalPlayer 保证。
 *
 * timeupdate 事件约 4 次/秒，纯时间推进做 400ms 节流，结构性变化
 * （换集/播放暂停/缓冲）立即应用。
 */
const audioManager = require('../../../utils/audioManager');
const audioBus = require('../../../utils/audio-bus');
const playerStore = require('../../../store/playerStore');

Component({
  options: {
    // 复用 app.wxss 工具类（.row/.center/.ellipsis/.tap-scale 等）
    styleIsolation: 'apply-shared',
  },

  properties: {
    /** tabBar 页传 true：条体上移让出原生 tabBar（详情页默认贴底） */
    elevated: { type: Boolean, value: false },
  },

  data: {
    hasEpisode: false,
    title: '',
    podcastTitle: '',
    coverUrl: '',
    isPlaying: false,
    isIntensiveMode: false, // 精听模式标记：副标题行显示「精听」小标签（对齐 Android MiniPlayerBar）
    progress: 0, // 0-100，条体顶缘进度线宽度
    panelVisible: false,
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
    /** playerStore 快照 → 条体 data（无会话或全屏面板展开时整条不渲染——互斥，对齐用户口径） */
    _sync(s) {
      if (!s) return;
      const prev = this._snapshot;
      const structural = !prev ||
        s.currentEpisode !== prev.currentEpisode ||
        s.hasEpisode !== prev.hasEpisode ||
        s.isPlaying !== prev.isPlaying ||
        s.isLoading !== prev.isLoading ||
        s.isIntensiveMode !== prev.isIntensiveMode;
      // 纯时间推进（timeupdate）节流，进度线用 CSS transition 补间视觉
      const now = Date.now();
      if (!structural && now - this._lastTickAt < 400) return;
      this._lastTickAt = now;
      this._snapshot = s;

      const ep = s.currentEpisode;
      const progress = s.duration > 0
        ? Math.min(100, Math.round((s.currentTime / s.duration) * 1000) / 10)
        : 0;
      this.setData({
        hasEpisode: !!(s.hasEpisode && ep),
        title: (ep && ep.title) || '',
        // 对齐 Web：currentEpisode.podcast?.title || "远路播客"
        podcastTitle: (ep && (ep.podcastTitle || (ep.podcast && ep.podcast.title))) || '远路播客',
        coverUrl: (ep && ep.coverUrl) || '',
        isPlaying: !!s.isPlaying,
        isIntensiveMode: !!s.isIntensiveMode,
        progress,
      });
    },

    /** 播放/暂停：恢复播放前先停 TTS/复习原声片段，保证同一时刻只有一个声音 */
    onTogglePlay() {
      if (!playerStore.getState().isPlaying) {
        audioBus.stopAll();
      }
      audioManager.togglePlay();
    },

    /** 点条身：展开全屏播放详情面板 */
    onOpenPanel() {
      this.setData({ panelVisible: true });
    },

    onPanelClose() {
      this.setData({ panelVisible: false });
    },

    /** 关闭播放器（对齐 Web closePlayer：停声 + 清会话，迷你条收起） */
    onClose() {
      audioManager.close();
      this.setData({ panelVisible: false });
    },
  },
});
