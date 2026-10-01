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
  showActionSheet: () => {},
  shareFileMessage: () => {},
  getBackgroundAudioManager: () => bgm,
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
};

global.Page = (cfg) => (global.__episodeCfg = cfg);

/* ==================== download-manager 桩（T3.3 页面逻辑测试） ====================
 * 模块本体（真实 fs/downloadFile 语义）由 scripts/test-download-manager.js 42 断言全覆盖；
 * 此处注入 require.cache 桩隔离页面逻辑：事件广播/缓存集/失败模式可控。 */
const dmState = { cached: new Set(), mode: 'ok', dlCalls: [], removes: [], touches: [], sheets: [], sheetResult: null, subs: [], resolveSlow: null, entrySize: null };
const fakeDm = {
  AUDIO_DIR: 'wxfile://usr/audio',
  download(ep) {
    dmState.dlCalls.push(ep.episodeid);
    if (dmState.mode === 'fail') {
      fakeDm._emit({ type: 'error', episodeid: ep.episodeid, error: '下载失败（HTTP 403）' });
      return Promise.reject(new Error('下载失败（HTTP 403）'));
    }
    if (dmState.mode === 'slow') {
      // 挂起下载：留出 progress 事件注入窗口，由用例 resolveSlow() 释放
      return new Promise((resolve) => {
        dmState.resolveSlow = () => {
          dmState.cached.add(ep.episodeid);
          fakeDm._emit({ type: 'downloaded', episodeid: ep.episodeid, path: `wxfile://usr/audio/${ep.episodeid}.m4a` });
          resolve(`wxfile://usr/audio/${ep.episodeid}.m4a`);
        };
      });
    }
    dmState.cached.add(ep.episodeid);
    fakeDm._emit({ type: 'downloaded', episodeid: ep.episodeid, path: `wxfile://usr/audio/${ep.episodeid}.m4a` });
    return Promise.resolve(`wxfile://usr/audio/${ep.episodeid}.m4a`);
  },
  getCachedPath: (id) => (dmState.cached.has(id) ? `wxfile://usr/audio/${id}.m4a` : null),
  getEntry: (id) => (dmState.cached.has(id)
    ? {
        path: `wxfile://usr/audio/${id}.m4a`,
        size: dmState.entrySize !== null ? dmState.entrySize : 5 * 1024 * 1024,
        title: 'Episode One',
      }
    : null),
  remove(id) {
    dmState.removes.push(id);
    dmState.cached.delete(id);
    fakeDm._emit({ type: 'removed', episodeid: id });
  },
  touch(id) {
    dmState.touches.push(id);
  },
  getUsage: () => ({ bytes: 0, count: dmState.cached.size }),
  clearAll: () => {
    dmState.cached.clear();
    fakeDm._emit({ type: 'cleared' });
  },
  subscribe(cb) {
    dmState.subs.push(cb);
    return () => {
      dmState.subs = dmState.subs.filter((x) => x !== cb);
    };
  },
  _emit(e) {
    dmState.subs.slice().forEach((cb) => cb(e));
  },
};
{
  const dmPath = require.resolve(path.join(__dirname, '../utils/download-manager'));
  require.cache[dmPath] = { id: dmPath, filename: dmPath, loaded: true, exports: fakeDm };
}

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

  section('七、membership 会员态接线（DOWNLOAD-TASK T1.2）');
  {
    // 静态红线：episode 页统一走 membershipStore，不自调订阅状态接口
    const pageSrc = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.js'), 'utf8');
    assert(pageSrc.includes("require('../../store/membershipStore')"), 'episode 页接入 membershipStore（唯一事实来源）');
    assert(!pageSrc.includes("'/api/user/subscription/status'"), 'episode 页不自调订阅状态接口（ai-deep-dive 旧做法不复制）');

    const authStore = require(path.join(__dirname, '../store/authStore'));
    const membershipStore = require(path.join(__dirname, '../store/membershipStore'));
    let statusCalls = 0;
    const baseRoutes = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        statusCalls += 1;
        opts.success({ statusCode: 200, data: { role: 'PREMIUM' } });
        return;
      }
      baseRoutes(opts);
    };

    // 未登录：isPremium 恒 false，且不发起权威校正请求
    const guestPage = createPage(pageConfig);
    guestPage.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    assert(guestPage.data.isPremium === false, '未登录 → isPremium=false');
    assert(statusCalls === 0, '未登录不发起 subscription/status（ensureFresh 登录前置短路）');

    // 纯移动端付费用户：本地 role 展示缓存滞后 USER，经 membershipStore 权威校正收敛 PREMIUM
    membershipStore.init(); // 生产由 app.js onLaunch 调用（订阅 authStore 联动）
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-premium' });
    await tick(); // deriveLocal 乐观判定（USER→false）+ 后台 ensureFresh 发起校正
    guestPage.onShow(); // 页面侧同步（onLoad/onShow 双挂点）
    await tick();
    await tick();
    await tick();
    assert(guestPage.data.isPremium === true, 'role 滞后 USER 的付费用户 → ensureFresh 权威校正收敛 isPremium=true');
    assert(statusCalls >= 1, '校正经 membershipStore 发起（页面不绕过事实来源）');

    // 登出联动：store 复位（authStore→deriveLocal），onShow 重入同步回 false
    authStore.setState({ isLoggedIn: false, userInfo: null, token: '' });
    await tick();
    guestPage.onShow();
    await tick();
    assert(guestPage.data.isPremium === false, '登出 → isPremium 复位 false（onShow 重同步）');
  }

  section('八、下载门禁三态分流（DOWNLOAD-TASK T1.3）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例：状态延续七节

    // 静态接线：premium-modal 场景源改为动态绑定（下载门禁与词典配额共用弹窗）
    const wxml = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.wxml'), 'utf8');
    assert(wxml.includes('source="{{premiumSource}}"'), 'WXML premium-modal source 动态绑定 premiumSource');

    // toast 记录器
    const toasts = [];
    const rawShowToast = global.wx.showToast;
    global.wx.showToast = (o) => toasts.push(o.title);

    // subscription/status 角色可变（七节固定 PREMIUM，本节按用例切换）
    let statusRole = 'USER';
    const baseRoutes2 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
      '/api/dictionary/youdao': { statusCode: 403, data: { code: 'DICTIONARY_QUOTA_EXCEEDED', message: '今日免费词典查询已用完' } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      baseRoutes2(opts);
    };

    // ① 未登录：toast 不跳页、不开弹窗（Web useEpisodeSummarize 口径）
    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    toasts.length = 0;
    page.onDownloadAudio();
    page.onTranscript();
    assert(toasts[0] === '音频下载仅对会员开放' && toasts[1] === '文稿下载仅对会员开放', '① 未登录 → 音频/文稿各弹会员限定 toast（Web 文案逐字）');
    assert(page.data.showPremiumModal === false, '① 未登录不拉起会员弹窗');

    // ② 非会员（登录 + 权威校正 USER）：premium-modal + episode_audio_download 场景
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-user' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === false, '② 非会员态收敛（校正 USER）');
    toasts.length = 0;
    page.onDownloadAudio();
    assert(page.data.showPremiumModal === true && page.data.premiumSource === 'episode_audio_download', '② 非会员点音频 → 弹窗开启 + 场景 episode_audio_download（埋点 source）');
    page.onPremiumModalClose();
    assert(page.data.showPremiumModal === false, '② 弹窗关闭复位');
    page.onTranscript();
    await tick();
    await tick();
    assert(page.data.showTranscriptPreview === true && page.data.showPremiumModal === false, '② 非会员点文稿 → 预览弹层承接（T1.4，非直接弹会员窗，Web 口径）');
    page.onTranscriptPreviewClose();

    // ③ 词典配额路径回归：source 复位 dictionary_quota，不被下载场景残留污染
    page.onPremiumModalClose();
    await page.translateText('hello');
    await tick();
    assert(page.data.showPremiumModal === true && page.data.premiumSource === 'dictionary_quota', '③ 词典配额超限 → 弹窗场景复位 dictionary_quota（不残留下载场景）');

    // ④ 会员：音频占位保留（阶段 3 替换）；文稿已接真实 PDF 链路（T2.1，详测见第十节）
    page.onPremiumModalClose();
    statusRole = 'PREMIUM';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-member' });
    global.wx.setStorageSync('token', 'tk-member');
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '④ 会员态收敛（role 滞后 USER + 订阅表 PREMIUM）');
    let dlCalled8 = false;
    const rawDl8 = global.wx.downloadFile;
    const rawOd8 = global.wx.openDocument;
    global.wx.downloadFile = (opts) => {
      dlCalled8 = true;
      opts.success && opts.success({ statusCode: 200, tempFilePath: 'wxfile://tp8.pdf' });
      opts.complete && opts.complete();
    };
    global.wx.openDocument = () => {};
    toasts.length = 0;
    dmState.cached.clear();
    dmState.dlCalls.length = 0;
    page.onDownloadAudio();
    await tick();
    await tick();
    assert(dmState.dlCalls.indexOf('ep1') !== -1, '④ 会员点音频 → 直进离线缓存链路（占位已退役，T3.3）');
    assert(page.data.audioDlState === 'downloaded', '④ downloaded 事件 → 按钮收敛已下载态');
    page.onTranscript();
    await tick();
    await tick();
    assert(dlCalled8 === true, '④ 会员点文稿 → 直进 PDF 下载链路（占位已退役）');
    assert(page.data.showPremiumModal === false, '④ 会员不触发会员弹窗（本地会员态先行，服务端 403 兜底零触发）');
    dmState.cached.clear();
    global.wx.downloadFile = rawDl8;
    global.wx.openDocument = rawOd8;

    global.wx.showToast = rawShowToast;
  }

  section('九、非会员文稿预览全链路（DOWNLOAD-TASK T1.4）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例延续
    let statusRole = 'USER';
    let previewMode = 'ok';
    const previewCalls = [];
    const PREVIEW_BODY = {
      success: true,
      data: {
        podcastTitle: 'Test Podcast',
        episodeTitle: 'Episode One',
        coverUrl: 'https://oss/cover1',
        subtitles: [
          { textEn: 'Hello world.', textCn: '[SPEAKER_1]: 你好，世界。' },
          { textEn: 'Second line.', textCn: '[SPEAKER_2]: 第二行。' },
        ],
        totalSubtitles: 20,
      },
    };
    const baseRoutes3 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      if (opts.url.includes('/api/episode/transcript-preview')) {
        previewCalls.push(opts);
        opts.success(
          previewMode === 'fail'
            ? { statusCode: 500, data: { success: false } }
            : { statusCode: 200, data: PREVIEW_BODY },
        );
        return;
      }
      baseRoutes3(opts);
    };

    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' }); // 未登录进入
    await tick();
    await tick();
    statusRole = 'USER';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-user' });
    global.wx.setStorageSync('token', 'tk-user'); // 真实登录两处同步：store + storage（请求层读 storage 注 Bearer）
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === false, '⑨ 非会员态收敛（校正 USER）');

    previewCalls.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(previewCalls.length === 1, '⑨ 非会员点文稿 → 拉取 transcript-preview（一次）');
    assert(previewCalls[0].header.Authorization === 'Bearer tk-user', '⑨ 请求携带 Bearer（配合后端 requireAuth 兼容）');
    assert(page.data.showTranscriptPreview === true && page.data.showPremiumModal === false, '⑨ 预览弹层开启且不弹会员窗');
    const pv = page.data.transcriptPreview;
    assert(pv && pv.totalSubtitles === 20 && pv.subtitles.length === 2, '⑨ 预览数据透传（2 句 + total 20，组件内做映射/剥离/页数）');

    page.onTranscriptPreviewClose();
    assert(page.data.showTranscriptPreview === false && page.data.showPremiumModal === false, '⑨ 关闭复位');
    // CTA 行为已内置组件（关弹层 + 占位 toast + PREMIUM_MODAL_OPEN 埋点，premium-modal.onCta 同款），
    // 页面不再做 premium-modal 二次弹窗接线
    const epSrc = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.js'), 'utf8');
    assert(!epSrc.includes('onTranscriptPreviewCta'), '⑦⑨ CTA 承接内置组件（页面无二次弹窗接线）');

    previewMode = 'fail';
    page.onTranscript();
    await tick();
    await tick();
    assert(page.data.showTranscriptPreview === true && page.data.transcriptPreview === null, '⑨ 接口失败 → 弹层照开走空态（Web 静默降级口径）');
    page.onTranscriptPreviewClose();

    statusRole = 'PREMIUM';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-member' });
    global.wx.setStorageSync('token', 'tk-member');
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '⑨ 会员态收敛');
    let dlCalled9 = false;
    global.wx.downloadFile = (opts) => {
      dlCalled9 = true;
      opts.success && opts.success({ statusCode: 200, tempFilePath: 'wxfile://tp9.pdf' });
      opts.complete && opts.complete();
    };
    global.wx.openDocument = () => {};
    previewCalls.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(
      previewCalls.length === 0 && page.data.showTranscriptPreview === false && dlCalled9 === true,
      '⑨ 会员点文稿 → 不拉预览，直进 PDF 链路（T2.1）',
    );
    global.wx.downloadFile = undefined;
    global.wx.openDocument = undefined;
  }

  section('十、会员文稿 PDF 下载与打开（DOWNLOAD-TASK T2.1）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例延续
    const { BASE_URL } = require(path.join(__dirname, '../utils/config'));

    // wx.downloadFile / wx.openDocument mock（harness 原无，本节挂载用后还原）
    const dl = { calls: [], status: 200, netfail: false, openfail: false, hang: false };
    const docs = [];
    const toasts2 = [];
    const rawDownloadFile = global.wx.downloadFile;
    const rawOpenDocument = global.wx.openDocument;
    const rawToast2 = global.wx.showToast;
    global.wx.downloadFile = (opts) => {
      dl.calls.push(opts);
      if (dl.hang) return; // 挂起不回调（防抖用例）
      if (dl.netfail) {
        opts.fail && opts.fail({ errMsg: 'downloadFile:fail' });
        opts.complete && opts.complete();
        return;
      }
      opts.success && opts.success({ statusCode: dl.status, tempFilePath: `wxfile://tmp-t${dl.status}.pdf` });
      opts.complete && opts.complete();
    };
    global.wx.openDocument = (opts) => {
      docs.push(opts);
      if (dl.openfail) opts.fail && opts.fail({ errMsg: 'openDocument:fail' });
      else opts.success && opts.success({});
    };
    global.wx.showToast = (o) => toasts2.push(o.title);

    let statusRole = 'PREMIUM';
    const trackPosts = [];
    const baseRoutes4 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      if (opts.url.includes('/api/track')) {
        trackPosts.push(opts.data);
        opts.success({ statusCode: 204 });
        return;
      }
      baseRoutes4(opts);
    };

    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    global.wx.setStorageSync('token', 'tk-pdf');
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-pdf' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '⑩ 会员态收敛');

    // 正常链路：downloadFile → openDocument
    dl.calls.length = 0; docs.length = 0; toasts2.length = 0; trackPosts.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(dl.calls.length === 1, '⑩ 会员点文稿 → downloadFile 一次');
    assert(
      dl.calls[0].url === `${BASE_URL}/api/episode/transcript-pdf?episodeid=ep1&format=A5`,
      '⑩ URL = BASE_URL + transcript-pdf + 恒 A5（Web 手机口径）',
    );
    assert(dl.calls[0].header.Authorization === 'Bearer tk-pdf', '⑩ 鉴权接口手动携带 Bearer（downloadFile 不走 request.js）');
    assert(
      docs.length === 1 && docs[0].fileType === 'pdf' && docs[0].showMenu === true && docs[0].filePath === 'wxfile://tmp-t200.pdf',
      '⑩ openDocument pdf + showMenu（右上角转发/保存入口）',
    );
    assert(toasts2.indexOf('正在生成文稿 PDF，请稍候...') !== -1, '⑩ 生成中 toast（Web 文案逐字）');
    assert(toasts2.indexOf('文稿已打开') !== -1, '⑩ 打开成功 toast（小程序语境定稿「文稿已打开」，附录 A 注意栏）');
    assert(page.data.isGeneratingPdf === false, '⑩ 在途标记复位');
    const tStart = trackPosts.find((t) => t.eventType === 'TRANSCRIPT_PDF_DOWNLOAD' && t.source === 'start');
    const tSuccess = trackPosts.find((t) => t.eventType === 'TRANSCRIPT_PDF_DOWNLOAD' && t.source === 'success');
    assert(!!tStart && tStart.metadata.episodeid === 'ep1', '⑩ 埋点 start（metadata 带 episodeid）');
    assert(!!tSuccess && tSuccess.metadata.episodeid === 'ep1', '⑩ 埋点 success（下载漏斗闭环）');

    // 404：后端文案
    dl.status = 404; toasts2.length = 0; docs.length = 0; trackPosts.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(toasts2[toasts2.length - 1] === '未找到字幕数据，无法生成文稿' && docs.length === 0, '⑩ 404 → 未找到字幕数据（后端 route 文案逐字），不打开');
    assert(trackPosts.some((t) => t.eventType === 'TRANSCRIPT_PDF_DOWNLOAD' && t.source === 'fail_404'), '⑩ 埋点 fail_404');

    // 403：权限兜底
    dl.status = 403; toasts2.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(toasts2[toasts2.length - 1] === '权限不足，需要高级会员权限', '⑩ 403 → 权限不足，需要高级会员权限（服务端兜底文案）');

    // 5xx：Web 兜底文案
    dl.status = 500; toasts2.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(toasts2[toasts2.length - 1] === '文稿生成失败', '⑩ 5xx → 文稿生成失败（Web 兜底文案）');

    // 网络失败
    dl.status = 200; dl.netfail = true; toasts2.length = 0; trackPosts.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(toasts2[toasts2.length - 1] === '文稿下载失败，请稍后重试', '⑩ 网络失败 → 文稿下载失败，请稍后重试（Web 文案逐字）');
    assert(trackPosts.some((t) => t.eventType === 'TRANSCRIPT_PDF_DOWNLOAD' && t.source === 'fail_network'), '⑩ 埋点 fail_network');
    dl.netfail = false;

    // 在途双击防抖
    dl.hang = true; dl.calls.length = 0;
    page.onTranscript();
    page.onTranscript();
    assert(dl.calls.length === 1, '⑩ 在途双击防抖（isGeneratingPdf 把门，不重复下载）');
    dl.calls[0].complete && dl.calls[0].complete(); // 手动结束挂起请求复位标记
    dl.hang = false;
    assert(page.data.isGeneratingPdf === false, '⑩ 防抖复位');

    // 401：对齐 request.js 全局口径（清 token + 重登提示）
    global.wx.setStorageSync('token', 'tk-pdf');
    dl.status = 401; toasts2.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(toasts2.indexOf('登录已过期，请重新登录') !== -1, '⑩ 401 → 重登提示（对齐 request.js 全局口径）');
    assert(global.wx.getStorageSync('token') === '', '⑩ 401 → 本地 token 已清除');

    // openDocument 失败兜底
    dl.status = 200; dl.openfail = true; toasts2.length = 0; docs.length = 0; trackPosts.length = 0;
    page.onTranscript();
    await tick();
    await tick();
    assert(docs.length === 1 && toasts2[toasts2.length - 1] === '文稿打开失败', '⑩ openDocument 失败 → 文稿打开失败兜底');
    assert(trackPosts.some((t) => t.eventType === 'TRANSCRIPT_PDF_DOWNLOAD' && t.source === 'fail_open'), '⑩ 埋点 fail_open');

    // 转圈态静态接线（T2.2：对齐 Web isGeneratingPdf ? Loader2 : FileDown + disabled:opacity-50）
    const wxml10 = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.wxml'), 'utf8');
    assert(wxml10.includes('wx:if="{{isGeneratingPdf}}"') && wxml10.includes('loading-spinner-sm'), '⑩ 文稿按钮生成中 → loading-spinner-sm 替换图标（Web Loader2 转圈等价）');
    assert(wxml10.includes('opacity: {{isGeneratingPdf ? 0.5 : 1}}'), '⑩ 生成中按钮半透明置灰（Web disabled:opacity-50 等价）');

    // 还原 mock
    global.wx.downloadFile = rawDownloadFile;
    global.wx.openDocument = rawOpenDocument;
    global.wx.showToast = rawToast2;
  }

  section('十一、音频离线缓存三态 UI（DOWNLOAD-TASK T3.3）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例延续
    dmState.cached.clear();
    dmState.dlCalls.length = 0;
    dmState.removes.length = 0;
    dmState.sheets.length = 0;
    dmState.sheetResult = null;
    dmState.mode = 'ok';
    const rawSheet = global.wx.showActionSheet;
    global.wx.showActionSheet = (o) => {
      dmState.sheets.push(o);
      if (dmState.sheetResult !== null) o.success({ tapIndex: dmState.sheetResult });
    };
    const toasts11 = [];
    const rawToast11 = global.wx.showToast;
    global.wx.showToast = (o) => toasts11.push(o.title);

    let statusRole = 'PREMIUM';
    const baseRoutes11 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      baseRoutes11(opts);
    };

    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    global.wx.setStorageSync('token', 'tk-audio');
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-audio' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '⑪ 会员态收敛');
    assert(page.data.audioDlState === 'idle', '⑪ 无缓存初始 idle');

    // ① idle → downloading（含 progress 事件）→ downloaded
    dmState.mode = 'slow';
    page.onDownloadAudio();
    assert(page.data.audioDlState === 'downloading' && page.data.audioDlProgress === 0, '⑪ 发起即置 downloading（乐观态）');
    fakeDm._emit({ type: 'progress', episodeid: 'ep1', progress: 37 });
    assert(page.data.audioDlState === 'downloading' && page.data.audioDlProgress === 37, '⑪ progress 事件驱动进度');
    toasts11.length = 0;
    dmState.resolveSlow();
    await tick();
    await tick();
    assert(page.data.audioDlState === 'downloaded', '⑪ downloaded 事件收敛');
    assert(toasts11.indexOf('已可离线播放') !== -1, '⑪ 完成提示 toast');
    dmState.mode = 'ok';

    // ② 已下载点击 → 四项管理菜单（T4.1 增「发送给好友」）
    dmState.sheets.length = 0;
    page.onDownloadAudio();
    assert(
      dmState.sheets.length === 1 &&
        JSON.stringify(dmState.sheets[0].itemList) === JSON.stringify(['播放', '重新下载', '发送给好友', '删除离线缓存']),
      '⑪ 已下载点击 → action sheet 四项（播放/重新下载/发送给好友/删除离线缓存）',
    );

    // ③ 删除离线缓存
    dmState.sheetResult = 3;
    dmState.removes.length = 0;
    toasts11.length = 0;
    page.onDownloadAudio();
    await tick();
    assert(dmState.removes.indexOf('ep1') !== -1 && page.data.audioDlState === 'idle', '⑪ 删除 → removed 事件收敛 idle');
    assert(toasts11.indexOf('已删除离线缓存') !== -1, '⑪ 删除提示 toast');

    // ④ 重新下载（先删后下，防缓存命中短路）
    dmState.cached.add('ep1');
    fakeDm._emit({ type: 'downloaded', episodeid: 'ep1' });
    const dlBefore = dmState.dlCalls.length;
    const rmBefore = dmState.removes.length;
    dmState.sheetResult = 1;
    page.onDownloadAudio();
    await tick();
    await tick();
    assert(dmState.removes.length === rmBefore + 1 && dmState.dlCalls.length === dlBefore + 1, '⑪ 重新下载 = 先删后下（防缓存短路）');
    assert(page.data.audioDlState === 'downloaded', '⑪ 重下完成收敛 downloaded');

    // ⑤ 播放（action sheet → onStartListening 链；④ 重下后缓存命中 → T3.4 本地优先播本地文件）
    audioManager.close();
    dmState.sheetResult = 0;
    page.onDownloadAudio();
    await tick();
    assert(
      audioManager.getState().hasEpisode === true &&
        audioManager.getState().currentEpisode.episodeid === 'ep1' &&
        bgmCalls.src === 'wxfile://usr/audio/ep1.m4a',
      '⑪ 播放 → 起播本集且缓存命中走本地路径（T3.4 本地优先经 action sheet 链路生效）',
    );
    audioManager.close();

    // ⑥ 失败：error 事件收敛 + dm 文案 toast
    dmState.cached.delete('ep1');
    fakeDm._emit({ type: 'removed', episodeid: 'ep1' });
    dmState.mode = 'fail';
    toasts11.length = 0;
    page.onDownloadAudio();
    await tick();
    await tick();
    assert(page.data.audioDlState === 'idle', '⑪ 失败 → error 事件收敛 idle');
    assert(toasts11.indexOf('下载失败（HTTP 403）') !== -1, '⑪ 失败 toast 透传 download-manager 文案');
    dmState.mode = 'ok';

    // ⑦ onShow 同步 + downloading 保护
    dmState.cached.add('ep1');
    page.onShow();
    assert(page.data.audioDlState === 'downloaded', '⑦⑪ onShow 命中缓存 → downloaded');
    dmState.cached.delete('ep1');
    page.onShow();
    assert(page.data.audioDlState === 'idle', '⑦⑪ onShow 缓存消失 → idle');
    dmState.mode = 'slow';
    page.onDownloadAudio();
    page.onShow();
    assert(page.data.audioDlState === 'downloading', '⑦⑪ 下载中 onShow 不被误清');
    dmState.resolveSlow();
    await tick();
    dmState.mode = 'ok';

    // ⑧ 他集事件忽略 / cleared 全局收敛
    const st8 = page.data.audioDlState;
    const pg8 = page.data.audioDlProgress;
    fakeDm._emit({ type: 'progress', episodeid: 'epOther', progress: 88 });
    assert(page.data.audioDlState === st8 && page.data.audioDlProgress === pg8, '⑧⑪ 他集事件不影响本页');
    // cleared 生产时序：clearAll 先清缓存集再广播（此处同步模拟该时序）
    dmState.cached.clear();
    fakeDm._emit({ type: 'cleared' });
    assert(page.data.audioDlState === 'idle', '⑧⑪ cleared 全局事件 → 收敛 idle');

    // ⑨ 门禁优先：非会员即使已缓存 → 弹会员窗，不进管理菜单不下载
    statusRole = 'USER';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-user2' });
    global.wx.setStorageSync('token', 'tk-user2');
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === false, '⑨⑪ 非会员态收敛');
    dmState.cached.add('ep1');
    fakeDm._emit({ type: 'downloaded', episodeid: 'ep1' });
    dmState.sheets.length = 0;
    dmState.dlCalls.length = 0;
    page.onDownloadAudio();
    assert(
      page.data.showPremiumModal === true && dmState.sheets.length === 0 && dmState.dlCalls.length === 0,
      '⑨⑪ 非会员已缓存 → 门禁优先弹会员窗（不进菜单/不下载）',
    );
    page.onPremiumModalClose();

    // ⑩ WXML 三态静态接线
    const wxml11 = fs.readFileSync(path.join(__dirname, '../pages/episode/episode.wxml'), 'utf8');
    assert(
      wxml11.includes("wx:if=\"{{audioDlState === 'downloading'}}\"") && wxml11.includes('{{audioDlProgress}}%'),
      '⑩⑪ WXML downloading 态百分比文本',
    );
    assert(
      wxml11.includes("wx:elif=\"{{audioDlState === 'downloaded'}}\"") && wxml11.includes('download-done.svg'),
      '⑩⑪ WXML downloaded 态 download-done 图标（Material，台账第十节）',
    );

    global.wx.showActionSheet = rawSheet;
    global.wx.showToast = rawToast11;
    dmState.cached.clear();
  }

  section('十二、播放本地优先（DOWNLOAD-TASK T3.4）');
  {
    audioManager.close();
    dmState.cached.clear();
    dmState.touches.length = 0;
    let subtitlesResolved = 0;
    const baseRoutes12 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: { ...EPISODE, audioUrl: null } },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
      '/api/episode/subtitles': { statusCode: 200, data: { audioUrl: 'https://oss/resolved12.m4a' } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/episode/subtitles')) subtitlesResolved += 1;
      baseRoutes12(opts);
    };

    // ① 无缓存对照：无 audioUrl → 解析签名直链（原链路不变）
    audioManager.playEpisode({ ...EPISODE, episodeid: 'epN1', audioUrl: null }, { playlist: [] });
    await tick();
    await tick();
    assert(bgmCalls.src === 'https://oss/resolved12.m4a' && subtitlesResolved === 1, '⑫ 无缓存 → 原 subtitles 解析链路不变');

    // ② 缓存命中：即使 episode 自带远端直链也优先本地，且 touch 刷新 LRU
    audioManager.close();
    dmState.cached.add('epN2');
    dmState.touches.length = 0;
    audioManager.playEpisode({ ...EPISODE, episodeid: 'epN2', audioUrl: 'https://oss/remote12.m4a' }, { playlist: [] });
    await tick();
    assert(bgmCalls.src === 'wxfile://usr/audio/epN2.m4a', '⑫ 命中缓存 → bgm.src 本地路径（优先于远端直链，免签名）');
    assert(dmState.touches.indexOf('epN2') !== -1, '⑫ 播放命中 → touch 刷新 LRU 时钟');

    // ③ 命中且无 audioUrl：零解析请求（飞行模式可播的关键——不发任何网络）
    audioManager.close();
    const resolvedBefore = subtitlesResolved;
    dmState.cached.add('epN3');
    audioManager.playEpisode({ ...EPISODE, episodeid: 'epN3', audioUrl: null }, { playlist: [] });
    await tick();
    await tick();
    assert(bgmCalls.src === 'wxfile://usr/audio/epN3.m4a' && subtitlesResolved === resolvedBefore, '⑫ 命中且无直链 → 零网络请求（离线播放成立）');

    // ④ 播放会话元数据/进度链路不受 src 来源影响（currentEpisode/hasEpisode 正常）
    assert(
      audioManager.getState().currentEpisode && audioManager.getState().currentEpisode.episodeid === 'epN3' &&
        audioManager.getState().hasEpisode === true,
      '⑫ 播放会话建立（progress-reporter 只看 episodeid，与 src 来源无关）',
    );

    audioManager.close();
    dmState.cached.clear();
  }

  section('十三、音频分享导出（DOWNLOAD-TASK T4.1）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例延续
    dmState.cached.clear();
    dmState.entrySize = null;
    dmState.mode = 'ok';
    dmState.sheets.length = 0;
    dmState.sheetResult = null;
    dmState.dlCalls.length = 0;

    const shareCalls = [];
    let shareFail = null; // null 成功 | { errMsg }
    const rawShare = global.wx.shareFileMessage;
    global.wx.shareFileMessage = (o) => {
      shareCalls.push(o);
      if (shareFail) o.fail && o.fail(shareFail);
      else o.success && o.success({});
    };
    const rawSheet13 = global.wx.showActionSheet; // 十一节末已还原为基桩，本节重新挂录音器
    global.wx.showActionSheet = (o) => {
      dmState.sheets.push(o);
      if (dmState.sheetResult !== null) o.success({ tapIndex: dmState.sheetResult });
    };
    const toasts13 = [];
    const rawToast13 = global.wx.showToast;
    global.wx.showToast = (o) => toasts13.push(o.title);

    let statusRole = 'PREMIUM';
    const baseRoutes13 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      baseRoutes13(opts);
    };

    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    global.wx.setStorageSync('token', 'tk-share');
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-share' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '⑬ 会员态收敛');

    // ① 菜单「发送给好友」→ shareFileMessage（缓存路径 + 标题.ext 文件名）
    dmState.cached.add('ep1');
    fakeDm._emit({ type: 'downloaded', episodeid: 'ep1' });
    dmState.sheetResult = 2;
    shareCalls.length = 0;
    page.onDownloadAudio();
    assert(
      shareCalls.length === 1 &&
        shareCalls[0].filePath === 'wxfile://usr/audio/ep1.m4a' &&
        shareCalls[0].fileName === 'Episode One.m4a',
      '⑬ 发送给好友 → shareFileMessage(filePath=缓存路径, fileName=标题.m4a)',
    );

    // ② 超 10MB 硬限 → 降级文案不发起
    dmState.entrySize = 11 * 1024 * 1024;
    shareCalls.length = 0;
    toasts13.length = 0;
    page.onDownloadAudio();
    assert(
      shareCalls.length === 0 && toasts13.indexOf('文件较大，暂不支持直接发送') !== -1,
      '⑬ 超 10MB（官方硬限）→ 降级文案，不发起分享',
    );
    dmState.entrySize = null;

    // ③ 取消分享 → 静默不算失败
    shareFail = { errMsg: 'shareFileMessage:fail cancel' };
    toasts13.length = 0;
    page.onDownloadAudio();
    assert(shareCalls.length === 1 && toasts13.length === 0, '⑬ 用户取消 → 静默（不算失败）');

    // ④ 分享失败（非取消）→ toast
    shareFail = { errMsg: 'shareFileMessage:fail file size exceeds limit' };
    toasts13.length = 0;
    page.onDownloadAudio();
    assert(toasts13.indexOf('发送失败，请稍后重试') !== -1, '⑬ 分享失败（非取消）→ 发送失败 toast');
    shareFail = null;

    // ⑤ 未缓存兜底：静默补下后分享（菜单打开瞬间被 LRU 驱逐的极端路径）
    dmState.cached.clear();
    fakeDm._emit({ type: 'removed', episodeid: 'ep1' });
    dmState.dlCalls.length = 0;
    shareCalls.length = 0;
    toasts13.length = 0;
    page._shareAudio();
    await tick();
    await tick();
    assert(dmState.dlCalls.length === 1 && shareCalls.length === 1, '⑬ 未缓存 → 先补下再分享（download-manager 兜底）');
    assert(toasts13.indexOf('正在准备文件...') !== -1, '⑬ 补下前置提示');

    global.wx.shareFileMessage = rawShare;
    global.wx.showActionSheet = rawSheet13;
    global.wx.showToast = rawToast13;
    dmState.cached.clear();
  }

  section('十四、PC 端保存到电脑（DOWNLOAD-TASK T4.2）');
  {
    const authStore = require(path.join(__dirname, '../store/authStore')); // 单例延续
    dmState.cached.clear();
    dmState.mode = 'ok';
    dmState.sheets.length = 0;
    dmState.sheetResult = null;
    dmState.dlCalls.length = 0;

    const diskCalls = [];
    let diskFail = null; // null 成功 | { errMsg }
    const rawDisk = global.wx.saveFileToDisk;
    global.wx.saveFileToDisk = (o) => {
      diskCalls.push(o);
      if (diskFail) o.fail && o.fail(diskFail);
      else o.success && o.success({});
    };
    const rawCanIUse = global.wx.canIUse;
    const rawSysInfo = global.wx.getSystemInfoSync;
    const rawSheet14 = global.wx.showActionSheet;
    global.wx.showActionSheet = (o) => {
      dmState.sheets.push(o);
      if (dmState.sheetResult !== null) o.success({ tapIndex: dmState.sheetResult });
    };
    const toasts14 = [];
    const rawToast14 = global.wx.showToast;
    global.wx.showToast = (o) => toasts14.push(o.title);

    let statusRole = 'PREMIUM';
    const baseRoutes14 = routeAwareHandler({
      '/api/episode/detail': { statusCode: 200, data: EPISODE },
      '/api/episode/list-by-podcastid': { statusCode: 200, data: { data: { episodes: [EPISODE] } } },
      '/api/comment/list': { statusCode: 200, data: [] },
      '/api/episode/favorite/find-unique': { statusCode: 200, data: { success: false } },
    });
    requestHandler = (opts) => {
      if (opts.url.includes('/api/user/subscription/status')) {
        opts.success({ statusCode: 200, data: { role: statusRole } });
        return;
      }
      baseRoutes14(opts);
    };

    const page = createPage(pageConfig);
    page.onLoad({ id: 'ep1' });
    await tick();
    await tick();
    global.wx.setStorageSync('token', 'tk-disk');
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-disk' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    dmState.cached.add('ep1');
    fakeDm._emit({ type: 'downloaded', episodeid: 'ep1' });

    // ① PC 端（windows）：五项菜单，保存项在发送与删除之间
    global.wx.canIUse = (api) => api === 'saveFileToDisk';
    global.wx.getSystemInfoSync = () => ({ platform: 'windows' });
    dmState.sheets.length = 0;
    page.onDownloadAudio();
    assert(
      dmState.sheets.length === 1 &&
        JSON.stringify(dmState.sheets[0].itemList) === JSON.stringify(['播放', '重新下载', '发送给好友', '保存到电脑', '删除离线缓存']),
      '⑭ PC 端（windows）→ 五项菜单（保存到电脑插在发送与删除之间）',
    );

    // ② tapIndex 3 → saveFileToDisk（缓存路径）+ 成功 toast
    dmState.sheetResult = 3;
    diskCalls.length = 0;
    toasts14.length = 0;
    page.onDownloadAudio();
    assert(diskCalls.length === 1 && diskCalls[0].filePath === 'wxfile://usr/audio/ep1.m4a', '⑭ 保存到电脑 → saveFileToDisk(filePath=缓存路径)');
    assert(toasts14.indexOf('已保存到电脑') !== -1, '⑭ 保存成功 toast');

    // ③ 取消静默 / 失败 toast
    diskFail = { errMsg: 'saveFileToDisk:fail cancel' };
    toasts14.length = 0;
    page.onDownloadAudio();
    assert(toasts14.length === 0, '⑭ 取消保存 → 静默');
    diskFail = { errMsg: 'saveFileToDisk:fail' };
    page.onDownloadAudio();
    assert(toasts14.indexOf('保存失败，请稍后重试') !== -1, '⑭ 保存失败 → toast');
    diskFail = null;

    // ④ 删除项仍为末项（tapIndex 4）
    dmState.sheetResult = 4;
    dmState.removes.length = 0;
    page.onDownloadAudio();
    await tick();
    assert(dmState.removes.indexOf('ep1') !== -1 && page.data.audioDlState === 'idle', '⑭ PC 菜单删除项 = 末项（tapIndex 4）');

    // ⑤ 移动端（ios）：canIUse 真但 platform 手机 → 四项无保存项（双保险防误报）
    dmState.cached.add('ep1');
    fakeDm._emit({ type: 'downloaded', episodeid: 'ep1' });
    global.wx.getSystemInfoSync = () => ({ platform: 'ios' });
    dmState.sheetResult = null; // 本用例只验菜单构成，不触发选择
    dmState.sheets.length = 0;
    page.onDownloadAudio();
    assert(
      dmState.sheets.length === 1 && dmState.sheets[0].itemList.length === 4 &&
        dmState.sheets[0].itemList.indexOf('保存到电脑') === -1,
      '⑭ 移动端（canIUse 真但 platform=ios）→ 四项无保存项（platform 双保险）',
    );

    // ⑥ canIUse 假（mac 变体对照）
    global.wx.canIUse = () => false;
    global.wx.getSystemInfoSync = () => ({ platform: 'mac' });
    dmState.sheets.length = 0;
    page.onDownloadAudio();
    assert(dmState.sheets[0].itemList.length === 4, '⑭ canIUse 假 → 四项（canIUse 为第一道闸）');

    // ⑦ 未缓存兜底：补下后保存
    global.wx.canIUse = (api) => api === 'saveFileToDisk';
    global.wx.getSystemInfoSync = () => ({ platform: 'windows' });
    dmState.cached.clear();
    fakeDm._emit({ type: 'removed', episodeid: 'ep1' });
    dmState.dlCalls.length = 0;
    diskCalls.length = 0;
    page._saveAudioToDisk();
    await tick();
    await tick();
    assert(dmState.dlCalls.length === 1 && diskCalls.length === 1, '⑭ 未缓存 → 先补下再保存（与分享同兜底）');

    global.wx.saveFileToDisk = rawDisk;
    global.wx.canIUse = rawCanIUse;
    global.wx.getSystemInfoSync = rawSysInfo;
    global.wx.showActionSheet = rawSheet14;
    global.wx.showToast = rawToast14;
    dmState.cached.clear();
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
