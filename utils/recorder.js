/**
 * utils/recorder.js — 复习模块录音底座（REVIEW-TASK T3.1）
 *
 * 抽取 pages/speech-eval 已过七轮真机验证的录音链路为共享模块，
 * 供 T3.2 eval-card / T3.4 shadowing / T4.5 practice 复用：
 *
 * - PCM 直录（16kHz / mono / frameSize 1KB≈32ms）+ onFrameRecorded 实时帧流
 *   ——波形音量（100ms 节流）与停止产物同源；**不用 format:'wav' 直录**
 *   （清单原始规格，真机教训：WAV 直录拿不到实时帧，且 onStop 兑底复杂）
 * - **停止不依赖 onStop**：真机 PCM stop() 后 onStop 可能不回调——
 *   stop() 直取内存帧出结果，仍调 rm.stop() 释放麦克风；onStop 仅作
 *   兜底入口（60s 时限到点自动停止 / 帧缺失时读 tempFilePath 文件）
 * - 产物：PCM → WAV（speech-core.pcmToWav 端内封装）→ 落盘 USER_DATA_PATH
 *   （既是评测上传源也是回放源，自动回收上一份）→ base64
 * - 权限三段：getSetting 已授权直过 / 拒绝过 → modal 引导 openSetting /
 *   未询问 → authorize；文案默认「需要麦克风权限才能进行跟读评测」（可配）
 * - 录音前 audioBus.stopAll() 停全部发声源（BGM/TTS/片段——iOS 录音播放互斥）
 *
 * 模块级单例（getRecorderManager 本身全局单例），事件只注册一次；
 * 会话令牌防跨页串流，迟到帧一律丢弃。
 */
const core = require('./speech-core');
const audioBus = require('./audio-bus');

const PCM_RATE = 16000;
const MIN_INTERVAL_MS = 100; // 音量回调节流

let rm = null;
let started = false; // 事件是否已注册（单例只注册一次）
let session = 0; // 会话令牌：start 递增，迟到事件按令牌丢弃
let frames = null; // 当前会话 PCM 帧缓冲（null = 未在录/已收尾）
let lastAmpAt = 0;
let pending = null; // stop() 的 resolve（onStop 兜底路径回填 tempFilePath 用）
let recording = false;

const ampListeners = new Set();

function getState() {
  return { recording };
}

function onAmplitude(fn) {
  ampListeners.add(fn);
  return () => ampListeners.delete(fn);
}

function notifyAmplitude(v) {
  for (const fn of Array.from(ampListeners)) {
    try {
      fn(v);
    } catch (e) {
      // 单个监听器异常不影响其他
    }
  }
}

/** 麦克风权限三段校验（speech-eval _ensureRecordPermission 同款） */
function ensurePermission(opts) {
  const texts = (opts && opts.texts) || {};
  const modalContent = texts.modalContent || '需要麦克风权限才能进行跟读评测';
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const auth = (res && res.authSetting) || {};
        if (auth['scope.record'] === true) return resolve(true);
        if (auth['scope.record'] === false) {
          wx.showModal({
            title: '麦克风权限',
            content: modalContent,
            confirmText: '去设置',
            success: (r) => {
              if (!r.confirm) return resolve(false);
              wx.openSetting({
                success: (s2) =>
                  resolve(!!(s2.authSetting && s2.authSetting['scope.record'])),
                fail: () => resolve(false),
              });
            },
            fail: () => resolve(false),
          });
          return;
        }
        wx.authorize({
          scope: 'scope.record',
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      },
      fail: () => resolve(false),
    });
  });
}

function ensureRecorder() {
  if (rm) return rm;
  rm = wx.getRecorderManager();
  if (!started) {
    started = true;
    rm.onStart(() => {
      // onStart 只在真正起录后触发（权限拒绝不会到这里）
      recording = true;
    });
    rm.onFrameRecorded((res) => {
      if (!frames) return; // 已停止/已收尾：丢弃迟到帧
      frames.push(res.frameBuffer);
      const now = Date.now();
      if (now - lastAmpAt >= MIN_INTERVAL_MS) {
        lastAmpAt = now;
        notifyAmplitude(core.frameAmplitude(res.frameBuffer));
      }
    });
    // onStop 仅兜底：真机 PCM stop() 后本回调可能不触发。stop() 主路径
    // 直取内存帧已出结果；这里只为「帧缺失」场景回填 tempFilePath
    rm.onStop((res) => {
      recording = false;
      if (pending && pending.session === session) {
        const settle = pending;
        pending = null;
        settle.withTempFile(res && res.tempFilePath);
      }
    });
    rm.onError(() => {
      recording = false;
      frames = null;
      pending = null;
      if (ampListeners.size) notifyAmplitude(0);
    });
  }
  return rm;
}

