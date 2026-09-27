/**
 * scripts/test-sentence-notebook.js — 句子本复刻自动化测试
 * （REVIEW-TASK 阶段 2：T2.1 数据接入与生词高亮联动 + T2.2 统计/配额/搜索筛选）
 *
 * 三层驱动（test-vocab-notebook 同款测试法）：
 *   1. utils/sentence-core.js 纯逻辑（linked-vocab 词边界交集 /
 *      VocabularyHighlighter 高亮分词 / 四路搜索筛选 / tagCloud 计数 /
 *      评测配额封顶 / 容量文案逐字）——直接 require 断言；
 *   2. components/review/sentence-notebook——Component 定义捕获 +
 *      makeInstance 驱动：active 懒加载 / 三路并发拉取 / 子请求降级
 *      （vocab 失败不拖垮主列表）/ refreshSeq 轻刷新 / 空态引导 /
 *      T2.2 筛选交互（搜索/标签/剧集 picker/清除/失效回落/视图切换图标）/ 横幅跳转；
 *   3. WXML/WXSS 结构断言：统计三格与空态文案逐字、quota-card 双栏 props、
 *      横幅文案逐字、高亮 mark 色值（Web highlightClassName 原值）、
 *      WXML 绑定零方法调用红线。
 *
 * 运行：node scripts/test-sentence-notebook.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toastCalls = [];
const switchTabCalls = [];
const navCalls = [];
const requestLog = []; // { path, method }
const modalCalls = [];
const audioInstances = []; // InnerAudioContext mock 实例（可手动驱动事件）

// 可编程的接口响应表：path → body（或 fn(data) → body）
const apiResponses = {};

function resolveRequest(opts) {
  const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestLog.push({ path: p, method: opts.method || 'GET', data: opts.data });
  const hit = apiResponses[p];
  const body = typeof hit === 'function' ? hit(opts.data) : hit;
  if (body === undefined) {
    opts.success({ statusCode: 200, data: { success: true, data: [] } });
  } else if (body instanceof Error) {
    opts.fail && opts.fail({ errMsg: body.message });
  } else {
    opts.success({ statusCode: 200, data: body });
  }
}

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: (o) => {
    modalCalls.push(o);
    o.success && o.success({ confirm: global.__modalConfirm !== false });
  },
  navigateTo: (o) => navCalls.push(o.url),
  navigateBack: () => {},
  switchTab: (o) => switchTabCalls.push(o.url),
  request: resolveRequest,
  // InnerAudioContext mock：事件可手动触发、seek 记录、currentTime 可写
  createInnerAudioContext() {
    const handlers = {};
    const ctx = {
      src: '',
      currentTime: 0,
      played: 0,
      stopped: 0,
      destroyed: false,
      seeks: [],
      seek(t) { this.seeks.push(t); },
      play() { this.played += 1; },
      stop() { this.stopped += 1; },
      destroy() { this.destroyed = true; },
      onEnded(cb) { handlers.ended = cb; },
      onError(cb) { handlers.error = cb; },
      onCanplay(cb) { handlers.canplay = cb; },
      onTimeUpdate(cb) { handlers.timeupdate = cb; },
      offEnded() { delete handlers.ended; },
      offError() { delete handlers.error; },
      offCanplay() { delete handlers.canplay; },
      offTimeUpdate() { delete handlers.timeupdate; },
      __fire(event) { handlers[event] && handlers[event](); },
    };
    audioInstances.push(ctx);
    return ctx;
  },
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 20 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 20, theme: 'light' }),
};
global.__modalConfirm = true;

// Component / Page 定义捕获
const componentDefs = {};
global.Component = (cfg) => { componentDefs.__last = cfg; };
global.Page = (cfg) => { componentDefs.__page = cfg; };

/* ==================== 断言工具 ==================== */

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

/** 由 Component 定义构造可驱动的伪实例（绑定 lifetimes/methods/observers） */
function makeInstance(def) {
  const propDefaults = {};
  Object.keys(def.properties || {}).forEach((k) => {
    propDefaults[k] = def.properties[k].value;
  });
  const inst = {
    data: Object.assign(propDefaults, JSON.parse(JSON.stringify(def.data))),
    setData(patch, cb) {
      Object.assign(this.data, patch);
      if (cb) cb();
    },
  };
  const source = def.methods ? Object.assign({}, def, def.methods) : def;
  Object.keys(source).forEach((k) => {
    if (
      typeof source[k] === 'function' &&
      !['attached', 'detached', 'ready', 'moved', 'created'].includes(k) &&
      !(def.lifetimes && def.lifetimes[k])
    ) {
      inst[k] = source[k].bind(inst);
    }
  });
  if (def.lifetimes && def.lifetimes.attached) {
    inst._attached = def.lifetimes.attached.bind(inst);
  }
  if (def.observers) {
    inst._observers = def.observers;
  }
  return inst;
}

/** 手动触发属性 observer（模拟运行时属性变化；真实运行时先落 data 再触发） */
function fireObserver(inst, key, value) {
  inst.data[key] = value;
  if (inst._observers && inst._observers[key]) {
    inst._observers[key].call(inst, value);
  }
}

/* ==================== 用例数据 ==================== */

function makeSentence(id, extra) {
  return Object.assign(
    {
      id,
      episodeid: 'ep' + id,
      episodeTitle: '剧集' + id,
      podcastTitle: null,
      subtitleId: id * 100,
      startTime: 12.3,
      endTime: 15.6,
      enText: 'The economy recovered quickly.',
      zhText: '经济很快恢复了。',
      note: null,
      tags: ['地道表达'],
      createAt: '2026-09-2' + (id % 10) + 'T00:00:00.000Z',
      updateAt: '2026-09-20T00:00:00.000Z',
    },
    extra || {},
  );
}

const S_RESILIENT = makeSentence(1, {
  enText: 'The resilient economy recovered quickly.',
  tags: ['地道表达', '写作素材'],
});
const S_AND = makeSentence(2, {
  enText: 'She and her colleague took off early.',
  subtitleId: null,
  zhText: null,
  tags: [],
});
const S_EMPTY_TAGS = makeSentence(3, {
  enText: 'A vibrant city never sleeps.',
  tags: null, // 服务端异常形状：归一为 []
});

const SENTENCES = [S_RESILIENT, S_AND, S_EMPTY_TAGS];

