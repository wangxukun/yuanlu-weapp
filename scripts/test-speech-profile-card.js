/**
 * scripts/test-speech-profile-card.js — 发音能力画像卡自动化测试
 * （REVIEW-TASK 阶段 4 T4.2：完整复刻 Android PronunciationNotebookScreen
 *  的 SpeechProfileCard + RadarChart.kt）
 *
 * 三层驱动：
 *   1. utils/pron-core 雷达几何/渲染纯函数——radarAngles 顶角顺时针口径 /
 *      radarPoint 坐标换算 / radarRingPoints 等分环 / radarScorePoints 得分缩放
 *      与 0-100 收口 / drawRadarChart 以 mock canvas node+ctx 驱动（Android
 *      RadarChart.kt 逐项：4 环 + 1px 网格/辐条、数据多边形 0.2 填充 + 2px
 *      描边、12sp·600 标签锚顶点外偏 6dp/2dp、半径 = 短半边 − 34dp、
 *      深浅主题网格/标签色、DPR 缩放）；
 *   2. components/review/speech-profile-card——Component 定义捕获 + makeInstance：
 *      展示字段派生（round / null→— / 语速单位）/ 综合得分标签 / 说明文案
 *      （CEFR 版「」引号 / 无数据版引导）/ evalCount=0 空态不查画布 /
 *      setData 回调后查 canvas 并自绘 / 深色重绘换网格标签色 / 图标变体；
 *   3. pron-notebook 集成 + WXML/WXSS 结构：画像卡挂载与 radar 传递 / 三态 /
 *      Material 主题色原值 / CEFR 全圆胶囊 / 深色双轨 / 绑定零方法调用红线。
 *
 * 运行：node scripts/test-speech-profile-card.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

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
  showToast: () => {},
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

function near(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-6);
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
  if (def.lifetimes && def.lifetimes.ready) inst._ready = def.lifetimes.ready.bind(inst);
  if (def.observers) inst._observers = def.observers;
  return inst;
}

/** 触发多字段 observer（真实运行时：任一字段变化即触发整组） */
function fireObserverKey(inst, key, patch) {
  Object.assign(inst.data, patch);
  if (inst._observers && inst._observers[key]) inst._observers[key].call(inst);
}
function fireObserver(inst, key, value) {
  inst.data[key] = value;
  if (inst._observers && inst._observers[key]) inst._observers[key].call(inst, value);
}

/* ==================== 用例数据 ==================== */

const PROFILE_FULL = {
  evalCount: 12,
  avgOverall: 71.4,
  avgAccuracy: 73.2,
  avgFluency: 68.9,
  avgIntegrity: 75.1,
  avgSpeed: 132.5,
  speedFitScore: 95,
  cefrLevel: 'B1',
};
const PROFILE_EMPTY = {
  evalCount: 0,
  avgOverall: null,
  avgAccuracy: null,
  avgFluency: null,
  avgIntegrity: null,
  avgSpeed: null,
  speedFitScore: null,
  cefrLevel: null,
};

function notebookBody(profile) {
  return {
    success: true,
    data: {
      isPremium: false,
      weakThreshold: 80,
      profile,
      phonemeStats: [{ phoneme: 'θ', avgScore: 62, count: 8, lowScoreCount: 5 }],
      totalErrors: 7,
      isTrialMode: true,
      errors: [],
    },
  };
}

/** mock canvas node + 记录型 2d ctx */
function makeCanvasNode() {
  const ops = {
    strokes: 0,
    fills: 0,
    fillTexts: [], // {text, x, y}
    strokeStyles: [],
    fillStyles: [],
    fonts: [],
    aligns: [],
    baselines: [],
    lineWidths: [],
    scaled: null,
    transforms: 0,
    cleared: null,
  };
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
    get textAlign() { return ops.aligns[ops.aligns.length - 1]; },
    set textBaseline(v) { ops.baselines.push(v); },
    get textBaseline() { return ops.baselines[ops.baselines.length - 1]; },
    setTransform() { ops.transforms += 1; },
    scale(x, y) { ops.scaled = { x, y }; },
    clearRect(x, y, w, h) { ops.cleared = { x, y, w, h }; },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() { ops.strokes += 1; },
    fill() { ops.fills += 1; },
    fillText(text, x, y) { ops.fillTexts.push({ text, x, y }); },
  };
  const node = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
  return { node, ops };
}

/* ==================== 1. 雷达几何与渲染纯函数 ==================== */

