/**
 * scripts/test-eval-card.js — 语音评测卡自动化测试（REVIEW-TASK T3.2）
 *
 * 两层驱动：
 *   1. utils/clip-player.js 播放内核——mock InnerAudioContext + 墙钟推进：
 *      起播锚定（startTime）/ onPlaying 流转 / 看门狗窗口判停（onEnded）/
 *      慢速倍速起播后设置 / stop 复位；
 *   2. components/voice/eval-card——Component 定义捕获 + makeInstance：
 *      四态流转（idle→recording→processing→result）/ 评测请求体 /
 *      403 永久置锁 + premium / quota 刷新外抛 / 评级文案三档 /
 *      词级对比 URL 与窗口 / previousResult 入场即结果态 / 录音太短。
 *
 * 运行：node scripts/test-eval-card.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) {
  for (let i = 0; i < (n || 6); i++) await tick();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 接口 mock ----------
const apiResponses = {};
const requestLog = [];
function resolveRequest(opts) {
  const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestLog.push({ path: p, method: opts.method || 'GET', data: opts.data });
  const hit = apiResponses[p];
  const body = typeof hit === 'function' ? hit(opts.data) : hit;
  if (body === undefined) {
    opts.success({ statusCode: 200, data: { success: true, data: {} } });
  } else if (body instanceof Error) {
    opts.success({ statusCode: 500, data: { success: false, message: 'boom' } });
  } else if (body.__status) {
    opts.success({ statusCode: body.__status, data: body });
  } else {
    opts.success({ statusCode: 200, data: body });
  }
}

// ---------- InnerAudioContext mock ----------
const audioInstances = [];
function makeAudioCtx() {
  const handlers = {};
  const ctx = {
    src: '',
    startTime: 0,
    playbackRate: 1,
    currentTime: 0,
    played: 0,
    stopped: 0,
    destroyed: false,
    seeks: [],
    play() { this.played += 1; },
    stop() { this.stopped += 1; },
    destroy() { this.destroyed = true; },
    seek(t) { this.seeks.push(t); },
    onPlay(cb) { handlers.play = cb; },
    onEnded(cb) { handlers.ended = cb; },
    onError(cb) { handlers.error = cb; },
    onCanplay(cb) { handlers.canplay = cb; },
    onTimeUpdate(cb) { handlers.timeupdate = cb; },
    onWaiting(cb) { handlers.waiting = cb; },
    offEnded() { delete handlers.ended; },
    offError() { delete handlers.error; },
    offCanplay() { delete handlers.canplay; },
    offTimeUpdate() { delete handlers.timeupdate; },
    offPlay() { delete handlers.play; },
    offWaiting() { delete handlers.waiting; },
    __fire(e) { handlers[e] && handlers[e](); },
  };
  audioInstances.push(ctx);
  return ctx;
}

// ---------- RecorderManager mock ----------
const recHandlers = {};
const rmStartOpts = [];
const recorderMock = {
  onStart(cb) { recHandlers.start = cb; },
  onFrameRecorded(cb) { recHandlers.frame = cb; },
  onStop(cb) { recHandlers.stop = cb; },
  onError(cb) { recHandlers.error = cb; },
  start(o) { rmStartOpts.push(o); },
  stop() {},
};

// ---------- FileSystemManager mock ----------
const fsFiles = {};
const fsm = {
  writeFileSync(p, d) { fsFiles[p] = d; },
  readFileSync(p, enc) {
    if (enc === 'base64') return 'QkFTRTY0==';
    return fsFiles[p] || new ArrayBuffer(16000);
  },
  unlinkSync(p) { delete fsFiles[p]; },
};

const toastCalls = [];
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: (o) => o.success && o.success({ confirm: false }),
  getSetting: (o) => o.success({ authSetting: { 'scope.record': true } }),
  authorize: (o) => o.success(),
  openSetting: (o) => o.success({ authSetting: {} }),
  request: resolveRequest,
  getRecorderManager: () => recorderMock,
  getFileSystemManager: () => fsm,
  getBackgroundAudioManager: () => ({
    play() {}, pause() {}, stop() {}, seek() {},
    onPlay() {}, onPause() {}, onStop() {}, onEnded() {},
    onTimeUpdate() {}, onCanplay() {}, onWaiting() {}, onError() {},
    onPrev() {}, onNext() {},
  }),
  createInnerAudioContext: makeAudioCtx,
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, theme: 'light' }),
};
wx.env = { USER_DATA_PATH: 'wxfile://usr' };

const componentDefs = {};
global.Component = (cfg) => { componentDefs.__last = cfg; };

const clipPlayerFactory = require(path.join(__dirname, '../utils/clip-player'));
require(path.join(__dirname, '../components/voice/eval-card'));
const cardDef = componentDefs.__last;
assert(!!cardDef && !!cardDef.methods, '模块加载：eval-card Component 定义捕获成功');

const WXML = fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.wxml'), 'utf8');
const WXSS = fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.wxss'), 'utf8');
const JSON_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.json'), 'utf8'));

/** 事件捕获版 makeInstance */
function makeCard(props) {
  const propDefaults = {};
  Object.keys(cardDef.properties || {}).forEach((k) => {
    propDefaults[k] = cardDef.properties[k].value;
  });
  const inst = {
    data: Object.assign(propDefaults, JSON.parse(JSON.stringify(cardDef.data))),
    events: [],
    setData(patch, cb) {
      Object.assign(this.data, patch);
      if (cb) cb();
    },
    triggerEvent(name, detail) {
      this.events.push({ name, detail });
    },
  };
  Object.keys(props || {}).forEach((k) => { inst.data[k] = props[k]; });
  const source = cardDef.methods ? Object.assign({}, cardDef.methods) : {};
  Object.keys(source).forEach((k) => {
    if (typeof source[k] === 'function') inst[k] = source[k].bind(inst);
  });
  if (cardDef.lifetimes && cardDef.lifetimes.attached) {
    inst._attached = cardDef.lifetimes.attached.bind(inst);
  }
  if (cardDef.observers) inst._observers = cardDef.observers;
  return inst;
}

