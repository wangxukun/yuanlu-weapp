/**
 * scripts/test-audio-tts.js — audio-clip / tts / audio-bus 单测
 * （Node 环境，mock wx.request 与 wx.createInnerAudioContext，request.js 走真实链路）
 *
 * 验证目标（REVIEW-TASK.md T0.6，对齐 Web useOriginalAudio / playContextAudio）：
 *   A. normalizeText 归一化（大小写/标点/引号/空格）
 *   B. 字幕定位：文本双向包含优先（标点差异可命中）、timestamp 落句兜底、均未命中报错
 *   C. 播放窗口：词级 words[0].start→words[last].end 优先；句级兜底；end 缺省 = start+3s；
 *      到窗口终点 onTimeUpdate 自动停止
 *   D. 缓存：同剧集多请求去重；失败不缓存可重试；audioUrl=null 提示
 *   E. toggle：同 key 再点 = 停止
 *   F. 互斥总线：tts ↔ clip 双向停对方（全局播放器经 audioManager.pause 同一总线）
 *   G. TTS：speak 播放/toggle/无 speakUrl；403 配额 → request.js toast + quotaHandler(dictionary_quota)
 *   H. 错误路径：字幕请求失败 → 原声信息加载失败；clip onError → 原声加载失败
 *
 * 运行：node scripts/test-audio-tts.js
 */

// ---- mock 全局 wx（request.js 走真实链路，仅 mock 底层 wx.request） ----
const toasts = [];
const audioContexts = [];
let episodeFixtures = {}; // episodeid → { audioUrl, subtitles } | 'FAIL_ONCE' 等
let youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/hello.mp3' } };
let subtitlesRequestCount = {};

global.wx = {
  _storage: {},
  getStorageSync(k) {
    return this._storage[k] !== undefined ? this._storage[k] : '';
  },
  setStorageSync(k, v) {
    this._storage[k] = v;
  },
  removeStorageSync(k) {
    delete this._storage[k];
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } };
  },
  showToast(opts) {
    toasts.push((opts && opts.title) || '');
  },
  request(opts) {
    setTimeout(() => {
      const url = opts.url;
      if (url.indexOf('/api/episode/subtitles') !== -1) {
        const id = decodeURIComponent(
          url.split('id=')[1] || '',
        );
        subtitlesRequestCount[id] = (subtitlesRequestCount[id] || 0) + 1;
        const fix = episodeFixtures[id];
        if (fix === 'FAIL_500') {
          opts.success({ statusCode: 500, data: { message: 'server error' } });
          return;
        }
        opts.success({
          statusCode: 200,
          data: { success: true, data: fix.subtitles, audioUrl: fix.audioUrl },
        });
        return;
      }
      if (url.indexOf('/api/dictionary/youdao') !== -1) {
        opts.success({
          statusCode: youdaoResponse.statusCode,
          data: youdaoResponse.data,
        });
        return;
      }
      opts.success({ statusCode: 200, data: {} });
    }, 0);
  },
  createInnerAudioContext() {
    const ctx = {
      src: '',
      currentTime: 0,
      played: false,
      stopped: false,
      destroyed: false,
      seekedTo: null,
      _h: {},
      onCanplay(cb) { this._h.canplay = cb; },
      onTimeUpdate(cb) { this._h.timeupdate = cb; },
      onEnded(cb) { this._h.ended = cb; },
      onError(cb) { this._h.error = cb; },
      offCanplay() { delete this._h.canplay; },
      offTimeUpdate() { delete this._h.timeupdate; },
      offEnded() { delete this._h.ended; },
      offError() { delete this._h.error; },
      play() { this.played = true; },
      pause() {},
      stop() { this.stopped = true; },
      destroy() { this.destroyed = true; },
      seek(t) { this.seekedTo = t; this.currentTime = t; },
    };
    audioContexts.push(ctx);
    return ctx;
  },
};

const clip = require('../utils/audio-clip');
const tts = require('../utils/tts');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const settle2 = async () => { await settle(); await settle(); };
const lastToast = () => toasts[toasts.length - 1] || '';
const lastCtx = () => audioContexts[audioContexts.length - 1];

// ---- 字幕夹具 ----
episodeFixtures = {
  e1: {
    audioUrl: 'https://oss/e1.m4a',
    subtitles: [
      {
        start: 1, end: 3, textEn: 'Hello, World!',
        words: [
          { word: 'Hello', start: 1.2, end: 1.6 },
          { word: 'World', start: 2.3, end: 2.8 },
        ],
      },
      { start: 38, end: 42, textEn: 'Second sentence here', words: [] },
      { start: 60, textEn: 'no end timestamp line' },
    ],
  },
  e2: { audioUrl: null, subtitles: [] }, // token 失效场景
  e3: { audioUrl: 'https://oss/e3.m4a', subtitles: [{ start: 1, end: 2, textEn: 'abc' }] },
  e4: { audioUrl: 'https://oss/e4.m4a', subtitles: [{ start: 1, end: 2, textEn: 'abc' }] },
  e5: { audioUrl: 'https://oss/e5.m4a', subtitles: [{ start: 1, end: 2, textEn: 'ok' }] },
};

