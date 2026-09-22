/**
 * utils/audioManager.js — 全局音频管理器（单例）
 *
 * 基于微信 wx.getBackgroundAudioManager() 封装，对应 Web 端：
 *   store/player-store.ts    —— 播放列表 / 循环模式 / 上下曲切换逻辑
 *   components/player/GlobalAudio.tsx —— 事件绑定 / 进度恢复 / 心跳上报
 *
 * 职责：
 *   1. 持有唯一的后台音频实例，跨页面共享播放状态（替代 zustand 全局 store）；
 *   2. 对外提供 play/pause/seek/播放列表管理等命令式 API；
 *   3. 内部维护轻量事件总线，页面通过 on/off 订阅 timeupdate 等事件刷新 UI；
 *   4. 预留进度恢复、进度上报、收听时长心跳等业务钩子（阶段二填充）。
 *
 * 使用注意：
 *   - 后台音频实例必须设置 title（iOS 后台播放的硬性要求），由 playEpisode 内部保证；
 *   - 设置 src 即自动开始播放，"暂停后恢复"用 bgm.play() 而非重设 src；
 *   - app.json 已声明 requiredBackgroundModes: ["audio"]，锁屏/切后台不断播。
 */

const { get, post } = require("./request");

// 播放模式：不循环 → 列表循环 → 单曲循环 → 随机（对应 Web 端 cyclePlayMode）
const PLAY_MODES = ["none", "all", "one"];

// ==================== 事件总线 ====================
// 支持的事件名：play / pause / stop / ended / timeupdate / error /
//               waiting / episodeChange / modeChange / playlistChange / seek
const listeners = {};

function on(event, handler) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(handler);
}

function off(event, handler) {
  if (!listeners[event]) return;
  if (!handler) {
    listeners[event] = [];
    return;
  }
  listeners[event] = listeners[event].filter((h) => h !== handler);
}

function emit(event, payload) {
  (listeners[event] || []).forEach((handler) => {
    try {
      handler(payload);
    } catch (e) {
      console.error(`[audioManager] ${event} handler error:`, e);
    }
  });
}

// ==================== 内部状态 ====================
// 所有字段通过 getState() 快照给页面 setData 使用
const state = {
  currentEpisode: null, // { episodeid, title, audioUrl, coverUrl, podcastTitle, ... }
  playlist: [], // Episode[]
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  loopMode: "none", // 'none' | 'all' | 'one'
  isShuffle: false,
  isLoading: false, // 缓冲中（onWaiting → onCanplay 之间）
  // 精听模式标记（对齐 Android PlayerState.isIntensiveMode）：
  // 由「开始精听」入口起播时置位、普通起播复位；迷你条「精听」标签、
  // 全屏面板封面「精听中」角标据此显示。
  isIntensiveMode: false,
  // 激活中的定时关闭任务；null 表示未开启。mode：
  //   'minutes'   N 分钟后暂停（endsAt/remainingMs 驱动倒计时展示）
  //   'episodes'  播完 N 集后停止（ended 结算递减）
  //   'episodeEnd' 播完整集声音再停止（ended 即停）
  sleepTimer: null,
  // 上次使用的定时配置（定时弹层「上次定时」行 + Switch 快捷重开）
  lastSleepConfig: null,
};

let bgm = null; // wx.getBackgroundAudioManager() 实例（微信侧本就是全局单例）
let initialized = false;
let sleepInterval = null; // 分钟定时的 1s 倒计时句柄

/** 定时配置的展示文案（对齐 Android SleepConfig.describe） */
function describeSleepConfig(config) {
  if (!config) return "";
  if (config.mode === "minutes") return `${config.minutes}分钟后关闭`;
  if (config.mode === "episodes") {
    return (config.count || 1) <= 1 ? "播完本集后关闭" : `播完${config.count}集后关闭`;
  }
  if (config.mode === "episodeEnd") return "播完整集后关闭";
  return "";
}

// TODO(阶段二)：进度恢复 / 进度上报 相关的中间变量（对齐 GlobalAudio.tsx）
// let resumeTime = null;          // 待恢复的历史进度（/api/episode/[id] → userState.progressSeconds）
// let loggedEpisodeId = null;     // 已计数播放量的剧集（incrementPlayCount）
// let unsentSeconds = 0;          // 未上报的收听秒数（30s 一次 /api/auth/update-activity）

// ==================== 初始化与事件绑定 ====================

