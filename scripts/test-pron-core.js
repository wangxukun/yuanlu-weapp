/**
 * scripts/test-pron-core.js — 发音弱项本 T4.1 数据接入自动化测试
 * （REVIEW-TASK 阶段 4：聚合接口归一 + weakThreshold 口径 + TRIAL_REACHED 埋点）
 *
 * 两层驱动（test-sentence-notebook 同款测试法）：
 *   1. utils/pron-core.js 纯逻辑——直接 require 断言：
 *      normalizeThreshold 收口（60-95 默认 80）/ parsePhonemeStats 均分升序
 *      + 四舍五入 + 同分稳定 / normalizeProfile 可空均值 / toRadarData 五维
 *      逐字移植 / normalizeErrorRecord 字段位 / parseNotebook 信封与失败语义 /
 *      lockedCount / maybeTrackTrialReach 会话内一次；
 *   2. components/review/pron-notebook——Component 定义捕获 + makeInstance 驱动：
 *      active 首次激活懒加载 / 试用埋点经 utils/track 静默上报 / 失败首败亮
 *      错误态 + retry / 已加载数据时失败保旧 / refreshSeq 轻刷新（Android
 *      onReenter 对齐）/ 非 active 不发请求；
 *   3. WXML 结构断言：宿主页 refresh-seq 传递 + 占位卡绑定零方法调用红线。
 *
 * 运行：node scripts/test-pron-core.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toastCalls = [];
const requestLog = []; // { path, method, data }

// 可编程的接口响应表：path → body（或 Error → fail）
const apiResponses = {};

function resolveRequest(opts) {
  const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestLog.push({ path: p, method: opts.method || 'GET', data: opts.data });
  const hit = apiResponses[p];
  if (hit instanceof Error) {
    opts.fail && opts.fail({ errMsg: hit.message });
    return;
  }
  const body = typeof hit === 'function' ? hit(opts.data) : hit;
  opts.success({ statusCode: 200, data: body });
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
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 20, theme: 'light' }),
};

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

/** 非会员试用形状（服务端 notebook/route.ts 口径：前 3 条切片 + totalErrors=7） */
function trialNotebookBody() {
  return {
    success: true,
    data: {
      isPremium: false,
      weakThreshold: 80,
      profile: {
        evalCount: 12,
        avgOverall: 71.4,
        avgAccuracy: 73.2,
        avgFluency: 68.9,
        avgIntegrity: 75.1,
        avgSpeed: 132.5,
        speedFitScore: 95,
        cefrLevel: 'B1',
      },
      phonemeStats: [
        { phoneme: 'θ', avgScore: 62.4, count: 8, lowScoreCount: 5 },
        { phoneme: 'æ', avgScore: 87.6, count: 6, lowScoreCount: 1 },
        { phoneme: 'ɪ', avgScore: 75.0, count: 4, lowScoreCount: 2 },
      ],
      totalErrors: 7,
      isTrialMode: true,
      errors: [
        {
          recognitionid: 101,
          episodeid: 'ep1',
          episode: { title: 'Tech Talk', coverUrl: 'https://oss/signed-cover-1' },
          targetText: 'The theory is quite clear.',
          targetStartTime: 12,
          subtitleId: 55,
          accuracyScore: 61.2,
          overallScore: 58.4,
          speed: 120,
          recognitionDate: '2026-09-20T10:00:00.000Z',
        },
        {
          recognitionid: 102,
          episodeid: 'ep1',
          episode: { title: 'Tech Talk', coverUrl: 'https://oss/signed-cover-1' },
          targetText: 'A vibrant city never sleeps.',
          targetStartTime: 88,
          subtitleId: 90,
          accuracyScore: 70,
          overallScore: 66,
          speed: 118,
          recognitionDate: '2026-09-21T10:00:00.000Z',
        },
        {
          recognitionid: 103,
          episodeid: 'ep2',
          episode: { title: 'Daily Life', coverUrl: '' },
          targetText: 'Think about both options.',
          targetStartTime: 5,
          subtitleId: null,
          accuracyScore: null,
          overallScore: 72,
          speed: null,
          recognitionDate: '2026-09-22T10:00:00.000Z',
        },
      ],
    },
  };
}

/* ==================== 1. pron-core 纯逻辑 ==================== */

const pronCore = require('../utils/pron-core');

section('normalizeThreshold（60-95 收口，默认 80）');
assert(pronCore.normalizeThreshold(undefined) === 80, '缺省 → 80（DEFAULT_WEAK_SCORE_THRESHOLD）');
assert(pronCore.normalizeThreshold('abc') === 80, '非数值 → 80');
assert(pronCore.normalizeThreshold(75) === 75, '区间内整数透传');
assert(pronCore.normalizeThreshold(40) === 60, '低于下限收口 60');
assert(pronCore.normalizeThreshold(99) === 95, '高于上限收口 95');
assert(pronCore.normalizeThreshold(82.6) === 83, '浮点先四舍五入再收口');

