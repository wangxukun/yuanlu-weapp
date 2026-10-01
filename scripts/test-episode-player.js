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

    // ④ 会员：占位 toast 不弹窗（阶段 2/3 落地前的既定占位）
    page.onPremiumModalClose();
    statusRole = 'PREMIUM';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-member' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '④ 会员态收敛（role 滞后 USER + 订阅表 PREMIUM）');
    toasts.length = 0;
    page.onDownloadAudio();
    page.onTranscript();
    assert(toasts[0] === '音频下载功能即将上线' && toasts[1] === '文稿弹层功能开发中', '④ 会员 → 两按钮占位 toast（阶段 2/3 替换为真实实现）');
    assert(page.data.showPremiumModal === false, '④ 会员不触发会员弹窗（本地会员态先行，服务端 403 兜底零触发）');

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

    page.onTranscriptPreviewCta();
    assert(
      page.data.showTranscriptPreview === false &&
        page.data.showPremiumModal === true &&
        page.data.premiumSource === 'episode_audio_download',
      '⑨ 拦截卡 CTA → 预览关 + 会员弹窗同场景（Web 跳订阅页的 weapp 等价承接）',
    );
    page.onPremiumModalClose();
    assert(page.data.showTranscriptPreview === false && page.data.showPremiumModal === false, '⑨ 关闭复位');

    previewMode = 'fail';
    page.onTranscript();
    await tick();
    await tick();
    assert(page.data.showTranscriptPreview === true && page.data.transcriptPreview === null, '⑨ 接口失败 → 弹层照开走空态（Web 静默降级口径）');
    page.onTranscriptPreviewClose();

    statusRole = 'PREMIUM';
    authStore.setState({ isLoggedIn: true, userInfo: { role: 'USER' }, token: 'tk-member' });
    await tick();
    page.onShow();
    await tick();
    await tick();
    await tick();
    assert(page.data.isPremium === true, '⑨ 会员态收敛');
    previewCalls.length = 0;
    page.onTranscript();
    await tick();
    assert(previewCalls.length === 0 && page.data.showTranscriptPreview === false, '⑨ 会员点文稿 → 不拉预览（占位保留，阶段 2 接管）');
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