const VOCAB = [
  { word: 'resilient', definition: '有韧性的' },
  { word: 'Resilient', definition: '重复词（小写同形）' },
  { word: 'and', definition: null }, // 命中 S_AND（词边界 + 忽略大小写）
  { word: 'take off', definition: '起飞' }, // 多词短语，词长降序先于 take
  { word: 'take', definition: '拿' },
  { word: 'sand', definition: '沙滩' }, // 词边界：不应命中 and
  { word: 'never', definition: '' }, // 命中但无释义 → title 兜底文案
  { word: '  vibrant  ', definition: '充满活力的' }, // trim 后命中
  { word: 'missing', definition: '不在任何句中' },
  { word: 'c++', definition: '正则元字符词' }, // 元字符转义不 throw
];

/* ==================== 加载被测模块 ==================== */

const core = require(path.join(__dirname, '../utils/sentence-core'));
const audioClip = require(path.join(__dirname, '../utils/audio-clip'));

require(path.join(__dirname, '../components/review/sentence-notebook'));
const notebookDef = componentDefs.__last;
require(path.join(__dirname, '../components/review/sentence-micro-player'));
const playerDef = componentDefs.__last;
assert(!!notebookDef && !!notebookDef.methods, '模块加载：sentence-notebook Component 定义捕获成功');
assert(!!playerDef && !!playerDef.methods, '模块加载：sentence-micro-player Component 定义捕获成功');

const WXML = fs.readFileSync(
  path.join(__dirname, '../components/review/sentence-notebook/index.wxml'), 'utf8');
const WXSS = fs.readFileSync(
  path.join(__dirname, '../components/review/sentence-notebook/index.wxss'), 'utf8');
const REVIEW_WXML = fs.readFileSync(
  path.join(__dirname, '../pages/review/index.wxml'), 'utf8');

/* ==================== 1. 纯逻辑：parseSentences / 归一 ==================== */

section('parseSentences / normalizeSentence');

{
  const parsed = core.parseSentences({ success: true, data: SENTENCES });
  assert(Array.isArray(parsed) && parsed.length === 3, '信封解析：success 数组 → 3 条');
  assert(parsed[0].enText === S_RESILIENT.enText, '字段透传：enText 原样');
  assert(Array.isArray(parsed[2].tags) && parsed[2].tags.length === 0,
    'tags:null 归一为空数组（不 throw）');
  assert(core.parseSentences({ success: false, data: [] }).length === 0, 'success:false → []');
  assert(core.parseSentences(null).length === 0, '空响应 → []');
  assert(core.parseSentences({ success: true, data: 'oops' }).length === 0, 'data 非数组 → []');

  const d = core.decorateSentence({ subtitleId: null, startTime: 63, endTime: 125.4, note: '', zhText: '中' }, []);
  assert(d.hasSubtitle === false, 'subtitleId:null → hasSubtitle=false（跟读禁用依据）');
  assert(d.startText === '63s' && d.endText === '125s', '秒文本 Ns 取整');
  assert(d.hasZh === true && d.hasNote === false, 'zhText/note 空值语义（空串=无）');
}

/* ==================== 2. 纯逻辑：联动词汇（linked-vocab.ts 逐行） ==================== */

section('filterLinkedVocabWords（词边界交集）');

{
  const linked = core.filterLinkedVocabWords(VOCAB, SENTENCES);
  const words = linked.map((v) => v.word);
  assert(words.includes('resilient'), '词边界命中：resilient');
  assert(words.includes('and'), '忽略大小写命中：and（句中 "and"）');
  assert(!words.includes('sand'), '词边界排除：sand 不因包含 and 而误命中');
  assert(!words.includes('missing'), '不在任何句中的词被过滤');
  // Web 口径：返回原始对象（word 保持 '  vibrant  ' 原形，trim 仅用于匹配）
  assert(linked.some((v) => v.word.trim() === 'vibrant'), 'trim 后命中：vibrant（原形保留）');
  assert(linked.filter((v) => v.word.toLowerCase() === 'resilient').length === 1,
    '小写同形去重：Resilient 不重复出现');
  assert(core.filterLinkedVocabWords([], SENTENCES).length === 0, '空词表 → []');
  assert(core.filterLinkedVocabWords(VOCAB, []).length === 0, '空句表 → []');
  assert(core.escapeRegex('c++.') === 'c\\+\\+\\.', 'escapeRegex：元字符逐个转义');
  // 正则元字符按字面匹配（Web 同款 \b 边界）；以非词字符结尾的词（c++）
  // 在两端 \b 语义下不命中——与 Web linked-vocab 行为一致，且构造正则不 throw
  const dotted = core.filterLinkedVocabWords([{ word: 'foo.bar', definition: 'x' }],
    [{ enText: 'the foo.bar endpoint' }, { enText: 'foo bar words' }]);
  assert(dotted.length === 1 && dotted[0].word === 'foo.bar',
    '正则元字符词按字面命中（foo.bar 不误匹配 "foo bar"）');
  let threw = false;
  try { core.filterLinkedVocabWords([{ word: 'c++', definition: 'x' }], [{ enText: 'I write c++ daily.' }]); }
  catch (e) { threw = true; }
  assert(!threw, '元字符词构造正则不 throw（c++）');
}

/* ==================== 3. 纯逻辑：高亮分词（VocabularyHighlighter 逐行） ==================== */

section('buildHighlightSegments（mark 高亮段）');

{
  const linked = core.filterLinkedVocabWords(VOCAB, SENTENCES);

  // 词长降序：多词短语优先，避免 "take off" 被 "take" 拆散
  const segs = core.buildHighlightSegments('They take off now.', [
    { word: 'take off', definition: '起飞' }, { word: 'take', definition: '拿' },
  ]);
  const hits = segs.filter((s) => s.hit).map((s) => s.text);
  assert(hits.length === 1 && hits[0] === 'take off', '词长降序：短语整体命中不被拆散');
  assert(segs.map((s) => s.text).join('') === 'They take off now.', '分段拼接无损（round-trip）');

  const segs2 = core.buildHighlightSegments(S_AND.enText, linked);
  const hit2 = segs2.find((s) => s.hit && s.text === 'and');
  assert(!!hit2, '忽略大小写命中段还原原文形态');
  assert(hit2.title === '生词本收录：已加入生词本', 'definition 空 → title 兜底「已加入生词本」');

  const segs3 = core.buildHighlightSegments(S_RESILIENT.enText, linked);
  const hit3 = segs3.find((s) => s.hit && s.text === 'resilient');
  assert(hit3.title === '生词本收录：有韧性的', '命中段 title 带生词本释义');

  // 词边界：句内子串不高亮（sand 内的 and）
  const segs4 = core.buildHighlightSegments('The sand is warm.', [{ word: 'and', definition: '和' }]);
  assert(!segs4.some((s) => s.hit), '词边界：sand 内的 and 不高亮');

  const segs5 = core.buildHighlightSegments('hello', []);
  assert(segs5.length === 1 && segs5[0].hit === false && segs5[0].text === 'hello',
    '无词表 → 整段单条不命中');
  assert(core.buildHighlightSegments('', linked).length === 0, '空文本 → []');

  // 相邻命中 + 标点边界（"resilient, resilient" 两段命中）
  const segs6 = core.buildHighlightSegments('resilient, resilient', [
    { word: 'resilient', definition: 'd' },
  ]);
  assert(segs6.filter((s) => s.hit).length === 2, '重复命中逐段标记（含标点边界）');
}

