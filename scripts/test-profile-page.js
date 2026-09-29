/**
 * scripts/test-profile-page.js — 「个人中心」主页（阶段 2）自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp），全链路驱动
 * pages/profile/index.js → utils/api/profile.js → utils/request.js → wx.request：
 * 覆盖登录闸、首载四源并行拉取与 DTO→视图模型映射（mapProfile 展平/404 兜底）、
 * 卡内错误态与重试、Tab 切换、下拉刷新、profileDirty 静默刷新、编辑页跳转、主题接入；
 * 阶段 3：统计三卡视图模型（值/单位/副文案/图标深浅变体/色调类）、canvas 算术定寸、
 * 本周/上周切换（URL 参数/数据替换/幂等）、深浅主题重建图标。
 *
 * 运行：node scripts/test-profile-page.js
 */

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

/** 按当前 handler 服务一轮四源请求后等全部微任务落定 */
async function settle(times) {
  for (let i = 0; i < (times || 6); i++) await flush();
}

/** canvas 节点 + 2d 上下文记录桩（fillText/arc 等调用可断言；
 *  scale/moveTo/fillText 坐标也记录——锁「dpr 缩放缺失→内容挤左上角」类回归） */
function mockCanvas() {
  const calls = { fillText: [], fillTextXY: [], moveTo: [], scale: [], fill: 0, stroke: 0, bezier: 0, arc: 0 };
  const ctx = {
    setTransform() {}, scale(...args) { calls.scale.push(args); }, clearRect() {},
    measureText: (t) => ({ width: String(t).length * 6 }),
    beginPath() {}, moveTo(x, y) { calls.moveTo.push([x, y]); }, lineTo() {}, closePath() {},
    bezierCurveTo() { calls.bezier++; },
    createLinearGradient: () => ({ addColorStop() {} }),
    fill() { calls.fill++; }, stroke() { calls.stroke++; }, arc() { calls.arc++; },
    fillText: (t, x, y) => { calls.fillText.push(String(t)); calls.fillTextXY.push([x, y]); },
  };
  return { node: { width: 0, height: 0, getContext: () => ctx }, calls };
}

/** 构造页面实例（拷贝 data + 模拟 setData + canvas 挂载模型：
 *  主内容可见（非骨架/未登录）且旅程 Tab 且非 loading 时，节点才在树上——
 *  与 wxml 的 wx:if/wx:else 挂载条件一一对应） */
function makePage() {
  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (patch) { Object.assign(this.data, patch); };
  const chart = mockCanvas();
  page.__chart = chart;
  page.__chartMounted = function () {
    return !this.data.isLoading && !this.data.needLogin &&
      !this.data.activityLoading && this.data.activeTab === 'journey';
  };
  page.createSelectorQuery = () => ({
    select() {
      return {
        fields() {
          // 真实 API 形状：res[0] = { node, width, height }
          return { exec(cb) { cb([page.__chartMounted() ? { node: chart.node } : null]); } };
        },
      };
    },
  });
  return page;
}

/* ==================== 固定响应 ==================== */

const PROFILE_DTO = {
  userid: 'u1',
  nickname: '远路漫漫',
  bio: '',
  learnLevel: 'Beginner',
  avatarUrl: 'https://oss-signed.example.com/avatar.jpg?a=1',
  avatarFileName: 'yuanlu/avatar/1.jpg',
  dailyStudyGoalMins: 30,
  weeklyListeningGoalHours: 5,
  weeklyWordsGoal: 50,
  User: {
    userid: 'u1',
    email: 'ab@ex.com',
    phone: '13812348000',
    role: 'USER',
    createAt: '2026-01-02T18:30:00.000Z',
  },
};

const STATS_DTO = { totalHours: 21.8, streakDays: 4, wordsLearned: 120, speechEvalCount: 9, speechHighScoreCount: 3 };
const WEEKLY_DTO = { weeklyActivity: [{ day: '周一', minutes: 30 }, { day: '周二', minutes: 0 }] };
const ACH_DTO = [
  { key: 'STREAK_3', name: '三连胜', description: 'd', icon: '🔥', unlocked: true, unlockedAt: '2026-09-01T00:00:00.000Z' },
  { key: 'VOCAB_50', name: '五十词', description: 'd', icon: '📚', unlocked: false, unlockedAt: null },
];