section('parsePhonemeStats（均分升序·最弱在前）');
(function () {
  const out = pronCore.parsePhonemeStats(trialNotebookBody().data.phonemeStats);
  assert(out.length === 3, '条数保持');
  assert(out[0].phoneme === 'θ' && out[0].avgScore === 62, '最弱 62.4 → 62 排最前');
  assert(out[1].phoneme === 'ɪ' && out[1].avgScore === 75, '次弱 75 居中');
  assert(out[2].phoneme === 'æ' && out[2].avgScore === 88, '最强 87.6 → 88 排最后');
  assert(out[0].count === 8 && out[0].lowScoreCount === 5, 'count/lowScoreCount 透传');
})();
assert(pronCore.parsePhonemeStats(null) && pronCore.parsePhonemeStats(null).length === 0, 'null → []');
assert(pronCore.parsePhonemeStats('x').length === 0, '非数组 → []');
(function () {
  const tie = pronCore.parsePhonemeStats([
    { phoneme: 'a', avgScore: 70, count: 1, lowScoreCount: 0 },
    { phoneme: 'e', avgScore: 70, count: 2, lowScoreCount: 1 },
    { phoneme: 'i', avgScore: 65, count: 1, lowScoreCount: 1 },
  ]);
  assert(
    tie.map((s) => s.phoneme).join(',') === 'i,a,e',
    '同分 70 保持原序（稳定排序，不依赖引擎实现）',
  );
})();
(function () {
  const bad = pronCore.parsePhonemeStats([{ count: 3 }, null]);
  assert(bad.length === 2, '坏条目不整条丢弃（防御性归零）');
  assert(bad.every((s) => typeof s.phoneme === 'string' && s.avgScore === 0), '缺失字段归零值');
})();

section('normalizeProfile（聚合均值·无数据 null）');
(function () {
  const p = pronCore.normalizeProfile(trialNotebookBody().data.profile);
  assert(p.evalCount === 12, 'evalCount 透传');
  assert(p.avgOverall === 71.4, '均值保持浮点原值（四舍五入只在雷达/展示层）');
  assert(p.cefrLevel === 'B1', 'cefrLevel 字符串透传');
})();
(function () {
  const p = pronCore.normalizeProfile(null);
  assert(p.evalCount === 0, '缺省 evalCount → 0');
  assert(p.avgOverall === null && p.avgSpeed === null, '缺省均值 → null');
  assert(p.cefrLevel === null, '缺省 cefrLevel → null');
  assert(pronCore.normalizeProfile({ cefrLevel: '' }).cefrLevel === null, '空串 cefrLevel → null');
  assert(
    (function () {
      // 回归：服务端 JSON 缺数据是显式 null（Number(null)===0 陷阱）
      const p = pronCore.normalizeProfile({
        evalCount: 3,
        avgOverall: null,
        avgAccuracy: null,
        avgSpeed: null,
        speedFitScore: null,
      });
      return p.evalCount === 3 && p.avgOverall === null && p.avgAccuracy === null &&
        p.avgSpeed === null && p.speedFitScore === null;
    })(),
    '显式 null 均值 → null（不被 Number(null)=0 吞成 0 分）',
  );
})();

section('toRadarData（speech-profile.service.ts 逐行移植）');
(function () {
  const radar = pronCore.toRadarData(pronCore.normalizeProfile(trialNotebookBody().data.profile));
  assert(
    radar.map((r) => r.dim).join('/') === '准确度/流利度/完整度/语速适配/综合表现',
    '五维名称与顺序逐字一致',
  );
  assert(radar.every((r) => r.fullMark === 100), 'fullMark 恒 100');
  assert(radar[0].score === 73 && radar[4].score === 71, 'Math.round（73.2→73 / 71.4→71）');
})();
(function () {
  const radar = pronCore.toRadarData({ avgAccuracy: 88.6 });
  assert(radar[0].score === 89, '单维 88.6 → 89');
  assert(radar.slice(1).every((r) => r.score === 0), '缺维以 0 计（前端提示数据积累中）');
})();
assert(pronCore.toRadarData(null).length === 5, 'profile null → 五维全 0 不抛错');

