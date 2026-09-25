/**
 * scripts/test-speech-eval.js — 语音评测页纯逻辑层测试
 *
 * 覆盖 utils/speech-core（对齐 Android feature/voice 口径的移植把门）：
 *   - effectivePassThreshold：严格度偏移 -5/0/+5 + clamp
 *   - normalizeSettings：存储读入容错（坏字段回落默认 + 钳制区间）
 *   - applyFilters：词数区间（0/50 = 不限）+ 只练未掌握（最新 bestScore 达生效线排除）
 *   - matchesRecord / latestRecordFor：subtitleId 相同 || 文本相同且起点差 < 0.5s，取 recognitionid 最大
 *   - parsePracticeData / parseRecordDto / parseEvalResponse / parseDetails：
 *     startSeconds 命名、bestScore 兜底、有道明细双口径音素字段（phoneme|phone / score|pronunciation）、
 *     overall ?? pronunciation ?? fallback 兜底链、无 details 退化总分
 *   - buildSentenceTokens / cleanWordKey / stripIpaSlashes：分词渲染与音标缓存键
 *   - scoreTier / ratingWord：85/60 双分界
 *   - pcmToWav / frameAmplitude：WAV 头 44 字节正确性 + RMS 音量
 *   - computeWordSweep：词级扫光三态（intensive-core 同源透传）
 * - 页内切片播放精度仿真（Android MediaPlayer 等价移植的把门）：
 *   模拟解码器（真实墙钟推进 currentTime）+ 300ms timeupdate 快照粒度，验证
 *   startTime 起播锚定 / 墙钟外推 50ms 看门狗的句尾停点收敛在 endSec±0.2s 内——
 *   直接轮询 currentTime 快照的旧实现停点会漂到 endSec+0.5s（串进下一句开头）。
 *   场景：原速 / 慢速 0.75 / startTime 被平台忽略（首帧纠偏兜底）/ 缓冲停顿 600ms。
 *
 * 运行：node scripts/test-speech-eval.js
 */

const core = require('../utils/speech-core');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.error('  ✗ ' + label);
  }
}

function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label + '（' + JSON.stringify(a) + '）');
}

console.log('== effectivePassThreshold ==');
eq(core.effectivePassThreshold({ passThreshold: 80, strictness: 'standard' }), 80, '标准 80');
eq(core.effectivePassThreshold({ passThreshold: 80, strictness: 'lenient' }), 75, '宽松 -5');
eq(core.effectivePassThreshold({ passThreshold: 80, strictness: 'strict' }), 85, '严格 +5');
eq(core.effectivePassThreshold({ passThreshold: 60, strictness: 'lenient' }), 55, 'clamp 下界不生效（55 合法）');
eq(core.effectivePassThreshold({ passThreshold: 95, strictness: 'strict' }), 100, 'clamp 上界 100');

console.log('== normalizeSettings ==');
eq(core.normalizeSettings(null), core.DEFAULT_SETTINGS, '空存储回落默认');
eq(core.normalizeSettings({ fontSizeLevel: 9, textMode: 'xxx' }), Object.assign({}, core.DEFAULT_SETTINGS, { fontSizeLevel: 2, textMode: 'normal' }), '坏字段钳制');
eq(core.normalizeSettings({ minWords: -3, maxWords: 99 }), Object.assign({}, core.DEFAULT_SETTINGS, { minWords: 0, maxWords: 50 }), '词数钳制 0..50');

console.log('== applyFilters（词数 + 只练未掌握） ==');
const subs = [
  { id: 1, textEn: 'Hello world', start: 0 },                                  // 2 词
  { id: 2, textEn: 'This is a longer sentence here', start: 5 },                // 6 词
  { id: 3, textEn: 'One two three four five six seven eight nine ten', start: 10 }, // 10 词
];
eq(core.applyFilters(subs, [], core.DEFAULT_SETTINGS).length, 3, '默认不过滤');
eq(core.applyFilters(subs, [], Object.assign({}, core.DEFAULT_SETTINGS, { minWords: 5 })).map(s => s.id), [2, 3], '最小词数 5');
eq(core.applyFilters(subs, [], Object.assign({}, core.DEFAULT_SETTINGS, { maxWords: 5 })).map(s => s.id), [1], '最大词数 5');
eq(core.applyFilters(subs, [], Object.assign({}, core.DEFAULT_SETTINGS, { maxWords: 50 })).length, 3, 'maxWords=50 视为不限');
// 只练未掌握：句 2 已达生效线（80）→ 排除；句 3 只有 70 分历史 → 保留
const records = [
  { recognitionid: 1, subtitleId: 2, targetText: 'This is a longer sentence here', targetStartTime: 5, accuracyScore: 60, overallScore: 85 },
  { recognitionid: 2, subtitleId: 3, targetText: '', targetStartTime: 10, accuracyScore: 70, overallScore: null },
];
eq(
  core.applyFilters(subs, records, Object.assign({}, core.DEFAULT_SETTINGS, { onlyUnmastered: true })).map(s => s.id),
  [1, 3],
  '只练未掌握排除达标句（bestScore=overallScore??accuracy）'
);

