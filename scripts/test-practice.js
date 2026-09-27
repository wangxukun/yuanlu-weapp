/**
 * scripts/test-practice.js — 发音闯关复习页自动化测试（REVIEW-TASK T4.5）
 *
 * Page 定义捕获 + makeInstance 騳动（复刻 Android WeaknessPractice 全行为）：
 *   1. 数据加载：GET /api/speech/errors（weakThreshold 在信封顶层）/ 403 整页
 *      锁定 / 401 登录文案 / 网络错误兜底 / 空弱项集 EmptyPane
 *   2. 换题：subtitle 装配（subtitleId ?? recognitionid / end 兜底 start+3）、
 *      进度 (index+1)/N、isLast、prevDisabled、结果不缓存（换题重置）
 *   3. 深链 ?subtitleId= 定位
 *   4. 达标：evaluate score ≥ weakThreshold → 顶栏徽章（completed 集合）
 *   6. 相变联动：phasechange processing → evaluating → 底部两钮禁用
 *   7. eval-card 工具行五钮同语音评测页（最近得分链路整体退役）+
 *      phasechange 事件 + previousResult observer
 *   8. WXML/WXSS 结构与图标资产断言（Material 原值）
 *
 * 运行：node scripts/test-practice.js
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

const apiResponses = {};
const requestLog = [];
function resolveRequest(opts) {
  const raw = opts.url.replace(/^https?:\/\/[^/]+/, '');
  const p = raw.split('?')[0];
  requestLog.push({ path: p, query: raw.split('?')[1] || '', method: opts.method || 'GET' });
  let hit = apiResponses[p];
  if (hit === undefined) hit = apiResponses[raw];
  if (hit && hit.__statusCode) {
    opts.success({ statusCode: hit.__statusCode, data: hit.body || {} });
    return;
  }
  const body = typeof hit === 'function' ? hit(opts) : hit;
  opts.success({
    statusCode: 200,
    data: body === undefined ? { success: true, data: {} } : body,
  });
}

const navBackCalls = [];
const toastTitles = [];

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastTitles.push(o.title),
  showModal: (o) => o.success && o.success({ confirm: false }),
  navigateTo: () => {},
  navigateBack: (o) => {
    navBackCalls.push(1);
    if (o && o.fail) o.fail({});
  },
  switchTab: (o) => o.url,
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  request: resolveRequest,
  getBackgroundAudioManager: () => ({
    play() {}, pause() {}, stop() {}, seek() {},
    onPlay() {}, onPause() {}, onStop() {}, onEnded() {},
    onTimeUpdate() {}, onCanplay() {}, onWaiting() {}, onError() {},
    onPrev() {}, onNext() {},
  }),
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375, statusBarHeight: 44 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, theme: 'light' }),
};
global.getApp = () => ({ globalData: {} });

let pageDef = null;
global.Page = (cfg) => { pageDef = cfg; };
require(path.join(__dirname, '../pages/review/practice'));
assert(!!pageDef && typeof pageDef.onLoad === 'function', '模块加载：practice Page 定义捕获成功');

const WXML = fs.readFileSync(path.join(__dirname, '../pages/review/practice/index.wxml'), 'utf8');
const WXSS = fs.readFileSync(path.join(__dirname, '../pages/review/practice/index.wxss'), 'utf8');
const JSON_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/review/practice/index.json'), 'utf8'));

function makePage() {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData(patch, cb) {
      Object.assign(this.data, patch);
      if (cb) cb();
    },
  };
  Object.keys(pageDef).forEach((k) => {
    if (typeof pageDef[k] === 'function') inst[k] = pageDef[k].bind(inst);
  });
  return inst;
}

function makeRecord(i, extra) {
  return Object.assign({
    recognitionid: 100 + i,
    episodeid: 'ep' + i,
    episode: { title: '剧集' + i, coverUrl: 'https://oss/c' + i + '.jpg', audioUrl: 'https://oss/a' + i + '.m4a' },
    targetText: 'Weak target ' + i + '.',
    targetStartTime: 10 + i,
    subtitleTextCn: '弱项译文' + i,
    subtitleWords: [{ word: 'Weak', start: 10.1, end: 10.5 }],
    subtitleEnd: 13.5,
    subtitleId: 1000 + i,
    accuracyScore: 62,
    overallScore: 66,
    speed: 120,
    recognitionDate: '2026-09-01T00:00:00.000Z',
  }, extra || {});
}

  const R1 = makeRecord(1);
const R2 = makeRecord(2, { overallScore: null }); // lastScore 回落 accuracyScore
const R3 = makeRecord(3); // 试用结算墙用（3 条切片）

apiResponses['/api/speech/errors'] = {
  success: true,
  data: [R1, R2],
  weakThreshold: 85, // 信封顶层（后端 route.ts 原样）
  totalErrors: 2,
  isTrialMode: false,
};
// 复习日池预检（Web [P3-c]：scenario/used/limit/remaining/exhausted/isPremium）
apiResponses['/api/speech/quota'] = {
  success: true,
  data: { scenario: 'review', used: 0, limit: 5, remaining: 5, exhausted: false, isPremium: false },
};

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- 1. 数据加载与首题装配 ---------- */
  section('数据加载 + 首题装配');

  const p = makePage();
  p.onLoad({});
  await settle(10);
  assert(p.data.loading === false && p.data.total === 2, '加载成功：total = 2');
  assert(p.data.index === 0 && p.data.prevDisabled === true && p.data.isLast === false,
    '首题：prevDisabled / 非末题');
  assert(Math.abs(p.data.progressPercent - 50) < 0.01, '进度 (1/2) = 50%');
  assert(p.data.subtitle.textEn === 'Weak target 1.', 'subtitle.textEn = targetText');
  assert(p.data.subtitle.textCn === '弱项译文1' && p.data.subtitle.audioUrl === 'https://oss/a1.m4a',
    'textCn/audioUrl = errors 接口补齐字段');
  assert(p.data.subtitleId === 1001 && p.data.episodeId === 'ep1', 'subtitleId = 弱项记录 subtitleId');
  assert(p.data.subtitle.end === 13.5, 'end = subtitleEnd 精确值');
  assert(p.data.cardKey === 'pr-101', '卡片 key 按题重挂（pr-recognitionid）');
  assert(p._weakThreshold === 85, 'weakThreshold 取信封顶层（非 data 内）');

  // 深链 subtitleId
  const pd = makePage();
  pd.onLoad({ subtitleId: '1002' });
  await settle(10);
  assert(pd.data.index === 1 && pd.data.subtitleId === 1002, '深链 subtitleId=1002 → 第 2 题');

  /* ---------- 2. 四态分流 ---------- */
  section('四态：403 锁定 / 401 / 网络 / 空');

  apiResponses['/api/speech/errors'] = { __statusCode: 403, body: { error: 'PRO 会员功能' } };
  const p403 = makePage();
  p403.onLoad({});
  await settle(10);
  assert(p403.data.isLocked === true && p403.data.loadError === '', '403 → 整页锁定态（loadError 空）');

  apiResponses['/api/speech/errors'] = { __statusCode: 401, body: { error: 'unauthorized' } };
  const p401 = makePage();
  p401.onLoad({});
  await settle(10);
  assert(p401.data.loadError === '请先登录后查看', '401 → 「请先登录后查看」');

  apiResponses['/api/speech/errors'] = { __statusCode: 500, body: { error: 'boom' } };
  const p500 = makePage();
  p500.onLoad({});
  await settle(10);
  assert(p500.data.loadError === 'boom', '5xx → 后端可读文案');

  apiResponses['/api/speech/errors'] = { success: true, data: [], weakThreshold: 80, totalErrors: 0 };
  const pe = makePage();
  pe.onLoad({});
  await settle(10);
  assert(pe.data.isEmpty === true && pe.data.loading === false, '空弱项集 → EmptyPane');

  apiResponses['/api/speech/errors'] = { success: false };
  const pb = makePage();
  pb.onLoad({});
  await settle(10);
  assert(pb.data.loadError === '弱项本数据加载失败', '坏形状 → 弱项本数据加载失败');
  pb.onRetry();
  await settle(10);
  assert(pb.data.loading === false, '重试路径可达');

  apiResponses['/api/speech/errors'] = {
    success: true, data: [R1, R2], weakThreshold: 85, totalErrors: 2, isTrialMode: false,
  };

  /* ---------- 3. 达标徽章 ---------- */
  section('达标判定');

  const q = makePage();
  q.onLoad({});
  await settle(10);
  assert(q.data.isCompleted === false, '入场无徽章');
  q.onEvaluate({ detail: { score: 84 } });
  assert(q.data.isCompleted === false, '84 < 85（weakThreshold）→ 不达标');
  q.onEvaluate({ detail: { score: 86 } });
  assert(q.data.isCompleted === true, '86 ≥ 85 → 达标（顶栏徽章依据）');
  // 换题后回看：completed 集合保持（内存态）
  q.onNext();
  assert(q.data.index === 1 && q.data.isCompleted === false, '换到第 2 题：该题未达标');
  q.onPrev();
  assert(q.data.index === 0 && q.data.isCompleted === true, '换回第 1 题：徽章恢复（集合口径）');

  /* ---------- 4. 相变联动底部导航 ---------- */
  section('phasechange → evaluating');

  const n = makePage();
  n.onLoad({});
  await settle(10);
  n.onPhaseChange({ detail: { phase: 'processing' } });
  assert(n.data.evaluating === true, 'processing → evaluating');
  const idxBefore = n.data.index;
  n.onNext();
  n.onPrev();
  assert(n.data.index === idxBefore, 'evaluating 中两钮均禁点');
  n.onPhaseChange({ detail: { phase: 'result' } });
  assert(n.data.evaluating === false, 'result → 恢复可用');

  /* ---------- 5. 末题完成复习 ---------- */
  section('末题「完成复习」');

  const f = makePage();
  f.onLoad({ subtitleId: '1002' });
  await settle(10);
  assert(f.data.isLast === true, '深链至末题');
  navBackCalls.length = 0;
  f.onNext(); // isLast → onExit → navigateBack
  assert(navBackCalls.length === 1, '完成复习 → navigateBack');

  /* ---------- 6. pron-core 纯函数 ---------- */
  section('pron-core：parseErrors / buildPracticeCard');

  const core = require('../utils/pron-core');
  const parsed = core.parseErrors({
    success: true, data: [R1], weakThreshold: 999, totalErrors: 9, isTrialMode: true,
  });
  assert(parsed.weakThreshold === 95, 'weakThreshold 越界收口 [60,95] → 95');
  assert(parsed.isTrialMode === true && parsed.records.length === 1, '试用标记 + 记录归一');
  assert(core.parseErrors({ success: false }) === null, '失败信封 → null');

  const card = core.buildPracticeCard(core.normalizeErrorRecord(Object.assign({}, makeRecord(3, {
    subtitleId: null, subtitleEnd: null, subtitleWords: null, targetStartTime: 7,
  }))));
  assert(card.subtitleId === 103, 'subtitleId 缺省 → recognitionid');
  assert(card.subtitle.end === 10, 'end 兜底 start+3');
  assert(card.subtitle.words.length === 0, 'words 缺省 → []');
  assert(card.subtitle.audioUrl === 'https://oss/a3.m4a', 'audioUrl 透传');

  /* ---------- 7. eval-card 工具行（五钮同语音评测页；最近得分退役） ---------- */
  section('eval-card：五钮工具行 + 相变外抛');

  const EC_JS = fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.js'), 'utf8');
  const EC_WXML = fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.wxml'), 'utf8');
  const EC_WXSS = fs.readFileSync(path.join(__dirname, '../components/voice/eval-card/index.wxss'), 'utf8');

  // 五钮顺序：AI朗读 → 原声播放 → 慢速播放 → 收藏书签 → 单句循环（无最近得分）
  const acts = EC_WXML.match(/<text class="ec-act-label">([^<]+)<\/text>/g) || [];
  const labels = acts.map((m) => m.replace(/<[^>]+>/g, ''));
  assert(labels.join('|') === 'AI朗读|原声播放|慢速播放|收藏书签|单句循环',
    '工具行五钮次序 = 语音评测页同款');
  assert(!EC_WXML.includes('最近得分') && !EC_WXML.includes('leaderboard-primary'),
    '最近得分钮退役（无文案/无图标引用）');
  assert(!EC_JS.includes('showLatestScore') && !EC_JS.includes('latestscore') &&
    !EC_JS.includes('showBookmark') && !EC_JS.includes('showLoop'),
    '闯关形态三 props + latestscore 事件退役（无死代码）');
  assert(!EC_WXSS.includes('ec-actions--split') && !EC_WXSS.includes('ec-act-spacer'),
    'split 布局样式退役');
  assert(EC_JS.includes("previousResult(v)") && EC_JS.includes("phase: 'result', result: v"),
    'previousResult observer：后置注入翻结果面（shadowing 结果恢复共用）');
  assert((EC_JS.match(/_emitPhase\(/g) || []).length >= 6, 'phasechange 相变外抛（recording/processing/result/idle 全覆盖）');

  /* ---------- 9. Web 口径恢复：日池预检 + 配额余量胶囊 ---------- */
  section('配额预检与余量胶囊（Web [P3-c]）');

  const g = makePage();
  g.onLoad({});
  await settle(10);
  assert(g.data.showQuota === true && g.data.quotaWarn === false,
    '非会员余量 5 → 胶囊普通态（无皇冠）');
  assert(g.data.quotaText === '今日剩余 5 次免费评测', '胶囊文案（普通态无后缀）');
  assert(g.data.quotaLocked === false, '未触墙 → 卡不置锁');

  // 评测后余量刷新（eval-card quota 事件全量形状）
  g.onQuota({ detail: { used: 3, limit: 5, remaining: 2, exhausted: false, isPremium: false } });
  assert(g.data.quotaWarn === true, '余量 2 < 3 → 琥珀预警');
  assert(g.data.quotaText === '今日剩余 2 次免费评测，明日额度自动就位',
    '预警文案（，明日额度自动就位）');

  // 403 触墙形状（eval-card 仅外抛 {exhausted:true}）
  g.onQuota({ detail: { exhausted: true } });
  assert(g.data.quotaLocked === true && g.data.quotaWarn === true,
    '触墙 → 卡置锁（余量保持旧值仍预警）');

  // 会员（跨天/升级场景）
  g.onQuota({ detail: { used: 1, limit: 5, remaining: 4, exhausted: false, isPremium: true } });
  assert(g.data.showQuota === false && g.data.quotaLocked === false,
    '会员 → 胶囊退场 + 解锁');

  /* ---------- 10. 试用结算墙（Web [P3-c] 成就先行） ---------- */
  section('试用结算墙');

  apiResponses['/api/speech/errors'] = {
    success: true,
    data: [R1, R2, R3],
    weakThreshold: 85,
    totalErrors: 7,   // 全量 7，试用切片 3 → lockedCount 4
    isTrialMode: true,
  };
  const t = makePage();
  t.onLoad({});
  await settle(10);
  assert(t.data.showSettlement === false, '非末题不触发结算');
  t.onNext();
  t.onNext(); // 末题 index 2
  assert(t.data.isLast === true && t.data.showSettlement === true,
    '试用模式走到末题 → 结算横幅（成就先行）');
  assert(t.data.lockedCount === 4, 'lockedCount = totalErrors(7) − 切片(3)');
  assert(t.data.completedCount === 0, '今日攻克 0/3');
  t.onEvaluate({ detail: { score: 90 } });
  assert(t.data.completedCount === 1, '达标一题 → 今日攻克 1/3');
  navBackCalls.length = 0;
  t.onNext(); // 末题 + 结算 → 开会员窗而非退出
  assert(t.data.showPremiumModal === true && t.data.premiumVars &&
    t.data.premiumVars.totalErrors === 4,
    '末钮「下一关·解锁 PRO」→ premium-modal(pronunciation_locked, {totalErrors:4})');
  assert(navBackCalls.length === 0, '结算优先：不 navigateBack');
  // 非试用（会员/全量）末钮仍为完成复习退出（前面「末题完成复习」用例已覆盖）

  /* ---------- 11. WXML / WXSS / 图标资产 ---------- */
  section('WXML 结构 + 图标资产（Material 原值）');

  assert(WXML.includes('发音闯关复习 ({{index + 1}}/{{total}})'), '顶栏标题携带进度');
  assert(WXML.includes('已达标') && WXML.includes('check-circle-primary-dark.svg') &&
    WXML.includes('/assets/icons/check-circle.svg'), '达标徽章：CheckCircle 双深浅');
  assert(WXML.includes('pr-progress-track') && WXML.includes('style="width: {{progressPercent}}%"'),
    '闯关进度条');
  assert(!WXML.includes('show-bookmark') && !WXML.includes('show-loop') &&
    !WXML.includes('show-latest-score'),
    '评测卡走默认五钮工具行（无形态开关透传）');
  assert(WXML.includes('pass-threshold="{{weakThreshold}}"'), '卡片 Excellent 档绑定 weakThreshold（信封顶层同源）');
  assert(WXML.includes('bind:phasechange="onPhaseChange"') && !WXML.includes('latestscore'),
    'phasechange 事件接线（latestscore 已退役）');
  assert(WXML.includes('bind:quota="onQuota"') && WXML.includes('quota-locked="{{quotaLocked}}"'),
    '日池预检置锁 + 余量刷新接线');
  // Web [P3-c] 口径恢复：配额胶囊 / 结算横幅 / PRO 末钮
  assert(WXML.includes('pr-quota--warn') && WXML.includes('{{quotaText}}'),
    '配额余量胶囊（普通/预警双态 + JS 派生文案）');
  assert(WXML.includes('workspace-premium-amber.svg') &&
    WXML.includes('workspace-premium-amber-dark.svg'), '预警皇冠双深浅（workspace_premium）');
  assert(WXML.includes('今日攻克 {{completedCount}}/{{total}}') &&
    WXML.includes('还有 {{lockedCount}} 条弱项句子待攻克，继续闯关精准消灭发音弱点'),
    '结算横幅文案（逐字）');
  assert(WXML.includes('下一关 · 解锁 PRO') && WXML.includes('workspace-premium-white.svg') &&
    WXML.includes('pr-nav-btn-pro'), '末钮琥珀「下一关 · 解锁 PRO」变形');
  assert(WXML.includes('quota-locked="{{quotaLocked}}"') && WXML.includes('bind:quota="onQuota"'),
    '日池预检置锁 + 评测后余量刷新接线');
  assert(WXML.includes('vars="{{premiumVars}}"'), '会员窗 vars 透传（结算 lockedCount）');
  assert(WXML.includes('{{isLast ? \'完成复习\' : \'下一题\'}}') ||
    (WXML.includes('完成复习') && WXML.includes('下一题')), '底部右钮文案（末题完成复习/下一题）');
  assert(WXML.includes('上一题') && WXML.includes('keyboard-arrow-left'), '底部左钮（KeyboardArrowLeft）');
  assert(WXML.includes('keyboard-arrow-right-white.svg'), '右钮箭头（onPrimary 白）');
  assert(WXML.includes('弱项练习是 PRO 会员功能') &&
    WXML.includes('升级会员解锁发音诊断、弱项句子收录与针对性循环练习。') &&
    WXML.includes('解锁 PRO 会员'), '锁定态三段文案（逐字）');
  assert(WXML.includes('没有待复习的弱项') && WXML.includes('您的发音记录非常完美，继续保持！'),
    '空态文案（逐字）');
  assert(WXML.includes('source="pronunciation_locked"'), '解锁 CTA → premium-modal(pronunciation_locked)');
  assert(WXML.includes('arrow-back-ink.svg') && WXML.includes('arrow-back-dark.svg'), '顶栏返回 ArrowBack 双深浅');
  assert(JSON_CFG.navigationStyle === 'custom' &&
    JSON_CFG.usingComponents['eval-card'] === '/components/voice/eval-card/index',
    'json：custom 导航 + eval-card 注册');

  assert(WXSS.includes('--pr-track: #f2efe8') && WXSS.includes('--pr-track: #26221c'),
    '进度轨道 surfaceVariant 双态');
  assert(WXSS.includes('height: 12rpx') && WXSS.includes('border-radius: 999rpx'),
    '进度条 6dp 圆头');
  assert(WXSS.includes('--pr-primary: #1f7a5c') && WXSS.includes('--pr-primary: #4da989'),
    'primary 双态（Color.kt 原值）');
  assert(WXSS.includes('.theme-dark') && WXSS.includes('.theme-light') &&
    WXSS.includes('prefers-color-scheme: dark'), '三轨主题（媒体查询 + 平类双覆盖）');
  assert(WXSS.includes('border: 2rpx solid var(--pr-outline)'), 'OutlinedButton 描边');
  assert(WXSS.includes('env(safe-area-inset-bottom)'), '底部安全区');
  // Web [P3-c] 色值（amber-50/500/600/400 + success 三档透明度原值）
  assert(WXSS.includes('--pr-amber-bg: #fffbeb') && WXSS.includes('--pr-amber-text: #d97706') &&
    WXSS.includes('rgba(245, 158, 11, 0.1)') && WXSS.includes('--pr-amber-text: #fbbf24'),
    '胶囊预警琥珀双态（amber-50/600 浅 · amber-500·10/400 深）');
  assert(WXSS.includes('background: #f59e0b') &&
    WXSS.includes('rgba(245, 158, 11, 0.2)'), 'PRO 末钮 amber-500 实底 + /20 投影');
  assert(WXSS.includes('rgba(46, 143, 111, 0.05)') && WXSS.includes('rgba(46, 143, 111, 0.1)') &&
    WXSS.includes('rgba(46, 143, 111, 0.3)'), '结算横幅 success /5 /10 /30 三档');
  assert(WXSS.includes('margin-bottom: 48rpx'), '结算横幅 mb-6 间距');

  ['arrow-back-ink', 'arrow-back-dark', 'check-circle', 'check-circle-primary-dark',
    'keyboard-arrow-right-white', 'lock-primary', 'lock-primary-dark',
    'keyboard-arrow-left-primary', 'keyboard-arrow-left-dark',
    'workspace-premium-amber', 'workspace-premium-amber-dark', 'workspace-premium-white'].forEach((name) => {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', name + '.svg')),
      '图标资产：' + name + '.svg 存在');
  });
  const wpSvg = fs.readFileSync(path.join(__dirname, '../assets/icons/workspace-premium-white.svg'), 'utf8');
  assert(wpSvg.includes('M9.68,13.69') && wpSvg.includes('fill="#ffffff"'),
    'workspace_premium：Material 官方 path（gstatic 原值）+ 白色');
  assert(!fs.existsSync(path.join(__dirname, '../assets/icons/leaderboard-primary.svg')),
    'leaderboard-primary.svg 已随「最近得分」退役删除');
  const abSvg = fs.readFileSync(path.join(__dirname, '../assets/icons/arrow-back-ink.svg'), 'utf8');
  assert(abSvg.includes('M20,11H7.83l5.59-5.59'), 'arrow_back：Material 官方 path');

  /* ==================== 汇总 ==================== */
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failed) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
