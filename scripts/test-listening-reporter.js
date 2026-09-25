/**
 * scripts/test-listening-reporter.js — 收听时长心跳上报器测试（打卡数据源）
 *
 * 把门口径 = Android ListeningTimeReporter.kt / Web GlobalAudio 心跳：
 *   - 播放中 1s 墙钟计时，满 30s 批量 POST /api/auth/update-activity {seconds}
 *   - 暂停/停止冲刷余量；游客不计时；登出余量丢弃
 *   - audioManager 六路播放事件（play/pause/stop/ended/error/close）联动
 *   - 主页脏刷新含 weekly-activity：打卡时间随收听时长更新
 *
 * 运行：node scripts/test-listening-reporter.js
 */

const storage = new Map();
const uploads = [];
let now = 0; // 可控时钟

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ statusBarHeight: 20, theme: 'light' }),
  getWindowInfo: () => ({ statusBarHeight: 20, windowWidth: 375 }),
  getMenuButtonBoundingClientRect: () => ({ left: 278 }),
  showToast() {},
  request(opt) {
    uploads.push({ url: opt.url, data: opt.data });
    setTimeout(() => opt.success({ statusCode: 200, data: { success: true } }), 1);
  },
};

// 可控 setInterval（模拟收听秒数推进）；setTimeout 保留真实实现（异步等待用）
const realSetTimeout = global.setTimeout;
const timers = [];
global.setInterval = (fn, ms) => { timers.push({ fn, ms, type: 'i' }); return timers.length - 1; };
global.clearInterval = (id) => { if (timers[id]) timers[id].dead = true; };
/** 推进 ms 毫秒的模拟时钟 */
function advance(ms) {
  const ticks = Math.floor(ms / 1000); // 心跳 1s/次；advance(29999)=29 次防满批
  for (let t = 0; t < ticks; t += 1) {
    timers.forEach((tm) => {
      if (!tm.dead && tm.type === 'i') tm.fn();
    });
  }
}

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}
function uploadsFor() { return uploads.filter((u) => u.url.endsWith('/api/auth/update-activity')); }

const reporter = require('../utils/listening-reporter');

(async () => {
  console.log('== 播放中 30s 批量上报 ==');
  reporter._reset(); uploads.length = 0; timers.length = 0;
  storage.set('token', 'tk');
  reporter.start();
  reporter.onPlaybackState(true);
  advance(29000);
  ok(uploadsFor().length === 0, '29s 不满批不上报');
  advance(1000);
  ok(uploadsFor().length === 1 && uploadsFor()[0].data.seconds === 30, '满 30s 上报一批 {seconds:30}');

  console.log('== 暂停冲刷余量 ==');
  advance(12000); // 再听 12s
  reporter.onPlaybackState(false);
  await new Promise((r) => setTimeout(r, 5));
  ok(uploadsFor().length === 2 && uploadsFor()[1].data.seconds === 12, '暂停冲刷 12s 余量');
  reporter.onPlaybackState(false);
  await new Promise((r) => setTimeout(r, 5));
  ok(uploadsFor().length === 2, '余量 0 时再停是 no-op（不重复上报）');

  console.log('== 续播跨批累计 ==');
  reporter.onPlaybackState(true);
  advance(65000);
  ok(uploadsFor().length === 4 && uploadsFor()[2].data.seconds === 30 && uploadsFor()[3].data.seconds === 30,
    '连续播放 65s → 两整批（余 5s 未报）：实际 ' + JSON.stringify(uploadsFor().map((u) => u.data.seconds)));

  console.log('== 游客不计时 ==');
  reporter._reset(); uploads.length = 0; timers.length = 0;
  storage.delete('token');
  reporter.start();
  reporter.onPlaybackState(true);
  advance(60000);
  reporter.onPlaybackState(false);
  ok(uploadsFor().length === 0, '无 token 全程零上报');

  console.log('== 登出余量丢弃 ==');
  reporter._reset(); uploads.length = 0; timers.length = 0;
  storage.set('token', 'tk');
  reporter.start();
  reporter.onPlaybackState(true);
  advance(20000);
  storage.delete('token'); // 播放中登出
  reporter.onPlaybackState(false);
  ok(uploadsFor().length === 0, '登出后冲刷分支丢弃 20s（不误记到后续账号）');

  console.log('== audioManager 六路事件联动 ==');
  // 重新加载模块（audioManager 在文件加载时不依赖 wx 音频实例，init 才创建）
  const bgmHandlers = {};
  const bgm = {
    onPlay(cb) { bgmHandlers.play = cb; },
    onPause(cb) { bgmHandlers.pause = cb; },
    onStop(cb) { bgmHandlers.stop = cb; },
    onEnded(cb) { bgmHandlers.ended = cb; },
    onError(cb) { bgmHandlers.error = cb; },
    onTimeUpdate() {},
    onCanplay() {},
    onWaiting() {},
    onPrev() {},
    onNext() {},
  };
  global.wx.getBackgroundAudioManager = () => bgm;
  let audioManager;
  try { delete require.cache[require.resolve('../utils/audioManager')]; } catch (e) {}
  audioManager = require('../utils/audioManager');
  audioManager.init();

  reporter._reset(); uploads.length = 0; timers.length = 0;
  storage.set('token', 'tk');
  bgmHandlers.play();
  advance(30000);
  bgmHandlers.pause();
  await new Promise((r) => setTimeout(r, 5));
  ok(uploadsFor().length === 1 && uploadsFor()[1 - 1].data.seconds === 30, 'onPlay→onPause 心跳链路（bgm 事件驱动上报）');

  uploads.length = 0;
  bgmHandlers.play();
  advance(15000);
  bgmHandlers.ended();
  await new Promise((r) => setTimeout(r, 5));
  ok(uploadsFor().length === 1 && uploadsFor()[0].data.seconds === 15,
    '播完 onEnded 冲刷 15s（打卡时长落账）：实际 ' + JSON.stringify(uploadsFor().map((u) => u.data.seconds)));

  console.log('');
  console.log('收听心跳：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