console.log('== matchesRecord / latestRecordFor ==');
ok(core.matchesRecord({ id: 9, textEn: 'A', start: 1.0 }, { subtitleId: 9, targetText: 'B', targetStartTime: 99 }), 'subtitleId 相同即匹配');
ok(core.matchesRecord({ id: 8, textEn: 'Same text', start: 2.0 }, { subtitleId: null, targetText: 'Same text', targetStartTime: 2.3 }), '文本相同且起点差 < 0.5s');
ok(!core.matchesRecord({ id: 8, textEn: 'Same text', start: 2.0 }, { subtitleId: null, targetText: 'Same text', targetStartTime: 3.0 }), '起点差 ≥ 0.5s 不匹配');
const latest = core.latestRecordFor({ id: 2, textEn: 'This is a longer sentence here', start: 5 }, [
  { recognitionid: 5, subtitleId: 2, targetText: '', targetStartTime: 0, accuracyScore: 50 },
  { recognitionid: 3, subtitleId: 2, targetText: '', targetStartTime: 0, accuracyScore: 60 },
]);
eq(latest && latest.recognitionid, 5, '取 recognitionid 最大（最新）');

console.log('== parsePracticeData ==');
const parsed = core.parsePracticeData({
  success: true,
  data: {
    episode: { title: 'EP1', audioUrl: 'https://oss/audio.m4a' },
    subtitles: [
      { id: 11, textEn: 'Hi there', textCn: '你好', startSeconds: 1.5, endSeconds: 3.5, words: [{ word: 'Hi', start: 1.5, end: 1.8 }] },
      { id: 12, textEn: 'Bye', startSeconds: 4 },
    ],
    previousRecords: [
      { recognitionid: 7, accuracyScore: 88.6, targetText: 'Hi there', targetStartTime: 1, overallScore: null, fluencyScore: 90.2, detailUrl: '', userAudioUrl: '' },
    ],
    isTrialMode: false,
  },
});
eq(parsed.audioUrl, 'https://oss/audio.m4a', '签名直链');
eq(parsed.episodeTitle, 'EP1', '剧集标题');
eq(parsed.subtitles[0].start, 1.5, 'startSeconds → start');
eq(parsed.subtitles[0].end, 3.5, 'endSeconds → end');
eq(parsed.subtitles[1].end, 7, 'end 缺省 = start + 3');
eq(parsed.subtitles[0].words.length, 1, '词级时间戳透传');
eq(parsed.records[0].accuracyScore, 89, '分数四舍五入');
eq(parsed.records[0].fluencyScore, 90, '可空维度四舍五入');
eq(parsed.records[0].detailUrl, null, '空串 detailUrl 归一为 null');

console.log('== parseEvalResponse / parseDetails（有道明细） ==');
const r1 = core.parseEvalResponse({
  success: true,
  data: {
    score: 91.4,
    recognitionId: 42,
    details: {
      pronunciation: 93.5,
      fluency: 96,
      integrity: 100,
      speed: 120,
      overall: 94.2,
      words: [
        { word: 'This', pronunciation: 88, start: 0.1, end: 0.4, phonemes: [{ phoneme: 'ð', score: 90 }, { phone: 'ɪ', pronunciation: 70 }] },
        { word: 'is', pronunciation: 61 },
      ],
    },
  },
});
eq(r1.overallScore, 94, 'overall 优先');
eq(r1.pronunciation, 94, '93.5 → 94');
eq(r1.fluency, 96, '流利度');
eq(r1.words[0].phonemes[0], { phoneme: 'ð', score: 90 }, '新版音素字段');
eq(r1.words[0].phonemes[1], { phoneme: 'ɪ', score: 70 }, '旧版 phone/pronunciation 兜底');
eq(r1.words[1].start, null, '无切片时间归 null');
// overall 缺失 → pronunciation 兜底
const r2 = core.parseDetails({ pronunciation: 80 }, 1, 99);
eq(r2.overallScore, 80, 'overall ?? pronunciation');
// details 整体缺失 → 退化总分（四维同分）
const r3 = core.parseEvalResponse({ success: true, data: { score: 75, recognitionId: 9 } });
eq([r3.overallScore, r3.pronunciation, r3.fluency, r3.words.length], [75, 75, 0, 0], '无明细退化总分');

