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
let token = '';
let pendingMs = 0;
let lastTick = null;
let tickTimer = null;

function currentToken() {
  try { return wx.getStorageSync('token') || ''; } catch (e) { return ''; }
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

function accountElapsed() {
  const current = currentToken();
  const now = Date.now();
  if (current !== token) {
    pendingMs = 0;
    token = current;
  } else if (token && lastTick !== null) {
    pendingMs += Math.max(0, now - lastTick);
  }
  lastTick = now;
}

function sendWholeSeconds() {
  const seconds = Math.floor(pendingMs / 1000);
  if (!seconds) return;
  pendingMs -= seconds * 1000;
  upload(seconds);
}

function flush() {
  if (tickTimer !== null) accountElapsed();
  sendWholeSeconds();
}

function onPlaybackState(isPlaying) {
  accountElapsed();
  if (isPlaying && token) {
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => {
      accountElapsed();
      if (pendingMs >= BATCH_SECONDS * 1000) sendWholeSeconds();
    }, 1000);
  } else {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
    lastTick = null;
    sendWholeSeconds();
  }
}

function start() {
  if (started) return;
  started = true;
  token = currentToken();
}

function _reset() {
  started = false;
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
  pendingMs = 0;
  lastTick = null;
  token = '';
}

module.exports = { start, onPlaybackState, flush, _reset, BATCH_SECONDS };
