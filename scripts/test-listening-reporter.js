/**
 * scripts/test-listening-reporter.js — 收听时长心跳上报器测试（打卡数据源）
 *
 * 把门口径 = Android ListeningTimeReporter.kt / Web GlobalAudio 心跳：
 *   - 播放中 1s 墙钟计时，满 30s 批量 POST /api/auth/update-activity {seconds}
 *   - 暂停/停止冲刷余量；游客不计时；登出余量丢弃
 *   - 播放态接线：精研页页内 clip-player 的 onPlayingChanged 翻转驱动
 *     （原全局播放器六路事件联动已随整集链路退役，红线 2）
 *   - 主页脏刷新含 weekly-activity：打卡时间随收听时长更新
 *
 * 运行：node scripts/test-listening-reporter.js
 */

const fs = require('fs');
const path = require('path');

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

  console.log('== 精研页播放态接线（原全局播放器六路事件联动已随整集链路退役） ==');
  // 红线 2：wx.getBackgroundAudioManager 全局播放内核已删除
  ok(!fs.existsSync(path.join(__dirname, '../utils/audioManager.js')),
    'utils/audioManager.js 已退役（零后台整集播放内核）');
  // 新接线：精研页页内 clip-player 的 onPlayingChanged 翻转驱动心跳
  const intensiveSrc = fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/index.js'), 'utf8');
  ok(intensiveSrc.indexOf('listeningReporter.onPlaybackState(playing)') !== -1,
    '精研页 _onPlayingChanged → onPlaybackState(playing)（起播计时/停止冲刷）');
  ok(intensiveSrc.indexOf('this._player.stop()') !== -1,
    '页面卸载停止播放会话（联动冲刷余量）');

  console.log('');
  console.log('收听心跳：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('测试崩溃：', e); process.exit(1); });