function init() {
  if (initialized) return;
  initialized = true;

  bgm = wx.getBackgroundAudioManager();

  bgm.onPlay(() => {
    state.isPlaying = true;
    state.isLoading = false;
    emit("play", getState());
  });

  bgm.onPause(() => {
    state.isPlaying = false;
    emit("pause", getState());
  });

  bgm.onStop(() => {
    state.isPlaying = false;
    emit("stop", getState());
  });

  bgm.onEnded(() => {
    state.isPlaying = false;
    // 单曲循环：微信后台音频没有 loop 属性，ended 后重设 src 实现
    if (state.loopMode === "one" && state.currentEpisode) {
      playEpisode(state.currentEpisode);
      return;
    }
    emit("ended", getState());
    // 定时关闭-按集数/播完本集：本集自然播完时结算，到量即停（不连播）
    if (_settleSleepOnEpisodeEnded()) return;
    playNext();
  });

  bgm.onTimeUpdate(() => {
    state.currentTime = bgm.currentTime || 0;
    state.duration = bgm.duration || 0;
    emit("timeupdate", getState());

    // TODO(阶段二)：进度节流上报（对齐 useSaveProgress：每 30s save 一次）
  });

  bgm.onCanplay(() => {
    state.isLoading = false;
    state.duration = bgm.duration || 0;
    // TODO(阶段二)：loadedmetadata 后执行 tryRestoreProgress()
  });

  bgm.onWaiting(() => {
    state.isLoading = true;
    emit("waiting", getState());
  });

  bgm.onError((err) => {
    state.isPlaying = false;
    state.isLoading = false;
    console.error("[audioManager] 播放错误:", err);
    wx.showToast({ title: "音频播放失败，请稍后重试", icon: "none" });
    emit("error", { ...getState(), err });
  });

  // 系统播放器（锁屏/控制中心）的上一首/下一首按钮
  bgm.onPrev(() => playPrevious());
  bgm.onNext(() => playNext());
}

// ==================== 播放控制 ====================

/**
 * 播放单集。若剧集未带直链 audioUrl，会先经
 * /api/episode/subtitles?id= 解析 OSS 签名直链（对齐 Web 端 getEpisodeAudioUrl）。
 * @param {Object} episode 剧集对象，至少含 episodeid/title
 * @param {Object} [context] 可选上下文 { playlist, intensive }：
 *   playlist 一并设置播放列表；intensive=true 表示本次起播来自「开始精听」/
 *   「精听模式」入口（对齐 Android PlayerController.play 的 intensive 参数），
 *   置位精听标记供迷你条/全屏面板展示指示器；普通起播复位该标记。
 */
async function playEpisode(episode, context) {
  if (!episode || !episode.episodeid) return;

  if (context && Array.isArray(context.playlist)) {
    state.playlist = context.playlist;
    emit("playlistChange", state.playlist);
  } else if (state.playlist.length === 0) {
    state.playlist = [episode];
    emit("playlistChange", state.playlist);
  }

  state.currentEpisode = episode;
  state.currentTime = 0;
  state.isLoading = true;
  state.isIntensiveMode = !!(context && context.intensive);

  let audioUrl = episode.audioUrl;
  if (!audioUrl) {
    // TODO(阶段二)：解析签名直链并缓存（getEpisodeSubtitlesData 同款缓存策略）
    const body = await get(
      `/api/episode/subtitles?id=${episode.episodeid}`
    ).catch(() => null);
    audioUrl = (body && body.audioUrl) || null;
    // 解析出的直链可回填 episode.audioUrl 供下次复用
    episode.audioUrl = audioUrl;
  }

  if (!audioUrl) {
    state.isLoading = false;
    wx.showToast({ title: "暂无可用音频", icon: "none" });
    emit("error", getState());
    return;
  }

  // title 是 iOS 后台播放的硬性要求，缺省会导致静音失败
  bgm.title = episode.title || "远路播客";
  bgm.epname = episode.podcastTitle || episode.podcast?.title || "";
  bgm.singer = episode.podcastTitle || "";
  bgm.coverImgUrl = episode.coverUrl || "";
  bgm.playbackRate = state.playbackRate;
  bgm.src = audioUrl; // 设置 src 即自动播放

  state.isPlaying = true;
  emit("episodeChange", getState());

  // TODO(阶段二)：
  //   1. 拉取 /api/episode/[id] 的 userState.progressSeconds 做续播；
  //   2. incrementPlayCount 播放量计数（每剧集只计一次）。
}

function pause() {
  if (bgm) bgm.pause();
}

function play() {
  if (bgm) bgm.play();
}

function togglePlay() {
  if (state.isPlaying) {
    pause();
  } else {
    play();
  }
}

/** 跳转进度（秒） */
function seek(time) {
  if (!bgm || !state.currentEpisode) return;
  const target = Math.max(0, Math.min(time, state.duration || time));
  bgm.seek(target);
  state.currentTime = target;
  emit("seek", getState());
}

/** 快进 30 秒（对齐 Web 端 forward） */
function forward(seconds = 30) {
  seek(state.currentTime + seconds);
}

