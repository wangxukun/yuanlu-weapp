/**
 * scripts/test-learning-report.js — 学习报表模块测试（个人中心阶段 8）
 *
 * 覆盖两层：
 * 1. utils/profile-core.js 报表纯函数：reportBrief 派生 / reportSuggestions 五规则
 *    （顺序 + fallback + slice 3）/ heatmapLevel 分档边界 / heatmapGrid 周一对齐与
 *    月标注 / xLabelStride 抽稀 / mapReport 防御映射
 * 2. pages/profile/learning-report 页面全链路（Node mock wx/Page + 双 canvas 桩）：
 *    - 免费用户（role=USER，7 天切片）：四宫格 / 锁卡弹窗 stats_report / PRO 区不渲染
 *    - PRO 用户（role=PREMIUM，365 天切片）：热力图 53 列 / 月标注 / 建议 / 趋势切换重绘
 *    - canvas 真机红线：显式算术 px 定寸 / scale(dpr) 先行 / 虚线网格 / 紫 #4f46e5
 *    - 换号（token 变化）→ isPremium 变化 → 自动重拉（365 天切片就位）
 */
const { execSync } = require('child_process');

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const navigations = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  navigateTo: (o) => navigations.push(o.url),
  navigateBack: () => navigations.push('__back__'),
  stopPullDownRefresh: () => { calls.stopPull = (calls.stopPull || 0) + 1; },
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light', windowWidth: 375, pixelRatio: 2 }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  request: (opts) => {
    calls.request.push(opts);
    if (requestHandler) requestHandler(opts);
  },
};

global.getApp = () => ({ globalData: { profileDirty: false } });

let pageConfig = null;
global.Page = (cfg) => { pageConfig = cfg; };

function respond(opts, statusCode, data) {
  opts.success({ statusCode, data, errMsg: 'request:ok' });
}

const flush = () => new Promise((r) => setImmediate(r));

async function settle(times) {
  for (let i = 0; i < (times || 8); i++) await flush();
}

/** canvas 节点 + 2d 上下文记录桩（strokeStyle/fillStyle 赋值可断言紫 #4f46e5） */
function mockCanvas() {
  const calls = {
    fillText: [], moveTo: [], scale: [], fill: 0, stroke: 0,
    bezier: 0, dash: [], clearRect: 0,
  };
  const ctx = {
    setTransform() {}, scale(...args) { calls.scale.push(args); }, clearRect() { calls.clearRect++; },
    measureText: (t) => ({ width: String(t).length * 6 }),
    beginPath() {}, moveTo(x, y) { calls.moveTo.push([x, y]); }, lineTo() {}, closePath() {},
    bezierCurveTo() { calls.bezier++; },
    setLineDash(d) { calls.dash.push(d); },
    fill() { calls.fill++; }, stroke() { calls.stroke++; },
    fillText: (t, x, y) => { calls.fillText.push(String(t)); },
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '',
  };
  const node = { width: 0, height: 0, getContext: () => ctx };
  return { node: node, calls: calls };
}

/** 构造页面实例（拷贝 data + setData 路径键 + 双 canvas 挂载模型：
 *  last7 非骨架即挂；trend 需 PRO 才挂——与 wxml 条件一一对应） */
function makePage() {
  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (patch) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') > 0) {
        const parts = k.split('.');
        let obj = this.data;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        obj[parts[parts.length - 1]] = patch[k];
      } else {
        this.data[k] = patch[k];
      }
    });
  };
  const last7 = mockCanvas();
  const trend = mockCanvas();
  page.__last7 = last7;
  page.__trend = trend;
  const mounted = function (id) {
    if (id === '#last7Chart') return !page.data.isLoading && !page.data.loadError;
    if (id === '#trendChart') return !page.data.isLoading && !page.data.loadError && page.data.isPremium;
    return false;
  };
  page.createSelectorQuery = () => ({
    select(id) {
      return {
        fields() {
          const node = id === '#trendChart' ? trend.node : last7.node;
          return { exec(cb) { cb([mounted(id) ? { node: node } : null]); } };
        },
      };
    },
  });
  return page;
}

/* ==================== 固定响应 ==================== */

/** 近 7 天样本（2026-09-24 周四起）：总 46 分钟、活跃 1 天、生词 0、streak 1 */
function freeDays() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(2026, 8, 24) + i * 86400000);
    days.push({
      date: dt.toISOString().slice(0, 10),
      minutes: i === 6 ? 46 : 0,
      wordsLearned: 0,
      isActive: i === 6,
    });
  }
  return days;
}

