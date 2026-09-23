/**
 * scripts/test-vocab-notebook.js — 生词本复刻自动化测试
 * （REVIEW-TASK 阶段 1：T1.1 数据接入 / T1.2 统计+配额 / T1.3 筛选列表 /
 *  T1.4 富视图与操作 / T1.5 四题型复习页 + tts.playUrl 扩展）
 *
 * 三层驱动：
 *   1. utils/vocab-core.js 纯逻辑（统计/筛选/排序/分词/装饰/配额文案/
 *      四题型分配/选项生成/答案判定/总结统计）——直接 require 断言；
 *   2. utils/tts.js playUrl——mock wx.createInnerAudioContext + request，
 *      验证直链播放 / onError TTS 兜底 / toggle / playingUrl 状态；
 *   3. components/review/vocab-notebook + pages/review/vocab-review——
 *      Component/Page 定义捕获 + makeInstance 驱动（mini-player 同款测试法），
 *      验证加载派生 / 筛选交互 / 手风琴 / 乐观翻转回滚 / 删除确认 /
 *      复习流转（答对翻面 / 选择分支 / SRS 提交 / 总结 / 再来一轮）；
 *   4. WXML 结构断言：quota-card 与 premium-modal 挂载、WXML 绑定零方法调用
 *      （indexOf/includes/map/filter/slice/join——3.B.4 六轮教训防再踩）。
 *
 * 运行：node scripts/test-vocab-notebook.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toastCalls = [];
const modalCalls = [];
const clipboardCalls = [];
const navCalls = [];
let navBackCalls = 0;
let switchTabCalls = [];
const requestLog = []; // { path, method, data }

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

// InnerAudioContext mock：事件可手动触发
const audioInstances = [];
const dlLog = []; // downloadFile 中转调用记录
function makeAudioCtx() {
  const handlers = {};
  const ctx = {
    src: '',
    currentTime: 0,
    played: 0,
    stopped: 0,
    destroyed: false,
    play() { this.played += 1; },
    stop() { this.stopped += 1; },
    seek() {},
    destroy() { this.destroyed = true; },
    onEnded(cb) { handlers.ended = cb; },
    onError(cb) { handlers.error = cb; },
    onCanplay(cb) { handlers.canplay = cb; },
    onTimeUpdate(cb) { handlers.timeupdate = cb; },
    offEnded() { delete handlers.ended; },
    offError() { delete handlers.error; },
    offCanplay() { delete handlers.canplay; },
    offTimeUpdate() { delete handlers.timeupdate; },
    __handlers: handlers,
    __fire(event) { handlers[event] && handlers[event](); },
  };
  audioInstances.push(ctx);
  return ctx;
}

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: (o) => {
    modalCalls.push(o);
    // 默认点击取消；用例可先改写 __modalConfirm
    o.success && o.success({ confirm: global.__modalConfirm !== false });
  },
  setClipboardData: (o) => {
    clipboardCalls.push(o.data);
    o.success && o.success();
  },
  navigateTo: (o) => navCalls.push(o.url),
  navigateBack: () => { navBackCalls += 1; },
  switchTab: (o) => switchTabCalls.push(o.url),
  downloadFile(opts) {
    dlLog.push(opts.url);
    setTimeout(() => opts.success && opts.success({
      statusCode: 200,
      tempFilePath: 'tmp-' + dlLog.length,
    }), 0);
  },
  request: resolveRequest,
  createInnerAudioContext: makeAudioCtx,
  getBackgroundAudioManager: () => ({
    play() {}, pause() {}, stop() {}, seek() {},
    onPlay() {}, onPause() {}, onStop() {}, onEnded() {},
    onTimeUpdate() {}, onCanplay() {}, onWaiting() {}, onError() {},
    onPrev() {}, onNext() {},
  }),
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 20 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 20 }),
};
global.__modalConfirm = true;

// Component / Page 定义捕获
const componentDefs = {};
global.Component = (cfg) => { componentDefs.__last = cfg; };
let pageDef = null;
global.Page = (cfg) => { pageDef = cfg; };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 由 Component/Page 定义构造可驱动的伪实例（绑定 lifetimes/methods） */
function makeInstance(def) {
  const propDefaults = {};
  Object.keys(def.properties || {}).forEach((k) => {
    propDefaults[k] = def.properties[k].value;
  });
  const inst = {
    data: Object.assign(propDefaults, JSON.parse(JSON.stringify(def.data))),
    setDataCalls: 0,
    setData(patch, cb) {
      Object.assign(this.data, patch);
      this.setDataCalls += 1;
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
  if (def.lifetimes && def.lifetimes.detached) {
    inst._detached = def.lifetimes.detached.bind(inst);
  }
  if (def.observers) {
    inst._observers = def.observers;
  }
  return inst;
}

/** 手动触发属性 observer（模拟运行时属性变化） */
function fireObserver(inst, key, value) {
  if (inst._observers && inst._observers[key]) {
    inst._observers[key].call(inst, value);
  }
}

/* ==================== 用例数据 ==================== */

const NOW = new Date('2026-09-23T04:00:00.000Z'); // 12:00 北京时间
const PAST = '2026-09-20T00:00:00.000Z'; // 已到期
const FUTURE = '2026-10-01T00:00:00.000Z'; // 未到期

function makeItem(id, extra) {
  return Object.assign(
    {
      vocabularyid: id,
      word: 'word' + id,
      definition: '词义' + id,
      translation: null,
      contextSentence: null,
      proficiency: 2,
      nextReviewAt: PAST,
      addedDate: '2026-09-01T00:00:00.000Z',
      speakUrl: null,
      webUrl: null,
      timestamp: 125,
      episodeid: null,
      episodeTitle: 'EP' + id,
      status: 'LEARNING',
      dictData: null,
    },
    extra || {},
  );
}

const RICH = makeItem(1, {
  word: 'resilient',
  translation: '有韧性的',
  contextSentence: 'The resilient economy recovered quickly.',
  nextReviewAt: FUTURE,
  speakUrl: 'https://dict/resilient.mp3',
  webUrl: 'https://dict.example.com/resilient',
  episodeid: 'ep1',
  dictData: {
    phonetics: { us: '/rɪˈzɪliənt/', uk: '/rɪˈzɪliənt/' },
    audio_urls: { us: 'https://dict/us-resilient.mp3', uk: 'https://dict/uk-resilient.mp3' },
    inflections: {
      plural: null, past_tense: null, present_participle: null,
      third_person_singular: null, adjective_form: 'resilient（形）',
    },
    definitions: [
      { pos: 'adj.', meaning_cn: '有弹性的；能快速恢复的', meaning_en: 'able to recover quickly', cefr_level: 'C1' },
      { pos: 'adj.', meaning_cn: '适应力强的', meaning_en: null },
    ],
    etymology: { prefix: 're-', root: 'sil', suffix: '-ent', breakdown: 're + sil + ient', mnemonic: '弹回来的能力' },
    phrases_and_collocations: [{ phrase: 'resilient economy', meaning_cn: '韧性经济' }],
    synonyms: ['tough', 'flexible'],
    antonyms: ['fragile'],
    examples: [
      { en: 'A resilient system bounces back.', cn: '有韧性的系统会反弹。', context: 'tech' },
    ],
  },
});

const DUE_ITEM = makeItem(2, { word: 'audit', nextReviewAt: null }); // 空 nextReviewAt = 到期
const MASTERED_ITEM = makeItem(3, {
  word: 'budget',
  status: 'MASTERED',
  nextReviewAt: FUTURE,
  addedDate: '2026-09-23T02:00:00.000Z', // 今日新增
});
const NO_DICT = makeItem(4, {
  word: 'vibrant',
  definition: '充满活力的',
  translation: '充满活力的',
  contextSentence: 'The vibrant city never sleeps.',
  episodeid: 'ep4',
});

const SAMPLE_LIST = [RICH, DUE_ITEM, MASTERED_ITEM, NO_DICT];

/** 深拷贝工厂：乐观翻转/删除等用例会 mutate 列表项，后续 section 需要干净副本 */
function freshSample() {
  return JSON.parse(JSON.stringify(SAMPLE_LIST));
}

/* ==================== 加载被测模块 ==================== */

const vocabCore = require(path.join(__dirname, '../utils/vocab-core'));
const srs = require(path.join(__dirname, '../utils/srs'));
// 先于组件加载 tts / audio-clip（组件 require 同一单例）
const tts = require(path.join(__dirname, '../utils/tts'));
const audioClip = require(path.join(__dirname, '../utils/audio-clip'));

require(path.join(__dirname, '../components/review/vocab-notebook'));
const notebookDef = componentDefs.__last;
require(path.join(__dirname, '../pages/review/vocab-review/index'));
const reviewPageDef = pageDef;
assert(!!notebookDef && !!reviewPageDef, '模块加载：Component 与 Page 定义捕获成功');

const WXML_NOTEBOOK = fs.readFileSync(
  path.join(__dirname, '../components/review/vocab-notebook/index.wxml'), 'utf8');
const WXML_REVIEW = fs.readFileSync(
  path.join(__dirname, '../pages/review/vocab-review/index.wxml'), 'utf8');

/* ==================== 一、vocab-core 纯逻辑 ==================== */

(async () => {
  section('一、统计与配额派生（T1.1/T1.2）');
  {
    const stats = vocabCore.deriveStats(SAMPLE_LIST);
    assert(stats.total === 4, 'stats.total = 全量 4');
    assert(stats.due === 2, 'stats.due = 2（RICH 未到期不算；DUE 空 nextReviewAt 算；MASTERED 不算；NO_DICT 到期算）');
    assert(stats.mastered === 1, 'stats.mastered = 1');

    const today = vocabCore.todayAddedCount(SAMPLE_LIST, NOW);
    assert(today === 1, 'todayAddedCount = 1（仅 MASTERED_ITEM 今日新增）');
    // 昨日 23:59 边界
    const edge = vocabCore.todayAddedCount(
      [makeItem(9, { addedDate: '2026-09-22T15:59:59.000Z' })], NOW,
    );
    assert(edge === 0, 'todayAddedCount：昨日 23:59（北京时间）不计入今日');

    assert(vocabCore.formatDate('2026-10-01T00:00:00.000Z') === '10/1', 'formatDate → M/D');
    assert(vocabCore.formatDate(null) === 'N/A', 'formatDate(null) → N/A');
  }

  {
    section('二、配额文案（逐字对齐 Web QuotaStatusCard 调用处）');
    const q1 = vocabCore.quotaTexts(12, 2);
    assert(q1.primaryStatusText === '12/50 · 还能收藏38个', '容量未满文案（无空格，对齐 Web）');
    assert(q1.dailyStatusText === '2/5 · 剩3次', '今日未用完文案');
    const q2 = vocabCore.quotaTexts(50, 5);
    assert(q2.primaryStatusText === '50/50 · 已满 (删除腾位或升级无限)', '容量已满文案');
    assert(q2.dailyStatusText === '5/5 · 已用完 (升级无限)', '今日已用完文案');
  }

  section('三、筛选与排序（T1.3，逐行对齐 Web filteredList）');
  {
    // 状态过滤：缺省 LEARNING
    let list = vocabCore.filterAndSort(SAMPLE_LIST, {});
    assert(list.length === 3 && list.every((v) => v.status === 'LEARNING'), '默认筛 LEARNING（3 条）');
    list = vocabCore.filterAndSort(SAMPLE_LIST, { status: 'MASTERED' });
    assert(list.length === 1 && list[0].word === 'budget', '筛 MASTERED（1 条）');

    // 搜索：word 小写包含 / translation 原串包含
    list = vocabCore.filterAndSort(SAMPLE_LIST, { query: 'RESIL' });
    assert(list.length === 1 && list[0].word === 'resilient', '搜索 word 大写输入小写匹配');
    list = vocabCore.filterAndSort(SAMPLE_LIST, { query: '有韧' });
    assert(list.length === 1 && list[0].word === 'resilient', '搜索 translation 中文匹配');
    list = vocabCore.filterAndSort(SAMPLE_LIST, { query: 'zzz' });
    assert(list.length === 0, '搜索无命中 → 空列表');

    // 排序：review（nextReviewAt 升序，空最小）
    list = vocabCore.filterAndSort(SAMPLE_LIST, { sort: 'review' });
    assert(list[0].word === 'audit', 'review 排序：空 nextReviewAt 最前');
    // added 降序（MASTERED_ITEM 今日最新；筛 MASTERED 单独验证）
    list = vocabCore.filterAndSort(SAMPLE_LIST, { sort: 'added', status: 'MASTERED' });
    assert(list.length === 1 && list[0].word === 'budget', 'added 排序：最新添加在前');
    // alpha
    list = vocabCore.filterAndSort(SAMPLE_LIST, { sort: 'alpha', status: 'MASTERED' });
    assert(list[0].word === 'budget', 'alpha 排序：localeCompare');
  }

  section('四、例句分词（renderContext 对齐）');
  {
    const parts = vocabCore.splitContext('The resilient economy recovered.', 'resilient');
    assert(parts.length === 3 && parts[1].hit === true && parts[1].text === 'resilient', 'splitContext：命中段标记 hit');
    assert(parts[0].text === 'The ' && parts[2].text === ' economy recovered.', 'splitContext：前后段保留空格');

    const ci = vocabCore.splitContext('Resilient RESILIENT resilient', 'resilient');
    assert(ci.length === 5 && ci[0].hit && !ci[1].hit && ci[2].hit && !ci[3].hit && ci[4].hit,
      'splitContext：大小写不敏感命中（交替 hit/text）');

    assert(vocabCore.splitContext(null, 'x').length === 0, 'splitContext：无文本 → []');
    assert(vocabCore.splitContext('abc', null).length === 0, 'splitContext：无词 → []');
  }

  section('五、decorateItem（WXML 就绪字段）');
  {
    const d = vocabCore.decorateItem(RICH);
    assert(d.due === false && d.mastered === false, 'RICH：未到期未掌握');
    assert(d.dateText === '10/1', 'RICH：日期徽章 = formatDate');
    assert(d.defText === '有弹性的；能快速恢复的', 'defText：definitions[0].meaning_cn 优先');
    assert(d.phonetic === '/rɪˈzɪliənt/', 'phonetic：us 优先');
    assert(d.playUrl === 'https://dict/us-resilient.mp3', 'playUrl：audio_urls.us 优先');
    assert(d.inflChips.length === 1 && d.inflChips[0].label === '形容词', 'inflChips：空值过滤只剩形容词');
    assert(d.hasEty === true, 'hasEty：root 存在');
    assert(d.mmss === '2:05', 'mmss：125s → 2:05');
    assert(d.origKey === 'ep1:resilient', 'origKey：episodeid:word');
    assert(d.dictExamples.length === 1 && d.dictExamples[0].parts.length === 3, 'dictExamples：例句分词预计算');
    assert(d.contextParts[1].hit === true, 'contextParts：上下文句命中段');

    const d2 = vocabCore.decorateItem(DUE_ITEM);
    assert(d2.due === true && d2.dateText === '需要复习', 'DUE：需要复习文案');
    assert(d2.defText === '词义2', 'defText 降级链：无 dictData 用 definition');

    const d3 = vocabCore.decorateItem(MASTERED_ITEM);
    assert(d3.mastered === true && d3.dateText === '', 'MASTERED：日期徽章为空（渲染已掌握徽章）');

    const d4 = vocabCore.decorateItem(makeItem(5, { definition: null, dictData: null }));
    assert(d4.defText === '暂无定义', 'defText 兜底：暂无定义');
  }

  /* ---- 六、闪卡复习纯逻辑 ---- */

  section('六、复习页纯逻辑（T1.5 闪卡模式）');
  {
    const due = vocabCore.buildDueQueue(SAMPLE_LIST);
    assert(due.length === 2 && due[0].word === 'audit' && due[1].word === 'vibrant', 'buildDueQueue：isDue && !MASTERED（2 条）');
    assert(srs.getIntervalLabel(2, 0) === '今天', 'SRS 副文案口径：忘记 = 今天（对齐 Android nextIntervalLabel）');
    assert(srs.getIntervalLabel(2, 1) === '1天', 'SRS 副文案口径：模糊 = 1天');
    assert(srs.getIntervalLabel(2, 2) === '7天', 'SRS 副文案口径：认识/简单 = 升级后阶梯（3级→7天）');
  }

  /* ---- 七、tts.playUrl ---- */

  section('七、tts.playUrl（直链播放 + TTS 兜底 + toggle）');
  {
    // 1. 直链成功
    let ok = await tts.playUrl('https://dict/us-a.mp3', 'apple');
    await sleep(30); // 等待 downloadFile 中转完成
    const ctx1 = audioInstances[audioInstances.length - 1];
    assert(ok === true && dlLog[0] === 'https://dict/us-a.mp3' && ctx1.played === 1,
      'playUrl：直链经 downloadFile 中转后本地开播（真机 504 修复）');
    assert(tts.getState().playingUrl === 'https://dict/us-a.mp3', 'playUrl：playingUrl 状态');
    ctx1.__fire('ended');
    assert(tts.getState().playingUrl === null, '播放结束：playingUrl 清空');

    // 2. 同 url toggle 停止
    await tts.playUrl('https://dict/us-a.mp3', 'apple');
    ok = await tts.playUrl('https://dict/us-a.mp3', 'apple');
    assert(ok === false && tts.getState().playingUrl === null, '同 url 再点：toggle 停止');

    // 3. onError → fallback TTS 合成
    apiResponses['/api/dictionary/youdao'] = { success: true, speakUrl: 'https://tts/apple.mp3' };
    await tts.playUrl('https://dict/broken.mp3', 'apple');
    await sleep(30);
    const ctx3 = audioInstances[audioInstances.length - 1];
    assert(ctx3.played === 1, '直链（本地中转）尝试开播');
    ctx3.__fire('error');
    await sleep(30); // fallback speak → youdao 请求 → downloadAudio → 本地播放
    const youdaoCall = requestLog.find(
      (r) => r.path === '/api/dictionary/youdao' && r.data && r.data.word === 'apple',
    );
    assert(!!youdaoCall, 'onError → TTS 兜底请求 /api/dictionary/youdao');
    const ctx4 = audioInstances[audioInstances.length - 1];
    assert(ctx4.played === 1 && dlLog.includes('https://tts/apple.mp3'), 'TTS 兜底（下载中转）开播 speakUrl');

    // 4. 无 url 有 fallback → 直接 TTS
    await tts.stop();
    const before = requestLog.filter((r) => r.path === '/api/dictionary/youdao').length;
    await tts.playUrl(null, 'banana');
    assert(requestLog.filter((r) => r.path === '/api/dictionary/youdao').length === before + 1,
      '无 url：直接走 TTS 合成');

    // 5. 无 url 无 fallback → toast 暂无发音
    toastCalls.length = 0;
    const okNone = await tts.playUrl(null, null);
    assert(okNone === false && toastCalls.includes('暂无发音'), '无 url 无 fallback：toast 暂无发音');
    await tts.stop();
    delete apiResponses['/api/dictionary/youdao'];
  }

  /* ---- 八、vocab-notebook 组件 ---- */

  section('八、vocab-notebook：数据接入与派生（T1.1/T1.2）');
  {
    // 每次请求返回全新副本（乐观翻转/删除会 mutate 列表项，section 间隔离）
    apiResponses['/api/vocabulary/all'] = () => ({ success: true, data: freshSample() });
    apiResponses['/api/user/subscription/status'] = { success: true, role: 'USER' };
    requestLog.length = 0;
    const nb = makeInstance(notebookDef);
    nb._attached();
    await tick();
    assert(!requestLog.some((r) => r.path === '/api/vocabulary/all'), 'attached（active=false）：懒加载不请求');
    // active 切 true 触发 observer 加载
    fireObserver(nb, 'active', true);
    await tick(); await tick();
    assert(nb.data.loaded === true, 'active → 数据加载完成');
    assert(nb.data.stats.total === 4 && nb.data.stats.due === 2 && nb.data.stats.mastered === 1, 'stats 派生');
    assert(nb.data.todayAddedCount === 1, 'todayAddedCount 派生');
    assert(nb.data.quota.primaryStatusText === '4/50 · 还能收藏46个', 'quota 文案派生');
    assert(nb.data.filteredList.length === 3, 'filteredList 默认 LEARNING 3 条');
    assert(nb.data.filteredList[0].defText !== undefined, 'filteredList 已 decorate（WXML 就绪）');
    global.__nb = nb;
  }

  section('九、vocab-notebook：筛选交互与手风琴（T1.3）');
  {
    const nb = global.__nb;
    nb.onFilterTap({ currentTarget: { dataset: { status: 'MASTERED' } } });
    assert(nb.data.filterStatus === 'MASTERED' && nb.data.filteredList.length === 1, '切已掌握 pill：列表过滤');
    assert(nb.data.filteredList[0].word === 'budget', '已掌握列表内容正确');
    nb.onFilterTap({ currentTarget: { dataset: { status: 'LEARNING' } } });

    nb.onSearchInput({ detail: { value: 'vibrant' } });
    assert(nb.data.filteredList.length === 1 && nb.data.filteredList[0].word === 'vibrant', '搜索过滤');
    nb.onClearSearch();
    assert(nb.data.searchQuery === '' && nb.data.filteredList.length === 3, '清空搜索恢复');

    nb.onSortTap({ currentTarget: { dataset: { sort: 'added' } } });
    assert(nb.data.sortMethod === 'added' && nb.data.filteredList.length === 3, '排序切换：状态更新并重算列表（排序语义见第三节）');

    // 手风琴：展开 → scrollInto 指向卡顶；再点收起
    nb.onCardTap({ currentTarget: { dataset: { id: RICH.vocabularyid } } });
    assert(nb.data.expandedId === RICH.vocabularyid, '点卡展开');
    await sleep(80);
    assert(nb.data.scrollInto === 'vn-top-' + RICH.vocabularyid, '展开后 scroll-into-view 指向卡顶');
    nb.onCardTap({ currentTarget: { dataset: { id: RICH.vocabularyid } } });
    assert(nb.data.expandedId === null, '再点收起');
  }

  section('十、vocab-notebook：发音 / 原声 / 词典链接（T1.4）');
  {
    const nb = global.__nb;
    const clipPlayCalls = [];
    const origClipPlay = audioClip.play;
    audioClip.play = (p) => clipPlayCalls.push(p);

    const ttsCalls = [];
    const origTtsPlayUrl = tts.playUrl;
    tts.playUrl = (url, text) => { ttsCalls.push({ url, text }); return Promise.resolve(true); };
    const speakCalls = [];
    const origSpeak = tts.speak;
    tts.speak = (t) => { speakCalls.push(t); return Promise.resolve(true); };

    nb.onPlayWord({ currentTarget: { dataset: { id: RICH.vocabularyid } } });
    assert(ttsCalls.length === 1 && ttsCalls[0].url === 'https://dict/us-resilient.mp3' && ttsCalls[0].text === 'resilient',
      '紧凑面发音：us 直链 + word 兜底');

    nb.onPlayPhon({ currentTarget: { dataset: { url: 'https://dict/uk-resilient.mp3', word: 'resilient' } } });
    assert(ttsCalls[1] && ttsCalls[1].url === 'https://dict/uk-resilient.mp3', '音标胶囊发音：指定音源');

    nb.onPlayContext({ currentTarget: { dataset: { text: RICH.contextSentence } } });
    assert(speakCalls.length === 1 && speakCalls[0] === RICH.contextSentence, 'AI 朗读例句：tts.speak');

    nb.onPlayOriginal({
      currentTarget: {
        dataset: { episodeid: 'ep1', word: 'resilient', timestamp: 125, context: RICH.contextSentence },
      },
    });
    assert(clipPlayCalls.length === 1 && clipPlayCalls[0].key === 'ep1:resilient'
      && clipPlayCalls[0].contextSentence === RICH.contextSentence, '原声播放：audio-clip 参数（key/定位句）');

    clipboardCalls.length = 0;
    nb.onCopyDict({ currentTarget: { dataset: { url: RICH.webUrl } } });
    assert(clipboardCalls[0] === RICH.webUrl && toastCalls.includes('词典链接已复制'), '查看网络词典：复制链接 + toast');

    tts.playUrl = origTtsPlayUrl;
    tts.speak = origSpeak;
    audioClip.play = origClipPlay;
  }

  section('十一、vocab-notebook：乐观翻转与删除（T1.4）');
  {
    const nb = global.__nb;
    // 乐观翻转：status 接口成功
    apiResponses['/api/vocabulary/status'] = { success: true, message: '已标记为掌握' };
    let item = nb._list.find((v) => v.vocabularyid === DUE_ITEM.vocabularyid);
    const before = item.status;
    await nb.onToggleStatus({ currentTarget: { dataset: { id: DUE_ITEM.vocabularyid } } });
    await tick();
    item = nb._list.find((v) => v.vocabularyid === DUE_ITEM.vocabularyid);
    assert(item.status !== before, '乐观翻转：本地 status 已变');
    assert(nb.data.stats.mastered === 2, '翻转后 stats 重派生（mastered +1）');

    // 失败回滚
    apiResponses['/api/vocabulary/status'] = { success: false, message: '失败' };
    const stBefore = item.status;
    await nb.onToggleStatus({ currentTarget: { dataset: { id: DUE_ITEM.vocabularyid } } });
    await tick(); await tick();
    item = nb._list.find((v) => v.vocabularyid === DUE_ITEM.vocabularyid);
    assert(item.status === stBefore, 'status 接口失败：回滚原状态');

    // 删除：确认弹窗（默认 confirm=true）→ delete 成功 → 本地移除
    apiResponses['/api/vocabulary/delete'] = { success: true };
    const delTarget = MASTERED_ITEM.vocabularyid;
    await nb.onDeleteTap({ currentTarget: { dataset: { id: delTarget } } });
    await tick();
    assert(modalCalls.some((m) => m.title === '确认彻底删除'), '删除前两段式确认弹窗');
    assert(!nb._list.some((v) => v.vocabularyid === delTarget), '确认后本地移除');
    assert(nb.data.stats.total === 3, '删除后 stats.total 联动（配额卡容量随删除实时联动）');
    assert(toastCalls.includes('已从生词本中彻底删除'), '删除成功 toast');

    // 复习入口跳转
    navCalls.length = 0;
    nb.onStartReview();
    assert(navCalls[0] === '/pages/review/vocab-review/index', '开始复习 → vocab-review 页');
  }

  /* ---- 十二、复习页 ---- */

  section('十二、vocab-review：闪卡队列初始化（T1.5 闪卡模式）');
  {
    apiResponses['/api/vocabulary/all'] = () => ({ success: true, data: freshSample() });
    requestLog.length = 0;
    const page = makeInstance(reviewPageDef);
    page.onLoad();
    await tick(); await tick();
    assert(page.data.loading === false, '入场加载完成');
    assert(page.data.queue.length === 2, '队列 = due 且非 MASTERED（2 张）');
    assert(page.data.progress === 0, '初始进度 0（未翻面不计，(0+0)/2）');
    assert(page.data.current && page.data.current.word === page.data.queue[0].word, 'current 快照 = 队首卡（WXML 就绪字段）');
    assert(page.data.current.intervalPreviews.forgot === '今天', 'SRS 副文案：忘记=今天（Leitner 预演入队时计算）');
    assert(page.data.isFlipped === false, '初始正面态');
    global.__vr = page;
  }

  {
    section('十三、闪卡翻转 / 滑动切卡 / FSRS 提交');
    const page = global.__vr;
    // 翻面：进度推进与回落
    page.onFlip();
    assert(page.data.isFlipped === true, '点击卡片 → 翻面（Front→Back）');
    assert(page.data.progress === 50, '翻面推进进度条 ((0+1)/2)');
    page.onFlip();
    assert(page.data.isFlipped === false && page.data.progress === 0, '再点翻回正面，进度回落');

    // 浏览式切卡（不评分）：下一张 / 上一张
    page.goNextCard();
    assert(page.data.index === 1 && page.data.isFlipped === false, 'goNextCard：进入下一张（浏览式不评分）');
    page.goPrevCard();
    assert(page.data.index === 0, 'goPrevCard：回到上一张（可重看重评）');

    // 手势：横移超阈值切卡 + 跟手反馈
    page.onTouchStart({ touches: [{ clientX: 300, clientY: 200 }] });
    page.onTouchMove({ touches: [{ clientX: 200, clientY: 202 }] });
    assert(page.data.dragOffset === -100, '横移跟手反馈（dragOffset=-100）');
    page.onTouchEnd();
    assert(page.data.index === 1 && page.data.dragOffset === 0, '左滑超 80dp 阈值 → 下一张，偏移复位');

    // 纵向滚动锁定：背面滚动区不误触切卡
    page.goPrevCard();
    page.onTouchStart({ touches: [{ clientX: 300, clientY: 200 }] });
    page.onTouchMove({ touches: [{ clientX: 295, clientY: 320 }] });
    page.onTouchEnd();
    assert(page.data.index === 0, '纵向手势锁定：不切卡（背面滚动保护）');

    // FSRS 提交：POST 参数 + 结果累计
    apiResponses['/api/vocabulary/review'] = {
      success: true,
      data: { vocabularyid: page.data.queue[0].vocabularyid, proficiency: 3, nextReviewAt: FUTURE, daysAdded: 7 },
    };
    requestLog.length = 0;
    page.onFlip();
    await page.onSubmit({ currentTarget: { dataset: { quality: 2 } } });
    await tick();
    const reviewCall = requestLog.find((r) => r.path === '/api/vocabulary/review');
    assert(!!reviewCall && reviewCall.data.quality === 2, 'POST /api/vocabulary/review {vocabularyid, quality}');
    assert(page.data.index === 1 && page.data.isFlipped === false, '提交后进入下一卡（翻面复位）');
    assert(page.data.results.length === 1 && page.data.results[0].qualityLabel === '认识', '结果累计（qualityLabel 派生）');

    // 回滑重评：覆盖旧结果（对齐 Android results.filterNot）
    page.goPrevCard();
    page.onFlip();
    await page.onSubmit({ currentTarget: { dataset: { quality: 0 } } });
    await tick();
    assert(page.data.results.length === 1 && page.data.results[0].quality === 0,
      '同词重评覆盖旧结果（回滑重测场景）');

    // 乐观更新 + 队列项 SRS 副文案按新等级重算
    const qid = page.data.results[0].vocabularyid;
    const updated = page._list.find((v) => v.vocabularyid === qid);
    assert(updated.proficiency === 3, '_list 乐观更新 proficiency');
    const qItem = page.data.queue.find((v) => v.vocabularyid === qid);
    assert(qItem.intervalPreviews.good === srs.getIntervalLabel(3, 2),
      '队列项 SRS 副文案按新等级重算（回看时预演准确）');

    // 最后一张 → 总结页（此时 index 已随重评提交推进到最后一张）
    page.onFlip();
    assert(page.data.isFlipped === true, '显示答案翻面');
    await page.onSubmit({ currentTarget: { dataset: { quality: 1 } } });
    await tick();
    assert(page.data.showSummary === true, '最后一张提交 → 总结页');
    assert(page.data.summary.total === 2 && page.data.summary.forgot === 1 && page.data.summary.hard === 1,
      '总结 2×2 统计（重评覆盖后：忘记1 + 模糊1）');
    assert(page.data.progress === 100, '总结页进度 100%');

    // 再来一轮：仅忘记子集
    const forgotId = page.data.results.find((r) => r.quality === srs.ReviewQuality.FORGOT).vocabularyid;
    await page.onRetry();
    await tick(); await tick();
    assert(page.data.queue.length === 1 && page.data.queue[0].vocabularyid === forgotId,
      '再来一轮：忘记子集重建队列');
    assert(page.data.results.length === 0 && page.data.index === 0, '再来一轮：结果与序号复位');
  }

  {
    section('十四、vocab-review：空队列与 handler 恢复');
    apiResponses['/api/vocabulary/all'] = { success: true, data: [MASTERED_ITEM, RICH] };
    toastCalls.length = 0;
    const p2 = makeInstance(reviewPageDef);
    p2.onLoad();
    await tick(); await tick();
    assert(toastCalls.includes('暂无到期生词'), '全无到期词：toast 提示');
    await sleep(700);
    assert(navBackCalls >= 1, '空队列自动退回');

    // quota handler 保存-恢复
    const saved = () => {};
    tts.setQuotaHandler(saved);
    const p3 = makeInstance(reviewPageDef);
    apiResponses['/api/vocabulary/all'] = { success: true, data: SAMPLE_LIST };
    p3.onLoad();
    await tick();
    assert(tts.getQuotaHandler() !== saved, 'onLoad：注册本页 handler（覆盖宿主）');
    p3.onUnload();
    assert(tts.getQuotaHandler() === saved, 'onUnload：恢复宿主 handler（不误清复习 Tab 组件注册）');
    tts.setQuotaHandler(null);
  }

  /* ---- 十五、WXML 结构断言 ---- */

  section('十五、WXML 结构与红线扫描');
  {
    assert(WXML_NOTEBOOK.includes('<quota-card'), 'notebook：quota-card 配额卡挂载');
    assert(WXML_NOTEBOOK.includes('premiumTitle="PRO 无限收藏 · 已收 {{stats.total}} 词"'), 'PRO 态文案逐字');
    assert(WXML_NOTEBOOK.includes('<premium-modal'), 'notebook：premium-modal 挂载（TTS 配额墙）');
    assert(WXML_NOTEBOOK.includes('根据遗忘曲线'), '复习横幅文案');
    assert(WXML_NOTEBOOK.includes('暂无收藏生词'), '全局空态文案');
    assert(WXML_NOTEBOOK.includes('空空如也，暂无已掌握的单词'), '筛选空态文案（两态区分）');
    assert(WXML_NOTEBOOK.includes('原声出处'), '原声出处卡');
    assert(WXML_NOTEBOOK.includes('标记为已掌握') && WXML_NOTEBOOK.includes('彻底删除'), '卡片操作按钮');
    assert(WXML_NOTEBOOK.includes('catchtap="noop"'), '展开面板 catchtap 阻断冒泡');
    assert(WXML_NOTEBOOK.includes('vn-bottom-space'), '底部让位（迷你播放条）');

    assert(WXML_REVIEW.includes('显示答案'), 'SRS 底栏：显示答案');
    assert(WXML_REVIEW.includes('再来一轮'), '总结页：再来一轮');
    assert(WXML_REVIEW.includes('vr-flip'), '3D 翻卡结构');
    assert(WXML_REVIEW.includes('回忆词义，点击卡片查看答案'), '闪卡正面提示文案（截图复刻）');
    assert(WXML_REVIEW.includes('来自《{{current.episodeTitle}}》'), '正面/原声卡「来自《剧集名》」');
    assert(WXML_REVIEW.includes('>闪卡</text>'), '顶部灰底「闪卡」标签');
    assert(WXML_REVIEW.includes('psychology-primary.svg'), '顶部大脑图标（Material psychology）');
    assert(WXML_REVIEW.includes('vr-srs-btn'), 'FSRS 2×2 四档按钮');
    assert(WXML_REVIEW.includes('data-quality="0"') && WXML_REVIEW.includes('data-quality="3"'), '四档 quality 0-3 绑定');
    assert(WXML_REVIEW.includes('intervalPreviews.forgot') && WXML_REVIEW.includes('intervalPreviews.easy'), '四档副文案 = Leitner 间隔预演');
    ['补全句子', '选择正确释义', '中译英', '看释义猜词', '读音提示', 'onAnswerInput'].forEach((label) => {
      assert(!WXML_REVIEW.includes(label), `四题型残留已清除：${label}`);
    });
    assert(WXML_REVIEW.includes('<premium-modal'), '复习页：premium-modal 挂载');

    // WXML 绑定零方法调用红线（3.B.4 六轮教训）
    const files = [
      ['vocab-notebook', WXML_NOTEBOOK],
      ['vocab-review', WXML_REVIEW],
    ];
    const methodCallRe = /\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|find|some|every)\(/;
    files.forEach(([name, wxml]) => {
      const offenders = wxml.split('\n').filter((l) => methodCallRe.test(l));
      assert(offenders.length === 0, `${name} WXML：绑定表达式零方法调用${offenders.length ? '（违规行：' + offenders[0].trim() + '）' : ''}`);
    });

    // 3D 翻卡关键样式
    const reviewCss = fs.readFileSync(
      path.join(__dirname, '../pages/review/vocab-review/index.wxss'), 'utf8');
    assert(reviewCss.includes('perspective: 1200px'), '翻卡：perspective 1200（对齐 Web）');
    assert(reviewCss.includes('rotateY(180deg)'), '翻卡：rotateY 180');
    assert(reviewCss.includes('-webkit-backface-visibility'), '翻卡：backface-visibility 加 -webkit- 前缀');
    assert(reviewCss.includes('0.6s cubic-bezier(0.4, 0, 0.2, 1)'), '翻卡：0.6s cubic-bezier 过渡曲线');
    const nbCss = fs.readFileSync(
      path.join(__dirname, '../components/review/vocab-notebook/index.wxss'), 'utf8');
    assert(nbCss.includes('--mini-player-height'), 'notebook：底部让位引用迷你条高度变量');
  }

  /* ==================== 汇总 ==================== */

  console.log('\n----------------------------------------');
  if (failed === 0) {
    console.log(`✅ 全部通过：${passed} 断言`);
  } else {
    console.error(`✗ ${failed} 项失败：`);
    failures.forEach((f) => console.error('  - ' + f));
    process.exitCode = 1;
  }
})();
