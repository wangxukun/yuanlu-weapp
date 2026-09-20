/**
 * utils/audio-clip.js — 字幕对齐的剧集原声片段播放
 * 复刻 Web 端 useOriginalAudio.ts（与语音评测 playReferenceAudio 同款实现）：
 *
 * 1. 拉取剧集规范化字幕（含词级时间戳）与 OSS 签名直链（直连不走代理——
 *    CBR M4A 直连 seek 落点精确，代理流式 body 与 206 Range seek 冲突）
 * 2. 定位目标字幕句：上下文句文本匹配优先（归一化后双向包含），
 *    vocabulary.timestamp 与字幕时间轴普遍不一致、仅作兜底
 *    （Web 实测：169 词文本匹配命中 98%+，纯 timestamp 仅 10% 能对上句）
 * 3. 播放窗口：词级 words[0].start → words[last].end，句级时间兜底
 *
 * 缓存为真·模块级全局 Map（Web 端 hook 实例级缓存的缺陷在此修正，
 * 失败不缓存、下次自动重试）；同一 key 播放中再次调用视为停止（toggle）。
 * 开播前经 audio-bus 停掉 TTS 与全局背景播放器（互斥）。
 */
const { get } = require('./request');
const audioBus = require('./audio-bus');

// 剧集字幕 + 签名音频直链缓存：episodeid → Promise<{ audioUrl, subtitles }>
const sourceCache = new Map();

let audioCtx = null;
let playingKey = null;
let loadingKey = null;
let playToken = 0; // 串联调用令牌：快速切卡时丢弃过期异步结果
const listeners = new Set();

function getState() {
  return { playingKey, loadingKey };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
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

/** 文本归一化：忽略大小写、标点与多余空格——收藏的上下文句与字幕文本
 *  常有标点/引号差异，裸字符串匹配会漏（Web 实测 169 词漏 4 个） */
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[.,!?;:"'’“”()\-—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取剧集字幕源（按剧集全局缓存 + 请求去重；失败不缓存可重试） */
function getSource(episodeid) {
  if (!sourceCache.has(episodeid)) {
    const p = get('/api/episode/subtitles?id=' + episodeid)
      .then((res) => {
        if (!res || !res.success) {
          throw new Error('fetch failed');
        }
        return { audioUrl: res.audioUrl || null, subtitles: res.data || [] };
      })
      .catch((err) => {
        sourceCache.delete(episodeid);
        throw err;
      });
    sourceCache.set(episodeid, p);
  }
  return sourceCache.get(episodeid);
}

/**
 * 定位目标字幕句：文本匹配优先（归一化双向包含），时间戳落句兜底。
 */
function locateSubtitle(subtitles, contextSentence, timestamp) {
  let target = null;
  if (contextSentence) {
    const norm = normalizeText(contextSentence);
    target =
      subtitles.find(
        (s) =>
          norm.includes(normalizeText(s.textEn)) ||
          normalizeText(s.textEn).includes(norm),
      ) || null;
  }
  if (!target) {
    const ts = timestamp || 0;
    target =
      subtitles.find(
        (s) =>
          ts >= s.start && (s.end === undefined || s.end === null || ts <= s.end),
      ) || null;
  }
  return target;
}

/** 播放窗口：词级起止优先；句级兜底（end 缺省 = start + 3s，与 Web 一致） */
function computeWindow(target) {
  const words = target.words || [];
  const targetStart = words.length > 0 ? words[0].start : target.start;
  const endTime =
    words.length > 0
      ? words[words.length - 1].end
      : target.end != null
        ? target.end
        : targetStart + 3;
  return { targetStart, endTime };
}

/** 停止播放。先摘事件处理器再销毁：停止/销毁动作可能触发 error 事件，
 *  残留的 onError 会导致正常播完后误弹「原声加载失败」（Web 同款防御） */
function stop() {
  const ctx = audioCtx;
  audioCtx = null;
  playingKey = null;
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
 * 播放一段原声片段。
 * @param {Object} params
 * @param {string} params.key 播放项唯一标识（惯例 `${episodeid}:${word}`），用于状态高亮
 * @param {string} params.episodeid 剧集 id
 * @param {number|null} [params.timestamp] 目标时间戳（秒），定位兜底
 * @param {string|null} [params.contextSentence] 目标句文本，定位优先
 * @param {Function} [params.onBeforePlay] 播放前回调（页面级额外清理）
 */
async function play(params) {
  const { key, episodeid, timestamp, contextSentence, onBeforePlay } =
    params || {};
  if (!key || !episodeid) return;
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
  audioBus.stopAll(CLIP_STOP); // 停 TTS 与全局播放器（互斥）

  const token = ++playToken;
  loadingKey = key;
  notify();
  try {
    const source = await getSource(episodeid);
    if (token !== playToken) return; // 期间已切到别的片段

    if (!source.audioUrl) {
      // 未登录/token 失效时接口回 audioUrl=null
      wx.showToast({ title: '暂时无法播放原声', icon: 'none' });
      return;
    }

    const target = locateSubtitle(source.subtitles, contextSentence, timestamp);
    if (!target) {
      wx.showToast({ title: '未找到该句的原声位置', icon: 'none' });
      return;
    }

    const { targetStart, endTime } = computeWindow(target);
    // 防御：个别字幕缺时间字段，非有限值按未定位处理，避免 seek NaN
    if (!isFinite(targetStart) || !isFinite(endTime)) {
      wx.showToast({ title: '未找到该句的原声位置', icon: 'none' });
      return;
    }

    const ctx = wx.createInnerAudioContext();
    audioCtx = ctx;
    ctx.src = source.audioUrl;
    ctx.onCanplay(() => {
      if (token !== playToken) return;
      ctx.seek(Math.max(0, targetStart));
      ctx.play();
      playingKey = key;
      notify();
    });
    ctx.onTimeUpdate(() => {
      // 到窗口终点自动停止
      if ((ctx.currentTime || 0) >= endTime) {
        stop();
      }
    });
    ctx.onEnded(() => stop());
    ctx.onError(() => {
      wx.showToast({ title: '原声加载失败', icon: 'none' });
      stop();
    });
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
  normalizeText, // 导出供测试与生词高亮等复用
};
