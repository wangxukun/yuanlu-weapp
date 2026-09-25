/**
 * scripts/test-theme.js — 外观设置（跟随系统/浅色/深色）单测
 *
 * 覆盖 utils/theme.js 三模式语义 + mine 页 onAppearance 交互 + 配置完整性：
 *   - 默认跟随系统；setMode 持久化（storage）并复位缓存
 *   - effective 解析：system → 系统主题；手动 light/dark 覆盖系统
 *   - rootClass：system 空类（走媒体查询）；dark → theme-dark；light → theme-light
 *   - chrome 同步：setTabBarStyle/setNavigationBarColor 按生效主题取色
 *   - onThemeChange（系统翻转）仅跟随系统模式联动
 *   - mine onAppearance：ActionSheet 三项带「（当前）」标记，选择后持久化 +
 *     本页 themeClass 即时更新；取消不改动
 *   - 配置把门：app.json darkmode/themeLocation 与 @ 变量齐备；theme.json
 *     light/dark 两组键一致；所有页面 json 不得再硬编码导航色（会压过主题变量）
 *
 * 运行：node scripts/test-theme.js
 */

const storage = new Map();
const chromeCalls = { tabStyles: [], navColors: [] };
let systemTheme = 'light';
let actionSheet = null;
let themeChangeHandler = null;
const toasts = [];

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  getAppBaseInfo: () => ({ theme: systemTheme }),
  onThemeChange(fn) { themeChangeHandler = fn; },
  setTabBarStyle(o) { chromeCalls.tabStyles.push(o); },
  setNavigationBarColor(o) { chromeCalls.navColors.push(o); },
  showActionSheet(o) { actionSheet = o; },
  showToast(o) { toasts.push(o.title); },
};

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}

const fs = require('fs');
const theme = require('../utils/theme');