/* ==================== 4. 纯逻辑：统计 / 标签 / 剧集候选 ==================== */

section('allTags / episodeOptions / deriveStats / tagCloud');

{
  const tags = core.allTags(SENTENCES);
  assert(JSON.stringify(tags) === JSON.stringify(['地道表达', '写作素材']),
    '标签去重保首见序、滤空（null tags 安全）');

  const cloud = core.tagCloud(SENTENCES);
  assert(cloud.length === 2 && cloud[0].name === '地道表达' && cloud[0].count === 1,
    'tagCloud：首见序 + 全量计数（地道表达 1）');
  assert(cloud[1].name === '写作素材' && cloud[1].count === 1, 'tagCloud：写作素材 1');
  assert(core.tagCloud([]).length === 0, 'tagCloud：空列表安全');

  const eps = core.episodeOptions(SENTENCES);
  assert(eps.length === 3 && eps[0].value === 'ep1' && eps[0].label === '剧集1',
    '剧集候选：episodeid 首见保序');
  assert(core.episodeOptions([makeSentence(9, { episodeTitle: '' })])[0].label === 'ep9',
    '剧集名缺失回落 episodeid');

  const stats = core.deriveStats(SENTENCES, core.filterLinkedVocabWords(VOCAB, SENTENCES));
  assert(stats.sentenceCount === 3, '统计：关键句 3');
  assert(stats.tagCount === 2, '统计：分类标签 2');
  assert(stats.vocabCount === core.filterLinkedVocabWords(VOCAB, SENTENCES).length,
    '统计：联动词汇 = 交集长度');
}

/* ==================== 5. 纯逻辑：四路搜索 + 筛选 ==================== */

section('filterSentences（四路搜索 + 剧集/标签筛选）');

{
  const list = core.parseSentences({ success: true, data: [
    makeSentence(1, { enText: 'The resilient economy', zhText: '韧性经济', note: 'note-abc', tags: ['写作素材'] }),
    makeSentence(2, { enText: 'totally different', zhText: '完全不同', note: null, tags: ['地道表达'] }),
  ] });
  assert(core.filterSentences(list, { query: 'RESILIENT' }).length === 1, '搜索命中英文（大小写不敏感）');
  assert(core.filterSentences(list, { query: '韧性' }).length === 1, '搜索命中中文译文');
  assert(core.filterSentences(list, { query: 'note-abc' }).length === 1, '搜索命中笔记');
  assert(core.filterSentences(list, { query: '写作' }).length === 1, '搜索命中标签');
  assert(core.filterSentences(list, { query: '  resilient ' }).length === 1, '搜索词 trim');
  assert(core.filterSentences(list, { query: '不存在' }).length === 0, '四路全空 → 过滤');
  assert(core.filterSentences(list, { episode: 'ep1' }).length === 1, '剧集筛选全等');
  assert(core.filterSentences(list, { episode: 'ALL' }).length === 2, "剧集 'ALL' 哨兵不筛");
  assert(core.filterSentences(list, { tag: '写作素材' }).length === 1, '标签筛选包含');
  assert(core.filterSentences(list, { tag: '写作素材', query: 'different' }).length === 0,
    '标签 + 搜索 交集');
}

/* ==================== 6. 纯逻辑：评测配额封顶 + 容量文案 ==================== */

section('evalQuotaView / quotaTexts（buffer 不泄露）');

{
  assert(core.FREE_SENTENCE_LIMIT === 30 && core.FREE_REVIEW_EVALUATIONS_PER_DAY === 5,
    '配额常量与 Web lib/quota.ts 同源（30 / 5）');

  const v1 = core.evalQuotaView({ used: 7, limit: 5 });
  assert(v1.used === 5 && v1.limit === 5, 'used=7 封顶 5（+1 buffer 不显示为 6/5）');
  assert(core.evalQuotaView({ used: 3 }).used === 3, '未触顶原样');
  assert(core.evalQuotaView({ used: 3 }).limit === 5, 'limit 缺省回落 5');
  assert(core.evalQuotaView({}).used === null, 'used 缺失 → null（文案 …）');
  assert(core.evalQuotaView(null).used === null, '空响应 → null');

  const q1 = core.quotaTexts(10, 2, 5);
  assert(q1.primaryStatusText === '10/30 · 还能收藏 20 句',
    '容量文案（带空格）：10/30 · 还能收藏 20 句');
  assert(q1.dailyStatusText === '2/5 · 剩3次', '日池文案：2/5 · 剩3次');
  const q2 = core.quotaTexts(30, 5, 5);
  assert(q2.primaryStatusText === '30/30 · 已满（删除腾位或升级无限）',
    '已满文案（全角括号，与生词本半角相区分）');
  assert(q2.dailyStatusText === '5/5 · 已用完 (升级无限)', '日池用完文案（半角括号）');
  assert(core.quotaTexts(0, null, 5).dailyStatusText === '…', '日池未加载 → …');
  assert(core.quotaTexts(29, 0, 5).primaryStatusText === '29/30 · 还能收藏 1 句', '临界 29 句');
}

/* ==================== 7. 组件驱动：加载 / 派生 / 降级 ==================== */

section('sentence-notebook 组件：active 懒加载 + 三路并发');

async function driveAttach(opts) {
  const inst = makeInstance(notebookDef);
  if (opts && opts.active) inst.data.active = true;
  inst._attached();
  await settle(8);
  return inst;
}