/**
 * 开始录音。返回 true/false（权限或启动失败为 false，toast 由调用方决定）。
 * @param {Object} [opts]
 * @param {boolean} [opts.ensurePerm=true] 调用方已自行校验权限时可传 false
 */
function start(opts) {
  if (recording) return false; // 防重复起录
  const doStart = () => {
    // 录音前停全部发声源（iOS 录音/播放互斥：BGM/TTS/原声片段）
    audioBus.stopAll();
    session += 1;
    frames = [];
    lastAmpAt = 0;
    try {
      ensureRecorder().start({
        format: 'PCM', // 实时帧 → 音量波形 + 停止时端内封装 WAV
        sampleRate: PCM_RATE,
        numberOfChannels: 1,
        frameSize: 1, // 1KB/帧 ≈ 32ms
        duration: 60000, // 60s 上限：到点自动停止（onStop 兜底）
      });
      recording = true;
      return true;
    } catch (e) {
      frames = null;
      recording = false;
      return false;
    }
  };
  if (opts && opts.ensurePerm === false) return doStart();
  return ensurePermission(opts).then((ok) => (ok ? doStart() : false));
}

/**
 * 停止录音并取产物（用户点击主路径——**不等待 onStop**）：
 * 直取内存 PCM 帧 → WAV 落盘（自动回收上一份）→ base64。
 * 帧全缺时兜底等 onStop 的 tempFilePath 读文件（个别机型不回调帧事件）。
 * @returns {Promise<{base64: string, duration: number, wavPath: string, bytes: number}>}
 *          帧全空时 base64=''、duration=0（「录音太短」判定交调用方）
 */
function stop() {
  if (!recording && !frames) {
    return Promise.resolve({ base64: '', duration: 0, wavPath: '', bytes: 0 });
  }
  const mySession = session;
  const collected = frames || [];
  frames = null; // 迟到帧一律丢弃
  recording = false;
  try {
    rm && rm.stop(); // 释放麦克风；评测不依赖其回调
  } catch (e) {
    /* stop 失败不影响内存帧产物 */
  }

  return new Promise((resolve) => {
    const finish = (extraBuf) => {
      const all = extraBuf ? collected.concat([extraBuf]) : collected;
      resolve(buildResult(all));
    };
    if (collected.length > 0) {
      finish(null); // 主路径：内存帧直接出结果
      return;
    }
    // 帧缺失：等 onStop 回填 tempFilePath（1.5s 超时兜底，防永挂）
    let settled = false;
    pending = {
      session: mySession,
      withTempFile(tempFilePath) {
        if (settled) return;
        settled = true;
        let buf = null;
        if (tempFilePath) {
          try {
            buf = wx.getFileSystemManager().readFileSync(tempFilePath);
          } catch (e) {
            /* 兜底失败 → 空产物 */
          }
        }
        finish(buf && buf.byteLength ? buf : null);
      },
    };
    setTimeout(() => {
      if (settled) return;
      settled = true;
      pending = null;
      finish(null);
    }, 1500);
  });
}

/** 丢弃当前录音（不产出，直接停止释放麦克风） */
function cancel() {
  frames = null;
  recording = false;
  pending = null;
  try {
    rm && rm.stop();
  } catch (e) {
    /* 忽略 */
  }
}

/** PCM 帧序列 → WAV 落盘 + base64 + 时长（16kHz/mono/16bit → bytes/32000 秒） */
let lastWavPath = '';
function buildResult(allFrames) {
  let total = 0;
  for (let i = 0; i < allFrames.length; i++) total += allFrames[i].byteLength;
  if (!total) return { base64: '', duration: 0, wavPath: '', bytes: 0 };
  try {
    const wav = core.pcmToWav(allFrames, PCM_RATE);
    const fs = wx.getFileSystemManager();
    const wavPath = wx.env.USER_DATA_PATH + '/recorder_' + Date.now() + '.wav';
    fs.writeFileSync(wavPath, wav, 'binary');
    const base64 = fs.readFileSync(wavPath, 'base64');
    // 只保留最近一份录音，回收旧文件
    if (lastWavPath && lastWavPath !== wavPath) {
      try { fs.unlinkSync(lastWavPath); } catch (e) { /* 忽略 */ }
    }
    lastWavPath = wavPath;
    return { base64, duration: total / (PCM_RATE * 2), wavPath, bytes: total };
  } catch (e) {
    return { base64: '', duration: total / (PCM_RATE * 2), wavPath: '', bytes: total };
  }
}

module.exports = {
  PCM_RATE,
  ensurePermission,
  start,
  stop,
  cancel,
  getState,
  onAmplitude,
};
