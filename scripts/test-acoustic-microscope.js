/**
 * scripts/test-acoustic-microscope.js — 声学显微镜与切片直连单测
 * （RESHAPE-TASK T2.1 / T2.2，Node 环境 mock wx + request）
 *
 * 验证目标：
 *   A. analyzeWordAcoustics（utils/intensive-core.js 新增纯函数）：
 *      每词 durationMs/gapMs 精确毫秒、音节估算、SPS 热力三档、
 *      wpm 句真实语速、⚡连读吞音词块（功能词 <130ms 且间隙 <20ms 并块、
 *      间隙过大拆块、非功能词不标、脏数据过滤）
 *   B. slicePhraseWindow（词块点读窗口）：前让 0.06s / 后让 0.08s、
 *      下标越界钳制、缺时间戳返回 null、wordCount/phraseText
 *   C. audio-clip 切片直连（T2.1「零整集 URL」）：
 *      clipAudioUrl 直用零字幕请求零 seek、clipOffset 进度对齐字幕时间轴、
 *      显式窗口换算切片内相对秒、clipId 走 /api/clips/{id}/audio 且缓存去重、
 *      失败不缓存可重试、切片模式单句循环回跳防抖
 *   D. 剧集链路回归：无切片参数时行为与原链路一致（seek 词级窗口）
 *
 * 运行：node scripts/test-acoustic-microscope.js
 */

// ---- mock 全局 wx（口径同 test-audio-tts.js） ----
const toasts = [];
const audioContexts = [];
const requests = [];
let clipFixtures = {}; // clipId → { success, data:{url,duration,clipOffset} } | 'FAIL_500'

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
  showModal() {},
  downloadFile() {},
  request(opts) {
    requests.push(opts.url);
    setTimeout(() => {
      const url = opts.url;
      if (url.indexOf('/api/clips/') !== -1) {
        const id = decodeURIComponent(url.split('/api/clips/')[1].split('/audio')[0]);
        const fix = clipFixtures[id];
        if (fix === 'FAIL_500') {
          opts.success({ statusCode: 500, data: { message: 'server error' } });
          return;
        }
        opts.success({ statusCode: 200, data: { success: true, data: fix } });
        return;
      }
      opts.success({ statusCode: 200, data: { success: true, data: [] } });
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
      seekCount: 0,
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
      seek(t) { this.seekedTo = t; this.seekCount += 1; this.currentTime = t; },
    };
    audioContexts.push(ctx);
    return ctx;
  },
};

const core = require('../utils/intensive-core');
const clip = require('../utils/audio-clip');

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
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);
const lastToast = () => toasts[toasts.length - 1] || '';
const lastCtx = () => audioContexts[audioContexts.length - 1];
const episodeSubtitleRequests = () => requests.filter((u) => u.indexOf('/api/episode/subtitles') !== -1);
const clipRequests = () => requests.filter((u) => u.indexOf('/api/clips/') !== -1);