console.log('== recordToResult（历史恢复基础卡） ==');
const base = core.recordToResult({ recognitionid: 7, accuracyScore: 88, overallScore: null, fluencyScore: null, integrityScore: 91, speed: null, userAudioUrl: 'https://oss/me.wav' });
eq([base.overallScore, base.pronunciation, base.fluency, base.integrity], [88, 88, 88, 91], '缺维回落 accuracy');
eq(base.userAudioUrl, 'https://oss/me.wav', '云端录音直链透传');

console.log('== 渲染辅助 ==');
eq(core.cleanWordKey('"Hello,"'), 'hello', '去词上标点');
eq(core.cleanWordKey("don't"), "don't", '保留撇号');
eq(core.stripIpaSlashes('/sʌm/'), 'sʌm', '剥斜杠');
const toks = core.buildSentenceTokens(
  { textEn: 'Go now', start: 3, words: [] },
  { go: 'ɡoʊ' }
);
eq(toks.map(t => t.d), ['ɡoʊ', 'now'], '音标模式替换展示文本');
eq(toks.map(t => t.s), [3, 3], '无词级时间戳退化为句起点');
const toks2 = core.buildSentenceTokens({ textEn: 'Go', start: 1, words: [{ word: 'Go', start: 1.2, end: 1.5 }] }, null);
eq(toks2[0].s, 1.2, '词级时间戳绑定');
eq(core.scoreTier(85), 'good', '85 分界含');
eq(core.scoreTier(84), 'mid', '84 → mid');
eq(core.scoreTier(59), 'bad', '59 → bad');
eq(core.ratingWord(95, 85), 'Excellent!', '达标');
eq(core.ratingWord(70, 80), 'Good Job!', '60..阈-1');
eq(core.ratingWord(50, 80), 'Keep Trying!', '低分');

console.log('== pcmToWav / frameAmplitude ==');
const pcm = new ArrayBuffer(3200); // 1600 samples = 0.1s
const view = new DataView(pcm);
for (let i = 0; i < 1600; i++) {
  view.setInt16(i * 2, i % 2 === 0 ? 16000 : -16000, true); // 方波 → 高 RMS
}
const wav = core.pcmToWav([pcm, pcm], 16000);
const wv = new DataView(wav);
const tag = (off) => String.fromCharCode(wv.getUint8(off), wv.getUint8(off + 1), wv.getUint8(off + 2), wv.getUint8(off + 3));
eq(wav.byteLength, 44 + 6400, '总长 = 头 + 数据');
eq(tag(0), 'RIFF', 'RIFF 头');
eq(tag(8), 'WAVE', 'WAVE 头');
eq(wv.getUint32(4, true), 36 + 6400, 'RIFF 长度');
eq(wv.getUint16(20, true), 1, 'PCM 格式');
eq(wv.getUint16(22, true), 1, '单声道');
eq(wv.getUint32(24, true), 16000, '采样率');
eq(wv.getUint32(28, true), 32000, '字节率 = 采样率×2');
eq(wv.getUint16(34, true), 16, '位深');
eq(wv.getUint32(40, true), 6400, 'data 长度');
const ampLoud = core.frameAmplitude(pcm);
const ampSilent = core.frameAmplitude(new ArrayBuffer(3200));
ok(ampLoud > 80, '方波帧高音量（' + ampLoud + '）');
eq(ampSilent, 0, '静音帧 0');

console.log('== computeWordSweep（透传 intensive-core） ==');
const words = [
  { word: 'a', start: 0, end: 1 },
  { word: 'b', start: 1.2, end: 2 },
];
eq(core.computeWordSweep(words, 0.5, 0, 2), { idx: 0, on: true }, '当前词点亮');
eq(core.computeWordSweep(words, 1.05, 0, 2), { idx: 0, on: true }, '间隙前半程光斑留 prev');
eq(core.computeWordSweep(words, 1.15, 0, 2), { idx: 1, on: true }, '间隙后半程光斑跳 next');
eq(core.computeWordSweep(words, 2.5, 0, 2), { idx: 2, on: false }, '读毕全已读');

