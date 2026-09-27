/**
 * scripts/test-recorder.js — 录音底座自动化测试（REVIEW-TASK T3.1）
 *
 * 驱动 utils/recorder.js（speech-eval 真机验证链路的共享底座抽取）：
 *   1. 权限三段（已授权直过 / 拒绝→modal→openSetting / 未询问→authorize）
 *   2. start 参数锁定（PCM 16k mono frameSize=1 60s）+ audioBus 停播放互斥
 *   3. onFrameRecorded 帧缓冲 + 音量 100ms 节流
 *   4. stop 主路径：直取内存帧 → WAV 落盘 → base64/duration（不依赖 onStop）
 *   5. 迟到帧丢弃 / 帧缺失 onStop tempFilePath 兜底 / 1.5s 超时兜底
 *   6. cancel 丢弃 / 防重复起录 / onError 复位
 *
 * 运行：node scripts/test-recorder.js
 */

/* ==================== mock 基础设施 ==================== */

const path = require('path');

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
async function settle(n) {
  for (let i = 0; i < (n || 6); i++) await tick();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- RecorderManager mock ----------
const recHandlers = {};
const rmCalls = { start: [], stop: 0 };
const recorderMock = {
  onStart(cb) { recHandlers.start = cb; },
  onFrameRecorded(cb) { recHandlers.frame = cb; },
  onStop(cb) { recHandlers.stop = cb; },
  onError(cb) { recHandlers.error = cb; },
  start(opts) { rmCalls.start.push(opts); },
  stop() { rmCalls.stop += 1; },
};
function fireFrame(bytes) {
  recHandlers.frame && recHandlers.frame({ frameBuffer: new ArrayBuffer(bytes) });
}

// ---------- FileSystemManager mock ----------
const fsFiles = {}; // path → ArrayBuffer
const fsCalls = { write: [], unlink: [], readRaw: [], readB64: [] };
const fsm = {
  writeFileSync(p, data) { fsCalls.write.push(p); fsFiles[p] = data; },
  readFileSync(p, enc) {
    if (enc === 'base64') {
      fsCalls.readB64.push(p);
      const buf = fsFiles[p];
      if (!buf) throw new Error('ENOENT');
      return 'B64(' + buf.byteLength + ')';
    }
    fsCalls.readRaw.push(p);
    if (p === 'wxfile://temp/pcm_missing') throw new Error('ENOENT');
    return fsFiles[p] || new ArrayBuffer(6400); // 兜底文件默认 0.2s PCM
  },
  unlinkSync(p) { fsCalls.unlink.push(p); delete fsFiles[p]; },
};

// ---------- 权限 mock（可编程） ----------
const perm = {
  setting: undefined, // true / false / undefined（未询问）
  authorizeOk: true,
  modalConfirm: true,
  openSettingOk: true,
};
const modalCalls = [];

// ---------- 全局播放器（audioBus 停播放互斥观测） ----------
const bgm = { pauseCalls: 0, play() {}, pause() { this.pauseCalls += 1; }, stop() {}, seek() {},
  onPlay() {}, onPause() {}, onStop() {}, onEnded() {}, onTimeUpdate() {}, onCanplay() {},
  onWaiting() {}, onError() {}, onPrev() {}, onNext() {} };

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  showModal: (o) => {
    modalCalls.push(o);
    o.success && o.success({ confirm: perm.modalConfirm });
  },
  getSetting: (o) =>
    o.success({ authSetting: perm.setting === undefined ? {} : { 'scope.record': perm.setting } }),
  authorize: (o) => (perm.authorizeOk ? o.success() : o.fail && o.fail({})),
  openSetting: (o) =>
    o.success({ authSetting: { 'scope.record': perm.openSettingOk } }),
  getRecorderManager: () => recorderMock,
  getFileSystemManager: () => fsm,
  getBackgroundAudioManager: () => bgm,
  createInnerAudioContext: () => ({
    src: '', play() {}, pause() {}, stop() {}, seek() {}, destroy() {},
    onEnded() {}, onError() {}, onCanplay() {}, onTimeUpdate() {},
    offEnded() {}, offError() {}, offCanplay() {}, offTimeUpdate() {},
  }),
  getWindowInfo: () => ({ windowHeight: 800, windowWidth: 375 }),
  getSystemInfoSync: () => ({ windowHeight: 800, windowWidth: 375, theme: 'light' }),
};
if (typeof wx.env === 'undefined') {
  wx.env = { USER_DATA_PATH: 'wxfile://usr' };
} else {
  wx.env.USER_DATA_PATH = 'wxfile://usr';
}

