/**
 * scripts/test-pron-list.js — 弱项列表 T4.4 自动化测试
 * （REVIEW-TASK 阶段 4：完整复刻 Android PronunciationNotebookScreen 的
 *  StatsPanelHeader / ReviewPlanBanner / PhonemeRadarCard / WeakSentenceListCard）
 *
 * 三层驱动：
 *   1. utils/pron-core 纯逻辑——classifyScore 三档 / formatZhDate 中文化（ISO 偏移/
 *      纯日期/非法回退）/ phonemeRadarPoints top6 '/音素/' / notebookStats
 *      （weakestPhoneme + mastered≥85）/ decorateWeakRow（lastScore=overall??accuracy、
 *      tone、scoreText、dateText、兜底）；
 *   2. components/review/pron-list——notebook 派生（统计三值/行装饰/锁定数/雷达就绪）/
 *      达人榜与闯关导航 / 弱项句行深链 speech-eval?id&focus / 锁定卡弹窗 vars /
 *      雷达 canvas 自绘（#4F46E5 + 6 维标签）/ 深色重绘 / 空态分支（无弱项/雷达<3 点）；
 *   3. pron-notebook 集成 + WXML/WXSS 结构：挂载 / 文案逐字 / 色值原值 /
 *      绑定零方法调用红线。
 *
 * 运行：node scripts/test-pron-list.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toastCalls = [];
const navCalls = [];
const requestLog = [];
const apiResponses = {};

function resolveRequest(opts) {
  const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestLog.push({ path: p, method: opts.method || 'GET', data: opts.data });
  const hit = apiResponses[p];
  if (hit instanceof Error) {
    opts.fail && opts.fail({ errMsg: hit.message });
    return;
  }
  opts.success({ statusCode: 200, data: typeof hit === 'function' ? hit(opts.data) : hit });
}

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: () => {},
  navigateTo: (o) => navCalls.push(o.url),
  navigateBack: () => {},
  switchTab: (o) => navCalls.push(o.url),
  request: resolveRequest,
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  getAppBaseInfo: () => ({ theme: 'light' }),
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 800, statusBarHeight: 20, pixelRatio: 2 }),
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 800, statusBarHeight: 20, theme: 'light', pixelRatio: 2 }),
};

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
  if (def.lifetimes && def.lifetimes.attached) inst._attached = def.lifetimes.attached.bind(inst);
  if (def.observers) inst._observers = def.observers;
  return inst;
}

function fireObserver(inst, key, value) {
  inst.data[key] = value;
  if (inst._observers && inst._observers[key]) inst._observers[key].call(inst, value);
}

/* ==================== 用例数据 ==================== */

/** 完整 notebook（非会员试用：errors 3 条 + totalErrors 7） */
function fullNotebook() {
  return {
    isPremium: false,
    weakThreshold: 80,
    profile: { evalCount: 12, avgOverall: 71.4, avgAccuracy: 73.2, avgFluency: 68.9, avgIntegrity: 75.1, avgSpeed: 132.5, speedFitScore: 95, cefrLevel: 'B1' },
    phonemeStats: [
      { phoneme: 'θ', avgScore: 55, count: 8, lowScoreCount: 5 },
      { phoneme: 'ð', avgScore: 62, count: 6, lowScoreCount: 2 },
      { phoneme: 'v', avgScore: 75, count: 4, lowScoreCount: 1 },
      { phoneme: 'ŋ', avgScore: 86, count: 3, lowScoreCount: 0 },
      { phoneme: 'x', avgScore: 66, count: 2, lowScoreCount: 1 },
      { phoneme: 'ʃ', avgScore: 90, count: 2, lowScoreCount: 0 },
      { phoneme: 'z', avgScore: 88, count: 1, lowScoreCount: 0 },
    ],
    totalErrors: 7,
    isTrialMode: true,
    errors: [
      { recognitionid: 101, episodeid: 'ep1', episodeTitle: 'Tech Talk', episodeCoverUrl: 'https://oss/c1', targetText: 'The theory is quite clear.', targetStartTime: 12, subtitleId: 55, accuracyScore: 61.2, overallScore: 58.4, speed: 120, recognitionDate: '2026-09-07T10:00:00.000Z' },
      { recognitionid: 102, episodeid: 'ep2', episodeTitle: 'Daily Life', episodeCoverUrl: 'https://oss/c2', targetText: 'Think about both options.', targetStartTime: 88, subtitleId: null, accuracyScore: 70, overallScore: null, speed: 118, recognitionDate: '2026-08-15T02:30:00.000Z' },
      { recognitionid: 103, episodeid: 'ep3', episodeTitle: '', episodeCoverUrl: '', targetText: 'A vibrant city.', targetStartTime: 5, subtitleId: 9, accuracyScore: null, overallScore: 82, speed: null, recognitionDate: '2026-09-26T16:00:00.000Z' },
    ],
  };
}