const pronCore = require('../utils/pron-core');

section('radarAngles / radarPoint（顶角顺时针，recharts/Android 同口径）');
(function () {
  const a = pronCore.radarAngles(5);
  assert(a.length === 5 && a[0] === 90, '首维正上方 90°');
  assert(a[1] === 18 && a[2] === -54 && a[3] === -126 && a[4] === -198, '顺时针每档 -72°（90/18/-54/-126/-198）');
  assert(pronCore.radarAngles(0).length === 0 && pronCore.radarAngles().length === 0, '0 维/缺省 → []');
})();
(function () {
  const top = pronCore.radarPoint(100, 100, 50, 90);
  assert(near(top.x, 100) && near(top.y, 50), '90° → 正上方（canvas y 向下）');
  const right = pronCore.radarPoint(100, 100, 50, 0);
  assert(near(right.x, 150) && near(right.y, 100), '0° → 正右方');
})();

section('radarRingPoints / radarScorePoints');
(function () {
  const pts = pronCore.radarRingPoints(0, 0, 10, 5);
  assert(pts.length === 5, '等分环 5 顶点');
  assert(pts.every((p) => near(Math.sqrt(p.x * p.x + p.y * p.y), 10)), '全部顶点半径 = r');
})();
(function () {
  const full = pronCore.radarScorePoints([100, 100, 100, 100, 100], 0, 0, 10);
  assert(full.every((p) => near(Math.sqrt(p.x * p.x + p.y * p.y), 10)), '满分 100 → 顶点落在环上');
  const zero = pronCore.radarScorePoints([0, 0, 0, 0, 0], 5, 7, 10);
  assert(zero.every((p) => p.x === 5 && p.y === 7), '0 分 → 全部收缩到圆心');
  const half = pronCore.radarScorePoints([50], 0, 0, 10)[0];
  assert(near(Math.sqrt(half.x * half.x + half.y * half.y), 5), '50 分 → 半径减半');
  const clamp = pronCore.radarScorePoints([150, -20], 0, 0, 10);
  assert(
    near(Math.sqrt(clamp[0].x ** 2 + clamp[0].y ** 2), 10) &&
      near(clamp[1].x, 0) && near(clamp[1].y, 0),
    '越界收口：150→环上 / -20→圆心',
  );
})();

