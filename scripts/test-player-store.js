/**
 * scripts/test-player-store.js — 播放状态镜像 store（3.B.2）自动化测试
 *
 * mock wx.getBackgroundAudioManager，驱动 utils/audioManager → store/playerStore：
 * 覆盖全事件镜像（起播/播放/暂停/进度时长/seek）、锁屏三键回调链
 * （onPrev/onNext 切曲、onPause 暂停）、ended 自动连播、订阅/退订模式。
 * playerStore 为只读镜像（播放命令走 audioManager，状态经事件回流，永不分叉）。
 *
 * 运行：node scripts/test-player-store.js
 */

/* ==================== mock 基础设施 ==================== */

const path = require('path');

const bgmCalls = { src: null, rates: [], seeks: [] };
const bgmHandlers = {};
const bgm = {
  currentTime: 0,
  duration: 0,
  play() { bgmHandlers.play && bgmHandlers.play(); },
  pause() { bgmHandlers.pause && bgmHandlers.pause(); },
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
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (p === '/api/episode/subtitles') {
      opts.success({ statusCode: 200, data: { audioUrl: 'https://oss/a.m4a' } });
      return;
    }
    opts.success({ statusCode: 200, data: { success: true } });
  },
  getBackgroundAudioManager: () => bgm,
};

/* ==================== 加载被测模块 ==================== */

const audioManager = require(path.join(__dirname, '../utils/audioManager'));
audioManager.init(); // 生产链路由 app.js onLaunch 调用
const playerStore = require(path.join(__dirname, '../store/playerStore')); // require 即订阅镜像

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

const EP = (id) => ({ episodeid: id, title: 'Episode ' + id, audioUrl: 'https://oss/' + id + '.m4a', podcastTitle: 'P' });
const PLAYLIST = [EP('ep1'), EP('ep2'), EP('ep3')];

/* ==================== 用例 ==================== */

(async () => {
  section('一、全事件镜像（audioManager 事实源 → playerStore）');
  {
    assert(playerStore.getState().hasEpisode === false, '初始态 hasEpisode=false');

    let notified = 0;
    const unsubscribe = playerStore.subscribe(() => { notified += 1; });

    await audioManager.playEpisode(PLAYLIST[0], { playlist: PLAYLIST });
    await tick();
    const s1 = playerStore.getState();
    assert(s1.hasEpisode === true && s1.currentEpisode.episodeid === 'ep1', '起播 → currentEpisode 镜像（episodeChange）');
    assert(s1.playlist.length === 3, '播放列表镜像');

    bgmHandlers.play();
    assert(playerStore.getState().isPlaying === true, '播放事件 → isPlaying=true');

    bgm.currentTime = 100;
    bgm.duration = 600;
    bgmHandlers.timeupdate();
    assert(playerStore.getState().currentTime === 100 && playerStore.getState().duration === 600, 'timeupdate → 进度/时长镜像（供跨页组件订阅）');

    audioManager.seek(250);
    assert(playerStore.getState().currentTime === 250, 'seek 命令 → 进度即时镜像');

    assert(notified >= 4, `订阅者在每次状态变化均被通知（已通知 ${notified} 次）`);
    unsubscribe();
  }

  section('二、锁屏三键回调链（bgm.onPrev/onNext/onPause）');
  {
    // 锁屏「下一首」
    bgmHandlers.next();
    await tick();
    assert(playerStore.getState().currentEpisode.episodeid === 'ep2', '锁屏 onNext → playNext 切 ep2（store 同步）');

    // 锁屏「上一首」
    bgmHandlers.prev();
    await tick();
    assert(playerStore.getState().currentEpisode.episodeid === 'ep1', '锁屏 onPrev → playPrevious 回 ep1');

    // 锁屏/控制中心「暂停」
    bgmHandlers.pause();
    assert(playerStore.getState().isPlaying === false, '锁屏 onPause → isPlaying=false');

    // 播完自动连播（ended → playNext）
    bgmHandlers.ended();
    await tick();
    assert(playerStore.getState().currentEpisode.episodeid === 'ep2', 'onEnded → 自动连播 ep2');
  }

  section('三、订阅/退订模式（与 authStore 同款）');
  {
    let calls = 0;
    const unsub = playerStore.subscribe(() => { calls += 1; });
    bgmHandlers.play();
    assert(calls === 1, '订阅后收到通知');
    unsub();
    bgmHandlers.pause();
    assert(calls === 1, '退订后不再通知（返回取消函数）');

    // store 与事实源一致性：直接比对 audioManager 快照
    const a = audioManager.getState();
    const p = playerStore.getState();
    assert(a.currentEpisode.episodeid === p.currentEpisode.episodeid && a.isPlaying === p.isPlaying &&
      a.currentTime === p.currentTime && a.duration === p.duration, 'store 快照与 audioManager.getState() 全字段一致（永不分叉）');
  }

  /* ==================== 汇总 ==================== */

  console.log(`\n========== playerStore 镜像测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
