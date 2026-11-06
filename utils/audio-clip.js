/**
 * utils/audio-clip.js — 语料切片原声播放底座
 * 完成「零整集 URL」改造（RESHAPE-TASK T2.1）：
 *
 * 调用方传入 clipAudioUrl（或 clipId 由 GET /api/clips/{id}/audio 解析签名直链）时，
 * 直接播放服务端物理切片（单文件 ≤40s），网络层不出现任何整集长音频请求；
 * 传入 clipOffset（切片在原字幕时间轴上的起点）时，进度回调自动加上偏移与
 * 原字幕毫秒级时间戳无缝对齐（词级高亮/切片条零改造消费）。
 *
 * 缓存为真·模块级全局 Map（失败不缓存、下次自动重试）；同一 key 播放中再次调用
 * 视为停止（toggle）。开播前经 audio-bus 停掉 TTS 等其余发声源（互斥）。
 */
const { get } = require('./request');
const audioBus = require('./audio-bus');

// 语料切片直链缓存：clipId → Promise<{ url, duration, offset }>
//（签名 URL 有效期内复用；失败不缓存可重试）
const clipCache = new Map();

let audioCtx = null;
let playingKey = null;
let loadingKey = null;
let playToken = 0; // 串联调用令牌：快速切卡时丢弃过期异步结果
let looping = false; // 单句循环（微播放器）：到窗口终点回 seek 句首续播
let loopGuardUntil = 0; // 循环回 seek 后的静默窗（真机 currentTime 是陈旧快照，防误触发二次 seek）
let progress = null; // { key, currentTime, start, end }——进度切片条数据源
const listeners = new Set();
const progressListeners = new Set();

