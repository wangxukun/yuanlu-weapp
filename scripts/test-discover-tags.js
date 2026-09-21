/**
 * scripts/test-discover-tags.js — 发现页「分类标签」筛选修复回归测试
 *
 * 根因（2026-09-21 实测线上）：标签行数据源原为 GET /api/tag/list（标签全库，
 * 课程/语法型），与播客实际挂的标签交集≈0（20 个仅 1 个命中），点击 19/20
 * 个标签过滤结果恒为空——Android 端 FilterChip 同款失效。修复：标签行改由
 * /api/podcast/list 返回的播客 tags 派生（按命中数降序），保证每个 chip 至少
 * 命中 1 档；过滤逻辑（id 精确匹配 + toggle 取消）不变。
 *
 * 运行：node scripts/test-discover-tags.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: () => {},
  navigateTo: () => {},
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__discoverCfg = cfg);

function routeAwareHandler(routes) {
  return (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[p];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

require(path.join(__dirname, '../pages/discover/index.js'));
const pageConfig = global.__discoverCfg;

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

function createPage(cfg) {
  return {
    ...cfg,
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
}

// 播客列表：标签 A(101 日常)×3、B(102 新闻)×2、C(103 文化)×1、无标签×2
const PODCASTS = [
  { podcastid: 'p1', title: 'A1', platform: 'X', tags: [{ id: 101, name: '日常' }] },
  { podcastid: 'p2', title: 'A2', platform: 'X', tags: [{ id: 101, name: '日常' }] },
  { podcastid: 'p3', title: 'A3', platform: 'X', tags: [{ id: 101, name: '日常' }, { id: 102, name: '新闻' }] },
  { podcastid: 'p4', title: 'B1', platform: 'Y', tags: [{ id: 102, name: '新闻' }] },
  { podcastid: 'p5', title: 'C1', platform: 'Y', tags: [{ id: 103, name: '文化' }] },
  { podcastid: 'p6', title: 'D1', platform: 'Y', tags: [] },
  { podcastid: 'p7', title: 'D2', platform: 'Y', tags: null },
];

// 旧数据源：标签全库（含大量与播客无关联的 id，模拟线上 20 个仅 1 命中的实况）
const TAG_LIBRARY = [
  { id: 900, name: 'Be动词' },
  { id: 901, name: 'A2' },
  { id: 101, name: '日常' },
  { id: 902, name: '一般现在时' },
];

/* ==================== 用例 ==================== */

(async () => {
  section('一、标签行改为播客标签派生（不再依赖 /api/tag/list）');
  {
    requestHandler = routeAwareHandler({
      '/api/podcast/list': { statusCode: 200, data: PODCASTS },
      '/api/tag/list': { statusCode: 200, data: TAG_LIBRARY },
    });
    calls.request.length = 0;
    const page = createPage(pageConfig);
    await page.loadData();

    const requested = calls.request.map((o) => o.url.split('?')[0].replace(/^https?:\/\/[^/]+/, ''));
    assert(!requested.includes('/api/tag/list'), '不再请求 /api/tag/list（标签全库数据源废弃）');
    assert(page.data.tags.length === 3, '派生标签 = 播客实际挂的 3 种（101/102/103）');
    assert(page.data.tags.map((t) => t.id).join(',') === '101,102,103', '按命中播客数降序（3,2,1）');
    assert(!page.data.tags.some((t) => t.id === 900 || t.id === 902), '标签全库中无播客关联的条目（Be动词等）不再出现');
  }

  section('二、验收红线：每个标签 chip 点击必有命中');
  {
    requestHandler = routeAwareHandler({
      '/api/podcast/list': { statusCode: 200, data: PODCASTS },
    });
    const page = createPage(pageConfig);
    await page.loadData();

    let allHit = true;
    page.data.tags.forEach((t) => {
      page.onSelectTag({ currentTarget: { dataset: { id: t.id } } });
      if (!(page.data.filteredPodcasts.length >= 1)) allHit = false;
    });
    assert(allHit, `全部 ${page.data.tags.length} 个标签点击后 filteredPodcasts ≥ 1（修复前 19/20 恒为空）`);

    page.onSelectTag({ currentTarget: { dataset: { id: 101 } } });
    assert(page.data.filteredPodcasts.length === 3 && page.data.filteredPodcasts.every((p) => p.tags.some((t) => t.id === 101)), '「日常」过滤出 3 档且均挂该标签');
    assert(page.data.selectedTagName === '日常', '区头标题 = 选中标签名（修复前恒显示 tags[0].name）');
    assert(page.data.filteredRows.length === 2 && page.data.filteredRows[1].length === 1, '过滤结果双列分块（2+1）');
  }

  section('三、toggle 与复位');
  {
    const page = createPage(pageConfig);
    requestHandler = routeAwareHandler({ '/api/podcast/list': { statusCode: 200, data: PODCASTS } });
    await page.loadData();

    page.onSelectTag({ currentTarget: { dataset: { id: 102 } } });
    assert(page.data.selectedTagId === 102 && page.data.filteredPodcasts.length === 2, '选中「新闻」→ 2 档');
    page.onSelectTag({ currentTarget: { dataset: { id: 102 } } });
    assert(page.data.selectedTagId === null && page.data.filteredPodcasts.length === 7, '再点同标签取消 → 复位全部 7 档（Android toggle 语义）');
    assert(page.data.selectedTagName === '', '取消后区头标题回落「全部播客」');

    page.onSelectTag({ currentTarget: { dataset: { id: 103 } } });
    page.onSelectTag({ currentTarget: { dataset: { id: '' } } }); // 「全部」chip
    assert(page.data.selectedTagId === null && page.data.filteredPodcasts.length === 7, '点「全部」chip 复位');
  }

  section('四、WXML 绑定');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    assert(wxml.includes('{{selectedTagName || \'全部播客\'}}'), '区头标题绑定 selectedTagName');
    assert(wxml.includes('bindtap="onSelectTag" data-id="{{item.id}}"'), '标签 chip 绑定 onSelectTag + data-id');
    assert(wxml.includes('selectedTagId === item.id ? \'active\''), '选中态高亮绑定保留');
  }

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 发现页标签筛选测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
