/**
 * scripts/test-mini-player.js — 迷你播放条与全屏面板自动化测试
 * （3.B.3 初版 + 2026-09-22 Android 对齐重构：精听标记 / 定时关闭 / 播放列表）
 *
 * mock wx.getBackgroundAudioManager + Component，驱动
 * utils/audioManager → store/playerStore → components/player/{mini-player,player-panel}：
 *   - audioManager.close()：停声 + 清空会话/播放列表/定时任务/精听标记（对齐 Web closePlayer）；
 *   - 定时关闭（对齐 Android applySleepConfig / handleSleepOnEpisodeEnded）：
 *     分钟定时（建立/倒计时/到期暂停）、按集数（递减/到量停不连播）、播完整集、
 *     取消、close 联动、lastSleepConfig 记忆、镜像回流；
 *   - 迷你条：无会话隐藏 / 起播显示 / 进度 / 节流 / 播客名兜底 / 精听标签数据 /
 *     面板互斥（wx:if 条件）/ 恢复播放先 audioBus.stopAll；
 *   - 全屏面板：展开同步（无字幕请求——字幕模块已删）/ 精听角标数据 / 定时按钮
 *     倒计时文案 / 定时弹层选项与 Switch / 播放列表弹层切播 / 精听模式按钮路由
 *     （practice 深链 + 栈顶守卫）/ 封面守卫 / 关闭播放器。
 *
 * 运行：node scripts/test-mini-player.js
 */

/* ==================== mock 基础设施 ==================== */

const fs = require('fs');
const path = require('path');

const bgmCalls = { src: null, rates: [], seeks: [], stops: 0, pauses: 0, plays: 0 };
const bgmHandlers = {};
const bgm = {
  currentTime: 0,
  duration: 0,
  play() { bgmCalls.plays += 1; bgmHandlers.play && bgmHandlers.play(); },
  pause() { bgmCalls.pauses += 1; bgmHandlers.pause && bgmHandlers.pause(); },
  stop() { bgmCalls.stops += 1; bgmHandlers.stop && bgmHandlers.stop(); },
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
  title: { set: () => {} },
  epname: { set: () => {} },
  singer: { set: () => {} },
  coverImgUrl: { set: () => {} },
  playbackRate: { set: (v) => { bgmCalls.rates.push(v); } },
});

const navCalls = [];
const backCalls = []; // navigateBack delta 记录（单例路由回退断言用）
const toastCalls = []; // showToast 标题记录（no-op 反馈断言用）
const modalCalls = [];
const requestUrls = [];
let currentPages = []; // 页面栈 mock（单例路由查重/跳转守卫用）
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: (opts) => { toastCalls.push(opts && opts.title); },
  showModal: (opts) => { modalCalls.push(opts); },
  navigateTo: (opts) => { navCalls.push(opts.url); },
  getCurrentPages: () => currentPages,
  switchTab: () => {},
  navigateBack: (opts) => { backCalls.push(opts && opts.delta); },
  stopPullDownRefresh: () => {},
  request: (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    requestUrls.push(p);
    if (p === '/api/episode/subtitles') {
      opts.success({ statusCode: 200, data: { audioUrl: 'https://oss/a.m4a', subtitles: [] } });
      return;
    }
    opts.success({ statusCode: 200, data: { success: true } });
  },
  getBackgroundAudioManager: () => bgm,
};

// Component 定义捕获（quota-card 同款测试法）
const componentDefs = {};
global.Component = (cfg) => { componentDefs.__last = cfg; };

/* ==================== 加载被测模块 ==================== */

require(path.join(__dirname, '../components/player/mini-player'));
const miniDef = componentDefs.__last;
require(path.join(__dirname, '../components/player/player-panel'));
const panelDef = componentDefs.__last;

const audioManager = require(path.join(__dirname, '../utils/audioManager'));
audioManager.init(); // 生产链路由 app.js onLaunch 调用
const playerStore = require(path.join(__dirname, '../store/playerStore'));
const audioBus = require(path.join(__dirname, '../utils/audio-bus'));
const route = require(path.join(__dirname, '../utils/route'));

