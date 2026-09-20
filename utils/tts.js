/**
 * utils/tts.js — 有道 TTS 朗读服务
 * 复刻 Web 端 useVocabularyNotebook 的 speakViaTts / playContextAudio：
 *
 * - POST /api/dictionary/youdao { word: text } → speakUrl → InnerAudioContext 播放
 * - 同文本播放中再调 = 停止（toggle）；playingText 供按钮高亮
 * - 配额触墙（403 DICTIONARY_QUOTA_EXCEEDED，免费 30 次/日）：
 *   request.js 已统一 toast message，这里只触发 quotaHandler('dictionary_quota')
 *   打开会员弹窗（对齐 Web「先 toast 再 openPremiumModal」的顺序，不重复 toast）
 * - 开播前经 audio-bus 停掉原声片段与全局背景播放器（互斥）
 *
 * quotaHandler 由页面注册（premium-modal 实例归页面所有）：
 *   tts.setQuotaHandler((source) => this.setData({ showPremiumModal: true, premiumSource: source }))
 */
const { post } = require('./request');
const audioBus = require('./audio-bus');

let audioCtx = null;
let playingText = null;
let quotaHandler = null;
const listeners = new Set();

function getState() {
  return { playingText };
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

/** 页面注册配额触墙处理器（打开 premium-modal，source = dictionary_quota） */
function setQuotaHandler(fn) {
  quotaHandler = typeof fn === 'function' ? fn : null;
}

function clearCtx() {
  const ctx = audioCtx;
  audioCtx = null;
  if (ctx) {
    try {
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
}

function stop() {
  clearCtx();
  playingText = null;
  notify();
}

/**
 * 朗读任意文本。
 * @returns {Promise<boolean>} true = 已开始播放；false = toggle 停止或失败
 */
async function speak(text) {
  if (!text) return false;
  if (playingText === text) {
    stop(); // 同文本再点 = 停止（toggle）
    return false;
  }
  stop();
  audioBus.stopAll(TTS_STOP); // 停原声片段与全局播放器（互斥）

  playingText = text; // 先置状态供按钮高亮（Web 同款：请求前置）
  notify();
  try {
    const res = await post('/api/dictionary/youdao', { word: text });
    const speakUrl = res && res.speakUrl;
    if (!speakUrl) {
      wx.showToast({ title: '暂无朗读资源', icon: 'none' });
      playingText = null;
      notify();
      return false;
    }

    const ctx = wx.createInnerAudioContext();
    audioCtx = ctx;
    ctx.src = speakUrl;
    ctx.onEnded(() => {
      if (audioCtx === ctx) {
        clearCtx();
        playingText = null;
        notify();
      }
    });
    ctx.onError(() => {
      if (audioCtx === ctx) {
        wx.showToast({ title: '播放失败', icon: 'none' });
        stop();
      }
    });
    ctx.play();
    return true;
  } catch (err) {
    if (err && err.code === 'DICTIONARY_QUOTA_EXCEEDED') {
      // request.js 已 toast message（今日 30 次免费已用完…）；
      // 只负责打开会员转化弹窗（对齐 Web 口径：免费 30 次/日，PRO 无限）
      if (typeof quotaHandler === 'function') {
        try {
          quotaHandler('dictionary_quota');
        } catch (e) {
          // 页面回调异常不影响状态复位
        }
      }
    }
    // 其余错误 request.js 已统一 toast，这里静默复位即可
    playingText = null;
    notify();
    return false;
  }
}

// 注册进互斥总线：原声片段开播前会停掉本模块
const TTS_STOP = () => stop();
audioBus.register(TTS_STOP);

module.exports = {
  speak,
  stop,
  getState,
  subscribe,
  setQuotaHandler,
};
