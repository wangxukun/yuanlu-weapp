/**
 * test-discover-tags — 专项特训页（第二 Tab 重构，工具化转型）
 *
 * 断言：tabBar 标签/图标替换、页面标题、三段骨架（发音急救箱/语境卡册书架/
 * 今日一测）、零旧信息流残留（scroll-view/channel-card/明信片）、按钮路由。
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
assert(json.enablePullDownRefresh !== true, 'B 静态骨架无下拉刷新');

// —— 场景 C：三段骨架 UI ——
const wxml = read('pages/discover/index.wxml');
const wxss = read('pages/discover/index.wxss');
assert(wxml.includes('发音急救箱') && wxml.includes('weakPhoneme') && wxml.includes('立即攻克'),
  'C 发音急救箱：诊断卡 + mock 音素 + 立即攻克按钮');
assert(wxml.includes('语境卡册书架') && wxml.includes('《') && wxml.includes('percent'),
  'C 语境卡册书架：书名 + 进度条');
assert(wxss.includes('display: grid') && wxss.includes('repeat(2, 1fr)'),
  'C 书架为手写两列 grid（弃用旧专栏卡组件）');
assert(wxml.includes('今日微剧场听写') && wxml.includes('开始测试'),
  'C 今日一测：固定单卡 + 开始测试大按钮');

// —— 场景 D：零旧信息流残留 ——
assert(!wxml.includes('scroll-view') && !wxml.includes('postcard') && !wxml.includes('channel-card'),
  'D 零滚动信息流/明信片/旧组件残留');
const js = read('pages/discover/index.js');
['播客', '频道', '专栏', '节目'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w), 'D 代码与文案零「' + w + '」字眼');
});

// —— 场景 E：mock 状态与路由 ——
const navigations = [];
global.wx = {
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
  showToast() {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab() {},
  request(o) {
    o.success({ statusCode: 200, data: { success: true, data: { items: [{ sceneid: 'latest1' }] } } });
  },
};
let page = null;
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) { Object.assign(this.data, patch); },
  });
};
require('../pages/discover/index');

(async () => {
  page.onLoad();
  assert(page.data.weakPhoneme === '/θ/ 齿间音', 'E mock 薄弱音素状态');
  assert(page.data.books.length === 4 && page.data.books[0].title === '职场高频句',
    'E 书架四册静态骨架');
  page.onPhonemeGo();
  assert(navigations[0] === '/pages/review/practice/index', 'E 立即攻克 → 发音闯关');
  page.onBookTap();
  assert(navigations[1] === '/pages/library/paths/index', 'E 书架卡片 → 我的卡册');
  await page.onDailyTestTap();
  assert(navigations[2] === '/pages/intensive-listening/index?sceneId=latest1',
    'E 开始测试 → 最新微语境精研（feed 取最新）');
  assert(page.data.testBusy === false, 'E 测试按钮忙碌态复位');

  console.log('----------------------------------------');
  if (failed === 0) console.log('ALL TRAINING-TAB TESTS PASSED');
  else { console.error(failed + ' TEST(S) FAILED'); process.exitCode = 1; }
})();