console.log('');
console.log('语音评测 core：' + passed + ' 通过，' + failed + ' 失败');

// ==================== 页内切片播放精度仿真（Android MediaPlayer 等价） ====================

/**
 * 模拟 InnerAudioContext：解码器位置以真实墙钟 × 倍速推进（50ms 步进），
 * onTimeUpdate 每 300ms 才回调一次（真机快照粒度）。可配置的真机形态：
 *   staleFirstMs  首帧回报延迟送达且为起播时刻陈旧快照（句首重播 bug 形态）
 *   reportLagMs   稳态回报经延迟管线送达：携带 reportLagMs 前的位置快照
 *                 （"I'm Neil. An" 句尾漏音 bug 形态）
 *   onPlayDelayMs onPlay 事件晚于实际起播送达（外推起点偏晚形态）
 */
function makeFakeCtx(cfg) {
  const honorStartTime = cfg.honor;
  const staleFirstMs = cfg.staleFirstMs || 0;
  const reportLagMs = cfg.reportLagMs || 0;
  const onPlayDelayMs = cfg.onPlayDelayMs || 0;
  const handlers = {};
  const ctx = {
    startTime: 0,
    playbackRate: 1,
    currentTime: 0,
    src: '',
    seekCalls: [],
    _playing: false,
    _timer: null,
    _reportTimer: null,
    _stoppedAt: null,
    _stoppedWall: null,
    onCanplay(cb) { handlers.canplay = cb; },
    onPlay(cb) { handlers.play = cb; },
    onTimeUpdate(cb) { handlers.timeupdate = cb; },
    onWaiting(cb) { handlers.waiting = cb; },
    onEnded(cb) { handlers.ended = cb; },
    onError(cb) { handlers.error = cb; },
    offCanplay() {}, offTimeUpdate() {}, offEnded() {}, offError() {},
    _fire(name) { handlers[name] && handlers[name](); },
    /** 派发一帧 timeupdate；reportLagMs > 0 时临时把 currentTime 置为滞后快照 */
    _fireReport() {
      const truePos = this.currentTime;
      if (reportLagMs) {
        this.currentTime = Math.max(0, truePos - (reportLagMs / 1000) * (this.playbackRate || 1));
        this._fire('timeupdate');
        this.currentTime = truePos;
      } else {
        this._fire('timeupdate');
      }
    },
    _startTicker() {
      let last = Date.now();
      this._timer = setInterval(() => {
        const now = Date.now();
        this.currentTime += ((now - last) / 1000) * (this.playbackRate || 1);
        last = now;
      }, 50);
    },
    play() {
      if (this._playing) return;
      this._playing = true;
      if (honorStartTime && this.startTime > 0 && this.currentTime === 0) {
        this.currentTime = this.startTime;
      }
      this._startTicker();
      const startSnap = this.currentTime;
      if (staleFirstMs) {
        // 首帧回报延迟送达 + 陈旧快照（真机二次播放形态），之后恢复 300ms 正常回报
        setTimeout(() => {
          const truePos = this.currentTime;
          this.currentTime = startSnap + 0.1;
          this._fire('timeupdate');
          this.currentTime = truePos;
          this._reportTimer = setInterval(() => this._fireReport(), 300);
        }, staleFirstMs);
      } else {
        this._reportTimer = setInterval(() => this._fireReport(), 300);
      }
      if (onPlayDelayMs) {
        setTimeout(() => this._fire('play'), onPlayDelayMs);
      } else {
        this._fire('play');
      }
    },
    seek(s) {
      this.seekCalls.push(s);
      this.currentTime = s;
    },
    /** 模拟缓冲停顿 ms 毫秒：触发 onWaiting 后仍送达一帧停顿前快照（真机
     * 事件乱序形态），随后冻结解码推进，恢复时回报一帧 */
    stall(ms) {
      if (!this._playing) return;
      this._fire('waiting');
      this._fire('timeupdate'); // 停顿前快照滞后送达：不得解除冻结
      clearInterval(this._timer);
      this._timer = null;
      setTimeout(() => {
        this._startTicker();
        this._fire('timeupdate');
      }, ms);
    },
    stop() { this._record(); this._teardown(); },
    destroy() { this._record(); this._teardown(); },
    _record() {
      if (this._stoppedAt == null) {
        this._stoppedAt = this.currentTime;
        this._stoppedWall = Date.now();
      }
    },
    _teardown() {
      if (this._timer) clearInterval(this._timer);
      if (this._reportTimer) clearInterval(this._reportTimer);
      this._timer = this._reportTimer = null;
      this._playing = false;
    },
  };
  return ctx;
}

