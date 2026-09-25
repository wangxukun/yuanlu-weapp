/**
 * utils/progress-reporter.js — 收听进度双端同步器（断点续播）
 *
 * 逐项移植三端已有口径：
 *   Android core/media/ProgressReporter.kt + Web lib/hooks/useSaveProgress.ts
 *   （上报）：播放中与上次保存位置相差 ≥15s 周期上报；暂停/停止立即上报；
 *             距结尾 5s 内视为听完（isFinished=true）；播完只报一次 finished，
 *             此后不再覆盖（直到切集）；切集冲刷上一集最终进度（isFinished=false）；
 *             游客（无 token）跳过远端；失败静默（尽力而为）。
 *   Android PlayerViewModel.resumePositionMs + Web GlobalAudio.tsx
 *   （续播）：isFinished → 从头；进度 ≤30s → 从头；距结尾 15s 内 → 从头；
 *            其余续播该位置。远端（/api/episode/detail 的 userState）优先，
 *            接口失败/未登录降级本地缓存。
 *
 * 小程序侧新增（用户可见诉求）：
 *   - 本地高频节流缓存（3s）于 wx storage（断网/游客也能续播）；
 *   - 远端走 POST（wx.request 不支持 PATCH，后端已导出 PATCH as POST 别名）；
 *   - onPlay 首帧安全 seek（音频未起播不 seek，对齐 Web tryRestoreProgress 的
 *     readyState 门控）；跳转成功轻提示「已为您跳转至上次播放位置」。
 *
 * 不抛异常：所有上报/读写失败一律静默，绝不影响播放主流程。
 * 供 utils/audioManager 接线与 scripts/test-progress-reporter.js 单测共用。
 */
const { get, post } = require('./request');

// ==================== 常量（三端口径） ====================
const PROGRESS_KEY = 'audioProgressMap'; // 本地进度表：{ [episodeid]: {position, duration, updatedAt} }
const MAP_CAP = 50;                      // 本地表上限（LRU 按 updatedAt 剪裁）
const LOCAL_SAVE_INTERVAL = 3;           // 本地节流（秒）
const REMOTE_INTERVAL = 15;              // 远端周期（秒，对齐 Android/Web）
const NEAR_END_FINISHED = 5;             // 暂停时距尾 ≤5s 视为听完
const RESUME_MIN = 30;                   // 续播阈值：≤30s 从头（Android resumePositionMs）
const RESUME_NEAR_END = 15;              // 续播阈值：距尾 ≤15s 视为已听完从头播

// ==================== 内部状态 ====================
let trackedEpisodeId = null;    // 当前跟踪的剧集（切集冲刷用）
let trackedPosition = 0;        // 最近已知位置（handleTime 持续刷新）
let trackedDuration = 0;

let lastSavedRemote = 0;        // 上次成功发起远端上报的位置（去重）
let lastSaveWasFinished = false;// 上次上报是否 finished（防切集覆盖）
let lastLocalPosition = -1;     // 上次写入本地的位置（3s 节流）

let pendingResume = null;       // { episodeId, position, applied } 起播待续播位置

// ==================== 本地缓存 ====================

function readMap() {
  try {
    const raw = wx.getStorageSync(PROGRESS_KEY);
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    return {};
  }
}

function writeMap(map) {
  try {
    wx.setStorageSync(PROGRESS_KEY, map);
  } catch (e) {
    /* 存储失败静默 */
  }
}

/** 写入单集本地进度（3s 节流由调用方 handleTime 控制） */
function saveLocal(episodeId, position, duration) {
  if (!episodeId || !(position > 0)) return;
  const map = readMap();
  map[episodeId] = {
    position: Math.round(position * 10) / 10,
    duration: duration > 0 ? Math.round(duration) : 0,
    updatedAt: Date.now(),
  };
  // 超上限剪裁最旧的
  const keys = Object.keys(map);
  if (keys.length > MAP_CAP) {
    keys
      .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
      .slice(0, keys.length - MAP_CAP)
      .forEach((k) => delete map[k]);
  }
  writeMap(map);
  lastLocalPosition = position;
}

function readLocal(episodeId) {
  if (!episodeId) return 0;
  const rec = readMap()[episodeId];
  return rec && rec.position > 0 ? rec.position : 0;
}

function clearLocal(episodeId) {
  if (!episodeId) return;
  const map = readMap();
  if (map[episodeId]) {
    delete map[episodeId];
    writeMap(map);
  }
}

// ==================== 远端上报 ====================

function hasToken() {
  try {
    return !!wx.getStorageSync('token');
  } catch (e) {
    return false;
  }
}

/**
 * 上报进度（尽力而为）：游客跳过（progress 接口需登录，对齐 Android）；
 * 失败静默。wx.request 不支持 PATCH → POST（后端已导出别名）。
 */
function upload(episodeId, progressSeconds, isFinished) {
  if (!episodeId || !hasToken()) return Promise.resolve();
  return post(
    '/api/episode/' + encodeURIComponent(episodeId) + '/progress',
    { progressSeconds: Math.max(0, progressSeconds), isFinished: !!isFinished },
    { showError: false, timeout: 8000 }
  ).catch(() => { /* 进度上报失败不影响播放 */ });
}

// ==================== 事件入口（audioManager 接线） ====================

/**
 * 切集入口：冲刷上一集最终进度并复位跟踪（playEpisode 起播时调用；
 * close 清空会话时传 null）。finished 已报过则不再覆盖（对齐切歌逻辑）。
 */
