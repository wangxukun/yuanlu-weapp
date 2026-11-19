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
 *   ④ 倍速在 canplay 就绪后设置；变速从当前位置重建，旧实例的事件按身份隔离
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

  let playRequested = false;

  /**
   * 检测当前是否处于微信真机或开发者工具运行时（区分无 platform 字段的 Node 单测桩）
   */
  function isWeChatRuntime() {
    if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') return false;
    try {
      const sys = wx.getSystemInfoSync();
      return !!(
        sys &&
        (sys.platform === 'ios' ||
          sys.platform === 'android' ||
          sys.platform === 'devtools' ||
          sys.platform === 'ohos' ||
          sys.platform === 'mac' ||
          sys.platform === 'windows')
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * 将业务层倍速归一为微信 InnerAudioContext 原生支持的标准档位。
   * 微信真机官方支持 0.5 / 0.8 / 1.0 / 1.25 / 1.5 / 2.0；直接传 0.75 在真机不会抛 JS 异常，
   * 但会被底层静默忽略并保持 1.0x，因此在微信运行时统一将 0.75 归一到 0.8。
   */
  function resolveNativeRate(r) {
    const num = Number(r) || 1;
    if (num === 0.75 && isWeChatRuntime()) {
      return 0.8;
    }
    return num;
  }

  function releaseAudio() {
    const ctx = audio;
    audio = null;
    clearWatchdog();
    if (ctx) {
      try {
        ctx.offCanplay(); ctx.offTimeUpdate(); ctx.offEnded(); ctx.offError();
        ctx.offPlay && ctx.offPlay();
        ctx.offWaiting && ctx.offWaiting();
        ctx.offSeeked && ctx.offSeeked();
      } catch (e) { /* 低版本基础库 off* 缺失时忽略 */ }
      try { ctx.stop(); } catch (e) { /* 忽略 */ }
      try { ctx.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  function stop() {
    releaseAudio();
    anchorAt = 0;
    const finishedKind = kind;
    kind = null;
    if (finishedKind !== null) notifyPlaying(null);
    return finishedKind;
  }

  function syncRate(ctx) {
    if (!rate) return;
    try {
      if (ctx.playbackRate !== rate) ctx.playbackRate = rate;
    } catch (e) {
      const fallback = rate < 1 ? 0.8 : 1.5;
      try { ctx.playbackRate = fallback; } catch (e2) { /* 旧设备可能不支持倍速 */ }
    }
  }

  // 起播或缓冲期间，续播使用已知落点；看门狗仍只使用正在推进的外推时钟。
  function resumePosition() {
    if (!audio) return null;
    if (!anchorAt) return startSec;
    if (stalledAt) return anchorPos;
    return estimatedPos();
  }

  function finishWindow() {
    const finished = stop();
    if (finished && typeof cb.onEnded === 'function') {
      try { cb.onEnded(finished); } catch (e) { /* 忽略 */ }
    }
  }

  function setRate(newRate) {
    if (!audio) return;
    const next = resolveNativeRate(newRate);
    if (next === (rate || 1)) return;
    const pos = resumePosition();
    rate = next === 1 ? 0 : next;
    // 准备期间只记最后一档，统一由该实例的 canplay 使用。
    if (!playRequested) return;
    if (endSec != null && pos >= endSec - 0.02) {
      finishWindow();
      return;
    }
    const url = audio.src;
    releaseAudio();
    startContext(url, pos);
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
    kind = playKind;
    endSec = o.endSec != null && isFinite(o.endSec) ? o.endSec : null;
    rate = o.rate && o.rate !== 1 ? resolveNativeRate(o.rate) : 0;
    startContext(url, o.startSec > 0 ? o.startSec : 0);
  }

  function startContext(url, position) {
    const ctx = wx.createInnerAudioContext();
    audio = ctx;
    startSec = position;
    anchorPos = position;
    anchorAt = 0;
    stalledAt = 0;
    lastReported = position;
    landingChecked = false;
    playRequested = false;
    let rateSyncCount = 0;

    ctx.onCanplay(() => {
      if (audio !== ctx || playRequested) return;
      playRequested = true;
      syncRate(ctx);
      ctx.play();
      if (audio === ctx) notifyPlaying(kind);
    });
    ctx.onPlay(() => {
      if (audio !== ctx) return;
      if (!anchorAt) anchorAt = Date.now();
      syncRate(ctx);
    });
    ctx.onSeeked && ctx.onSeeked(() => {
      if (audio === ctx && playRequested) syncRate(ctx);
    });
    ctx.onTimeUpdate(() => {
      if (audio !== ctx || !playRequested) return;
      // 前 3 帧 timeupdate 持续复核 playbackRate（兜底未触发 onPlay 或首帧解码重置倍速的机型）
      if (rate && rateSyncCount < 3) {
        rateSyncCount += 1;
        syncRate(ctx);
      }
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
          rateSyncCount = 0;
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
      if (audio !== ctx || stalledAt) return;
      if (anchorAt) anchorPos = estimatedPos();
      stalledAt = Date.now();
    });
    ctx.onEnded(() => {
      if (audio !== ctx) return;
      finishWindow();
    });
    ctx.onError(() => {
      if (audio !== ctx) return;
      stop();
      wx.showToast({ title: '音频播放失败', icon: 'none' });
    });
    // 50ms 监控循环（对齐 Android monitorJob 的 delay(50)）
    watchdog = setInterval(() => {
      if (audio !== ctx) return;
      const t = estimatedPos();
      if (t == null) return; // 缓冲停顿中：不判停、不外推
      if (typeof cb.onTick === 'function') {
        try { cb.onTick(t); } catch (e) { /* 忽略 */ }
      }
      if (audio === ctx && endSec != null && t >= endSec - 0.02) {
        finishWindow();
      }
    }, 50);
    if (position > 0) ctx.startTime = position;
    ctx.src = url;
  }

  function getKind() {
    return kind;
  }

  return { playUrl, stop, setRate, getKind, estimatedPos: resumePosition };
}

module.exports = { createClipPlayer };
