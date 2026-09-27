/**
 * scripts/test-shadowing.js — AI 影子跟读页自动化测试（REVIEW-TASK T3.4）
 *
 * Page 定义捕获 + makeInstance 驱动：
 *   1. 深链定位（id 优先 / subtitleId 兜底 / 未命中回落 0）
 *   2. subtitle 组装（subtitleId 精确匹配字幕条目〔words/文本全用字幕口径〕/
 *      subtitleId null 兜底收藏句字段 / 字幕拉取失败降级）
 *   3. 跨集切句按 episodeid 重拉 subtitles（按集缓存）
 *   4. quota 预检置锁 / onQuota 触墙置锁
 *   5. evaluate 结果缓存与切回恢复（previousResult）
 *   6. 句导航边界 + 最后一句「完成跟读」带回 subtitleId（globalData）+ navigateBack
 *   7. 空句库空态；WXML 结构断言
 *
 * 运行：node scripts/test-shadowing.js
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
  requestLog.push({ path: p, method: opts.method || 'GET' });
  // 先精确 path，再带 query 前缀（subtitles?id=epN 按集分发）
  let hit = apiResponses[p];
  if (hit === undefined) hit = apiResponses[raw];
  const body = typeof hit === 'function' ? hit(opts) : hit;
  if (body === undefined) {
    opts.success({ statusCode: 200, data: { success: true, data: {} } });
  } else {
    opts.success({ statusCode: 200, data: body });
  }
}

const navBackCalls = [];
const switchTabCalls = [];
const appGlobal = { globalData: {} };

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: (o) => o.success && o.success({ confirm: false }),
  navigateTo: () => {},
  navigateBack: (o) => {
    navBackCalls.push(1);
    if (o && o.fail) o.fail({});
  },
  switchTab: (o) => switchTabCalls.push(o.url),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  request: resolveRequest,
  getBackgroundAudioManager: () => ({
    play() {}, pause() {}, stop() {}, seek() {},
    onPlay() {}, onPause() {}, onStop() {}, onEnded() {},
    onTimeUpdate() {}, onCanplay() {}, onWaiting() {}, onError() {},
    onPrev() {}, onNext() {},
  }),
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, theme: 'light' }),
};
global.getApp = () => appGlobal;

let pageDef = null;
global.Page = (cfg) => { pageDef = cfg; };
// shadowing 模块级 subtitleCache：跨实例复用（真全局缓存口径）
require(path.join(__dirname, '../pages/review/shadowing'));
assert(!!pageDef && typeof pageDef.onLoad === 'function', '模块加载：shadowing Page 定义捕获成功');

const WXML = fs.readFileSync(path.join(__dirname, '../pages/review/shadowing/index.wxml'), 'utf8');
const JSON_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/review/shadowing/index.json'), 'utf8'));

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

function makeSentence(id, extra) {
  return Object.assign({
    id, episodeid: 'ep' + id, episodeTitle: '剧集' + id, podcastTitle: null,
    subtitleId: id * 10, startTime: 10, endTime: 13,
    enText: 'Saved text ' + id + '.',
    zhText: '收藏句翻译' + id,
    note: null, tags: [],
    createAt: '2026-09-0' + id + 'T00:00:00.000Z', updateAt: '',
  }, extra || {});
}

const S1 = makeSentence(1); // ep1 / subtitleId 10
const S2 = makeSentence(2); // ep2 / subtitleId 20（跨集）
const S3 = makeSentence(3, { subtitleId: null }); // 无字幕定位句

apiResponses['/api/sentences/list'] = { success: true, data: [S1, S2, S3] };
apiResponses['/api/episode/subtitles?id=ep1'] = {
  success: true, audioUrl: 'https://oss/ep1.m4a',
  data: [{ id: 10, start: 12.1, end: 15.2, textEn: 'Subtitle text one.', textCn: '字幕译文一',
    words: [{ word: 'Subtitle', start: 12.1, end: 12.5 }] }],
};
apiResponses['/api/episode/subtitles?id=ep2'] = {
  success: true, audioUrl: 'https://oss/ep2.m4a',
  data: [{ id: 20, start: 22, end: 25, textEn: 'Subtitle text two.', textCn: null, words: [] }],
};
apiResponses['/api/episode/subtitles?id=ep3'] = {
  success: true, audioUrl: 'https://oss/ep3.m4a', data: [],
};
apiResponses['/api/speech/quota'] = { success: true, data: { used: 2, limit: 5, exhausted: false } };

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- 1. 深链定位与 subtitle 组装 ---------- */
  section('深链定位 + subtitle 注入');

  const p = makePage();
  p.onLoad({ id: '2' }); // id 优先 → 第 2 句（ep2/subtitleId 20）
  await settle(10);
  assert(p.data.index === 1 && p.data.loading === false, '深链 id=2 → index 1');
  assert(p.data.episodeId === 'ep2' && p.data.subtitleId === 20, '当前句：ep2 / subtitleId 20');
  assert(p.data.subtitle.audioUrl === 'https://oss/ep2.m4a', 'subtitle.audioUrl = 全集直链');
  assert(p.data.subtitle.textEn === 'Subtitle text two.', '文本用字幕口径（命中 subtitleId=20）');
  assert(p.data.cardKey === 'sh-2', '卡片 key 按句 id 重挂');
  assert(p.data.total === 3 && Math.abs(p.data.progressPercent - 66.67) < 0.1,
    '进度 (2/3)');

  // subtitleId 兜底
  const p2 = makePage();
  p2.onLoad({ subtitleId: '10' });
  await settle(10);
  assert(p2.data.index === 0 && p2.data.subtitle.words.length === 1,
    '深链 subtitleId=10 → 第 1 句（词级时间戳注入）');
  assert(p2.data.subtitle.textEn === 'Subtitle text one.' && p2.data.subtitle.start === 12.1,
    '命中字幕：start/textEn/words 全字幕口径');

  // 非零位深链（deck 跟读场景：只传 subtitleId；回归锁死——index 初始 0 会把
  // subtitleId 兜底分支短路，恒落第 1 句致卡片与跟读句错位）
  const p2b = makePage();
  p2b.onLoad({ subtitleId: '20' });
  await settle(10);
  assert(p2b.data.index === 1 && p2b.data.subtitleId === 20,
    '深链 subtitleId=20（非零位）→ 第 2 句（deck 跟读同句回归）');
  assert(p2b.data.subtitle.textEn === 'Subtitle text two.',
    '非零位深链：句子文本与第 3 张刷句卡一致（非第 1 句）');

  // 未命中回落 0
  const p3 = makePage();
  p3.onLoad({ id: '999' });
  await settle(10);
  assert(p3.data.index === 0, '深链未命中 → 回落 0');

  /* ---------- 2. subtitleId null 兜底 + 字幕失败降级 ---------- */
  section('无字幕定位句 / 降级');

  const p4 = makePage();
  p4.onLoad({ id: '3' }); // subtitleId null → ep3 字幕空 → 收藏句字段兜底
  await settle(10);
  assert(p4.data.subtitle.textEn === 'Saved text 3.' && p4.data.subtitle.words.length === 0,
    'subtitleId null：收藏句字段兜底（words 空）');
  assert(p4.data.subtitle.audioUrl === 'https://oss/ep3.m4a', 'audioUrl 仍取全集直链');

  /* ---------- 3. quota 预检与事件 ---------- */
  section('quota 预检 / 触墙置锁');

  assert(p.data.quotaLocked === false, '预检未触墙 → 不置锁');
  apiResponses['/api/speech/quota'] = { success: true, data: { used: 6, limit: 5, exhausted: true } };
  const p5 = makePage();
  p5.onLoad({ id: '1' });
  await settle(10);
  assert(p5.data.quotaLocked === true, '预检 exhausted → 卡置锁');

  p5.onQuota({ detail: { used: 6, limit: 5, exhausted: true } });
  assert(p5.data.quotaLocked === true, '评测后触墙 → 保持置锁');
  p5.onQuota({ detail: { used: 1, limit: 5, exhausted: false } });
  assert(p5.data.quotaLocked === false, '余量恢复（跨天）→ 解锁');

  /* ---------- 4. evaluate 缓存与切回恢复 ---------- */
  section('结果缓存与切回恢复');

  const RESULT = { overallScore: 88, pronunciation: 90, fluency: 85, integrity: 88, speed: 100, words: [] };
  p5.onEvaluate({ detail: { score: 88, details: RESULT, recognitionId: 7 } });
  p5.onNext();
  await settle(10);
  assert(p5.data.index === 1 && p5.data.previousResult === null, '切下一句：无历史结果');
  p5.onPrev();
  await settle(10);
  assert(p5.data.previousResult === RESULT, '切回：previousResult 恢复（结果态重挂）');

  /* ---------- 5. 句导航边界 + 完成带回 ---------- */
  section('导航边界 / 完成跟读带回');

  navBackCalls.length = 0;
  p5.onPrev(); // index 0 → no-op
  assert(p5.data.index === 0 && navBackCalls.length === 0, '首句上一句 no-op');
  // 跳到最后一句（index 2）
  p5.onNext(); await settle(10);
  p5.onNext(); await settle(10);
  assert(p5.data.index === 2, '推进到最后一句');
  p5.onNext(); // 最后一句 → 完成跟读
  assert(navBackCalls.length === 1, '最后一句下一句 → navigateBack');
  assert(appGlobal.globalData.deckFocusSubtitleId === '' || appGlobal.globalData.deckFocusSubtitleId,
    'globalData 带回字段已写入（subtitleId null 句为空串）');

  // 完成带回非空 subtitleId
  appGlobal.globalData.deckFocusSubtitleId = '';
  const p6 = makePage();
  p6.onLoad({ id: '1' });
  await settle(10);
  navBackCalls.length = 0;
  p6.onFinish();
  assert(navBackCalls.length === 1 && appGlobal.globalData.deckFocusSubtitleId === '10',
    '完成跟读：带回当前句 subtitleId=10（deck onShow 消费定位）');

  /* ---------- 6. 跨集切句重拉字幕 ---------- */
  section('跨集切句');

  requestLog.length = 0;
  const p7 = makePage();
  p7.onLoad({ id: '1' });
  await settle(10);
  requestLog.length = 0;
  p7.onNext(); // ep1 → ep2
  await settle(10);
  assert(p7.data.subtitle.audioUrl === 'https://oss/ep2.m4a',
    '跨集切句：重拉 ep2 字幕注入');
  const ep2Fetches = requestLog.filter((r) => r.path === '/api/episode/subtitles').length;
  p7.onPrev(); await settle(10); // 回 ep1（缓存命中）
  p7.onNext(); await settle(10);
  assert(requestLog.filter((r) => r.path === '/api/episode/subtitles').length === ep2Fetches,
    '按集缓存：回访已拉剧集零重复请求');

  /* ---------- 7. 空句库 ---------- */
  section('空句库');

  apiResponses['/api/sentences/list'] = { success: true, data: [] };
  const p8 = makePage();
  p8.onLoad({});
  await settle(10);
  assert(p8.data.isEmpty === true && p8.data.subtitle === null, '空句库 → 空态');
  apiResponses['/api/sentences/list'] = { success: true, data: [S1, S2, S3] };

  /* ---------- 8. 结构断言 ---------- */
  section('WXML / json 结构断言');

  assert(WXML.includes('AI 影子跟读评测 ({{index + 1}}/{{total}})'), '标题格式（(i/N)）逐字');
  assert(WXML.includes('sh-progress-bar'), '进度条');
  assert(WXML.includes('<eval-card') && WXML.includes('key="{{cardKey}}"') &&
    WXML.includes('subtitle="{{subtitle}}"') && WXML.includes('quota-locked="{{quotaLocked}}"') &&
    WXML.includes('previous-result="{{previousResult}}"'),
    'eval-card 挂载与 props（key 重挂 / subtitle / quotaLocked / previousResult）');
  assert(WXML.includes('bind:evaluate="onEvaluate"') && WXML.includes('bind:quota="onQuota"'),
    'eval-card 事件接线（evaluate / quota）');
  assert(WXML.includes('上一句') && WXML.includes('下一句') && WXML.includes('完成跟读'),
    '底部导航三态文案');
  assert(WXML.includes('index >= total - 1') && WXML.includes('sh-finish'),
    '最后一句右钮变「完成跟读」');
  assert(WXML.includes('句子本为空') && WXML.includes('请先在句子本收藏一些句子，再来进行影子跟读。'),
    '空态文案');
  assert(JSON_CFG.usingComponents['eval-card'], 'json 注册 eval-card');
  const methodCalls = WXML.match(/\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|toLowerCase|trim)\(/g);
  assert(!methodCalls, 'WXML 绑定零方法调用（' + (methodCalls ? methodCalls.join(' ; ') : '无') + '）');

  /* ---------- 汇总 ---------- */

  console.log(`\n========== 影子跟读 T3.4 测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