(async () => {
  // ══════════ A. analyzeWordAcoustics ══════════
  // 构造：I(0.10-0.25) kind(0.30-0.38) of(0.39-0.45) wanted(0.60-1.30)
  //       to(1.35-1.44) ask(1.60-2.10)
  // kind 80ms、of 60ms（gap 10ms）→ 连读块；to 90ms 但与 of 间隙 90ms > 20ms → 独立块
  const words = [
    { word: 'I', start: 0.1, end: 0.25 },
    { word: 'kind', start: 0.3, end: 0.38 },
    { word: 'of', start: 0.39, end: 0.45 },
    { word: 'wanted', start: 0.6, end: 1.3 },
    { word: 'to', start: 1.35, end: 1.44 },
    { word: 'ask', start: 1.6, end: 2.1 },
  ];
  const ac = core.analyzeWordAcoustics(words);
  assert(ac.words.length === 6, 'A 六词全量产出视图');
  assert(ac.words[0].durationMs === 150, 'A durationMs 毫秒精确（I = 150ms）');
  assert(ac.words[1].gapMs === 50, 'A gapMs = 与前词间隙（kind ← I = 50ms）');
  assert(ac.words[1].durationMs === 80 && ac.words[1].isFastLink === true, 'A kind 80ms 功能词 → isFastLink');
  assert(ac.words[2].durationMs === 60 && ac.words[2].isFastLink === true, 'A of 60ms 功能词 → isFastLink');
  assert(ac.words[3].durationMs === 700 && ac.words[3].isFastLink === false, 'A wanted 700ms 实词不标');
  assert(ac.words[4].durationMs === 90 && ac.words[4].isFastLink === true, 'A to 90ms 功能词单字成块（间隙过大未并入前块）');

  const blocks = ac.fastLinks;
  assert(blocks.length === 2, 'A 连读块 = 2 组（kind of / to，间隙 >20ms 拆块）');
  assert(blocks[0].startIdx === 1 && blocks[0].endIdx === 2, 'A 第一块 [kind, of]');
  assert(blocks[0].text === 'kind of', 'A 第一块文本 kind of');
  assert(blocks[0].durationSec === 0.15, 'A 第一块时长 = 块首词 start → 块尾词 end（0.15s）');
  assert(blocks[1].startIdx === 4 && blocks[1].endIdx === 4, 'A 第二块单词 to（与 of 间隙 90ms 拆开）');

  // wpm：6 词 / (2.1 - 0.1)s = 3 词/s = 180 wpm
  assert(ac.wpm === 180, 'A 句真实语速 wpm = 180（首词起~末词止）');

  // 音节估算
  assert(core.estimateSyllables('time') === 1, 'A 音节：time → 1（尾 e 不发音）');
  assert(core.estimateSyllables('table') === 2, 'A 音节：table → 2（-le 自成音节）');
  assert(core.estimateSyllables('little') === 2, 'A 音节：little → 2（-le 自成音节）');
  assert(core.estimateSyllables('wanted') === 2, 'A 音节：wanted → 2');
  assert(core.estimateSyllables('communication') === 5, 'A 音节：communication → 5');
  assert(core.estimateSyllables('') === 1, 'A 音节：空串 → 1（防御）');

  // SPS 热力三档：wanted 700ms/2音节 ≈ 2.86 sps；of 60ms/1音节 ≈ 16.7 sps
  const tiers = ac.words.map((w) => w.speedTier);
  assert(ac.words[3].speedTier === 'slow', 'A 长实词 wanted → slow 热力档');
  assert(tiers.indexOf('fast') !== -1, 'A 极速功能词存在 fast 档');
  assert(tiers.indexOf('normal') !== -1, 'A 存在 normal 档');
  assert(ac.medianSps > 0, 'A medianSps 热力基准非零');

  // 边界与脏数据
  const empty = core.analyzeWordAcoustics([]);
  assert(empty.words.length === 0 && empty.fastLinks.length === 0 && empty.wpm === 0,
    'A 空词表零产出防御');
  const dirty = core.analyzeWordAcoustics([
    { word: 'hi', start: 0, end: 0.2 },
    null,
    { word: 'bad', start: 1, end: 0.5 }, // end < start 过滤
    { word: 'no-time', start: 1 },       // 缺 end 过滤
  ]);
  assert(dirty.words.length === 1, 'A 脏词条（null/end倒置/缺字段）全过滤');

  // 单功能词极速 <130ms：连读块允许单词成块（a / of 等冠词介词吞音同样有教学价值）
  const single = core.analyzeWordAcoustics([
    { word: 'a', start: 1.0, end: 1.05 },
    { word: 'decision', start: 1.4, end: 2.0 },
  ]);
  assert(single.fastLinks.length === 1 && single.fastLinks[0].text === 'a',
    'A 单词极速功能词成块（a）');

  // ══════════ B. slicePhraseWindow ══════════
  const win = core.slicePhraseWindow(words, 3, 4); // wanted to
  assert(near(win.startSec, 0.54), 'B 起点 = 词 start - 0.06（0.6-0.06）');
  assert(near(win.endSec, 1.52), 'B 终点 = 词 end + 0.08（1.44+0.08，默认 pad）');
  assert(win.phraseText === 'wanted to' && win.wordCount === 2, 'B 文本与词数');

  const winPad = core.slicePhraseWindow(words, 5, 5, 0.2);
  assert(near(winPad.endSec, 2.3) && near(winPad.startSec, 1.54), 'B 自定义 padSec=0.2 生效');

  const clampHi = core.slicePhraseWindow(words, 4, 99);
  assert(clampHi.endIdx === undefined && clampHi.wordCount === 2, 'B endIdx 越界钳制到末词（to ask）');
  const clampLo = core.slicePhraseWindow(words, -5, 1);
  assert(near(clampLo.startSec, 0.04), 'B startIdx 负值钳到 0（I 起点让 0.06 不低于 0）');
  assert(near(core.slicePhraseWindow(words, 0, 0).startSec, 0.04), 'B 首词窗口起点 = max(0, start-0.06)');

  assert(core.slicePhraseWindow(null, 0, 1) === null, 'B 非数组 → null');
  assert(
    core.slicePhraseWindow([{ word: 'x', start: 1 }], 0, 0) === null,
    'B 缺 end 时间戳 → null',
  );

  // ══════════ C. audio-clip 切片直连（零整集 URL） ══════════
  // C1：clipAudioUrl 直用 + clipOffset 进度对齐 + 无 seek（窗口起点 0）
  requests.length = 0;
  toasts.length = 0;
  let progressSnap = null;
  const unsub = clip.subscribeProgress((p) => { progressSnap = p; });
  await clip.play({
    key: 's1:demo',
    clipAudioUrl: 'https://oss/clips/s1.mp3',
    clipDuration: 8,
    clipOffset: 120.5, // 切片在原字幕时间轴上的起点
  });
  await settle2();
  const c1 = lastCtx();
  assert(episodeSubtitleRequests().length === 0, 'C1 切片直连：零 /api/episode/subtitles 整集字幕请求');
  assert(c1.src === 'https://oss/clips/s1.mp3', 'C1 音源 = 切片直链');
  assert(c1.seekedTo === null, 'C1 整段播放窗口起点 0 → 零 seek');
  c1._h.canplay && c1._h.canplay();
  assert(clip.getState().playingKey === 's1:demo', 'C1 播放态置位');
  c1.currentTime = 3.2;
  c1._h.timeupdate && c1._h.timeupdate();
  assert(progressSnap && Math.abs(progressSnap.currentTime - 123.7) < 1e-6,
    'C1 进度回调 +clipOffset 对齐字幕时间轴（3.2 + 120.5 = 123.7）');
  assert(progressSnap.start === 120.5 && progressSnap.end === 128.5,
    'C1 切片条窗口 [0,8] 映射为字幕绝对 [120.5, 128.5]');
  c1.currentTime = 8.05;
  c1._h.timeupdate && c1._h.timeupdate();
  assert(clip.getState().playingKey === null && c1.destroyed, 'C1 切片自然到窗终自动停止');

  // C2：显式字幕绝对窗口换算切片内相对秒
  requests.length = 0;
  await clip.play({
    key: 's1:win',
    clipAudioUrl: 'https://oss/clips/s1.mp3',
    clipOffset: 120.5,
    startTime: 123.5,
    endTime: 127,
  });
  await settle2();
  const c2 = lastCtx();
  c2._h.canplay && c2._h.canplay();
  assert(c2.seekedTo === 3, 'C2 显式窗口 [123.5,127] → 切片内 seek(3.0)');
  c2.currentTime = 3.5;
  c2._h.timeupdate && c2._h.timeupdate();
  assert(progressSnap && Math.abs(progressSnap.currentTime - 124) < 1e-6 && progressSnap.end === 127,
    'C2 窗口终点映射回字幕绝对 127');

  // C3：clipId 解析 + 缓存去重
  clipFixtures = {
    cl9: { url: 'https://oss/clips/cl9.mp3', duration: 6, clipOffset: 10 },
  };
  requests.length = 0;
  await clip.play({ key: 'cl9:a', clipId: 'cl9' });
  await settle2();
  assert(clipRequests().length === 1 && clipRequests()[0].indexOf('/api/clips/cl9/audio') !== -1,
    'C3 clipId → GET /api/clips/cl9/audio');
  const c3 = lastCtx();
  c3._h.canplay && c3._h.canplay();
  assert(c3.src === 'https://oss/clips/cl9.mp3', 'C3 解析出的签名直链开播');
  clip.stop();
  await clip.play({ key: 'cl9:b', clipId: 'cl9' });
  await settle2();
  assert(clipRequests().length === 1, 'C3 同 clipId 二次播放走缓存零新请求');
  clip.stop();

  // C4：解析失败不缓存可重试
  clipFixtures.clBad = 'FAIL_500';
  toasts.length = 0;
  await clip.play({ key: 'clBad:a', clipId: 'clBad' });
  await settle2();
  assert(lastToast() === '原声信息加载失败', 'C4 切片解析失败 → 原声信息加载失败');
  clipFixtures.clBad = { url: 'https://oss/clips/clBad.mp3', duration: 5, clipOffset: 0 };
  await clip.play({ key: 'clBad:b', clipId: 'clBad' });
  await settle2();
  const c4 = lastCtx();
  assert(c4.src === 'https://oss/clips/clBad.mp3', 'C4 失败不缓存，重试成功');
  clip.stop();

  // C5：切片模式单句循环回跳（loopGuard 600ms 防抖；起播后再开循环——
  // play() 内部 stop() 会复位 looping，真实 UI 也是播放中切循环钮）
  await clip.play({
    key: 's1:loop',
    clipAudioUrl: 'https://oss/clips/s1.mp3',
    clipDuration: 8,
    clipOffset: 120.5,
  });
  await settle2();
  const c5 = lastCtx();
  c5._h.canplay && c5._h.canplay();
  clip.setLoop(true);
  c5.currentTime = 8.2;
  c5._h.timeupdate && c5._h.timeupdate(); // 触发回跳 seek(0)
  assert(c5.seekedTo === 0 && clip.getState().playingKey === 's1:loop', 'C5 循环模式到窗终回跳切片 0 处续播');
  assert(near(progressSnap.currentTime, 120.5, 1e-6), 'C5 回跳后进度映射回字幕 120.5');
  c5.currentTime = 0.01;
  c5._h.timeupdate && c5._h.timeupdate(); // 防抖窗内（<600ms）不二次 seek
  assert(c5.seekCount === 1, 'C5 loopGuard 防抖：静默窗内不重复回跳');
  clip.setLoop(false);
  clip.stop();

  // C6：切片参数优先于剧集链路（episodeid 同时存在也不拉字幕）
  requests.length = 0;
  await clip.play({
    key: 's1:prio',
    episodeid: 'e1',
    clipAudioUrl: 'https://oss/clips/s1.mp3',
    clipDuration: 4,
  });
  await settle2();
  assert(episodeSubtitleRequests().length === 0, 'C6 切片参数在场 → 剧集链路完全旁路');
  clip.stop();
  unsub();

  // ══════════ D. 剧集链路回归（无切片参数） ══════════
  // wx.request mock 对 /api/episode/subtitles 返回 {success:true,data:[]}，
  // audioUrl 缺省 → 走「暂时无法播放原声」分支，证明链路仍可达且未被切片逻辑破坏
  toasts.length = 0;
  await clip.play({ key: 'e9:x', episodeid: 'e9', timestamp: 1 });
  await settle2();
  assert(episodeSubtitleRequests().length > 0, 'D 无切片参数仍走剧集字幕链路');
  assert(lastToast() === '暂时无法播放原声', 'D 剧集链路 audioUrl 缺省提示口径不变');

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL ACOUSTIC-MICROSCOPE TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
