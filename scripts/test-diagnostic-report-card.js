/**
 * scripts/test-diagnostic-report-card.js — AI 发音诊断报告卡 T4.3 自动化测试
 * （REVIEW-TASK 阶段 4：音素行 + tips 映射 + 免费 Top3/模糊锁定 + PRO 进步曲线）
 *
 * 三层驱动：
 *   1. utils/pron-core 纯逻辑——getPhonemeTip（22 条映射逐字/斜杠归一/兜底）/
 *      diagnosticRows（Top10 截取/免费 3 可见/barWidth ×0.4/三档进度条/两档符号色/
 *      meta 文案/tip 附着）/ diagnosticLockedCount / parseDiagnostic（信封/月份过滤
 *      升序）/ drawTrendChart（mock canvas：虚线网格/Y 轴 0-100/平滑折线 #4F46E5
 *      2.5px/半径 4 圆点/月份标签/DPR）；
 *   2. components/review/diagnostic-report-card——Component 捕获 + makeInstance：
 *      行派生/空态/解锁弹窗接线/PRO 曲线懒加载（成功重绘·缓存不重复拉·403 弹窗
 *      兜底收起·失败 toast 文案逐字）；
 *   3. pron-notebook 集成 + WXML/WXSS 结构：挂载传参/文案逐字/语义色原值/
 *      虚线+blur 锁定态/绑定零方法调用红线。
 *
 * 运行：node scripts/test-diagnostic-report-card.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toastCalls = [];
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
  const status = hit && hit.__status ? hit.__status : 200;
  const body = hit && hit.__status ? hit.body : hit;
  opts.success({ statusCode: status, data: typeof body === 'function' ? body(opts.data) : body });
}

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: () => {},
  navigateTo: () => {},
  navigateBack: () => {},
  switchTab: () => {},
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

function fireObserverKey(inst, key, patch) {
  Object.assign(inst.data, patch);
  if (inst._observers && inst._observers[key]) inst._observers[key].call(inst);
}

/* ==================== 用例数据 ==================== */

/** 音素统计（升序 = 最弱在前），覆盖三档分数与未映射音素 */
function sampleStats() {
  return [
    { phoneme: 'θ', avgScore: 55.4, count: 8, lowScoreCount: 5 }, // low / error 符号
    { phoneme: 'ð', avgScore: 62.4, count: 6, lowScoreCount: 2 }, // mid / warn
    { phoneme: 'v', avgScore: 75, count: 4, lowScoreCount: 1 }, // mid / warn
    { phoneme: 'ŋ', avgScore: 85.6, count: 3, lowScoreCount: 0 }, // good / warn（两档口径）
    { phoneme: 'x', avgScore: 66, count: 2, lowScoreCount: 1 }, // 未映射 → 兜底 tip
    { phoneme: 'ʃ', avgScore: 70, count: 2, lowScoreCount: 0 },
    { phoneme: 'z', avgScore: 72, count: 1, lowScoreCount: 0 },
    { phoneme: 'ɪ', avgScore: 74, count: 1, lowScoreCount: 0 },
    { phoneme: 'e', avgScore: 78, count: 1, lowScoreCount: 0 },
    { phoneme: 'ʌ', avgScore: 79, count: 1, lowScoreCount: 0 },
    { phoneme: 'l', avgScore: 82, count: 1, lowScoreCount: 0 }, // 第 11 条 → 截断
    { phoneme: 'r', avgScore: 88, count: 1, lowScoreCount: 0 }, // 第 12 条 → 截断
  ];
}

/** mock canvas node + 记录型 2d ctx */
function makeCanvasNode() {
  const ops = {
    strokes: 0,
    fills: 0,
    fillTexts: [],
    strokeStyles: [],
    fillStyles: [],
    lineWidths: [],
    dashs: [],
    arcs: 0,
    scaled: null,
    cleared: null,
  };
  const ctx = {
    set strokeStyle(v) { ops.strokeStyles.push(v); },
    get strokeStyle() { return ops.strokeStyles[ops.strokeStyles.length - 1]; },
    set fillStyle(v) { ops.fillStyles.push(v); },
    get fillStyle() { return ops.fillStyles[ops.fillStyles.length - 1]; },
    set lineWidth(v) { ops.lineWidths.push(v); },
    get lineWidth() { return ops.lineWidths[ops.lineWidths.length - 1]; },
    set font(v) { ops.fonts = ops.fonts || []; ops.fonts.push(v); },
    get font() { return (ops.fonts && ops.fonts[ops.fonts.length - 1]) || ''; },
    set textAlign(v) { ops.aligns = ops.aligns || []; ops.aligns.push(v); },
    get textAlign() { return 'left'; },
    set textBaseline(v) { ops.baselines = ops.baselines || []; ops.baselines.push(v); },
    get textBaseline() { return 'middle'; },
    setLineDash(v) { ops.dashs.push(v ? v.slice() : v); },
    setTransform() {},
    scale(x, y) { ops.scaled = { x, y }; },
    clearRect(x, y, w, h) { ops.cleared = { x, y, w, h }; },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    quadraticCurveTo() {},
    arc() { ops.arcs += 1; },
    stroke() { ops.strokes += 1; },
    fill() { ops.fills += 1; },
    fillText(text, x, y) { ops.fillTexts.push({ text, x, y }); },
  };
  return { node: { width: 0, height: 0, getContext: () => ctx }, ops };
}