/** 快退 15 秒（对齐 Web 端 backward） */
function backward(seconds = 15) {
  seek(Math.max(0, state.currentTime - seconds));
}

/** 设置倍速（部分机型不支持时静默降级） */
function setPlaybackRate(rate) {
  state.playbackRate = rate;
  try {
    if (bgm) bgm.playbackRate = rate;
  } catch (e) {
    console.warn("[audioManager] playbackRate not supported:", e);
  }
  emit("modeChange", getState());
}

// ==================== 播放列表与模式 ====================

function setPlaylist(episodes) {
  state.playlist = episodes || [];
  emit("playlistChange", state.playlist);
}

function addToPlaylist(episode) {
  if (state.playlist.some((ep) => ep.episodeid === episode.episodeid)) return;
  state.playlist.push(episode);
  emit("playlistChange", state.playlist);
}

function removeFromPlaylist(episodeId) {
  state.playlist = state.playlist.filter((ep) => ep.episodeid !== episodeId);
  emit("playlistChange", state.playlist);
}

/** 循环播放模式按钮：不循环 → 列表循环 → 单曲循环 → 随机 → 不循环 */
function cyclePlayMode() {
  if (state.isShuffle) {
    state.isShuffle = false;
    state.loopMode = "none";
  } else if (state.loopMode === "none") {
    state.loopMode = "all";
  } else if (state.loopMode === "all") {
    state.loopMode = "one";
  } else {
    state.isShuffle = true;
  }
  emit("modeChange", getState());
}

function playNext() {
  const { playlist, currentEpisode, isShuffle, loopMode } = state;
  if (!playlist.length) return;

  if (isShuffle) {
    playEpisode(playlist[Math.floor(Math.random() * playlist.length)]);
    return;
  }

  const currentIndex = playlist.findIndex(
    (ep) => ep.episodeid === currentEpisode?.episodeid
  );
  if (currentIndex === -1 || currentIndex === playlist.length - 1) {
    if (loopMode === "all") {
      playEpisode(playlist[0]);
    } else {
      state.isPlaying = false;
    }
  } else {
    playEpisode(playlist[currentIndex + 1]);
  }
}

function playPrevious() {
  const { playlist, currentEpisode, isShuffle, loopMode } = state;
  if (!playlist.length) return;

  if (isShuffle) {
    playEpisode(playlist[Math.floor(Math.random() * playlist.length)]);
    return;
  }

  const currentIndex = playlist.findIndex(
    (ep) => ep.episodeid === currentEpisode?.episodeid
  );
  if (currentIndex === -1 || currentIndex === 0) {
    if (loopMode === "all") {
      playEpisode(playlist[playlist.length - 1]);
    }
  } else {
    playEpisode(playlist[currentIndex - 1]);
  }
}

// ==================== 精听模式标记（对齐 Android setIntensiveMode） ====================

/** 手动切换精听标记（如从全屏播放器「精听模式」进入精听流时补标记），不改变播放行为 */
function setIntensiveMode(enabled) {
  state.isIntensiveMode = !!enabled;
  emit("episodeChange", getState());
}

// ==================== 定时关闭（对齐 Android applySleepConfig / handleSleepOnEpisodeEnded） ====================

function _stopSleepInterval() {
  if (sleepInterval) {
    clearInterval(sleepInterval);
    sleepInterval = null;
  }
}

function _clearSleepTimer() {
  _stopSleepInterval();
  state.sleepTimer = null;
  emit("sleepTimer", getState());
}

/** 分钟倒计时的 1s 心跳（运行时由 setInterval 驱动；单测以 _sleepTick 直驱） */
function _sleepTick() {
  const timer = state.sleepTimer;
  if (!timer || timer.mode !== "minutes") {
    _stopSleepInterval();
    return;
  }
  const remainingMs = Math.max(0, timer.endsAt - Date.now());
  // 整体替换（非原地改字段）：引用变化驱动镜像 store / 面板的差异化更新
  state.sleepTimer = { ...timer, remainingMs };
  if (remainingMs <= 0) {
    _clearSleepTimer();
    pause(); // 对齐 Android：到点暂停（会话保留，迷你条显示暂停态）
    emit("sleepTimerFired", getState());
    emit("sleepTimer", getState());
    return;
  }
  emit("sleepTimer", getState());
}

/**
 * 应用定时关闭配置（定时弹层选项）。按时间走 1s 倒计时到点暂停；
 * 按集数/播完本集在 ended 时结算。同时记忆为「上次定时」供弹层 Switch 快捷重开。
 * @param {{mode:'minutes'|'episodes'|'episodeEnd', minutes?:number, count?:number}} config
 */