// audioBus.stopAll 互斥调用计数（不打断原行为）
let stopAllCalls = 0;
const origStopAll = audioBus.stopAll;
audioBus.stopAll = function () {
  stopAllCalls += 1;
  return origStopAll.apply(this, arguments);
};

// 假时钟：让 400ms 节流 / 定时倒计时判定确定化
const realNow = Date.now;
let fakeNow = 1000000;
Date.now = () => fakeNow;

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

const EP = (id, extra) => Object.assign({
  episodeid: id,
  title: 'Episode ' + id,
  audioUrl: 'https://oss/' + id + '.m4a',
  podcastTitle: '远路英语',
  coverUrl: 'https://oss/cover-' + id + '.jpg',
}, extra || {});

/** 由 Component 定义构造可驱动的伪实例（绑定 lifetimes/methods/observer；
 *  properties 默认值反射进 data，与真机运行时语义一致） */
function makeInstance(def) {
  const propDefaults = {};
  Object.keys(def.properties || {}).forEach((k) => {
    propDefaults[k] = def.properties[k].value;
  });
  const inst = {
    data: Object.assign(propDefaults, JSON.parse(JSON.stringify(def.data))),
    events: [],
    setDataCalls: 0,
    setData(patch) {
      Object.assign(this.data, patch);
      this.setDataCalls += 1;
    },
    triggerEvent(name, detail) {
      this.events.push(name);
    },
  };
  Object.keys(def.methods || {}).forEach((k) => {
    inst[k] = def.methods[k].bind(inst);
  });
  if (def.lifetimes && def.lifetimes.attached) {
    inst._attached = def.lifetimes.attached.bind(inst);
  }
  return inst;
}

const fireTime = (t, d) => {
  bgm.currentTime = t;
  bgm.duration = d;
  bgmHandlers.timeupdate();
};

const subRequestCount = () => requestUrls.filter((u) => u === '/api/episode/subtitles').length;

/* ==================== 用例 ==================== */

