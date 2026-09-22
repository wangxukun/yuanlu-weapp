/**
 * store/playerStore.js — 全局播放状态镜像（3.B.2）
 *
 * audioManager 是播放域的唯一事实源（内部 state + 事件总线）；本 store 在模块
 * 加载时订阅其全部事件，把快照镜像为与 authStore/membershipStore 同款的
 * 发布-订阅 store——跨页面/组件（3.B.3 迷你播放条、全屏面板）统一用
 * `playerStore.subscribe(fn)` 感知播放态，`getState()` 拿快照。
 *
 * 职责边界（单向依赖，无环）：
 *   - 读：本 store 只做镜像，不持有私有播放状态；
 *   - 写：播放命令一律走 utils/audioManager（play/pause/seek/next/prev...），
 *     状态经事件回流本 store，保证两者永不分叉。
 */
const Store = require('./core.js');
const audioManager = require('../utils/audioManager');

class PlayerStore extends Store {
  constructor() {
    super({
      currentEpisode: null,
      hasEpisode: false,
      isPlaying: false,
      isLoading: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      loopMode: 'none',
      isShuffle: false,
      playlist: [],
      // 精听模式标记 + 定时关闭（对齐 Android PlayerState，audioManager 为事实源）
      isIntensiveMode: false,
      sleepTimer: null,
      lastSleepConfig: null,
    });

    // 全事件镜像：任何播放态变化（含锁屏/耳机线控触发的 play/pause/prev/next、
    // 定时关闭的设置/倒计时/结算）都会回流到本 store 并通知订阅者
    this._mirror = (s) => {
      if (!s) return;
      this.setState({
        currentEpisode: s.currentEpisode,
        hasEpisode: s.hasEpisode,
        isPlaying: s.isPlaying,
        isLoading: s.isLoading,
        currentTime: s.currentTime || 0,
        duration: s.duration || 0,
        playbackRate: s.playbackRate,
        loopMode: s.loopMode,
        isShuffle: s.isShuffle,
        playlist: s.playlist,
        isIntensiveMode: s.isIntensiveMode,
        sleepTimer: s.sleepTimer,
        lastSleepConfig: s.lastSleepConfig,
      });
    };
    [
      'play', 'pause', 'stop', 'ended', 'waiting',
      'timeupdate', 'episodeChange', 'modeChange', 'seek', 'error',
      'sleepTimer', 'sleepTimerFired',
    ].forEach((evt) => audioManager.on(evt, this._mirror));
  }
}

module.exports = new PlayerStore();