/* ==================== 1. pron-core 纯逻辑 ==================== */

const pronCore = require('../utils/pron-core');

section('getPhonemeTip（phoneme-tips.ts 逐字移植）');
assert(Object.keys(pronCore.PHONEME_TIPS).length === 22, '映射表 22 条（θ/ð/v/w/r/l/iː/ɪ/æ/e/ə/ɑː/ʌ/ŋ/ʃ/tʃ/dʒ/z/eɪ/aɪ/aʊ/oʊ）');
(function () {
  const t = pronCore.getPhonemeTip('θ');
  assert(
    t.tip === '舌尖轻咬上下齿之间，气流从舌齿缝隙摩擦出——不是「斯」，舌要真伸出去' &&
      t.contrast === 'think vs. sink · path vs. pass',
    'θ 命中：tip/contrast 逐字',
  );
  assert(pronCore.getPhonemeTip('/ð/').tip === pronCore.PHONEME_TIPS['ð'].tip, '斜杠+空白归一（/ð/ → ð）');
  const fb = pronCore.getPhonemeTip('qq');
  assert(
    fb.tip === '在跟读练习中放慢原声，对着音标口型重复 5 遍，再以正常语速连读 3 遍' &&
      fb.contrast === '对比原声录音回放，逐词定位失分点',
    '未映射 → 通用兜底建议',
  );
})();

section('diagnosticRows（Top10 / 免费切片 / 三档条 / 两档符号）');
(function () {
  const rows = pronCore.diagnosticRows(sampleStats(), false);
  assert(rows.length === 10, '12 条 → Top10 截取');
  assert(rows.slice(0, 3).every((r) => r.visible === true), '非会员前 3 条可见');
  assert(rows.slice(3).every((r) => r.visible === false), '第 4 条起模糊锁定');
  assert(rows[0].avgScore === 55 && rows[0].scoreTier === 'low' && rows[0].scoreClass === 'error', '<60：low 档 + error 符号色');
  assert(rows[1].avgScore === 62 && rows[1].scoreTier === 'mid' && rows[1].scoreClass === 'warn', '62：mid 档 + warn 符号色');
  assert(rows[3].avgScore === 86 && rows[3].scoreTier === 'good' && rows[3].scoreClass === 'warn', '86：good 档 + warn 符号色（两档口径，Web 原样）');
  assert(rows[0].barWidth === 55, '可见行 barWidth = avgScore');
  assert(rows[3].barWidth === Math.round(86 * 0.4), '锁定行 barWidth = round(avgScore × 0.4)');
  assert(rows[0].metaText === '评测 8 次 · 低分 5 次', 'meta 文案逐字');
  assert(rows[0].tipText === pronCore.PHONEME_TIPS['θ'].tip, '可见行附着 tip');
  assert(rows[4].tipText === '在跟读练习中放慢原声，对着音标口型重复 5 遍，再以正常语速连读 3 遍', '未映射音素（x）→ 兜底 tip');
})();
(function () {
  const rows = pronCore.diagnosticRows(sampleStats(), true);
  assert(rows.every((r) => r.visible === true) && rows.every((r) => r.barWidth === r.avgScore), 'PRO 全量可见 + barWidth 实分');
})();
assert(pronCore.diagnosticRows(null, false).length === 0, 'null stats → []');

section('diagnosticLockedCount');
assert(pronCore.diagnosticLockedCount(sampleStats()) === 7, 'Top10 − 3 = 7');
assert(pronCore.diagnosticLockedCount(sampleStats().slice(0, 3)) === 0, '≤3 条 → 0');
assert(pronCore.diagnosticLockedCount([]) === 0, '空 → 0');

