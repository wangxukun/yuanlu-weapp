/**
 * utils/tts.js — 有道 TTS 朗读服务
 * 复刻 Web 端 useVocabularyNotebook 的 speakViaTts / playContextAudio / playAudio：
 *
 * - POST /api/dictionary/youdao { word: text } → speakUrl → InnerAudioContext 播放
 * - 同文本播放中再调 = 停止（toggle）；playingText 供按钮高亮
 * - playUrl(url, fallbackText)：词典发音直链播放，音源失败降级 TTS 合成
 *   （dictvoice 对部分复合词/生僻词返回 5xx，Web 同款兜底）
 * - 真机播放失败修复（2026-09-23，模拟器正常/真机失败的四级防线）：
 *   ① 音源 http:// 一律升 https（iOS ATS 拒绝明文音源，工具不校验）；
 *   ② 音源先经 wx.downloadFile 中转再播本地临时文件（真机移动网络直拉
 *      openapi.youdao.com 偶发 504 网关超时；下载超时 15s + fail 重试一次
 *      + 成功缓存，同文本重播零网络）；
 *   ③ 下载失败回退同 URL 直接流播；播放 onError 时短文本（≤60 字符）降级
 *      dictvoice 直链（词典级接口，长句必 500 不降级）；
 *   ④ onError 落 console.error（含 errCode/errMsg），域名校验失败
 *      （errMsg 含 domain）自动弹「音源域名未配置」指引 Modal。
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
 * ⚠️ 仅支持单词/短语级短文本：实测 100 字符即返回 500（returned null audio），
 * 长句降级必然失败，由 DICTVOICE_MAX_LEN 门限拦截。
 */
function buildDictvoiceUrl(text) {
  return (
    'https://dict.youdao.com/dictvoice?audio=' +
    encodeURIComponent(text) +
    '&type=2'
  );
}

const DICTVOICE_MAX_LEN = 60;

/**
 * 音频下载中转（真机 504 修复核心，2026-09-23）：
 * 微信媒体播放器在真机移动网络下直拉 openapi.youdao.com 偶发 504 网关超时
 * （errCode 504 / error player to stop；同一 URL PC 网络 200/audio/mp3 正常，
 * 模拟器因此不复现）——改为 wx.downloadFile 先落本地临时文件再播：
 * 超时可控（15s）、fail 自动重试一次、成功即缓存（同文本重播零网络）。
 * 域名校验同走 downloadFile 合法域名（openapi/dict.youdao.com 均已配）。
 */
const audioCache = new Map(); // url → tempFilePath（简单 LRU，上限 30）
const AUDIO_CACHE_MAX = 30;

function downloadAudio(url, retried) {
  return new Promise((resolve, reject) => {
    const cached = audioCache.get(url);
    if (cached) {
      resolve(cached);
      return;
    }
    wx.downloadFile({
      url,
      timeout: 15000,
      success(res) {
        if (res.statusCode === 200 && res.tempFilePath) {
          if (audioCache.size >= AUDIO_CACHE_MAX) {
            const oldest = audioCache.keys().next().value;
            audioCache.delete(oldest);
          }
          audioCache.set(url, res.tempFilePath);
          resolve(res.tempFilePath);
        } else {
          reject(new Error('http ' + res.statusCode));
        }
      },
      fail(err) {
        if (!retried) {
          downloadAudio(url, true).then(resolve, reject);
          return;
        }
        reject(err);
      },
    });
  });
}

/**
 * 最终播放失败提示：微信域名校验失败（errMsg 含 domain）时给出精确配置指引，
 * 其余情况通用 toast。区分依据是真实 errMsg 特征（url not in domain list），
 * 域名配置正确后该分支不会再触发，线上用户只见通用提示。
 */
function notifyPlayError(err) {
  const msg = (err && err.errMsg) || '';
  if (/domain/i.test(msg)) {
    wx.showModal({
      title: '音源域名未配置',
      content:
        '发音音源被真机域名校验拦截。请在小程序后台「开发管理 → 开发设置 → 服务器域名 → downloadFile 合法域名」中添加 openapi.youdao.com 与 dict.youdao.com，保存后重试。',
      confirmText: '知道了',
      showCancel: false,
    });
    return;
  }
  wx.showToast({ title: '播放失败', icon: 'none' });
}

/**
 * 创建 InnerAudioContext 播放一个音源（本地临时文件或远程 URL）。
 * @param {string} src 音源地址（downloadAudio 的 tempFilePath，或流播兜底的 URL）
 * @param {Function} onSrcError 该音源失败后的续接（降级 / 终态提示）
 */
function playSrcAudio(src, onSrcError) {
  const ctx = wx.createInnerAudioContext();
  audioCtx = ctx;
  ctx.src = src;
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
      src,
      err && (err.errMsg || ('code ' + err.errCode)),
    );
    onSrcError(err);
  });
  ctx.play();
  return ctx;
}

/**
 * speak 的播放编排（三级链）：
 * ① downloadAudio 中转 → 本地播放（主路径，规避真机直拉流 504）；
 * ② 下载失败 → 同 URL 直接流播兜底（覆盖 downloadFile 不可用的边缘场景）；
 * ③ 播放 onError 且文本 ≤ DICTVOICE_MAX_LEN → 降级 dictvoice（同样下载中转，
 *    失败再流播）；长句跳过降级（dictvoice 长文本必 500）直接终态提示。
 */
async function startPlay(url, text) {
  let src = url;
  try {
    src = await downloadAudio(url);
  } catch (e) {
    console.warn('[tts] download failed, fallback to stream:', url);
  }
  const allowDictvoice = String(text || '').length <= DICTVOICE_MAX_LEN;
  playSrcAudio(src, (err) => {
    if (allowDictvoice) {
      const dvUrl = buildDictvoiceUrl(text);
      clearCtx(); // 保留 playingText，降级音源无缝接管
      const dvFail = (err2) => {
        stop();
        notifyPlayError(err2 || err);
      };
      downloadAudio(dvUrl)
        .then((file) => playSrcAudio(file, dvFail))
        .catch(() => playSrcAudio(dvUrl, dvFail)); // dictvoice 下载失败：流播再试
      return;
    }
    stop();
    notifyPlayError(err);
  });
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
  // 下载中转（同 speak：规避真机直拉流 504；单词音频小，缓存后重播零网络）
  let src = normalized;
  try {
    src = await downloadAudio(normalized);
  } catch (e) {
    console.warn('[tts] download failed, fallback to stream:', normalized);
  }
  const ctx = wx.createInnerAudioContext();
  audioCtx = ctx;
  ctx.src = src;
  const fallback = async (err) => {
    if (audioCtx !== ctx) return;
    clearCtx();
    playingUrl = null;
    notify();
    if (fallbackText) {
      const ok = await speak(fallbackText);
      if (!ok) wx.showToast({ title: '播放失败', icon: 'none' });
    } else {
      notifyPlayError(err);
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
      src,
      err && (err.errMsg || ('code ' + err.errCode)),
    );
    fallback(err);
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
      // OpenAPI 未回传 speakUrl：直接用 dictvoice 音源（短文本才可能合成成功）
      startPlay(buildDictvoiceUrl(text), text);
      return true;
    }
    // 降级链由 startPlay 编排：下载中转 → 流播兜底 → 短文本 dictvoice
    startPlay(speakUrl, text);
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
  /** 清空已下载音频缓存（测试隔离 / 内存压力场景） */
  clearAudioCache() {
    audioCache.clear();
  },
};
