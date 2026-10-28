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
let prescriptionPayload = { success: true, data: { cards: [] } };
const navigations = [];
const toasts = [];

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
  showToast: (o) => toasts.push(o.title || ''),
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => navigations.push(o.url),
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
    } else if (url.includes('/api/studio/daily-prescription')) {
      data = prescriptionPayload;
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

  // —— G. 今日五分钟处方（T3.1：/api/studio/daily-prescription 映射与驱动） ——
  prescriptionPayload = {
    success: true,
    data: {
      cards: [
        {
          type: 'vocab_revival',
          focus: 'resilient',
          clipid: 'cA',
          episodeid: 'epA',
          enText: 'The resilient team pushed back the timeline',
          zhText: '坚韧的团队把时间线往后推了',
          startTime: 10, endTime: 18, duration: 8.4, wpm: 120,
          cefrLevel: 'B2', coverUrl: 'https://oss/cvA.jpg', sourceLabel: '访谈',
        },
        {
          type: 'weak_phoneme',
          focus: 'θ',
          clipid: 'cB',
          episodeid: 'epB',
          enText: 'I think this is the right thing',
          zhText: null,
          startTime: 30, endTime: 38, duration: 8.2, wpm: 130,
          cefrLevel: null, coverUrl: null, sourceLabel: null,
        },
        {
          type: 'micro_scene',
          sceneid: 's9',
          title: '职场沟通 · 例会上的延期',
          summaryZh: '一组关于推进与退让的表达',
          situationTag: '职场',
          cefrLevel: 'B2',
          coverUrl: 'https://oss/cvS.jpg',
          duration: 28,
        },
      ],
    },
  };
  await page.fetchHomeData(true); // 触发后 rx 不在这条链上——直接调 _fetchRx
  await page._fetchRx();
  const rx = page.data.rxCards;
  assert(rx.length === 3, 'G 处方卡 3 张（生词重逢/弱音狙击/微剧场）');
  assert(rx[0].kind === 'clip' && rx[0].tagLabel === '跨语境重逢' && rx[0].focusLabel === 'resilient',
    'G 生词重逢卡：标签与焦点词');
  assert(rx[0].durLabel === '8s' && rx[0].cefrLabel === 'B2', 'G 时长/难度预格式化（WXML 零方法调用）');
  assert(rx[1].tagLabel === '弱音狙击' && rx[1].focusLabel === 'θ', 'G 弱音狙击卡：目标音素');
  assert(rx[2].kind === 'scene' && rx[2].tagLabel === '今日微剧场' && rx[2].durLabel === '28s',
    'G 今日微剧场卡');
  navigations.length = 0;
  page.onRxCardTap({ currentTarget: { dataset: { kind: 'clip', episodeid: 'epA' } } });
  assert(navigations[0] === '/pages/intensive-listening/index?id=epA', 'G 处方卡点击 → 原声精研页');
  page.onRxCardTap({ currentTarget: { dataset: { kind: 'scene', sceneid: 'sceneX', episodeid: '' } } });
  assert(navigations[1] === '/pages/intensive-listening/index?sceneId=sceneX',
    'G 微剧场卡点击 → 微剧场精研页（sceneId 深链，修复空 episodeid 点击无效）');
  navigations.splice(1, 1); // 摘除本断言跳转，还原 H 段按 [0]=精研/[1]=心愿 的既有状态

  // 处方失败/未就绪 → 静默隐藏
  prescriptionPayload = { success: false };
  await page._fetchRx();
  assert(page.data.rxCards.length === 0, 'G 处方未就绪 → 静默清空（区块隐藏）');

  // —— H. 心愿定制签（T3.1：灵感胶囊 + 召唤跳转） ——
  assert(page.data.wishChips.length === 3 && new Set(page.data.wishChips).size === 3,
    'H 灵感胶囊 3 枚且不重复');
  const chip = page.data.wishChips[0];
  page.onWishChipTap({ currentTarget: { dataset: { chip } } });
  assert(page.data.wishInput === chip, 'H 胶囊点击回填输入框');
  page.setData({ wishInput: '' });
  toasts.length = 0;
  page.onWishGo();
  assert(toasts[0] === '先写下一个小心愿吧' && navigations.length === 1, 'H 空心愿 → toast 拦截不跳转');
  page.onWishGo2 = null;
  page.setData({ wishInput: '#连读特训' });
  page.onWishGo();
  assert(
    navigations[1] === '/pages/library/paths/index?wish=' + encodeURIComponent('#连读特训'),
    'H 召唤定制 → 心愿工坊带参（# 前缀安全编码）'
  );

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL HOME DAILY-PRACTICE TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