function getState() {
  return { playingKey, loadingKey, progress };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function subscribeProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

function notify() {
  for (const fn of Array.from(listeners)) {
    try {
      fn(getState());
    } catch (e) {
      // 单个监听器异常不影响其他
    }
  }
}

function notifyProgress() {
  for (const fn of Array.from(progressListeners)) {
    try {
      fn(progress);
    } catch (e) {
      // 单个监听器异常不影响其他
    }
  }
}

/** 单句循环开关：播放中切换不打断当前播放（微播放器「单句循环」） */
function setLoop(v) {
  looping = !!v;
}

/** 文本归一化：忽略大小写、标点与多余空格——收藏的上下文句与字幕文本
 *  常有标点/引号差异，裸字符串匹配会漏（Web 实测 169 词漏 4 个） */
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[.,!?;:"'’“”()\-—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析语料切片音源（切片直连模式）：clipAudioUrl 直用；clipId 走
 * GET /api/clips/{id}/audio 换签名直链（成功缓存、失败不缓存）。
 * 两者皆无返回 null（零整集请求）。
 * @returns {Promise<{url,duration,offset}|null> | null}
 */
function resolveClipSource(params) {
  if (!params) return null;
  if (params.clipAudioUrl) {
    return Promise.resolve({
      url: params.clipAudioUrl,
      duration: Number(params.clipDuration) || 0,
      offset: Number(params.clipOffset) || 0,
    });
  }
  if (params.clipId) {
    const id = String(params.clipId);
    if (!clipCache.has(id)) {
      const p = get('/api/clips/' + encodeURIComponent(id) + '/audio')
        .then((res) => {
          if (!res || !res.success || !res.data || !res.data.url) {
            throw new Error('clip fetch failed');
          }
          return {
            url: res.data.url,
            duration: Number(res.data.duration) || 0,
            offset: Number(res.data.clipOffset != null ? res.data.clipOffset : res.data.offset) || 0,
          };
        })
        .catch((err) => {
          clipCache.delete(id);
          throw err;
        });
      clipCache.set(id, p);
    }
    return clipCache.get(id);
  }
  return null;
}

/** 停止播放。先摘事件处理器再销毁：停止/销毁动作可能触发 error 事件，
 *  残留的 onError 会导致正常播完后误弹「原声加载失败」（Web 同款防御） */
function stop() {
  const ctx = audioCtx;
  audioCtx = null;
  playingKey = null;
  looping = false;
  if (progress) {
    progress = null;
    notifyProgress();
  }
  if (ctx) {
    try {
      ctx.offCanplay();
      ctx.offTimeUpdate();
      ctx.offEnded();
      ctx.offError();
    } catch (e) {
      // 低版本基础库 off* 缺失时忽略
    }
    try {
      ctx.stop();
      ctx.destroy();
    } catch (e) {
      // 忽略
    }
  }
  notify();
}

/**
 * 统一起播内核：窗口 [winStart, winEnd]（音源本地秒），offset = 音源起点在
 * 原字幕时间轴上的偏移（进度回调统一 +offset 对齐字幕毫秒时间戳）。
 * winEnd 为 null 时播到文件自然结束。
 */
function startWindow(url, key, token, winStart, winEnd, offset) {
  const ctx = wx.createInnerAudioContext();
  audioCtx = ctx;
  ctx.src = url;
  const localStart = Math.max(0, winStart);
  ctx.onCanplay(() => {
    if (token !== playToken) return;
    if (localStart > 0) ctx.seek(localStart);
    ctx.play();
    playingKey = key;
    notify();
  });
  ctx.onTimeUpdate(() => {
    if (token !== playToken) return;
    const t = ctx.currentTime || 0;
    progress = {
      key,
      currentTime: t + offset,
      start: localStart + offset,
      end: winEnd != null ? winEnd + offset : null,
    };
    notifyProgress();
    // 到窗口终点：单句循环回 seek 句首续播，否则自动停止
    if (winEnd != null && t >= winEnd) {
      if (looping) {
        const now = Date.now();
        if (now < loopGuardUntil) return;
        loopGuardUntil = now + 600;
        progress = { key, currentTime: localStart + offset, start: localStart + offset, end: winEnd + offset };
        notifyProgress();
        ctx.seek(Math.max(0, localStart));
        ctx.play();
      } else {
        stop();
      }
    }
  });
  ctx.onEnded(() => stop());
  ctx.onError(() => {
    wx.showToast({ title: '原声加载失败', icon: 'none' });
    stop();
  });
}

/**
 * 播放一段语料切片原声。
 * @param {Object} params
 * @param {string} params.key 播放项唯一标识，用于状态高亮
 * @param {string} [params.clipAudioUrl] 服务端物理切片签名直链（切片直连）
 * @param {string} [params.clipId] 语料切片 id（经 /api/clips/{id}/audio 解析直链）
 * @param {number} [params.clipDuration] 切片时长（秒；无显式窗口时整段播放）
 * @param {number} [params.clipOffset] 切片在原字幕时间轴上的起点（秒）
 * @param {number} [params.startTime] 目标起点（字幕绝对时间秒）
 * @param {number} [params.endTime] 目标终点（字幕绝对时间秒）
 * @param {Function} [params.onBeforePlay] 播放前回调（页面级额外清理）
 */
async function play(params) {
  const {
    key, episodeid, startTime, endTime, onBeforePlay,
    clipId, clipAudioUrl,
  } =
    params || {};
  if (!key || (!episodeid && !clipAudioUrl && !clipId)) return;
  if (playingKey === key) {
    stop(); // 同 key 再点 = 停止（toggle）
    return;
  }
  stop();
  if (typeof onBeforePlay === 'function') {
    try {
      onBeforePlay();
    } catch (e) {
      // 页面回调异常不阻断播放
    }
  }
  audioBus.stopAll(CLIP_STOP); // 停 TTS 等其余发声源（互斥）

  const token = ++playToken;
  loadingKey = key;
  notify();
  try {
    // ── 切片直连（唯一合规通道，零整集 URL）：显式 startTime/endTime 为字幕绝对时间 →
    //    换算切片内相对窗口；无显式窗口整段播放（0 ~ duration）
    const clip = resolveClipSource(params);
    if (!clip) {
      wx.showToast({ title: '暂时无法播放原声', icon: 'none' });
      return;
    }
    const resolved = await clip;
    if (token !== playToken) return;
    if (!resolved.url) {
      wx.showToast({ title: '暂时无法播放原声', icon: 'none' });
      return;
    }
    const offset = resolved.offset || 0;
    const explicit =
      typeof startTime === 'number' &&
      isFinite(startTime) &&
      typeof endTime === 'number' &&
      isFinite(endTime);
    if (explicit) {
      startWindow(resolved.url, key, token, Math.max(0, startTime - offset), endTime - offset, offset);
    } else if (resolved.duration > 0) {
      startWindow(resolved.url, key, token, 0, resolved.duration, offset);
    } else {
      startWindow(resolved.url, key, token, 0, null, offset);
    }
  } catch (e) {
    wx.showToast({ title: '原声信息加载失败', icon: 'none' });
    stop();
  } finally {
    if (token === playToken) {
      loadingKey = null;
      notify();
    }
  }
}

// 注册进互斥总线：TTS 开播前会停掉本模块
const CLIP_STOP = () => stop();
audioBus.register(CLIP_STOP);

module.exports = {
  play,
  stop,
  getState,
  subscribe,
  subscribeProgress,
  setLoop,
  normalizeText, // 导出供测试与生词高亮等复用
  resolveClipSource, // 切片直连解析（测试断言请求口径用）
};