function applySleepConfig(config) {
  _stopSleepInterval();
  if (!config || !config.mode) return;

  if (config.mode === "minutes") {
    const minutes = Math.max(1, Math.floor(Number(config.minutes) || 0));
    state.lastSleepConfig = { mode: "minutes", minutes };
    state.sleepTimer = {
      mode: "minutes",
      minutes,
      label: describeSleepConfig(state.lastSleepConfig),
      endsAt: Date.now() + minutes * 60 * 1000,
      remainingMs: minutes * 60 * 1000,
    };
    sleepInterval = setInterval(_sleepTick, 1000);
  } else if (config.mode === "episodes") {
    const count = Math.max(1, Math.floor(Number(config.count) || 1));
    state.lastSleepConfig = { mode: "episodes", count };
    state.sleepTimer = {
      mode: "episodes",
      count,
      label: describeSleepConfig(state.lastSleepConfig),
    };
  } else if (config.mode === "episodeEnd") {
    state.lastSleepConfig = { mode: "episodeEnd" };
    state.sleepTimer = {
      mode: "episodeEnd",
      label: describeSleepConfig(state.lastSleepConfig),
    };
  }
  emit("sleepTimer", getState());
}

/** 取消定时关闭 */
function cancelSleepTimer() {
  _clearSleepTimer();
}

/**
 * 播完一集（ended）结算定时任务（对齐 Android handleSleepOnEpisodeEnded，
 * 到量时补上真正的停止——不连播）。
 * @returns {boolean} true 表示本集播完即停（调用方不得再 playNext）
 */
function _settleSleepOnEpisodeEnded() {
  const timer = state.sleepTimer;
  if (!timer) return false;

  if (timer.mode === "episodeEnd") {
    _clearSleepTimer();
    emit("sleepTimerFired", getState());
    return true;
  }
  if (timer.mode === "episodes") {
    const remaining = (timer.count || 1) - 1;
    if (remaining <= 0) {
      _clearSleepTimer();
      emit("sleepTimerFired", getState());
      return true;
    }
    state.lastSleepConfig = { mode: "episodes", count: remaining };
    state.sleepTimer = {
      mode: "episodes",
      count: remaining,
      label: describeSleepConfig(state.lastSleepConfig),
    };
    emit("sleepTimer", getState());
    return false;
  }
  return false; // minutes：到点由倒计时暂停，不影响连播
}

/**
 * 关闭播放会话（3.B.3 迷你播放条 ×，对齐 Web closePlayer / Android stop）：
 * 停声并清空当前剧集/播放列表/进度与定时任务，hasEpisode 经事件回流为 false，
 * 跨页迷你播放条随镜像 store 整条收起（区别于 pause——会话保留、条体仍在）。
 */
function close() {
  if (bgm) {
    try {
      bgm.stop();
    } catch (e) {
      // 未起播等场景 stop 可能报错，静默
    }
  }
  _stopSleepInterval();
  state.currentEpisode = null;
  state.playlist = [];
  state.isPlaying = false;
  state.isLoading = false;
  state.currentTime = 0;
  state.duration = 0;
  state.isIntensiveMode = false;
  state.sleepTimer = null;
  emit("episodeChange", getState());
  emit("stop", getState());
}

// ==================== 生命周期与快照 ====================

/** 供页面 setData 使用的状态快照（浅拷贝，避免页面直接改内部状态） */
function getState() {
  return {
    currentEpisode: state.currentEpisode,
    isPlaying: state.isPlaying,
    isLoading: state.isLoading,
    currentTime: state.currentTime,
    duration: state.duration,
    playbackRate: state.playbackRate,
    loopMode: state.loopMode,
    isShuffle: state.isShuffle,
    playlist: state.playlist,
    hasEpisode: !!state.currentEpisode,
    isIntensiveMode: state.isIntensiveMode,
    sleepTimer: state.sleepTimer,
    lastSleepConfig: state.lastSleepConfig,
  };
}

/** App onShow：恢复心跳计时（阶段二实现收听时长上报） */
function onAppShow() {
  // TODO(阶段二)：重启 30s 心跳定时器 → POST /api/auth/update-activity { seconds }
}

/** App onHide：立即冲刷未上报的收听秒数 */
function onAppHide() {
  // TODO(阶段二)：unsentSeconds > 0 时立即上报一次
}

module.exports = {
  init,
  on,
  off,
  playEpisode,
  play,
  pause,
  togglePlay,
  seek,
  forward,
  backward,
  setPlaybackRate,
  setPlaylist,
  addToPlaylist,
  removeFromPlaylist,
  cyclePlayMode,
  playNext,
  playPrevious,
  close,
  setIntensiveMode,
  applySleepConfig,
  cancelSleepTimer,
  describeSleepConfig,
  _sleepTick,
  getState,
  onAppShow,
  onAppHide,
};