section('normalizeErrorRecord（WeakRecordDto 字段位）');
(function () {
  const r = pronCore.normalizeErrorRecord(trialNotebookBody().data.errors[0]);
  assert(r.recognitionid === 101 && r.episodeid === 'ep1', '主键/剧集 id 透传');
  assert(r.episodeTitle === 'Tech Talk' && r.episodeCoverUrl === 'https://oss/signed-cover-1', '剧集标题/签名封面');
  assert(r.targetText === 'The theory is quite clear.', 'targetText 透传');
  assert(r.targetStartTime === 12 && r.subtitleId === 55, '时间/字幕 id 透传');
  assert(r.overallScore === 58.4 && r.accuracyScore === 61.2 && r.speed === 120, '三维分数透传');
  assert(r.recognitionDate === '2026-09-20T10:00:00.000Z', '评测时间透传');
  assert(r.episodeAudioUrl === '' && r.subtitleTextCn === null && r.subtitleWords === null && r.subtitleEnd === null,
    'errors 接口补齐字段在 notebook 形状下保持字段位（null/空串）');
})();
(function () {
  const r = pronCore.normalizeErrorRecord(trialNotebookBody().data.errors[2]);
  assert(r.episodeCoverUrl === '', '空封面归一空串');
  assert(r.subtitleId === null && r.accuracyScore === null && r.speed === null, '可空字段 null 保持');
})();
(function () {
  const r = pronCore.normalizeErrorRecord(null);
  assert(r.episodeTitle === '' && r.targetText === '' && r.overallScore === null, 'null 条目全兜底不抛错');
})();

section('parseNotebook（信封与失败语义）');
(function () {
  const n = pronCore.parseNotebook(trialNotebookBody());
  assert(n !== null && n.isPremium === false, 'isPremium 布尔化');
  assert(n.weakThreshold === 80, 'weakThreshold 归一');
  assert(n.totalErrors === 7 && n.isTrialMode === true, 'totalErrors/isTrialMode 透传');
  assert(n.errors.length === 3 && n.errors[0].targetText === 'The theory is quite clear.', 'errors 逐条归一');
  assert(n.phonemeStats[0].phoneme === 'θ', 'phonemeStats 已升序');
  assert(pronCore.toRadarData(n.profile).length === 5, 'profile 已归一可直接喂雷达');
})();
assert(pronCore.parseNotebook({ success: false, error: 'x' }) === null, 'success:false → null（区别于空弱项本）');
assert(pronCore.parseNotebook({ success: true }) === null, 'data 缺失 → null');
assert(pronCore.parseNotebook(null) === null, '响应 null → null');

section('lockedCount（T4.4 锁定卡口径）');
(function () {
  const n = pronCore.parseNotebook(trialNotebookBody());
  assert(pronCore.lockedCount(n) === 4, '非会员 7 − 3 条切片 = 4');
})();
(function () {
  const body = trialNotebookBody();
  body.data.isPremium = true;
  body.data.isTrialMode = false;
  body.data.errors.push({ recognitionid: 104, targetText: 'x', overallScore: 50 });
  body.data.totalErrors = body.data.errors.length;
  assert(pronCore.lockedCount(pronCore.parseNotebook(body)) === 0, '会员全量（totalErrors=可见数）→ 0');
})();
assert(pronCore.lockedCount(null) === 0, 'null → 0');

section('maybeTrackTrialReach（首次进入·会话内一次）');
(function () {
  pronCore.resetTrialTrackState();
  const fired = [];
  const tracker = (eventType, source, metadata) => fired.push({ eventType, source, metadata });
  const trial = pronCore.parseNotebook(trialNotebookBody());

  const nonTrial = pronCore.parseNotebook(trialNotebookBody());
  nonTrial.isTrialMode = false;
  assert(pronCore.maybeTrackTrialReach(nonTrial, tracker) === false, '非试用态不上报');
  assert(pronCore.maybeTrackTrialReach(null, tracker) === false, 'notebook null 不上报');

  assert(pronCore.maybeTrackTrialReach(trial, tracker) === true, '试用态首次进入上报');
  assert(
    fired.length === 1 &&
      fired[0].eventType === 'TRIAL_REACHED' &&
      fired[0].source === 'pronunciation_trial' &&
      fired[0].metadata.totalErrors === 7,
    '上报参数逐字：TRIAL_REACHED / pronunciation_trial / {totalErrors:7}',
  );
  assert(pronCore.maybeTrackTrialReach(trial, tracker) === false, '会话内第二次不再上报');
  assert(fired.length === 1, '无重复上报');

  pronCore.resetTrialTrackState();
  assert(pronCore.maybeTrackTrialReach(trial, tracker) === true, '复位后重新可上报（测试隔离钩子）');
  pronCore.resetTrialTrackState();
})();

/* ==================== 2. pron-notebook 组件驱动 ==================== */