section('parseDiagnostic（信封/月份归一）');
(function () {
  const res = pronCore.parseDiagnostic({
    success: true,
    data: {
      phonemes: [{ phoneme: 'a', avgScore: 60, count: 2, lowScoreCount: 1 }, { phoneme: 'b', avgScore: 50, count: 1, lowScoreCount: 1 }],
      trend: [
        { month: '2026-08', avgScore: 68.4, count: 9 },
        { month: '2026-07', avgScore: 71.6, count: 12 },
        { month: '', avgScore: 50, count: 1 },
      ],
    },
  });
  assert(res.phonemes[0].phoneme === 'b', 'phonemes 升序（最弱在前）');
  assert(res.trend.length === 2 && res.trend[0].month === '2026-07' && res.trend[1].month === '2026-08', '月份升序 + 空月份过滤');
  assert(res.trend[0].avgScore === 72 && res.trend[1].avgScore === 68, '月均分四舍五入');
})();
assert(pronCore.parseDiagnostic({ success: false }) === null, 'success:false → null');
assert(pronCore.parseDiagnostic(null) === null, '响应 null → null');

section('drawTrendChart（mock canvas，recharts LineChart 视觉）');
(function () {
  const { node, ops } = makeCanvasNode();
  const trend = [
    { month: '2026-07', avgScore: 72, count: 12 },
    { month: '2026-08', avgScore: 68, count: 9 },
    { month: '2026-09', avgScore: 78, count: 6 },
  ];
  const ok = pronCore.drawTrendChart(node, 320, 208, trend, 2);
  assert(ok === true, '正常入参返回 true');
  assert(node.width === 640 && node.height === 416, 'DPR 2 → 640×416');
  assert(ops.scaled && ops.scaled.x === 2, 'ctx.scale(2,2)');
  assert(ops.dashs.some((d) => d && d[0] === 3 && d[1] === 3), '网格虚线 3-3（CartesianGrid strokeDasharray）');
  assert(ops.strokeStyles.indexOf('rgba(107, 114, 128, 0.15)') >= 0, '网格色 currentColor@0.1');
  assert(ops.strokeStyles.indexOf('#4F46E5') >= 0, '折线色 #4F46E5');
  assert(ops.lineWidths.indexOf(2.5) >= 0, '折线宽 2.5（strokeWidth 2.5）');
  assert(ops.arcs === 3, '3 个数据点半径 4 圆点');
  const labels = ops.fillTexts.map((t) => t.text);
  ['0', '25', '50', '75', '100'].forEach((v) => assert(labels.indexOf(v) >= 0, 'Y 刻度 ' + v));
  assert(labels.indexOf('2026-07') >= 0 && labels.indexOf('2026-09') >= 0, '月份标签');
  assert(ops.strokes === 6, '描边 6 次 = 5 网格线 + 1 折线');
})();
assert(pronCore.drawTrendChart(makeCanvasNode().node, 320, 208, [], 2) === false, '空 trend → false');

/* ==================== 2. 组件驱动 ==================== */

