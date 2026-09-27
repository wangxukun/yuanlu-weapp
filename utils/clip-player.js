/**
 * utils/clip-player.js — 窗口化单实例音频播放内核（REVIEW-TASK T3.2）
 *
 * 参数化移植 pages/speech-eval 的 _playUrl（七轮真机验证结晶，页面本身
 * 暂不切换接入——短期两份并存，后续统一收口到本模块）：
 *
 * 句界精度 = 重建"精确 currentPosition"（Android MediaPlayer 等价）：
 *   ① 起播锚定 ctx.startTime（等价 prepare→seekTo→start，无 seek 竞态）；
 *      首帧回报比句首早 0.5s 以上才判「startTime 被平台忽略」补一次 seek——
 *      不可与墙钟期望比较（真机暖缓存首帧回报延迟且快照陈旧，误判会造成
 *      句首 ~1s 重播）
 *   ② 实时锚点只许前跳、不许回拖：外推以墙钟为轴 pos = anchor +
 *      (now - anchorAt)×rate，免疫事件管线延迟；onTimeUpdate 回报领先外推
 *      > 0.02s 才前跳校准（上限 1.0s 防野值）；回报落后 = 陈旧快照一律忽略
 *   ③ 50ms 看门狗：外推位置 ≥ endSec 即停（落点误差 ~100ms 级）；
 *      onWaiting（缓冲停顿）冻结判停与外推，恢复需「位置确有推进 +
 *      距停顿 >200ms」双判据
 *   ④ 慢速倍速只在 onPlay 后设置（提前设置部分平台忽略或重置进度回 0）
 *
 * 与 audio-clip.js 的分工：audio-clip 是全局单例的"字幕定位片段播放器"
 * （互斥总线成员）；clip-player 是页面/组件私有的"URL 直连窗口播放器"
 * （原声/慢速/录音回放/词级对比四路共用，起播前同样 stopAll 互斥）。
 */
const audioBus = require('./audio-bus');

/**
 * 创建一个私有播放器实例（组件/页面各持一个）。
 * @param {Object} [hooks]
 * @param {Function} [hooks.onPlaying] (kind|null) => void —— 播放态变化
 * @param {Function} [hooks.onTick] (posSec) => void —— 50ms 位置回调（词级扫光用）
 * @param {Function} [hooks.onEnded] (kind) => void —— 自然到窗终/播完停止
 */