async function main() {
section('pron-notebook 组件（active 懒加载 / 埋点 / 失败口径 / refreshSeq）');

require('../components/review/pron-notebook/index.js');
const def = componentDefs.__last;
assert(!!def, 'Component 定义捕获成功');
assert(def.properties.active && def.properties.refreshSeq, 'properties：active + refreshSeq（宿主 onShow 通道）');

function countNotebookReqs() {
  return requestLog.filter((r) => r.path === '/api/speech/notebook').length;
}
function trackReqs() {
  return requestLog.filter((r) => r.path === '/api/track');
}

// —— 未激活不请求 ——
requestLog.length = 0;
delete apiResponses['/api/speech/notebook'];
pronCore.resetTrialTrackState();
let inst = makeInstance(def);
inst._attached();
await settle();
assert(countNotebookReqs() === 0, 'attached 且 active=false → 不发请求');

// —— 首次激活：拉聚合 + 试用埋点 ——
apiResponses['/api/speech/notebook'] = trialNotebookBody();
fireObserver(inst, 'active', true);
await settle();
assert(countNotebookReqs() === 1, '首次激活 → GET /api/speech/notebook 恰一次');
assert(inst.data.loading === false && inst.data.loaded === true && inst.data.loadError === false, '加载完成态');
assert(inst.data.notebook && inst.data.notebook.totalErrors === 7, '归一结果落 data.notebook');
assert(inst.data.notebook.phonemeStats[0].phoneme === 'θ', '组件侧音素已升序（pron-core 归一生效）');
const trs = trackReqs();
assert(
  trs.length === 1 &&
    trs[0].method === 'POST' &&
    trs[0].data.eventType === 'TRIAL_REACHED' &&
    trs[0].data.source === 'pronunciation_trial' &&
    trs[0].data.metadata.totalErrors === 7,
  'isTrialMode 首次进入 → POST /api/track {TRIAL_REACHED, pronunciation_trial, {totalErrors:7}}（经 utils/track 静默链路）',
);

// —— 再次激活轻刷新：会话内不重复埋点 ——
fireObserver(inst, 'active', false);
fireObserver(inst, 'active', true);
await settle();
assert(countNotebookReqs() === 2, '再次激活 → 轻刷新（refresh 口径）');
assert(trackReqs().length === 1, '会话内埋点不重复（pron-core 去重）');

// —— refreshSeq：active 且已加载 → 刷新；失败保旧数据 ——
apiResponses['/api/speech/notebook'] = Error('network down');
fireObserver(inst, 'refreshSeq', 1);
await settle();
assert(countNotebookReqs() === 3, 'refreshSeq 递增且 active → 再拉取（Android onReenter 对齐）');
assert(inst.data.notebook && inst.data.notebook.totalErrors === 7, '刷新失败保持旧数据');
assert(inst.data.loadError === false && inst.data.loading === false, '已有数据时失败不亮错误态');

// —— 失败 + retry：首败亮错误态，重试成功恢复 ——
requestLog.length = 0;
inst = makeInstance(def);
apiResponses['/api/speech/notebook'] = Error('network down');
fireObserver(inst, 'active', true);
await settle();
assert(countNotebookReqs() === 1 && inst.data.loadError === true && inst.data.loaded === false,
  '从未加载成功过的失败 → loadError 态');
apiResponses['/api/speech/notebook'] = trialNotebookBody();
inst.retry();
await settle();
assert(inst.data.loaded === true && inst.data.loadError === false && inst.data.notebook !== null,
  'retry() 重新拉取成功 → 恢复');

// —— 非 active 时 refreshSeq 变化不请求 ——
requestLog.length = 0;
fireObserver(inst, 'active', false);
fireObserver(inst, 'refreshSeq', 2);
await settle();
assert(countNotebookReqs() === 0, '非 active 时 refreshSeq 变化 → 不发请求');

/* ==================== 3. WXML / 结构断言 ==================== */

section('WXML 与结构（占位期红线）');

const hostWxml = fs.readFileSync(path.join(__dirname, '../pages/review/index.wxml'), 'utf8');
assert(
  /<pron-notebook active="\{\{activeTab === 2\}\}" refresh-seq="\{\{refreshSeq\}\}" \/>/.test(hostWxml),
  '宿主页 pron-notebook 传入 refresh-seq（与 vocab/sentence 同款）',
);

const compWxml = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxml'), 'utf8');
const bindings = compWxml.match(/\{\{[^}]+\}\}/g) || [];
assert(
  bindings.length > 0 && bindings.every((b) => !/\.\w+\(/.test(b)),
  'WXML 绑定零方法调用红线（全部为属性访问/比较）',
);
assert(/notebook-placeholder/.test(compWxml), '占位卡保留（T4.2–T4.5 逐卡替换）');

const compJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.json'), 'utf8'));
assert(compJson.component === true, '组件 json 声明完好');

/* ==================== 汇总 ==================== */

console.log(`\n========== 发音弱项本 T4.1 测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) {
  console.error('失败用例：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
}

main();
