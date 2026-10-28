/**
 * scripts/test-home-recommend.js — 主页「今日修行」数据管线单测
 * （Node 环境，mock wx + Page；原「为你推荐」难度口径已随整集列表退役，
 * RESHAPE-TASK T0.2/T3.1 前置拆除，本套件改守保留管线的正确性）
 *
 * 验证目标：
 *   A. 零整集链路：fetchHomeData 不发 /api/episode/list、/api/user/history、
 *      /api/episode/list-by-podcastid 任何请求（红线 1/2）
 *   B. 本周里程：weekNow/weekLast 分钟 → kmCurrent/kmGoal/weeklyProgress/
 *      remainingMins 换算正确
 *   C. 词汇路标：vocabulary.addedDate 本周（周一 00:00 起）计数
 *   D. 学习小径：weeklyActivity 7 天 → journeyDays（isToday 对位）
 *   E. 打卡文案：todayMinutes vs dailyStudyGoalMins
 *   F. 问候语与 bio 兜底/截断
 *
 * 运行：node scripts/test-home-recommend.js
 */

let profilePayload = {}; // 可变：/api/user/profile 载荷
let weekNowPayload = { weeklyActivity: [] };
let weekLastPayload = { weeklyActivity: [] };
let vocabPayload = [];   // 可变：/api/vocabulary/all

let episodeListCalls = 0;
let historyCalls = 0;
let enrichCalls = 0;

global.wx = {
  _storage: {},
  getStorageSync(k) {
    return this._storage[k] !== undefined ? this._storage[k] : '';
  },
  setStorageSync(k, v) {
    this._storage[k] = v;
  },
  removeStorageSync(k) {
    delete this._storage[k];
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } };
  },
  showToast() {},
  navigateTo() {},
  switchTab() {},
  request(opts) {
    const url = opts.url;
    let data = {};
    if (url.includes('/api/user/profile')) {
      data = profilePayload;
    } else if (url.includes('/api/episode/list-by-podcastid')) {
      enrichCalls++;
      data = { episodes: [] };
    } else if (url.includes('/api/episode/list')) {
      episodeListCalls++;
      data = [];
    } else if (url.includes('/api/user/history')) {
      historyCalls++;
      data = { data: { items: [] } };
    } else if (url.includes('/api/user/stats/weekly-activity')) {
      data = url.includes('weekOffset=1') ? weekLastPayload : weekNowPayload;
    } else if (url.includes('/api/vocabulary/all')) {
      data = vocabPayload;
    }
    opts.success({ statusCode: 200, data });
  },
};

// Page 构造器 mock：捕获配置并注入 setData
let page = null;
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  });
};

require('../pages/home/index');
const authStore = require('../store/authStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function mondayOfThisWeek() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

(async () => {
  // 登录进入内容态
  authStore.setLoginData('token-1', { userid: 'u1', role: 'USER' });
  page.onLoad();
  await settle();

  // —— A. 零整集链路 ——
  assert(episodeListCalls === 0 && historyCalls === 0 && enrichCalls === 0,
    'A fetchHomeData 零整集请求（episode/list、history、富化全退役）');
  assert(page.data.recommended === undefined && page.data.latestEpisodes === undefined,
    'A 推荐位数据不存在（结构即红线）');

  // —— B. 本周里程 ——
  // 今日 120 分钟、上周 100 分钟 → +20%；goal 2h → km 10；剩 0 分钟
  //（120 分钟动态放在今天下标，打卡断言不受真实星期影响）
  const todayIndex = (new Date().getDay() + 6) % 7;
  const nowArr = [0, 0, 0, 0, 0, 0, 0];
  nowArr[todayIndex] = 120;
  profilePayload = { weeklyListeningGoalHours: 2, dailyStudyGoalMins: 20, nickname: 'K', bio: '' };
  weekNowPayload = { weeklyActivity: nowArr.map((m, i) => ({ day: '周' + i, minutes: m })) };
  weekLastPayload = { weeklyActivity: [{ minutes: 100 }] };
  await page.fetchHomeData(true);
  await settle();
  const mil = page.data.mileage;
  assert(mil.weeklyProgress === 20, 'B 周环比 +20%（120 vs 100 分钟）');
  assert(Math.abs(mil.kmCurrent - 10) < 1e-9 && mil.kmGoal === 10,
    'B 120 分钟 × 5.0 = 10km / 目标 10km');
  assert(mil.remainingMins === 0, 'B 周目标已达成 remainingMins=0');
  assert(page.data.checkInStatus === '今日打卡完成', 'E 今日 120 分钟 ≥ 20 → 打卡完成');

  // —— C. 词汇路标：本周（周一 00:00 起）新增计数 ——
  const monday = mondayOfThisWeek();
  const inWeek = new Date(monday.getTime() + 3600 * 1000).toISOString();
  const lastWeek = new Date(monday.getTime() - 24 * 3600 * 1000).toISOString();
  vocabPayload = [
    { word: 'a', addedDate: inWeek },
    { word: 'b', addedDate: inWeek },
    { word: 'c', addedDate: lastWeek },
    { word: 'd' },
  ];
  profilePayload = { weeklyWordsGoal: 10, nickname: 'K' };
  await page.fetchHomeData(true);
  await settle();
  assert(page.data.mileage.wordsCurrent === 2, 'C 本周新增生词 = 2（上周/无日期不计）');

  // —— D. 学习小径 ——
  weekNowPayload = {
    weeklyActivity: [
      { day: '周一', minutes: 10 }, { day: '周二', minutes: 0 }, { day: '周三', minutes: 5 },
      { day: '周四', minutes: 0 }, { day: '周五', minutes: 0 }, { day: '周六', minutes: 0 },
      { day: '周日', minutes: 0 },
    ],
  };
  await page.fetchHomeData(true);
  await settle();
  const days = page.data.journeyDays;
  assert(days.length === 7 && days[0].minutes === 10 && days[2].minutes === 5,
    'D journeyDays 回填 7 天分钟数');
  const todayIdx = (new Date().getDay() + 6) % 7;
  assert(days[todayIdx].isToday === true && days.filter((d) => d.isToday).length === 1,
    'D isToday 唯一且对位今天');

  // —— F. 问候语与 bio ——
  profilePayload = { nickname: '远路人', bio: '一二三四五六七八九十一二三四五六' };
  await page.fetchHomeData(true);
  await settle();
  assert(page.data.greeting.includes('远路人'), 'F 问候语含昵称');
  assert(page.data.bio === '一二三四五六七八九十一二三四五...',
    'F bio 超 15 字截断（含省略号）');
  profilePayload = {};
  await page.fetchHomeData(true);
  await settle();
  assert(page.data.bio === '世界很长，慢慢走', 'F bio 兜底文案');

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL HOME DAILY-PRACTICE TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