function serveAll(opts) {
  if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 200, PROFILE_DTO);
  if (opts.url.indexOf('/api/user/stats/overview') >= 0) return respond(opts, 200, STATS_DTO);
  if (opts.url.indexOf('/api/user/stats/weekly-activity') >= 0) return respond(opts, 200, WEEKLY_DTO);
  if (opts.url.indexOf('/api/user/achievements') >= 0) return respond(opts, 200, ACH_DTO);
  respond(opts, 404, { error: 'not found' });
}

/* ==================== 加载被测模块（mock 就绪后） ==================== */

const theme = require('../utils/theme');
const authStore = require('../store/authStore');
require('../pages/profile/index');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

(async function main() {
  /* ---------- 1. 未登录守门 ---------- */
  console.log('== 未登录守门 ==');
  storage.delete('token');
  let page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  ok(page.data.isLoading === false && page.data.needLogin === true, '未登录 onShow → needLogin 且不拉取');
  ok(calls.request.length === 0, '未登录零请求');
  page.onLogin();
  ok(navigations[navigations.length - 1] === '/pages/auth/index', '去登录跳转 auth 页');

  /* ---------- 2. 首载四源并行 ---------- */
  console.log('== 首载四源并行 ==');
  authStore.setLoginData('tok-1', { userid: 'u1', nickname: '兜底昵称', email: 'ab@ex.com' });
  await settle(); // setLoginData 触发的 fetchProfile 也走 serveAll
  calls.request.length = 0;

  requestHandler = serveAll;
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();

  ok(page.data.isLoading === false && page.data.needLogin === false, '首载完成退出骨架态');
  ok(calls.request.length === 4, '四源各一发（profile/overview/weekly/achievements）');
  const vm = page.data.profile;
  ok(vm && vm.displayName === '远路漫漫' && vm.levelLabel === '初级', 'mapProfile 展平：昵称/等级');
  ok(vm.bioText === '路虽远行则将至，事虽难做则成。', '空签名回退默认座右铭');
  ok(vm.phoneMasked === '138****8000' && vm.hasPhone === true, '安全派生随卡就绪');
  ok(vm.joinDateText.length === 10 && /^\d{4}\/\d{2}\/\d{2}$/.test(vm.joinDateText), '加入日期 yyyy/MM/dd');
  ok(page.data.stats && page.data.stats.kmText === '109.0', 'stats 映射（21.8h→109.0km）');
  ok(page.data.weekly.length === 2 && page.data.weekly[1].minutes === 0, 'weekly 解包归零');
  ok(page.data.achievements && page.data.achievements.unlockedCount === 1, 'achievements 计数');
  ok(page.data.tabs.length === 3 && page.data.tabs[1].label === '里程碑', '三 Tab 定义');
  ok(page.data.activeTab === 'journey', '默认 Tab=旅程数据');
  ok(page.data.themeClass === '' && page.data.dark === false, '主题跟随系统（空根类）');

  /* ---------- 2b. 旅程数据 Tab（阶段 3） ---------- */
  console.log('== 旅程数据 Tab ==');
  ok(page.data.statsLoading === false && page.data.activityLoading === false, '副源 loading 旗标落定');
  const cards = page.data.statCards;
  ok(cards.length === 3 && cards[0].label === '累计里程' && cards[0].value === '109.0' &&
     cards[0].unit === 'km' && cards[0].subtext === '21.8h 精听', '累计里程卡（109.0km + 21.8h 精听）');
  ok(cards[1].label === '连续天数' && cards[1].value === '4' && cards[1].unit === '天' &&
     cards[1].subtext === '', '连续天数卡（无副文案）');
  ok(cards[2].label === '词汇路标' && cards[2].value === '120' && cards[2].unit === '词', '词汇路标卡');
  ok(cards[0].tintClass === 'tint-primary' && cards[1].tintClass === 'tint-secondary' &&
     cards[2].tintClass === 'tint-tertiary', '三卡色调类');
  ok(cards[0].icon === '/assets/icons/hiking-primary.svg' &&
     cards[1].icon === '/assets/icons/local-fire-department-accent.svg' &&
     cards[2].icon === '/assets/icons/bookmark-tertiary.svg', '浅色图标变体');

  // onReady：canvas 显式算术 px 定寸（375 屏宽 → 内缩 144rpx → 303px；440rpx → 220px）
  page.onReady();
  ok(page.data.chartW === 303 && page.data.chartH === 220, 'onReady 算术定寸 303×220（禁百分比红线）');
  ok(page._dpScale === 1, 'dpScale=屏宽/375');

  // 周切换：URL 带 weekOffset=1、数据替换、重复点击无操作
  const WEEKLY_DTO2 = { weeklyActivity: [{ day: '周一', minutes: 11 }, { day: '周二', minutes: 22 }] };
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/stats/weekly-activity') >= 0) {
      return respond(opts, 200, opts.url.indexOf('weekOffset=1') >= 0 ? WEEKLY_DTO2 : WEEKLY_DTO);
    }
    serveAll(opts);
  };
  calls.request.length = 0;
  page.onChangeWeek({ currentTarget: { dataset: { offset: 1 } } });
  ok(page.data.weekOffset === 1 && page.data.activityLoading === true, '切上周 → loading 立起');
  await settle();
  ok(page.data.activityLoading === false, '周数据落定 loading 落下');
  const weekReq = calls.request.find((o) => o.url.indexOf('weekly-activity') >= 0);
  ok(!!weekReq && weekReq.url.indexOf('weekOffset=1') >= 0, '请求带 weekOffset=1');
  ok(page.data.weekly.length === 2 && page.data.weekly[1].minutes === 22, '上周数据替换');
  calls.request.length = 0;
  page.onChangeWeek({ currentTarget: { dataset: { offset: 1 } } });
  await settle();
  ok(calls.request.length === 0, '同周再点无操作');

  // 深色主题：统计卡图标换深变体（onShow 检测生效主题变化重建）
  theme.setMode('dark');
  page.onShow();
  await settle();
  ok(page.data.dark === true && page.data.statCards[0].icon === '/assets/icons/hiking-primary-dark.svg' &&
     page.data.statCards[2].icon === '/assets/icons/bookmark-tertiary-dark.svg', '深色下统计卡图标换 -dark 变体');
  theme.setMode('system');
  page.onShow();
  await settle();
  ok(page.data.dark === false && page.data.statCards[0].icon === '/assets/icons/hiking-primary.svg', '回浅色图标还原');

  // 回本周（供后续场景）
  page.onChangeWeek({ currentTarget: { dataset: { offset: 0 } } });
  await settle();
  ok(page.data.weekOffset === 0 && page.data.weekly[1].minutes === 0, '切回本周');
  // 周切换后图表确实重绘（canvas 已挂载路径）
  await new Promise((r) => setTimeout(r, 260)); // 等保险帧
  ok(page.__chart.calls.fillText.some((t) => t === '周一') &&
     page.__chart.calls.fillText.some((t) => t.indexOf('m') > 0), 'canvas 绘制含星期标签与 Y 刻度');
  ok(page.__chart.calls.arc >= 2 && page.__chart.calls.stroke >= 1, 'canvas 绘制数据点与曲线');
  // dpr 缩放回归锁：缓冲 = W*dpr 设备像素，缺 ctx.scale(dpr) 时内容挤左上 1/dpr 角（真机 dpr=3）
  ok(page.__chart.calls.scale.some((a) => a[0] === 2 && a[1] === 2), '绘制前应用 ctx.scale(dpr=2)（mock pixelRatio=2）');
  (function () {
    const W = page.data.chartW; // 375 窗口 → 303
    const H = page.data.chartH; // → 220
    const xs = page.__chart.calls.fillTextXY.map((p) => p[0]).concat(page.__chart.calls.moveTo.map((p) => p[0]));
    const ys = page.__chart.calls.fillTextXY.map((p) => p[1]).concat(page.__chart.calls.moveTo.map((p) => p[1]));
    ok(Math.max.apply(null, xs) > W * 0.8 && Math.max.apply(null, ys) > H * 0.6,
      '绘制坐标铺满逻辑画布（末点 x>0.8W、X 轴标签 y>0.6H，非挤左上角）');
  })();

  /* ---------- 2c. 首载空白画布 BUG（周数据先落定 + 骨架态未挂载） ---------- */
  console.log('== 首载空白画布 BUG 回归 ==');
  // profile 延迟 40ms、周数据即时：复现 requestChartDraw 在 isLoading 翻转前被触发
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/profile') >= 0 && opts.url.indexOf('/stats') < 0) {
      setTimeout(() => respond(opts, 200, PROFILE_DTO), 40);
      return;
    }
    serveAll(opts);
  };
  const racePage = makePage();
  racePage.onLoad();
  racePage.onReady();
  racePage.onShow();
  await new Promise((r) => setTimeout(r, 90)); // profile 延迟落定 + Promise.all 收口
  ok(racePage.data.isLoading === false, '延迟 profile 落定后退出骨架态');
  await new Promise((r) => setTimeout(r, 400)); // 挂载重试循环（120ms 步进）+ 保险帧
  ok(racePage.__chart.calls.fillText.some((t) => t === '周一') &&
     racePage.__chart.calls.fillText.some((t) => t.indexOf('m') > 0),
     '修复生效：骨架态查空后经重试循环最终完成绘制');
  ok(racePage.__chart.calls.arc >= 2, '修复生效：数据点已绘制');
  requestHandler = serveAll; // 延迟 handler 仅限本场景，防泄漏到后续断言

  /* ---------- 3. onShow 幂等与脏标记 ---------- */
  console.log('== onShow 幂等与脏标记 ==');
  calls.request.length = 0;
  page.onShow();
  await settle();
  ok(calls.request.length === 0, '已加载且无脏标记 → onShow 不重拉');

  global.getApp = () => ({ globalData: { profileDirty: true } });
  calls.request.length = 0;
  page.onShow();
  await settle();
  ok(calls.request.length === 4, 'profileDirty → 静默四源重拉');
  ok(page.data.isLoading !== true, '静默刷新不回骨架态');

  /* ---------- 4. Tab 切换 ---------- */
  console.log('== Tab 切换 ==');
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });
  ok(page.data.activeTab === 'security', '切到账号与安全');
  const before = page.data.activeTab;
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });
  ok(page.data.activeTab === before, '同 Tab 点击无操作');
  page.onTab({ currentTarget: { dataset: { key: 'milestones' } } });
  ok(page.data.activeTab === 'milestones', '切到里程碑');

  /* ---------- 5. 编辑资料跳转 ---------- */
  page.onOpenEdit();
  ok(navigations[navigations.length - 1] === '/pages/profile/edit', '编辑资料 → /pages/profile/edit');

  /* ---------- 6. 下拉刷新 ---------- */
  console.log('== 下拉刷新 ==');
  calls.request.length = 0;
  calls.stopPull = 0;
  page.onPullDownRefresh();
  await settle();
  ok(calls.request.length === 4 && calls.stopPull === 1, '下拉刷新四源重拉 + stopPullDownRefresh');

  /* ---------- 7. profile 404 → 兜底合成 ---------- */
  console.log('== profile 404 兜底 ==');
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 404, { error: 'Profile not found' });
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  const vm404 = page.data.profile;
  ok(vm404 && vm404.displayName === '兜底昵称' && vm404.avatarUrl === null, '404 → userInfo 合成最小资料');
  ok(page.data.loadError === '', '404 兜底不算错误态');

  /* ---------- 8. profile 500 → 卡内错误 + 重试 ---------- */
  console.log('== 卡内错误与重试 ==');
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 500, { error: 'Internal Server Error' });
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  ok(page.data.profile === null && page.data.loadError === '资料加载失败', '500 → profile 空 + 卡内错误文案');
  ok(page.data.isLoading === false, '错误不回页级骨架（卡内态）');

  requestHandler = serveAll;
  page.onRetry();
  await settle();
  ok(page.data.profile && page.data.profile.displayName === '远路漫漫', '点击重试恢复资料');

  /* ---------- 收尾 ---------- */
  console.log('\n========== 个人中心主页测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