(async () => {
  console.log('== 三模式语义 ==');
  theme._reset(); storage.clear();
  ok(theme.getMode() === 'system', '缺省跟随系统');
  theme.setMode('dark');
  ok(storage.get(theme.STORAGE_KEY) === 'dark', 'setMode 持久化到 storage');
  ok(theme.getEffective() === 'dark', '手动深色：系统浅色下仍生效深色');
  ok(theme.rootClass() === 'theme-dark', 'rootClass → theme-dark（覆盖类）');
  theme.setMode('light');
  systemTheme = 'dark'; // 系统切深色
  theme._reset(); // 清缓存重读 storage（模拟冷启动）
  ok(theme.getMode() === 'light' && theme.getEffective() === 'light', '手动浅色冷启动后仍覆盖系统深色');
  ok(theme.rootClass() === 'theme-light', 'rootClass → theme-light');
  theme.setMode('system');
  ok(theme.getEffective() === 'dark', '跟随系统：系统深色 → 生效深色');
  ok(theme.rootClass() === '', '跟随系统：空根类（走媒体查询）');
  systemTheme = 'light';
  theme._reset();
  ok(theme.getEffective() === 'light', '跟随系统：系统浅色 → 生效浅色');

  console.log('== chrome 同步 ==');
  chromeCalls.tabStyles.length = 0; chromeCalls.navColors.length = 0;
  theme.setMode('dark');
  const tab = chromeCalls.tabStyles[chromeCalls.tabStyles.length - 1];
  const nav = chromeCalls.navColors[chromeCalls.navColors.length - 1];
  ok(tab && tab.backgroundColor === '#1e1b16' && tab.selectedColor === '#4da989' && tab.borderStyle === 'white',
    '深色 tabBar 配色（同 theme.json）');
  ok(nav && nav.backgroundColor === '#151310' && nav.frontColor === '#ffffff',
    '深色导航栏配色');
  theme.setMode('light');
  const tabL = chromeCalls.tabStyles[chromeCalls.tabStyles.length - 1];
  ok(tabL && tabL.backgroundColor === '#ffffff' && tabL.selectedColor === '#1f7a5c',
    '浅色 tabBar 配色');

  console.log('== 系统主题翻转联动 ==');
  theme.init(); // 注册 onThemeChange（app onLaunch 同款入口）
  theme.setMode('light');
  chromeCalls.tabStyles.length = 0;
  systemTheme = 'dark';
  themeChangeHandler && themeChangeHandler({ theme: 'dark' });
  ok(chromeCalls.tabStyles.length === 0, '手动模式下系统翻转不联动 chrome');
  theme.setMode('system');
  chromeCalls.tabStyles.length = 0;
  systemTheme = 'light';
  themeChangeHandler({ theme: 'light' });
  ok(chromeCalls.tabStyles.length === 1, '跟随系统模式下系统翻转联动 chrome');

  console.log('== mine 页 onAppearance（ActionSheet 三选一） ==');
  let rawPage = null;
  global.Page = (cfg) => { rawPage = cfg; };
  // mine 页 require authStore（其内部依赖 wx 存储 mock 已备）
  require('../pages/mine/index');
  const store = Object.assign({ themeClass: '' }, rawPage.data);
  const page = Object.assign(Object.create(rawPage), {
    data: store,
    setData(p) { Object.assign(store, p); },
  });
  page.onShow();
  ok(store.themeClass === '', 'onShow 刷新根类（跟随系统 → 空类）');
  theme.setMode('light');
  page.onShow();
  ok(store.themeClass === 'theme-light', 'onShow 刷新根类（手动浅色 → theme-light）');

  page.onAppearance();
  ok(actionSheet && actionSheet.itemList.length === 3, 'ActionSheet 三项');
  ok(actionSheet.itemList[0] === '跟随系统' && actionSheet.itemList[1] === '浅色（当前）' && actionSheet.itemList[2] === '深色',
    '现行模式带「（当前）」标记：' + JSON.stringify(actionSheet.itemList));
  toasts.length = 0;
  actionSheet.success({ tapIndex: 2 }); // 选深色
  ok(storage.get(theme.STORAGE_KEY) === 'dark', '选择后持久化 dark');
  ok(store.themeClass === 'theme-dark', '本页根类即时更新');
  ok(toasts[0] === '已切换为深色', 'toast 反馈');
  page.onAppearance();
  toasts.length = 0;
  actionSheet.success({ tapIndex: 2 }); // 重复选择当前项
  ok(toasts.length === 0 && store.themeClass === 'theme-dark', '重复选当前项无副作用');
  page.onAppearance();
  actionSheet.fail && actionSheet.fail({ errMsg: 'cancel' });
  ok(storage.get(theme.STORAGE_KEY) === 'dark', '取消不改模式');

  console.log('== 配置把门 ==');
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  ok(appJson.darkmode === true && appJson.themeLocation === 'theme.json',
    'app.json darkmode + themeLocation');
  ok(appJson.window.navigationBarBackgroundColor === '@navBgColor' &&
    appJson.tabBar.backgroundColor === '@tabBg', 'window/tabBar 引用主题变量');
  const themeJson = JSON.parse(fs.readFileSync('theme.json', 'utf8'));
  const lk = Object.keys(themeJson.light).sort(), dk = Object.keys(themeJson.dark).sort();
  ok(JSON.stringify(lk) === JSON.stringify(dk), 'theme.json light/dark 键一致');
  let hardCoded = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = dir + '/' + d.name;
    if (d.isDirectory()) walk(p);
    else if (d.name.endsWith('.json')) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (cfg.navigationBarBackgroundColor && cfg.navigationBarBackgroundColor[0] !== '@') hardCoded.push(p);
      } catch (e) { /* 忽略非 json */ }
    }
  });
  walk('pages');
  ok(hardCoded.length === 0, '页面 json 无硬编码导航色（' + (hardCoded[0] || '全部走 @ 变量') + '）');
  // 页级导航色键（含 @ 变量形态）一律移除：tab 重显时框架按页配置重应用会压过
  // applyChrome 的 setNavigationBarColor（复习页手动深色白条根因），统一继承 app window
  let ownNavKeys = [];
  const walk2 = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = dir + '/' + d.name;
    if (d.isDirectory()) walk2(p);
    else if (d.name.endsWith('.json')) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if ('navigationBarBackgroundColor' in cfg || 'navigationBarTextStyle' in cfg) ownNavKeys.push(p);
      } catch (e) { /* 忽略 */ }
    }
  });
  walk2('pages');
  ok(ownNavKeys.length === 0, '页面 json 无页级导航色键（继承 app window）：' + (ownNavKeys[0] || '全部继承'));

  const appWxss = fs.readFileSync('app.wxss', 'utf8');
  ok(appWxss.includes('prefers-color-scheme: dark') && appWxss.includes('.theme-dark') && appWxss.includes('.theme-light'),
    'app.wxss 深色令牌双轨齐备（媒体查询 + 手动根类）');
  // 回归把门：根类必须自声明 color（继承传计算值，缺此声明时手动深色下
  // 无显式色类的文本会继承 page 级系统态深字色 → 深字压深底不可读）
  const rootBlockCount = appWxss.split('.theme-dark {').length - 1 + appWxss.split('.theme-light {').length - 1;
  const rootColorCount = (appWxss.match(/\.theme-(dark|light) \{[\s\S]*?color: var\(--text-primary\);/g) || []).length;
  ok(rootBlockCount === rootColorCount, '两个手动根类均自声明 color: var(--text-primary)（继承修复）');
  // 色阶深色翻转（第二波核心）：媒体查询 + .theme-dark 翻转、.theme-light 全量还原
  ok(/--ink-900: #ece7dc/.test(appWxss) && appWxss.indexOf('--ink-900: #ece7dc') !== appWxss.lastIndexOf('--ink-900: #ece7dc'),
    'ink 色阶深色翻转（媒体查询 + theme-dark 双块）');
  ok(/--ink-900: #221f18/.test(appWxss), 'theme-light 全量还原原色阶（手动浅色防串色）');
  ok(/--primary-50: #12261f/.test(appWxss) && /--primary-100: #1a3329/.test(appWxss),
    'primary 浅色档深色翻转（品牌淡底自动双态）');
  // 第二波页面接线
  ['pages/contact/index.wxml','pages/library/favorites/index.wxml','pages/podcast/podcast.wxml',
   'pages/episode/episode.wxml','pages/channel/index.wxml','pages/channel/all/index.wxml',
   'pages/search/search.wxml','pages/intensive-listening/index.wxml'].forEach((f) => {
    ok(fs.readFileSync(f, 'utf8').includes('{{themeClass}}'), f + ' 根视图挂 themeClass');
  });
  // 关键白底已令牌化（迷你条/全屏弹层/频道卡）
  ok(fs.readFileSync('components/player/mini-player/index.wxss', 'utf8').includes('background-color: var(--card-bg);'),
    '迷你播放条底色令牌化');
  ok(!/background-color: #ffffff/.test(fs.readFileSync('components/player/player-panel/index.wxss', 'utf8')),
    '全屏播放器无白底残留');
  // theme require 解析把门：嵌套目录页（pages/library/favorites 等）曾用
  // 浅层 '../../' 解析到 pages/utils/theme 不存在而整页白屏
  const pathMod = require('path');
  const themeReqFiles = [];
  const walkReq = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = dir + '/' + d.name;
    if (d.isDirectory() && p.indexOf('node_modules') < 0) walkReq(p);
    else if (d.name.endsWith('.js')) themeReqFiles.push(p);
  });
  walkReq('pages');
  walkReq('components');
  themeReqFiles.push('app.js');
  const brokenReq = themeReqFiles.filter((f) => {
    const m = fs.readFileSync(f, 'utf8').match(/require\(['"]([^'"]*utils\/theme)['"]\)/);
    return m && !fs.existsSync(pathMod.join(pathMod.dirname(f), m[1]) + '.js');
  });
  ok(brokenReq.length === 0, 'theme require 全部可解析（' + (brokenReq[0] || '无错位路径') + '）');
  // 语音评测接入全局主题（私有存储键退役）
  // 剧集详情：AI 精讲 chip 与评论区不得再用纯白/Slate 硬编码底（联系我们表单风格）
  const epCss = fs.readFileSync('pages/episode/episode.wxss', 'utf8');
  ok(!/background-color: #FFFFFF/.test(epCss) && !/#E2E8F0|#94A3B8/.test(epCss),
    '评论区输入框/发送钮/头像底令牌化（无 Slate 硬编码）');
  const ddCss = fs.readFileSync('components/ai-deep-dive/index.wxss', 'utf8');
  ok(!/background-color: #ffffff/.test(ddCss) && !/rgba\(34, 31, 24/.test(ddCss),
    'AI 精讲 chip/分割线令牌化（无纯白底与透明黑描边）');
  ok(!/#(1f2937|374151|6b7280|9ca3af)/.test(ddCss), 'AI 精讲展开态文本令牌化（无 Tailwind 灰硬编码，深色可读）');
  ok(/\.dd-opt \{[^}]*border: 1px solid var\(--border-color\)/.test(ddCss), '测验选项描边令牌化（深色降亮）');
  ok(!fs.readFileSync('pages/speech-eval/index.js', 'utf8').includes('THEME_KEY'),
    '语音评测废弃私有主题存储（走 utils/theme）');

  ['pages/home/index.wxml', 'pages/discover/index.wxml', 'pages/review/index.wxml', 'pages/mine/index.wxml'].forEach((f) => {
    ok(fs.readFileSync(f, 'utf8').includes('{{themeClass}}'), f + ' 根视图挂 themeClass');
  });

  // 生词本组件深色适配把门：背景色不得再用固定浅色（白叠层/ink-50/ink-100），
  // 须走会翻转的语义令牌（card-bg / base-200 / base-300 / card-fade）；
  // 白字 on 彩色按钮/横幅属有意设计不在此列
  const vn = fs.readFileSync('components/review/vocab-notebook/index.wxss', 'utf8');
  const vnHard = vn.split('\n').filter((l) => /background:\s*(rgba\(255|var\(--ink-(50|100)\))/.test(l));
  ok(vnHard.length === 0, '生词本组件背景色已全部令牌化（残留：' + (vnHard[0] || '无') + '）');
  ok(vn.includes('var(--card-fade)'), '展开面板渐隐走 --card-fade 新令牌');

  console.log('');
  console.log('外观设置：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
