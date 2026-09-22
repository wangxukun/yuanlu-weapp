/**
 * scripts/test-intensive-listening.js — 独立精听工作流页自动化测试（3.B.4）
 *
 * mock wx（BGM + request 路由 + Page/Component 捕获 + 假时钟），驱动：
 *   - utils/intensive-core 纯逻辑：findActiveIndex 增量定位（命中/前进/回退）、
 *     computeWordSweep 词级扫光三态（useWordHighlight 离散移植）、shouldLoopSeek 循环回跳守卫、
 *     buildDictation 去空格切块三态判定（correct/error/pending/标点恒对）、
 *     formatStartTime 补零、stripSpeaker；
 *   - 页面全链路：字幕渐进渲染 + 扩窗、活动句/词高亮 setData 差量、自动跟随
 *     scroll-into-view、单句循环越界回 seek、精听起播（audioBus 互停 +
 *     intensive 标记 + 签名直链回填免二次拉取）、听写（0.8 倍速/输入三态/
 *     全对自动跳句/错满 3 次提示词）、句子收藏（乐观翻转 + toast action 开
 *     完善抽屉 + 配额墙回滚）、点词查典（/api/dict + 暂停 + 已收藏态）与
 *     生词落库（/api/vocabulary/add 请求体）；
 *   - 组件：sentence-tag-drawer 预设/自定义标签与 meta 提交、
 *     vocabulary-modal 词源折叠与发音（InnerAudioContext）。
 *
 * 运行：node scripts/test-intensive-listening.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const bgmCalls = { src: null, rates: [], seeks: [], stops: 0, pauses: 0, plays: 0 };
const bgmHandlers = {};
const bgm = {
  currentTime: 0,
  duration: 300,
  play() { bgmCalls.plays += 1; bgmHandlers.play && bgmHandlers.play(); },
  pause() { bgmCalls.pauses += 1; bgmHandlers.pause && bgmHandlers.pause(); },
  stop() { bgmCalls.stops += 1; bgmHandlers.stop && bgmHandlers.stop(); },
  seek(t) { bgmCalls.seeks.push(t); },
  onPlay(cb) { bgmHandlers.play = cb; },
  onPause(cb) { bgmHandlers.pause = cb; },
  onStop(cb) { bgmHandlers.stop = cb; },
  onEnded(cb) { bgmHandlers.ended = cb; },
  onTimeUpdate(cb) { bgmHandlers.timeupdate = cb; },
  onCanplay(cb) { bgmHandlers.canplay = cb; },
  onWaiting(cb) { bgmHandlers.waiting = cb; },
  onError(cb) { bgmHandlers.error = cb; },
  onPrev(cb) { bgmHandlers.prev = cb; },
  onNext(cb) { bgmHandlers.next = cb; },
};
Object.defineProperties(bgm, {
  src: { get: () => bgmCalls.src, set: (v) => { bgmCalls.src = v; } },
  title: { set: () => {} },
  epname: { set: () => {} },
  singer: { set: () => {} },
  coverImgUrl: { set: () => {} },
  playbackRate: { set: (v) => { bgmCalls.rates.push(v); } },
});

const navCalls = [];
const navBackCalls = [];
const modalCalls = [];
const toastCalls = [];
const requestCalls = [];
let currentPages = [];

const innerAudios = [];
let routeHandler = null; // (path, method, data) => {statusCode, data}

global.wx = {
  getStorageSync: (k) => (k === 'token' ? 'test-token' : ''),
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => { toastCalls.push(o); },
  showModal: (o) => { modalCalls.push(o); },
  navigateTo: (o) => { navCalls.push(o.url); },
  getCurrentPages: () => currentPages,
  switchTab: (o) => { navCalls.push(o.url); },
  navigateBack: () => { navBackCalls.push(1); },
  stopPullDownRefresh: () => {},
  getWindowInfo: () => ({ statusBarHeight: 44 }),
  getMenuButtonBoundingClientRect: () => ({ top: 48, bottom: 80, height: 32 }),
  createInnerAudioContext: () => {
    const a = { src: '', play() { a.played = (a.played || 0) + 1; }, stop() {}, destroy() {} };
    innerAudios.push(a);
    return a;
  },
  request: (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    requestCalls.push({ path: p, method: opts.method || 'GET', data: opts.data || {} });
    const res = routeHandler
      ? routeHandler(p, opts.method || 'GET', opts.data || {})
      : { statusCode: 200, data: { success: true } };
    opts.success(res);
  },
  getBackgroundAudioManager: () => bgm,
};

let pageDef = null;
global.Page = (cfg) => { pageDef = cfg; };
const componentDefs = {};
global.Component = (cfg) => { componentDefs.__last = cfg; };

/* ==================== 夹具 ==================== */

const EPISODE = {
  episodeid: 'ep1',
  title: 'Free Coffee & Deep Work',
  audioUrl: '', // 空直链：验证 subtitles 回填
  coverUrl: 'https://oss/cover.jpg',
  podcastTitle: '远路英语',
};

const SUBS = [
  {
    id: 10, start: 0, end: 5, textEn: 'I like free coffee.',
    textCn: '我喜欢免费的咖啡。',
    words: [
      { word: 'I', start: 0, end: 0.4 },
      { word: 'like', start: 0.4, end: 0.9 },
      { word: 'free', start: 0.9, end: 1.5 },
      { word: 'coffee.', start: 1.5, end: 2.3 },
    ],
  },
  {
    id: 11, start: 5, end: 10, textEn: 'She said yes.',
    textCn: '[SPEAKER_1]: 她答应了。',
    words: [
      { word: 'She', start: 5, end: 5.4 },
      { word: 'said', start: 5.4, end: 5.9 },
      { word: 'yes.', start: 5.9, end: 6.5 },
    ],
  },
  {
    id: 12, start: 10, end: 15, textEn: 'Really? Free coffee!',
    textCn: '真的吗？免费的咖啡！',
    words: [
      { word: 'Really?', start: 10, end: 10.6 },
      { word: 'Free', start: 10.6, end: 11.1 },
      { word: 'coffee!', start: 11.1, end: 11.9 },
    ],
  },
];

