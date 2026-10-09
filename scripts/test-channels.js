/**
 * scripts/test-channels.js — 「全部频道」页与频道链路自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page），全链路驱动
 * pages/channel/all/index.js → utils/channels.js → utils/request.js → wx.request：
 * GET /api/channels 信封解包（封面/总集数/档数）、双列分块与奇数占位、
 * 加载/错误/空三态、重试、频道深链跳转（channel-card 组件 open 事件口径）、
 * app.json 注册与发现页入口（含推荐频道模块软失败口径）。
 * 另对页面/组件 WXML/WXSS 与图标资产做静态断言（Web ChannelCard.tsx 复刻规格）。
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

// utils/channels 直接驱动（信封解包单测）
const { fetchChannels } = require(path.join(__dirname, '../utils/channels.js'));

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

// /api/channels 信封数据：3 频道（服务端已按 channel.sortOrder + 播放量排序、
// 封面已解析为签名 URL），与 Web discover-service.getRecommendedChannels 同口径
function channelsEnvelope(list) {
  return {
    statusCode: 200,
    data: { success: true, data: list },
  };
}
const CHANNELS = [
  { name: 'BBC Learning English', coverUrl: 'https://oss/signed-banner.jpg?sig=1', podcastCount: 9, episodeCount: 416, totalPlays: 12000 },
  { name: 'CNN 10', coverUrl: 'default_cover_url', podcastCount: 3, episodeCount: 158400, totalPlays: 800 },
  { name: 'NHK World', coverUrl: 'https://oss/signed-nhk.jpg?sig=2', podcastCount: 2, episodeCount: 980, totalPlays: 300 },
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
    assert(appJson.pages.includes('pages/channel/index'), 'app.json 已注册 pages/channel/index（详情深链目标）');
  }

  section('二、GET /api/channels 信封解包（Web getRecommendedChannels 公开口径）');
  {
    requestHandler = routeAwareHandler({ '/api/channels': channelsEnvelope(CHANNELS) });
    calls.request.length = 0;
    const page = createPage(allPage);
    page.onLoad();
    await tick();

    assert(calls.request.length === 1 && /\/api\/channels$/.test(calls.request[0].url), 'onLoad 发起 GET /api/channels（不再客户端聚合 /api/podcast/list）');
    assert(page.data.isLoading === false && page.data.error === null, '加载完成复位状态');
    assert(page.data.channels.length === 3, '信封 data 数组解包为 3 频道');
    assert(
      page.data.channels[0].name === 'BBC Learning English' &&
        page.data.channels[0].coverUrl === 'https://oss/signed-banner.jpg?sig=1' &&
        page.data.channels[0].episodeCount === 416 &&
        page.data.channels[0].podcastCount === 9,
      '频道字段透传（name/coverUrl/podcastCount/episodeCount）'
    );
    assert(page.data.channelRows.length === 2 && page.data.channelRows[1].length === 1, '3 频道分块 2 行（2+1，奇数末行占位）');

    // utils/channels 信封异常口径
    requestHandler = routeAwareHandler({ '/api/channels': { statusCode: 200, data: { success: false, error: 'Channel service down' } } });
    let err = null;
    await fetchChannels().catch((e) => (err = e));
    assert(err && err.message === 'Channel service down', 'success:false → 抛信封 error（页面错误态）');

    requestHandler = routeAwareHandler({ '/api/channels': { statusCode: 200, data: { success: true } } });
    err = null;
    await fetchChannels().catch((e) => (err = e));
    assert(err && err.message === '加载频道失败', 'data 非数组 → 兜底文案');
  }

  section('三、错误 / 空态 / 重试');
  {
    requestHandler = routeAwareHandler({
      '/api/channels': { statusCode: 500, data: { success: false, error: 'Internal Server Error' } },
    });
    const page = createPage(allPage);
    page.onLoad();
    await tick();
    assert(page.data.error === 'Internal Server Error' && page.data.isLoading === false, '5xx → 错误态展示 message（wxml 渲染重试按钮）');

    requestHandler = routeAwareHandler({ '/api/channels': channelsEnvelope([]) });
    page.onRetry();
    await tick();
    assert(page.data.error === null && page.data.channels.length === 0, '重试成功 → 空态（「暂无频道」分支）');
  }

  section('四、频道深链跳转（channel-card open 事件口径）');
  {
    const page = createPage(allPage);
    navigations.length = 0;
    page.onOpenChannel({ detail: { name: 'BBC News & Sport' } });
    assert(navigations[0] === '/pages/channel/index?name=' + encodeURIComponent('BBC News & Sport'), '卡片 open 事件 e.detail.name → 频道详情页 ?name= 深链（encodeURIComponent）');
    assert(page.onOpenChannel({ detail: {} }) === undefined, '无 name 静默忽略（不跳转）');

    // 详情占位页：name 解码 + 导航栏标题
    const detail = createPage(detailPage);
    detail.onLoad({ name: encodeURIComponent('CNN') });
    assert(detail.data.name === 'CNN', '占位页解码 name');
    assert(navTitles[navTitles.length - 1] === 'CNN', '占位页导航栏标题 = 频道名');
  }

  section('五、发现页入口与推荐频道模块（/api/channels 同源 + 软失败）');
  {
    assert(discoverPage.onViewAllChannels !== undefined, '发现页存在 onViewAllChannels');
    navigations.length = 0;
    discoverPage.onViewAllChannels();
    assert(navigations[0] === '/pages/channel/all/index', '「推荐频道 · 查看更多」→ 全部频道页');
    const discoverWxml = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    assert(discoverWxml.includes('查看更多') && discoverWxml.includes('bindtap="onViewAllChannels"'), '发现页「查看更多」绑定 onViewAllChannels');

    // 推荐频道模块：与全部频道同源（/api/channels），含封面/集数；双列分块
    requestHandler = routeAwareHandler({
      '/api/podcast/list': { statusCode: 200, data: [{ podcastid: 'p1', platform: 'BBC' }] },
      '/api/channels': channelsEnvelope(CHANNELS),
    });
    const page = createPage(discoverPage);
    await page.loadData();
    assert(page.data.channels.length === 3 && page.data.channels[0].episodeCount === 416, '发现页推荐频道来自 /api/channels（封面/总集数字段齐备）');
    assert(page.data.channelRows.length === 2 && page.data.channelRows[0].length === 2, '推荐频道双列分块（每行两个）');

    // 软失败：/api/channels 异常不阻断发现页其余区块
    requestHandler = routeAwareHandler({
      '/api/podcast/list': { statusCode: 200, data: [{ podcastid: 'p1', platform: 'BBC' }] },
      '/api/channels': { statusCode: 500, data: { success: false, error: 'boom' } },
    });
    const page2 = createPage(discoverPage);
    await page2.loadData();
    assert(page2.data.error === null && page2.data.channels.length === 0, '频道接口失败 → 软失败（整页正常、推荐频道模块隐藏）');
  }

  section('六、WXML/WXSS 复刻规格（Web ChannelCard.tsx / discover/channels 页）');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/channel/all/index.wxml'), 'utf8');
    [
      '全部频道', '暂无频道', 'channel-card',
      'channel="{{channel}}"', 'bind:open="onOpenChannel"',
      'wx:if="{{item.length === 1}}"', 'wx:key="name"',
    ].forEach((frag) => assert(wxml.includes(frag), `全部频道 WXML 含 ${frag}`));
    assert(!wxml.includes('频道主页') && !wxml.includes('computer.svg'), '旧版「频道主页」胶囊/computer 图标已废弃');

    const discoverWxml2 = fs.readFileSync(path.join(__dirname, '../pages/discover/index.wxml'), 'utf8');
    assert(discoverWxml2.includes('<channel-card channel="{{channel}}" bind:open="onOpenChannel" />'), '发现页推荐频道渲染 channel-card 组件');
    assert(!discoverWxml2.includes('频道主页'), '发现页旧版「频道主页」按钮已废弃');

    const wxss = fs.readFileSync(path.join(__dirname, '../pages/channel/all/index.wxss'), 'utf8');
    assert(wxss.includes('display: flex') && wxss.includes('gap: 24rpx'), '双列网格保留（每行两个，12dp 间距）');
    assert(!wxss.includes('aspect-ratio: 1 / 1') && !wxss.includes('var(--primary-950)'), '旧版 1:1 绿底方卡样式已废弃删除');

    // 组件与页面 json 注册
    const allJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/channel/all/index.json'), 'utf8'));
    const discoverJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../pages/discover/index.json'), 'utf8'));
    assert(allJson.usingComponents['channel-card'] === '/components/common/channel-card/index', '全部频道页注册 channel-card 组件');
    assert(discoverJson.usingComponents['channel-card'] === '/components/common/channel-card/index', '发现页注册 channel-card 组件');

    const compJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../components/common/channel-card/index.json'), 'utf8'));
    assert(compJson.component === true, 'components/common/channel-card 组件声明 component:true');
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
      '/assets/icons/headset.svg', '/assets/icons/date-range.svg',
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
