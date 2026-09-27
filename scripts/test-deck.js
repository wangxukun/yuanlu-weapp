/**
 * scripts/test-deck.js — 刷句复习卡片流自动化测试（REVIEW-TASK T3.3）
 *
 * Page 定义捕获 + makeInstance 驱动（vocab-review 同款测试法）：
 *   1. 数据加载与深链定位（subtitleId 命中 / 未命中回落 0）
 *   2. 三模式（sequential 免费 / tag·srs PRO 置锁弹窗 / srs 最久收藏排序 / tag 组卷）
 *   3. 手势（左滑下一句 / 右滑重听 / 快速轻扫速度阈值 / 点击翻面防误触 / 角标透明度派生 / 纵向让位）
 *   4. 翻面与切卡（末尾回环 / flipped 复位 / 停音频 / 翻卡成就 PRO 每 10 张 toast）
 *   5. 重听 audio-clip 显式窗口 + 播放态回流；跟读深链
 *   6. WXML/WXSS 结构断言（文案逐字 + 零方法调用红线）
 *
 * 运行：node scripts/test-deck.js
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
  const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestLog.push({ path: p, method: opts.method || 'GET' });
  const hit = apiResponses[p];
  const body = typeof hit === 'function' ? hit(opts.data) : hit;
  if (body === undefined) {
    opts.success({ statusCode: 200, data: { success: true, data: {} } });
  } else {
    opts.success({ statusCode: 200, data: body });
  }
}

const audioInstances = [];
function makeAudioCtx() {
  const handlers = {};
  const ctx = {
    src: '', currentTime: 0, seeks: [], played: 0, stopped: 0, destroyed: false,
    play() { this.played += 1; },
    stop() { this.stopped += 1; },
    destroy() { this.destroyed = true; },
    seek(t) { this.seeks.push(t); },
    onPlay(cb) { handlers.play = cb; },
    onEnded(cb) { handlers.ended = cb; },
    onError(cb) { handlers.error = cb; },
    onCanplay(cb) { handlers.canplay = cb; },
    onTimeUpdate(cb) { handlers.timeupdate = cb; },
    onWaiting(cb) { handlers.waiting = cb; },
    offEnded() { delete handlers.ended; },
    offError() { delete handlers.error; },
    offCanplay() { delete handlers.canplay; },
    offTimeUpdate() { delete handlers.timeupdate; },
    offPlay() { delete handlers.play; },
    offWaiting() { delete handlers.waiting; },
    __fire(e) { handlers[e] && handlers[e](); },
  };
  audioInstances.push(ctx);
  return ctx;
}

const toastCalls = [];
const navCalls = [];
let navBackCalls = 0;
const switchTabCalls = [];
const navBarColorCalls = [];
const appGlobal = { globalData: { deckFocusSubtitleId: '' } };
global.getApp = () => appGlobal;

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toastCalls.push(o.title),
  showModal: (o) => o.success && o.success({ confirm: false }),
  navigateTo: (o) => navCalls.push(o.url),
  navigateBack: (o) => {
    navBackCalls += 1;
    if (o && o.fail) o.fail({}); // 测试默认模拟「无上页」→ fail 分支 switchTab
  },
  switchTab: (o) => switchTabCalls.push(o.url),
  setNavigationBarColor: (o) => navBarColorCalls.push(o.backgroundColor),
  setTabBarStyle: () => {},
  request: resolveRequest,
  createInnerAudioContext: makeAudioCtx,
  getBackgroundAudioManager: () => ({
    play() {}, pause() {}, stop() {}, seek() {},
    onPlay() {}, onPause() {}, onStop() {}, onEnded() {},
    onTimeUpdate() {}, onCanplay() {}, onWaiting() {}, onError() {},
    onPrev() {}, onNext() {},
  }),
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, theme: 'light' }),
};

let pageDef = null;
global.Page = (cfg) => { pageDef = cfg; };

require(path.join(__dirname, '../pages/review/deck'));
assert(!!pageDef && !!pageDef.methods === false && typeof pageDef.onLoad === 'function',
  '模块加载：deck Page 定义捕获成功');

const WXML = fs.readFileSync(path.join(__dirname, '../pages/review/deck/index.wxml'), 'utf8');
const WXSS = fs.readFileSync(path.join(__dirname, '../pages/review/deck/index.wxss'), 'utf8');
const JSON_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/review/deck/index.json'), 'utf8'));

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
    subtitleId: id * 10, startTime: 10 + id, endTime: 13 + id,
    enText: 'Sentence number ' + id + ' for review.',
    zhText: id === 2 ? null : '第' + id + '句翻译。',
    note: id === 1 ? 'note-1' : null,
    tags: id === 1 ? ['地道表达'] : id === 2 ? ['写作素材'] : [],
    createAt: '2026-09-0' + ((id % 9) + 1) + 'T00:00:00.000Z',
    updateAt: '2026-09-20T00:00:00.000Z',
  }, extra || {});
}

const SENTENCES = [
  makeSentence(1, { createAt: '2026-09-05T00:00:00.000Z' }),
  makeSentence(2, { createAt: '2026-09-02T00:00:00.000Z' }),
  makeSentence(3, { createAt: '2026-09-08T00:00:00.000Z' }),
];
const VOCAB = [{ word: 'number', definition: '数字' }];

/* ==================== 用例 ==================== */