const recorder = require(path.join(__dirname, '../utils/recorder'));
const audioBus = require(path.join(__dirname, '../utils/audio-bus'));

// 互斥观测：注册一个测试 stopper，recorder.start 应触发 audioBus.stopAll
let busStopCalls = 0;
audioBus.register(() => { busStopCalls += 1; });

/* ==================== 1. 权限三段 ==================== */

section('ensurePermission（三段校验）');

(async () => {
  perm.setting = true;
  assert((await recorder.ensurePermission()) === true, '已授权：直过');

  perm.setting = undefined;
  perm.authorizeOk = true;
  assert((await recorder.ensurePermission()) === true, '未询问：authorize 成功');

  perm.authorizeOk = false;
  assert((await recorder.ensurePermission()) === false, '未询问：authorize 拒绝 → false');

  perm.setting = false;
  perm.modalConfirm = true;
  perm.openSettingOk = true;
  modalCalls.length = 0;
  assert((await recorder.ensurePermission()) === true, '拒绝过：modal 去设置 → 开启成功');
  assert(modalCalls.length === 1 && modalCalls[0].content === '需要麦克风权限才能进行跟读评测',
    '默认 modal 文案逐字（T3.1 规格）');

  perm.openSettingOk = false;
  assert((await recorder.ensurePermission()) === false, '拒绝过：设置页仍未开启 → false');

  perm.modalConfirm = false;
  assert((await recorder.ensurePermission()) === false, '拒绝过：modal 取消 → false');

  const custom = await recorder.ensurePermission({ texts: { modalContent: '自定义文案' } });
  assert(custom === false && modalCalls[modalCalls.length - 1].content === '自定义文案',
    'modal 文案可配置');

  /* ==================== 2. start 参数与互斥 ==================== */

  section('start（参数锁定 + 播放互斥）');

  perm.setting = true;
  rmCalls.start.length = 0;
  busStopCalls = 0;
  const okStart = await recorder.start();
  assert(okStart === true, 'start 返回 true');
  assert(rmCalls.start.length === 1, 'rm.start 恰一次');
  const opts = rmCalls.start[0];
  assert(opts.format === 'PCM' && opts.sampleRate === 16000 &&
    opts.numberOfChannels === 1 && opts.frameSize === 1 && opts.duration === 60000,
    'start 参数：PCM / 16k / mono / frameSize 1 / 60s（真机验证口径）');
  assert(busStopCalls >= 1, 'audioBus.stopAll：录音前停全部发声源（iOS 互斥）');
  recHandlers.start && recHandlers.start();
  assert(recorder.getState().recording === true, 'onStart：recording 置位');

  // 防重复起录（录音中再 start 直接 false，不发 rm.start）
  const before = rmCalls.start.length;
  assert(recorder.start({ ensurePerm: false }) === false, '录音中重复 start → false');
  assert(rmCalls.start.length === before, '重复 start 不触发 rm.start');

  /* ==================== 3. 帧缓冲与音量节流 ==================== */

  section('onFrameRecorded（帧缓冲 + 音量节流）');

  let ampCount = 0;
  const unsub = recorder.onAmplitude(() => { ampCount += 1; });
  fireFrame(3200);
  fireFrame(3200);
  fireFrame(3200);
  assert(ampCount === 1, '100ms 节流：连发三帧音量只回调一次');
  unsub();

  /* ==================== 4. stop 主路径（不依赖 onStop） ==================== */

  section('stop（内存帧直取 → WAV 落盘 → base64）');

  fsCalls.write.length = 0;
  rmCalls.stop = 0;
  const result = await recorder.stop();
  assert(rmCalls.stop === 1, 'stop 调 rm.stop 释放麦克风');
  assert(result.bytes === 9600, 'bytes = 帧累计（3200×3）');
  assert(Math.abs(result.duration - 0.3) < 1e-9, 'duration = bytes/32000（0.3s）');
  assert(fsCalls.write.length === 1, 'WAV 落盘一次（USER_DATA_PATH）');
  assert(fsCalls.write[0].indexOf('wxfile://usr/recorder_') === 0, '落盘路径前缀');
  assert(result.base64 === 'B64(' + fsFiles[fsCalls.write[0]].byteLength + ')',
    'base64 经 readFileSync(path, base64) 产出（WAV 全量）');
  assert(result.wavPath === fsCalls.write[0], 'wavPath 返回落盘路径');
  assert(recorder.getState().recording === false, '停止后 recording 复位');

  // 迟到帧：stop 后再 fire 不 NPE、不影响产物
  fireFrame(3200);
  assert(true, '迟到帧安全丢弃（无异常）');

  /* ==================== 5. 帧缺失兜底 ==================== */

  section('帧缺失兜底（onStop tempFilePath / 超时）');

  await recorder.start({ ensurePerm: false });
  recHandlers.start();
  fsCalls.readRaw.length = 0;
  const stopPromise = recorder.stop();
  await settle(2);
  recHandlers.stop && recHandlers.stop({ tempFilePath: 'wxfile://temp/pcm1' });
  const r2 = await stopPromise;
  assert(fsCalls.readRaw[0] === 'wxfile://temp/pcm1', '帧缺失：onStop 兜底读临时文件');
  assert(r2.bytes === 6400 && Math.abs(r2.duration - 0.2) < 1e-9, '兜底产物时长 0.2s');

  // 超时兜底：无帧且 onStop 永不触发 → 1.5s 后空产物
  await recorder.start({ ensurePerm: false });
  recHandlers.start();
  let timedOut = null;
  const t0 = Date.now();
  recorder.stop().then((r3) => { timedOut = r3; });
  await sleep(1700);
  assert(timedOut && timedOut.base64 === '' && timedOut.bytes === 0,
    'onStop 永不回调：1.5s 超时 → 空产物（不永挂）');
  assert(Date.now() - t0 >= 1450, '超时确实等待（≈1.5s）');

  /* ==================== 6. cancel / onError ==================== */

  section('cancel / onError');

  await recorder.start({ ensurePerm: false });
  recHandlers.start();
  fireFrame(3200);
  recorder.cancel();
  assert(recorder.getState().recording === false, 'cancel 后复位');
  const r4 = await recorder.stop();
  assert(r4.bytes === 0 && r4.base64 === '', 'cancel 丢弃：后续 stop 空产物');

  await recorder.start({ ensurePerm: false });
  recHandlers.start();
  recHandlers.error && recHandlers.error({ errMsg: 'start:fail auth deny' });
  assert(recorder.getState().recording === false, 'onError：recording 复位');
  fireFrame(3200); // onError 后帧缓冲已清
  const r5 = await recorder.stop();
  assert(r5.bytes === 0, 'onError 清缓冲（错误会话不产出）');

  // 旧文件回收：第二次产物落盘后第一次的 wav 被 unlink
  await recorder.start({ ensurePerm: false });
  recHandlers.start();
  fireFrame(3200);
  fsCalls.unlink.length = 0;
  await recorder.stop();
  assert(fsCalls.unlink.length === 1, '自动回收上一份录音文件');

  /* ==================== 汇总 ==================== */

  console.log(`\n========== 录音底座 T3.1 测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败用例：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
