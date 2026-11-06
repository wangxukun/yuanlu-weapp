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
const modals = [];
const audioContexts = [];
// downloadFile 中转 mock：默认 200 成功；'FAIL' = fail 两次；fn(url) = 定制 statusCode
const dlCalls = [];
let dlBehavior = null;
let dlSeq = 0;
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
  showModal(opts) {
    modals.push((opts && opts.title) || '');
  },
  downloadFile(opts) {
    dlCalls.push(opts.url);
    if (dlBehavior === 'FAIL') {
      opts.fail && opts.fail({ errMsg: 'downloadFile:fail timeout' });
      return;
    }
    const sc = typeof dlBehavior === 'function' ? dlBehavior(opts.url) : 200;
    setTimeout(
      () => opts.success && opts.success({ statusCode: sc, tempFilePath: 'tmp-' + (++dlSeq) }),
      0,
    );
  },
  request(opts) {
    setTimeout(() => {
      const url = opts.url;
      if (url.indexOf('/api/clips/') !== -1 && url.indexOf('/audio') !== -1) {
        const m = url.match(/\/api\/clips\/([^/?]+)\/audio/);
        const id = decodeURIComponent((m && m[1]) || '');
        subtitlesRequestCount[id] = (subtitlesRequestCount[id] || 0) + 1;
        const fix = episodeFixtures[id];
        if (fix === 'FAIL_500') {
          opts.success({ statusCode: 500, data: { message: 'server error' } });
          return;
        }
        opts.success({
          statusCode: 200,
          data: {
            success: true,
            data: {
              url: fix ? fix.audioUrl : null,
              duration: (fix && fix.duration) || 8,
              clipOffset: (fix && fix.clipOffset) || 0,
            },
          },
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
// 等待 downloadFile 中转链完成（mock 的 success 走 setTimeout 0）
const dlWait = () => new Promise((r) => setTimeout(r, 30));

// ---- 语料切片夹具 ----
episodeFixtures = {
  c1: { audioUrl: 'https://oss/c1.mp3', duration: 6, clipOffset: 10 },
  c2: { audioUrl: null, duration: 0, clipOffset: 0 }, // 无音频场景
  c3: { audioUrl: 'https://oss/c3.mp3', duration: 4, clipOffset: 0 },
  c4: { audioUrl: 'https://oss/c4.mp3', duration: 4, clipOffset: 0 },
  c5: { audioUrl: 'https://oss/c5.mp3', duration: 4, clipOffset: 0 },
};

(async () => {
  // —— A. normalizeText ——
  const n = clip.normalizeText('  "Hello,—World!" (again)  ');
  assert(n === 'hello world again', 'A 归一化：去标点/引号/压空格/小写 → "' + n + '"');

  // —— B + C：clipId 切片直连 + 显式窗口换算（startTime - clipOffset）+ 终点自停 ——
  toasts.length = 0;
  let p = clip.play({ key: 'c1:hello', clipId: 'c1', startTime: 11.2, endTime: 12.8 });
  assert(clip.getState().loadingKey === 'c1:hello', 'B 请求期间 loadingKey 置位');
  await settle2();
  const ctx1 = lastCtx();
  ctx1._h.canplay && ctx1._h.canplay();
  assert(clip.getState().playingKey === 'c1:hello', 'B 语料切片解析并开播');
  assert(Math.abs(ctx1.seekedTo - 1.2) < 0.01 && ctx1.played, 'C 显式窗口按 clipOffset(10) 换算相对起点 seek(1.2) 并 play');
  ctx1.currentTime = 2.9;
  ctx1._h.timeupdate && ctx1._h.timeupdate();
  assert(clip.getState().playingKey === null && ctx1.destroyed, 'C 到切片相对终点 2.8s 后自动停止销毁');

  // —— B2：内联 clipAudioUrl 免请求直播 ——
  p = clip.play({ key: 'inline:s2', clipAudioUrl: 'https://oss/inline.mp3', clipOffset: 30, clipDuration: 15, startTime: 38, endTime: 42 });
  await settle2();
  const ctx2 = lastCtx();
  ctx2._h.canplay && ctx2._h.canplay();
  assert(ctx2.seekedTo === 8, 'B 内联 clipAudioUrl 相对起点 38 - 30 = 8');
  ctx2.currentTime = 12.1;
  ctx2._h.timeupdate && ctx2._h.timeupdate();
  assert(clip.getState().playingKey === null, 'C 相对终点 12s 自动停止');

  // —— C：无显式 startTime/endTime 时按 duration 整段播放 ——
  p = clip.play({ key: 'c1:full', clipId: 'c1' });
  await settle2();
  const ctx3 = lastCtx();
  ctx3._h.canplay && ctx3._h.canplay();
  ctx3.currentTime = 5.5;
  ctx3._h.timeupdate && ctx3._h.timeupdate();
  assert(clip.getState().playingKey === 'c1:full', 'C 无显式窗口时窗口 = 0~duration（5.5 < 6 仍在播）');
  clip.stop();

  // —— B4：无 clipId 且无 clipAudioUrl → 拒绝整集回退，toast 提示 ——
  toasts.length = 0;
  await clip.play({ key: 'e3:x', episodeid: 'e3', contextSentence: 'zzz nothing matches', timestamp: 999 });
  assert(lastToast() === '暂时无法播放原声', 'B 缺失语料切片标识 → 暂时无法播放原声（零整集回退）');

  // —— D：缓存去重 ——
  subtitlesRequestCount = {};
  await clip.play({ key: 'c5:a', clipId: 'c5' });
  clip.stop();
  await clip.play({ key: 'c5:b', clipId: 'c5' });
  clip.stop();
  assert(subtitlesRequestCount.c5 === 1, 'D 同一 clipId 两次播放只发一次请求（全局缓存去重）');
  assert((subtitlesRequestCount.c1 || 0) === 0, 'D 更早场景预热过的 c1 零新请求（模块级全局缓存）');

  // —— E：toggle ——
  await clip.play({ key: 'c1:t', clipId: 'c1' });
  const ctxT = lastCtx();
  ctxT._h.canplay && ctxT._h.canplay();
  assert(clip.getState().playingKey === 'c1:t', 'E 播放中');
  await clip.play({ key: 'c1:t', clipId: 'c1' });
  assert(clip.getState().playingKey === null && ctxT.destroyed, 'E 同 key 再点 = 停止（toggle）');

  // —— D：失败不缓存可重试 ——
  episodeFixtures.c4 = 'FAIL_500';
  subtitlesRequestCount.c4 = 0;
  toasts.length = 0;
  await clip.play({ key: 'c4:x', clipId: 'c4' });
  assert(lastToast() === '原声信息加载失败', 'H 切片请求失败 → 原声信息加载失败');
  episodeFixtures.c4 = { audioUrl: 'https://oss/c4.mp3', duration: 4, clipOffset: 0 };
  toasts.length = 0;
  await clip.play({ key: 'c4:x', clipId: 'c4' });
  assert(subtitlesRequestCount.c4 === 2 && lastToast() !== '原声信息加载失败', 'D 失败后缓存已清除，重试成功');
  clip.stop();

  // —— H：clip onError ——
  toasts.length = 0;
  await clip.play({ key: 'c1:err', clipId: 'c1' });
  const ctxE = lastCtx();
  ctxE._h.error && ctxE._h.error();
  assert(lastToast() === '原声加载失败' && clip.getState().playingKey === null, 'H 音频加载错误 → 原声加载失败并停止');

  // —— G：TTS 基础（下载中转：downloadFile → 本地临时文件播放） ——
  tts.clearAudioCache(); dlCalls.length = 0;
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/hello.mp3' } };
  let ok = await tts.speak('Hello, World!');
  await dlWait();
  assert(ok === true && tts.getState().playingText === 'Hello, World!', 'G TTS 播放开始且 playingText 置位');
  const ttsCtx = lastCtx();
  assert(dlCalls[0] === 'https://tts/hello.mp3', 'G 音源先经 downloadFile 中转（真机直拉流 504 修复）');
  assert(ttsCtx.src === 'tmp-1' && ttsCtx.played, 'G 播放的是下载后的本地临时文件');
  ttsCtx._h.ended && ttsCtx._h.ended();
  assert(tts.getState().playingText === null, 'G TTS 播完 onEnded 清状态');

  // 缓存命中：同 URL 重播零网络
  dlCalls.length = 0;
  ok = await tts.speak('Hello, World!');
  await dlWait();
  assert(dlCalls.length === 0 && lastCtx().src === 'tmp-1' && lastCtx().played,
    'G 音频缓存命中：同 URL 重播不再下载');
  lastCtx()._h.ended && lastCtx()._h.ended();

  ok = await tts.speak('same text');
  assert(ok === true, 'G TTS 新文本可播');
  ok = await tts.speak('same text');
  assert(ok === false && tts.getState().playingText === null, 'G TTS 同文本再点 = 停止（toggle）');

  youdaoResponse = { statusCode: 200, data: {} }; // 无 speakUrl
  toasts.length = 0;
  tts.clearAudioCache(); dlCalls.length = 0;
  ok = await tts.speak('no resource');
  await dlWait();
  const dictCtx = lastCtx();
  assert(ok === true && dlCalls[0] === 'https://dict.youdao.com/dictvoice?audio=no%20resource&type=2' && dictCtx.played,
    'G 无 speakUrl → dictvoice 直链（经下载中转）开播');
  dictCtx._h.ended && dictCtx._h.ended();
  assert(tts.getState().playingText === null, 'G 降级音源播完清状态');

  // —— G：真机修复① http 音源强制升 https ——
  tts.clearAudioCache(); dlCalls.length = 0;
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'http://tts/plain.mp3' } };
  ok = await tts.speak('plain http');
  await dlWait();
  assert(dlCalls[0] === 'https://tts/plain.mp3', 'G http speakUrl → https 规范化后下载（iOS ATS）');
  lastCtx()._h.ended && lastCtx()._h.ended();

  // —— G：真机修复②② 下载 fail 自动重试一次 → 仍失败流播兜底 ——
  tts.clearAudioCache(); dlCalls.length = 0; dlBehavior = 'FAIL';
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/netfail.mp3' } };
  await tts.speak('net fail');
  await dlWait();
  assert(dlCalls.filter((u) => u === 'https://tts/netfail.mp3').length === 2,
    'G downloadFile fail 自动重试一次');
  const streamCtx = lastCtx();
  assert(streamCtx.src === 'https://tts/netfail.mp3' && streamCtx.played,
    'G 两次下载均失败 → 流播兜底（直接播远程 URL）');
  dlBehavior = null;
  streamCtx._h.ended && streamCtx._h.ended();

  // —— G：下载返回非 200（网关 504 等）→ 流播兜底 ——
  tts.clearAudioCache();
  dlBehavior = () => 504;
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/gw504.mp3' } };
  await tts.speak('gw 504');
  await dlWait();
  assert(lastCtx().src === 'https://tts/gw504.mp3' && lastCtx().played,
    'G 下载返回 504 → 流播兜底');
  dlBehavior = null;
  lastCtx()._h.ended && lastCtx()._h.ended();

  // —— G：真机修复③ 播放 onError → 短文本降级 dictvoice（下载中转） ——
  tts.clearAudioCache(); dlCalls.length = 0;
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/broken.mp3' } };
  ok = await tts.speak('fallback me'); // 11 字符 ≤ 60
  await dlWait();
  const brokenCtx = lastCtx();
  assert(brokenCtx.src.indexOf('tmp-') === 0, 'G 主音源本地播放');
  brokenCtx._h.error && brokenCtx._h.error({ errCode: 10003, errMsg: 'MediaError' });
  await dlWait();
  const fbCtx = lastCtx();
  assert(fbCtx !== brokenCtx &&
    dlCalls.indexOf('https://dict.youdao.com/dictvoice?audio=fallback%20me&type=2') !== -1,
    'G onError → dictvoice 降级（下载中转）换 ctx 重试');
  assert(tts.getState().playingText === 'fallback me', 'G 降级期间 playingText 高亮不闪断');
  toasts.length = 0;
  fbCtx._h.error && fbCtx._h.error({ errCode: 10004 });
  assert(lastToast() === '播放失败' && tts.getState().playingText === null,
    'G 降级音源也失败 → 播放失败 toast + 状态复位');

  // —— G：长文本（>60 字符）onError 不降级 dictvoice（长句必 500，实测） ——
  tts.clearAudioCache(); dlCalls.length = 0;
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/long504.mp3' } };
  await tts.speak('one two three four five six seven eight nine ten eleven twelve thirteen');
  await dlWait();
  const longCtx = lastCtx();
  toasts.length = 0;
  longCtx._h.error && longCtx._h.error({ errCode: 504, errMsg: 'error player to stop' });
  assert(dlCalls.every((u) => u.indexOf('dictvoice') === -1),
    'G 长文本 onError 不再请求 dictvoice（dictvoice 长句 500 returned null audio）');
  assert(lastToast() === '播放失败' && tts.getState().playingText === null,
    'G 长文本最终失败 → 播放失败 toast + 状态复位');

  // —— G：真机修复④ 域名校验失败 → 精确配置指引 Modal（免开 vConsole） ——
  tts.clearAudioCache();
  youdaoResponse = { statusCode: 200, data: { speakUrl: 'https://tts/blocked.mp3' } };
  await tts.speak('blocked by domain');
  await dlWait();
  const blockedCtx = lastCtx();
  blockedCtx._h.error && blockedCtx._h.error({ errMsg: 'downloadFile:fail url not in domain list' });
  await dlWait();
  const dlCtx = lastCtx(); // 降级 dictvoice 同样被域名校验拦截
  toasts.length = 0; modals.length = 0;
  dlCtx._h.error && dlCtx._h.error({ errMsg: 'downloadFile:fail url not in domain list' });
  assert(modals[0] === '音源域名未配置' && lastToast() === '',
    'G 域名校验失败（errMsg 含 domain）→ 精确指引 Modal（含配置路径），不再裸 toast');
  assert(tts.getState().playingText === null, 'G 域名拦截后状态复位');

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
  await clip.play({ key: 'c1:m', clipId: 'c1' });
  const clipM = lastCtx();
  clipM._h.canplay && clipM._h.canplay();
  assert(ttsM.destroyed && tts.getState().playingText === null, 'F 原声开播 → TTS 被总线停止');
  assert(clip.getState().playingKey === 'c1:m', 'F 原声接管播放');
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
