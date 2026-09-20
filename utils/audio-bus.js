/**
 * utils/audio-bus.js — 复习模块音频互斥总线
 *
 * TTS 朗读（tts.js）、原声片段（audio-clip.js）共用；任何一方开播前
 * stopAll() 停掉其余发声源（含全局背景播放器 audioManager），
 * 保证同一时刻只有一个声音——对齐 Web 端各 hook 里 onBeforePlay /
 * stopAllAudio 的分散约定，集中为一条总线，避免两两 require 形成环。
 */
const audioManager = require('./audioManager');

const stoppers = new Set();

// 全局背景播放器（剧集整集播放）天然参与互斥：短音频开播前先暂停它
stoppers.add(function pauseGlobalPlayer() {
  try {
    audioManager.pause();
  } catch (e) {
    // 播放器未初始化等情况静默
  }
});

/** 注册一个"停止自己"的函数，返回取消注册函数 */
function register(fn) {
  stoppers.add(fn);
  return () => stoppers.delete(fn);
}

/** 停掉除 exceptFn 外的所有发声源 */
function stopAll(exceptFn) {
  for (const fn of Array.from(stoppers)) {
    if (fn !== exceptFn) {
      try {
        fn();
      } catch (e) {
        // 单个停止失败不影响其他
      }
    }
  }
}

module.exports = { register, stopAll };
