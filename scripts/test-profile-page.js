/**
 * scripts/test-profile-page.js — 「个人中心」主页（阶段 2-4）自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp），全链路驱动
 * pages/profile/index.js → utils/api/profile.js → utils/request.js → wx.request：
 * 覆盖登录闸、首载四源并行拉取与 DTO→视图模型映射（mapProfile 展平/404 兜底）、
 * 卡内错误态与重试、Tab 切换、下拉刷新、profileDirty 静默刷新、编辑页跳转、主题接入；
 * 阶段 3：统计三卡视图模型（值/单位/副文案/图标深浅变体/色调类）、canvas 算术定寸、
 * 本周/上周切换（URL 参数/数据替换/幂等）、深浅主题重建图标；
 * 阶段 4：里程碑路图绘制（虚线/实线裁剪/节点旗标/标签/脉冲 RAF 启停）与
 * 成就墙数据位（take(8)/解锁排前/计数/全部查看 toast）；
 * 阶段 5：账号与安全——绑定手机/邮箱弹层（scene:BIND 发码/倒计时/业务失败行内/
 * 强度三项/两密一致/校验链/乐观回写）与注销链路（DELETE→logout→1.2s navigateBack）。
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

/** 业务四源计数（剔除 onShow 的 membership ensureFresh 订阅校正请求） */
const bizCalls = () => calls.request.filter((o) => o.url.indexOf('subscription/status') < 0);

/** 按当前 handler 服务一轮四源请求后等全部微任务落定 */
async function settle(times) {
  for (let i = 0; i < (times || 6); i++) await flush();
}

/** canvas 节点 + 2d 上下文记录桩（fillText/arc 等调用可断言；
 *  scale/moveTo/fillText 坐标也记录——锁「dpr 缩放缺失→内容挤左上角」类回归；
 *  另记 setLineDash/quadraticCurveTo 与 RAF 启停——锁里程碑虚线/平滑路径/脉冲动画） */
function mockCanvas() {
  const calls = {
    fillText: [], fillTextXY: [], moveTo: [], scale: [], fill: 0, stroke: 0,
    bezier: 0, arc: 0, dash: [], quad: 0, raf: 0, cancelRaf: 0,
  };
  let rafCb = null;
  const ctx = {
    setTransform() {}, scale(...args) { calls.scale.push(args); }, clearRect() {},
    measureText: (t) => ({ width: String(t).length * 6 }),
    beginPath() {}, moveTo(x, y) { calls.moveTo.push([x, y]); }, lineTo() {}, closePath() {},
    quadraticCurveTo() { calls.quad++; },
    bezierCurveTo() { calls.bezier++; },
    setLineDash(d) { calls.dash.push(d); },
    createLinearGradient: () => ({ addColorStop() {} }),
    fill() { calls.fill++; }, stroke() { calls.stroke++; }, arc() { calls.arc++; },
    fillText: (t, x, y) => { calls.fillText.push(String(t)); calls.fillTextXY.push([x, y]); },
  };
  const node = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    requestAnimationFrame(cb) { calls.raf++; rafCb = cb; return calls.raf; },
    cancelAnimationFrame() { calls.cancelRaf++; rafCb = null; },
  };
  return {
    node: node,
    calls: calls,
    fireRaf() { if (rafCb) { const cb = rafCb; cb(); } },
  };
}

