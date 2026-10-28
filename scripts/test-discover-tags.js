/**
 * scripts/test-discover-tags.js — 探索画廊（T4.2）自动化测试
 *
 * 覆盖：feed 拉取与卡片映射、搜索防抖（q 透传）、场景胶囊 toggle、
 * 专栏聚合与点击、明信片卡跳转精研室（?sceneId=）、日签海报开合、
 * 零禁用接口（episode/podcast/channels 全退役）。
 * 运行：node scripts/test-discover-tags.js
 */
const fs = require('fs');
const path = require('path');

const calls = { request: [] };
let feedPayload = null;
const navigations = [];

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: () => {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  getWindowInfo: () => ({ pixelRatio: 2 }),
  getSystemInfoSync: () => ({ pixelRatio: 2, statusBarHeight: 20, theme: 'light' }),
  getImageInfo: (o) => o.fail && o.fail({}),
  canvasToTempFilePath: (o) => o.fail && o.fail({}),
  createSelectorQuery: () => ({ in: () => ({ select: () => ({ fields: () => ({ exec: (cb) => cb([null]) }) }) }) }),
  request: (opts) => {
    calls.request.push(opts.url);
    const res = feedPayload || {
      statusCode: 200,
      data: {
        success: true,
        data: {
          page: 1, pageSize: 10, total: 0, items: [],
        },
      },
    };
    opts.success(res);
  },
};

global.Page = (cfg) => (global.__discoverCfg = cfg);

require(path.join(__dirname, '../pages/discover/index.js'));
const pageConfig = global.__discoverCfg;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
  });

  // —— A. feed 拉取与卡片映射 ——
  feedPayload = {
    statusCode: 200,
    data: {
      success: true,
      data: {
        page: 1, pageSize: 10, total: 2,
        items: [
          {
            sceneid: 's1', title: '例会上的延期', coverUrl: 'https://oss/cv1.jpg',
            situationTag: '职场', cefrLevel: 'B2', duration: 28.4, clipCount: 4,
            golden: { en: 'We need to push back the timeline.', zh: '我们需要把时间线往后推。', start: 12.5, end: 15.8 },
          },
          {
            sceneid: 's2', title: '深夜慢速独白', coverUrl: '', situationTag: '情感',
            cefrLevel: '', duration: 33, clipCount: 5,
            golden: { en: 'It is okay to feel lost.', zh: null, start: 40, end: 43 },
          },
        ],
      },
    },
  };
  page.onLoad();
  await tick();
  ok(calls.request.some((u) => u.indexOf('/api/scenes/feed') !== -1), 'A 首载请求 /api/scenes/feed');
  ok(calls.request.every((u) => !u.includes('/api/podcast/') && !u.includes('/api/episode/') && !u.includes('/api/channels')),
    'A 零禁用接口（节目/剧集/频道全退役）');
  ok(page.data.cards.length === 2, 'A 卡片 2 张');
  const c1 = page.data.cards[0];
  ok(c1.sceneid === 's1' && c1.en.indexOf('push back') !== -1 && c1.durText === '28s' && c1.start === 12.5,
    'A 卡片映射：金句/时长/窗口秒（WXML 零方法调用）');
  ok(page.data.columns.length === 2 && page.data.columns[0].name === '职场' && page.data.columns[0].sceneCount === 1,
    'A 专栏聚合：situationTag 计数');
  ok(page.data.noMore === true && page.data.total === 2, 'A 分页态：total/noMore');

  // —— B. 卡片跳转精研室（?sceneId= 微剧场模式） ——
  navigations.length = 0;
  page.onCardTap({ currentTarget: { dataset: { scene: 's1' } } });
  ok(navigations[0] === '/pages/intensive-listening/index?sceneId=s1', 'B 明信片卡 → 精研室微剧场模式');

  // —— C. 搜索防抖（q 透传；清空恢复） ——
  calls.request.length = 0;
  page.onSearchInput({ detail: { value: '委婉' } });
  ok(calls.request.length === 0, 'C 防抖窗口内零请求');
  await new Promise((r) => setTimeout(r, 450));
  ok(calls.request.some((u) => u.indexOf('q=' + encodeURIComponent('委婉')) !== -1), 'C 防抖到期带 q 请求');
  calls.request.length = 0;
  page.onClearSearch();
  await tick();
  ok(calls.request.some((u) => u.indexOf('q=') === -1), 'C 清空搜索恢复全量');

  // —— D. 场景胶囊 toggle ——
  calls.request.length = 0;
  page.onChipTap({ currentTarget: { dataset: { key: '职场' } } });
  await tick();
  ok(page.data.activeTag === '职场' && calls.request.some((u) => u.indexOf('tag=') !== -1), 'D 胶囊选中带 tag 请求');
  page.onChipTap({ currentTarget: { dataset: { key: '职场' } } });
  await tick();
  ok(page.data.activeTag === '' && !calls.request[calls.request.length - 1].includes('tag='), 'D 再点同胶囊取消筛选');

  // —— E. 专栏点击 → 胶囊筛选 ——
  page.onColumnTap({ currentTarget: { dataset: { name: '情感' } } });
  await tick();
  ok(page.data.activeTag === '情感', 'E 专栏点击 → 对应标签筛选');

  // —— F. 日签海报开合（canvas 环境缺失时静默降级） ——
  page.onPosterOpen({ currentTarget: { dataset: { scene: 's1' } } });
  ok(page.data.poster && page.data.poster.sceneid === 's1' && page.data.poster.en.indexOf('push back') !== -1,
    'F 打开日签弹层（携带封面与金句）');
  page.onPosterReady(); // canvas 探测失败 → 不抛错
  page.onPosterClose();
  ok(page.data.poster === null, 'F 关闭弹层');

  // —— G. WXML 结构红线 ——
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
  ok(wxml.includes('sentence-micro-player') && wxml.includes('clip-id="{{item.sceneid}}"'),
    'G 微播放器走 sceneid 切片直连（零整集）');
  ok(wxml.includes('日签') && wxml.includes('poster-canvas'), 'G 日签海报按钮与画布');
  ok(wxml.includes('主题专栏') && wxml.includes('今日声音明信片'), 'G 双区块：专栏 + 明信片');

  console.log('----------------------------------------');
  if (failed === 0) {
    console.log('ALL DISCOVER GALLERY TESTS PASSED');
  } else {
    console.error(failed + ' TEST(S) FAILED');
    process.exitCode = 1;
  }
})();