const SUB = {
  textEn: 'The resilient economy recovered quickly.',
  textCn: '有韧性的经济很快恢复了。',
  words: [
    { word: 'The', start: 12.0, end: 12.2 },
    { word: 'resilient', start: 12.2, end: 12.8 },
    { word: 'economy', start: 12.9, end: 13.5 },
  ],
  audioUrl: 'https://oss.example.com/ep1.m4a',
  start: 12.0,
  end: 13.5,
};

const EVAL_BODY = {
  success: true,
  data: {
    score: 88,
    recognitionId: 4321,
    details: {
      // 有道 ISE 原始口径：词分字段 = pronunciation（parseWordDto 同源）
      overall: 88,
      pronunciation: 90,
      fluency: 85,
      integrity: 88,
      speed: 100,
      words: [
        { word: 'The', pronunciation: 95, phonemes: [] },
        { word: 'resilient', pronunciation: 78, start: 0.1, end: 0.8,
          phonemes: [{ phoneme: 'r', score: 60 }, { phoneme: 'ɪ', score: 90 }] },
        { word: 'economy', pronunciation: 88, phonemes: [] },
      ],
    },
  },
};

/* ==================== 1. clip-player 播放内核 ==================== */

section('clip-player（窗口播放内核）');

(async () => {
  let playingKinds = [];
  let endedKinds = [];
  const cp = clipPlayerFactory.createClipPlayer({
    onPlaying: (k) => playingKinds.push(k),
    onEnded: (k) => endedKinds.push(k),
  });

  // 起播锚定 + onPlaying
  cp.playUrl('https://oss.example.com/ep1.m4a', 'original', { startSec: 12, endSec: 13.5 });
  const ctx = audioInstances[audioInstances.length - 1];
  assert(ctx.startTime === 12, '起播锚定：ctx.startTime = 窗口起点（无 seek 竞态）');
  ctx.__fire('canplay');
  assert(playingKinds[playingKinds.length - 1] === 'original' && ctx.played === 1, 'canplay → play + onPlaying(original)');

  // 慢速：onPlay 后才设置 playbackRate（提前设置会被平台忽略）
  ctx.__fire('play');
  assert(ctx.playbackRate === 1, '常速不触碰 playbackRate');
  const slow = audioInstances[audioInstances.length - 1];
  cp.playUrl('https://oss.example.com/ep1.m4a', 'slow', { startSec: 12, endSec: 13.5, rate: 0.75 });
  const sctx = audioInstances[audioInstances.length - 1];
  assert(sctx !== ctx, '切播重建 ctx（单实例）');
  sctx.__fire('canplay');
  sctx.__fire('play');
  assert(sctx.playbackRate === 0.75, '慢速倍速在 onPlay 后设置（0.75）');

  // 看门狗窗口判停：endSec 很近，墙钟推进后 onEnded
  playingKinds = [];
  endedKinds = [];
  cp.playUrl('https://dict.youdao.com/dictvoice?audio=word&type=2', 'word_us', { startSec: 0, endSec: 0.15 });
  const wctx = audioInstances[audioInstances.length - 1];
  wctx.__fire('canplay');
  wctx.__fire('play');
  await sleep(400); // 50ms 看门狗 × 若干拍
  assert(endedKinds.includes('word_us'), '看门狗：外推 ≥ endSec 即停并回调 onEnded');
  assert(playingKinds[playingKinds.length - 1] === null, '停止后 onPlaying(null) 复位');

  // stop 手动复位
  cp.playUrl('https://oss.example.com/ep1.m4a', 'original', { startSec: 1, endSec: 2 });
  const c2 = audioInstances[audioInstances.length - 1];
  c2.__fire('canplay');
  cp.stop();
  assert(c2.stopped === 1 && cp.getKind() === null, 'stop：销毁 ctx + kind 复位');

  /* ==================== 2. eval-card 四态流转与评测闭环 ==================== */

  section('eval-card（四态流转 + 评测闭环）');

  apiResponses['/api/speech/evaluate'] = EVAL_BODY;
  apiResponses['/api/speech/quota'] = { success: true, data: { used: 3, limit: 5, remaining: 2, exhausted: false } };
  apiResponses['/api/dictionary/youdao'] = { success: true, data: { speakUrl: 'https://tts/a.mp3' } };

  const card = makeCard({
    subtitle: SUB, subtitleId: 77, episodeId: 'ep1', episodeTitle: '剧集一',
  });
  card._attached();
  assert(card.data.textEn === SUB.textEn && card.data.phase === 'idle' && !card.data.locked,
    '入场派生：textEn 落 data / idle / 未锁');

  // idle → recording（权限已授权 mock；互斥由 recorder 编排）
  rmStartOpts.length = 0;
  await card.onToggleRecording();
  await settle(4);
  recHandlers.start();
  assert(rmStartOpts.length === 1 && rmStartOpts[0].format === 'PCM',
    '起录：recorder PCM（T3.1 底座）');
  assert(card.data.phase === 'recording', 'phase → recording');

  // 波形：帧驱动 amplitudes（100ms 节流在 recorder 内）；喂足 0.5s 阈值字节
  recHandlers.frame({ frameBuffer: new ArrayBuffer(16000) });
  assert(card.data.amplitudes.length === 1, '音量帧驱动波形');

  // recording → processing → result（评测请求体）
  requestLog.length = 0;
  card.events.length = 0;
  await card.onToggleRecording(); // 停止并评测
  await settle(8);
  const evalReq = requestLog.find((r) => r.path === '/api/speech/evaluate');
  assert(!!evalReq, 'POST /api/speech/evaluate 发出');
  assert(evalReq.data.episodeId === 'ep1' && evalReq.data.subtitleId === 77 &&
    evalReq.data.targetText === SUB.textEn && evalReq.data.rate === 16000 &&
    evalReq.data.scenario === 'review', '评测请求体字段逐项（episodeId/subtitleId/targetText/rate/scenario）');
  assert(typeof evalReq.data.audioBase64 === 'string' && evalReq.data.audioBase64.length > 0,
    'audioBase64 透传（WAV）');
  assert(card.data.phase === 'result' && card.data.result.overallScore === 88,
    '成功回填：phase → result（overallScore 88）');
  const evalEvt = card.events.find((e) => e.name === 'evaluate');
  assert(!!evalEvt && evalEvt.detail.score === 88 && evalEvt.detail.recognitionId === 4321,
    'evaluate 事件外抛（score/details/recognitionId）');
  const quotaEvt = card.events.find((e) => e.name === 'quota');
  assert(!!quotaEvt && quotaEvt.detail.used === 3, '评测后 quota 刷新外抛（used=3）');
  assert(card.data.rating === 'Excellent!', '评级文案：88 ≥ 80 → Excellent!');
  assert(card.data.result.words[1].phonemes.length === 2, '逐词胶囊：词级音素明细解析');

  // 词级对比：美音/英音 URL
  audioInstances.length = 0;
  card.onPlayDictVoice({ currentTarget: { dataset: { word: 'resilient', us: '1' } } });
  let dctx = audioInstances[audioInstances.length - 1];
  assert(dctx.src.includes('dictvoice?audio=resilient&type=2'), '美音：dictvoice type=2 直链');
  dctx.__fire('canplay');
  assert(card.data.playing === 'word_us', '美音播放态高亮');
  card.onPlayDictVoice({ currentTarget: { dataset: { word: 'resilient', us: '0' } } });
  dctx = audioInstances[audioInstances.length - 1];
  assert(dctx.src.includes('type=1'), '英音：dictvoice type=1 直链');

  // 词级原声：词窗口
  audioInstances.length = 0;
  card.onPlayWordOriginal({ currentTarget: { dataset: { word: 'economy' } } });
  const wctx2 = audioInstances[audioInstances.length - 1];
  assert(wctx2.startTime === 12.9, '词级原声：startTime = 词级时间戳窗口');

  // 词级「我」：录音切片
  audioInstances.length = 0;
  card.onPlayWordMe({ currentTarget: { dataset: { index: 1 } } });
  const mctx = audioInstances[audioInstances.length - 1];
  assert(mctx.startTime === 0.1, '词级「我」：录音词切片 start');

  // 点词展开音素行
  card.onSelectWord({ currentTarget: { dataset: { index: 1 } } });
  assert(card.data.selectedWordIndex === 1, '点词展开音素诊断');
  card.onSelectWord({ currentTarget: { dataset: { index: 1 } } });
  assert(card.data.selectedWordIndex === null, '再点收起');

  // 再试一次
  card.onRetryRecording();
  assert(card.data.phase === 'idle' && card.data.result === null, '再试一次 → idle 复位');

  /* ---------- 评级三档 ---------- */
  card._applyRating(70);
  assert(card.data.rating === 'Good Job!', '评级文案：70 → Good Job!');
  card._applyRating(50);
  assert(card.data.rating === 'Keep Trying!', '评级文案：50 → Keep Trying!');
  card._applyRating(90);
  assert(card.data.rating === 'Excellent!', '评级文案：90 → Excellent!');
  assert(card.data.ratingSub.includes('80'), '副文案带 passThreshold');

  /* ---------- 录音太短（帧不足 0.5s 阈值；零帧会走 1.5s 超时兜底，不是本路径） ---------- */
  toastCalls.length = 0;
  await card.onToggleRecording();
  await settle(4);
  recHandlers.start();
  recHandlers.frame({ frameBuffer: new ArrayBuffer(1600) }); // 0.05s < 0.5s
  await card.onToggleRecording();
  await settle(8);
  assert(card.data.phase === 'idle' && toastCalls.includes('录音太短，请重试'),
    '录音太短：toast + 回落 idle');

  /* ---------- 403 永久置锁 ---------- */
  section('403 配额墙（永久置锁 + 转化）');

  apiResponses['/api/speech/evaluate'] = {
    __status: 403,
    success: false,
    code: 'REVIEW_EVAL_QUOTA_EXCEEDED',
    message: '今日免费评测次数已用完',
  };
  toastCalls.length = 0;
  await card.onToggleRecording();
  await settle(4);
  recHandlers.start();
  recHandlers.frame({ frameBuffer: new ArrayBuffer(16000) });
  await card.onToggleRecording();
  await settle(8);
  assert(card.data.phase === 'idle', '403 后回落 idle（不出结果）');
  assert(card.data.locked === true, '403 → 本卡永久置锁');
  assert(card.data.showPremiumModal === true && card.data.premiumSource === 'review_eval_quota',
    '403 → premium-modal(review_eval_quota)');
  assert(toastCalls.includes('今日免费评测次数已用完'), '403 → 后端 message toast');

  // 锁定态：点录音只开会员窗，不再起录
  rmStartOpts.length = 0;
  await card.onToggleRecording();
  await settle(4);
  assert(rmStartOpts.length === 0 && card.data.showPremiumModal === true,
    '锁定态点录音：零起录，重开会员窗');

  // quotaLocked prop 透传（父页预检）
  const card2 = makeCard({ subtitle: SUB, quotaLocked: true });
  card2._attached();
  assert(card2.data.locked === true, 'quotaLocked prop → 锁定态');

  // previousResult → 入场即结果态
  const card3 = makeCard({
    subtitle: SUB,
    previousResult: { overallScore: 92, pronunciation: 93, fluency: 90, integrity: 92, speed: 100, words: [] },
  });
  card3._attached();
  assert(card3.data.phase === 'result' && card3.data.rating === 'Excellent!',
    'previousResult → 入场即结果态');

  // 书签真实现：toggle 请求 + 乐观翻转 + toast（走查修复：此前仅外抛事件无逻辑）
  apiResponses['/api/sentences/toggle'] = { success: true, data: { saved: false } };
  requestLog.length = 0;
  toastCalls.length = 0;
  card3.setData({ bookmarked: true, subtitleId: 77, episodeId: 'ep1' });
  card3.onToggleBookmark();
  await settle(8);
  const bkReq = requestLog.find((r) => r.path === '/api/sentences/toggle');
  assert(!!bkReq && bkReq.data.episodeid === 'ep1' && bkReq.data.subtitleId === 77 &&
    bkReq.data.enText === SUB.textEn && bkReq.data.startTime === SUB.start &&
    bkReq.data.endTime === SUB.end,
    '书签 toggle 请求体（episodeid/subtitleId/start/end/enText/zhText）');
  assert(card3.data.bookmarked === false, '取消收藏：本地态翻转（saved=false）');
  assert(toastCalls.includes('已从「句子本」移除'), '取消收藏 toast 逐字');
  const bkEvt = card3.events.find((e) => e.name === 'bookmark');
  assert(!!bkEvt && bkEvt.detail.saved === false, 'bookmark 事件外抛（saved）');

  // 失败回滚
  apiResponses['/api/sentences/toggle'] = { success: false, message: 'boom' };
  card3.setData({ bookmarked: true });
  card3.onToggleBookmark();
  await settle(8);
  assert(card3.data.bookmarked === true, 'toggle 失败：乐观翻转回滚');

  // subtitleId 缺失防御
  const card4 = makeCard({ subtitle: SUB }); // subtitleId 默认 null
  card4._attached();
  toastCalls.length = 0;
  requestLog.length = 0;
  card4.onToggleBookmark();
  await settle(4);
  assert(toastCalls.includes('该句缺少字幕定位，无法收藏') &&
    !requestLog.some((r) => r.path === '/api/sentences/toggle'),
    'subtitleId 缺失：提示且零请求');

  /* ==================== 3. 结构断言 ==================== */

  section('WXML / WXSS / json 结构断言');

  ['AI朗读', '原声播放', '慢速播放', '收藏书签', '单句循环'].forEach((label) => {
    assert(WXML.includes('>' + label + '</text>'), '工具行钮标签：' + label);
  });
  assert(/\.ec-act \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*align-items: center/s.test(WXSS),
    '钮列 flex 布局：标签与圆钮水平居中对齐（走查修复）');
  assert(!WXML.includes('显示翻译') && !WXML.includes('隐藏翻译'),
    '工具行翻译钮已删除（走查修复）');
  assert(!WXML.includes('ec-sentence-row') &&
    /<text>\{\{textEn\}\} <\/text>\s*<image class="ec-translate-ic"/.test(WXML.replace(/\n\s*/g, '\n')) || WXML.includes('{{textEn}} </text>'),
    '翻译图标随文流排句尾（text 后 inline，非右侧独立列）');
  assert(WXML.includes('class="ec-card {{themeClass}} col"') &&
    /\/\* ===== 深色[\s\S]*\.theme-dark \{/.test(WXSS) && !WXSS.includes('.theme-dark .ec-card'),
    '组件根自持 themeClass + 独立 .theme-dark 令牌块（深色卡片走查修复：组件样式无法命中页面祖先）');
  assert(WXML.includes("loop ? (dark ? '/assets/icons/repeat-1-primary-dark.svg' : '/assets/icons/repeat-1-primary.svg') : (dark ? '/assets/icons/repeat-lucide-graydark.svg' : '/assets/icons/repeat-lucide-gray.svg')"),
    '循环图标四态全内联且同族 lucide（未激活 Repeat 无"1" / 激活 Repeat1——走查修复风格混搭）');
  assert(!WXML.includes("bookmarked ? 'ec-act-btn--on'") &&
    !WXML.includes("loop ? 'ec-act-btn--on'"),
    '书签/循环激活态只切图标不改按钮背景（走查修复）');
  assert(WXML.includes('今日免费跟读评测已用完') && WXML.includes('解锁无限评测'),
    '配额锁定态：文案逐字（spec）');
  assert(WXML.includes('正在分析发音...'), '处理中态文案逐字（spec）');
  assert(WXML.includes('点击录音') && WXML.includes('点击停止并评测'), '空闲/录音态文案');
  assert(WXML.includes('Excellent') === false, '评级文案走 JS 派生（WXML 零拼接）');
  assert(WXML.includes('综合得分') && WXML.includes('准确度') && WXML.includes('流利度') && WXML.includes('完整度'),
    '结果区：得分环标签 + 三维条');
  assert(WXML.includes('逐词纠错') && WXML.includes('音素诊断'), '逐词胶囊 + 音素诊断标题');
  assert(WXML.includes('美音') && WXML.includes('英音') && WXML.includes('原声') && WXML.includes('我'),
    '四对比胶囊（美/英/原声/我）');
  assert(WXML.includes('再试一次'), '再试一次按钮');
  assert(WXML.includes('<premium-modal') && WXML.includes('review_eval_quota') === false,
    'premium-modal 自持（source 动态绑定）');
  assert(JSON_CFG.usingComponents['premium-modal'], 'json 注册 premium-modal');
  assert(WXSS.includes('dashed') && WXSS.includes('--ec-secondary-50'),
    '锁定态：橙色虚线圆锁');
  assert(WXSS.includes('conic-gradient') && WXSS.includes('--ec-pct'),
    '得分环 conic-gradient 百分比');
  const methodCalls = WXML.match(/\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|toLowerCase|trim)\(/g);
  assert(!methodCalls, 'WXML 绑定零方法调用（' + (methodCalls ? methodCalls.join(' ; ') : '无') + '）');

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 语音评测卡 T3.2 测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