// ==================== 页面模块加载（mock wx + Page 捕获，两组仿真共享） ====================

let lastCtx = null;
let _pageCfg = null;

function ensurePageLoaded() {
  if (_pageCfg) return _pageCfg;
  global.wx = {
    getStorageSync: () => '',
    setStorageSync: () => {},
    getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375 }),
    getSystemInfoSync: () => ({ statusBarHeight: 20, theme: 'light' }),
    getAppBaseInfo: () => ({ theme: 'light' }),
    getMenuButtonBoundingClientRect: () => ({ left: 278 }),
    getRecorderManager: () => ({ onStart() {}, onFrameRecorded() {}, onStop() {}, onError() {}, start() {}, stop() {} }),
    getFileSystemManager: () => ({}),
    env: { USER_DATA_PATH: 'wxfile://usr' },
    navigateBack() {}, switchTab() {}, navigateTo() {},
    showToast() {}, showModal() {},
    createInnerAudioContext() { lastCtx = makeFakeCtx({ honor: true }); return lastCtx; },
  };
  global.Page = (cfg) => { _pageCfg = cfg; };
  require('../pages/speech-eval/index.js');
  return _pageCfg;
}

// ==================== 录音→评测全链路仿真（真机 onStop 缺失兜底） ====================

/**
 * 复刻真机 bug 形态：RecorderManager.stop() 之后 onStop 回调不触发（真机 PCM
 * 格式的已知平台差异，开发者工具正常）——修复前评测链完全押在 onStop 上，
 * 点击「停止并评测」后页面永卡录音态。修复后点击直取内存 PCM 帧评测。
 * 同时验证：评测请求体（subtitleId/targetText/rate）、评测中→结果翻面、
 * onStop 迟到触发不双跑（_finishing 防重）。
 */
