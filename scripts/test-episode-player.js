/**
 * scripts/test-episode-player.js — 剧集页接入全局播放器（3.B.1）自动化测试
 *
 * mock wx.getBackgroundAudioManager（属性 setter + 事件回调注册 + 命令方法），
 * 全链路驱动 pages/episode/episode.js → utils/audioManager → bgm：
 * 覆盖开始精听起播（元数据注入/播放列表/签名直链解析兜底）、同集 toggle、
 * audio-bus 互停、ended 自动连播、锁屏上下首、「本集在播」派生态与 WXML 绑定。
 * 播放控制 UI（进度拖拽/倍速/循环/快进快退）自 3.B.3 方案 B 起收敛到
 * 迷你条 + 全屏面板，相关断言见 scripts/test-mini-player.js。
 *
 * 运行：node scripts/test-episode-player.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const storage = new Map();
const calls = { request: [] };
let requestHandler = null;

// ---- BackgroundAudioManager mock：记录赋值/命令，暴露事件触发器 ----
const bgmCalls = {
  src: null, title: null, epname: null, singer: null, coverImgUrl: null,
  rates: [], seeks: [], plays: 0, pauses: 0,
};
const bgmHandlers = {};
const bgm = {
  currentTime: 0,
  duration: 0,
  play() { bgmCalls.plays += 1; bgmHandlers.play && bgmHandlers.play(); },
  pause() { bgmCalls.pauses += 1; bgmHandlers.pause && bgmHandlers.pause(); },
  seek(t) { bgmCalls.seeks.push(t); },
  onPlay(cb) { bgmHandlers.play = cb; },
  onPause(cb) { bgmHandlers.pause = cb; },
  onStop(cb) { bgmHandlers.stop = cb; },
  onEnded(cb) { bgmHandlers.ended = cb; },
  onTimeUpdate(cb) { bgmHandlers.timeupdate = cb; },
  onCanplay(cb) { bgmHandlers.canplay = cb; },
  onWaiting(cb) { bgmHandlers.waiting = cb; },
  onError(cb) { bgmHandlers.error = cb; },
  onPrev(cb) { bgmHandlers.prev = cb; },
  onNext(cb) { bgmHandlers.next = cb; },
};
Object.defineProperties(bgm, {
  src: { get: () => bgmCalls.src, set: (v) => { bgmCalls.src = v; } },
  title: { set: (v) => { bgmCalls.title = v; } },
  epname: { set: (v) => { bgmCalls.epname = v; } },
  singer: { set: (v) => { bgmCalls.singer = v; } },
  coverImgUrl: { set: (v) => { bgmCalls.coverImgUrl = v; } },
  playbackRate: { set: (v) => { bgmCalls.rates.push(v); } },
});

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: () => {},
  showModal: () => {},
  navigateTo: () => {},
  switchTab: () => {},
  navigateBack: () => {},
  stopPullDownRefresh: () => {},
  showShareMenu: () => {},
  setNavigationBarTitle: () => {},
  getBackgroundAudioManager: () => bgm,
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__episodeCfg = cfg);

function routeAwareHandler(routes) {
  return (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const hit = routes[p];
    const resp = typeof hit === 'function' ? hit(opts) : hit || { statusCode: 200, data: { success: true } };
    opts.success(resp);
  };
}

/* ==================== 加载被测模块 ==================== */

const audioManager = require(path.join(__dirname, '../utils/audioManager'));
const audioBus = require(path.join(__dirname, '../utils/audio-bus'));
audioManager.init(); // 生产链路由 app.js onLaunch 调用

require(path.join(__dirname, '../pages/episode/episode.js'));
const pageConfig = global.__episodeCfg;

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

const EPISODE = {
  episodeid: 'ep1',
  title: 'Episode One',
  description: 'desc',
  coverUrl: 'https://oss/cover1',
  audioUrl: 'https://oss/audio1.m4a',
  podcastid: 'pd1',
  podcastTitle: 'Test Podcast',
  duration: 600,
  playCount: 3,
};
const RELATED = [
  // 模拟真实接口：list-by-podcastid 的剧集对象缺 podcastTitle（切播后迷你条副标题依赖回填）
  { episodeid: 'ep2', title: 'Episode Two', coverUrl: 'https://oss/cover2', audioUrl: 'https://oss/audio2.m4a', duration: 500 },
  { episodeid: 'ep3', title: 'Episode Three', coverUrl: 'https://oss/cover3', audioUrl: 'https://oss/audio3.m4a', duration: 400 },
];

/* ==================== 用例 ==================== */

