/**
 * utils/listening-reporter.js — 收听时长心跳上报器
 *
 * 逐项移植 Android core/media/ListeningTimeReporter.kt 与 Web
 * components/player/GlobalAudio.tsx 的心跳逻辑（打卡时长的唯一写入源）：
 * - 播放中：1s 墙钟心跳累计收听秒数，满批次（30s）上报一次增量
 *   POST /api/auth/update-activity { seconds }，服务端累加
 *   user_daily_activity.listeningSeconds（= 主页打卡/学习小径/里程的数据源）
 * - 暂停/停止/关闭/换集（onPlaybackState(false)）：立即冲刷未满批次余量
 * - 按墙钟计时而非播放器进度：倍速/拖进度条不影响（Android/Web 同口径）
 * - 游客（无 token）完全跳过且不累计：避免把游客播放误记到之后登录的账号
 * - 尽力而为：失败批次丢弃、由后续批次继续累计（Web 同口径）；
 *   失败原因落 console.warn（Android 的历史教训：任何一层静默都会让
 *   “打卡不动”重新变成玄学）
 */
const { post } = require('./request');

const BATCH_SECONDS = 30;
const TAG = '[listening-reporter]';

let started = false;
let loggedIn = false;
let unsentSeconds = 0;   // 未上报的累计秒数（Web unsentSecondsRef）
let tickTimer = null;    // 1s 心跳句柄

function hasToken() {
  try {
    return !!wx.getStorageSync('token');
  } catch (e) {
    return false;
  }
}

function upload(seconds) {
  console.log(TAG, 'POST /api/auth/update-activity { seconds:', seconds, '}');
  post('/api/auth/update-activity', { seconds }, { showError: false, timeout: 8000 })
    .then(() => console.log(TAG, '✓ 上报成功：+' + seconds + 's 已计入今日学习时长'))
    .catch((err) => console.warn(
      TAG, '✗ 上报失败（本批 ' + seconds + 's 丢弃）：',
      err && (err.message || ('HTTP ' + err.statusCode))
    ));
}

/** 冲刷未满批次余量（暂停/停止/关闭时；0 为 no-op） */
function flush() {
  if (unsentSeconds > 0) {
    const seconds = unsentSeconds;
    unsentSeconds = 0;
    console.log(TAG, '冲刷未满批次余量：', seconds + 's');
    upload(seconds);
  }
}

function startTicker() {
  if (tickTimer !== null) return;
  tickTimer = setInterval(() => {
    unsentSeconds += 1;
    if (unsentSeconds >= BATCH_SECONDS) {
      const seconds = unsentSeconds;
      unsentSeconds = 0;
      upload(seconds);
    }
  }, 1000);
}

function stopTicker() {
  if (tickTimer !== null) {
    // 句柄可为 0（falsy），必须严格判 null——否则暂停分支永不清理定时器
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/**
 * 播放状态入口（audioManager 在 play/pause/stop/ended/error/close 时调用）：
 * 播放中且登录 → 计时；否则停止计时并冲刷余量（登出/游客态余量丢弃）。
 */
function onPlaybackState(isPlaying) {
  const token = hasToken();
  if (token !== loggedIn) {
    loggedIn = token;
    console.log(TAG, '登录态变更：loggedIn=' + loggedIn);
  }
  if (isPlaying && loggedIn) {
    startTicker();
  } else {
    const wasTicking = tickTimer !== null;
    stopTicker();
    if (loggedIn && (wasTicking || unsentSeconds > 0)) {
      flush(); // 暂停/停止/关闭播放器：冲刷余量
    } else if (unsentSeconds > 0) {
      console.warn(TAG, '非登录态丢弃未上报秒数：', unsentSeconds + 's');
      unsentSeconds = 0;
    }
  }
}

/** App onLaunch 启动（幂等） */
function start() {
  if (started) return;
  started = true;
  loggedIn = hasToken();
}

/** 单测隔离 */
function _reset() {
  stopTicker();
  unsentSeconds = 0;
  loggedIn = false;
  started = false;
}

module.exports = { start, onPlaybackState, flush, _reset, BATCH_SECONDS };