/** 365 天样本：末 7 天同上；年中埋峰值 60 分钟（热力 max=60）与生词 */
function proDays() {
  const days = [];
  for (let i = 0; i < 365; i++) {
    const dt = new Date(Date.UTC(2025, 9, 2) + i * 86400000); // 2025-10-02 起一年
    const minutes = i === 100 ? 60 : i % 30 === 0 ? 10 : 0;
    days.push({
      date: dt.toISOString().slice(0, 10),
      minutes: minutes,
      wordsLearned: i === 100 ? 3 : 0,
      isActive: i % 30 === 0,
    });
  }
  // 末 7 天对齐 freeDays（46 分钟 / 1 活跃）
  for (let i = 0; i < 7; i++) {
    days[358 + i].minutes = i === 6 ? 46 : 0;
    days[358 + i].isActive = i === 6;
  }
  return days;
}

function reportDto(days, streakDays) {
  return { days: days, streakDays: streakDays, dailyGoalMins: 20 };
}

let currentRole = 'USER';
let currentDays = null;

function serveReport(opts) {
  if (opts.url.indexOf('/api/user/subscription/status') >= 0) {
    return respond(opts, 200, { role: currentRole });
  }
  if (opts.url.indexOf('/api/user/stats/learning-report') >= 0) {
    return respond(opts, 200, reportDto(currentDays, 1));
  }
  respond(opts, 404, { error: 'not found' });
}

/* ==================== 断言工具 ==================== */

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label);
  }
}

/* ==================== 1. 纯函数（profile-core） ==================== */

async function testPureFunctions() {
  console.log('== 学习报表纯函数 ==');
  const core = require('../utils/profile-core');

  // reportBrief：46 分钟 → 0 小时 46 分；活跃 1 天；生词 0；日均 round(46/7)=7
  const brief = core.reportBrief(freeDays());
  ok(brief.hours === 0 && brief.minsPart === 46 && brief.totalMins === 46, 'reportBrief 时长拆分 0 小时 46 分');
  ok(brief.activeDays === 1 && brief.wordsLearned === 0, 'reportBrief 活跃天数 / 生词');
  ok(brief.avgMins === 7, 'reportBrief 日均 = round(46/7) = 7');

  // reportSuggestions：五规则顺序 + slice 3
  ok(
    core.reportSuggestions({ avgMins: 15, activeDays: 6, wordsLearned: 0 }, 4, 20)[0].indexOf('连续打卡 4 天') === 0,
    '建议规则 1：连续打卡 ≥3',
  );
  ok(
    core.reportSuggestions({ avgMins: 10, activeDays: 2, wordsLearned: 5 }, 0, 20).length === 2 &&
      core.reportSuggestions({ avgMins: 10, activeDays: 2, wordsLearned: 5 }, 0, 20)[0].indexOf('近 7 天日均 10 分钟') === 0,
    '建议规则 2：日均低于目标 + 规则 4：学习分散（互斥 else if）',
  );
  ok(
    core.reportSuggestions({ avgMins: 0, activeDays: 4, wordsLearned: 3 }, 0, 20).every((s) => s.indexOf('学习日还比较分散') < 0) &&
      core.reportSuggestions({ avgMins: 0, activeDays: 4, wordsLearned: 3 }, 0, 20)[0] === '继续保持，数据积累后这里会给出更具体的学习建议。',
    '建议规则 4：activeDays 3-4 不触发分散提示（回落 fallback）',
  );
  ok(
    core.reportSuggestions({ avgMins: 0, activeDays: 0, wordsLearned: 0 }, 0, 20)[0].indexOf('没有新收生词') >= 0,
    '建议规则 5：零生词',
  );
  ok(
    core.reportSuggestions({ avgMins: 30, activeDays: 3, wordsLearned: 9 }, 2, 20)[0] === '继续保持，数据积累后这里会给出更具体的学习建议。',
    '建议 fallback：全规则未命中',
  );
  ok(
    core.reportSuggestions({ avgMins: 5, activeDays: 6, wordsLearned: 0 }, 5, 20).length === 3,
    '建议命中多条时 slice 3',
  );

  // heatmapLevel：边界分档
  ok(
    core.heatmapLevel(0, 60) === 0 && core.heatmapLevel(15, 60) === 1 && core.heatmapLevel(30, 60) === 2 &&
      core.heatmapLevel(45, 60) === 3 && core.heatmapLevel(60, 60) === 4 && core.heatmapLevel(61, 60) === 4,
    'heatmapLevel 分档边界（0/.25/.5/.75/1）',
  );
  ok(core.heatmapLevel(5, 0) === 1, 'heatmapLevel max=0 时非零分钟归 1 档');

  // heatmapGrid：2026-09-24 周四起 7 天 → 首列前 3 空（周四 row=3）、53 列
  const g = core.heatmapGrid(proDays());
  ok(g.weeks.length === 53, 'heatmapGrid 全年 53 列');
  ok(g.weeks[0].slice(0, 3).every((c) => c === null) && g.weeks[0][3] !== null, 'heatmapGrid 周一对齐（2025-10-02 周四 → 首列前 3 空）');
  ok(g.max === 60, 'heatmapGrid max = 期内峰值 60');
  const labels = g.monthLabels.filter(Boolean);
  ok(labels[0] === '10月' && labels.length === 12, 'heatmapGrid 月标注（首列 10 月起共 12 个；10-01 在旧列内不触发，与 Web 同口径）');
  ok(core.heatmapGrid([]).weeks.length === 0, 'heatmapGrid 空序列防御');

  // xLabelStride：≤7 全显；否则约 6 个标签
  ok(
    core.xLabelStride(7) === 1 && core.xLabelStride(30) === 5 && core.xLabelStride(90) === 15 && core.xLabelStride(365) === 61,
    'xLabelStride 抽稀（7/30/90/365 → 1/5/15/61）',
  );

  // mapReport：字符串数字归一 / goal 兜底 20
  const mapped = core.mapReport({
    days: [{ date: '2026-09-30', minutes: '5', wordsLearned: '2', isActive: 1 }],
    streakDays: '3',
  });
  ok(
    mapped.days[0].minutes === 5 && mapped.days[0].wordsLearned === 2 && mapped.days[0].isActive === true &&
      mapped.streakDays === 3 && mapped.dailyGoalMins === 20,
    'mapReport 防御映射 + dailyGoalMins 兜底 20',
  );
}

