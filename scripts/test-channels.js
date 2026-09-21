/**
 * scripts/test-channels.js — 「全部频道」页与频道链路自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），全链路驱动
 * pages/channel/all/index.js → utils/request.js → wx.request：
 * 覆盖 platform 聚合（空值过滤/计数/降序）、双列分块与奇数占位、
 * 加载/错误/空三态、重试、频道深链跳转、app.json 注册与发现页入口。
 * 另对 WXML/WXSS/图标资产做静态断言（ChannelListScreen.kt 复刻规格）。
 *
 * 运行：node scripts/test-channels.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const toasts = [];
const navigations = [];
const navTitles = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (o) => toasts.push(o.title),
  showModal: () => {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: () => {},
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

function routeAwareHandler(routes) {
  return (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[p];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

require(path.join(__dirname, '../pages/channel/all/index.js'));
require(path.join(__dirname, '../pages/channel/index.js'));
require(path.join(__dirname, '../pages/discover/index.js'));
const allPage = pageConfigs[0];
const detailPage = pageConfigs[1];
const discoverPage = pageConfigs[2];

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

// 模拟数据：5 档 BBC、3 档 CNN、1 档 NYT + 2 条无 platform（应被过滤）
const PODCASTS = [
  { podcastid: 'b1', platform: 'BBC' },
  { podcastid: 'b2', platform: 'BBC' },
  { podcastid: 'b3', platform: 'BBC' },
  { podcastid: 'b4', platform: 'BBC' },
  { podcastid: 'b5', platform: 'BBC' },
  { podcastid: 'c1', platform: 'CNN' },
  { podcastid: 'c2', platform: 'CNN' },
  { podcastid: 'c3', platform: 'CNN' },
  { podcastid: 'n1', platform: 'NYT' },
  { podcastid: 'x1', platform: '' },
  { podcastid: 'x2', platform: null },
];

/* ==================== 用例 ==================== */

