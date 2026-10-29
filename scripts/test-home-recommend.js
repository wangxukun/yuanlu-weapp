/**
 * test-home-recommend — 查词工具首页：搜索分流 / 保存生词 / 配额墙（阶段一续）
 *
 * 断言：isWordQuery 分流口径、灵感胶囊触发查询、空结果空态、保存生词
 * （登录/未登录/配额墙 403 三分支）、词典配额墙弹会员窗。
 */
const toasts = [];
const navigations = [];
const posts = [];
let dictQuota = null;
let semanticCalls = [];
let semanticPayload = {
  success: true,
  data: {
    phrases: ['make an appointment', 'schedule a call'],
    items: [
      { clipid: 'sc1', episodeid: 'epS', subtitleId: 51, enText: 'I would like to make an appointment.', zhText: '我想预约。', duration: 4.2, cefrLevel: 'A2', clipAudioUrl: 'https://oss/s1.mp3?Signature=x', clipOffset: 12.0, words: [] },
      { clipid: 'sc2', episodeid: 'epT', subtitleId: 52, enText: 'Schedule a call next week.', zhText: '下周约个电话。', duration: 3.8, cefrLevel: 'B1', clipAudioUrl: null, clipOffset: 0, words: [] },
      { clipid: 'sc3', episodeid: 'epU', subtitleId: 53, enText: 'Book a table.', zhText: '订个位子。', duration: 2.1, cefrLevel: 'A1', clipAudioUrl: null, clipOffset: 0, words: [] },
    ],
  },
};