async function runRecordEvalSim() {
  const rawPage = ensurePageLoaded();
  const recHandlers = {};
  const recorderCalls = { starts: 0, stops: 0 };
  const recorder = {
    start(opts) { recorderCalls.starts += 1; recorderCalls.lastOpts = opts; setTimeout(() => recHandlers.start && recHandlers.start(), 5); },
    stop() { recorderCalls.stops += 1; /* 真机 bug 形态：不回调 onStop */ },
    onStart(cb) { recHandlers.start = cb; },
    onFrameRecorded(cb) { recHandlers.frame = cb; },
    onStop(cb) { recHandlers.stop = cb; },
    onError(cb) { recHandlers.error = cb; },
  };
  const evalRequests = [];
  global.wx.getRecorderManager = () => recorder;
  global.wx.getFileSystemManager = () => ({
    writeFileSync() {},
    readFileSync(path, enc) { return enc === 'base64' ? 'UklGRg==' : new ArrayBuffer(64000); },
    unlinkSync() {},
  });
  global.wx.request = (opt) => {
    // 按 URL 路由：练习数据 / 评测 / 其余（生词表等）静默成功
    if (opt.url.indexOf('/api/speech/evaluate') >= 0) {
      evalRequests.push(opt.data);
      setTimeout(() => opt.success({
        statusCode: 200,
        data: {
          success: true,
          data: {
            score: 88, recognitionId: 7,
            details: { pronunciation: 90, fluency: 91, integrity: 92, speed: 100, overall: 89,
              words: [{ word: 'Neil', pronunciation: 95, phonemes: [{ phoneme: 'n', score: 92 }] }] },
          },
        },
      }), 20);
      return;
    }
    if (opt.url.indexOf('/api/speech/practice-data') >= 0) {
      setTimeout(() => opt.success({
        statusCode: 200,
        data: {
          success: true,
          data: {
            episode: { title: 'EP', audioUrl: 'https://oss/a.m4a' },
            subtitles: [{ id: 3, textEn: "I'm Neil.", textCn: '我是尼尔。', startSeconds: 5, endSeconds: 6.2 }],
            previousRecords: [], isTrialMode: false,
          },
        },
      }), 10);
      return;
    }
    setTimeout(() => opt.success({ statusCode: 200, data: { success: true, data: [] } }), 10);
  };

  console.log('');
  console.log('== 录音→评测全链路仿真（真机 stop() 后 onStop 不回调） ==');

  const store = Object.assign({}, rawPage.data);
  const page = Object.assign(Object.create(rawPage), {
    setData(p) { Object.assign(store, p); },
    data: store,
  });
  page.onLoad({ id: 'ep1' });
  await new Promise((r) => setTimeout(r, 40)); // 等练习数据落地
  ok(page._subs.length === 1 && store.indexLabel === '1 / 1', '字幕集就绪（1/1）');

  // 起录：onStart + 20 帧 × 3200B（2s，> 0.5s 下限）
  recHandlers.start();
  for (let i = 0; i < 20; i++) recHandlers.frame({ frameBuffer: new ArrayBuffer(3200) });
  ok(store.phase === 'recording', '录音中态（onStart）');

  // 点击「停止并评测」：不等 onStop 直取帧评测（真机 bug 修复点）
  await page.onToggleRecording();
  ok(store.phase === 'evaluating', '点击后立即进入评测中（不依赖 onStop）');
  await new Promise((r) => setTimeout(r, 80));
  ok(store.phase === 'result', '评测完成翻到结果面（修复前永卡录音态）');
  ok(store.result && store.result.overallScore === 89 && store.result.words.length === 1, '有道明细解析（总分 89）');
  ok(evalRequests.length === 1 && evalRequests[0].subtitleId === 3 &&
    evalRequests[0].targetText === "I'm Neil." && evalRequests[0].rate === 16000, '评测请求体（subtitleId/targetText/rate）');
  ok(recorderCalls.stops === 1, 'stop() 仍被调用释放麦克风');

  // onStop 迟到触发（_finishing 防重，不双跑评测）
  recHandlers.stop && recHandlers.stop({ tempFilePath: 'wxfile://pcm.tmp' });
  await new Promise((r) => setTimeout(r, 60));
  ok(evalRequests.length === 1, 'onStop 迟到不重复评测（防重）');
  page.onUnload();
}