function createClipPlayer(hooks) {
  const cb = hooks || {};
  let audio = null;
  let kind = null;
  let startSec = 0;
  let endSec = null;
  let rate = 0;
  let anchorAt = 0;
  let anchorPos = 0;
  let stalledAt = 0;
  let landingChecked = false;
  let lastReported = 0;
  let watchdog = null;

  function notifyPlaying(k) {
    if (typeof cb.onPlaying === 'function') {
      try { cb.onPlaying(k); } catch (e) { /* 回调异常不阻断 */ }
    }
  }

  function clearWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  /** 外推位置；null = 尚未起播或缓冲停顿中（播放头未推进，不参与判停） */
  function estimatedPos() {
    if (!anchorAt || stalledAt) return null;
    return anchorPos + ((Date.now() - anchorAt) / 1000) * (rate || 1);
  }

  function stop() {
    startSec = 0;
    endSec = null;
    rate = 0;
    anchorAt = 0;
    anchorPos = 0;
    stalledAt = 0;
    landingChecked = false;
    lastReported = 0;
    clearWatchdog();
    const ctx = audio;
    audio = null;
    const finishedKind = kind;
    kind = null;
    if (ctx) {
      try {
        ctx.offCanplay(); ctx.offTimeUpdate(); ctx.offEnded(); ctx.offError();
        ctx.offPlay && ctx.offPlay();
        ctx.offWaiting && ctx.offWaiting();
      } catch (e) { /* 低版本基础库 off* 缺失时忽略 */ }
      try { ctx.stop(); ctx.destroy(); } catch (e) { /* 忽略 */ }
    }
    if (finishedKind !== null) notifyPlaying(null);
    return finishedKind;
  }

  /**
   * 播放一段 URL（可带窗口与倍速；同 kind 再点由调用方自行 toggle）。
   * @param {string} url 音源（OSS 直链 / 本地 wav 路径 / dictvoice 直链）
   * @param {string} playKind 播放标识（'original'/'slow'/'user'/'word_us'...）
   * @param {Object} [opts] { startSec, endSec, rate }
   */
  function playUrl(url, playKind, opts) {
    if (!url) return;
    if (/\.mp3(\?|$)/i.test(url.split('?')[0] + '')) {
      // 旧批次 mp3 的 seek 落点先天不准（新批次已迁 m4a），告警不阻断
      console.warn('[clip-player] 旧批次 mp3 音源，seek 精度可能不准：', url.slice(0, 80));
    }
    audioBus.stopAll(); // 停全局播放器 / TTS / 原声片段（互斥总线）
    stop();
    const o = opts || {};
    const ctx = wx.createInnerAudioContext();
    audio = ctx;
    kind = playKind;
    startSec = o.startSec > 0 ? o.startSec : 0;
    endSec = o.endSec != null && isFinite(o.endSec) ? o.endSec : null;
    rate = o.rate && o.rate !== 1 ? o.rate : 0;
    anchorPos = startSec; // 外推锚点（起播前先按预期落点占位）
    anchorAt = 0;

    if (startSec > 0) ctx.startTime = startSec;
    ctx.src = url;
    ctx.onCanplay(() => {
      if (audio !== ctx) return;
      ctx.play();
      notifyPlaying(kind);
    });
    ctx.onPlay(() => {
      if (audio !== ctx) return;
      anchorAt = Date.now();
      // 慢速倍速只能在起播后设置（提前设置部分平台忽略或重置进度到 0）
      if (rate) {
        try {
          ctx.playbackRate = rate;
        } catch (e) {
          try { ctx.playbackRate = 0.8; } catch (e2) { /* 忽略 */ }
        }
      }
    });
    ctx.onTimeUpdate(() => {
      if (audio !== ctx) return;
      const reported = ctx.currentTime || 0;
      const prevReported = lastReported;
      lastReported = reported;
      const now = Date.now();
      const est = estimatedPos();
      if (stalledAt) {
        // 缓冲恢复判据：位置确有推进（冻结期间原地重复的快照不得解冻）
        // 且距停顿触发 >200ms（停顿瞬间乱序送达的停顿前快照不算）
        if (reported > prevReported + 0.05 && now - stalledAt > 200) {
          anchorPos = reported;
          anchorAt = now;
          stalledAt = 0;
        }
      } else if (est == null) {
        anchorPos = reported;
        anchorAt = now;
      } else if (reported > est + 0.02 && reported <= est + 1.0) {
        // 锚点只许前跳、不许回拖（回报落后 = 陈旧快照，忽略）
        anchorPos = reported;
        anchorAt = now;
      }
      // 首帧落点纠偏（只做一次，零误报判据：比句首早 0.5s 以上才补 seek）
      if (!landingChecked) {
        landingChecked = true;
        if (startSec > 0 && reported < startSec - 0.5) {
          ctx.seek(startSec);
          anchorPos = startSec;
          anchorAt = now;
          stalledAt = 0;
        }
      }
      if (typeof cb.onTick === 'function') {
        const p = estimatedPos();
        try { cb.onTick(p != null ? p : reported); } catch (e) { /* 忽略 */ }
      }
    });
    // 缓冲停顿：播放头不走，冻结外推与判停，恢复由 onTimeUpdate 重锚
    ctx.onWaiting && ctx.onWaiting(() => {
      if (audio === ctx && !stalledAt) stalledAt = Date.now();
    });
    ctx.onEnded(() => {
      if (audio !== ctx) return;
      const finished = stop();
      if (finished && typeof cb.onEnded === 'function') {
        try { cb.onEnded(finished); } catch (e) { /* 忽略 */ }
      }
    });
    ctx.onError(() => {
      if (audio !== ctx) return;
      stop();
      wx.showToast({ title: '音频播放失败', icon: 'none' });
    });
    // 50ms 监控循环（对齐 Android monitorJob 的 delay(50)）
    clearWatchdog();
    watchdog = setInterval(() => {
      if (audio !== ctx) {
        clearWatchdog();
        return;
      }
      const t = estimatedPos();
      if (t == null) return; // 缓冲停顿中：不判停、不外推
      if (typeof cb.onTick === 'function') {
        try { cb.onTick(t); } catch (e) { /* 忽略 */ }
      }
      if (endSec != null && t >= endSec - 0.02) {
        const finished = stop();
        if (finished && typeof cb.onEnded === 'function') {
          try { cb.onEnded(finished); } catch (e) { /* 忽略 */ }
        }
      }
    }, 50);
  }

  function getKind() {
    return kind;
  }

  return { playUrl, stop, getKind, estimatedPos };
}

module.exports = { createClipPlayer };
