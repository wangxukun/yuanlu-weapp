/**
 * test-discover-tags — 原声微流页（第二 Tab，2026-11-15 自 yl-weapp A工程 完整迁移，
 * 替换退役的「专项特训」三段式页面）
 *
 * 断言：tabBar 标签/图标、页面标题、竖滑 swiper 切片流骨架、DIY 下拉刷新、
 * 环形游标与已看去重模块挂载、外链图片零依赖（本地资产）、合规字样零残留、
 * 零旧特训页残留。运行时行为由 test-reels-session.cjs 覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

// —— 场景 A：tabBar（app.json） ——
const app = JSON.parse(read('app.json'));
const tab = app.tabBar.list.find((t) => t.pagePath === 'pages/discover/index');
assert(!!tab && tab.text === '原声微流', 'A tabBar 文案「原声微流」');
assert(tab.iconPath === 'assets/icons/reels.png' && tab.selectedIconPath === 'assets/icons/reels-active.png',
  'A tabBar 图标换 reels 双态');
assert(fs.existsSync(path.join(__dirname, '../assets/icons/reels.png')) &&
  fs.existsSync(path.join(__dirname, '../assets/icons/reels-active.png')), 'A reels 图标资产存在');

// —— 场景 B：页面契约 ——
const json = JSON.parse(read('pages/discover/index.json'));
assert(json.navigationBarTitleText === '原声微流', 'B 页面标题「原声微流」');
assert(!!json.usingComponents && !!json.usingComponents['vocabulary-modal'] &&
  !!json.usingComponents['premium-modal'], 'B 组件注册（词卡/会员弹窗）');

// —— 场景 C：微流骨架（竖滑 swiper + DIY 下拉 + 游标去重） ——
const wxml = read('pages/discover/index.wxml');
const wxss = read('pages/discover/index.wxss');
const js = read('pages/discover/index.js');
assert(wxml.includes('<swiper') && wxml.includes('vertical'), 'C 竖滑 swiper 切片流');
assert(wxml.includes('rl-pull-hint') && wxml.includes('onPullTouchStart'), 'C DIY 下拉刷新提示条与手势');
assert(js.includes("require('./reels-session')"), 'C 环形游标会话模块挂载');
assert(js.includes('PAGE_SIZE_CAP') && js.includes('PRELOAD_MARGIN'), 'C 渲染封顶与预取边界常量');
assert(fs.existsSync(path.join(__dirname, '../pages/discover/reels-session.js')), 'C reels-session 模块存在');
assert(fs.existsSync(path.join(__dirname, '../pages/discover/reels-corpus.js')), 'C 本地语料兜底存在');

// —— 场景 D：合规与外链 ——
['播客', '智能', '社区', '大模型'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w) && !json.navigationBarTitleText.includes(w),
    'D 零「' + w + '」字眼');
});
assert(!/\bpodcast\b/i.test(js) && !/\bpodcast\b/i.test(wxml) && !js.includes('podcastTitle'),
  'D 零英文 podcast 标识');
assert(!/\bAI\b/.test(js) && !/\bAI\b/.test(wxml), 'D 零「AI」字眼');
assert(!js.includes('images.unsplash.com') && !wxml.includes('images.unsplash.com') &&
  !read('pages/discover/reels-corpus.js').includes('images.unsplash.com'),
  'D 零 unsplash 外链（封面/头像已本地化）');
assert(fs.existsSync(path.join(__dirname, '../assets/covers')), 'D 本地封面资产目录存在');

// —— 场景 E：零旧特训页残留 ——
['发音急救箱', '语境卡册', '今日微剧场听写', 'learning-paths/mine', 'speech/notebook',
  'mode=dictate', 'layers'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w) && !wxss.includes('layers'),
    'E 零旧特训残留「' + w + '」');
});

if (failed) {
  console.error('✗ ' + failed + ' 项失败');
  process.exit(1);
}
console.log('✓ discover-tags 全部通过');