async function runPlaybackSims() {
  // ---- 页面模块共享加载（见 ensurePageLoaded） ----
  const rawPage = ensurePageLoaded();

  const sub = {
    id: 1,
    textEn: 'Go now please',
    textCn: '现在请出发',
    start: 10,
    end: 11.2,
    words: [
      { word: 'Go', start: 10, end: 10.4 },
      { word: 'now', start: 10.5, end: 10.8 },
      { word: 'please', start: 10.9, end: 11.2 },
    ],
  };

  function buildPage() {
    const store = Object.assign({}, rawPage.data);
    const page = Object.assign(Object.create(rawPage), {
      setData(p) { Object.assign(store, p); },
      data: store,
    });
    page._subs = [sub];
    return page;
  }

  /** 跑一次切片播放，resolve 停点位置与 seek 次数（超时 reject） */
  function playClip(cfg, rate, endSec, stall) {
    return new Promise((resolve, reject) => {
      global.wx.createInnerAudioContext = () => {
        lastCtx = makeFakeCtx(cfg);
        return lastCtx;
      };
      const page = buildPage();
      const startedAt = Date.now();
      page._playUrl('https://oss/audio.m4a', 'original', { startSec: 10, endSec, rate });
      setTimeout(() => lastCtx._fire('canplay'), 10);
      if (stall) setTimeout(() => lastCtx.stall(stall), 300);
      const timer = setTimeout(() => reject(new Error('播放未在预期窗口内停止')), 15000);
      const poll = setInterval(() => {
        if (lastCtx._stoppedAt != null) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve({ pos: lastCtx._stoppedAt, wall: Date.now() - startedAt, seekCalls: lastCtx.seekCalls.length });
        }
      }, 25);
    });
  }

  const scenarios = [
    { name: '原速切片（rate=1）', cfg: { honor: true }, rate: 1, end: 11.2, stall: 0, wantWall: 1.2, wantSeeks: 0 },
    { name: '慢速切片（rate=0.75）', cfg: { honor: true }, rate: 0.75, end: 11.2, stall: 0, wantWall: 1.2 / 0.75, wantSeeks: 0 },
    // startTime 被忽略：首个 timeupdate（+0.3s）回报 ~0.3（比句首早 9.7s）才纠偏回句首
    { name: 'startTime 被忽略（首帧纠偏兜底）', cfg: { honor: false }, rate: 1, end: 11.2, stall: 0, wantWall: 1.5, wantSeeks: 1 },
    { name: '缓冲停顿 600ms（冻结判停不误停）', cfg: { honor: true }, rate: 1, end: 11.2, stall: 600, wantWall: 1.8, wantSeeks: 0 },
    // 真机二次播放回放形态：首帧回报延迟 900ms 且为陈旧快照（句首+0.1s）。
    // 修复前：墙钟期望比较误判落点失败 → seek 回句首 → 句首 ~1s 重播（wall≈2.1s）；
    // 修复后：陈旧快照落后外推被忽略 → 不回跳、停点准点
    { name: '真机二次播放（首帧回报延迟 900ms 陈旧快照，句首不重播）', cfg: { honor: true, staleFirstMs: 900 }, rate: 1, end: 11.2, stall: 0, wantWall: 1.2, wantSeeks: 0 },
    { name: '真机二次播放慢速（同上，rate=0.75）', cfg: { honor: true, staleFirstMs: 900 }, rate: 0.75, end: 11.2, stall: 0, wantWall: 1.2 / 0.75, wantSeeks: 0 },
    // 真机稳态回报延迟管线：每帧携带 300ms 前的位置快照（"I'm Neil. An" 漏音形态）。
    // 修复前：按「回报位置 @ 送达时刻」重锚，外推时间轴被每帧回拖 0.3s，
    // 句尾停点迟到 → 停点 ≈ endSec+0.3（漏出下一句开头）；
    // 修复后（锚点只前跳不回拖）：外推以墙钟为轴不受管线延迟影响，停点准点
    { name: '真机稳态回报延迟 300ms（句尾不漏下一句开头）', cfg: { honor: true, reportLagMs: 300 }, rate: 1, end: 11.2, stall: 0, wantWall: 1.2, wantSeeks: 0 },
    { name: '真机稳态回报延迟 300ms 慢速（同上）', cfg: { honor: true, reportLagMs: 300 }, rate: 0.75, end: 11.2, stall: 0, wantWall: 1.2 / 0.75, wantSeeks: 0 },
    // onPlay 事件晚于实际起播 250ms 送达：外推起点偏晚 → 首帧准确回报领先外推，
    // 前跳校准后停点准点
    { name: 'onPlay 迟到 250ms（首帧前跳校准）', cfg: { honor: true, onPlayDelayMs: 250 }, rate: 1, end: 11.2, stall: 0, wantWall: 1.2, wantSeeks: 0 },
  ];

  console.log('');
  console.log('== 切片播放精度仿真（Android MediaPlayer 等价：startTime + 墙钟外推 50ms 看门狗） ==');
  for (const s of scenarios) {
    const r = await playClip(s.cfg, s.rate, s.end, s.stall);
    const posErr = r.pos - s.end;
    const wallErr = r.wall / 1000 - s.wantWall;
    // 停点判据：endSec-0.10 ≤ pos ≤ endSec+0.2（上界严防漏进下一句开头——
    // 旧实现直接轮询快照会漂到 +0.5s；下界容忍整机满载并发跑测时的
    // 50ms 定时器调度抖动，早停 0.1s 内无听感影响）
    const okPos = posErr >= -0.1 && posErr <= 0.2;
    // 墙钟判据：±0.35s（覆盖仿真定时器抖动）；seek 次数精确对齐预期
    const okWall = Math.abs(wallErr) <= 0.35;
    const okSeek = r.seekCalls === s.wantSeeks;
    ok(okPos && okWall && okSeek,
      s.name + '：停点 ' + r.pos.toFixed(3) + 's（' + (posErr >= 0 ? '+' : '') + posErr.toFixed(3) + 's），耗时 ' +
      (r.wall / 1000).toFixed(2) + 's（期望 ' + s.wantWall.toFixed(2) + 's），seek×' + r.seekCalls);
  }
}

runRecordEvalSim()
  .then(() => runPlaybackSims())
  .then(() => {
    console.log('');
    console.log('语音评测 core：' + passed + ' 通过，' + failed + ' 失败');
    if (failed > 0) process.exit(1);
  })
  .catch((e) => {
    console.error('  ✗ 仿真失败：' + (e && e.message));
    process.exit(1);
  });