const DICT_FREE = {
  word: 'free',
  phonetics: { uk: '/friː/', us: '/fri/' },
  audio_urls: { uk: 'https://voice/free-uk.mp3', us: 'https://voice/free-us.mp3' },
  definitions: [
    { pos: 'adj', meaning_cn: '免费的', meaning_en: 'costing nothing', cefr_level: 'A1' },
    { pos: 'adj', meaning_cn: '自由的', meaning_en: 'not confined', cefr_level: null },
  ],
  etymology: {
    prefix: null, root: 'free', suffix: null,
    breakdown: '古英语 frēo，意为「自由的、不受束缚的」。',
    mnemonic: 'free 自由 → 白拿 → 免费。',
  },
  examples: [
    { en: 'The coffee is free.', cn: '咖啡是免费的。', context: '' },
  ],
};

// 可配置的接口行为
let toggleResponse = { statusCode: 200, data: { success: true, saved: true, message: '已收藏', data: { saved: true, totalCount: 3, limit: 30, sentence: { id: 77, episodeid: 'ep1', subtitleId: 11, enText: 'She said yes.', zhText: '她答应了。', note: null, tags: ['地道表达'] } } } };
let vocabAddResponse = { statusCode: 200, data: { success: true } };

routeHandler = (p, method) => {
  if (p === '/api/episode/detail') return { statusCode: 200, data: EPISODE };
  if (p === '/api/episode/subtitles') return { statusCode: 200, data: { success: true, data: SUBS, audioUrl: 'https://oss/signed.m4a' } };
  if (p === '/api/sentences/keys') return { statusCode: 200, data: { success: true, data: { subtitleIds: [10], allTags: ['地道表达'] } } };
  if (p === '/api/vocabulary/words') return { statusCode: 200, data: { success: true, data: ['free'] } };
  if (p.indexOf('/api/dict/') === 0) return { statusCode: 200, data: { success: true, data: DICT_FREE } };
  if (p === '/api/user/profile') return { statusCode: 200, data: { User: { email: 'a@b.c' } } };
  if (p === '/api/vocabulary/add') return vocabAddResponse;
  if (p === '/api/sentences/toggle') return toggleResponse;
  if (p === '/api/sentences/meta') return { statusCode: 200, data: { success: true, message: '已保存', data: {} } };
  return { statusCode: 200, data: { success: true } };
};

/* ==================== 加载被测模块 ==================== */

const core = require(path.join(__dirname, '../utils/intensive-core'));

const audioManager = require(path.join(__dirname, '../utils/audioManager'));
audioManager.init();
const playerStore = require(path.join(__dirname, '../store/playerStore'));
const authStore = require(path.join(__dirname, '../store/authStore'));
const audioBus = require(path.join(__dirname, '../utils/audio-bus'));

let stopAllCalls = 0;
const origStopAll = audioBus.stopAll;
audioBus.stopAll = function () { stopAllCalls += 1; return origStopAll.apply(this, arguments); };

authStore.init(); // token 已在 storage → 登录态

require(path.join(__dirname, '../pages/intensive-listening/index')); // Page 捕获

require(path.join(__dirname, '../components/vocabulary-modal')); // 组件捕获（目录 index.js）
const vocabModalDef = componentDefs.__last;
require(path.join(__dirname, '../components/sentence-tag-drawer'));
const drawerDef = componentDefs.__last;

// 假时钟（循环回跳 500ms 守卫的确定化）
const realNow = Date.now;
let fakeNow = 1000000;
Date.now = () => fakeNow;