/** 构造页面实例（拷贝 data + 模拟 setData（支持 'a.b.c' 路径键，对齐真机语义）+ 双 canvas 挂载模型：
 *  主内容可见（非骨架/未登录）且对应 Tab 且非该源 loading 时，节点才在树上——
 *  与 wxml 的 wx:if/wx:else 挂载条件一一对应） */
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
  const chart = mockCanvas();
  const msChart = mockCanvas();
  page.__chart = chart;
  page.__ms = msChart;
  const mounted = function (id) {
    if (id === '#weeklyChart') {
      return !page.data.isLoading && !page.data.needLogin &&
        !page.data.activityLoading && page.data.activeTab === 'journey';
    }
    if (id === '#milestoneChart') {
      return !page.data.isLoading && !page.data.needLogin &&
        !page.data.statsLoading && page.data.activeTab === 'milestones';
    }
    return false;
  };
  page.createSelectorQuery = () => ({
    select(id) {
      return {
        fields() {
          // 真实 API 形状：res[0] = { node, width, height }
          const node = id === '#milestoneChart' ? msChart.node : chart.node;
          return { exec(cb) { cb([mounted(id) ? { node: node } : null]); } };
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
  if (opts.url.indexOf('/api/user/subscription/status') >= 0) return respond(opts, 200, { role: 'USER' });
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
  ok(bizCalls().length === 4, '四源各一发（profile/overview/weekly/achievements；subscription/status 校正另计）');
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

  // 学习报表入口卡（阶段 8）：普通用户（role=USER 校正后）副标题走解锁文案 + 浅色图标
  ok(page.data.isPremium === false, 'isPremium 订阅校正为 false（USER）');
  ok(page.data.reportEntryIcon === '/assets/icons/bar-chart-primary.svg' &&
     page.data.reportArrowIcon === '/assets/icons/keyboard-arrow-right-primary.svg', '入口卡浅色图标变体');
  page.onOpenLearningReport();
  ok(navigations.indexOf('/pages/profile/learning-report/index') >= 0, '入口卡跳转学习报表页');

  // onReady：canvas 显式算术 px 定寸（375 屏宽 → 内缩 144rpx → 303px；440rpx → 220px；256rpx → 128px）
  page.onReady();
  ok(page.data.chartW === 303 && page.data.chartH === 220, 'onReady 算术定寸 303×220（禁百分比红线）');
  ok(page.data.msH === 128, '里程碑 canvas 高 256rpx→128px');
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
  ok(bizCalls().length === 0, '已加载且无脏标记 → onShow 不重拉四源（订阅校正除外）');

  global.getApp = () => ({ globalData: { profileDirty: true } });
  calls.request.length = 0;
  page.onShow();
  await settle();
  ok(bizCalls().length === 4, 'profileDirty → 静默四源重拉');
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

  /* ---------- 4b. 里程碑 Tab（阶段 4） ---------- */
  console.log('== 里程碑 Tab ==');
  await new Promise((r) => setTimeout(r, 300)); // 挂载即时（同步桩）+ 保险帧 120ms
  const ms = page.__ms.calls;
  ok(ms.fillText.some((t) => t === '起步') && ms.fillText.some((t) => t === '远路'), '节点名称标签（起步…远路）');
  ok(ms.fillText.some((t) => t === '1.0km') && ms.fillText.some((t) => t === '100.0km'), 'km 档位标签（1.0km…100.0km）');
  ok(ms.arc >= 5, '五个节点圆绘制');
  ok(ms.dash.some((d) => Array.isArray(d) && d.length === 2 && d[0] === 0.1 && d[1] === 9),
    '全程圆点虚线 setLineDash([0.1, 9dp])（dpScale=1）');
  ok(ms.quad >= 4, '中点法 quadraticCurveTo 平滑路径（4 段）');
  ok(ms.stroke >= 2, '虚线全程 + 已完成段实线两笔');
  ok(ms.scale.some((a) => a[0] === 2 && a[1] === 2), '里程碑 canvas 应用 ctx.scale(dpr)（挤左上回归锁）');
  ok(ms.raf === 0, '满程 km=109 ≥ 100：脉冲不启动（静态一帧）');
  ok(page.data.msKmText === '109.0', '卡头胶囊 msKmText=109.0');
  ok(page.data.achievementsLoading === false, '成就源 loading 落定');
  ok(page.data.achTiles.length === 2 && page.data.achTiles[0].key === 'STREAK_3' &&
     page.data.achTiles[0].unlocked === true, 'achTiles=排序后前 8（解锁排前）');
  page.onAllAchievements();
  ok(toasts[toasts.length - 1] === '完整成就墙 即将上线', '全部查看 → snackbar 同文案 toast');

  // 成就墙 take(8)：10 项（i%3===0 共 4 解锁散布）→ 仅前 8、解锁稳定排前
  const ACH10 = [];
  for (let i = 0; i < 10; i++) {
    ACH10.push({ key: 'K' + i, name: 'n' + i, description: 'd', icon: 'x', unlocked: i % 3 === 0, unlockedAt: null });
  }
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/achievements') >= 0) return respond(opts, 200, ACH10);
    serveAll(opts);
  };
  page.onPullDownRefresh();
  await settle();
  ok(page.data.achTiles.length === 8, '成就墙仅取前 8（Android take(8)）');
  ok(page.data.achievements.unlockedCount === 4, '解锁计数全量（4/10）');
  ok(page.data.achTiles.slice(0, 4).every((t) => t.unlocked === true) &&
     page.data.achTiles[4].unlocked === false, '解锁稳定排前、锁定补位');

  // 脉冲点：低里程（5h→25km ∈ (0,100)）→ RAF 启动；onHide/切走 Tab 必须取消
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/stats/overview') >= 0) {
      return respond(opts, 200, { totalHours: 5, streakDays: 1, wordsLearned: 10 });
    }
    serveAll(opts);
  };
  page.onPullDownRefresh();
  await settle();
  await new Promise((r) => setTimeout(r, 60));
  ok(page.data.stats.totalKm === 25 && page.data.msKmText === '25.0', '低里程 stats 落定（25km）');
  ok(page.__ms.calls.raf > 0, '0<km<100 启动脉冲 RAF');
  const arcBeforePulse = page.__ms.calls.arc;
  page.__ms.fireRaf();
  ok(page.__ms.calls.arc >= arcBeforePulse + 2, 'RAF 帧重绘脉冲（呼吸圈+实心点）');
  const cancelBeforeHide = page.__ms.calls.cancelRaf;
  page.onHide();
  ok(page.__ms.calls.cancelRaf > cancelBeforeHide, 'onHide 取消脉冲 RAF（后台耗电红线）');
  const arcAfterHide = page.__ms.calls.arc;
  page.__ms.fireRaf(); // 旧帧回调（token 已作废）不应再绘制
  ok(page.__ms.calls.arc === arcAfterHide, '作废 token 后旧帧不再绘制');
  // 回前台：profileDirty 静默刷新链路重挂路图 → RAF 续跑
  const rafBeforeShow = page.__ms.calls.raf;
  page.onShow();
  await settle();
  ok(page.__ms.calls.raf > rafBeforeShow, 'onShow 后脉冲动画续跑');
  const cancelBeforeLeave = page.__ms.calls.cancelRaf;
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });
  ok(page.data.activeTab === 'security' && page.__ms.calls.cancelRaf > cancelBeforeLeave,
    '切走里程碑 Tab 取消脉冲 RAF');
  requestHandler = serveAll; // 覆盖 handler 仅限本段，防泄漏到后续断言

  /* ---------- 4c. 账号与安全：绑定手机/邮箱弹层（阶段 5） ---------- */
  console.log('== 账号与安全 · 绑定弹层 ==');
  ok(page.data.activeTab === 'security', '已在账号与安全 Tab（4b 切走脉冲时落此）');
  ok(page.data.profile.hasPhone === true && page.data.profile.hasRealEmail === true &&
     page.data.profile.passwordSet === true, '四卡派生就绪（本账号全绑定态）');

  // 手机弹层：表单重置 + 输入过滤（非数字剔除、限 11 位）
  page.onOpenBindPhone();
  ok(page.data.securitySheet === 'phone' && page.data.bindForm.phone === '', '打开手机弹层 + 表单重置');
  page.onPhoneInput({ detail: { value: '138abc12345678' } });
  ok(page.data.bindForm.phone === '13812345678', '手机号输入过滤非数字并截 11 位');
  page.onPhoneInput({ detail: { value: '138' } });
  ok(page.data.bindUi.canSendCode === false, '手机号无效 → 发码不可用');
  await page.onSendCode();
  ok(page.data.bindForm.error === '请输入有效的11位手机号码', '无效手机号发码 → 行内校验文案');

  // 发码成功：请求体 {phone, scene:'BIND'} → notice + 倒计时 60
  page.onPhoneInput({ detail: { value: '13812348000' } });
  ok(page.data.bindUi.canSendCode === true, '有效手机号 → 发码可用');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/send') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSendCode();
  await settle();
  const sendReq = calls.request.find((o) => o.url.indexOf('/api/auth/sms/send') >= 0);
  ok(!!sendReq && sendReq.data.phone === '13812348000' && sendReq.data.scene === 'BIND',
    '发码请求 {phone, scene:BIND}（勿复用写死 LOGIN 的发码）');
  ok(page.data.bindForm.notice === '验证码发送成功', '发码成功 notice 文案');
  ok(page.data.bindForm.countdownSeconds === 60, '倒计时启动 60s');
  await new Promise((r) => setTimeout(r, 1050));
  ok(page.data.bindForm.countdownSeconds === 59, '倒计时 1s 递减');
  page.onCloseSheet();
  ok(page.data.securitySheet === '' && page.data.bindForm.countdownSeconds === 0, '关弹层清倒计时');

  // 业务失败（HTTP 200 + success:false）→ 行内 error，不弹全局 toast
  page.onOpenBindPhone();
  page.onPhoneInput({ detail: { value: '13800000000' } });
  const toastCountBefore = toasts.length;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/send') >= 0) {
      return respond(opts, 200, { success: false, message: '发送太频繁' });
    }
    serveAll(opts);
  };
  await page.onSendCode();
  await settle();
  ok(page.data.bindForm.error === '发送太频繁' && page.data.bindForm.countdownSeconds === 0,
    '发码业务失败 → 行内 error（assertAction 口径）');
  ok(toasts.length === toastCountBefore, '业务失败不弹全局 toast（showError:false）');

  // 提交绑定手机：校验链 → 成功乐观回写 + 关弹层 + toast
  page.onCodeInput({ detail: { value: '12' } });
  ok(page.data.bindUi.submitEnabled === false, 'code<6 提交不可用');
  await page.onSubmitBind();
  ok(page.data.bindForm.error === '请输入6位验证码', 'code 不足 → 行内文案');
  page.onCodeInput({ detail: { value: '123456' } });
  ok(page.data.bindUi.submitEnabled === true, '表单齐备 → 提交可用');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/bind') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSubmitBind();
  await settle();
  const bindReq = calls.request.find((o) => o.url.indexOf('/api/auth/sms/bind') >= 0);
  ok(!!bindReq && bindReq.data.phone === '13800000000' && bindReq.data.code === '123456', 'sms/bind 请求体');
  ok(page.data.securitySheet === '' && page.data.bindForm.phone === '', '成功关弹层 + 表单重置');
  ok(page.data.profile.phone === '13800000000' && page.data.profile.phoneMasked === '138****0000' &&
     page.data.profile.hasPhone === true, '乐观回写 phone/脱敏/hasPhone（不整页重拉）');
  ok(toasts[toasts.length - 1] === '绑定成功', 'toast 绑定成功');

  // 邮箱弹层：trim / 强度三项实时 / 两密一致 / 校验链 / 回写 passwordSet
  console.log('== 账号与安全 · 绑定邮箱 ==');
  page.onOpenBindEmail();
  ok(page.data.securitySheet === 'email', '打开邮箱弹层');
  page.onEmailInput({ detail: { value: ' wxk@example.com ' } });
  ok(page.data.bindForm.email === 'wxk@example.com', '邮箱输入 trim');
  ok(page.data.bindUi.canSendCode === true, '合法邮箱 → 发码可用');
  page.onPasswordInput({ detail: { value: 'abc' } });
  ok(page.data.bindUi.criteria.length === false && page.data.bindUi.criteria.hasLetter === true &&
     page.data.bindUi.criteria.hasNumber === false && page.data.bindUi.criteria.allMet === false,
    '强度三项实时（abc：仅字母）');
  page.onPasswordInput({ detail: { value: 'abcd1234' } });
  ok(page.data.bindUi.criteria.allMet === true, 'abcd1234 三项全满足');
  page.onConfirmPasswordInput({ detail: { value: 'abcd123' } });
  ok(page.data.bindUi.confirmMatch === false && page.data.bindUi.submitEnabled === false, '两密不一致 → 不可提交');
  await page.onSubmitBind();
  ok(page.data.bindForm.error === '请输入6位邮箱验证码', '校验链：code 空先行文案');
  page.onCodeInput({ detail: { value: '654321' } });
  ok(page.data.bindUi.submitEnabled === false, '两密不一致仍不可提交');
  page.onConfirmPasswordInput({ detail: { value: 'abcd1234' } });
  ok(page.data.bindUi.confirmMatch === true && page.data.bindUi.submitEnabled === true, '两密一致 → 可提交');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/bind-email/confirm') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSubmitBind();
  await settle();
  const emReq = calls.request.find((o) => o.url.indexOf('bind-email/confirm') >= 0);
  ok(!!emReq && emReq.data.email === 'wxk@example.com' && emReq.data.code === '654321' &&
     emReq.data.password === 'abcd1234', 'bind-email/confirm 请求体（email+code+password）');
  ok(page.data.profile.email === 'wxk@example.com' && page.data.profile.emailMasked === 'w**@example.com' &&
     page.data.profile.hasRealEmail === true && page.data.profile.passwordSet === true,
    '乐观回写 email/脱敏/hasRealEmail/passwordSet（绑定即设密码）');
  ok(toasts[toasts.length - 1] === '邮箱绑定成功', 'toast 邮箱绑定成功');
  requestHandler = serveAll;

  /* ---------- 5. 编辑资料跳转 ---------- */
  page.onOpenEdit();
  ok(navigations[navigations.length - 1] === '/pages/profile/edit', '编辑资料 → /pages/profile/edit');

  /* ---------- 6. 下拉刷新 ---------- */
  console.log('== 下拉刷新 ==');
  calls.request.length = 0;
  calls.stopPull = 0;
  page.onPullDownRefresh();
  await settle();
  ok(bizCalls().length === 4 && calls.stopPull === 1, '下拉刷新四源重拉 + stopPullDownRefresh');

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

  /* ---------- 9. 注销账号（阶段 5：二次确认 → DELETE → logout → 1.2s navigateBack） ---------- */
  console.log('== 注销账号 ==');
  // 失败分支：业务失败 → toast 后端文案 + 弹窗复位
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/self-delete') >= 0) {
      return respond(opts, 200, { success: false, message: '服务繁忙' });
    }
    serveAll(opts);
  };
  page.onOpenDeleteConfirm();
  ok(page.data.deleteConfirmOpen === true, '打开注销二次确认弹窗');
  await page.onConfirmDelete();
  await settle();
  ok(page.data.deletingAccount === false && page.data.deleteConfirmOpen === false, '注销失败复位弹窗与旗标');
  ok(toasts[toasts.length - 1] === '服务繁忙', '失败 toast 后端文案（自管，非全局）');

  // 成功分支：DELETE → authStore.logout + accountDeleted + toast + 1.2s 后 navigateBack
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/self-delete') >= 0) {
      return respond(opts, 200, { success: true, message: 'ok' });
    }
    serveAll(opts);
  };
  page.onOpenDeleteConfirm();
  await page.onConfirmDelete();
  await settle();
  const delReq = calls.request.find((o) => o.url.indexOf('/api/user/self-delete') >= 0);
  ok(!!delReq && delReq.method === 'DELETE', 'DELETE /api/user/self-delete 发出');
  ok(page.data.accountDeleted === true && page.data.deleteConfirmOpen === false, '注销成功态（弹窗已关）');
  ok(authStore.getState().isLoggedIn === false, 'authStore.logout 清会话（回 mine 游客态）');
  ok(toasts[toasts.length - 1] === '账号已成功注销', 'toast 账号已成功注销');
  await new Promise((r) => setTimeout(r, 1300));
  ok(navigations[navigations.length - 1] === '__back__', '约 1.2s 后 navigateBack（对齐 Android delay(1200)+onBack）');
  requestHandler = serveAll;

  /* ---------- 收尾 ---------- */
  console.log('\n========== 个人中心主页测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