global.wx = {
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
  showToast: (o) => toasts.push(o.title || ''),
  navigateTo: (o) => navigations.push(o.url),
  switchTab() {},
  stopPullDownRefresh() {},
  request(opts) {
    const url = opts.url;
    let data = {};
    if (url.includes('/api/dict/')) {
      if (dictQuota) {
        opts.success({ statusCode: 403, data: dictQuota });
        return;
      }
      data = { success: true, data: { definitions: [], corpusExamples: [] } };
    } else if (url.includes('/api/scenes/semantic-search')) {
      semanticCalls.push(opts.data && opts.data.q);
      data = semanticPayload;
    } else if (url.includes('/api/scenes/feed')) {
      data = { success: true, data: { total: 0, items: [] } };
    } else if (url.includes('/api/vocabulary/add')) {
      posts.push({ url, data: opts.data });
      data = { success: true };
    } else if (url.includes('/api/user/profile')) data = { nickname: 'n' };
    else if (url.includes('/api/user/stats/overview')) data = {};
    else if (url.includes('/api/vocabulary/all')) data = { data: [] };
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
const dictTool = require('../utils/dict-tool');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

(async () => {
  page.onLoad();

  // —— 场景 A：isWordQuery 分流口径 ——
  assert(dictTool.isWordQuery('compromise') && dictTool.isWordQuery('give up') && dictTool.isWordQuery("it's"),
    'A 英文单词/短语/撇号 → 词典路径');
  assert(!dictTool.isWordQuery('职场拒绝') && !dictTool.isWordQuery('#查单词: compromise') && !dictTool.isWordQuery(''),
    'A 中文场景/#前缀/空 → 语境检索路径');
  assert(dictTool.cleanSearchQuery('#电话预约') === '电话预约' &&
    dictTool.cleanSearchQuery('##机场值机') === '机场值机' &&
    dictTool.cleanSearchQuery('#查单词: compromise') === 'compromise' &&
    dictTool.cleanSearchQuery('  面试自我介绍 ') === '面试自我介绍',
    'A cleanSearchQuery 统一清洗（剥#/保留查单词/去空白）');

  // —— 场景 B：灵感胶囊统一链路（word → 词典；scene → 语义检索 POST） ——
  page.onSuggestionTap({ currentTarget: { dataset: { item: { label: '#查单词: deadline', word: 'deadline' } } } });
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.wordModal.visible === true && page.data.wordModal.word === 'deadline',
    'B #查单词 胶囊 → 词典弹层（#查单词: 语义保留）');
  page.onVocabClose();
  page.onSuggestionTap({ currentTarget: { dataset: { item: { label: '#电话预约', scene: '预约' } } } });
  await new Promise((r) => setTimeout(r, 0));
  assert(semanticCalls[0] === '电话预约',
    'B #电话预约 胶囊 → 统一下游剥 # 后进语义检索（q=电话预约 非 label 原文）');
  assert(page.data.results.length === 3 && page.data.results[0].clipid === 'sc1',
    'B 语义结果 3 条（含 clipid/直签链路字段）');
  page.onResultTap({ currentTarget: { dataset: { clip: 'sc2', query: '电话预约', scene: '' } } });
  assert(navigations[0] === '/pages/practice-room/index?query=' + encodeURIComponent('电话预约') + '&clipId=sc2',
    'B 语境句点击 → 训练室 query+clipId 深链');

  // —— 场景 C：空态文案（仅搜索后渲染） ——
  const wxml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../pages/home/index.wxml'), 'utf8');
  assert(wxml.includes('没找到相关语境') && wxml.includes('searchDone'),
    'C 空态分支与仅搜索后渲染（wx:if searchDone）');

  // —— 场景 D：保存生词三分支 ——
  // D1 未登录 → 引导登录不发请求
  const postsBefore = posts.length;
  page.setData({ 'wordModal.visible': true, 'wordModal.word': 'deadline', isLoggedIn: false });
  page.onVocabSave();
  assert(posts.length === postsBefore && navigations.some((u) => u === '/pages/auth/index'),
    'D1 未登录保存 → 引导登录零请求');
  // D2 登录成功保存 → 请求体对齐 Web 同款
  authStore.setLoginData('token-2', { userid: 'u2', role: 'USER' });
  page.setData({ isLoggedIn: true, 'wordModal.saving': false, 'wordModal.isSaved': false });
  page.onVocabSave();
  await new Promise((r) => setTimeout(r, 0));
  assert(posts.length === 1 && posts[0].data.word === 'deadline',
    'D2 登录保存 → POST /api/vocabulary/add（word 透传）');
  assert(page.data.wordModal.isSaved === true, 'D2 保存成功置已收藏态');
  // D3 生词容量墙 → 会员窗（覆写版 mock 同步尊重词典配额开关）
  let vocAddFail = null;
  global.wx.request = (opts) => {
    if (opts.url.includes('/api/vocabulary/add')) {
      if (vocAddFail) { opts.success({ statusCode: 403, data: vocAddFail }); return; }
      posts.push({ url: opts.url, data: opts.data });
      opts.success({ statusCode: 200, data: { success: true } });
      return;
    }
    if (opts.url.includes('/api/dict/') && dictQuota) {
      opts.success({ statusCode: 403, data: dictQuota });
      return;
    }
    opts.success({ statusCode: 200, data: { success: true, data: {} } });
  };
  vocAddFail = { code: 'VOCABULARY_QUOTA_EXCEEDED' };
  page.setData({ 'wordModal.saving': false, 'wordModal.isSaved': false, 'wordModal.visible': true, 'wordModal.word': 'another' });
  page.onVocabSave();
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.showPremiumModal === true && page.data.premiumSource === 'vocabulary_total',
    'D3 容量墙 403 → 会员窗（工具权益口径场景）');

  // —— 场景 E：词典配额墙 → 会员窗 ——
  dictQuota = { code: 'DICTIONARY_QUOTA_EXCEEDED', message: '今日查询已用完' };
  page.setData({ showPremiumModal: false });
  await page._lookupWord('efficiency');
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.showPremiumModal === true, 'E 词典配额墙 → 会员窗（dictionary_quota）');

  // —— 场景 F：灵感胶囊静态池口径 ——
  assert(page.data.suggestions.every((s) => s.word || s.scene), 'F 胶囊必带查询类型（word/scene）');

  console.log('----------------------------------------');
  if (failed === 0) console.log('ALL HOME DAILY-PRACTICE TESTS PASSED');
  else { console.error(failed + ' TEST(S) FAILED'); process.exitCode = 1; }
})();