(async () => {
  apiResponses['/api/sentences/list'] = { success: true, data: SENTENCES };
  apiResponses['/api/vocabulary/all'] = { success: true, data: VOCAB };
  apiResponses['/api/user/subscription/status'] = { success: true, data: { role: 'USER' } };

  /* ---------- 1. 加载与深链 ---------- */
  section('数据加载与深链定位');

  const p = makePage();
  navBarColorCalls.length = 0;
  p.onLoad({ subtitleId: '20' }); // 深链命中第 2 句（subtitleId=20）
  await settle(8);
  assert(navBarColorCalls.length >= 1,
    'onLoad/onShow 经 _syncTheme 调 applyChrome（手动深色下原生导航栏跟随——走查修复）');
  await new Promise((r) => setTimeout(r, 10)); // ensureFresh 微任务
  assert(p.data.loading === false && p.data.deckCount === 3, '加载完成：deckCount 3');
  assert(p.data.currentIndex === 1, '深链 subtitleId=20 → 定位第 2 句（index 1）');
  assert(p.data.indexLabel === '2 / 3' && Math.abs(p.data.progressPercent - 66.67) < 0.1,
    '进度派生：2/3（66.7%）');
  assert(p.data.card.enParts.some((s) => s.hit && s.text === 'number'),
    '当前卡生词高亮联动（number 命中）');
  assert(p.data.tagOptions.length === 2 && p.data.tagOptions[0].name === '地道表达',
    '标签候选：计数降序（地道表达 1 / 写作素材 1，首见序稳定）');

  // 未命中深链回落 0
  const p2 = makePage();
  p2.onLoad({ subtitleId: '9999' });
  await settle(8);
  assert(p2.data.currentIndex === 0, '深链未命中 → 回落 index 0');

  /* ---------- 2. 翻面与切卡 ---------- */
  section('翻面 / 切卡 / 回环 / 成就');

  p.onFlipToggle();
  assert(p.data.flipped === true, '底坞翻转钮：翻面');
  p.onFlipToggle();
  assert(p.data.flipped === false, '再点翻回');

  toastCalls.length = 0;
  p.onNext();
  assert(p.data.currentIndex === 2 && p.data.flipped === false, '下一句：index+1 且翻面复位');
  p.onNext();
  assert(p.data.currentIndex === 0, '末尾回环到第 0 张（无完成页）');
  assert(p.data.flipCount === 2, '翻卡计数累计 2');
  assert(toastCalls.length === 0, '免费用户无成就 toast');

  // PRO 成就：每 10 张 toast
  p.setData({ isPremium: true, flipCount: 9 });
  toastCalls.length = 0;
  p.onNext();
  assert(toastCalls.some((t) => t.includes('连续翻卡 10 张')),
    'PRO 第 10 张：成就 toast 文案逐字');
  toastCalls.length = 0;
  p.setData({ flipCount: 4 });
  p.onNext();
  assert(toastCalls.length === 0, '非整 10 不 toast');
  p.setData({ isPremium: false, flipCount: 0 });

  // 免费点成就入口 → 会员窗
  p.onAchievementTap();
  assert(p.data.showPremiumModal === true && p.data.premiumSource === 'sentence_review_advanced',
    '免费点成就入口 → premium(sentence_review_advanced)');
  p.onPremiumClose();

  /* ---------- 3. 手势 ---------- */
  section('拖拽手势（阈值逐字复刻 Web）');

  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });

  // 左滑超阈值 → 下一句
  p.setData({ currentIndex: 0 });
  p.onCardTouchStart(touch(200, 300));
  p.onCardTouchMove(touch(40, 300)); // dx = -160（≥150 角标全显）
  assert(Math.abs(p.data.rotate - (-160 / 200 * 15)) < 0.01, '跟手旋转：dx -160 → -12°（线性，200 封顶）');
  assert(p.data.cueLeftOp === 1 && p.data.cueRightOp === 0, '左角标全显 / 右角标隐藏');
  p.onCardTouchEnd();
  assert(p.data.currentIndex === 1, '左滑 -160px（> 90 阈值）→ 下一句');
  assert(p.data.dx === 0 && p.data.rotate === 0 && p.data.dragging === false,
    '松手手势状态归零（CSS transition 复位）');

  // 右滑超阈值 → 重听原音（当前 index 1 → 第 2 句 startTime=12）
  audioInstances.length = 0;
  apiResponses['/api/episode/subtitles'] = {
    success: true, audioUrl: 'https://oss.example.com/ep.m4a', data: [],
  };
  p.setData({ currentIndex: 1 });
  p.onCardTouchStart(touch(100, 300));
  p.onCardTouchMove(touch(260, 300)); // dx = +160
  assert(p.data.cueRightOp === 1, '右角标全显');
  p.onCardTouchEnd();
  await settle(8);
  const rctx = audioInstances[audioInstances.length - 1];
  assert(!!rctx && rctx.src === 'https://oss.example.com/ep.m4a', '右滑 → 重听拉起原声');
  rctx.__fire('canplay');
  assert(rctx.seeks.includes(12), '重听 seek 到句窗口起点（startTime）');

  // 快速轻扫：位移未达阈值但速度超阈 → 下一句
  p.setData({ currentIndex: 0 });
  p.onCardTouchStart(touch(200, 300));
  const now = Date.now();
  p._drag.prevX = 200; p._drag.prevT = now - 50; // 50ms 内滑 30px → 600px/s
  p._drag.lastX = 170; p._drag.lastT = now;
  p.setData({ dx: -30, dragging: true });
  p._drag.startX = 200;
  p.onCardTouchEnd();
  assert(p.data.currentIndex === 1, '轻扫 -30px + 600px/s（> 400 阈值）→ 下一句');

  // 点击翻面（|dx| < 10 防误触）
  p.setData({ flipped: false });
  p.onCardTouchStart(touch(200, 300));
  p.onCardTouchMove(touch(195, 300)); // dx = -5（未超 slop，未锁定）
  p.onCardTouchEnd();
  assert(p.data.flipped === true, '轻触（位移 5px < 10）→ 翻面');
  p.setData({ flipped: false });

  // 纵向手势让位（不翻面不切卡）
  p.onCardTouchStart(touch(200, 300));
  p.onCardTouchMove(touch(190, 500)); // 纵向 200 vs 横向 -10
  p.onCardTouchEnd();
  assert(p.data.flipped === false && p.data.currentIndex === 1, '纵向手势让位：无翻面无切卡');

  // 重听按钮（底坞）：播放中高亮态经订阅回流
  audioInstances.length = 0;
  p.onReplay();
  await settle(8);
  audioInstances[audioInstances.length - 1].__fire('canplay');
  assert(p.data.playingKey === 'deck:2', '重听播放态回流（playingKey = deck:id）');

  /* ---------- 4. 三模式 ---------- */
  section('三模式（sequential 免费 / tag·srs PRO）');

  // 免费点 srs → 会员窗，不切换
  p.onModeTap({ currentTarget: { dataset: { mode: 'srs' } } });
  assert(p.data.mode === 'sequential' && p.data.showPremiumModal === true,
    '免费点 SRS：不切换 + 弹会员窗');

  // PRO 切 srs：最久收藏优先（createAt 升序 → 第 2 句在前）
  p.setData({ isPremium: true });
  p.onModeTap({ currentTarget: { dataset: { mode: 'srs' } } });
  assert(p.data.mode === 'srs' && p.data.currentIndex === 0, 'PRO 切 SRS：模式生效 + index 复位');
  await settle(2);
  assert(p.data.card.id === 2, 'SRS 排序：最久收藏（createAt 2026-09-02）排首');

  // PRO 切 tag + 选标签组卷
  p.onModeTap({ currentTarget: { dataset: { mode: 'tag' } } });
  assert(p.data.mode === 'tag' && p.data.selectedTag === '', 'PRO 切标签组卷：selectedTag 清空');
  p.onTagTap({ currentTarget: { dataset: { tag: '写作素材' } } });
  assert(p.data.selectedTag === '写作素材' && p.data.deckCount === 1 && p.data.card.id === 2,
    '标签组卷：写作素材子集（1 张）');
  p.onTagTap({ currentTarget: { dataset: { tag: '写作素材' } } });
  assert(p.data.selectedTag === '' && p.data.deckCount === 3, '再点同标签取消 → 全量');
  p.setData({ mode: 'sequential', isPremium: false });

  /* ---------- 5. 跟读与空态 ---------- */
  section('跟读深链 / 空句库');

  navCalls.length = 0;
  p.setData({ currentIndex: 0 }); // 第 1 句 subtitleId=10
  p.onShadow();
  assert(navCalls[0] === '/pages/review/shadowing/index?subtitleId=10',
    '跟读 → shadowing?subtitleId= 深链');
  // subtitleId null 的句子不渲染跟读钮（WXML wx:if）+ onShadow 防御
  p.setData({ currentIndex: 1 }); // 第 2 句 subtitleId=20
  navCalls.length = 0;
  const cardBackup = p.data.card;
  p.setData({ card: Object.assign({}, cardBackup, { hasSubtitle: false }) });
  p.onShadow();
  assert(navCalls.length === 0, 'subtitleId 缺失：onShadow 防御 no-op');
  p.setData({ card: cardBackup });

  // 空句库
  apiResponses['/api/sentences/list'] = { success: true, data: [] };
  const p3 = makePage();
  p3.onLoad({});
  await settle(8);
  assert(p3.data.isEmpty === true && p3.data.card === null, '空句库 → 空态渲染条件');
  apiResponses['/api/sentences/list'] = { success: true, data: SENTENCES };

  // 影子跟读返回带回的句定位（globalData 暂存，消费即清）
  appGlobal.globalData.deckFocusSubtitleId = '20';
  p.onShow();
  assert(p.data.currentIndex === 1 && appGlobal.globalData.deckFocusSubtitleId === '',
    'onShow 消费带回 subtitleId=20 → 定位第 2 句并清空暂存');

  /* ---------- 6. 结构断言 ---------- */
  section('WXML / WXSS / json 结构断言');

  assert(WXML.includes('原句精听与复习'), '正面徽章文案逐字');
  assert(WXML.includes('轻触卡片空白处翻转查看译文与笔记'), '翻面提示文案逐字');
  assert(WXML.includes("card.zhText || '暂无翻译'"), '背面译文空兜底「暂无翻译」');
  assert(WXML.includes('学习笔记：'), '背面学习笔记标签');
  assert(WXML.includes('重听原音') && WXML.includes('下一句'), '手势角标文案');
  assert(WXML.includes("flipped ? '看英文' : '看译文'"), '翻转钮双态文案');
  assert(WXML.includes('dk-dock-shadow') && WXML.includes('card.hasSubtitle'),
    '跟读钮仅 subtitleId 存在时渲染');
  assert(WXML.includes('顺序刷') && WXML.includes('标签组卷') && WXML.includes('SRS 调度'),
    '三模式标签文案');
  assert(WXML.includes('句子本为空') &&
    WXML.includes('请先在播客单集逐字稿中收藏一些句子，再进入卡片复习模式。'),
    '空态文案逐字');
  assert(WXML.includes('手势操作指南') && WXML.includes('知道了'), '帮助弹窗');
  assert(WXML.includes('catchtap="noop"') && WXML.includes('catchtap="onHelpToggle"'),
    '帮助弹窗防误关：面板 catchtap=noop + 知道了 catchtap（空 catch 不拦截致双重翻转的走查修复）');
  assert(typeof pageDef.noop === 'function', 'noop 事件方法已定义');
  assert(WXML.includes('<premium-modal') && JSON_CFG.usingComponents['premium-modal'],
    'premium-modal 挂载 + json 注册');
  assert(WXSS.includes('#10b981') && WXSS.includes('rotate(-12deg)'),
    '角标 emerald 色 + -12° 旋转（Web 原值）');
  assert(/\.dk-dock-flip--on \{[^}]*var\(--primary-50\)/s.test(WXSS) &&
    !WXSS.includes('--ink-900'),
    '翻转钮激活态：浅绿实底（primary-50，替代 btn-neutral 深色实心——走查修复反差）');
  assert(WXML.includes("flipped ? (dark ? '/assets/icons/repeat-active-dark.svg' : '/assets/icons/repeat-active.svg') : (dark ? '/assets/icons/repeat-white.svg' : '/assets/icons/repeat.svg')"),
    '翻转钮图标四态（浅色灰/主绿 × 深色白/浅绿——深色走查修复）');
  assert(WXSS.includes('rgba(77, 169, 137, 0.35)'),
    '翻转钮深色描边浅绿透明（双轨媒体查询 + theme-dark）');
  assert(WXSS.includes('#fdf4e7') && WXSS.includes('#e59d2e'),
    'deck 生词高亮 accent 口径（与句子本 amber 区分）');
  const methodCalls = WXML.match(/\{\{[^}]*\.(indexOf|includes|map|filter|slice|join|toLowerCase|trim)\(/g);
  assert(!methodCalls, 'WXML 绑定零方法调用（' + (methodCalls ? methodCalls.join(' ; ') : '无') + '）');

  /* ---------- 汇总 ---------- */

  console.log(`\n========== 刷句复习 T3.3 测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
