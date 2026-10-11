/**
 * scripts/test-home-recommend.js — 主页「为你推荐」难度口径单测（Node 环境，mock wx + Page）
 *
 * 验证目标（三端推荐口径统一，2026-10-11）：
 *   A. profile 带 derivedLevel（语音评测推导 CEFR 值）→ 按 CEFR 相邻档过滤，
 *      与 Web 服务端 getRecommendedEpisodes 的等级解析一致
 *   B. derivedLevel 过滤命中时，「为你推荐」与「最近发布」（接口序前 4）自然错开
 *   C. derivedLevel 为 null / 非法值 → 回退 learnLevel 粗粒度档（历史行为不变）
 *   D. learnLevel 缺失（General）→ 不过滤取前 4（历史行为不变）
 *   E. derivedLevel 档位在池中无命中 → 回退池前 4（历史兜底不变）
 *
 * 运行：node scripts/test-home-recommend.js
 */

let profilePayload = {}; // 可变：/api/user/profile 载荷
let episodePool = [];    // 可变：/api/episode/list 分页池（推荐序）

let apiCalls = 0;

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
    apiCalls++;
    const url = opts.url;
    let data = {};
    if (url.includes('/api/user/profile')) {
      data = profilePayload;
    } else if (url.includes('/api/episode/list-by-podcastid')) {
      data = { episodes: [] }; // 富化为空（测试池不带 podcastid，正常也不会触发）
    } else if (url.includes('/api/episode/list')) {
      data = episodePool;
    } else if (url.includes('/api/user/stats/weekly-activity')) {
      data = { weeklyActivity: [] };
    } else if (url.includes('/api/user/history')) {
      data = { data: { items: [] } };
    } else if (url.includes('/api/vocabulary/all')) {
      data = [];
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

/** 推荐序池：B2,B2,B1,B1,C1,B1（模拟服务端个性化 ranked 头部；日期递增以便验证最近发布排序） */
const ep = (id, diff, pub) => ({
  episodeid: id,
  title: `EP-${id}`,
  difficulty: diff,
  publishAt: pub,
  duration: 600,
  playCount: 0,
});
const ids = (list) => list.map((e) => e.episodeid).join(',');

async function scenario(label, profile, pool) {
  authStore.logout();
  await settle();
  profilePayload = profile;
  episodePool = pool;
  authStore.setLoginData('token-' + Math.random().toString(36).slice(2), {
    userid: 'u1',
    role: 'USER',
  });
  await settle();
  await settle();
  if (process.env.DEBUG_HOME_REC) {
    console.error('DEBUG', JSON.stringify({
      isLoggedIn: page.data.isLoggedIn,
      isLoading: page.data.isLoading,
      error: page.data.error,
      apiCalls,
      recommended: page.data.recommended,
      latest: page.data.latestEpisodes,
    }));
  }
  return { recommended: page.data.recommended, latest: page.data.latestEpisodes, label };
}

(async () => {
  page.onLoad(); // 注册 authStore 订阅（游客态，零请求）
  await settle();

  const pool = [
    ep('e1', 'B2', '2026-10-01'),
    ep('e2', 'B2', '2026-10-02'),
    ep('e3', 'B1', '2026-10-03'),
    ep('e4', 'B1', '2026-10-04'),
    ep('e5', 'C1', '2026-10-05'),
    ep('e6', 'B1', '2026-10-06'),
  ];

  // —— 场景 A/B：derivedLevel=B2 → [B2,C1] 相邻档过滤（Web 同口径）——
  let r = await scenario('A', { learnLevel: 'Intermediate', derivedLevel: 'B2' }, pool);
  assert(
    ids(r.recommended) === 'e1,e2,e5',
    `A derivedLevel=B2 → [B2,C1] 过滤取前 4（实得 ${ids(r.recommended)}）`
  );
  assert(
    ids(r.latest) === 'e6,e5,e4,e3',
    `B 最近发布=严格 publishAt 倒序前 4，与推荐序（池序前 4）错开（实得 ${ids(r.latest)}）`
  );

  // —— 场景 C1：derivedLevel=null → 回退 learnLevel=[B1,B2] ——
  r = await scenario('C1', { learnLevel: 'Intermediate', derivedLevel: null }, pool);
  assert(
    ids(r.recommended) === 'e1,e2,e3,e4',
    `C1 derivedLevel=null 回退 learnLevel=[B1,B2]（实得 ${ids(r.recommended)}）`
  );

  // —— 场景 C2：derivedLevel 非法值 → 忽略，回退 learnLevel ——
  r = await scenario('C2', { learnLevel: 'Advanced', derivedLevel: 'X9' }, pool);
  assert(
    ids(r.recommended) === 'e5',
    `C2 非法 derivedLevel 忽略 → learnLevel=Advanced=[C1,C2] 过滤（实得 ${ids(r.recommended)}）`
  );

  // —— 场景 D：无等级（General）→ 不过滤取前 4 ——
  r = await scenario('D', {}, pool);
  assert(
    ids(r.recommended) === 'e1,e2,e3,e4',
    `D General 不过滤取池前 4（实得 ${ids(r.recommended)}）`
  );

  // —— 场景 E：derivedLevel 档位池中无命中 → 回退池前 4 ——
  const noHitPool = [
    ep('f1', 'B1', '2026-10-01'),
    ep('f2', 'B1', '2026-10-02'),
    ep('f3', 'B1', '2026-10-03'),
    ep('f4', 'B1', '2026-10-04'),
  ];
  r = await scenario('E', { learnLevel: 'Intermediate', derivedLevel: 'C1' }, noHitPool);
  assert(
    ids(r.recommended) === 'f1,f2,f3,f4',
    `E [C1,C2] 无命中回退池前 4（实得 ${ids(r.recommended)}）`
  );

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
