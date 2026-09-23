/**
 * utils/tts.js — 有道 TTS 朗读服务
 * 复刻 Web 端 useVocabularyNotebook 的 speakViaTts / playContextAudio / playAudio：
 *
 * - POST /api/dictionary/youdao { word: text } → speakUrl → InnerAudioContext 播放
 * - 同文本播放中再调 = 停止（toggle）；playingText 供按钮高亮
 * - playUrl(url, fallbackText)：词典发音直链播放，音源失败降级 TTS 合成
 *   （dictvoice 对部分复合词/生僻词返回 5xx，Web 同款兜底）
 * - 真机播放失败修复（2026-09-23，模拟器正常/真机 onError 的三重防线）：
 *   ① 音源 http:// 一律升 https（iOS ATS 拒绝明文音源，工具不校验）；
 *   ② speakUrl 播放 onError 自动降级 dictvoice 直链重试一次
 *      （https://dict.youdao.com/dictvoice，Web 音素对比同源）；
 *   ③ onError 落 console.error（含 errCode/errMsg），真机 vConsole 可定位
 *      「域名不在 downloadFile 合法域名」类配置问题。
 *   ※ 配置层前提：小程序后台 downloadFile 合法域名须含
 *      openapi.youdao.com 与 dict.youdao.com（开发者工具 urlCheck:false
 *      不暴露该问题，见 WE-TASK 4.2）。
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
let playingText = null; // TTS 合成朗读中的文本（高亮用，对齐 Web playingText）
let playingUrl = null; // 词典发音直链播放中的 url（playUrl，toggle 用）
let quotaHandler = null;
const listeners = new Set();

function getState() {
  return { playingText, playingUrl };
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

/** 读取当前处理器（子页面入栈/退栈时保存-恢复用，避免误清宿主页面的注册） */
function getQuotaHandler() {
  return quotaHandler;
}

/**
 * 真机音源 URL 规范化：http:// 强制升 https://。
 * 微信开发者工具不校验协议，真机（尤其 iOS）对 http 音源直接 onError——
 * 有道 OpenAPI 回传的 speakUrl 偶为 http，是「模拟器正常、真机播放失败」
 * 的成因之一。
 */
function normalizeUrl(url) {
  if (typeof url !== 'string') return url;
  return url.indexOf('http://') === 0 ? 'https://' + url.slice(7) : url;
}

/**
 * 有道词典网页版 TTS 直链（dictvoice）——OpenAPI speakUrl 真机不可用时的
 * 降级音源。与 Web 端语音评测音素对比播放同源（dict.youdao.com/dictvoice）。
 */
function buildDictvoiceUrl(text) {
  return (
    'https://dict.youdao.com/dictvoice?audio=' +
    encodeURIComponent(text) +
    '&type=2'
  );
}

/**
 * 创建 InnerAudioContext 播放一段音源；onError 时若有 fallbackUrl 自动降级
 * 重试一次（换 ctx，保持 playingText 高亮不闪断）。
 * 真机失败主因（供排查参考）：域名不在 downloadFile 合法域名 /
 * http 音源 / speakUrl 签名过期，errMsg 会带具体 errCode。
 */
function startPlay(url, fallbackUrl) {
  const ctx = wx.createInnerAudioContext();
  audioCtx = ctx;
  ctx.src = url;
  ctx.onEnded(() => {
    if (audioCtx === ctx) {
      clearCtx();
      playingText = null;
      playingUrl = null;
      notify();
    }
  });
  ctx.onError((err) => {
    if (audioCtx !== ctx) return;
    console.error(
      '[tts] audio error:',
      url,
      err && (err.errMsg || ('code ' + err.errCode)),
    );
    if (fallbackUrl) {
      clearCtx(); // 保留 playingText，降级音源无缝接管
      startPlay(fallbackUrl, null);
      return;
    }
    stop();
    wx.showToast({ title: '播放失败', icon: 'none' });
  });
  ctx.play();
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
  playingUrl = null;
  notify();
}

/**
 * 词典发音直链播放 + TTS 合成兜底（复刻 Web playAudio）。
 *
 * @param {string|null} url 词典音源直链（dictData.audio_urls.us/uk、speakUrl）
 * @param {string|null} fallbackText 音源失败（dictvoice 未收录复合词/生僻词返回 5xx）
 *   或 url 为空时降级 TTS 合成的文本（通常为单词本身）
 * @returns {Promise<boolean>} true = 已开始播放；false = 停止或失败
 */
async function playUrl(url, fallbackText) {
  if (!url) {
    // 无词典发音地址：直接走 TTS 合成（Web 同款分支）
    if (fallbackText) {
      const ok = await speak(fallbackText);
      if (!ok) wx.showToast({ title: '暂无发音', icon: 'none' });
      return ok;
    }
    wx.showToast({ title: '暂无发音', icon: 'none' });
    return false;
  }
  const normalized = normalizeUrl(url); // 真机 http 音源直接 onError，统一升 https
  if (playingUrl === normalized) {
    stop(); // 同直链再点 = 停止（toggle，与 speak 行为一致）
    return false;
  }
  stop();
  audioBus.stopAll(TTS_STOP); // 停原声片段与全局播放器（互斥）

  playingUrl = normalized;
  notify();
  const ctx = wx.createInnerAudioContext();
  audioCtx = ctx;
  ctx.src = normalized;
  const fallback = async () => {
    if (audioCtx !== ctx) return;
    clearCtx();
    playingUrl = null;
    notify();
    if (fallbackText) {
      const ok = await speak(fallbackText);
      if (!ok) wx.showToast({ title: '播放失败', icon: 'none' });
    } else {
      wx.showToast({ title: '播放失败', icon: 'none' });
    }
  };
  ctx.onEnded(() => {
    if (audioCtx === ctx) {
      clearCtx();
      playingUrl = null;
      notify();
    }
  });
  ctx.onError((err) => {
    console.error(
      '[tts] audio error:',
      normalized,
      err && (err.errMsg || ('code ' + err.errCode)),
    );
    fallback();
  });
  ctx.play();
  return true;
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
    const speakUrl = normalizeUrl(res && res.speakUrl);
    if (!speakUrl) {
      // OpenAPI 未回传 speakUrl：直接用 dictvoice 降级音源（不再裸 toast）
      startPlay(buildDictvoiceUrl(text), null);
      return true;
    }
    // 主音源 = OpenAPI speakUrl（签名短时效，真机域名/协议受限时 onError）；
    // 降级 = dictvoice 直链（https，Web 端音素对比同源）
    startPlay(speakUrl, buildDictvoiceUrl(text));
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
  playUrl,
  stop,
  getState,
  subscribe,
  setQuotaHandler,
  getQuotaHandler,
};