function setEpisode(episodeId) {
  if (episodeId !== trackedEpisodeId) {
    const previous = trackedEpisodeId;
    if (previous && !lastSaveWasFinished &&
      trackedPosition > 0 && trackedPosition !== lastSavedRemote) {
      upload(previous, trackedPosition, false);
    }
    trackedEpisodeId = episodeId || null;
    trackedPosition = 0;
    trackedDuration = 0;
    lastSavedRemote = 0;
    lastSaveWasFinished = false;
    lastLocalPosition = -1;
    if (episodeId) prepareResume(episodeId);
  }
  return trackedEpisodeId;
}

/**
 * 播放中（onTimeUpdate）：本地 3s 节流 + 远端 15s 位置差周期上报。
 */
function handleTime(episodeId, position, duration) {
  if (!episodeId || episodeId !== trackedEpisodeId) return;
  trackedPosition = position || 0;
  if (duration > 0) trackedDuration = duration;

  // 本地高频缓存（回退/位置跳变也落一次）
  if (position > 0 && (lastLocalPosition < 0 ||
    Math.abs(position - lastLocalPosition) >= LOCAL_SAVE_INTERVAL)) {
    saveLocal(episodeId, position, trackedDuration);
  }

  // 远端低频同步（对齐 Android：与上次保存位置相差 ≥ intervalMs）
  if (position > 0 && Math.abs(position - lastSavedRemote) >= REMOTE_INTERVAL) {
    lastSavedRemote = position;
    upload(episodeId, position, false);
  }
}

/**
 * 暂停 / 停止 / 冲刷（onPause / onStop / close / App onHide）：
 * 位置有效且与上次上报不同 → 立即上报；距尾 ≤5s 视为听完并清本地。
 */
function handlePause(episodeId, position, duration) {
  if (!episodeId || episodeId !== trackedEpisodeId) return;
  if (!(position > 0) || position === lastSavedRemote) return;
  const finished = duration > 0 && position >= duration - NEAR_END_FINISHED;
  lastSavedRemote = position;
  lastSaveWasFinished = finished;
  if (finished) {
    clearLocal(episodeId);
  } else {
    saveLocal(episodeId, position, duration);
  }
  upload(episodeId, position, finished);
}

/**
 * 自然播完（onEnded）：上报 isFinished=true（只报一次）并清本地，
 * 避免下次播放跳到末尾。
 */
function handleEnded(episodeId, position) {
  if (!episodeId || episodeId !== trackedEpisodeId) return;
  clearLocal(episodeId);
  if (!lastSaveWasFinished) {
    lastSaveWasFinished = true;
    lastSavedRemote = position || trackedPosition;
    upload(episodeId, position || trackedPosition, true);
  }
}

// ==================== 断点续播（远端优先 → 本地降级） ====================

/**
 * 起播前准备续播位置（playEpisode 内调用）：先同步读本地（快路径），
 * 登录态下再异步拉 /api/episode/detail 的 userState（多端一致的远端进度，
 * 对齐 Web fetchEpisodeStatus）；远端在首帧 seek 应用前返回则覆盖本地值。
 */
function prepareResume(episodeId) {
  pendingResume = { episodeId, position: readLocal(episodeId), applied: false };
  if (!hasToken()) return pendingResume;
  get('/api/episode/detail?id=' + encodeURIComponent(episodeId), null, { showError: false, timeout: 5000 })
    .then((body) => {
      const us = body && body.userState;
      if (!pendingResume || pendingResume.applied ||
        pendingResume.episodeId !== episodeId || !us) return;
      if (us.isFinished) {
        pendingResume.position = 0;
      } else if (typeof us.progressSeconds === 'number' && us.progressSeconds > 0) {
        pendingResume.position = us.progressSeconds;
      }
    })
    .catch(() => { /* 远端失败 → 维持本地降级值 */ });
  return pendingResume;
}

/**
 * 首帧安全 seek（bgm.onPlay 时调用；音频未起播绝不 seek）：
 * 应用待续播位置并返回之（0 = 从头播，不 seek）。阈值口径＝Android：
 * ≤30s 不续播；duration 已知且距尾 ≤15s 视为已听完从头播。只应用一次。
 */
function applyResume(episodeId, duration) {
  if (!pendingResume || pendingResume.applied || pendingResume.episodeId !== episodeId) {
    return 0;
  }
  pendingResume.applied = true;
  const position = pendingResume.position;
  pendingResume = null;
  if (!(position >= RESUME_MIN)) return 0;
  if (duration > 0 && position >= duration - RESUME_NEAR_END) return 0;
  return position;
}

/** 单测隔离：复位全部内部状态 */
function _reset() {
  trackedEpisodeId = null;
  trackedPosition = 0;
  trackedDuration = 0;
  lastSavedRemote = 0;
  lastSaveWasFinished = false;
  lastLocalPosition = -1;
  pendingResume = null;
}

module.exports = {
  setEpisode,
  handleTime,
  handlePause,
  handleEnded,
  prepareResume,
  applyResume,
  flush: () => handlePause(trackedEpisodeId, trackedPosition, trackedDuration),
  readLocal,
  saveLocal,
  clearLocal,
  _reset,
  // 常量透传（单测口径）
  LOCAL_SAVE_INTERVAL,
  REMOTE_INTERVAL,
  NEAR_END_FINISHED,
  RESUME_MIN,
  RESUME_NEAR_END,
  PROGRESS_KEY,
};