/* ==================== 2. 页面全链路 ==================== */

async function testPage() {
  const authStore = require('../store/authStore');
  const membershipStore = require('../store/membershipStore');
  membershipStore.init(); // 等价 app.js onLaunch：建立 authStore → deriveLocal 联动（换号重校正链路依赖）
  require('../pages/profile/learning-report/index');
  ok(typeof pageConfig === 'object' && pageConfig !== null, 'Page() 捕获页面配置');

  /* ---------- 2a. 免费用户（USER，7 天切片） ---------- */
  console.log('== 免费用户（role=USER） ==');
  currentRole = 'USER';
  currentDays = freeDays();
  requestHandler = serveReport;
  authStore.setLoginData('tok-free', { userid: 'u1', nickname: '免费用户', role: 'USER' });
  await settle();

  let page = makePage();
  page.onLoad();
  page.onReady();
  ok(page.data.chartW === 303 && page.data.last7H === 176 && page.data.trendH === 224, 'onReady 算术定寸 303×176/224（禁百分比红线）');
  page.onShow();
  await settle();

  ok(page.data.isLoading === false && page.data.loadError === '', '首载完成');
  ok(page.data.isPremium === false, 'isPremium 权威校正为 false（USER）');
  ok(page.data.headerIcon === '/assets/icons/bar-chart-primary.svg', '页头浅色图标变体');

  const cards = page.data.statCards;
  ok(
    cards.length === 4 && cards[0].label === '近 7 天时长' && cards[0].value === '0' && cards[0].unit === '小时' &&
      cards[0].value2 === '46' && cards[0].unit2 === '分',
    '四宫格 1：0 小时 46 分（value/unit 两段式）',
  );
  ok(cards[1].label === '目标达成' && cards[1].value === '1' && cards[1].unit === '/ 7 天', '四宫格 2：1 / 7 天');
  ok(cards[2].label === '连续打卡' && cards[2].value === '1' && cards[2].unit === '天', '四宫格 3：连续打卡 1 天');
  ok(cards[3].label === '新收生词' && cards[3].value === '0' && cards[3].unit === '个', '四宫格 4：新收生词 0 个');
  ok(
    cards[0].icon === '/assets/icons/bar-chart-primary.svg' &&
      cards[1].icon === '/assets/icons/event-available-primary.svg' &&
      cards[2].icon === '/assets/icons/local-fire-department-primary.svg' &&
      cards[3].icon === '/assets/icons/bookmark-primary.svg',
    '四宫格图标统一 primary 绿',
  );

  // 近 7 天 canvas 真机红线：dpr 缩放 + 虚线网格 + 紫 #4f46e5 + X 轴 MM-DD
  const l7 = page.__last7;
  ok(page.__last7.node.width === 606 && page.__last7.node.height === 352, 'canvas 缓冲区 = W×dpr / H×dpr（303×2 / 176×2）');
  ok(l7.calls.scale.some((a) => a[0] === 2 && a[1] === 2), '绘制前应用 ctx.scale(dpr=2)（挤左上回归锁）');
  ok(l7.calls.dash.some((d) => d[0] === 3 && d[1] === 3), '虚线网格 setLineDash([3,3])（Web CartesianGrid）');
  const ctx7 = page.__last7.node.getContext('2d');
  ok(ctx7.strokeStyle === '#4f46e5', '折线紫 #4f46e5（Web 硬编码色）');
  ok(l7.calls.fillText.some((t) => /^09-/.test(t)), 'X 轴 MM-DD 日期标签');
  ok(l7.calls.fillText.some((t) => t === '0') && l7.calls.fillText.some((t) => t === '80'), 'Y 轴整数刻度（峰值 46 → chartYMax 阶梯 0/20/40/60/80）');

  // 免费锁定层：PRO 区不渲染（trend 未挂载）+ 弹窗开关
  ok(page.data.pmVisible === false, 'premium-modal 初始关闭');
  page.onUnlock();
  ok(page.data.pmVisible === true, '锁卡点击 → premium-modal stats_report 场景打开');
  page.onPmClose();
  ok(page.data.pmVisible === false, '弹窗关闭回落');
  ok(page.__trend.calls.clearRect === 0, '免费用户 trend canvas 不绘制（isPremium 门禁）');

  // 下拉刷新：静默重拉
  calls.request.length = 0;
  await page.onPullDownRefresh();
  ok(calls.request.some((o) => o.url.indexOf('learning-report') >= 0) && calls.stopPull === 1, '下拉刷新重拉 + stopPullDownRefresh');

  /* ---------- 2b. PRO 用户（换号 → isPremium 变化自动重拉，365 天切片） ---------- */
  console.log('== PRO 用户（换号 tok-pro，role=PREMIUM） ==');
  currentRole = 'PREMIUM';
  currentDays = proDays();
  authStore.setLoginData('tok-pro', { userid: 'u1', nickname: 'PRO 用户', role: 'USER' });
  await settle();

  calls.request.length = 0;
  page.onShow(); // 同一页面实例：_hasLoaded=true 但 isPremium 变化 → 强制重拉
  await settle();

  ok(page.data.isPremium === true, '换号后 isPremium 校正为 true（subscription/status 权威）');
  ok(calls.request.some((o) => o.url.indexOf('learning-report') >= 0), 'isPremium 变化 → 自动重拉（365 天切片就位）');

  const proDaysLen = page._report.days.length;
  ok(proDaysLen === 365, 'PRO 切片 365 天');
  ok(page.data.heatWeeks.length === 53 && page.data.heatMonthLabels.filter(Boolean).length === 12, '热力图视图模型 53 列 + 12 月标注');
  ok(page.data.suggestions.length >= 1 && page.data.suggestions.length <= 3, '智能建议 1-3 条');
  const firstCell = page.data.heatWeeks[0].find((c) => c.cls !== 'lvx');
  ok(firstCell && /^lv[0-4]$/.test(firstCell.cls), '热力格类名 lv0-lv4（前置空格 lvx）');

  // PRO：trend canvas 绘制（紫线 + 抽稀标签）
  const tr = page.__trend;
  ok(tr.calls.clearRect >= 1, 'PRO trend canvas 绘制（isPremium 解锁）');
  ok(tr.calls.scale.some((a) => a[0] === 2 && a[1] === 2), 'trend scale(dpr) 先行');
  const labelCount = tr.calls.fillText.filter((t) => /^(\d{2})-(\d{2})$/.test(t)).length;
  ok(labelCount <= 8, '趋势 X 标签抽稀（365 天 → 首尾+stride 共 ≤8 个）');

  // 趋势切换：range 90 → 30（token 递增触发重绘）
  const tokenBefore = page._trendToken;
  calls.request.length = 0;
  page.onChangeRange({ currentTarget: { dataset: { range: 30 } } });
  ok(page.data.range === 30 && page._trendToken > tokenBefore, '切月 → range=30 + trend 重绘');
  page.onChangeRange({ currentTarget: { dataset: { range: 30 } } });
  ok(page._trendToken === tokenBefore + 1, '同 range 重复点击无操作');
  ok(calls.request.length === 0, '趋势切换纯前端切片（不发请求）');

  /* ---------- 2c. 未登录守门 ---------- */
  console.log('== 未登录守门 ==');
  authStore.logout();
  await settle();
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  ok(page.data.isLoading === false && page.data.loadError.indexOf('登录') >= 0, '未登录 → 错误态提示登录');
}

/* ==================== 主流程 ==================== */

let core_ref = null;

(async function main() {
  await testPureFunctions();
  core_ref = require('../utils/profile-core');
  await testPage();
  console.log('');
  console.log('========== 学习报表测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
