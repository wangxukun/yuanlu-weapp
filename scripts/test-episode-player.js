/**
 * scripts/test-episode-player.js — 剧集页接入全局播放器（3.B.1）自动化测试
 *
 * mock wx.getBackgroundAudioManager（属性 setter + 事件回调注册 + 命令方法），
 * 全链路驱动 pages/episode/episode.js → utils/audioManager → bgm：
 * 覆盖开始精听起播（元数据注入/播放列表/签名直链解析兜底）、同集 toggle、
 * audio-bus 互停、进度拖拽 seek、快退快进、倍速循环切换、timeupdate 刷新
 * 与拖动期不回弹、ended 自动连播、WXML 控件绑定与文案。
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
  { episodeid: 'ep2', title: 'Episode Two', coverUrl: 'https://oss/cover2', audioUrl: 'https://oss/audio2.m4a', podcastTitle: 'Test Podcast', duration: 500 },
  { episodeid: 'ep3', title: 'Episode Three', coverUrl: 'https://oss/cover3', audioUrl: 'https://oss/audio3.m4a', podcastTitle: 'Test Podcast', duration: 400 },
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
    assert(page.data.player.hasEpisode === true, '页内控制卡渲染（player.hasEpisode）');
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

  section('四、进度：timeupdate / 拖拽 seek / 快退快进');
  {
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();

    bgm.currentTime = 100;
    bgm.duration = 600;
    bgmHandlers.timeupdate();
    assert(page.data.player.currentTime === 100 && page.data.player.duration === 600, 'timeupdate → 控制卡时间/时长刷新');

    page.onSeekChanging({ detail: { value: 250 } });
    assert(page.data.isSeeking === true && page.data.dragTime === 250, '拖动中记录拖动值');
    bgm.currentTime = 101;
    bgmHandlers.timeupdate();
    assert(page.data.player.currentTime === 100, '拖动中不追 timeupdate（避免进度回弹）');
    page.onSeekChanged({ detail: { value: 250 } });
    assert(bgmCalls.seeks[bgmCalls.seeks.length - 1] === 250 && page.data.isSeeking === false, '松手 seek(250) 并退出拖动态');

    page.onForward30();
    assert(bgmCalls.seeks[bgmCalls.seeks.length - 1] === 280, '快进 30s（250+30）');
    page.onBackward15();
    assert(bgmCalls.seeks[bgmCalls.seeks.length - 1] === 265, '快退 15s（280-15）');
  }

  section('五、倍速与循环模式（Web cyclePlaybackRate / cyclePlayMode 同序）');
  {
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();

    const rates = [];
    for (let i = 0; i < 5; i++) {
      page.onCycleRate();
      rates.push(audioManager.getState().playbackRate);
    }
    assert(rates.join(',') === '1.25,1.5,2,0.75,1', '倍速循环 1→1.25→1.5→2→0.75→1');
    assert(page.data.rateLabel === '1x', '控制卡倍速文案 = 1x');

    page.onCycleMode();
    assert(audioManager.getState().loopMode === 'all', '循环模式：none → all');
    page.onCycleMode();
    assert(audioManager.getState().loopMode === 'one', '循环模式：all → one');
    page.onCycleMode();
    assert(audioManager.getState().isShuffle === true && audioManager.getState().loopMode === 'one', '循环模式：one → 随机（loopMode 保持 one，audioManager 行为）');
    assert(page.data.player.isShuffle === true, 'modeChange 事件同步控制卡');
    page.onCycleMode();
    assert(audioManager.getState().isShuffle === false && audioManager.getState().loopMode === 'none', '循环模式：随机 → 复位不循环');
  }

  section('六、ended 自动连播与上下首');
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
    assert(page.data.player.currentEpisode && page.data.player.currentEpisode.episodeid === 'ep2', 'episodeChange → 控制卡标题跟随播放事实源');
    assert(page.data.isCurrentPlaying === false, '他集（ep2）在播而本页是 ep1 → isCurrentPlaying=false（按钮回到「开始精听」态）');

    page.onPrevEpisode();
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep1', '上一首回到 ep1');
    page.onNextEpisode();
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep2', '下一首切 ep2');
  }

  section('七、WXML 控件绑定与文案');
  {
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.wxml'), 'utf8');
    [
      'bindtap="onStartListening"', 'bindtap="onTogglePlay"', 'bindtap="onPrevEpisode"', 'bindtap="onNextEpisode"',
      'bindtap="onBackward15"', 'bindtap="onForward30"', 'bindchanging="onSeekChanging"', 'bindchange="onSeekChanged"',
      'bindtap="onCycleRate"', 'bindtap="onCycleMode"',
      'pause-primary.svg', 'play-primary.svg', 'skip-next.svg', 'skip-previous.svg',
      'replay.svg', 'forward.svg', 'repeat.svg', 'repeat-one-active.svg', 'shuffle-active.svg',
      '暂停精听', '开始精听', 'wx:if="{{player.hasEpisode}}"',
      "src=\"{{isCurrentPlaying ? '/assets/icons/pause-filled.svg' : '/assets/icons/play-filled.svg'}}\"",
    ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));
    assert((wxml.match(/isCurrentPlaying \?/g) || []).length >= 3, '播放/暂停图标与文案三处均随 isCurrentPlaying 幂等切换（主按钮图标/文案 + 封面播放钮）');
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