/* ==================== 工具函数 ==================== */

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}`); }
}

function section(title) { console.log(`\n━━━ ${title} ━━━`); }

const tick = () => new Promise((r) => setImmediate(r));

/** setData 路径补丁应用（viewList[3] / wordModal.visible） */
function applyPatch(data, key, value) {
  const m = key.match(/^(.*)\[(\d+)\]$/);
  if (m) {
    const parts = m[1].split('.');
    let obj = data;
    for (let i = 0; i < parts.length; i++) obj = obj[parts[i]];
    obj[Number(m[2])] = value;
    return;
  }
  const parts = key.split('.');
  let obj = data;
  for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
  obj[parts[parts.length - 1]] = value;
}

/** Page 定义 → 可驱动伪实例（顶层方法平铺 + setData 记录） */
function makePage() {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    options: {},
    setDataLog: [],
    setData(d) {
      inst.setDataLog.push(d);
      Object.keys(d).forEach((k) => applyPatch(inst.data, k, d[k]));
    },
  };
  Object.keys(pageDef).forEach((k) => {
    if (typeof pageDef[k] === 'function') inst[k] = pageDef[k].bind(inst);
  });
  return inst;
}

/** Component 定义 → 可驱动伪实例（properties 默认值反射 + observers/methods） */
function makeInstance(def, props) {
  const propDefaults = {};
  Object.keys(def.properties || {}).forEach((k) => {
    propDefaults[k] = def.properties[k].value;
  });
  const inst = {
    data: Object.assign(propDefaults, JSON.parse(JSON.stringify(def.data))),
    events: [],
    triggerEvent(name, detail) { inst.events.push({ name, detail }); },
    setData(d) { Object.keys(d).forEach((k) => applyPatch(inst.data, k, d[k])); },
  };
  Object.keys(def.methods || {}).forEach((k) => {
    inst[k] = def.methods[k].bind(inst);
  });
  if (def.observers) {
    inst._setProp = (key, value) => {
      inst.data[key] = value;
      const obs = def.observers[key];
      if (typeof obs === 'function') obs.call(inst, value);
    };
  }
  if (props) Object.keys(props).forEach((k) => { inst.data[k] = props[k]; });
  return inst;
}

/** 模拟播放推进：设 BGM 时间并触发 timeupdate（经 audioManager → playerStore → 页面订阅） */
function playbackAt(t) {
  bgm.currentTime = t;
  bgmHandlers.timeupdate();
}

const lastRequest = (p, method) => {
  const hits = requestCalls.filter((c) => c.path === p && (!method || c.method === method));
  return hits[hits.length - 1];
};

/* ==================== 一、纯逻辑：intensive-core ==================== */

section('intensive-core 纯逻辑');

assert(core.formatStartTime(9) === '00:09', 'formatStartTime 分钟补零（00:09）');
assert(core.formatStartTime(605) === '10:05', 'formatStartTime 10:05');
assert(core.stripSpeaker('[SPEAKER_2]: 你好') === '你好', 'stripSpeaker 去说话人标记');
assert(core.stripSpeaker(undefined) === '', 'stripSpeaker 空值兜底');

const subs = [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 15 }];
assert(core.findActiveIndex(subs, 1, 0) === 0, 'findActiveIndex：命中当前句保持');
assert(core.findActiveIndex(subs, 7, 0) === 1, 'findActiveIndex：前进扫描（1）');
assert(core.findActiveIndex(subs, 12, 0) === 2, 'findActiveIndex：前进跨句（2）');
assert(core.findActiveIndex(subs, 2, 1) === 0, 'findActiveIndex：回退全局查找');
assert(core.findActiveIndex(subs, 5.5, -1) === 1, 'findActiveIndex：无起点全局查找');
assert(core.findActiveIndex(subs, 100, 0) === -1, 'findActiveIndex：越界 -1');

const words = [{ word: 'a', start: 0, end: 1 }, { word: 'b', start: 1, end: 2 }];
// 词级扫光三态（useWordHighlight 离散移植）：{idx, on} 两标量
const sweepWords = [
  { word: 'aa', start: 0, end: 1 },
  { word: 'bb', start: 3, end: 4 }, // aa→bb 间 2s 间隙
  { word: 'cc', start: 5, end: 6 },
];
const sw0 = core.computeWordSweep(sweepWords, 0.5, 0, 8);
assert(sw0.idx === 0 && sw0.on === true, 'computeWordSweep：词窗命中 → 当前词点亮');
const swGap1 = core.computeWordSweep(sweepWords, 1.5, 0, 8);
assert(swGap1.idx === 0 && swGap1.on === true, 'computeWordSweep：间隙前半程 → 光斑驻留 prev');
const swGap2 = core.computeWordSweep(sweepWords, 2.2, 0, 8);
assert(swGap2.idx === 1 && swGap2.on === true, 'computeWordSweep：间隙后半程 → 光斑切到 next');
const swHalf = core.computeWordSweep(sweepWords, 4.5, 0, 8);
assert(swHalf.idx === 2 && swHalf.on === true, 'computeWordSweep：p=0.5 半程归属 next');
const swTail = core.computeWordSweep(sweepWords, 6.5, 0, 8);
assert(swTail.idx === 3 && swTail.on === false, 'computeWordSweep：尾词后间隙 → 全部已读无光斑（idx=len）');
const swEnd = core.computeWordSweep(sweepWords, 8.5, 0, 8);
assert(swEnd.idx === 3 && swEnd.on === false, 'computeWordSweep：整句读完 → 全部已读（Web: applyReadColor 1）');
const swBefore = core.computeWordSweep(sweepWords, -0.5, 0, 8);
assert(swBefore.idx === -1 && swBefore.on === false, 'computeWordSweep：句首前 → 全部未读');
const swHeadGap = core.computeWordSweep([{ word: 'x', start: 2, end: 3 }], 1, 0, 4);
assert(swHeadGap.idx === -1 && swHeadGap.on === false, 'computeWordSweep：首词前间隙 → 全部未读（prev=-1）');
const swEmpty = core.computeWordSweep(null, 1, 0, 4);
assert(swEmpty.idx === -1 && swEmpty.on === false, 'computeWordSweep：空词表兜底');

assert(core.shouldLoopSeek(10.2, subs[1], 0, 10000) === true, 'shouldLoopSeek：越过句尾丧行出保护窗');
assert(core.shouldLoopSeek(10.2, subs[1], 9800, 10000) === false, 'shouldLoopSeek：500ms 保护窗内不回跳');
assert(core.shouldLoopSeek(9.5, subs[1], 0, 10000) === false, 'shouldLoopSeek：句内不回跳');

// 听写：空输入 → 全 pending（纯标点恒 correct）
let d = core.buildDictation('She said yes.', '');
assert(d.targetWords.length === 3, 'buildDictation：目标词切分');
assert(d.slots[0].status === 'pending' && d.slots[2].punct === false, 'buildDictation：空输入 pending');
// 注意：'yes.' 含字母，clean 非空 → 非纯标点
d = core.buildDictation('I like free coffee.', 'ilikefreecoffee');
assert(d.isCorrect === true, 'buildDictation：全对（去空格切块逐词全等）');
assert(d.slots[3].target === 'coffee.' && d.slots[3].status === 'correct', 'buildDictation：标点随词全等 correct');
// 前缀 pending
d = core.buildDictation('She said yes.', 'sh');
assert(d.slots[0].status === 'pending', 'buildDictation：前缀匹配 pending');
assert(d.isCorrect === false, 'buildDictation：未完成不计全对');
// 错误（同长不匹配）
d = core.buildDictation('She said yes.', 'xhesai');
assert(d.slots[0].status === 'error', 'buildDictation：同长不匹配 error');
// 前缀不匹配 error
d = core.buildDictation('She said yes.', 'xe');
assert(d.slots[0].status === 'error', 'buildDictation：前缀不匹配 error');
// 纯标点 token 恒 correct
d = core.buildDictation('Oh , really', 'oh');
assert(d.slots[1].status === 'correct' && d.slots[1].punct === true, 'buildDictation：纯标点 token 恒 correct');
// 大小写不敏感
d = core.buildDictation('She', 'SHE');
assert(d.slots[0].status === 'correct', 'buildDictation：大小写不敏感');

/* ==================== 二、页面：加载 / 起播 / 字幕流 ==================== */

(async () => {

section('页面：加载 · 精听起播 · 渐进渲染');

const page = makePage();
page.onLoad({ id: 'ep1' });
await tick(); await tick(); await tick(); await tick();

assert(page.data.isLoading === false && page.data.error === null, 'onLoad → 详情+字幕双请求就绪');
assert(page.data.viewList.length === 3, '字幕视图模型建立（3 句）');
assert(page.data.viewList[1].tsLabel === '00:05', '视图模型 tsLabel 预格式化（00:05）');
assert(page.data.viewList[1].zhClean === '她答应了。', 'zhClean 去说话人标记');
assert(page.data.episode.audioUrl === 'https://oss/signed.m4a', 'subtitles 签名直链回填剧集对象');

// 精听起播：互停 + intensive 标记 + 直链复用（无二次 subtitles 拉取）
assert(stopAllCalls >= 1, '起播前 audioBus.stopAll 互停');
assert(audioManager.getState().currentEpisode.episodeid === 'ep1', '全局播放器切到本集');
assert(audioManager.getState().isIntensiveMode === true, '精听起播 → intensive 标记置位');
assert(bgmCalls.src === 'https://oss/signed.m4a', 'BGM 使用回填直链（免二次拉取）');
assert(requestCalls.filter((c) => c.path === '/api/episode/subtitles').length === 1, 'subtitles 仅请求一次');

await tick(); await tick();
assert(page.data.savedMap[10] === true, 'sentences/keys → 书签态回填（句 10 已收藏）');
assert(page.data.isLoggedIn === true, '登录态同步');

section('页面：活动句 / 词扫光 / 自动跟随');

// playEpisode 后 isPlaying=true（mock BGM 未触发 onPlay，手动补一帧）
bgmHandlers.play();
playbackAt(1.2); // 句 0 内，词 'free'（0.9-1.5）
await tick();
assert(page.data.isPlayingHere === true && page.data.isPlaying === true, 'isPlayingHere/isPlaying 派生态');
assert(page.data.activeIndex === 0, 'timeupdate → 活动句 0');
assert(page.data.activeWordIndex === 2 && page.data.wordSweepOn === true, '词窗扫光 → 当前词 free（idx=2 光斑点亮）');
assert(page.data.scrollIntoView === 'sub-10', '自动跟随 → scroll-into-view 锚点 sub-10');

playbackAt(0.2);
await tick();
assert(page.data.activeWordIndex === 0 && page.data.wordSweepOn === true, '回跳句首 → 扫光到词 0（光斑点亮）');

// 尾词后间隙（coffee. 止于 2.3，句 0 至 5s）：全部已读、无光斑
playbackAt(3.0);
await tick();
assert(page.data.activeWordIndex === 4 && page.data.wordSweepOn === false, '尾词后间隙 → idx=len 全已读、光斑熄灭');

playbackAt(6.2);
await tick();
assert(page.data.activeIndex === 1, '推进 → 活动句 1');
assert(page.data.scrollIntoView === 'sub-11', '跟随锚点更新 sub-11');
assert(page.data.activeWordIndex === 2 && page.data.wordSweepOn === true, '句 1 词扫光（yes. 词窗 5.9-6.5）');

section('页面：单句循环（越界回 seek）');

bgmCalls.seeks.length = 0;
page.onToggleLoop({ currentTarget: { dataset: { index: 1 } } });
await tick();
assert(page.data.loopIndex === 1, '循环按钮 → loopIndex=1');
assert(bgmCalls.seeks[0] === 5, '开启循环 → 立即 seek 句首');

fakeNow += 1000; // 出保护窗
playbackAt(10.3); // 越过句 1 句尾
await tick();
assert(bgmCalls.seeks[1] === 5, '越过句尾 → 回 seek 句首（500ms 守卫放行）');

fakeNow += 100;
playbackAt(10.6);
await tick();
assert(bgmCalls.seeks.length === 2, '保护窗内不重复回跳');

page.onToggleLoop({ currentTarget: { dataset: { index: 1 } } });
assert(page.data.loopIndex === -1, '再点循环 → 取消');
fakeNow += 1000;
bgmCalls.seeks.length = 0;
playbackAt(10.8);
await tick();
assert(bgmCalls.seeks.length === 0, '取消循环后自然推进不回跳');

section('页面：句子收藏（乐观 + toast + 抽屉 + 配额墙）');

// 收藏句 2（id 12，未收藏 → toggle 返回 saved:true）
page.onToggleSave({ currentTarget: { dataset: { index: 2 } } });
await tick(); await tick();
const toggleReq = lastRequest('/api/sentences/toggle', 'POST');
assert(!!toggleReq, '收藏 → POST /api/sentences/toggle');
assert(toggleReq.data.episodeid === 'ep1' && toggleReq.data.subtitleId === 12, 'toggle 请求体 episodeid/subtitleId');
assert(toggleReq.data.enText === 'Really? Free coffee!' && toggleReq.data.zhText === '真的吗？免费的咖啡！', 'toggle 请求体 enText/zhText（已去说话人标记）');
assert(page.data.savedMap[12] && page.data.savedMap[12].id === 77, '收藏成功 → 书签态写入（响应实体）');
assert(page.data.toast && page.data.toast.type === 'saved', '收藏成功 → toast saved');
assert(page.data.toast.quote === 'Really? Free coffee!', 'toast 引文截断（slice 32）');
assert(typeof page.data.toast.sentence.id === 'number', 'toast 携带 SavedSentenceItem（action 开抽屉用）');

page.onToastAction();
assert(page.data.toast === null && page.data.drawerSentence.id === 77, 'toast action → 打开完善抽屉');
page.onDrawerClose();
assert(page.data.drawerSentence === null, '抽屉关闭');

// 取消收藏
toggleResponse = { statusCode: 200, data: { success: true, message: '已移除', data: { saved: false, sentence: null } } };
page.onToggleSave({ currentTarget: { dataset: { index: 2 } } });
await tick(); await tick();
assert(!page.data.savedMap[12], 'toggle saved:false → 移除书签态');
assert(page.data.toast && page.data.toast.type === 'removed', '移除 → toast removed');

// 配额墙：乐观翻转 → 403 回滚 + 会员弹窗
toggleResponse = { statusCode: 403, data: { success: false, code: 'SENTENCE_QUOTA_EXCEEDED', message: '满了', data: { totalCount: 30, limit: 30 } } };
page.onToggleSave({ currentTarget: { dataset: { index: 2 } } });
await tick(); await tick();
assert(!page.data.savedMap[12], '配额 403 → 乐观态回滚');
assert(page.data.showPremiumModal === true && page.data.premiumSource === 'sentence_quota', '配额 403 → sentence_quota 会员弹窗');
page.onPremiumClose();

// 未登录门禁
modalCalls.length = 0;
page.setData({ isLoggedIn: false });
page.onToggleSave({ currentTarget: { dataset: { index: 2 } } });
assert(modalCalls.length === 1 && modalCalls[0].confirmText === '去登录', '未登录收藏 → 登录引导弹窗');
page.setData({ isLoggedIn: true });

section('页面：点词查典 + 生词落库');

bgmCalls.pauses = 0;
page.onWordTap({ currentTarget: { dataset: { index: 0, wi: 2 } } }); // 'free'
await tick(); await tick();
assert(bgmCalls.pauses === 1, '点词 → 暂停播放（对齐 Web handleWordClick）');
assert(page.data.wordModal.visible === true && page.data.wordModal.word === 'free', '生词弹窗打开');
assert(page.data.wordModal.isSaved === true, 'words 列表含 free → isSaved 预置');
assert(page.data.wordModal.dictData && page.data.wordModal.dictData.definitions.length === 2, '词典数据（/api/dict）载入');
assert(page.data.wordModal.loading === false, 'loading 复位');

vocabAddResponse = { statusCode: 200, data: { success: true } };
page.onVocabSave();
await tick(); await tick();
const vocabReq = lastRequest('/api/vocabulary/add', 'POST');
assert(!!vocabReq, '保存生词 → POST /api/vocabulary/add');
assert(vocabReq.data.word === 'free' && vocabReq.data.episodeid === 'ep1', 'add 请求体 word/episodeid');
assert(vocabReq.data.definition.indexOf('[adj] 免费') >= 0, 'add 请求体 definition（词性拼接）');
assert(vocabReq.data.contextSentence === 'I like free coffee.', 'add 请求体 contextSentence');
assert(vocabReq.data.speakUrl === 'https://voice/free-us.mp3', 'add 请求体 speakUrl（US 音源）');
assert(page.data.wordModal.isSaved === true && page.data.wordModal.visible === false, '保存成功 → isSaved + 关闭弹窗');
assert(toastCalls.some((t) => t.title === '已加入生词本'), '保存成功 → 「已加入生词本」toast');

// 生词配额墙
vocabAddResponse = { statusCode: 403, data: { success: false, code: 'VOCABULARY_QUOTA_EXCEEDED', message: '满了' } };
page.setData({ 'wordModal.visible': true, 'wordModal.isSaved': false });
page.onVocabSave();
await tick(); await tick();
assert(page.data.showPremiumModal === true && page.data.premiumSource === 'vocabulary_total', '生词总量配额 → vocabulary_total 弹窗');
page.onPremiumClose();

vocabAddResponse = { statusCode: 403, data: { success: false, code: 'VOCABULARY_DAILY_QUOTA_EXCEEDED', message: '今日满' } };
page.setData({ 'wordModal.visible': true, 'wordModal.isSaved': false });
page.onVocabSave();
await tick(); await tick();
assert(page.data.premiumSource === 'vocabulary_daily', '生词每日配额 → vocabulary_daily 弹窗');
page.onPremiumClose();

section('页面：听写模式（0.8 倍速 / 三态 / 自动跳句 / 提示词）');

bgmCalls.rates.length = 0;
page.onSwitchMode({ currentTarget: { dataset: { mode: 'dictate' } } });
assert(page.data.mode === 'dictate', '切换听写 Tab');
assert(bgmCalls.rates[bgmCalls.rates.length - 1] === 0.8, '听写 → 0.8 倍速');

bgmHandlers.play(); // wordTap 曾暂停，恢复播放后进入听写流
playbackAt(5.2); // 回到句 1
await tick();
assert(page.data.activeIndex === 1, '听写活动句 = 播放句');
assert(page.data.dictSlots.length === 3 && page.data.dictSlots.every((s) => s.status === 'pending'), '听写句重置 → 全 pending 槽');

// 前缀输入 pending
page.onDictInput({ detail: { value: 'sh' } });
assert(page.data.dictSlots[0].status === 'pending' && page.data.dictSlots[0].input === 'sh', '前缀输入 → pending 显示输入');

// 错误 → 回车累计 → 第 3 次开提示词
page.onDictInput({ detail: { value: 'xhesaidyes' } });
assert(page.data.dictSlots[0].status === 'error', '同长不匹配 → error');
page.onDictConfirm();
page.onDictInput({ detail: { value: 'xhesaidyes' } });
page.onDictConfirm();
page.onDictInput({ detail: { value: 'xhesaidyes' } });
page.onDictConfirm();
assert(page.data.dictHint === true, '错满 3 次 → 提示词开启');
assert(page.data.dictSlots.some((s) => s.hint), '槽位带提示词标记');

// 改对 → 全对自动跳下一句（seek 句 2 起点）
bgmCalls.seeks.length = 0;
page.onDictInput({ detail: { value: 'shesaidyes' } });
assert(page.data.dictSlots.every((s) => s.status === 'correct'), '改对 → 全槽 correct');
assert(bgmCalls.seeks[0] === 10, '全对 → 自动 seek 下一句起点');
await tick();
playbackAt(10.2);
await tick();
assert(page.data.activeIndex === 2, '跳句后听写卡跟随到句 2');
assert(page.data.dictSlots.every((s) => s.status === 'pending'), '新听写句输入重置');

// 听写模式循环锁活动句：越过句 2 句尾回句首
fakeNow += 1000;
bgmCalls.seeks.length = 0;
playbackAt(15.2);
await tick();
assert(bgmCalls.seeks[0] === 10, '听写模式：越过活动句尾 → 自动回句首（loopTarget=activeIndex）');

bgmCalls.rates.length = 0;
page.onSwitchMode({ currentTarget: { dataset: { mode: 'read' } } });
assert(bgmCalls.rates[bgmCalls.rates.length - 1] === 1.0, '回精读 → 恢复 1.0 倍速');

section('页面：渐进渲染扩窗');

// 100 句长字幕 → 首屏 40，活动句推进到 33+ 扩窗
const LONG_SUBS = [];
for (let i = 0; i < 100; i++) {
  LONG_SUBS.push({
    id: 1000 + i, start: i * 5, end: i * 5 + 5,
    textEn: 'Sentence number ' + i + ' here.', textCn: '第 ' + i + ' 句',
    words: [{ word: 'Sentence', start: i * 5, end: i * 5 + 1 }, { word: 'number', start: i * 5 + 1, end: i * 5 + 2 }],
  });
}
routeHandler = (p) => {
  if (p === '/api/episode/subtitles') return { statusCode: 200, data: { success: true, data: LONG_SUBS, audioUrl: 'https://oss/long.m4a' } };
  if (p === '/api/episode/detail') return { statusCode: 200, data: Object.assign({}, EPISODE, { episodeid: 'epLong' }) };
  if (p === '/api/sentences/keys') return { statusCode: 200, data: { success: true, data: { subtitleIds: [], allTags: [] } } };
  if (p === '/api/vocabulary/words') return { statusCode: 200, data: { success: true, data: [] } };
  if (p === '/api/user/profile') return { statusCode: 200, data: { User: {} } };
  return { statusCode: 200, data: { success: true } };
};

const page2 = makePage();
page2.onLoad({ id: 'epLong' });
await tick(); await tick(); await tick(); await tick();
assert(page2.data.viewList.length === 40, '长字幕首屏渲染 40 句');

playbackAt(29 * 5 + 1); // 活动句 29（距 40 底缘 11 ≤ 阈值 12）→ 扩窗
await tick();
assert(page2.data.viewList.length === 70, '活动句逼近底缘 → 扩窗 +30（40→70）');
assert(page2.data.activeIndex === 29, '扩窗不影响活动句');

page2.onScrollLower();
assert(page2.data.viewList.length === 100, '手动滚到底 → 再补一窗至全量');

/* ==================== 三、组件：完善抽屉 / 生词弹窗 ==================== */

section('组件：sentence-tag-drawer');

const drawer = makeInstance(drawerDef);
drawer._setProp('sentence', { id: 77, enText: 'She said yes.', zhText: '她答应了。', note: '', tags: [] });
assert(drawer.data.selectedTags.join() === '地道表达', '无标签句 → 默认「地道表达」');
assert(drawer.data.presets.length === 7, '预设标签 7 枚（对齐 Web PRESET_SENTENCE_TAGS）');

drawer.onToggleTag({ currentTarget: { dataset: { tag: '长难句' } } });
assert(drawer.data.selectedTags.indexOf('长难句') >= 0, '点预设 → 多选加入');
drawer.setData({ customTagInput: '虚拟语气' });
drawer.onConfirmAddTag();
assert(drawer.data.selectedTags.indexOf('虚拟语气') >= 0, '自定义标签加入');
assert(drawer.data.customTags.join() === '虚拟语气', '自定义标签归组渲染');

requestCalls.length = 0;
await drawer.onSave();
const metaReq = lastRequest('/api/sentences/meta', 'POST');
assert(!!metaReq && metaReq.data.id === 77, '保存 → POST /api/sentences/meta（id）');
assert(metaReq.data.tags.indexOf('虚拟语气') >= 0 && metaReq.data.tags.indexOf('地道表达') >= 0, 'meta 请求体 tags（含自定义）');
assert(metaReq.data.note === null, '空笔记 → null');
assert(drawer.events.some((e) => e.name === 'updated' && e.detail.id === 77), 'updated 事件回传 id/tags');
assert(drawer.events.some((e) => e.name === 'close'), '保存成功 → close 事件');

section('组件：vocabulary-modal');

const vm = makeInstance(vocabModalDef);
vm._setProp('word', 'free');
assert(vm.data.etyOpen === false, '新词 → 词源面板重置收缩');
vm.onToggleEty();
assert(vm.data.etyOpen === true, '点击词源头 → 展开');

vm.onPlayAudio({ currentTarget: { dataset: { url: 'https://voice/free-us.mp3' } } });
assert(innerAudios.length === 1 && innerAudios[0].src === 'https://voice/free-us.mp3' && innerAudios[0].played === 1, '发音按钮 → InnerAudioContext 播放 US 音源');
vm.onPlayAudio({ currentTarget: { dataset: { url: 'https://voice/free-uk.mp3' } } });
assert(innerAudios.length === 1 && innerAudios[0].src === 'https://voice/free-uk.mp3', '复用同一音频实例切换音源');

vm.onClose();
assert(vm.events.some((e) => e.name === 'close'), '关闭 → close 事件');
vm.onComplete();
assert(vm.events.some((e) => e.name === 'complete'), '完成学习 → complete 事件');

/* ==================== 四、四 Bug 修复回归 ==================== */

section('四 Bug 修复回归（底部条联动 / 关闭钮删除 / 安全区 / 换行）');

// —— Bug 1：底部迷你条挂载 + 「关闭音频」联动退栈 ——
const pageWxml = fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/index.wxml'), 'utf8');
const pageWxss = fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/index.wxss'), 'utf8');
const pageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/index.json'), 'utf8'));
assert(pageWxml.indexOf('<mini-player') >= 0 && !!pageJson.usingComponents['mini-player'], 'Bug1：页面挂载底部迷你播放条（含组件注册）');

// page2 正在播 epLong（isPlayingHere=true）→ 模拟迷你条 ×：audioManager.close()
navBackCalls.length = 0;
assert(page2.data.isPlayingHere === true, 'Bug1 前置：page2 处于本集在播态');
audioManager.close();
await tick(); await tick();
assert(navBackCalls.length === 1, 'Bug1：关闭音频（close 清空会话）→ navigateBack 恰好一次（episodeChange+stop 双事件防重）');
assert(audioManager.getState().hasEpisode === false, 'Bug1：会话确已清空（hasEpisode=false）');

// —— Bug 2：右上角关闭钮删除（仅剩左 chevron + 隐形占位维持 Tab 居中） ——
assert((pageWxml.match(/il-icon-btn tap-scale/g) || []).length === 1, 'Bug2：header 仅保留左 chevron 一个可点按钮');
assert(pageWxml.indexOf('il-icon-btn--ghost') >= 0, 'Bug2：右侧隐形占位维持 Tab 居中');

// —— Bug 4：词间显式空格（行断点）+ break-word 换行 ——
assert(pageWxml.indexOf('{{w.word}} </text>') >= 0, 'Bug4：词文本尾部显式空格（相邻 text 间恢复软换行点）');
assert(pageWxss.indexOf('word-break: break-word') >= 0 && pageWxss.indexOf('overflow-wrap: break-word') >= 0, 'Bug4：字幕/听写容器 break-word + overflow-wrap');

// —— Bug 3：弹窗顶部安全区（胶囊下缘优先 / statusBar+48 兜底） ——
const vmSafe = makeInstance(vocabModalDef);
assert(vmSafe._calcHeaderSafeTop() === 80 + 8, 'Bug3：胶囊下缘 80px → 安全区 88px');
const menuFn = global.wx.getMenuButtonBoundingClientRect;
delete global.wx.getMenuButtonBoundingClientRect;
assert(vmSafe._calcHeaderSafeTop() === 44 + 48, 'Bug3：无胶囊 API → statusBar 44 + 48 兜底');
global.wx.getMenuButtonBoundingClientRect = menuFn;

/* ==================== 五、扫光三态与字重走查（精读2 截图） ==================== */

section('扫光三态渲染与活动句字重（useWordHighlight 对齐）');

const wxsSrc = fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/intensive.wxs'), 'utf8');
// 三态视图层映射：past / cur / 未读回落
assert(wxsSrc.indexOf('w--past') >= 0 && wxsSrc.indexOf('w--cur') >= 0, 'WXS：三态 class 映射（w--past / w--cur / w）');
assert(pageWxml.indexOf('wordSweepOn)') >= 0, 'WXML：wordSweepOn 透传 WXS');
// 色值对齐 Web 端 ACCENT_BG_LIGHT #FAE5C6 / READ_TEXT_LIGHT #96580D（走设计令牌）
assert(pageWxss.indexOf('.w--past') >= 0 && pageWxss.indexOf('var(--accent-700)') >= 0, 'WXSS：已读词 accent-700 棕字（#96580D）');
assert(pageWxss.indexOf('.w--cur') >= 0 && pageWxss.indexOf('var(--accent-100)') >= 0, 'WXSS：当前词 accent-100 底光斑（#FAE5C6）');
// 活动句取消加粗：.sub--active .sub-text 块内不得再有 font-weight
const activeBlock = pageWxss.slice(
  pageWxss.indexOf('.sub--active .sub-text'),
  pageWxss.indexOf('}', pageWxss.indexOf('.sub--active .sub-text'))
);
assert(activeBlock.indexOf('font-weight') === -1, 'WXSS：活动句恢复正常字重（移除 font-weight:700）');
assert(pageWxss.indexOf('.w--on') === -1, 'WXSS：旧单态 .w--on 已退役');

/* ==================== 六、收藏成功 toast 富色主题（sonner richColors） ==================== */

section('收藏成功 toast 富色主题（对齐 Web <Toaster richColors /> success）');

// WXML：左对钩图标（仅 saved 态渲染）+ 富色主题 class
assert(pageWxml.indexOf('check-circle-success.svg') >= 0 && pageWxml.indexOf('il-toast-icon') >= 0, 'toast：左侧对钩状态图标引入');
assert(pageWxml.indexOf('il-toast--saved') >= 0 && pageWxml.indexOf('il-toast--plain') >= 0, 'toast：saved 富色 / removed 中性双主题分流');
assert(pageWxml.indexOf('<image wx:if="{{toast.type === \'saved\'}}" class="il-toast-icon"') >= 0, 'toast：图标仅收藏成功态渲染（removed 无图标）');
// WXSS：sonner richColors success 原值（hsl143/85%/96%≈#ECFDF3 底、hsl145/92%/87%≈#BFFCD9 边、hsl140/100%/27%≈#008A2E 字）
assert(pageWxss.indexOf('#ecfdf3') >= 0 && pageWxss.indexOf('#bffcd9') >= 0, 'toast：浅绿底 + 浅绿细边（sonner 原值）');
assert(pageWxss.indexOf('#008a2e') >= 0, 'toast：标题转 success 绿字');
assert(pageWxss.indexOf('0 8rpx 24rpx rgba(27, 24, 18, 0.08)') >= 0, 'toast：轻微阴影（≈shadow-sm）');
const iconCss = pageWxss.slice(pageWxss.indexOf('.il-toast-icon'), pageWxss.indexOf('}', pageWxss.indexOf('.il-toast-icon')));
assert(iconCss.indexOf('flex-shrink: 0') >= 0, 'toast：图标 flex-shrink 0（文案挤压时不缩）');

/* ==================== 七、标签胶囊流式布局（完善句子本收藏） ==================== */

section('标签胶囊流式布局（std-tags 独占一行修复）');

const drawerWxss = fs.readFileSync(path.join(__dirname, '../components/sentence-tag-drawer/index.wxss'), 'utf8');
const vmWxss = fs.readFileSync(path.join(__dirname, '../components/vocabulary-modal/index.wxss'), 'utf8');
// 根因：app.wxss 的 .wrap 只含 flex-wrap，容器必须自带 display:flex
const tagsBlock = drawerWxss.slice(drawerWxss.indexOf('.std-tags'), drawerWxss.indexOf('}', drawerWxss.indexOf('.std-tags')));
assert(tagsBlock.indexOf('display: flex') >= 0 && tagsBlock.indexOf('flex-wrap: wrap') >= 0, '标签容器：flex + wrap 流式换行（修复纵向独占一行）');
const tagBlock = drawerWxss.slice(drawerWxss.indexOf('.std-tag {'), drawerWxss.indexOf('}', drawerWxss.indexOf('.std-tag {')));
assert(tagBlock.indexOf('#f3f4f6') >= 0 && tagBlock.indexOf('#4b5563') >= 0, '未选中胶囊：gray-100/gray-600（QuickTagDrawer 原值）');
assert(drawerWxss.indexOf('.std-tag--on') >= 0 && drawerWxss.indexOf('background: var(--primary-600)') >= 0, '选中胶囊：primary-600 实底白字');
assert(drawerWxss.indexOf('.std-tag--add') >= 0 && drawerWxss.indexOf('dashed') >= 0, '自定义胶囊：灰色虚线边框');
assert(tagBlock.indexOf('flex-shrink: 0') >= 0, '胶囊单体 flex-shrink 0（行内不压缩变形）');
// 同根因联动修复：生词弹窗词源 chips
const chipsBlock = vmWxss.slice(vmWxss.indexOf('.vm-ety-chips'), vmWxss.indexOf('}', vmWxss.indexOf('.vm-ety-chips')));
assert(chipsBlock.indexOf('display: flex') >= 0 && chipsBlock.indexOf('flex-wrap: wrap') >= 0, '词源 chips：同根因 flex-wrap 联动修复');

/* ==================== 八、抽屉标签选中态渲染（WXML 表达式不支持方法调用） ==================== */

section('抽屉标签选中态渲染（indexOf 绑定恒假修复）');

// 纯函数：tag.wxs has()（Node 按 JS 加载 .wxs，直接单测）
const tagWxs = require(path.join(__dirname, '../components/sentence-tag-drawer/tag.wxs'));
assert(tagWxs.has(['地道表达', '长难句'], '地道表达') === 'std-tag--on', 'tag.has：命中已选 → std-tag--on');
assert(tagWxs.has(['地道表达'], '长难句') === '', 'tag.has：未选 → 空串');
assert(tagWxs.has(null, '地道表达') === '', 'tag.has：空数组兜底');

// 结构：绑定必须走 WXS，不再有 indexOf 方法调用（WXML 表达式不支持，恒为假）
const drawerWxml = fs.readFileSync(path.join(__dirname, '../components/sentence-tag-drawer/index.wxml'), 'utf8');
assert(drawerWxml.indexOf('tag.has(selectedTags, item)') >= 0, 'WXML：选中态经 tag.wxs 求值');
assert(drawerWxml.indexOf('<wxs src="./tag.wxs" module="tag" />') >= 0, 'WXML：引入 tag.wxs 模块');
assert(drawerWxml.indexOf('selectedTags.indexOf(item)') === -1, 'WXML：原 indexOf 绑定已清除（该写法在 WXML 恒为假）');
// 全工程新页面/组件无方法调用绑定（防再踩）
const wxmlFiles = [
  '../pages/intensive-listening/index.wxml',
  '../components/vocabulary-modal/index.wxml',
  '../components/sentence-tag-drawer/index.wxml',
];
const methodCall = wxmlFiles.map((p) => fs.readFileSync(path.join(__dirname, p), 'utf8'))
  .filter((t) => /\{\{[^}]*\.(indexOf|includes|map|filter|slice|join)\(/.test(t));
assert(methodCall.length === 0, '全组件 WXML：绑定表达式零方法调用（indexOf/includes/map/filter/slice/join）');

/* ==================== 汇总 ==================== */

console.log('\n────────────────────────');
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 断言`);
} else {
  console.log(`❌ 失败 ${failed} / ${passed + failed}：`);
  failures.forEach((n) => console.log('   - ' + n));
  Date.now = realNow;
  process.exit(1);
}
Date.now = realNow;

})();
