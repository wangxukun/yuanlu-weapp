/**
 * scripts/test-search.js — 独立搜索页与发现页搜索打通自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），全链路驱动
 * pages/search/search.js → utils/request.js → wx.request：
 * 覆盖深链 ?q=、防抖/回车/清空交互、{success,data,total} 包装解包、
 * topTags 裁剪、双列分块、错误复位不重复 toast、导航栏标题动态化；
 * 并回归发现页 doSearch 解包修复与「全部结果」跳转（打通入口）。
 * 另对 WXML 做静态断言：Web 端 /search 页文案逐字一致 + 关键绑定齐全。
 *
 * 运行：node scripts/test-search.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const storage = new Map();
const toasts = [];
const navigations = [];
const switchTabs = [];
const navTitles = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  showModal: () => {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => switchTabs.push(o.url),
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  setNavigationBarTitle: (o) => navTitles.push(o.title),
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

const pageConfigs = [];
global.Page = (cfg) => pageConfigs.push(cfg);

/** 路由感知应答：按路径返回 {statusCode, data}；未知路径 200 {success:true} */
function routeAwareHandler(routes) {
  return (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[p];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

require(path.join(__dirname, '../pages/search/search.js'));
require(path.join(__dirname, '../pages/discover/index.js'));
const searchPage = pageConfigs[0];
const discoverPage = pageConfigs[1];

/* ==================== 工具函数 ==================== */

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

/** 构造带 setData 的页面实例 */
function createPage(cfg) {
  return {
    ...cfg,
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
}

const PODCASTS = [
  { podcastid: 'p1', title: 'All Ears English', coverUrl: 'https://oss/c1', description: 'Daily English conversations', platform: 'Apple Podcasts', episodeCount: 12, tags: [{ id: 't1', name: '日常' }, { id: 't2', name: '初级' }, { id: 't3', name: '第三标签应被裁掉' }] },
  { podcastid: 'p2', title: 'BBC 6 Minute English', coverUrl: 'https://oss/c2', description: '', platform: '', episodeCount: 0, tags: [] },
  { podcastid: 'p3', title: 'The Daily', coverUrl: 'https://oss/c3', description: 'News', platform: 'NYT', episodeCount: 300, tags: [{ id: 't4', name: '新闻' }] },
];

function searchResponse(opts) {
  const q = /q=([^&]+)/.exec(opts.url);
  const term = q ? decodeURIComponent(q[1]) : '';
  const data = term === 'empty' ? [] : PODCASTS;
  return {
    statusCode: 200,
    data: { success: true, data, query: term, total: data.length },
  };
}

/* ==================== 用例 ==================== */

(async () => {
  section('一、页面注册与初始态');
  {
    assert(typeof searchPage.onLoad === 'function', 'pages/search/search.js 已通过 Page() 注册');
    assert(searchPage.data.query === '' && searchPage.data.searched === null, '初始态：query 空、searched=null（对应 Web 无 q 参数）');
    assert(Array.isArray(searchPage.data.results) && searchPage.data.results.length === 0, '初始 results 为空数组');
    assert(searchPage.data.isSearching === false && searchPage.data.total === 0, '初始 isSearching=false、total=0');
    ['onSearchInput', 'onConfirm', 'onClear', 'doSearch', 'onOpenPodcast', 'onGoDiscover', '_chunkPairs'].forEach((m) =>
      assert(typeof searchPage[m] === 'function', `方法 ${m} 存在`));
  }

  section('二、深链 ?q= 与搜索链路（{success,data,total} 包装解包）');
  {
    requestHandler = routeAwareHandler({ '/api/podcast/search': searchResponse });
    calls.request.length = 0;
    const page = createPage(searchPage);
    page.onLoad({ q: 'daily' });
    await tick();

    assert(calls.request.length === 1, 'onLoad 带 q 立即发起一次搜索');
    const url = calls.request[0].url;
    assert(/\/api\/podcast\/search\?q=daily&limit=40$/.test(url), `请求路径含 q=daily 且 limit=40（对齐 Web limit 40）：${url}`);
    assert(page.data.searched === 'daily', 'searched 记录提交词');
    assert(page.data.isSearching === false, '搜索完成后 isSearching 复位');
    assert(page.data.results.length === 3 && page.data.total === 3, '解包 res.data 数组 + total 计数（3 条）');
    assert(page.data.results[0].topTags.length === 2 && page.data.results[0].topTags[1].name === '初级', 'topTags 裁剪前 2 个标签（Web tags.slice(0,2)）');
    assert(page.data.resultRows.length === 2 && page.data.resultRows[0].length === 2 && page.data.resultRows[1].length === 1, '3 条结果分块为 2 行双列（2+1）');
    assert(navTitles[navTitles.length - 1] === '“daily” 的搜索结果', '导航栏标题动态化（对齐 Web generateMetadata）');
  }

  section('三、输入交互：防抖 / 回车即搜 / 清空复位');
  {
    requestHandler = routeAwareHandler({ '/api/podcast/search': searchResponse });
    const page = createPage(searchPage);

    // 清空输入 → 立即回初始态，不发请求
    calls.request.length = 0;
    page.onSearchInput({ detail: { value: '   ' } });
    await tick();
    assert(page.data.searched === null && calls.request.length === 0, '输入为空白 → 复位初始态且不发请求');

    // 防抖 400ms：拦截 setTimeout 手动推进
    const realSetTimeout = global.setTimeout;
    let captured = null;
    global.setTimeout = (fn, ms) => { captured = { fn, ms }; return 1; };
    page.onSearchInput({ detail: { value: 'news' } });
    assert(captured && captured.ms === 400, '非空输入创建 400ms 防抖定时器（对齐发现页/Android）');
    assert(calls.request.length === 0, '防抖期内未发请求');
    captured.fn();
    global.setTimeout = realSetTimeout;
    await tick();
    assert(calls.request.length === 1 && page.data.searched === 'news', '定时器触发后提交搜索 news');

    // 回车（confirm）立即搜索，不等防抖
    calls.request.length = 0;
    page.onConfirm({ detail: { value: 'bbc' } });
    await tick();
    assert(calls.request.length === 1 && page.data.searched === 'bbc', 'confirm 回车立即搜索');

    // 清空按钮 → 复位 + 标题回落
    page.onClear();
    assert(page.data.query === '' && page.data.searched === null && page.data.results.length === 0, 'onClear 复位全部搜索状态');
    assert(navTitles[navTitles.length - 1] === '搜索', 'onClear 后导航栏标题回落「搜索」');
  }

  section('四、空结果 / 异常路径');
  {
    requestHandler = routeAwareHandler({ '/api/podcast/search': searchResponse });
    const page = createPage(searchPage);
    page.onConfirm({ detail: { value: 'empty' } });
    await tick();
    assert(page.data.results.length === 0 && page.data.total === 0 && page.data.searched === 'empty', '空关键词命中 → 空结果态（wxml 渲染 search-off 无结果分支）');

    // 5xx：request.js 全局 toast 一次并 reject；页面 catch 只复位不重复 toast
    requestHandler = routeAwareHandler({
      '/api/podcast/search': { statusCode: 500, data: { success: false, error: 'Internal Server Error' } },
    });
    toasts.length = 0;
    calls.request.length = 0;
    page.onConfirm({ detail: { value: 'boom' } });
    await tick();
    assert(page.data.searched === 'boom' && page.data.results.length === 0 && page.data.isSearching === false, '接口 5xx → 复位空结果态');
    assert(toasts.length === 1, '仅 request.js 全局 toast 一次，页面不重复提示');

    // 200 + data 缺失（防御分支）
    requestHandler = routeAwareHandler({
      '/api/podcast/search': { statusCode: 200, data: { success: true } },
    });
    page.onConfirm({ detail: { value: 'weird' } });
    await tick();
    assert(Array.isArray(page.data.results) && page.data.results.length === 0, '200 无 data 字段 → 防御性空数组');
  }

  section('五、卡片与空态跳转');
  {
    const page = createPage(searchPage);
    navigations.length = 0;
    switchTabs.length = 0;
    page.onOpenPodcast({ currentTarget: { dataset: { id: 'p9' } } });
    assert(navigations[0] === '/pages/podcast/podcast?id=p9', '结果卡点击 → 播客详情页');
    page.onGoDiscover();
    assert(switchTabs[0] === '/pages/discover/index', '无结果态「发现页面」→ switchTab 发现页');
  }

  section('六、发现页打通：doSearch 解包修复 + 富卡 + 全部结果入口');
  {
    requestHandler = routeAwareHandler({
      '/api/podcast/search': searchResponse,
      '/api/podcast/list': { statusCode: 200, data: [] },
      '/api/tag/list': { statusCode: 200, data: [] },
    });
    const page = createPage(discoverPage);
    await page.doSearch('daily');
    assert(Array.isArray(page.data.searchResults) && page.data.searchResults.length === 3, '发现页 doSearch 解包 {data} 数组（修复整包 setData 的 bug）');
    assert(page.data.searchResultRows.length === 2, '就地搜索结果双列分块渲染');
    assert(page.data.searchResults[0].topTags.length === 2 && page.data.searchResults[0].topTags[1].name === '初级', '发现页搜索结果预处理 topTags 前 2 个标签');

    navigations.length = 0;
    page.setData({ query: 'daily' });
    page.onOpenFullSearch();
    assert(navigations[0] === '/pages/search/search?q=daily', '「搜索 "q" 的全部结果」→ 独立搜索页深链');

    // 搜索结果区标记段（大小不一回归 + 与独立搜索页同款富卡）
    const discoverWxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    const block = discoverWxml.slice(
      discoverWxml.indexOf('搜索结果态'),
      discoverWxml.indexOf('正常浏览态')
    );
    assert(block.includes('class="grid-col" wx:for="{{item}}"'), '搜索结果卡由 grid-col（flex:1）包裹——同列等宽，修复大小不一');
    assert(block.includes('wx:if="{{item.length === 1}}"'), '奇数行补空 grid-col 占位（对齐本页其他区块）');
    assert(block.includes('result-card'), '就地搜索卡与独立搜索页同款 result-card');
    ['result-platform', 'result-title', 'result-desc', 'result-meta', 'meta-tag', 'meta-headphones'].forEach((cls) =>
      assert(block.includes(cls), `搜索卡含 ${cls}`));
    assert(block.includes('的全部结果'), '结果区底部「全部结果」入口');
  }

  section('七、WXML 文案与绑定（对齐 Web /search 逐字文案）');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/search/search.wxml'), 'utf8');
    [
      ['搜索播客', '无词标题'],
      ['在上方搜索栏输入关键词，按标题、标签和描述查找播客', '无词副标题'],
      ['根据标题、标签、描述为你找到以下播客', '有词副标题'],
      ['输入关键词开始搜索', '空态主文案'],
      ['支持按播客标题、标签和描述搜索', '空态副文案'],
      ['没有找到与', '无结果态主文案'],
      ['试试换个关键词，或浏览', '无结果态副文案'],
      ['发现页面', '无结果态链接文案'],
      ['共找到', '计数行文案'],
      ['个相关播客', '计数行文案（后半）'],
      ['搜索“日常生活”或“新闻”……', 'SearchBar 同款 placeholder（全角引号）'],
    ].forEach(([text, name]) => assert(wxml.includes(text), `WXML 含「${name}」`));
    [
      'bindconfirm="onConfirm"', 'bindinput="onSearchInput"', 'bindtap="onClear"',
      'bindtap="onGoDiscover"', 'bindtap="onOpenPodcast"', 'wx:for="{{resultRows}}"',
      'class="grid-col" wx:for="{{item}}"', 'wx:if="{{item.length === 1}}"',
      '/assets/icons/search.svg', '/assets/icons/manage-search.svg', '/assets/icons/search-off.svg',
      '/assets/icons/headphones.svg',
    ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));

    const discoverWxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    assert(discoverWxml.includes('的全部结果'), '发现页含「全部结果」入口');
    assert(!discoverWxml.includes('🔍'), '发现页搜索图标已从 emoji 升级为官方 SVG');

    // 图标资产：Material Symbols 官方 path（viewBox 0 -960 960 960）+ 烘焙色
    [['search.svg', '#a79e8a'], ['search-off.svg', '#cfc7b4'], ['manage-search.svg', '#cfc7b4']].forEach(([f, color]) => {
      const svg = fs.readFileSync(path.join(__dirname, '../assets/icons/', f), 'utf8');
      assert(svg.includes('viewBox="0 -960 960 960"') && svg.includes(`fill="${color}"`), `${f} 为官方 Material Symbols path 且烘焙设计色`);
    });
  }

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 搜索页测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