(async () => {
  section('一、audioManager.close()（对齐 Web closePlayer / Android stop）');
  {
    await audioManager.playEpisode(EP('ep1'), { playlist: [EP('ep1'), EP('ep2')], intensive: true });
    await tick();
    assert(playerStore.getState().hasEpisode === true, '前置：起播后会话存在');

    audioManager.close();
    const s = audioManager.getState();
    assert(bgmCalls.stops >= 1, 'close → bgm.stop() 停声');
    assert(s.currentEpisode === null && s.hasEpisode === false, 'close → 清空当前剧集（hasEpisode=false）');
    assert(s.playlist.length === 0, 'close → 清空播放列表');
    assert(s.isIntensiveMode === false, 'close → 精听标记复位');
    assert(playerStore.getState().hasEpisode === false, 'close → playerStore 镜像回流（迷你条整条收起）');
  }

  section('二、迷你播放条 mini-player');
  {
    const mini = makeInstance(miniDef);
    mini._attached();
    assert(mini.data.hasEpisode === false, '无播放会话：整条不渲染');

    // 普通起播：精听标记 false（标签不显示）
    await audioManager.playEpisode(EP('ep2'));
    await tick();
    assert(mini.data.hasEpisode === true, '起播 → 迷你条出现');
    assert(mini.data.title === 'Episode ep2' && mini.data.podcastTitle === '远路英语', '标题/播客名镜像');
    assert(mini.data.isIntensiveMode === false, '普通起播 → 精听标记 false（无「精听」标签）');

    fakeNow += 500;
    fireTime(90, 300);
    assert(mini.data.progress === 30, 'timeupdate → 进度线 90/300 = 30%');

    // 节流
    const callsBefore = mini.setDataCalls;
    fakeNow += 100;
    fireTime(91, 300);
    assert(mini.setDataCalls === callsBefore && mini.data.progress === 30, '400ms 内 timeupdate 节流（进度不跳变）');
    fakeNow += 400;
    fireTime(150, 300);
    assert(mini.data.progress === 50, '越过节流窗口 → 进度更新为 50%');

    // 精听入口起播：标记置位（「精听」标签显示依据）
    await audioManager.playEpisode(EP('ep3'), { intensive: true });
    await tick();
    assert(mini.data.isIntensiveMode === true, '精听入口起播 → isIntensiveMode=true（迷你条「精听」标签）');

    // 播客名兜底
    await audioManager.playEpisode(EP('ep3b', { podcastTitle: undefined }), { intensive: true });
    await tick();
    assert(mini.data.podcastTitle === '远路播客', '无播客名 → 兜底「远路播客」');

    // 恢复播放互斥
    bgmHandlers.pause();
    fakeNow += 500;
    fireTime(151, 300);
    const stopAllBefore = stopAllCalls;
    mini.onTogglePlay();
    assert(stopAllCalls === stopAllBefore + 1, '恢复播放 → audioBus.stopAll()（停 TTS/复习片段，防双声）');
    assert(audioManager.getState().isPlaying === true, '恢复播放 → isPlaying=true');

    // 面板展开/收起（visible 由迷你条持有；条体 wx:if 互斥）
    mini.onOpenPanel();
    assert(mini.data.panelVisible === true, '点条身 → panelVisible=true（迷你条随互斥条件隐藏）');
    mini.onPanelClose();
    assert(mini.data.panelVisible === false, '面板 close 事件 → panelVisible=false（迷你条恢复显示）');

    mini.onClose();
    assert(audioManager.getState().hasEpisode === false && mini.data.hasEpisode === false, '关闭钮 → close() 清会话，迷你条收起');
  }

  section('三、定时关闭（对齐 Android applySleepConfig / handleSleepOnEpisodeEnded）');
  {
    await audioManager.playEpisode(EP('ep5'), { playlist: [EP('ep5'), EP('ep6')], intensive: true });
    bgmHandlers.play();

    // —— 分钟定时 ——
    audioManager.applySleepConfig({ mode: 'minutes', minutes: 15 });
    let t = audioManager.getState().sleepTimer;
    assert(t && t.mode === 'minutes' && t.label === '15分钟后关闭', '分钟定时建立（label 对齐 Android describe）');
    assert(audioManager.getState().lastSleepConfig.mode === 'minutes' && audioManager.getState().lastSleepConfig.minutes === 15, 'lastSleepConfig 记忆（Switch 快捷重开依据）');
    assert(playerStore.getState().sleepTimer && playerStore.getState().sleepTimer.minutes === 15, 'sleepTimer 事件 → playerStore 镜像');

    fakeNow += 14 * 60 * 1000;
    audioManager._sleepTick();
    t = audioManager.getState().sleepTimer;
    assert(t && t.remainingMs > 0 && t.remainingMs <= 60 * 1000, '倒计时随时间递减（remainingMs 更新，引用替换驱动镜像）');

    const pausesBefore = bgmCalls.pauses;
    fakeNow += 61 * 1000;
    audioManager._sleepTick();
    assert(audioManager.getState().sleepTimer === null, '分钟到期 → 定时任务清除');
    assert(bgmCalls.pauses > pausesBefore, '分钟到期 → 暂停播放（对齐 Android exoPlayer.pause）');

    // —— 按集数：递减 + 到量停（不连播）——
    await audioManager.playEpisode(EP('ep6'), { playlist: [EP('ep6'), EP('ep7')] });
    audioManager.applySleepConfig({ mode: 'episodes', count: 2 });
    assert(audioManager.getState().sleepTimer.label === '播完2集后关闭', '按集数建立（label 对齐 Android describe）');

    bgmHandlers.ended(); // 第一集播完 → 递减 + 正常连播
    await tick();
    assert(audioManager.getState().sleepTimer && audioManager.getState().sleepTimer.count === 1, '播完 1 集 → 递减为「播完本集」');
    assert(audioManager.getState().sleepTimer.label === '播完本集后关闭', '递减后 label 更新');
    assert(audioManager.getState().currentEpisode.episodeid === 'ep7', '未到量 → 正常连播 ep7');

    const srcAfter = bgmCalls.src;
    bgmHandlers.ended(); // 第二集播完 → 到量停止
    await tick();
    assert(audioManager.getState().sleepTimer === null, '到量 → 定时清除');
    assert(audioManager.getState().currentEpisode.episodeid === 'ep7', '到量停止：不再连播（currentEpisode 保持 ep7）');
    assert(bgmCalls.src === srcAfter, '到量停止：未重设 src（真正停下，非仅清标记）');

    // —— 播完整集声音再停止 ——
    await audioManager.playEpisode(EP('ep8'), { playlist: [EP('ep8'), EP('ep9')] });
    audioManager.applySleepConfig({ mode: 'episodeEnd' });
    assert(audioManager.getState().sleepTimer.label === '播完整集后关闭', 'episodeEnd describe 文案');
    bgmHandlers.ended();
    await tick();
    assert(audioManager.getState().sleepTimer === null && audioManager.getState().currentEpisode.episodeid === 'ep8', '播完整集 → 本集结束即停（不连播）');

    // —— 取消 / close 联动 ——
    audioManager.applySleepConfig({ mode: 'minutes', minutes: 30 });
    audioManager.cancelSleepTimer();
    assert(audioManager.getState().sleepTimer === null, '取消定时');
    assert(audioManager.getState().lastSleepConfig && audioManager.getState().lastSleepConfig.minutes === 30, '取消后 lastSleepConfig 保留（上次定时行展示）');

    audioManager.applySleepConfig({ mode: 'minutes', minutes: 10 });
    audioManager.close();
    assert(audioManager.getState().sleepTimer === null, 'close() → 定时任务一并清除（对齐 Android stop() cancel sleepJob）');
  }

  section('四、全屏播放面板 player-panel（Android 对齐重构后）');
  {
    const panel = makeInstance(panelDef);
    panel._attached();

    // 未展开：订阅静默（visible 门禁）
    await audioManager.playEpisode(EP('ep4'));
    await tick();
    fakeNow += 500;
    const calls0 = panel.setDataCalls;
    fireTime(90, 300);
    assert(panel.setDataCalls === calls0, '面板未展开：不渲染（visible 门禁）');

    // 展开：全量同步；字幕模块已删 → 不再请求 /api/episode/subtitles
    const subsBefore = subRequestCount();
    await audioManager.playEpisode(EP('ep4'), { playlist: [EP('ep4'), EP('ep5')], intensive: true });
    bgmHandlers.play();
    panel.setData({ visible: true });
    panelDef.properties.visible.observer.call(panel, true);
    await tick();
    assert(panel.data.title === 'Episode ep4', '展开 → 标题同步');
    assert(panel.data.isIntensiveMode === true, '精听会话 → 封面「精听中」角标数据');
    assert(subRequestCount() === subsBefore, '字幕模块已删 → 不再请求字幕接口');
    fakeNow += 500;
    fireTime(120, 300);
    assert(panel.data.timeLabel === '02:00' && panel.data.remainLabel === '-03:00', '时间标签同步（当前/剩余）');

    // —— 顶部安全区：沉浸宿主页让出状态栏/胶囊，默认导航宿主页不加留白 ——
    global.wx.getWindowInfo = () => ({ statusBarHeight: 47, screenHeight: 812, windowHeight: 812 });
    global.wx.getMenuButtonBoundingClientRect = () => ({ top: 51, height: 32, bottom: 83, width: 87, left: 278, right: 365 });
    panel._measureHeaderTop();
    assert(panel.data.headerPadTop === 87, '沉浸宿主页（精听页 custom 导航）：headerPadTop = 胶囊底 83 + 间隙 4');
    global.wx.getWindowInfo = () => ({ statusBarHeight: 47, screenHeight: 812, windowHeight: 721 });
    panel._measureHeaderTop();
    assert(panel.data.headerPadTop === 0, '默认导航宿主页：原生导航栏即安全区 → headerPadTop 钳 0');

    // —— 定时按钮：激活时显示倒计时（分钟模式 mm:ss）——
    audioManager.applySleepConfig({ mode: 'minutes', minutes: 15 });
    assert(panel.data.sleepActive === true && panel.data.sleepText === '15:00', '分钟定时 → 按钮转主题色并显示倒计时 15:00');
    fakeNow += 500;
    audioManager._sleepTick();
    assert(panel.data.sleepText === '15:00' || panel.data.sleepText === '14:59', '倒计时随 tick 刷新');

    // —— 定时弹层：选项与 Switch ——
    panel.onOpenSleepSheet();
    assert(panel.data.sleepSheetVisible === true, '点「定时关闭」→ 定时弹层展开');
    panel.onSelectSleepMinutes({ currentTarget: { dataset: { minutes: 30 } } });
    assert(audioManager.getState().sleepTimer && audioManager.getState().sleepTimer.minutes === 30, '选「30分」→ applySleepConfig(minutes:30)');
    assert(panel.data.selectedSleep && panel.data.selectedSleep.minutes === 30, '弹层选中态跟随（30分高亮）');
    assert(panel.data.lastSleepDesc === '30分钟后关闭', '「上次定时」行显示 describe 文案');

    panel.onSleepSwitchChange({ detail: { value: false } });
    assert(audioManager.getState().sleepTimer === null, 'Switch 关 → 取消定时');
    panel.onSleepSwitchChange({ detail: { value: true } });
    assert(audioManager.getState().sleepTimer && audioManager.getState().sleepTimer.minutes === 30, 'Switch 开 → 按上次配置重开（兜底 15 分）');

    panel.onSelectSleepEpisodes({ currentTarget: { dataset: { count: 3 } } });
    assert(audioManager.getState().sleepTimer.mode === 'episodes' && audioManager.getState().sleepTimer.count === 3, '选「播完3集」→ applySleepConfig(episodes:3)');
    panel.onSelectEpisodeEnd();
    assert(audioManager.getState().sleepTimer.mode === 'episodeEnd', '选「播完整集声音再停止」→ episodeEnd');
    panel.onCloseSleepSheet();
    assert(panel.data.sleepSheetVisible === false, '定时弹层关闭');

    // —— 播放列表弹层：切播 ——
    panel.onOpenPlaylistSheet();
    assert(panel.data.playlistSheetVisible === true && panel.data.playlist.length === 2, '点「播放列表」→ 弹层展开（队列镜像）');
    panel.onPlaylistItemTap({ currentTarget: { dataset: { id: 'ep5' } } });
    await tick();
    assert(audioManager.getState().currentEpisode.episodeid === 'ep5', '点列表条目 → 切播 ep5');
    assert(audioManager.getState().isIntensiveMode === true, '播放列表切播 → 保留精听标记（同一精听会话内换集，标签不消失）');
    assert(panel.data.currentEpisodeId === 'ep5', '弹层当前集高亮跟随');
    panel.onClosePlaylistSheet();
    assert(panel.data.playlistSheetVisible === false, '播放列表弹层关闭');

    // —— 精听模式按钮：补标记 + 独立精听工作流页路由（3.B.4 起） ——
    await audioManager.playEpisode(EP('ep4'), { playlist: [EP('ep4')] }); // 普通起播复位标记
    await tick();
    navCalls.length = 0;
    panel.events.length = 0;
    panel.onOpenIntensive();
    assert(audioManager.getState().isIntensiveMode === true, '「精听模式」→ 补精听标记（对齐 Android setIntensiveMode）');
    assert(panel.events.includes('close'), '「精听模式」→ 触发 close（收起面板）');
    assert(navCalls[0] === '/pages/intensive-listening/index?id=ep4', '「精听模式」→ 跳转独立精听工作流页（原 practice 深链由 3.B.4 页承接）');

    // 栈顶守卫：已是本集精听页 → no-op，不重复入栈
    currentPages = [{
      route: 'pages/intensive-listening/index',
      options: { id: 'ep4' },
    }];
    navCalls.length = 0;
    panel.onOpenIntensive();
    assert(navCalls.length === 0, '守卫：栈顶即本集精听页 → 不重复入栈');
    currentPages = [];

    // —— 封面点按守卫（保留）——
    navCalls.length = 0;
    panel.events.length = 0;
    panel.onCoverTap();
    assert(panel.events.includes('close') && navCalls[0] === '/pages/episode/episode?id=ep4', '封面点按 → 收起面板 + navigateTo 剧集详情页');
    currentPages = [{ route: 'pages/episode/episode', options: { id: 'ep4' } }];
    navCalls.length = 0;
    panel.onCoverTap();
    assert(navCalls.length === 0, '封面守卫：栈顶即目标剧集页 → 不重复入栈');
    currentPages = [];

    // —— header close：收起并关闭播放器 ——
    panel.onClosePlayer();
    assert(panel.events.includes('close'), 'header close → 触发 close');
    assert(audioManager.getState().hasEpisode === false, 'header close → 关闭播放器（会话清空）');
  }

  section('五、WXML 结构断言（UI 减法 + 新增模块）');
  {
    const miniWxml = fs.readFileSync(path.join(__dirname, '../components/player/mini-player/index.wxml'), 'utf8');
    const panelWxml = fs.readFileSync(path.join(__dirname, '../components/player/player-panel/index.wxml'), 'utf8');
    const miniWxss = fs.readFileSync(path.join(__dirname, '../components/player/mini-player/index.wxss'), 'utf8');

    // 迷你条：「精听」标签 + 互斥 + mb-1 间距
    assert(miniWxml.includes('mp-intensive-tag') && miniWxml.includes('精听') && miniWxml.includes('graphic-eq-primary.svg'), '迷你条：副标题行前「精听」标签（GraphicEq 图标）');
    assert(miniWxml.includes('hasEpisode && !panelVisible'), '迷你条：面板展开时整条隐藏（互斥）');
    assert(miniWxss.includes('bottom: 2rpx'), '迷你条：tabBar 页与导航条间距固定 2rpx（视口底边即 tabBar 顶边，无额外偏移）');

    // 面板：新增功能模块
    ['播放列表', '定时关闭', '精听模式', 'queue-music.svg', 'alarm.svg', 'graphic-eq-white.svg',
      '上次定时', '按时间', '播完整集声音再停止', '播完本集', '自定义', '按集数', '精听中']
      .forEach((frag) => assert(panelWxml.includes(frag), `面板 WXML 含 ${frag}`));

    // 面板：旧模块已删（精读 pill / 字幕 / 悬浮迷你条）
    assert(!panelWxml.includes('精读') && !panelWxml.includes('pp-transcript') && !panelWxml.includes('showTranslation'), '面板：精读按钮与字幕模块已彻底移除');
    assert(!panelWxml.includes('pp-floating'), '面板：底部悬浮迷你控制条已移除（由精听模式按钮承接）');

    // 面板：顶部安全区内联留白（状态栏/胶囊避让）
    assert(panelWxml.includes('headerPadTop'), '面板：header 内联 padding-top={{headerPadTop}}px（动态安全区）');
  }

  section('六、单例路由 singletonNavigateTo（剧集↔精听乒乓压栈根治）');
  {
    const panel2 = makeInstance(panelDef);
    panel2._attached();
    const reloadSpy = [];

    // —— 工具直测：不存在 → 压栈；已存在 → 回退；栈顶 → no-op ——
    currentPages = [];
    navCalls.length = 0;
    backCalls.length = 0;
    let r = route.singletonNavigateTo('/pages/intensive-listening/index?id=ep4');
    assert(r.action === 'push' && navCalls[0] === '/pages/intensive-listening/index?id=ep4' && backCalls.length === 0,
      '栈内无目标页 → 正常 navigateTo 压栈');

    currentPages = [
      { route: 'pages/home/index' },
      { route: 'pages/episode/episode', options: { id: 'ep4' } },
      { route: 'pages/intensive-listening/index', options: { id: 'ep4' } },
    ];
    navCalls.length = 0;
    r = route.singletonNavigateTo('/pages/episode/episode?id=ep4');
    assert(r.action === 'back' && r.delta === 1 && navCalls.length === 0 && backCalls[backCalls.length - 1] === 1,
      '栈深处已有剧集页 → navigateBack({delta:1}) 回退，不压新页');

    // 重复层收拢：回退到最深处实例，其上重复层（含另一条剧集页）一并弹出
    currentPages = [
      { route: 'pages/home/index' },
      { route: 'pages/episode/episode', options: { id: 'ep4' } },
      { route: 'pages/intensive-listening/index', options: { id: 'ep4' } },
      { route: 'pages/episode/episode', options: { id: 'ep4' } },
    ];
    navCalls.length = 0;
    backCalls.length = 0;
    r = route.singletonNavigateTo('pages/episode/episode?id=ep4');
    assert(r.action === 'back' && r.delta === 2 && navCalls.length === 0 && backCalls[0] === 2,
      '栈内多条重复 → 回退最深处实例（delta=2 顺带收拢重复层）');

    currentPages = [{ route: 'pages/intensive-listening/index', options: { id: 'ep4' }, singletonReload(q) { reloadSpy.push(q); } }];
    navCalls.length = 0;
    backCalls.length = 0;
    r = route.singletonNavigateTo('/pages/intensive-listening/index?id=ep5');
    assert(r.action === 'noop' && navCalls.length === 0 && backCalls.length === 0,
      '栈顶已是目标页 → no-op（不压栈不回退）');
    assert(reloadSpy.length === 1 && reloadSpy[0].id === 'ep5',
      '换参 → 命中实例 singletonReload({id:"ep5"}) 就地重指（播放列表切集场景）');

    // —— 面板集成：乒乓链路不再产生重复层 ——
    await audioManager.playEpisode(EP('ep4'), { playlist: [EP('ep4'), EP('ep5')], intensive: true });
    await tick();

    // 精听页面板点封面 → 回退到栈内剧集页（原实现会压入重复剧集页）
    currentPages = [
      { route: 'pages/episode/episode', options: { id: 'ep4' } },
      { route: 'pages/intensive-listening/index', options: { id: 'ep4' } },
    ];
    navCalls.length = 0;
    backCalls.length = 0;
    panel2.onCoverTap();
    assert(panel2.events.includes('close') && navCalls.length === 0 && backCalls[backCalls.length - 1] === 1,
      '精听页面板点封面 → 收起面板 + navigateBack 回退到栈内剧集页（不压重复层）');

    // 播放列表切到 ep5 后，在精听页(ep4)再点「精听模式」→ no-op + 就地换集
    await audioManager.playEpisode(EP('ep5'), { playlist: [EP('ep5')], intensive: true });
    await tick();
    currentPages = [{ route: 'pages/intensive-listening/index', options: { id: 'ep4' }, singletonReload(q) { reloadSpy.push(q); } }];
    reloadSpy.length = 0;
    navCalls.length = 0;
    backCalls.length = 0;
    panel2.onOpenIntensive();
    assert(navCalls.length === 0 && backCalls.length === 0 && audioManager.getState().isIntensiveMode === true,
      '栈顶精听页(ep4) 再点「精听模式」(现播 ep5) → 补标记后 no-op，不压栈');
    assert(toastCalls.includes('已在精听页'),
      '栈顶 no-op → toast「已在精听页」点明单例语义');
    assert(reloadSpy.length === 1 && reloadSpy[0].id === 'ep5',
      '精听页实例 singletonReload 重指 ep5（不新开精听页实例）');

    audioManager.close();
    currentPages = [];
  }

  /* ==================== 汇总 ==================== */

  Date.now = realNow; // 还原时钟
  audioManager.close(); // 清理会话与定时 interval（防 Node 进程挂起）
  console.log(`\n========== 迷你播放条/全屏面板测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
