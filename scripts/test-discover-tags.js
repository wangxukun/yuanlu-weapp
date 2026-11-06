/**
 * test-discover-tags — 专项特训页（第二 Tab 重构，工具化转型；2026-11-05 去 mock 接真数据）
 *
 * 断言：tabBar 标签/图标、页面标题、三段真数据（发音急救箱=speech/notebook 画像、
 * 语境卡册书架=learning-paths/mine 真卡册、今日一测=feed 日期种子 + 听写模式）、
 * 零旧信息流残留、游客/无画像/空书架三分支路由、零「播客」字样。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

// —— 场景 A：tabBar 替换（app.json） ——
const app = JSON.parse(read('app.json'));
const tab = app.tabBar.list.find((t) => t.pagePath === 'pages/discover/index');
assert(!!tab && tab.text === '特训', 'A tabBar 文案「发现」→「特训」');
assert(tab.iconPath === 'assets/icons/layers.png' && tab.selectedIconPath === 'assets/icons/layers-active.png',
  'A tabBar 图标换 layers 双态（81×81 PNG，原生 tabBar 不支持 SVG）');
assert(fs.existsSync(path.join(__dirname, '../assets/icons/layers.png')) &&
  fs.existsSync(path.join(__dirname, '../assets/icons/layers-active.png')), 'A layers 图标资产存在');

// —— 场景 B：页面清理与标题 ——
const json = JSON.parse(read('pages/discover/index.json'));
assert(json.navigationBarTitleText === '专项特训', 'B 页面标题「专项特训」');
assert(!json.usingComponents || !json.usingComponents['channel-card'], 'B channel-card 注册移除（组件已退役）');
assert(json.enablePullDownRefresh !== true, 'B 三段式无下拉刷新');

// —— 场景 C：三段真数据 UI ——
const wxml = read('pages/discover/index.wxml');
const wxss = read('pages/discover/index.wxss');
const js = read('pages/discover/index.js');
assert(wxml.includes('发音急救箱') && wxml.includes('aid.weakDesc') && wxml.includes('立即攻克'),
  'C 发音急救箱：诊断卡 + 画像文案 + 立即攻克按钮');
assert(js.includes('/api/speech/notebook'), 'C 急救箱接真画像接口（speech/notebook，mock 已除名）');
assert(js.includes('phonemeStats'), 'C 急救箱消费 phonemeStats 最弱音素');
assert(wxml.includes('语境卡册书架') && wxml.includes('《') && wxml.includes('percent'),
  'C 语境卡册书架：书名 + 进度条');
assert(js.includes('/api/learning-paths/mine'), 'C 书架接真卡册接口（learning-paths/mine，假进度已除名）');
assert(wxss.includes('display: grid') && wxss.includes('repeat(2, 1fr)'),
  'C 书架为手写两列 grid（弃用旧专栏卡组件）');
assert(wxml.includes('今日微剧场听写') && wxml.includes('开始测试'),
  'C 今日一测：固定单卡 + 开始测试大按钮');
assert(js.includes('mode=dictate'), 'C 今日一测直达听写模式（mode=dictate，标题与行为一致）');
assert(js.includes('daySeed()') && js.includes('% items.length'),
  'C 今日一测日期种子换题（当天稳定、跨天换题）');

// —— 场景 D：零旧信息流残留 ——
assert(!wxml.includes('scroll-view') && !wxml.includes('postcard') && !wxml.includes('channel-card'),
  'D 零滚动信息流/明信片/旧组件残留');
['播客', '频道', '专栏', '节目'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w), 'D 代码与文案零「' + w + '」字眼');
});

// —— 场景 E：真数据装配与三分支路由（mock wx 环境驱动） ——
const navigations = [];
const switchedTabs = [];
const storage = new Map();
const requests = [];
function installWx(overrides = {}) {
  global.wx = Object.assign({
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync(k, v) { storage.set(k, v); },
    removeStorageSync(k) { storage.delete(k); },
    showToast() {},
    navigateTo: (o) => navigations.push(o.url),
    switchTab: (o) => switchedTabs.push(o.url),
    request(o) {
      requests.push(o.url);
      o.success({ statusCode: 200, data: { success: true, data: { items: [{ sceneid: 's1' }, { sceneid: 's2' }, { sceneid: 's3' }] } } });
    },
  }, overrides);
}
// 以登录态 + 有画像 + 有卡册装载页面（authStore 需先于页面 require 初始化）
installWx();
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
};
const authStore = require('../store/authStore');
authStore.getState().isLoggedIn = true;
// speech/notebook 有画像 + learning-paths/mine 一册（按 URL 分流）
global.wx.request = (o) => {
  requests.push(o.url);
  if (o.url.includes('/api/speech/notebook')) {
    o.success({
      statusCode: 200,
      data: {
        success: true,
        data: {
          phonemeStats: [{ phoneme: 'θ', avgScore: 64.4 }, { phoneme: 'v', avgScore: 78 }],
        },
      },
    });
  } else if (o.url.includes('/api/learning-paths/mine')) {
    o.success({
      statusCode: 200,
      data: { success: true, data: [{ pathid: 7, pathName: '面试自救指南', coverUrl: 'https://oss/c.jpg', progress: 40, itemCount: 6 }] },
    });
  } else if (o.url.includes('/api/scenes/feed')) {
    o.success({
      statusCode: 200,
      data: { success: true, data: { items: [{ sceneid: 's1' }, { sceneid: 's2' }, { sceneid: 's3' }] } },
    });
  } else {
    o.success({ statusCode: 200, data: { success: true, data: {} } });
  }
};
let page = null;
require('../pages/discover/index');

(async () => {
  page.onLoad();
  page.onShow();
  await new Promise((r) => setTimeout(r, 20));
  assert(page.data.aid.state === 'ready' && page.data.aid.weakLabel === '/θ/ 64 分',
    'E1 急救箱真画像：最弱音素 /θ/ 平均 64 分（phonemeStats[0]）');
  assert(page.data.shelf.state === 'ready' && page.data.shelf.books.length === 1 &&
    page.data.shelf.books[0].title === '面试自救指南' && page.data.shelf.books[0].progress === 40,
    'E1 书架真卡册：learning-paths/mine 映射（标题/真进度）');
  assert(page.data.shelf.books[0].cover === 'https://oss/c.jpg' && page.data.shelf.books[0].isIcon === false,
    'E1 书架封面用真签名 URL（isIcon=false 走图片模式）');

  page.onPhonemeGo();
  assert(navigations[0] === '/pages/review/practice/index', 'E2 有画像「立即攻克」→ 发音闯关');

  page.onBookTap({ currentTarget: { dataset: { pathid: 7 } } });
  assert(navigations[1] === '/pages/library/paths/detail?id=7', 'E2 书架卡片 → 卡册详情（真 pathid）');

  await page.onDailyTestTap();
  assert(navigations[2].startsWith('/pages/intensive-listening/index?sceneId=s') &&
    navigations[2].endsWith('&mode=dictate'),
    'E2 开始测试 → 微剧场精研室听写模式（日期种子三选一）');
  assert(page.data.testBusy === false, 'E2 测试按钮忙碌态复位');

  // —— 场景 F：无画像 → 引导去复习页发音 Tab（pendingTab=2） ——
  global.wx.request = (o) => {
    if (o.url.includes('/api/speech/notebook')) {
      o.success({ statusCode: 200, data: { success: true, data: { phonemeStats: [] } } });
    } else if (o.url.includes('/api/learning-paths/mine')) {
      o.success({ statusCode: 200, data: { success: true, data: [] } });
    } else if (o.url.includes('/api/scenes/feed')) {
      o.success({ statusCode: 200, data: { success: true, data: { items: [{ sceneid: 's1' }] } } });
    } else {
      o.success({ statusCode: 200, data: { success: true, data: {} } });
    }
  };
  await page._loadAid();
  await page._loadShelf();
  await new Promise((r) => setTimeout(r, 20));
  assert(page.data.aid.state === 'empty' && page.data.aid.weakDesc.includes('还没有发音画像'),
    'F1 无画像：空态文案承接');
  assert(page.data.shelf.state === 'empty', 'F1 空书架：心愿工坊 CTA 空态');
  page.onPhonemeGo();
  assert(switchedTabs.length === 1 && switchedTabs[0] === '/pages/review/index' &&
    storage.get('review:pendingTab') === 2,
    'F2 无画像 CTA → 复习页发音 Tab（pendingTab=2 预约）');

  // —— 场景 G：游客 → 登录引导 ——
  authStore.getState().isLoggedIn = false;
  page._syncAuthState();
  await new Promise((r) => setTimeout(r, 20));
  assert(page.data.aid.state === 'guest' && page.data.shelf.state === 'guest',
    'G1 游客：急救箱/书架均为登录引导态');
  navigations.length = 0;
  page.onPhonemeGo();
  assert(navigations[0] === '/pages/auth/index', 'G2 游客 CTA → 登录页');

  console.log('----------------------------------------');
  if (failed === 0) console.log('ALL TRAINING-TAB TESTS PASSED');
  else { console.error(failed + ' TEST(S) FAILED'); process.exitCode = 1; }
})();