section('drawRadarChart（Android RadarChart.kt 逐项，mock canvas 驱动）');
(function () {
  const { node, ops } = makeCanvasNode();
  const radar = pronCore.toRadarData(pronCore.normalizeProfile(PROFILE_FULL));
  const ok = pronCore.drawRadarChart(node, 320, 204, radar, 2);
  assert(ok === true, '正常入参返回 true');
  assert(node.width === 640 && node.height === 408, 'DPR 2 → 物理像素 640×408');
  assert(ops.scaled && ops.scaled.x === 2 && ops.scaled.y === 2, 'ctx.scale(2,2)（CSS 像素坐标系作画）');
  assert(ops.strokes === 6, '描边 6 次 = 4 环 + 辐条 1 批 + 数据多边形 1（gridRingCount=4）');
  assert(ops.lineWidths.indexOf(2) >= 0, '数据多边形描边 2px（Android Stroke(2.dp)）');
  assert(ops.lineWidths.indexOf(1) >= 0, '网格环/辐条 1px');
  assert(ops.strokeStyles.indexOf('#E5E7EB') >= 0, '默认网格色 #E5E7EB（浅色）');
  assert(ops.strokeStyles.indexOf('#7C3AED') >= 0, '数据多边形描边 #7C3AED（ProfileRadarColor 双态恒值）');
  assert(ops.fillStyles.indexOf('rgba(124, 58, 237, 0.2)') >= 0, '数据多边形 0.2 透明填充');
  assert(ops.fonts.indexOf('600 12px sans-serif') >= 0, '标签字体 12sp·600（labelStyle）');
  assert(ops.baselines.indexOf('top') >= 0, 'textBaseline=top（drawText topLeft 语义）');
  assert(ops.fills === 1 && ops.cleared && ops.cleared.w === 320, '填充恰 1 次 + 作画前清屏');

  // 半径与标签锚点几何：R = min(320,204)/2 − 34 = 68；cx=160, cy=102
  // 顶部「准确度」anchor=(160,34)，dy<-1 → 标签顶 y = 34 − 16 − 2 = 16，居中
  assert(ops.fillTexts.length === 5, '五个维度标签');
  assert(
    ops.fillTexts.map((t) => t.text).join('/') === '准确度/流利度/完整度/语速适配/综合表现',
    '标签文案与渲染顺序逐字一致',
  );
  assert(near(ops.fillTexts[0].x, 160) && near(ops.fillTexts[0].y, 16), '顶部标签：x 居中 160，顶缘 y=16（anchor 上方 −行高−2dp）');
  assert(
    ops.aligns.join(',') === 'center,left,left,right,right',
    '象限对齐：顶居中 / 右侧左对齐 / 左侧右对齐',
  );
  // 右侧「流利度」anchor=(224.67,80.99)：x = anchor+6、y = anchor−行高−2dp = 62.99
  assert(near(ops.fillTexts[1].x, 230.67, 1e-2) && near(ops.fillTexts[1].y, 62.99, 1e-2), '右侧标签锚顶点外偏（+6dp / 上方 −行高−2dp）');
  // 左侧「综合表现」anchor=(95.33,81.01)：右对齐 x = anchor−6 → 文字完整落在画布内
  assert(near(ops.fillTexts[4].x, 89.33, 1e-2), '左侧标签右对齐锚 anchor−6dp');
  assert(
    ops.fillTexts.every((t, i) => {
      const w = t.text.length * 12;
      return t.x - w >= 0 && t.x + w <= 320 + 0.001;
    }),
    '标签完整落在画布内（左右侧不截断）',
  );
})();
(function () {
  const { node, ops } = makeCanvasNode();
  const radar = pronCore.toRadarData(pronCore.normalizeProfile(PROFILE_FULL));
  pronCore.drawRadarChart(node, 320, 204, radar, 1, {
    gridColor: pronCore.RADAR_GRID_STROKE_DARK,
    labelColor: pronCore.RADAR_TICK_FILL_DARK,
  });
  assert(ops.strokeStyles.indexOf('#3A342C') >= 0, '深色网格色 #3A342C（isDark 分支）');
  assert(ops.fillStyles.indexOf('#A8A29E') >= 0, '深色标签色 #A8A29E（isDark 分支）');
  assert(ops.strokeStyles.indexOf('#7C3AED') >= 0, '深色下数据多边形仍 #7C3AED（恒值）');
})();
assert(pronCore.drawRadarChart(null, 320, 204, [], 2) === false, 'node null → false');
assert(pronCore.drawRadarChart({ getContext: null }, 320, 204, [], 2) === false, 'getContext 缺失 → false');
(function () {
  const { node } = makeCanvasNode();
  assert(pronCore.drawRadarChart(node, 320, 204, [], 2) === false, '空 radar → false（无维度可画）');
  assert(pronCore.drawRadarChart(node, 60, 60, pronCore.toRadarData(pronCore.normalizeProfile(PROFILE_FULL)), 1) === false,
    '半径收口为负（短半边 30 − 34）→ false');
})();

/* ==================== 2. speech-profile-card 组件 ==================== */