(async () => {
  // —— A. normalizeText ——
  const n = clip.normalizeText('  "Hello,—World!" (again)  ');
  assert(n === 'hello world again', 'A 归一化：去标点/引号/压空格/小写 → "' + n + '"');

  // —— B2 + C：文本定位（标点差异）+ 词级窗口 + 终点自停 ——
  toasts.length = 0;
  let p = clip.play({ key: 'e1:hello', episodeid: 'e1', contextSentence: 'hello world', timestamp: 999999 });
  assert(clip.getState().loadingKey === 'e1:hello', 'B 请求期间 loadingKey 置位');
  await settle2();
  const ctx1 = lastCtx();
  ctx1._h.canplay && ctx1._h.canplay();
  assert(clip.getState().playingKey === 'e1:hello', 'B 文本匹配定位成功（标点差异可命中）');
  assert(ctx1.seekedTo === 1.2 && ctx1.played, 'C 词级窗口起点 seek(1.2) 并 play');
  ctx1.currentTime = 2.9;
  ctx1._h.timeupdate && ctx1._h.timeupdate();
  assert(clip.getState().playingKey === null && ctx1.destroyed, 'C 到词级窗口终点 2.8s 后自动停止销毁');

  // —— B3：timestamp 兜底 + 句级窗口（end 存在）——
  p = clip.play({ key: 'e1:s2', episodeid: 'e1', timestamp: 40 });
  await settle2();
  const ctx2 = lastCtx();
  ctx2._h.canplay && ctx2._h.canplay();
  assert(ctx2.seekedTo === 38, 'B timestamp=40 落句兜底 → 句级窗口起点 38');
  ctx2.currentTime = 42.1;
  ctx2._h.timeupdate && ctx2._h.timeupdate();
  assert(clip.getState().playingKey === null, 'C 句级窗口终点 42s 自动停止');

  // —— C：end 缺省 = start + 3 ——
  p = clip.play({ key: 'e1:s3', episodeid: 'e1', timestamp: 61 });
  await settle2();
  const ctx3 = lastCtx();
  ctx3._h.canplay && ctx3._h.canplay();
  ctx3.currentTime = 62.9;
  ctx3._h.timeupdate && ctx3._h.timeupdate();
  assert(clip.getState().playingKey === 'e1:s3', 'C end 缺省时窗口 = start+3s（62.9 < 63 仍在播）');
  clip.stop();

  // —— B4：均未命中 ——
  toasts.length = 0;
  await clip.play({ key: 'e3:x', episodeid: 'e3', contextSentence: 'zzz nothing matches', timestamp: 999 });
  assert(lastToast() === '未找到该句的原声位置', 'B 文本与时间戳均未命中 → 未找到该句的原声位置');

  // —— D：audioUrl=null ——
  toasts.length = 0;
  await clip.play({ key: 'e2:x', episodeid: 'e2', timestamp: 0 });
  assert(lastToast() === '暂时无法播放原声', 'D audioUrl=null（token 失效）→ 暂时无法播放原声');

  // —— D：缓存去重 ——
  subtitlesRequestCount = {};
  await clip.play({ key: 'e5:a', episodeid: 'e5', timestamp: 1 });
  clip.stop();
  await clip.play({ key: 'e5:b', episodeid: 'e5', timestamp: 1 });
  clip.stop();
  assert(subtitlesRequestCount.e5 === 1, 'D 新剧集两次播放只发一次字幕请求（全局缓存去重）');
  assert((subtitlesRequestCount.e1 || 0) === 0, 'D 更早场景预热过的 e1 零新请求（模块级全局缓存）');

  // —— E：toggle ——
  await clip.play({ key: 'e1:t', episodeid: 'e1', timestamp: 2 });
  const ctxT = lastCtx();
  ctxT._h.canplay && ctxT._h.canplay();
  assert(clip.getState().playingKey === 'e1:t', 'E 播放中');
  await clip.play({ key: 'e1:t', episodeid: 'e1', timestamp: 0 });
  assert(clip.getState().playingKey === null && ctxT.destroyed, 'E 同 key 再点 = 停止（toggle）');

  // —— D：失败不缓存可重试 ——
  episodeFixtures.e4 = 'FAIL_500';
  subtitlesRequestCount.e4 = 0;
  toasts.length = 0;
  await clip.play({ key: 'e4:x', episodeid: 'e4', timestamp: 1 });
  assert(lastToast() === '原声信息加载失败', 'H 字幕请求失败 → 原声信息加载失败');
  episodeFixtures.e4 = { audioUrl: 'https://oss/e4.m4a', subtitles: [{ start: 1, end: 2, textEn: 'abc' }] };
  toasts.length = 0;
  await clip.play({ key: 'e4:x', episodeid: 'e4', timestamp: 1 });
  assert(subtitlesRequestCount.e4 === 2 && lastToast() !== '原声信息加载失败', 'D 失败后缓存已清除，重试成功');
  clip.stop();

  // —— H：clip onError ——
  toasts.length = 0;
  await clip.play({ key: 'e1:err', episodeid: 'e1', timestamp: 2 });
  const ctxE = lastCtx();
  ctxE._h.error && ctxE._h.error();
  assert(lastToast() === '原声加载失败' && clip.getState().playingKey === null, 'H 音频加载错误 → 原声加载失败并停止');

  // —— G：TTS 基础 ——
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/hello.mp3' } };
  let ok = await tts.speak('Hello, World!');
  assert(ok === true && tts.getState().playingText === 'Hello, World!', 'G TTS 播放开始且 playingText 置位');
  const ttsCtx = lastCtx();
  assert(ttsCtx.src === 'https://tts/hello.mp3' && ttsCtx.played, 'G TTS 播放 speakUrl');
  ttsCtx._h.ended && ttsCtx._h.ended();
  assert(tts.getState().playingText === null, 'G TTS 播完 onEnded 清状态');

  ok = await tts.speak('same text');
  assert(ok === true, 'G TTS 新文本可播');
  ok = await tts.speak('same text');
  assert(ok === false && tts.getState().playingText === null, 'G TTS 同文本再点 = 停止（toggle）');

  youdaoResponse = { statusCode: 200, data: {} }; // 无 speakUrl
  toasts.length = 0;
  ok = await tts.speak('no resource');
  const dictCtx = lastCtx();
  assert(ok === true && dictCtx.src === 'https://dict.youdao.com/dictvoice?audio=no%20resource&type=2' && dictCtx.played,
    'G 无 speakUrl → 降级 dictvoice 直链开播（真机修复②）');
  dictCtx._h.ended && dictCtx._h.ended();
  assert(tts.getState().playingText === null, 'G 降级音源播完清状态');

  // —— G：真机修复① http 音源强制升 https ——
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'http://tts/plain.mp3' } };
  ok = await tts.speak('plain http');
  assert(lastCtx().src === 'https://tts/plain.mp3', 'G http speakUrl → https 规范化（iOS ATS）');
  lastCtx()._h.ended && lastCtx()._h.ended();

  // —— G：真机修复② speakUrl onError → dictvoice 降级重试 ——
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/broken.mp3' } };
  ok = await tts.speak('fallback me');
  const brokenCtx = lastCtx();
  assert(brokenCtx.src === 'https://tts/broken.mp3', 'G 主音源先播 speakUrl');
  brokenCtx._h.error && brokenCtx._h.error({ errCode: 10003, errMsg: 'MediaError' });
  const fbCtx = lastCtx();
  assert(fbCtx !== brokenCtx && fbCtx.src === 'https://dict.youdao.com/dictvoice?audio=fallback%20me&type=2',
    'G onError → 换 ctx 降级 dictvoice 重试');
  assert(tts.getState().playingText === 'fallback me', 'G 降级期间 playingText 高亮不闪断');
  toasts.length = 0;
  fbCtx._h.error && fbCtx._h.error({ errCode: 10004 });
  assert(lastToast() === '播放失败' && tts.getState().playingText === null,
    'G 降级音源也失败 → 播放失败 toast + 状态复位');

  // —— G：配额触墙 ——
  youdaoResponse = { statusCode: 403, data: { code: 'DICTIONARY_QUOTA_EXCEEDED', message: '今日 30 次免费词典查询已用完' } };
  let handlerSource = null;
  tts.setQuotaHandler((source) => { handlerSource = source; });
  toasts.length = 0;
  ok = await tts.speak('quota test');
  assert(ok === false, 'G 配额触墙 speak 返回 false');
  assert(toasts.indexOf('今日 30 次免费词典查询已用完') !== -1, 'G request.js 统一 toast message（先 toast）');
  assert(handlerSource === 'dictionary_quota', 'G quotaHandler 触发 premium-modal(dictionary_quota)（后弹窗）');
  assert(tts.getState().playingText === null, 'G 触墙后 playingText 复位');
  tts.setQuotaHandler(null);

  // —— F：互斥总线双向 ——
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/mutex.mp3' } };
  await tts.speak('mutex');
  const ttsM = lastCtx();
  assert(tts.getState().playingText === 'mutex', 'F TTS 播放中');
  await clip.play({ key: 'e1:m', episodeid: 'e1', timestamp: 2 });
  const clipM = lastCtx();
  clipM._h.canplay && clipM._h.canplay();
  assert(ttsM.destroyed && tts.getState().playingText === null, 'F 原声开播 → TTS 被总线停止');
  assert(clip.getState().playingKey === 'e1:m', 'F 原声接管播放');
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/mutex2.mp3' } };
  await tts.speak('mutex2');
  assert(clipM.destroyed && clip.getState().playingKey === null, 'F TTS 开播 → 原声被总线停止');
  assert(tts.getState().playingText === 'mutex2', 'F TTS 接管播放');
  tts.stop();

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL AUDIO-TTS TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