function makeCanvasNode() {
  const ops = { strokes: 0, fills: 0, fillTexts: [], strokeStyles: [], fillStyles: [], fonts: [], aligns: [], baselines: [], lineWidths: [], scaled: null, cleared: null };
  const ctx = {
    set strokeStyle(v) { ops.strokeStyles.push(v); },
    get strokeStyle() { return ops.strokeStyles[ops.strokeStyles.length - 1]; },
    set fillStyle(v) { ops.fillStyles.push(v); },
    get fillStyle() { return ops.fillStyles[ops.fillStyles.length - 1]; },
    set font(v) { ops.fonts.push(v); },
    get font() { return ops.fonts[ops.fonts.length - 1]; },
    set lineWidth(v) { ops.lineWidths.push(v); },
    get lineWidth() { return ops.lineWidths[ops.lineWidths.length - 1]; },
    set textAlign(v) { ops.aligns.push(v); },
    get textAlign() { return 'left'; },
    set textBaseline(v) { ops.baselines.push(v); },
    get textBaseline() { return 'top'; },
    setTransform() {},
    scale(x, y) { ops.scaled = { x, y }; },
    clearRect(x, y, w, h) { ops.cleared = { x, y, w, h }; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() { ops.strokes += 1; },
    fill() { ops.fills += 1; },
    fillText(text, x, y) { ops.fillTexts.push({ text, x, y }); },
  };
  return { node: { width: 0, height: 0, getContext: () => ctx }, ops };
}

/* ==================== 1. pron-core 纯逻辑 ==================== */

const pronCore = require('../utils/pron-core');

section('classifyScore（≥80 good / ≥60 mid / 其余 bad）');
assert(pronCore.classifyScore(80) === 'good' && pronCore.classifyScore(100) === 'good', '≥80 → good');
assert(pronCore.classifyScore(79.4) === 'mid' && pronCore.classifyScore(60) === 'mid' && pronCore.classifyScore(79.6) === 'good', '60-79 → mid（入参先 round：79.6→80 good）');
assert(pronCore.classifyScore(59) === 'bad' && pronCore.classifyScore(0) === 'bad', '<60 → bad');

section('formatZhDate（Android formatZhDate 口径）');
assert(pronCore.formatZhDate('2026-09-07T10:00:00.000Z') === '2026年9月7日', 'ISO 带偏移 → 中文日期（本地时区）');
assert(pronCore.formatZhDate('2026-08-15') === '2026年8月15日', '纯日期 → 中文日期');
assert(pronCore.formatZhDate('bad-date') === 'bad-date', '非法 → 回退原串前 10 位');
assert(pronCore.formatZhDate('') === '' && pronCore.formatZhDate(null) === '', '空 → 空串');

section('phonemeRadarPoints（top6 / 包斜杠标签）');
(function () {
  const pts = pronCore.phonemeRadarPoints(fullNotebook().phonemeStats);
  assert(pts.length === 6, '最弱前 6 项');
  assert(pts[0].dim === '/θ/' && pts[0].score === 55, '标签包斜杠 + 均分取整');
  assert(pronCore.phonemeRadarPoints([{ phoneme: 'a', avgScore: 50 }], 1).length === 1, 'limit 可调');
})();

section('notebookStats（weakestPhoneme / mastered≥85）');
(function () {
  const s = pronCore.notebookStats(fullNotebook());
  assert(s.weakestPhoneme === '/θ/', '最弱音素 /θ/（首项包斜杠）');
  assert(s.masteredPhonemeCount === 3, 'avgScore≥85 计数（ŋ 86 / ʃ 90 / z 88 三项达标）');
})();
assert(pronCore.notebookStats(null).weakestPhoneme === null, 'null notebook → null 音素');
assert(pronCore.notebookStats({ phonemeStats: [] }).weakestPhoneme === null, '空统计 → null');

section('decorateWeakRow（lastScore=overall??accuracy + 徽章/日期预计算）');
(function () {
  const rows = fullNotebook().errors.map(pronCore.decorateWeakRow);
  assert(rows[0].lastScore === 58 && rows[0].tone === 'bad' && rows[0].scoreText === '上次得分: 58', 'overall 58.4 → 58 bad（四舍五入）');
  assert(rows[1].lastScore === 70 && rows[1].tone === 'mid', 'overall null → accuracy 70 mid');
  assert(rows[2].lastScore === 82 && rows[2].tone === 'good', 'overall 82 good（accuracy null 不干扰）');
  assert(rows[0].dateText === '2026年9月7日', '中文日期预计算');
  assert(rows[2].episodeTitle === '未知播客' && rows[1].subtitleId === null, '空剧集名兜底 / subtitleId null 保持');
})();
(function () {
  const r = pronCore.decorateWeakRow(null);
  assert(r.lastScore === 0 && r.tone === 'bad' && r.episodeTitle === '未知播客', 'null 记录全兜底');
})();

/* ==================== 2. pron-list 组件 ==================== */

async function main() {
section('pron-list 组件（派生 / 导航 / 雷达 / 弹窗 / 空态）');

require('../components/review/pron-list/index.js');
const def = componentDefs.__last;
assert(!!def, 'Component 定义捕获成功');
assert(def.properties.notebook, 'properties：notebook');

const { node: radarNode, ops: radarOps } = makeCanvasNode();
let radarQueries = 0;
function makeInst() {
  const inst = makeInstance(def);
  inst.createSelectorQuery = function () {
    radarQueries += 1;
    return {
      select() {
        return {
          fields() { return this; },
          exec(cb) { cb([{ node: radarNode, width: 320, height: 240 }]); },
        };
      },
    };
  };
  return inst;
}

// —— 完整 notebook：派生 + 雷达自绘 + 导航 ——
let inst = makeInst();
inst._attached();
fireObserver(inst, 'notebook', fullNotebook());
await settle();
assert(inst.data.totalErrors === 7, '待复习句子 = totalErrors 全量口径');
assert(inst.data.weakestPhoneme === '/θ/', '最弱音素 /θ/');
assert(inst.data.masteredCount === 3, '已攻克音素 = ≥85 计数');
assert(inst.data.rows.length === 3 && inst.data.rows[0].scoreText === '上次得分: 58', '行装饰落地');
assert(inst.data.lockedCount === 4, '锁定数 = 7 − 3 条切片');
assert(inst.data.premiumVars && inst.data.premiumVars.totalErrors === 4, '锁定卡弹窗 vars {totalErrors:4}');
assert(inst.data.radarReady === true, '7 音素 → 雷达就绪');
assert(radarQueries >= 1 && radarNode.width === 640, '雷达 canvas 查询 + DPR 自绘');
assert(radarOps.strokeStyles.indexOf('#4F46E5') >= 0, '音素雷达描边 #4F46E5（PhonemeRadarColor）');
assert(
  radarOps.fillTexts.map((t) => t.text).slice(0, 6).join(',') === '/θ/,/ð/,/v/,/ŋ/,/x/,/ʃ/',
  '雷达 6 维 /音素/ 标签',
);
assert(radarOps.fillTexts.length === 6, '恰 6 个维度标签');

// 导航：达人榜 / 闯关 / 弱项句行深链
navCalls.length = 0;
inst.openLeaderboard();
inst.openPractice();
inst.openSpeechEval({ currentTarget: { dataset: { index: 0 } } });
inst.openSpeechEval({ currentTarget: { dataset: { index: 1 } } }); // subtitleId null → 不带 focus
assert(
  navCalls[0] === '/pages/review/leaderboard/index' && navCalls[1] === '/pages/review/practice/index',
  '达人榜/闯关导航（T4.5 页面）',
);
assert(navCalls[2] === '/pages/speech-eval/index?id=ep1&focus=55', '弱项句行深链 id + focus=subtitleId');
assert(navCalls[3] === '/pages/speech-eval/index?id=ep2', 'subtitleId null → 深链不带 focus');
navCalls.length = 0;
inst.openSpeechEval({ currentTarget: { dataset: { index: 99 } } });
assert(navCalls.length === 0, '越界行 no-op');

// 锁定卡弹窗
inst.openUnlock();
assert(inst.data.premiumVisible === true, '锁定卡点击 → premium-modal(pronunciation_locked)');
inst.onModalClose();
assert(inst.data.premiumVisible === false, '弹窗关闭复位');

// —— 空态：无弱项句子（横幅=全部完成 + 列表=太棒了） ——
const nbEmpty = fullNotebook();
nbEmpty.totalErrors = 0;
nbEmpty.errors = [];
nbEmpty.isTrialMode = false;
inst = makeInst();
inst._attached();
fireObserver(inst, 'notebook', nbEmpty);
await settle();
assert(inst.data.rows.length === 0 && inst.data.lockedCount === 0, '无弱项 → 行空 + 无锁定');

// —— 雷达 <3 点：数据积累中 ——
const nbFew = fullNotebook();
nbFew.phonemeStats = [{ phoneme: 'θ', avgScore: 55, count: 8, lowScoreCount: 5 }, { phoneme: 'ð', avgScore: 62, count: 6, lowScoreCount: 2 }];
radarQueries = 0;
inst = makeInst();
inst._attached();
fireObserver(inst, 'notebook', nbFew);
await settle();
assert(inst.data.radarReady === false, '<3 音素 → 雷达空态（数据积累中）');
assert(radarQueries === 0, '雷达空态不查画布');

// —— 深色：图标变体 + 雷达重绘换色 ——
radarOps.strokeStyles.length = 0;
fireObserver(inst, 'dark', true);
await settle();
assert(
  inst.data.icons.mic.indexOf('mic-tertiary-dark.svg') >= 0 &&
    inst.data.icons.lockPrimary.indexOf('lock-primary-dark.svg') >= 0,
  '深色图标变体（mic/lock/track-changes 切 -dark；secondary/error/success 恒值）',
);
assert(
  inst.data.icons.emojiEventsSecondary.indexOf('emoji-events-secondary.svg') >= 0 &&
    inst.data.icons.trackChangesError.indexOf('track-changes-error.svg') >= 0,
  'secondary/error 图标双态恒值（Android DarkSecondary/LightError 同值）',
);

/* ==================== 3. 集成与结构 ==================== */

section('pron-notebook 集成 + WXML/WXSS 结构');

const nbJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.json'), 'utf8'));
assert(nbJson.usingComponents['pron-list'] === '/components/review/pron-list/index', 'pron-notebook 注册 pron-list');
const nbWxml = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxml'), 'utf8');
assert(/<pron-list notebook="\{\{notebook\}\}" \/>/.test(nbWxml), '弱项列表挂载（notebook 整包传递）');
assert(nbWxml.indexOf('coming') < 0, 'coming 占位退场（已加载态全量真实模块）');

const wxml = fs.readFileSync(path.join(__dirname, '../components/review/pron-list/index.wxml'), 'utf8');
assert(wxml.indexOf('发音弱项本') >= 0 && wxml.indexOf('针对性攻克发音短板，提升口语地道程度。') >= 0, '页头标题/副题逐字');
assert(wxml.indexOf('发音达人榜') >= 0, '达人榜入口文案');
assert(wxml.indexOf('待复习句子') >= 0 && wxml.indexOf('最弱音素') >= 0 && wxml.indexOf('已攻克音素') >= 0, '三统计卡标签逐字');
assert(wxml.indexOf('复习计划已就绪') >= 0 && wxml.indexOf('开始闯关复习') >= 0, '横幅标题/按钮逐字');
assert(wxml.indexOf('你有 {{totalErrors}} 个弱项句子需要复习。') >= 0, '横幅副文（N 占位）');
assert(wxml.indexOf('全部完成了！') >= 0 && wxml.indexOf('你做得很好，目前没有待复习的弱项句子。快去挑战新播客吧。') >= 0, '全部完成卡文案逐字');
assert(wxml.indexOf('薄弱音素诊断雷达') >= 0 && wxml.indexOf('数据积累中') >= 0 && wxml.indexOf('完成更多评测即可解锁雷达图') >= 0, '雷达卡标题/空态逐字');
assert(wxml.indexOf('待复习弱项句子') >= 0, '列表卡标题逐字');
assert(wxml.indexOf('还有 {{lockedCount}} 条弱项句子待攻克') >= 0, '锁定卡标题（N 占位）');
assert(wxml.indexOf('解锁 PRO 会员查看完整弱项本，开始针对性循环练习') >= 0 && wxml.indexOf('>解锁<') >= 0, '锁定卡副文/CTA 逐字');
assert(wxml.indexOf('太棒了！') >= 0 && wxml.indexOf('您目前没有待复习的弱项句子') >= 0, '列表空态逐字');
assert(wxml.indexOf('未知播客') < 0 && wxml.indexOf('{{item.episodeTitle}}') >= 0, '剧集名经 decorateWeakRow 兜底（wxml 直读字段）');
assert(/<premium-modal visible="\{\{premiumVisible\}\}" source="pronunciation_locked" vars="\{\{premiumVars\}\}"/.test(wxml), 'premium-modal 挂载 source=pronunciation_locked + vars');
assert(wxml.indexOf('id="plPhonemeRadar"') >= 0 && wxml.indexOf('type="2d"') >= 0, '雷达 canvas 2d');
assert(wxml.indexOf('pl-score--{{item.tone}}') >= 0 && wxml.indexOf('{{item.scoreText}}') >= 0, '得分徽章三档类 + 预计算文案');

const bindings = wxml.match(/\{\{[^}]+\}\}/g) || [];
assert(bindings.length > 0 && bindings.every((b) => !/\.\w+\(/.test(b)), 'WXML 绑定零方法调用红线');

const wxss = fs.readFileSync(path.join(__dirname, '../components/review/pron-list/index.wxss'), 'utf8');
(function () {
  const m = wxss.match(/\.pl-root \{[^}]+\}/);
  assert(
    !!m && m[0].indexOf('display: flex') >= 0 && m[0].indexOf('flex-direction: column') >= 0 && m[0].indexOf('gap: 24rpx') >= 0,
    '四块纵向间距 24rpx（Android spacedBy(12.dp) 同节奏）',
  );
})();
(function () {
  const nbWxss = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxss'), 'utf8');
  const m = nbWxss.match(/\.notebook-pad \{[^}]+\}/);
  assert(
    !!m && m[0].indexOf('gap: 24rpx') >= 0 && m[0].indexOf('flex-direction: column') >= 0,
    '卡片宿主 notebook-pad 同款 24rpx 间距（画像/诊断/弱项列表三卡节奏统一）',
  );
})();
assert(wxss.indexOf('#3d6a8d') >= 0 && wxss.indexOf('#1b3348') >= 0, '横幅双态原值（ReviewBannerLight/Dark）');
assert(wxss.indexOf('#2e8f6f') >= 0 && wxss.indexOf('#d2503f') >= 0 && wxss.indexOf('#d98a17') >= 0, '成功绿/错误红/secondary 原值');
assert(wxss.indexOf('#1f7a5c') >= 0 && wxss.indexOf('#4da989') >= 0, 'primary 双态原值');
assert(wxss.indexOf('#0a241b') >= 0, '深色 onPrimary #0A241B（Android DarkOnPrimary）');
assert(wxss.indexOf('44rpx') >= 0, '页头 titleLarge 22sp');
assert(wxss.indexOf('width: 112rpx') >= 0 && wxss.indexOf('border-radius: 20rpx') >= 0, '封面 56dp/圆角 10dp');
assert(
  /@media \(prefers-color-scheme: dark\)/.test(wxss) && /\.pl-root\.theme-light/.test(wxss),
  '深色双轨（媒体查询 + 手动浅色全量重声明）',
);

/* ==================== 汇总 ==================== */

console.log(`\n========== 弱项列表 T4.4 测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) {
  console.error('失败用例：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
}

main();