(async () => {
  section('一、页面注册与初始态');
  {
    assert(typeof allPage.onLoad === 'function', 'pages/channel/all/index.js 已通过 Page() 注册');
    assert(allPage.data.isLoading === true && Array.isArray(allPage.data.channels), '初始态 isLoading=true、channels=[]');
    ['loadChannels', 'onRetry', 'onOpenChannel', '_chunkPairs'].forEach((m) =>
      assert(typeof allPage[m] === 'function', `方法 ${m} 存在`));

    const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
    assert(appJson.pages.includes('pages/channel/all/index'), 'app.json 已注册 pages/channel/all/index');
    assert(appJson.pages.includes('pages/channel/index'), 'app.json 已注册 pages/channel/index（详情占位，消除死链）');
  }

  section('二、platform 聚合（对齐 Android DiscoverViewModel）');
  {
    requestHandler = routeAwareHandler({ '/api/podcast/list': { statusCode: 200, data: PODCASTS } });
    calls.request.length = 0;
    const page = createPage(allPage);
    page.onLoad();
    await tick();

    assert(calls.request.length === 1 && /\/api\/podcast\/list$/.test(calls.request[0].url), 'onLoad 发起 GET /api/podcast/list');
    assert(page.data.isLoading === false && page.data.error === null, '加载完成复位状态');
    assert(page.data.channels.length === 3, '空 platform（null/空串）被过滤，剩 3 个频道');
    assert(page.data.channels[0].name === 'BBC' && page.data.channels[0].podcastCount === 5, 'BBC 聚合 5 档');
    assert(page.data.channels[1].name === 'CNN' && page.data.channels[1].podcastCount === 3, 'CNN 聚合 3 档');
    assert(page.data.channels.map((c) => c.podcastCount).join(',') === '5,3,1', '按节目数降序（sortedByDescending）');
    assert(page.data.channelRows.length === 2 && page.data.channelRows[1].length === 1, '3 频道分块 2 行（2+1，奇数末行）');
  }

  section('三、错误 / 空态 / 重试');
  {
    requestHandler = routeAwareHandler({
      '/api/podcast/list': { statusCode: 500, data: { success: false, error: 'Internal Server Error' } },
    });
    const page = createPage(allPage);
    page.onLoad();
    await tick();
    assert(page.data.error === 'Internal Server Error' && page.data.isLoading === false, '5xx → 错误态展示 message（wxml 渲染重试按钮）');

    requestHandler = routeAwareHandler({ '/api/podcast/list': { statusCode: 200, data: [] } });
    page.onRetry();
    await tick();
    assert(page.data.error === null && page.data.channels.length === 0, '重试成功 → 空态（EmptyBox「暂无频道」分支）');
  }

  section('四、频道深链跳转');
  {
    const page = createPage(allPage);
    navigations.length = 0;
    page.onOpenChannel({ currentTarget: { dataset: { name: 'BBC News & Sport' } } });
    assert(navigations[0] === '/pages/channel/index?name=' + encodeURIComponent('BBC News & Sport'), '卡片点击 → 频道详情页 ?name= 深链（encodeURIComponent）');

    // 详情占位页：name 解码 + 导航栏标题
    const detail = createPage(detailPage);
    detail.onLoad({ name: encodeURIComponent('CNN') });
    assert(detail.data.name === 'CNN', '占位页解码 name');
    assert(navTitles[navTitles.length - 1] === 'CNN', '占位页导航栏标题 = 频道名');
  }

  section('五、发现页入口接线');
  {
    assert(discoverPage.onViewAllChannels !== undefined, '发现页存在 onViewAllChannels');
    navigations.length = 0;
    discoverPage.onViewAllChannels();
    assert(navigations[0] === '/pages/channel/all/index', '「推荐频道 · 查看更多」→ 全部频道页');
    const discoverWxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    assert(discoverWxml.includes('查看更多') && discoverWxml.includes('bindtap="onViewAllChannels"'), '发现页「查看更多」绑定 onViewAllChannels');
  }

  section('六、WXML/WXSS 复刻规格（ChannelListScreen.kt / ChannelCard）');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/channel/all/index.wxml'), 'utf8');
    [
      '全部频道', '暂无频道', '档节目', '频道主页',
      'class="channel-name"', 'wx:if="{{item.length === 1}}"',
      '/assets/icons/computer.svg', 'bindtap="onOpenChannel"', 'data-name="{{channel.name}}"',
    ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));

    const wxss = fs.readFileSync(path.join(__dirname, '../pages/channel/all/index.wxss'), 'utf8');
    assert(wxss.includes('aspect-ratio: 1 / 1'), '方卡 aspectRatio(1f)');
    assert(wxss.includes('var(--primary-50)'), '卡底 primaryContainer=#edf7f2（=primary-50）');
    assert(wxss.includes('border-radius: 32rpx'), '圆角 16dp=32rpx');
    assert(wxss.includes('var(--primary-950)'), '文字色 onPrimaryContainer=#0a241b');
    assert(wxss.includes('opacity: 0.7'), '档节目 onPrimaryContainer 70% 透明度');
    assert(wxss.includes('justify-content: center'), '卡片内容垂直居中（verticalArrangement=Center）');
    assert(wxss.includes('text-overflow: ellipsis'), '频道名单行截断（maxLines=1 + Ellipsis）');
    assert(wxss.includes('background-color: #ffffff') && wxss.includes('var(--r-full)'), '胶囊白底 rounded-full');
    assert(wxss.includes('font-size: 44rpx'), '页标题 titleLarge=22sp');

    // 图标：经典 Material Icons filled Computer（Icons.Filled.Computer，viewBox 0 0 24 24）+ 品牌色烘焙
    const svg = fs.readFileSync(path.join(__dirname, '../assets/icons/computer.svg'), 'utf8');
    assert(svg.includes('viewBox="0 0 24 24"') && svg.includes('fill="#1f7a5c"'), 'computer.svg 为官方 filled path 且烘焙 primary 色');
  }

  section('七、频道详情页数据链路（GET /api/channel/{name}）');
  {
    // 信封数据：3 档节目 + 2 条单集（含 podcast 引用；channel 接口无 difficulty）
    const CHANNEL = {
      statusCode: 200,
      data: {
        success: true,
        data: {
          platformName: 'BBC Learning English',
          podcastCount: 3,
          topShows: [
            { podcastid: 'p1', title: '6 Minute English', coverUrl: 'https://oss/c1', platform: 'BBC Learning English', episodeCount: 62 },
            { podcastid: 'p2', title: 'The English We Speak', coverUrl: 'https://oss/c2', platform: 'BBC Learning English', episodeCount: 0 },
            { podcastid: 'p3', title: 'News Review', coverUrl: 'https://oss/c3', platform: 'BBC Learning English', episodeCount: 7 },
          ],
          topEpisodes: [
            { episodeid: 'e1', title: 'Ep 1', coverUrl: 'https://oss/ec1', duration: 139, playCount: 7, publishAt: '2026-02-01T00:00:00.000Z', podcast: { podcastid: 'p1', title: '6 Minute English', coverUrl: 'https://oss/c1' } },
            { episodeid: 'e2', title: 'Ep 2', coverUrl: null, duration: null, playCount: 0, publishAt: null, podcast: { podcastid: 'p3', title: 'News Review', coverUrl: 'https://oss/c3' } },
          ],
        },
      },
    };
    requestHandler = routeAwareHandler({
      '/api/channel/BBC%20Learning%20English': CHANNEL,
    });
    calls.request.length = 0;
    navTitles.length = 0;
    const page = createPage(detailPage);
    page.onLoad({ name: encodeURIComponent('BBC Learning English') });
    await tick();

    assert(calls.request.length === 1 && /\/api\/channel\/BBC%20Learning%20English$/.test(calls.request[0].url), 'onLoad 发起 GET /api/channel/{name}（name 已编码）');
    assert(navTitles[navTitles.length - 1] === 'BBC Learning English', '导航栏标题 = 频道名');
    assert(page.data.isLoading === false && page.data.error === null, '加载完成复位');
    assert(page.data.channel && page.data.channel.podcastCount === 3, '信封解包 channel{platformName, podcastCount}（页头「3 档播客」）');
    assert(page.data.showRows.length === 2 && page.data.showRows[1].length === 1, 'topShows 双列分块（2+1 奇数占位行）');
    assert(page.data.topEpisodes[0].podcastTitle === '6 Minute English', '单集 podcastTitle 从 podcast 引用映射');
    assert(page.data.topEpisodes[1].podcastCoverUrl === 'https://oss/c3', '单集 podcastCoverUrl 映射（封面降级链）');

    // 跳转
    navigations.length = 0;
    page.onOpenPodcast({ currentTarget: { dataset: { id: 'p1' } } });
    page.onOpenEpisode({ currentTarget: { dataset: { id: 'e1' } } });
    assert(navigations[0] === '/pages/podcast/podcast?id=p1' && navigations[1] === '/pages/episode/episode?id=e1', '热门节目→播客详情 / 热门单集→剧集详情');

    // 200 + success:false → Android IOException("加载频道失败") 口径
    requestHandler = routeAwareHandler({
      '/api/channel/x': { statusCode: 200, data: { success: false, error: 'Channel not found' } },
    });
    page.onLoad({ name: 'x' });
    await tick();
    assert(page.data.error === 'Channel not found' && page.data.isLoading === false, '信封 success:false → 错误态透传 error');

    // 404 → request.js ApiError message
    requestHandler = routeAwareHandler({
      '/api/channel/y': { statusCode: 404, data: { success: false, error: 'Channel not found' } },
    });
    page.onLoad({ name: 'y' });
    await tick();
    assert(page.data.error === 'Channel not found', 'HTTP 404 → 错误态（重试按钮渲染）');

    // retry：loadedName 复用重拉
    requestHandler = routeAwareHandler({
      '/api/channel/y': { statusCode: 200, data: { success: true, data: { platformName: 'y', podcastCount: 1, topShows: [], topEpisodes: [] } } },
    });
    calls.request.length = 0;
    page.onRetry();
    await tick();
    assert(calls.request.length === 1 && page.data.error === null && page.data.channel.podcastCount === 1, 'retry 复用 loadedName 重拉成功');
  }

  section('八、频道详情页复刻规格（ChannelScreen + 播客页 episode-row）');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/channel/index.wxml'), 'utf8');
    [
      '热门节目', '热门单集', '档播客', 'episodes',
      'class="show-eyebrow"', 'class="show-title"', 'class="show-meta"',
      'class="episode-row', 'class="ep-cover-wrap"', 'class="ep-difficulty"', 'class="ep-duration"',
      'fmt.difficultyColor', 'fmt.formatDuration', 'fmt.formatPlayCount', 'fmt.formatDate',
      '/assets/icons/headphones.svg', '/assets/icons/calendar.svg',
      '../podcast/podcast.wxs',
      'bindtap="onOpenPodcast"', 'bindtap="onOpenEpisode"',
      'wx:if="{{item.length === 1}}"', 'wx:if="{{podcast.episodeCount > 0}}"',
    ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));

    const wxss = fs.readFileSync(path.join(__dirname, '../pages/channel/index.wxss'), 'utf8');
    assert(wxss.includes('aspect-ratio: 1 / 1') && wxss.includes('border-radius: 32rpx'), '节目卡封面 1:1 + 圆角 16dp（CoverImage 默认）');
    assert(wxss.includes('text-transform: uppercase') && wxss.includes('letter-spacing: 2.8rpx'), '眉标大写 + 字距 1.4sp（EyebrowText）');
    assert(wxss.includes('-webkit-line-clamp: 2'), '节目标题 maxLines=2');
    assert(wxss.includes('width: 240rpx') && wxss.includes('height: 135rpx'), '单集封面 16:9（240×135rpx，与播客页逐字一致）');
    assert(wxss.includes('rgba(0, 0, 0, 0.6)'), '时长遮罩半透明黑底');
    assert(wxss.includes('width: 28rpx'), 'icon-xs 与播客页同值');

    // ep-* 样式与播客页逐字一致（拷贝未改）
    const podcastWxss = fs.readFileSync(path.join(__dirname, '../pages/podcast/podcast.wxss'), 'utf8');
    ['episode-row', 'ep-cover-wrap', 'ep-cover', 'ep-difficulty', 'ep-duration', 'ep-info', 'ep-series', 'ep-title'].forEach((cls) => {
      const pick = (css) => {
        const m = new RegExp('\\.' + cls.replace('-', '\\-') + ' \\{([\\s\\S]*?)\\}').exec(css);
        return m ? m[1].replace(/\s+/g, ' ').trim() : null;
      };
      assert(pick(wxss) !== null && pick(wxss) === pick(podcastWxss), `.${cls} 样式与播客页逐字一致`);
    });
  }

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 全部频道测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
