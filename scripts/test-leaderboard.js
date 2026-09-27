/**
 * scripts/test-leaderboard.js — 发音达人榜自动化测试（REVIEW-TASK T4.5）
 *
 * Page 定义捕获 + makeInstance 騳动（复刻 Android SpeechLeaderboard 全行为）：
 *   1. 初始象限（weekly|score）拉取 + 行装饰（前三金银铜徽章 / 主副指标按维度
 *      互换 / 昵称首字母大写回退）+ 吸底「我的排名」
 *   2. 四象限缓存：Tab 来回切换即时呈现（不重复请求）
 *   3. loadingKey 竞态护栏：旧象限响应不落地（快速切换时错位防护）
 *   4. 401 → 「请先登录后查看排行榜」+ 重试；空榜 EmptyBoard
 *   5. 头像：相对路径补 BASE_URL 源；加载失败 → 首字母占位
 *   6. pron-core：parseLeaderboard / decorateLeaderboardRows / 枚举口径
 *   7. WXML/WXSS 结构与图标资产断言（Rank 金银铜 Material 原值）
 *
 * 运行：node scripts/test-leaderboard.js
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
/** 延迟响应队列（竞态护栏用例：挂起请求，手工按乱序 flush） */
const pendingDeferred = [];
function resolveRequest(opts) {
  const raw = opts.url.replace(/^https?:\/\/[^/]+/, '');
  requestLog.push({ url: raw, method: opts.method || 'GET' });
  let hit = apiResponses[raw];
  if (hit === undefined) hit = apiResponses[raw.split('?')[0]];
  if (hit === 'DEFER') {
    pendingDeferred.push(opts);
    return;
  }
  if (hit && hit.__statusCode) {
    opts.success({ statusCode: hit.__statusCode, data: hit.body || {} });
    return;
  }
  opts.success({
    statusCode: 200,
    data: hit === undefined ? { success: true, data: {} } : hit,
  });
}
function flushDeferred(body) {
  const opts = pendingDeferred.shift();
  if (opts) opts.success({ statusCode: 200, data: body });
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
require(path.join(__dirname, '../pages/review/leaderboard'));
assert(!!pageDef && typeof pageDef.onLoad === 'function', '模块加载：leaderboard Page 定义捕获成功');

const WXML = fs.readFileSync(path.join(__dirname, '../pages/review/leaderboard/index.wxml'), 'utf8');
const WXSS = fs.readFileSync(path.join(__dirname, '../pages/review/leaderboard/index.wxss'), 'utf8');
const JSON_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/review/leaderboard/index.json'), 'utf8'));

function makePage() {
  const inst = {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData(patch, cb) {
      // 支持 'entries[1].avatarFailed' 路径键（页面真实用法）
      Object.keys(patch).forEach((k) => {
        const m = k.match(/^(\w+)\[(\d+)\]\.(\w+)$/);
        if (m && Array.isArray(this.data[m[1]])) {
          this.data[m[1]][Number(m[2])][m[3]] = patch[k];
        } else {
          this.data[k] = patch[k];
        }
      });
      if (cb) cb();
    },
  };
  Object.keys(pageDef).forEach((k) => {
    if (typeof pageDef[k] === 'function') inst[k] = pageDef[k].bind(inst);
  });
  return inst;
}

function boardBody(entries, me) {
  return { success: true, data: { period: 'weekly', metric: 'score', entries, me } };
}
function entry(userid, nickname, evalCount, avgScore, avatar) {
  return { userid, nickname, avatar: avatar === undefined ? '/static/images/default-avatar.png' : avatar, evalCount, avgScore };
}

const SCORE_ENTRIES = [
  entry('u1', '阿政', 12, 93, 'https://oss/a1.jpg'),
  entry('u2', 'Bob', 20, 88, ''),
  entry('u3', '小蔡', 9, 85),
  entry('u4', '用户_d4', 7, 81),
  entry('u5', '敏', 6, 79),
];
const ME = { rank: 23, evalCount: 8, avgScore: 76.4 };

apiResponses['/api/speech/leaderboard?period=weekly&metric=score'] = boardBody(SCORE_ENTRIES, ME);
apiResponses['/api/speech/leaderboard?period=weekly&metric=count'] =
  boardBody(SCORE_ENTRIES.slice().reverse(), null);
apiResponses['/api/speech/leaderboard?period=daily&metric=score'] =
  boardBody([], null); // 今日空榜

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- 1. 初始象限 + 行装饰 ---------- */
  section('初始象限（weekly|score）');

  const p = makePage();
  p.onLoad();
  await settle(10);
  assert(requestLog[0] && requestLog[0].url.includes('period=weekly&metric=score'),
    '初始请求 weekly|score');
  assert(p.data.isLoading === false && p.data.entries.length === 5, '榜单 5 行落地');
  const [r1, r2, r3, r4, r5] = p.data.entries;
  assert(r1.medal === 'gold' && r2.medal === 'silver' && r3.medal === 'bronze' && r4.medal === '' && r5.medal === '',
    '前三名金银铜徽章 / 其余数字位');
  assert(r4.rankText === '4', '数字排名位 rankText');
  assert(r1.mainText === '93 分' && r1.subText === '12 次评测', 'score 维度：N 分 / N 次评测');
  assert(r2.initial === 'B', '昵称首字母大写（头像回退占位）');
  assert(r2.avatar === '' && r2.avatarFailed === false, '空头像：待回退（不预置失败）');
  assert(r1.avatar === 'https://oss/a1.jpg', '绝对头像原样透传');
  assert(r3.avatar.startsWith('https://') && r3.avatar.includes('/static/images/default-avatar.png'),
    '相对头像补 BASE_URL 源');
  assert(p.data.me && p.data.me.rank === 23 && p.data.me.evalCount === 8 && p.data.me.avgScore === 76,
    'me 卡：rank/evalCount/avgScore（四舍五入）');
  assert(p.data.ruleText === '平均综合分（≥5次评测）', '副行规则文案（score）');

  /* ---------- 2. 头像失败回退 ---------- */
  section('头像失败 → 首字母');

  p.onAvatarError({ currentTarget: { dataset: { index: 1 } } });
  assert(p.data.entries[1].avatarFailed === true, 'binderror → avatarFailed 置位');
  p.onAvatarError({ currentTarget: { dataset: { index: 1 } } });
  assert(p.data.entries[1].avatarFailed === true, '重复 error 不重复 setData（幂等）');

  /* ---------- 3. 四象限缓存 ---------- */
  section('四象限切换与缓存');

  p.selectMetric({ currentTarget: { dataset: { key: 'count' } } });
  await settle(10);
  assert(p.data.metric === 'count' && p.data.ruleText === '练习次数', '切 count：规则文案同步');
  assert(p.data.entries[0].mainText.endsWith(' 次') && p.data.entries[0].subText.startsWith('平均 '),
    'count 维度主副指标互换');
  assert(p.data.me === null, 'count 象限无 me → 吸底卡退场');
  const fetchCount1 = requestLog.length;
  p.selectMetric({ currentTarget: { dataset: { key: 'score' } } });
  await settle(10);
  assert(p.data.entries[0].mainText === '93 分' && p.data.me, '切回 score：缓存即时呈现');
  assert(requestLog.length === fetchCount1, '缓存命中：零重复请求');
  p.selectPeriod({ currentTarget: { dataset: { key: 'daily' } } });
  await settle(10);
  assert(p.data.entries.length === 0 && p.data.isLoading === false, 'daily|score 空榜');
  // 未缓存象限在加载期不呈现其他象限的陈旧行（Android board==null 语义）
  p.selectPeriod({ currentTarget: { dataset: { key: 'weekly' } } });
  await settle(10);
  apiResponses['/api/speech/leaderboard?period=daily&metric=count'] = 'DEFER';
  p.selectPeriod({ currentTarget: { dataset: { key: 'daily' } } });
  p.selectMetric({ currentTarget: { dataset: { key: 'count' } } });
  assert(p.data.entries.length === 0 && p.data.me === null && p.data.isLoading === true,
    '切未缓存象限：旧榜先清（加载态）');
  pendingDeferred.length = 0; // 丢弃挂起请求，恢复 weekly|score 供后续用例
  p.selectPeriod({ currentTarget: { dataset: { key: 'weekly' } } });
  p.selectMetric({ currentTarget: { dataset: { key: 'score' } } });
  await settle(10);
  const fetchCount2 = requestLog.length;
  p.selectPeriod({ currentTarget: { dataset: { key: 'weekly' } } });
  p.selectPeriod({ currentTarget: { dataset: { key: 'weekly' } } });
  assert(requestLog.length === fetchCount2, '同象限重复点击不再请求');
  assert(p.data.period === 'weekly' && p.data.entries[0].mainText === '93 分', '回 weekly：缓存呈现');

  /* ---------- 4. 竞态护栏 ---------- */
  section('loadingKey 竞态护栏');

  const q = makePage();
  q.onLoad();
  await settle(10);
  apiResponses['/api/speech/leaderboard?period=daily&metric=count'] = 'DEFER';
  q.selectPeriod({ currentTarget: { dataset: { key: 'daily' } } });
  q.selectMetric({ currentTarget: { dataset: { key: 'count' } } });
  await settle(10);
  assert(pendingDeferred.length === 1, 'daily|count 请求挂起（延迟响应）');
  // 用户已切走（回 weekly|score）后才返回：不得落地 daily|count
  q.selectPeriod({ currentTarget: { dataset: { key: 'weekly' } } });
  flushDeferred(boardBody(SCORE_ENTRIES, ME));
  await settle(10);
  assert(q._boards['daily|count'] === undefined, '过期响应不写入缓存');
  assert(q.data.period === 'weekly' && q.data.entries.length === 5, '当前象限仍正确呈现');
  // 再切回 daily|count：未缓存 → 重新请求
  delete apiResponses['/api/speech/leaderboard?period=daily&metric=count'];
  const before = requestLog.length;
  q.selectPeriod({ currentTarget: { dataset: { key: 'daily' } } });
  await settle(10);
  assert(requestLog.length === before + 1, '未缓存象限重进 → 重新拉取');

  /* ---------- 5. 错误态 ---------- */
  section('401 toast / 失败 / 重试');

  apiResponses['/api/speech/leaderboard?period=daily&metric=score'] =
    { __statusCode: 401, body: { error: 'unauthorized' } };
  const e1 = makePage();
  e1.onLoad({});
  e1.selectPeriod({ currentTarget: { dataset: { key: 'daily' } } });
  await settle(10);
  assert(toastTitles.indexOf('请先登录后查看排行榜') >= 0,
    '401 → toast「请先登录后查看排行榜」（Web 口径）');
  assert(e1.data.loadError === '' && e1.data.entries.length === 0 && e1.data.me === null,
    '401 → 空榜呈现（不进错误重试态）');
  apiResponses['/api/speech/leaderboard?period=daily&metric=score'] =
    { __statusCode: 500, body: { error: 'boom' } };
  e1.onRetry();
  await settle(10);
  assert(e1.data.loadError === 'boom', '5xx → 后端文案');
  assert(e1.data.entries.length === 0, '错误态不呈现榜单');
  apiResponses['/api/speech/leaderboard?period=daily&metric=score'] =
    boardBody(SCORE_ENTRIES, ME);
  e1.onRetry();
  await settle(10);
  assert(e1.data.isLoading === false && e1.data.entries.length === 5, '重试成功恢复');

  /* ---------- 6. pron-core 纯函数 ---------- */
  section('pron-core：parseLeaderboard / decorateLeaderboardRows');

  const core = require('../utils/pron-core');
  assert(core.LEADERBOARD_PERIODS.length === 2 &&
    core.LEADERBOARD_PERIODS[0].label === '近7天' &&
    core.LEADERBOARD_PERIODS[1].key === 'daily', '周期枚举（近7天/今日；key 即 apiValue）');
  assert(core.LEADERBOARD_METRICS[0].key === 'score' &&
    core.LEADERBOARD_METRICS[0].ruleText === '平均综合分（≥5次评测）' &&
    core.LEADERBOARD_METRICS[1].label === '勤奋榜', '维度枚举（ruleText 逐字）');

  assert(core.parseLeaderboard({ success: false }) === null, '失败信封 → null');
  const pl = core.parseLeaderboard({
    success: true,
    data: {
      period: 'weekly', metric: 'count',
      entries: [entry('u1', '小明', 3, 88.6), null],
      me: { rank: 2, evalCount: 3, avgScore: 88.6 },
    },
  });
  assert(pl.entries.length === 2 && pl.entries[0].avgScore === 89, '行归一（null 行防御 + 均分四舍五入）');
  assert(pl.entries[1].nickname === '' && pl.entries[1].evalCount === 0, 'null 行兜底空值');
  assert(pl.me.rank === 2 && pl.me.avgScore === 89, 'me 归一');
  const plNoMe = core.parseLeaderboard({ success: true, data: { entries: [], me: null } });
  assert(plNoMe.me === null, 'me 缺省 → null');

  const rows = core.decorateLeaderboardRows(pl.entries, 'count');
  assert(rows[0].mainText === '3 次' && rows[0].subText === '平均 89 分', 'count 装饰（主副互换）');
  assert(rows[1].initial === '', '空昵称 initial 空串防御');
  const rowsScore = core.decorateLeaderboardRows([{ nickname: 'amy', evalCount: 5, avgScore: 90 }], 'score');
  assert(rowsScore[0].initial === 'A' && rowsScore[0].medal === 'gold', '首字母大写 + #1 金');

  /* ---------- 7. WXML / WXSS / 图标资产 ---------- */
  section('WXML 结构 + 图标资产（Material 原值）');

  assert(WXML.includes('榜单按{{ruleText}}排名'), '顶栏副行规则文案');
  assert(WXML.includes('发音达人榜') && WXML.includes('emoji-events-secondary.svg') &&
    WXML.includes('lb-trophy-box'), '奖杯标题（30dp secondary@0.12 盒）');
  assert(WXML.includes('emoji-events-gold.svg') && WXML.includes('military-tech-silver.svg') &&
    WXML.includes('military-tech-bronze.svg'), '前三名金银铜图标');
  assert(WXML.includes('lb-pill-opt--primary') && WXML.includes('lb-pill-opt--secondary'),
    '双 pill：周期 primary 实底 / 维度 secondary 实底');
  assert(WXML.includes('本周期暂无上榜记录') && WXML.includes('完成语音评测即可上榜'),
    '空榜文案（逐字）');
  assert(WXML.includes('#{{me.rank}}') && WXML.includes('我的排名') &&
    WXML.includes('{{me.evalCount}} 次评测 · 平均 {{me.avgScore}} 分'), '吸底我的排名卡');
  assert(WXML.includes('binderror="onAvatarError"') && WXML.includes('lb-avatar-initial'),
    '头像失败回退首字母');
  assert(WXML.includes('lb-divider') && WXML.includes('wx:if="{{ri < entries.length - 1}}"'),
    '行间 HorizontalDivider（末行无）');
  assert(WXML.includes('arrow-back-ink.svg') && WXML.includes('arrow-back-dark.svg'),
    '顶栏返回 ArrowBack 双深浅');
  assert(JSON_CFG.navigationStyle === 'custom', 'json：custom 导航');

  assert(WXSS.includes('--lb-secondary: #d98a17') && !WXSS.includes('--lb-secondary: #7'),
    'secondary 双态恒值 #D98A17');
  assert(WXSS.includes('--lb-on-secondary: #151310'), '深色 onSecondary（DarkSecondary 配对）');
  assert(WXSS.includes('border-radius: 24rpx') && WXSS.includes('padding: 6rpx') &&
    WXSS.includes('border-radius: 18rpx'), 'pill 几何（12/3/9dp）');
  assert(WXSS.includes('width: 80rpx') && WXSS.includes('border-radius: 50%'),
    '头像 40dp 圆');
  assert(WXSS.includes('width: 44rpx'), '徽章 22dp');
  assert(WXSS.includes('.theme-dark') && WXSS.includes('.theme-light') &&
    WXSS.includes('prefers-color-scheme: dark'), '三轨主题');
  assert(WXSS.includes('position: absolute') && WXSS.includes('env(safe-area-inset-bottom)'),
    'me 卡吸底 + 安全区');
  assert(WXSS.includes('216rpx'), '列表尾部 108dp 留白（me 卡不遮末行）');

  ['emoji-events-gold', 'military-tech-silver', 'military-tech-bronze',
    'emoji-events-secondary', 'arrow-back-ink', 'arrow-back-dark'].forEach((name) => {
    assert(fs.existsSync(path.join(__dirname, '../assets/icons', name + '.svg')),
      '图标资产：' + name + '.svg 存在');
  });
  const gold = fs.readFileSync(path.join(__dirname, '../assets/icons/emoji-events-gold.svg'), 'utf8');
  const silver = fs.readFileSync(path.join(__dirname, '../assets/icons/military-tech-silver.svg'), 'utf8');
  const bronze = fs.readFileSync(path.join(__dirname, '../assets/icons/military-tech-bronze.svg'), 'utf8');
  assert(gold.includes('fill="#EAB308"') && silver.includes('fill="#9CA3AF"') &&
    bronze.includes('fill="#D97706"'), '金银铜色值（Web Crown/Medal 原值）');
  // viewBox 网格回归（真机白图教训）：military_tech 是 0 -960 960 960 网格的
  // Material Symbols 字形，错配 0 0 24 24 viewBox 时路径整体落出视口 → #2/#3
  // 奖牌渲染成空白；换色烘焙必须连同源 viewBox 一起复用
  assert(silver.includes('viewBox="0 -960 960 960"') &&
    bronze.includes('viewBox="0 -960 960 960"'),
    '银铜奖牌：960 网格字形配 0 -960 960 960 viewBox（白图回归锁死）');
  assert(gold.includes('viewBox="0 0 24 24"'), '金皇冠：24 网格字形配 24 viewBox');

  /* ==================== 汇总 ==================== */
  console.log(`\n━━━ 汇总 ━━━`);
  console.log(`通过 ${passed} / 失败 ${failed}`);
  if (failed) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
