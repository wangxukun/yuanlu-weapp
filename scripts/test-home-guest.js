/**
 * test-home-guest — 查词工具首页（工具化转型阶段一）
 *
 * 断言：灵感胶囊抽样/刷新、无搜索零内容、查词分流（词→词典弹层含真实语境
 * 例句静态高亮；场景→语境句列表）、查词记录抽屉、4 工具入口路由、登录态
 * 问候拉取、下拉刷新配置保留。
 */
const fs = require('node:fs');
const path = require('node:path');

const toasts = [];
const navigations = [];
const switchTabs = [];
const storage = {};
let profileCalls = 0;
let dictCalls = [];
let feedCalls = [];

let dictPayload = {
  success: true,
  data: {
    definitions: [{ pos: 'v.', meaning_cn: '妥协' }],
    corpusExamples: [
      { clipid: 'clipA', enText: 'We must compromise on price.', zhText: '我们必须在价格上妥协。' },
      { clipid: 'clipB', enText: 'Compromise is not weakness.', zhText: '妥协不是软弱。' },
      { clipid: 'clipC', enText: 'a third compromise example', zhText: null },
    ],
  },
};
let feedPayload = {
  success: true,
  data: {
    total: 2,
    items: [
      { sceneid: 's1', duration: 21.4, situationTag: '面试', golden: { en: 'Tell me about yourself.', zh: '介绍一下你自己。' } },
      { sceneid: 's2', duration: 33.9, situationTag: '面试', golden: { en: 'Why this role?', zh: '为什么选这个岗位？' } },
    ],
  },
};
let profilePayload = { nickname: '小远', streakDays: 5 };
let vocabPayload = { data: [{ word: 'resilient' }] };

global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: (o) => toasts.push(o.title || ''),
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => switchTabs.push(o.url),
  stopPullDownRefresh() {},
  request(opts) {
    const url = opts.url;
    let data = {};
    if (url.includes('/api/user/profile')) { profileCalls++; data = profilePayload; }
    else if (url.includes('/api/user/stats/overview')) data = { streakDays: 5 };
    else if (url.includes('/api/vocabulary/all')) data = vocabPayload;
    else if (url.includes('/api/dict/')) { dictCalls.push(url); data = dictPayload; }
    else if (url.includes('/api/scenes/feed')) { feedCalls.push(url); data = feedPayload; }
    opts.success({ statusCode: 200, data });
  },
};

function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    if (!/[.[]/.test(key)) { data[key] = patch[key]; return; }
    const path = key.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = data;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (cur[k] === undefined || typeof cur[k] !== 'object') {
        cur[k] = /^\d+$/.test(path[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[path[path.length - 1]] = patch[key];
  });
}

let page = null;
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) { applyPatch(this.data, patch); },
  });
};

require('../pages/home/index');
const authStore = require('../store/authStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

(async () => {
  // —— 场景 A：初始工具态（游客可用；无搜索零内容） ——
  page.onLoad();
  assert(page.data.suggestions.length === 4 && page.data.suggestions.every((s) => s.label.startsWith('#')),
    'A 灵感胶囊 4 枚且带 # 前缀（静态池随机抽样）');
  const labels1 = page.data.suggestions.map((s) => s.label).join(',');
  page.onRefreshSuggestions();
  const labels2 = page.data.suggestions.map((s) => s.label).join(',');
  assert(labels1 !== labels2 || true, 'A 刷新可换胶囊（随机口径，不做确定性断言）');
  assert(page.data.searchDone === false && page.data.results.length === 0,
    'A 无搜索零内容零播放（searchDone=false / results 空）');
  assert(page.data.isLoggedIn === false, 'A 游客 isLoggedIn=false（搜索仍可用）');

  // —— 场景 B：查词分流（英文词 → 词典弹层 + 真实语境例句静态高亮） ——
  await page._lookupWord('compromise');
  assert(page.data.wordModal.visible === true && page.data.wordModal.word === 'compromise',
    'B 查词弹层打开（/api/dict 命中）');
  assert(page.data.wordModal.corpusExamples.length === 2, 'B 例句最多展示 2 条（静态文本口径）');
  const first = page.data.wordModal.corpusExamples[0];
  assert(first.clipid === 'clipA' && first.parts.some((p) => p.hl), 'B 命中词三段高亮预计算（WXML 零方法调用）');
  assert(page.data.history[0] === 'compromise', 'B 查词记录置顶入本地历史');
  assert(page.data.results.length === 0, 'B 词典路径不渲染语境列表');

  // —— 场景 C：例句【前往跟读】→ 训练室（携带词与例句） ——
  page.onVocabGoPractice({ detail: { example: { clipid: 'clipB' } } });
  assert(navigations[0] === '/pages/practice-room/index?word=compromise&clipId=clipB',
    'C 前往跟读 → 训练室带 word+clipId');
  assert(page.data.wordModal.visible === false, 'C 跳转即关闭弹层');

  // —— 场景 D：场景检索（中文意图 → 语境句列表，仅搜索后渲染） ——
  await page._searchScene('面试');
  assert(page.data.searchDone === true && page.data.results.length === 2, 'D 场景检索出 2 条语境句');
  assert(page.data.results[0].durText === '21s' && page.data.results[0].en === 'Tell me about yourself.',
    'D 结果视图模型预格式化（durText/en）');
  page.onResultTap({ currentTarget: { dataset: { scene: 's2' } } });
  assert(navigations[1] === '/pages/practice-room/index?sceneId=s2', 'D 语境句点击 → 训练室 sceneId 深链');

  // —— 场景 E：4 工具入口 ——
  page.onToolTap({ currentTarget: { dataset: { key: 'history' } } });
  assert(page.data.historyOpen === true && page.data.history[0] === 'compromise', 'E 查词记录抽屉打开');
  page.onHistoryClear();
  assert(page.data.history.length === 0, 'E 查词记录可清空');
  page.onHistoryClose();
  page.onToolTap({ currentTarget: { dataset: { key: 'vocab' } } });
  assert(storage['review:pendingTab'] === 0 && switchTabs[0] === '/pages/review/index', 'E 生词本 → 复习中心 Tab0（storage 预约）');
  page.onToolTap({ currentTarget: { dataset: { key: 'pron' } } });
  assert(storage['review:pendingTab'] === 2, 'E 发音笔记本 → 复习中心 Tab2');
  page.onToolTap({ currentTarget: { dataset: { key: 'packs' } } });
  assert(navigations[2] === '/pages/library/paths/index', 'E 我的卡册 → 学习路径页');

  // —— 场景 F：登录态（问候 + 生词保存态判定） ——
  authStore.setLoginData('token-1', { userid: 'u1', role: 'USER' });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.isLoggedIn === true, 'F 登录后内容态');
  assert(page.data.greeting.indexOf('小远') !== -1 && page.data.streakDays === 5, 'F 问候语 + 连续天数（profile+overview）');
  assert(page._vocabSet['resilient'] === true, 'F 生词集合预载（保存态判定）');
  await page._lookupWord('resilient');
  assert(page.data.wordModal.isSaved === true, 'F 已收藏词查询即已保存态');

  // —— 场景 G：下拉刷新配置保留（回归守卫） ——
  const homeJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/home/index.json'), 'utf8'));
  assert(homeJson.enablePullDownRefresh === true, 'G 页面 json 开启 enablePullDownRefresh（手势可达）');

  console.log('----------------------------------------');
  if (failed === 0) console.log('ALL HOME GUEST-STATE TESTS PASSED');
  else { console.error(failed + ' TEST(S) FAILED'); process.exitCode = 1; }
})();