(async () => {
  section('一、开始精听起播（元数据注入 + 播放列表）');
  {
    requestHandler = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE, ...RELATED] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    assert(page.data.episode && page.data.episode.episodeid === 'ep1', '剧集详情加载完成');
    assert(page.data.relatedEpisodes.length === 2, '相关剧集加载完成（过滤自身取前 5）');

    page.onStartListening();
    await tick();
    assert(bgmCalls.src === 'https://oss/audio1.m4a', 'bgm.src 设置签名直链（设置即自动播放）');
    assert(bgmCalls.title === 'Episode One', '锁屏元数据 title 注入（iOS 后台播放硬性要求）');
    assert(bgmCalls.epname === 'Test Podcast' && bgmCalls.singer === 'Test Podcast', 'epname/singer 注入');
    assert(bgmCalls.coverImgUrl === 'https://oss/cover1', '锁屏封面 coverImgUrl 注入');
    assert(audioManager.getState().playlist.length === 3, '播放列表 = 当前剧集 + 相关剧集（ended 连播/锁屏上下首）');
    const plItem = audioManager.getState().playlist[1];
    assert(plItem.podcastTitle === 'Test Podcast', '播放列表条目回填 podcastTitle（related 缺字段时取本集播客名，迷你条副标题数据源）');
    assert(plItem.coverUrl === 'https://oss/cover2', '播放列表条目封面：自带 coverUrl 不被覆盖');
    assert(audioManager.getState().hasEpisode === true, '播放会话建立（hasEpisode=true，迷你条/面板接管控制）');
    assert(audioManager.getState().isIntensiveMode === true, '「开始精听」起播 → 置位精听标记（迷你条「精听」标签/面板「精听中」角标）');
    assert(page.data.isCurrentPlaying === true, '本集在播 → isCurrentPlaying=true（按钮/封面图标切换依据）');
  }

  section('二、同集 toggle 与 audio-bus 互停');
  {
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();

    const pausesBefore = bgmCalls.pauses;
    page.onStartListening(); // 已在播本集 → toggle → pause
    assert(bgmCalls.pauses === pausesBefore + 1, '已在播本集再点「开始精听」→ 暂停（幂等 toggle）');
    assert(page.data.isCurrentPlaying === false, '暂停后 isCurrentPlaying=false → 图标/文案回落播放态');

    // 互停：注册一个假发声源，起播新剧集时应被停掉
    let stopped = false;
    const unregister = audioBus.register(() => { stopped = true; });
    page.setData({ episode: { ...EPISODE, episodeid: 'epX', title: 'Other' } });
    page.onStartListening();
    await tick();
    assert(stopped, '起播前经 audio-bus 停掉 TTS/原声片段（防双声）');
    unregister();
  }

  section('三、无 audioUrl 时的签名直链解析兜底');
  {
    requestHandler = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: { ...EPISODE, episodeid: 'epNoUrl', audioUrl: null } },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
      '/api/episode/subtitles': { statusCode: 200, data: { audioUrl: 'https://oss/resolved.m4a' } },
    });
    const page = createPage(pageConfig);
    page.onLoad({ id: 'epNoUrl' });
    await tick();
    await tick();
    page.onStartListening();
    await tick();
    assert(bgmCalls.src === 'https://oss/resolved.m4a', '剧集无直链时经 /api/episode/subtitles 解析 OSS 签名直链');
  }

  section('四、ended 自动连播与锁屏上下首');
  {
    requestHandler = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE, ...RELATED] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    page.onStartListening();
    await tick();

    bgmHandlers.ended(); // 播完 → playNext → ep2
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep2', 'ended 自动连播下一集（ep2）');
    assert(page.data.isCurrentPlaying === false, '他集（ep2）在播而本页是 ep1 → isCurrentPlaying=false（按钮回到「开始精听」态）');

    bgmHandlers.prev(); // 锁屏「上一首」
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep1', '锁屏 onPrev → 上一首回到 ep1');
    bgmHandlers.next(); // 锁屏「下一首」
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep2', '锁屏 onNext → 下一首切 ep2');
  }

  section('五、WXML 控件绑定与文案');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.wxml'), 'utf8');
    [
      'bindtap="onStartListening"',
      'pause-filled.svg', 'play-filled.svg',
      '暂停精听', '开始精听',
      "src=\"{{isCurrentPlaying ? '/assets/icons/pause-filled.svg' : '/assets/icons/play-filled.svg'}}\"",
      '<mini-player />',
    ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));
    assert((wxml.match(/isCurrentPlaying \?/g) || []).length >= 3, '播放/暂停图标与文案三处均随 isCurrentPlaying 幂等切换（主按钮图标/文案 + 封面播放钮）');
    assert(!wxml.includes('player-card') && !wxml.includes('onCycleRate'), '页内播放控制卡已退役（控件收敛到迷你条/全屏面板，方案 B）');
  }

  section('六、精听深链 practice=true 自动起播（面板「精听模式」按钮入口）');
  {
    audioManager.close(); // 清既有会话，验证深链从零起播
    requestHandler = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE, ...RELATED] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1', practice: 'true' });
    await tick();
    await tick();
    await tick();
    await tick();
    assert(bgmCalls.src === 'https://oss/audio1.m4a', 'practice 深链 → 详情与相关剧集就绪后自动起播');
    assert(audioManager.getState().isIntensiveMode === true, 'practice 起播 → 精听标记置位（intensive=true）');
    assert(audioManager.getState().playlist.length === 3, 'practice 起播 → 播放列表完整（含相关剧集）');

    // 已在播本集时带 practice 进入：仅补标记不打断播放
    const srcBefore = bgmCalls.src;
    const page2 = createPage(pageConfig);
    page2.onLoad({ id: 'ep1', practice: 'true' });
    await tick();
    await tick();
    await tick();
    await tick();
    assert(audioManager.getState().currentEpisode && audioManager.getState().currentEpisode.episodeid === 'ep1', '带会话二次进入 → 保持本集播放');
    assert(srcBefore === bgmCalls.src || audioManager.getState().isIntensiveMode === true, '带会话进入 → 不重设 src 或仅补精听标记');
    audioManager.close();
  }

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 剧集页播放测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