(async () => {
  apiResponses['/api/sentences/list'] = { success: true, data: SENTENCES };
  apiResponses['/api/vocabulary/all'] = { success: true, data: VOCAB };
  apiResponses['/api/speech/quota'] = { success: true, data: { used: 2, limit: 5, remaining: 3, exhausted: false, isPremium: false } };

  requestLog.length = 0;
  const inst = await driveAttach({ active: true });

  assert(requestLog.some((r) => r.path === '/api/sentences/list'), '拉取 GET /api/sentences/list');
  assert(requestLog.some((r) => r.path === '/api/vocabulary/all'), '并发拉取 GET /api/vocabulary/all（联动集）');
  assert(requestLog.some((r) => r.path === '/api/speech/quota'), '并发拉取 GET /api/speech/quota?scenario=review');

  assert(inst.data.loaded === true && inst.data.loading === false, '首次激活：loaded=true / loading=false');
  assert(inst.data.stats.sentenceCount === 3, '组件 stats：关键句 3');
  assert(inst.data.stats.tagCount === 2, '组件 stats：分类标签 2');
  const expVocab = core.filterLinkedVocabWords(VOCAB, core.parseSentences({ success: true, data: SENTENCES }));
  assert(inst.data.stats.vocabCount === expVocab.length, '组件 stats：联动词汇 = 交集口径');

  const first = inst.data.list[0];
  assert(first.id === S_RESILIENT.id, '列表保持服务端 createAt desc 排序');
  assert(first.enParts.some((s) => s.hit && s.text === 'resilient'), '装饰条目 enParts 含命中段');
  assert(first.hasSubtitle === true, '装饰条目 hasSubtitle');

  assert(inst.data.evalQuota.used === 2 && inst.data.evalQuota.limit === 5, '评测日池落 data（展示口径）');

  /* ---------- 懒加载：未激活不请求 ---------- */
  requestLog.length = 0;
  const idle = await driveAttach({});
  assert(requestLog.length === 0, '未激活（attached 时 active=false）零请求');

  /* ---------- active observer：激活后加载 / 再激活轻刷新 ---------- */
  requestLog.length = 0;
  fireObserver(idle, 'active', true);
  await settle(8);
  assert(requestLog.some((r) => r.path === '/api/sentences/list'), 'observer：首次激活触发加载');
  requestLog.length = 0;
  fireObserver(idle, 'active', false);
  await settle(2);
  assert(requestLog.length === 0, '失活不触发请求');
  fireObserver(idle, 'active', true);
  await settle(8);
  assert(requestLog.some((r) => r.path === '/api/sentences/list'), '再激活轻刷新（loaded 后 refresh）');

  /* ---------- refreshSeq：宿主 onShow 通知（active+loaded 才刷） ---------- */
  requestLog.length = 0;
  fireObserver(idle, 'refreshSeq', 1);
  await settle(8);
  assert(requestLog.some((r) => r.path === '/api/sentences/list'), 'refreshSeq 递增触发轻刷新');

  /* ---------- 子请求降级：vocab 失败不拖垮句子列表 ---------- */
  apiResponses['/api/vocabulary/all'] = new Error('network down');
  requestLog.length = 0;
  toastCalls.length = 0;
  fireObserver(idle, 'refreshSeq', 2);
  await settle(8);
  assert(idle.data.stats.sentenceCount === 3, 'vocab 失败：句子列表保持旧数据');
  assert(idle.data.stats.vocabCount === expVocab.length, 'vocab 失败：联动集沿用上次');
  assert(toastCalls.length > 0, 'vocab 失败：request.js 统一 toast（组件不重复 toast）');

  /* ---------- 主列表失败：保持旧数据 ---------- */
  apiResponses['/api/vocabulary/all'] = { success: true, data: VOCAB };
  apiResponses['/api/sentences/list'] = new Error('network down');
  fireObserver(idle, 'refreshSeq', 3);
  await settle(8);
  assert(idle.data.list.length === 3 && idle.data.stats.sentenceCount === 3,
    '主列表失败：保持旧数据不清空');

  /* ---------- 配额失败 → 沿用上次（Web catch(()=>{}) 同款静默降级） ---------- */
  apiResponses['/api/sentences/list'] = { success: true, data: SENTENCES };
  apiResponses['/api/speech/quota'] = new Error('quota down');
  fireObserver(idle, 'refreshSeq', 4);
  await settle(8);
  assert(idle.data.evalQuota.used === 2,
    '配额失败 → 沿用上次值（初始未加载才为 null，文案 …）');

  /* ---------- 空列表：stats 全 0（空态渲染依据） ---------- */
  apiResponses['/api/sentences/list'] = { success: true, data: [] };
  apiResponses['/api/speech/quota'] = { success: true, data: { used: 0, limit: 5 } };
  fireObserver(idle, 'refreshSeq', 5);
  await settle(8);
  assert(idle.data.stats.sentenceCount === 0 && idle.data.list.length === 0,
    '空列表 → stats.sentenceCount=0（WXML 渲染空态）');
  assert(core.filterLinkedVocabWords(VOCAB, []).length === 0 &&
    idle.data.stats.vocabCount === 0, '空句表 → 联动词汇归零');

  /* ---------- 空态引导：去发现页 ---------- */
  idle.onGoDiscover();
  assert(switchTabCalls.length === 1 && switchTabCalls[0] === '/pages/discover/index',
    '空态「去浏览播客」switchTab 发现页');

  /* ==================== 7b. T2.2：配额卡 / 筛选交互 / 视图切换 ==================== */

  section('T2.2 筛选与视图交互');

  apiResponses['/api/sentences/list'] = { success: true, data: SENTENCES };
  apiResponses['/api/speech/quota'] = { success: true, data: { used: 2, limit: 5 } };
  fireObserver(idle, 'refreshSeq', 6);
  await settle(8);

  // 配额双栏文案（quotaTexts 已随 applyDerived 落 data）
  assert(idle.data.quota.primaryStatusText === '3/30 · 还能收藏 27 句',
    '组件 quota.primaryStatusText（3/30 · 还能收藏 27 句）');
  assert(idle.data.quota.dailyStatusText === '2/5 · 剩3次',
    '组件 quota.dailyStatusText（2/5 · 剩3次）');
  assert(idle.data.sentenceLimit === 30, '容量上限常量 30 透出（quota-card primaryLimit）');

  // 筛选候选派生
  assert(JSON.stringify(idle.data.episodeNames) === JSON.stringify(['全部播客来源 (3)', '剧集1', '剧集2', '剧集3']),
    '剧集下拉候选：ALL 哨兵 + 首见保序');
  assert(idle.data.tagCloud.length === 2, '标签云落 data（2 个标签）');
  assert(idle.data.filteredList.length === 3 && !idle.data.hasFilter,
    '初始无筛选：filteredList 全量 / hasFilter=false');

  // 搜索（四路匹配在纯逻辑 section 已覆盖；此处验证交互链路）
  idle.onSearchInput({ detail: { value: 'vibrant' } });
  assert(idle.data.filteredList.length === 1, '搜索交互：vibrant 命中 1 条');
  assert(idle.data.hasFilter === true, '搜索激活 hasFilter（清除筛选入口显现）');
  idle.onClearSearch();
  assert(idle.data.filteredList.length === 3 && !idle.data.hasFilter, '清空搜索恢复全量');

  // 标签 pill
  idle.onTagTap({ currentTarget: { dataset: { tag: '写作素材' } } });
  assert(idle.data.filterTag === '写作素材' && idle.data.filteredList.length === 1,
    '标签筛选：写作素材 1 条');
  idle.onTagTap({ currentTarget: { dataset: { tag: 'ALL' } } });
  assert(idle.data.filterTag === 'ALL' && idle.data.filteredList.length === 3, '「全部」pill 复位');

  // 剧集 picker（索引 → episodeid 走 JS 映射）
  idle.onEpisodeChange({ detail: { value: '1' } });
  assert(idle.data.filterEpisode === 'ep1' && idle.data.episodeIdx === 1 &&
    idle.data.filteredList.length === 1, '剧集筛选 idx1 → ep1 命中 1 条');

  // 清除筛选（Web resetFilter：搜索/剧集/标签一并复位）
  idle.onClearFilter();
  assert(idle.data.searchQuery === '' && idle.data.filterEpisode === 'ALL' &&
    idle.data.filterTag === 'ALL' && idle.data.episodeIdx === 0 &&
    idle.data.filteredList.length === 3 && !idle.data.hasFilter, '清除筛选全部复位');

  // 筛选空态（与全局空态严格区分）
  idle.onSearchInput({ detail: { value: '不存在的词' } });
  assert(idle.data.filteredList.length === 0 && idle.data.stats.sentenceCount === 3,
    '筛选空：filteredList=0 但全局统计仍在（双空态区分依据）');

  // 视图切换（图标变体随选中态预计算）
  idle.onSearchInput({ detail: { value: '' } });
  // 回归（BUG3）：filteredList 条目必须是装饰后的（enParts 随行，卡片/简洁清单直接渲染）
  assert(Array.isArray(idle.data.filteredList[0].enParts) && idle.data.filteredList[0].enParts.length > 0,
    'filteredList 带派生字段（enParts 随行，卡片模式可渲染原句）');
  assert(idle.data.filteredList.every((s) => Array.isArray(s.enParts) && s.hasZh !== undefined),
    '全部筛选结果均为装饰条目（hasZh 等派生字段齐备）');
  idle.onTagTap({ currentTarget: { dataset: { tag: '写作素材' } } });
  assert(idle.data.filteredList[0].enParts.some((seg) => typeof seg.text === 'string'),
    '标签筛选后 filteredList 仍为装饰条目');
  idle.onTagTap({ currentTarget: { dataset: { tag: 'ALL' } } });
  assert(idle.data.viewMode === 'cards' &&
    idle.data.viewCardsSrc.includes('grid-view-ink') &&
    idle.data.viewCompactSrc.includes('list-gray'), '视图初始 cards：选中墨色/未选灰图标');
  idle.onViewTap({ currentTarget: { dataset: { view: 'compact' } } });
  assert(idle.data.viewMode === 'compact' &&
    idle.data.viewCompactSrc.includes('list-ink') &&
    idle.data.viewCardsSrc.includes('grid-view-gray'), '切到 compact：图标变体翻转');
  idle.onViewTap({ currentTarget: { dataset: { view: 'compact' } } });
  assert(idle.data.viewMode === 'compact' &&
    idle.data.viewCompactSrc.includes('list-ink'), '重复点击同视图 no-op（状态不变）');

  // 失效剧集回落 ALL（数据刷新后旧筛选指向已删剧集）
  idle.setData({ filterEpisode: 'ep-gone' });
  fireObserver(idle, 'refreshSeq', 7);
  await settle(8);
  assert(idle.data.filterEpisode === 'ALL' && idle.data.episodeIdx === 0,
    '失效剧集筛选回落 ALL');

  // 复习横幅 → deck 页
  idle.onStartDeck();
  assert(navCalls.length === 1 && navCalls[0] === '/pages/review/deck/index',
    '复习横幅 CTA → navigateTo pages/review/deck');

  /* ==================== 7c. T2.3：audio-clip 显式窗口 / 循环 / 进度 ==================== */

  section('T2.3 audio-clip 扩展（微播放器底座）');

  apiResponses['/api/episode/subtitles'] = {
    success: true, audioUrl: 'https://oss.example.com/ep.m4a', data: [],
  };
  let lastCtx = () => audioInstances[audioInstances.length - 1];

  // a) 显式窗口：免文本定位，直接 seek startTime
  await audioClip.play({ key: 'epA:s1', episodeid: 'epA', startTime: 12, endTime: 15 });
  await settle(6);
  lastCtx().__fire('canplay'); // 真机由 src 加载完成触发
  assert(lastCtx().src === 'https://oss.example.com/ep.m4a', '显式窗口：字幕源直链注入 ctx.src');
  assert(lastCtx().seeks.includes(12), '显式窗口：seek 到 startTime（免文本定位）');
  assert(audioClip.getState().playingKey === 'epA:s1', '播放中 playingKey 置位');

  // b) 进度订阅：timeupdate → progress（key/start/end/currentTime）
  let prog = null;
  const unsub = audioClip.subscribeProgress((p) => { prog = p; });
  lastCtx().currentTime = 13;
  lastCtx().__fire('timeupdate');
  assert(prog && prog.key === 'epA:s1' && prog.currentTime === 13 &&
    prog.start === 12 && prog.end === 15, '进度订阅：timeupdate 推送 progress 数据');
  unsub();

  // c) 无循环：越过窗口终点自动停止
  lastCtx().currentTime = 15.3;
  lastCtx().__fire('timeupdate');
  assert(audioClip.getState().playingKey === null && audioClip.getState().progress === null,
    '无循环：到窗终自动停止 + 进度清空');

  // d) 单句循环：到窗终回 seek 句首续播（600ms 静默窗防陈旧快照误触发）
  await audioClip.play({ key: 'epA:s2', episodeid: 'epA', startTime: 20, endTime: 23 });
  await settle(6);
  lastCtx().__fire('canplay');
  audioClip.setLoop(true);
  lastCtx().currentTime = 23.2;
  lastCtx().__fire('timeupdate');
  assert(audioClip.getState().playingKey === 'epA:s2', '循环开启：到窗终不停止');
  assert(lastCtx().seeks[lastCtx().seeks.length - 1] === 20, '循环：回 seek 句首（20）');
  const seeksAfterLoop = lastCtx().seeks.length;
  lastCtx().currentTime = 23.5; // 静默窗内（陈旧快照）不应二次 seek
  lastCtx().__fire('timeupdate');
  assert(lastCtx().seeks.length === seeksAfterLoop, '循环静默窗：600ms 内陈旧快照不重复 seek');
  audioClip.setLoop(false);
  lastCtx().currentTime = 23.6;
  lastCtx().__fire('timeupdate');
  assert(audioClip.getState().playingKey === null, '关闭循环后：窗终恢复自动停止');

  // e) 同 key toggle
  await audioClip.play({ key: 'epA:s3', episodeid: 'epA', startTime: 1, endTime: 2 });
  await settle(6);
  lastCtx().__fire('canplay');
  await audioClip.play({ key: 'epA:s3', episodeid: 'epA', startTime: 1, endTime: 2 });
  assert(audioClip.getState().playingKey === null, '同 key 再点 = 停止（toggle）');

  /* ==================== 7d. T2.3：微播放器组件 ==================== */

  section('T2.3 微播放器组件');

  const mp = makeInstance(playerDef);
  mp.data.sentenceId = 9;
  mp.data.episodeid = 'epB';
  mp.data.startTime = 12;
  mp.data.endTime = 15;
  // setData 同值守卫观测：值未变的广播不得触发本实例 setData（列表 N 实例广播放大防线）
  let mpSetDataCalls = 0;
  const rawSetData = mp.setData.bind(mp);
  mp.setData = (patch, cb) => { mpSetDataCalls += 1; rawSetData(patch, cb); };
  mp._attached();

  // 别人的 key 开始播放：广播到达但本实例值不变 → 零 setData
  const callsBefore = mpSetDataCalls;
  await audioClip.play({ key: 'epZ:s99', episodeid: 'epZ', startTime: 1, endTime: 2 });
  await settle(6);
  lastCtx().__fire('canplay');
  assert(mpSetDataCalls === callsBefore, '同值守卫：他人 key 的播放广播零 setData');
  audioClip.stop();

  // onTogglePlay → audio-clip 播放（请求字幕源 + seek）
  requestLog.length = 0;
  mp.onTogglePlay();
  await settle(6);
  lastCtx().__fire('canplay');
  assert(requestLog.some((r) => r.path === '/api/episode/subtitles'), '点播放拉取字幕源（缓存复用）');
  assert(audioClip.getState().playingKey === 'epB:s9', '播放 key = episodeid:s{id}（两视图共享态）');
  assert(mp.data.playing === true && mp.data.loading === false, '订阅状态：playing 同步');

  // 循环开关
  mp.onToggleLoop();
  assert(mp.data.loop === true, '循环开关翻转');
  mp.onToggleLoop();
  assert(mp.data.loop === false, '循环开关再翻回');

  // 到窗终停止 → 组件回落空闲态（裸图标：无进度字段）
  lastCtx().currentTime = 15.4;
  lastCtx().__fire('timeupdate');
  assert(mp.data.playing === false && mp.data.loading === false,
    '停止后：回落空闲播放图标');
  mp._detached && mp._detached();

  /* ==================== 7e. T2.3：卡片操作坞 / 折叠 / 删除 / 抽屉 ==================== */

  section('T2.3 卡片交互（操作坞/折叠/删除/抽屉）');

  // 折叠「查看中文翻译 & 笔记」
  idle.onToggleExpand({ currentTarget: { dataset: { id: 1 } } });
  assert(idle.data.expandedId === 1, '折叠展开：expandedId 置位');
  idle.onToggleExpand({ currentTarget: { dataset: { id: 1 } } });
  assert(idle.data.expandedId === null, '再次点击收起');

  // 影子跟读：禁用提示 / 可用跳转
  toastCalls.length = 0;
  navCalls.length = 0;
  idle.onShadowTap({ currentTarget: { dataset: { ok: false, id: 2 } } });
  assert(toastCalls.includes('该句缺少字幕定位信息，无法跟读'), '跟读禁用：toast 提示文案逐字');
  assert(navCalls.length === 0, '跟读禁用：不跳转');
  idle.onShadowTap({ currentTarget: { dataset: { ok: true, id: 1 } } });
  assert(navCalls[0] === '/pages/review/shadowing/index?id=1', '跟读可用：跳 shadowing?id=');

  // meta 出处胶囊 → 剧集详情
  idle.onEpisodeTap({ currentTarget: { dataset: { episodeid: 'ep1' } } });
  assert(navCalls[1] === '/pages/episode/episode?id=ep1', '出处胶囊：跳剧集详情 ?id=');

  // 编辑 → 抽屉 sentence 置位
  idle.onEditTap({ currentTarget: { dataset: { id: 1 } } });
  assert(!!idle.data.editSentence && idle.data.editSentence.id === 1, '编辑：editSentence 置位（抽屉开启）');

  // 抽屉保存成功 → 本地同步 tags/note + 派生刷新
  idle.onDrawerUpdated({ detail: { id: 1, tags: ['面试金句'], note: '被动语态笔记' } });
  const updated = idle.data.list.find((s) => s.id === 1);
  assert(JSON.stringify(updated.tags) === JSON.stringify(['面试金句']) && updated.note === '被动语态笔记',
    '抽屉 updated：tags/note 本地同步');
  assert(idle.data.tagCloud.some((t) => t.name === '面试金句'), '抽屉 updated：标签云重算');
  idle.onDrawerClose();
  assert(idle.data.editSentence === null, '抽屉关闭：editSentence 清空');

  // 删除两段式：确认 → POST /api/sentences/delete → 本地过滤 + toast
  global.__modalConfirm = true;
  modalCalls.length = 0;
  toastCalls.length = 0;
  requestLog.length = 0;
  apiResponses['/api/sentences/delete'] = { success: true };
  idle.onDeleteTap({ currentTarget: { dataset: { id: 3 } } });
  await settle(6);
  assert(modalCalls.length === 1 && modalCalls[0].title === '从句子本移除' &&
    modalCalls[0].content === '确定要移除这个句子吗？移除后需要重新收藏。', '删除弹窗：标题/正文文案逐字');
  assert(requestLog.some((r) => r.path === '/api/sentences/delete' && r.data && r.data.id === 3),
    '删除确认：POST /api/sentences/delete {id}');
  assert(idle.data.stats.sentenceCount === 2, '删除后：列表与统计同步（3 → 2）');
  assert(toastCalls.includes('已从句子本中移除'), '删除成功 toast 逐字');

  // 删除取消：不发请求
  global.__modalConfirm = false;
  requestLog.length = 0;
  idle.onDeleteTap({ currentTarget: { dataset: { id: 1 } } });
  await settle(4);
  assert(!requestLog.some((r) => r.path === '/api/sentences/delete'), '删除取消：零请求');
  global.__modalConfirm = true;

  /* ==================== 8. WXML / WXSS 结构断言 ==================== */

  section('WXML / WXSS 结构断言');

  assert(WXML.includes('关键句') && WXML.includes('联动词汇') && WXML.includes('分类标签'),
    '统计三格文案逐字（Web SentenceStats）');
  assert(WXML.includes('句子本暂无匹配内容'), '空态标题逐字');
  assert(WXML.includes('在收听播客时打开「沉浸式逐字稿」，点击字幕行右侧的“书签”按钮，即可一键收藏精选原句！'),
    '空态描述逐字（含全角引号）');
  assert(WXML.includes('去浏览播客'), '空态按钮文案逐字');
  assert(WXML.includes('wx:for="{{item.enParts}}"') && WXML.includes("seg.hit ? 'sn-hl'"),
    '高亮段循环 + 命中类切换');
  assert(REVIEW_WXML.includes('<sentence-notebook active="{{activeTab === 1}}" refresh-seq="{{refreshSeq}}" />'),
    '宿主页面传递 refresh-seq（onShow 轻刷新链路）');

  // T2.2 结构：配额卡 / 横幅 / 筛选面板 / 双空态 / 视图切换
  assert(WXML.includes('<quota-card') && WXML.includes('primaryLabel="句子本容量"') &&
    WXML.includes('dailyLabel="今日复习评测"'), 'quota-card 挂载 + 双栏标题逐字');
  assert(WXML.includes('premiumTitle="PRO 无限收藏 · 已收 {{stats.sentenceCount}} 句"') &&
    WXML.includes('premiumSubtitle="容量不设限，复习评测也不限次"'), 'PRO 无限态文案逐字');
  assert(WXML.includes('primaryLimit="{{sentenceLimit}}"') &&
    WXML.includes('dailyLimit="{{evalQuota.limit}}"'), '双栏 limit 绑定（30 / 动态日池）');
  assert(WXML.includes('卡片复习已就绪'), '横幅标题逐字');
  assert(WXML.includes('深度联动，随时开始 AI 影子跟读与卡片复习。'), '横幅描述逐字');
  assert(WXML.includes('卡片复习模式') && WXML.includes('bindtap="onStartDeck"'), '横幅 CTA 文案 + 事件');
  assert(WXML.includes('placeholder="搜索英文原句、中文翻译、笔记或标签..."'), '搜索 placeholder 逐字（含省略号）');
  assert(WXML.includes('mode="selector" range="{{episodeNames}}"') &&
    WXML.includes('bindchange="onEpisodeChange"'), '剧集筛选 picker');
  assert(WXML.includes('标签分类：') && WXML.includes('全部 ({{stats.sentenceCount}})') &&
    WXML.includes('清除筛选'), '标签 pills：分类标签头 + 全部计数 + 清除筛选');
  assert(WXML.includes('卡片详情') && WXML.includes('简洁清单'), '视图切换双标签');
  assert(WXML.includes('未找到匹配的句子') && WXML.includes('调整搜索词或筛选条件试试'),
    '筛选空态文案逐字（与全局空态区分）');
  assert(WXML.includes('wx:elif="{{viewMode === \'compact\'}}"'), '双视图分支（compact elif cards）');

  // 四 BUG 修复结构断言（2026-09-26 真机截图反馈）
  assert(WXSS.includes('margin-top: 24rpx') && /\.sn-panel \{[^}]*margin-top/s.test(WXSS),
    'BUG1：配额卡与搜索筛选面板间距（sn-panel margin-top）');
  assert(WXML.includes('<scroll-view class="sn-tags-scroll" scroll-x') &&
    WXSS.includes('flex-wrap: nowrap') && WXSS.includes('width: max-content'),
    'BUG2：标签行单行 + 水平滚动（scroll-x / nowrap / max-content）');
  assert(WXML.includes('class="card sn-item ') && WXML.includes('sn-item-en font-serif') &&
    WXML.includes('wx:for="{{item.enParts}}"'),
    'BUG3：卡片模式渲染装饰条目 enParts（衬线原句）');
  assert(WXML.includes('class="card sn-compact-wrap"') &&
    WXSS.includes('.sn-compact + .sn-compact') &&
    !/\.sn-compact \{[^}]*margin-bottom/s.test(WXSS),
    'BUG4：简洁清单单容器 + divide-y 分隔线、行间零外距');
  assert(WXML.includes('sn-compact-en font-serif'), '简洁清单原句衬线 + 生词高亮');
  assert(WXSS.includes('rgba(99, 102, 241, 0.1)') && WXSS.includes('--sn-tag-text: #4f46e5'),
    '标签胶囊 indigo-500/10 底 + indigo-600 字（Web 原值）');
  assert(WXSS.includes('font-size: 32rpx') && WXSS.includes('font-weight: 700'),
    '卡片原句 text-base 粗体（32rpx/700）');
  assert(fs.existsSync(path.join(__dirname, '../assets/icons/podcasts-gray.svg')) &&
    fs.readFileSync(path.join(__dirname, '../assets/icons/podcasts-gray.svg'), 'utf8').includes('M14,12c0,0.74'),
    'podcasts-gray.svg：Material Podcasts 官方 path 烘焙（原 lucide Radio 全局换装 Material）');

  // T2.3 结构：微播放器（裸图标形态）/ 操作坞 / 折叠区 / 抽屉挂载
  const MPWXML = fs.readFileSync(
    path.join(__dirname, '../components/review/sentence-micro-player/index.wxml'), 'utf8');
  const MPWXSS = fs.readFileSync(
    path.join(__dirname, '../components/review/sentence-micro-player/index.wxss'), 'utf8');
  const NOTEBOOK_JSON = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../components/review/sentence-notebook/index.json'), 'utf8'));

  assert((WXML.match(/<sentence-micro-player/g) || []).length === 2,
    '微播放器挂载两处（卡片详情 + 简洁清单）');
  assert(WXML.includes('start-time="{{item.startTime}}"') &&
    WXML.includes('end-time="{{item.endTime}}"'), '微播放器 props：显式窗口透传');
  // 三轮走查（截图对齐）：裸图标形态——胶囊容器/进度切片/双时间全部移除
  assert(MPWXML.includes('smp-btn') && MPWXML.includes('smp-loop') && MPWXML.includes('smp-spin'),
    '微播放器结构：播放钮 + 循环钮 + loading 态');
  assert(!MPWXML.includes('smp-track') && !MPWXML.includes('smp-fill') && !MPWXML.includes('smp-times') &&
    !MPWXSS.includes('smp-track') && !MPWXSS.includes('--smp-fill'),
    '微播放器裸形态：无胶囊容器/进度切片/双时间（Web 移动端口径）');
  assert(MPWXSS.includes('gap: 8rpx'), '微播放器图标间距 = Web gap-1');

  // 卡片详情：底栏 = 折叠按钮居左 + 5 图标（播放/循环 → 麦克风 → 编辑 → 删除）居右同一行
  const barBlock = WXML.split('sn-item-bar')[1] || '';
  assert(/\.sn-item-bar \{[^}]*justify-content: space-between/s.test(WXSS) &&
    /\.sn-item-bar \{[^}]*margin-top: 8rpx/s.test(WXSS),
    '卡片底栏：space-between 两端排布 + 分割线上间距（gap 20 + margin 8 = 28rpx）');
  assert(/\.sn-item-acts \{[^}]*gap: 8rpx/s.test(WXSS),
    '卡片底栏图标组：均匀 gap（Web gap-1）');
  assert(barBlock.indexOf('onToggleExpand') >= 0 &&
    barBlock.indexOf('sn-collapse') < barBlock.indexOf('sentence-micro-player'),
    '折叠按钮并入底栏且居左（在 5 图标之前）');
  assert(barBlock.indexOf('sentence-micro-player') < barBlock.indexOf('onShadowTap') &&
    barBlock.indexOf('onShadowTap') < barBlock.indexOf('onEditTap') &&
    barBlock.indexOf('onEditTap') < barBlock.indexOf('onDeleteTap'),
    '卡片底栏图标次序：播放/循环 → 麦克风 → 编辑 → 删除');

  // 简洁清单：3 图标单独一行靠右（播放/循环/麦克风），无编辑/删除
  const compactBlock = WXML.slice(
    WXML.indexOf('sn-compact-wrap'), WXML.indexOf('卡片详情：英文原句'));
  assert(compactBlock.includes('sn-compact-foot') &&
    WXSS.includes('.sn-compact-foot'), '简洁清单：底部操作行独立容器');
  assert(/\.sn-compact-foot \{[^}]*justify-content: flex-end/s.test(WXSS),
    '简洁清单：操作行整行靠右');
  assert(!compactBlock.includes('onEditTap') && !compactBlock.includes('onDeleteTap') &&
    !compactBlock.includes('edit-gray') && !compactBlock.includes('delete-gray'),
    '简洁清单：彻底无编辑/删除图标（Web 移动端 hidden 口径）');
  assert(compactBlock.indexOf('sentence-micro-player') < compactBlock.indexOf('onShadowTap'),
    '简洁清单操作行次序：播放/循环 → 麦克风');
  assert(WXML.includes('bindtap="onShadowTap"') && WXML.includes('mic-off.svg'),
    '操作坞：影子跟读（禁用态图标 Material MicOff）');
  assert(WXML.includes('bindtap="onEditTap"') && WXML.includes('bindtap="onToggleExpand"'),
    '操作坞：编辑 + 折叠触发行');
  assert(WXML.includes('查看中文翻译 & 笔记') && WXML.includes('收起译文与笔记'),
    '折叠触发行文案（两态逐字）');
  assert(WXML.includes('参考译文') && WXML.includes('暂无翻译'),
    '折叠区：参考译文 + 空译文兜底');
  assert(WXML.includes('个人笔记 &amp; 语法搭配') && WXML.includes('+ 添加你的第一条学习笔记'),
    '折叠区：笔记标题 + 空笔记引导（逐字）');
  assert(WXML.includes('<sentence-tag-drawer sentence="{{editSentence}}" bindupdated="onDrawerUpdated" bindclose="onDrawerClose" />'),
    'quick-tag-drawer 挂载（sentence/updated/close 三接线）');
  assert(NOTEBOOK_JSON.usingComponents['sentence-micro-player'] &&
    NOTEBOOK_JSON.usingComponents['sentence-tag-drawer'] &&
    NOTEBOOK_JSON.usingComponents['quota-card'], 'json 注册：micro-player / tag-drawer / quota-card');
  assert(!WXML.includes('sn-compact-slice') && !WXML.includes('sn-compact-mtag') &&
    !WXSS.includes('.sn-compact-slice') && !WXSS.includes('.sn-compact-mtag'),
    '简洁清单 meta：无时间戳/分类标签（四轮走查，Web 桌面端元素）');
  assert(WXML.includes('class="sn-compact-zh"') && !WXML.includes('sn-compact-zh ellipsis'),
    '简洁清单中文：完整显示多行换行（无 ellipsis）');
  assert(WXML.includes('sn-compact-note'), '简洁清单 meta：笔记摘要保留');
  ['mic-gray', 'mic-off', 'edit-gray', 'delete-gray', 'description-indigo',
   'pause-primary-dark', 'repeat-graydark'].forEach((name) => {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', name + '.svg')),
      '图标资产：' + name + '.svg 存在');
  });

  // WXML 绑定零方法调用红线（3.B.4 六轮教训）
  const methodCalls = WXML.match(/\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|toLowerCase|trim)\(/g);
  assert(!methodCalls, 'WXML 绑定零方法调用（' + (methodCalls ? methodCalls.join(' ; ') : '无') + '）');

  // 高亮 mark 色值 = Web highlightClassName 原值（bg/text/border 三值 + 深色三态）
  assert(WXSS.includes('#fef3c7') && WXSS.includes('#78350f') && WXSS.includes('#f59e0b'),
    '高亮 mark 浅色三值逐字（amber-100/900/500）');
  assert(WXSS.includes('rgba(45, 22, 3, 0.4)') && WXSS.includes('#fcd34d') && WXSS.includes('#d97706'),
    '高亮 mark 深色三值（amber-950/40 · amber-300 · amber-600）');
  assert(WXSS.includes('prefers-color-scheme: dark') && WXSS.includes('.theme-dark .sn-hl'),
    '深色双轨：媒体查询 + 手动覆盖根类');
  assert(WXSS.includes('#d98a17') === false ||
    WXML.includes('warning.svg'), '统计格琥珀/信息色走烘焙图标（不在 WXSS 硬编码文字色）');

  // 图标资产齐备（Android Material 官方 path + 原语义色）
  ['format-quote-primary', 'format-quote-primary-dark', 'warning', 'warning-dark',
   'label-info', 'label-info-dark'].forEach((name) => {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', name + '.svg')),
      '图标资产：' + name + '.svg 存在');
  });
  const tagSvg = fs.readFileSync(path.join(__dirname, '../assets/icons/label-info.svg'), 'utf8');
  assert(tagSvg.includes('M17.63 5.84') && tagSvg.includes('fill="#4a7fa5"'),
    'label-info：Material Label 官方 path + Web info 色');

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 句子本 T2.1–T2.3 测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