async function main() {
section('diagnostic-report-card 组件（行派生 / 弹窗 / 曲线懒加载与兜底）');

require('../components/review/diagnostic-report-card/index.js');
const def = componentDefs.__last;
assert(!!def, 'Component 定义捕获成功');
assert(def.properties.stats && def.properties.isPremium && def.properties.popupOpen,
  'properties：stats + isPremium + popupOpen（弹窗期卸载画布通道）');

// —— 非会员：行切片 + 解锁弹窗 ——
let inst = makeInstance(def);
inst.createSelectorQuery = function () {
  return {
    select() {
      return {
        fields() { return this; },
        exec(cb) { cb([{ node: null, width: 0, height: 0 }]); },
      };
    },
  };
};
inst._attached();
fireObserverKey(inst, 'stats, isPremium', { stats: sampleStats(), isPremium: false });
await settle();
assert(inst.data.rows.length === 10 && inst.data.isEmpty === false, 'Top10 行派生');
assert(inst.data.lockedCount === 7, '锁定数 7');
assert(inst.data.rows[3].visible === false && inst.data.rows[0].visible === true, '免费前 3 可见');
inst.openUnlock();
assert(inst.data.premiumVisible === true, '解锁引导点击 → premium-modal 打开（source diagnostic_report）');
inst.onModalClose();
assert(inst.data.premiumVisible === false, '弹窗关闭回调复位');

// —— 空态 ——
fireObserverKey(inst, 'stats, isPremium', { stats: [], isPremium: false });
await settle();
assert(inst.data.isEmpty === true, '无音素 → 空态（诊断数据积累中）');

// —— PRO：曲线懒加载成功 + 缓存 + 重绘 ——
const { node: trendNode, ops: trendOps } = makeCanvasNode();
let trendQueries = 0;
inst.createSelectorQuery = function () {
  trendQueries += 1;
  return {
    select() {
      return {
        fields() { return this; },
        exec(cb) { cb([{ node: trendNode, width: 320, height: 208 }]); },
      };
    },
  };
};
fireObserverKey(inst, 'stats, isPremium', { stats: sampleStats(), isPremium: true });
requestLog.length = 0;
toastCalls.length = 0;
apiResponses['/api/speech/diagnostic'] = {
  success: true,
  data: {
    phonemes: [],
    trend: [
      { month: '2026-07', avgScore: 72, count: 12 },
      { month: '2026-08', avgScore: 68, count: 9 },
    ],
  },
};
inst.toggleTrend();
await settle();
assert(inst.data.showTrend === true && inst.data.trendLoading === false, '展开后加载完成');
assert(
  requestLog.filter((r) => r.path === '/api/speech/diagnostic').length === 1,
  '首次展开懒加载恰一次',
);
assert(inst.data.trend && inst.data.trend.length === 2, 'trend 落库');
assert(trendQueries >= 1 && trendNode.width === 622 && trendNode.height === 416,
  'canvas 节点查询 + DPR 自绘落地（算术定寸 311×208 × pixelRatio=2；fields(size) 返回值仅兜底）');
assert(trendOps.arcs === 2, '折线圆点绘制（2 个月）');

// —— 宿主页弹窗联动：打开卸载曲线画布（开发者工具 canvas 原生层悬浮防透出）/ 关闭重绘 ——
const trendQueriesBefore = trendQueries;
inst.data.popupOpen = true;
if (inst._observers.popupOpen) inst._observers.popupOpen.call(inst, true);
await settle();
assert(trendQueries === trendQueriesBefore, '弹窗打开不触发重绘（曲线画布由 wx:elif 卸载）');
inst.data.popupOpen = false;
if (inst._observers.popupOpen) inst._observers.popupOpen.call(inst, false);
await new Promise((r) => setTimeout(r, 150));
assert(trendQueries > trendQueriesBefore, '弹窗关闭 → 曲线画布重挂载后延时重绘（120ms 兜底）');
inst.toggleTrend();
inst.toggleTrend();
await settle();
assert(
  requestLog.filter((r) => r.path === '/api/speech/diagnostic').length === 1,
  '收起再展开用缓存，不重复请求',
);

// —— 403：弹窗兜底 + 收起 ——
const inst403 = makeInstance(def);
inst403._attached();
fireObserverKey(inst403, 'stats, isPremium', { stats: sampleStats(), isPremium: true });
apiResponses['/api/speech/diagnostic'] = {
  __status: 403,
  body: { error: 'Premium membership required' },
};
inst403.toggleTrend();
await settle();
assert(inst403.data.showTrend === false && inst403.data.premiumVisible === true, '403 → 收起曲线 + premium-modal 兜底（红线双保险）');

// —— 失败 toast 文案逐字 ——
const instFail = makeInstance(def);
instFail._attached();
fireObserverKey(instFail, 'stats, isPremium', { stats: sampleStats(), isPremium: true });
apiResponses['/api/speech/diagnostic'] = { success: false };
toastCalls.length = 0;
instFail.toggleTrend();
await settle();
assert(toastCalls.indexOf('诊断数据加载失败，请稍后重试') >= 0, 'success:false → toast 逐字');

apiResponses['/api/speech/diagnostic'] = Error('network down');
const instNet = makeInstance(def);
instNet._attached();
fireObserverKey(instNet, 'stats, isPremium', { stats: sampleStats(), isPremium: true });
toastCalls.length = 0;
instNet.toggleTrend();
await settle();
assert(toastCalls.indexOf('网络错误，请稍后重试') >= 0, '网络错误 → toast 逐字');

// —— 空曲线 → 占位文案数据就位 ——
apiResponses['/api/speech/diagnostic'] = { success: true, data: { phonemes: [], trend: [] } };
const instEmpty = makeInstance(def);
instEmpty._attached();
fireObserverKey(instEmpty, 'stats, isPremium', { stats: sampleStats(), isPremium: true });
instEmpty.toggleTrend();
await settle();
assert(instEmpty.data.trendLoading === false && Array.isArray(instEmpty.data.trend) && instEmpty.data.trend.length === 0,
  '空 trend → 空态文案分支数据就位');

/* ==================== 3. 集成与结构断言 ==================== */

section('pron-notebook 集成 + WXML/WXSS 结构');

pronCore.resetTrialTrackState();
require('../components/review/pron-notebook/index.js');
const nbDef = componentDefs.__last;
const nbJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.json'), 'utf8'));
assert(
  nbJson.usingComponents['diagnostic-report-card'] === '/components/review/diagnostic-report-card/index',
  'pron-notebook json 注册 diagnostic-report-card',
);
const nbWxml = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxml'), 'utf8');
assert(
  /<diagnostic-report-card stats="\{\{notebook\.phonemeStats\}\}" is-premium="\{\{notebook\.isPremium\}\}" popup-open="\{\{popupOpen\}\}" \/>/.test(nbWxml),
  '诊断卡挂载：stats/isPremium 传递 + popupOpen 透传',
);
assert(nbWxml.indexOf('pron-list') >= 0 && nbDef.data.coming === undefined, '弱项列表（T4.4）随诊断卡挂载，coming 占位退场');

const wxml = fs.readFileSync(path.join(__dirname, '../components/review/diagnostic-report-card/index.wxml'), 'utf8');
assert(wxml.indexOf('AI 发音诊断报告') >= 0, '卡片标题逐字');
assert(wxml.indexOf('诊断数据积累中') >= 0 && wxml.indexOf('完成更多语音评测后，这里会逐个指出你的薄弱音素') >= 0, '空态文案逐字');
assert(wxml.indexOf('PRO 解锁：Top10 逐个击破方案 + 逐月进步曲线') >= 0, '解锁副文案逐字');
assert(wxml.indexOf('解锁完整诊断') >= 0, 'CTA 文案逐字');
assert(wxml.indexOf('近 6 个月进步曲线') >= 0 && wxml.indexOf('近 6 个月暂无带综合分的评测记录') >= 0, '曲线标题/空态逐字');
assert(wxml.indexOf('还有 {{lockedCount}} 个薄弱音素的专项建议已锁定') >= 0, '锁定计数文案');
assert(wxml.indexOf('对比练习：{{item.tipContrast}}') >= 0, '对比练习前缀');
assert(/<premium-modal visible="\{\{premiumVisible\}\}" source="diagnostic_report"/.test(wxml), 'premium-modal 挂载 + source=diagnostic_report');
assert(
  wxml.indexOf('id="drcTrend"') >= 0 && wxml.indexOf('type="2d"') >= 0 &&
    wxml.indexOf('trend.length > 0 && !popupOpen') >= 0 &&
    /<view wx:elif="\{\{trend\.length > 0\}\}" class="drc-canvas"><\/view>/.test(wxml),
  '曲线 canvas 2d：弹窗期卸载 + 同 class 空盒占位保高度（开发者工具原生层防透出）',
);
assert(wxml.indexOf('drc-row--locked') >= 0, '锁定行类分支');

const bindings = wxml.match(/\{\{[^}]+\}\}/g) || [];
assert(bindings.length > 0 && bindings.every((b) => !/\.\w+\(/.test(b)), 'WXML 绑定零方法调用红线');

const wxss = fs.readFileSync(path.join(__dirname, '../components/review/diagnostic-report-card/index.wxss'), 'utf8');
assert(wxss.indexOf('#2e8f6f') >= 0 && wxss.indexOf('#f59e0b') >= 0 && wxss.indexOf('#d2503f') >= 0,
  '进度条三档原值（success/amber-500/error-500）');
assert(wxss.indexOf('#b8402f') >= 0 && wxss.indexOf('#d97706') >= 0, '符号两档原值（error-600/amber-600）');
assert(wxss.indexOf('border-style: dashed') >= 0, '锁定行虚线边框');
assert(wxss.indexOf('filter: blur(12rpx)') >= 0 && wxss.indexOf('filter: blur(6rpx)') >= 0, '文字/进度条 blur 档位');
assert(wxss.indexOf('width: 112rpx') >= 0, '音素符号列宽 w-14');
assert(wxss.indexOf('@keyframes drc-spin') >= 0, '加载旋转动画');
assert(
  /@media \(prefers-color-scheme: dark\)/.test(wxss) && /\.drc-card\.theme-light/.test(wxss),
  '深色双轨（媒体查询 + 手动浅色全量重声明）',
);

const tipsFile = fs.readFileSync(path.join(__dirname, '../utils/pron-core.js'), 'utf8');
assert(tipsFile.indexOf('舌后部抵软腭，走鼻子出气（sing/long 结尾）——不要读成 n（舌尖抵齿龈）') >= 0, 'ŋ tip 逐字入库');

/* ==================== 汇总 ==================== */

console.log(`\n========== 诊断报告卡 T4.3 测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) {
  console.error('失败用例：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
}

main();