async function main() {
section('speech-profile-card 组件（字段派生 / 文案 / 空态 / 画布自绘 / 深色重绘）');

require('../components/review/speech-profile-card/index.js');
const def = componentDefs.__last;
assert(!!def, 'Component 定义捕获成功');
assert(def.properties.profile && def.properties.radar, 'properties：profile + radar');

// —— 空画像：空态字段 + 引导文案，不查画布 ——
let inst = makeInstance(def);
let queries = 0;
inst.createSelectorQuery = function () {
  queries += 1;
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
fireObserverKey(inst, 'profile, radar', { profile: pronCore.normalizeProfile(PROFILE_EMPTY) });
await settle();
assert(inst.data.hasData === false, 'evalCount=0 → hasData false');
assert(inst.data.avgOverallText === '—' && inst.data.avgSpeedText === '—', '无数据均值 → —');
assert(inst.data.hintIsCefr === false, '无数据 → 说明条为引导版');
assert(
  inst.data.hintText === '在任意剧集的跟读练习中完成语音评测，即可生成专属画像并获得难度匹配推荐。',
  '引导文案逐字',
);
assert(
  inst.data.icons.speedFaint.indexOf('speed-faint.svg') >= 0 && inst.data.icons.infoHint.indexOf('info-onsurface.svg') >= 0,
  '空态图标：Speed@0.3 淡色 + Info onSurfaceVariant（浅色）',
);
assert(queries === 0, '空态不查询画布节点');

// —— 完整画像：字段派生 + CEFR 文案 + 画布自绘 ——
const { node: drawNode, ops: drawOps } = makeCanvasNode();
inst.createSelectorQuery = function () {
  queries += 1;
  return {
    select() {
      return {
        fields() { return this; },
        exec(cb) { cb([{ node: drawNode, width: 320, height: 204 }]); },
      };
    },
  };
};
fireObserverKey(inst, 'profile, radar', {
  profile: pronCore.normalizeProfile(PROFILE_FULL),
  radar: pronCore.toRadarData(pronCore.normalizeProfile(PROFILE_FULL)),
});
await settle();
assert(inst.data.hasData === true, 'evalCount>0 → hasData true');
assert(inst.data.avgOverallText === '71', '综合得分 Math.round（71.4→71）');
assert(inst.data.avgSpeedText === '133 词/分', '平均语速取整带单位（132.5→133 词/分）');
assert(inst.data.hintIsCefr === true, '有数据且有等级 → 说明条为 CEFR 版');
assert(
  inst.data.hintText ===
    '根据你的评测表现，当前发音水平约为 CEFR B1 级，首页「为你推荐」已按该等级匹配剧集难度。评测越多，画像越准。',
  'CEFR 说明文案逐字（Android「」引号版）',
);
assert(inst.data.icons.infoHint.indexOf('info-secondary.svg') >= 0, 'CEFR 版说明图标 Info secondary（双态恒值）');
assert(queries === 1, 'setData 回调后恰查询一次画布');
assert(drawNode.width === 640, '画布 DPR 缩放落地（wx.getWindowInfo pixelRatio=2）');
assert(drawOps.fillTexts.length === 5 && drawOps.strokeStyles.indexOf('#E5E7EB') >= 0, '雷达浅色自绘（网格 #E5E7EB）');

// —— 深色切换：图标变体 + 雷达重绘换主题色 ——
const darkOps = drawOps; // 同一 mock ctx 继续记录
fireObserver(inst, 'dark', true);
await settle();
assert(
  inst.data.icons.speedFaint.indexOf('speed-faint-dark.svg') >= 0,
  '深色 → 空态 Speed 切 -dark 变体（IconBadge Speed 恒 secondary 不变）',
);
assert(
  inst.data.icons.speed.indexOf('speed-secondary.svg') >= 0,
  'IconBadge Speed 双态恒 speed-secondary（Android DarkSecondary=#D98A17）',
);
assert(
  darkOps.strokeStyles.indexOf('#3A342C') >= 0 && darkOps.fillStyles.indexOf('#A8A29E') >= 0,
  '深色触发雷达重绘：网格 #3A342C / 标签 #A8A29E',
);
fireObserver(inst, 'dark', false);
await settle();
assert(darkOps.strokeStyles.lastIndexOf('#E5E7EB') > darkOps.strokeStyles.lastIndexOf('#3A342C'), '浅色切回重绘浅色网格');

/* ==================== 3. pron-notebook 集成 + 结构断言 ==================== */

section('pron-notebook 集成（画像卡挂载 + radar 传递）');
pronCore.resetTrialTrackState();
require('../components/review/pron-notebook/index.js');
const nbDef = componentDefs.__last;
assert(!!nbDef, 'pron-notebook Component 定义捕获成功');

apiResponses['/api/speech/notebook'] = notebookBody(PROFILE_FULL);
const nb = makeInstance(nbDef);
nb._attached();
fireObserver(nb, 'active', true);
await settle();
assert(nb.data.radar.length === 5 && nb.data.radar[0].dim === '准确度', 'notebook → toRadarData 派生 radar');

const hostJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.json'), 'utf8'));
assert(
  hostJson.usingComponents['speech-profile-card'] === '/components/review/speech-profile-card/index',
  'pron-notebook json 注册 speech-profile-card',
);

const nbWxml = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxml'), 'utf8');
assert(
  /<speech-profile-card profile="\{\{notebook\.profile\}\}" radar="\{\{radar\}\}" \/>/.test(nbWxml),
  '画像卡挂载：profile/radar 双向传递',
);
assert(
  nbWxml.indexOf('{{coming.title}}') >= 0 &&
    nbDef.data.coming.title === '更多模块开发中' &&
    nbDef.data.coming.phase === 'T4.3–T4.5',
  '已加载态保留后续模块占位卡（data 驱动文案）',
);
assert(nbWxml.indexOf('bindtap="retry"') >= 0 && nbWxml.indexOf('重试') >= 0, '失败态重试按钮接线 retry');
assert(nbWxml.indexOf('wx:elif="{{loadError}}"') >= 0, '三态分支：loadError 优先于加载中占位');

section('speech-profile-card WXML/WXSS 结构（Android 复刻口径）');

const wxml = fs.readFileSync(path.join(__dirname, '../components/review/speech-profile-card/index.wxml'), 'utf8');
assert(wxml.indexOf('发音能力画像') >= 0, '卡片标题逐字');
assert(/<text wx:if="\{\{profile\.cefrLevel\}\}" class="spc-cefr">\{\{profile\.cefrLevel\}\} 级<\/text>/.test(wxml),
  'CEFR 纯文字胶囊（无图标，Android 口径）');
assert(wxml.indexOf('暂无画像数据') >= 0 && wxml.indexOf('完成语音评测后自动生成你的能力雷达') >= 0, '空态双行文案逐字');
assert(
  wxml.indexOf('评测次数') >= 0 && wxml.indexOf('综合得分') >= 0 && wxml.indexOf('平均语速') >= 0,
  '三统计格标签逐字（Android「综合得分」非 Web「综合均分」）',
);
assert(/<canvas[^>]*id="spcRadar"[^>]*type="2d"/.test(wxml), 'canvas 2d 声明（wx:if hasData）');
assert(wxml.indexOf('{{hintText}}') >= 0 && wxml.indexOf('spc-hint--cefr') >= 0, '说明条文案 data 驱动 + CEFR 态类');

const bindings = wxml.match(/\{\{[^}]+\}\}/g) || [];
assert(bindings.length > 0 && bindings.every((b) => !/\.\w+\(/.test(b)), 'WXML 绑定零方法调用红线');

const wxss = fs.readFileSync(path.join(__dirname, '../components/review/speech-profile-card/index.wxss'), 'utf8');
(function () {
  const m = wxss.match(/\.spc-cefr \{[^}]+\}/);
  assert(
    !!m && m[0].indexOf('border-radius: 999rpx') >= 0 && m[0].indexOf('var(--spc-secondary-12)') >= 0,
    'CEFR 胶囊：全圆 + secondary@0.12（RoundedCornerShape(50)）',
  );
  assert(wxss.indexOf('--spc-secondary-12: rgba(217, 138, 23, 0.12)') >= 0, 'secondary@0.12 变量原值');
  const b = wxss.match(/\.spc-icon-badge \{[^}]+\}/);
  assert(!!b && b[0].indexOf('68rpx') >= 0 && b[0].indexOf('20rpx') >= 0, 'IconBadge 34dp/圆角 10dp');
})();
assert(wxss.indexOf('#faf8f3') >= 0 && wxss.indexOf('#26221c') >= 0, '内嵌底双态原值（background/surfaceVariant）');
assert(wxss.indexOf('#1e1b16') >= 0, '深色卡面 surface #1E1B16');
assert(wxss.indexOf('#1c1917') >= 0 && wxss.indexOf('#e8e3d9') >= 0, 'onSurface 双态原值');
assert(wxss.indexOf('rgba(229, 224, 213, 0.4)') >= 0 && wxss.indexOf('rgba(58, 52, 44, 0.4)') >= 0, 'outline@0.4 双态边框');
assert(wxss.indexOf('height: 440rpx') >= 0, '雷达块 220dp 总高（含上下 8dp padding）');
assert(wxss.indexOf('height: 360rpx') >= 0, '空态 180dp 高');
assert(wxss.indexOf('rgba(217, 138, 23, 0.06)') >= 0, 'CEFR 说明底 secondary@0.06');
assert(
  /@media \(prefers-color-scheme: dark\)/.test(wxss) && /\.spc-card\.theme-light/.test(wxss),
  '深色双轨：媒体查询轨（跟随系统）+ .theme-light 全量重声明（手动浅色优先）',
);
assert(wxss.indexOf('text-overflow') < 0, '统计格不做省略截断（平均语速完整显示）');

const nbWxss = fs.readFileSync(path.join(__dirname, '../components/review/pron-notebook/index.wxss'), 'utf8');
assert(nbWxss.indexOf('.np-retry-btn') >= 0, '重试按钮样式存在');

/* ==================== 汇总 ==================== */

console.log(`\n========== 语音画像卡（Android 复刻）测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) {
  console.error('失败用例：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
}

main();
