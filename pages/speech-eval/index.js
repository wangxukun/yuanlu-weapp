/**
 * pages/speech-eval — 语音评测页（复刻 Android feature/voice：SpeechEvalScreen +
 * SpeechEvalViewModel + SpeechEvalCard + SpeechSettingsSheet）
 *
 * 状态机：加载 → 句子过滤/切换 → 录音（16kHz PCM → WAV）→ 评测 → 结果/回放。
 *   录音收尾：点击「停止并评测」直取内存 PCM 帧走评测，不等 onStop 回调
 *   （真机 PCM 下 stop() 后该回调可能不触发，页面会永卡录音态）；onStop
 *   仅作 60s 时限自动停止的兜底入口（_finishing 防重）。
 *   phase: idle | recording | evaluating | result（录音面/结果面条件渲染 + 入场翻动动画）
 *   playing: 页内音频（原声/慢速/录音回放/词级四路）单 InnerAudioContext 互斥；
 *   AI 朗读复用 utils/tts（真机 504 修复的下载中转 + dictvoice 降级 + 配额弹窗自持）
 *   原声/慢速切片 = Android MediaPlayer 等价移植：startTime 起播锚定 +
 *   onTimeUpdate 精确锚点 + 墙钟外推 50ms 看门狗到句尾即停（currentTime 是
 *   250~500ms 快照，直接轮询判停必然串进下一句开头）
 *
 * 与 Android 的对齐点：
 *   - 句子过滤（词数区间 + 只练未掌握）与历史匹配（subtitleId || 文本+起点差<0.5s）
 *   - 每句结果缓存（切句返回恢复）+ 历史记录恢复（云端录音直链 + detail 明细回填）
 *   - 盲读模式（遮挡/揭示，评测产出后自动揭示）、音标模式（逐词 IPA 预取缓存）
 *   - 达标 1.5s 自动跳下一句；「最近得分」入口；评测配额墙（403 → 会员弹窗）
 *   - 点词查词与精听页共用 vocabulary-modal 同一口径
 */
const { get, post } = require('../../utils/request');
const core = require('../../utils/speech-core');
const authStore = require('../../store/authStore');
const audioBus = require('../../utils/audio-bus');
const tts = require('../../utils/tts');
const theme = require('../../utils/theme');

const SETTINGS_KEY = 'speechPracticeSettings';
const PCM_RATE = 16000;
const MIN_RECORD_BYTES = PCM_RATE * 2 * 0.5; // 0.5s 的 16bit mono PCM
const AUTO_ADVANCE_DELAY = 1500;
const AMP_WINDOW = 24; // 波形滚动窗口（渲染条数，Android takeLast(24)）

Page({
  data: {
    statusBarH: 20,
    gearRightPx: 100, // 齿轮与原生胶囊避让（右偏移 = 屏宽 - 胶囊左缘 + 8）
    dark: false,
    themeMode: 'system',

    // 加载态
    loading: true,
    loadError: null,
    episodeTitle: '',
    audioUrl: '',
    isTrialMode: false,

    // 句子游标与派生态
    index: 0,
    indexLabel: '0 / 0',
    subsEmpty: false,
    practicedCount: 0,
    progressPercent: 0,
    hasLatestRecord: false,
    isLastIndex: false,

    // 单句评测卡
    phase: 'idle',
    result: null,
    selectedWordIndex: null,
    playing: 'none',
    amplitudes: [],

    // 字幕区
    tokens: [],
    blindBars: [],
    textCn: '',
    hasCn: false,
    showCn: true,
    blindMasked: true,
    blindRevealed: false,
    sweepIdx: -1,
    sweepOn: false,
    fontSizeCls: 'se-fs-1',

    // 设置
    settings: core.DEFAULT_SETTINGS,
    effectiveThreshold: 80,
    showSettings: false,

    // 查词 / 会员弹窗
    wordModal: { visible: false, word: '', dictData: null, loading: false, saving: false, isSaved: false },
    showPremiumModal: false,
    premiumSource: 'review_eval_quota',
  },

  onLoad(query) {
    this._episodeId = query.id || '';
    this._focusSubtitleId = query.focus ? parseInt(query.focus, 10) : null;

    this._allSubs = [];      // 全量字幕（过滤输入）
    this._subs = [];         // 过滤后字幕
    this._records = [];      // 历史评测记录
    this._resultCache = {};  // subtitleId → 最近一次结果（切句恢复）
    this._ipaCache = {};     // 词键 → US 音标（已剥斜杠）
    this._vocabSet = {};     // 已保存生词小写表
    this._audio = null;      // 页内单例 InnerAudioContext
    this._audioEndSec = null;
    this._sweepWords = null;
    this._advanceTimer = null;
    this._pcmFrames = null;
    this._lastAmpAt = 0;
    this._finishing = false;  // 录音收尾防重（点击停止与 onStop 兜底互斥）
    this._lastWavPath = '';

    // 状态栏 + 胶囊避让（沉浸页顶部与原生胶囊同排）
    let statusBarH = 20;
    let gearRightPx = 100;
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      statusBarH = win.statusBarHeight || 20;
      if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
        const rect = wx.getMenuButtonBoundingClientRect();
        if (rect && rect.left) gearRightPx = win.windowWidth - rect.left + 8;
      }
    } catch (e) { /* 取不到时用默认值 */ }

    const themeMode = theme.getMode();
    const settings = core.normalizeSettings(wx.getStorageSync(SETTINGS_KEY));
    this.setData({
      statusBarH,
      gearRightPx,
      themeMode,
      dark: theme.getEffective() === 'dark',
      settings,
      effectiveThreshold: core.effectivePassThreshold(settings),
      fontSizeCls: 'se-fs-' + settings.fontSizeLevel,
    });

    this._initRecorder();
    this._unTheme = theme.subscribe(() => this._onThemeChange());
    this._unbus = audioBus.register(() => this._stopPlayback());

    // AI 朗读走 tts.js 全链（真机 504 修复的 downloadFile 中转 + dictvoice 降级）：
    // 订阅其播放态点亮 'ai'；配额弹窗自持（入栈保存宿主 handler、退栈恢复）
    this._unsubTts = tts.subscribe((s) => {
      if (s.playingText != null) {
        if (this.data.playing !== 'ai') this.setData({ playing: 'ai' });
      } else if (this.data.playing === 'ai') {
        this.setData({ playing: 'none' });
      }
    });
    this._prevQuota = tts.getQuotaHandler();
    tts.setQuotaHandler((source) => {
      this.setData({ showPremiumModal: true, premiumSource: source });
    });

    if (!this._episodeId) {
      this.setData({ loading: false, loadError: '缺少剧集参数' });
      return;
    }
    this._load();
  },

  onUnload() {
    this._destroyed = true; // 录音机的迟到回调不再 setData
    if (this._unbus) this._unbus();
    if (this._unTheme) this._unTheme();
    if (this._unsubTts) this._unsubTts();
    tts.stop();
    tts.setQuotaHandler(this._prevQuota || null);
    this._cancelAdvance();
    this._clearWatchdog();
    this._stopPlayback();
    if (this._audio) {
      try { this._audio.destroy(); } catch (e) { /* 忽略 */ }
      this._audio = null;
    }
    if (this._recorder && this.data.phase === 'recording') {
      this._pcmFrames = null; // 丢弃帧：onStop 的评测流程随页面销毁作废
      try { this._recorder.stop(); } catch (e) { /* 忽略 */ }
    }
  },

  noop() {},

  /** 收起：返回剧集详情（无上一页时回首页兜底） */
  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' }),
    });
  },

  // ==================== 主题 ====================

  // 深浅色已接入全局外观（utils/theme）：设置弹窗的三选一直写全局模式，
  // 订阅回流即时切换本页（.se-page--dark 依旧驱动页内 --se-* 深色板）
  onSetThemeMode(e) {
    theme.setMode(e.detail.mode);
  },

  _onThemeChange() {
    const snap = theme.getState();
    this.setData({ themeMode: snap.mode, dark: snap.effective === 'dark' });
  },

  // ==================== 数据加载 ====================

  _load() {
    const focusId = this._subs[this.data.index] ? this._subs[this.data.index].id : this._focusSubtitleId;
    this.setData({ loading: true, loadError: null });
    get('/api/speech/practice-data?id=' + encodeURIComponent(this._episodeId) + '&t=' + Date.now(), null, { showError: false })
      .then((body) => {
        if (!body || body.success === false) {
          throw new Error((body && (body.error || body.message)) || '练习数据加载失败');
        }
        const parsed = core.parsePracticeData(body);
        this._allSubs = parsed.subtitles;
        this._records = parsed.records;
        const filtered = core.applyFilters(this._allSubs, this._records, this.data.settings);

        // 弱项句直达定位：过滤集内按 subtitleId 命中；被排除时定位目标之后最近的可见句
        let focusIndex = 0;
        let toastMsg = null;
        const target = focusId != null ? focusId : null;
        if (target != null) {
          const hit = filtered.findIndex((s) => s.id === target);
          if (hit >= 0) {
            focusIndex = hit;
          } else {
            toastMsg = '该句被当前过滤条件排除，已定位到最近的句子';
            focusIndex = core.nearestVisibleIndexAfter(filtered, this._allSubs, target);
          }
        }
        this._focusSubtitleId = null;
        this._subs = filtered;
        this.setData({
          loading: false,
          audioUrl: parsed.audioUrl || '',
          episodeTitle: parsed.episodeTitle || '',
          isTrialMode: parsed.isTrialMode,
        });
        this._applySentence(focusIndex, null);
        const cur = filtered[focusIndex];
        if (cur) this._restoreFromHistory(cur.id);
        if (toastMsg) wx.showToast({ title: toastMsg, icon: 'none' });
        this._fetchVocabSet();
      })
      .catch((err) => {
        this.setData({ loading: false, loadError: (err && err.message) || '练习数据加载失败' });
      });
  },

  onRetry() {
    this._load();
  },

  /** 已保存生词表（句内 primary 标色用，与精听页同接口） */
  _fetchVocabSet() {
    if (!authStore.getState().isLoggedIn) return;
    get('/api/vocabulary/words', null, { showError: false })
      .then((body) => {
        const arr = body && body.success && Array.isArray(body.data) ? body.data : [];
        const set = {};
        arr.forEach((w) => { set[String(w).toLowerCase()] = true; });
        this._vocabSet = set;
        if (this.data.tokens.length) this._renderTokens();
      })
      .catch(() => {});
  },

  // ==================== 派生态同步 ====================

  _syncDerived() {
    const subs = this._subs;
    const idx = this.data.index;
    let practiced = 0;
    for (let i = 0; i < subs.length; i++) {
      if (core.latestRecordFor(subs[i], this._records)) practiced++;
    }
    const cur = subs[idx];
    this.setData({
      indexLabel: (idx + 1) + ' / ' + subs.length,
      subsEmpty: subs.length === 0,
      practicedCount: practiced,
      progressPercent: subs.length ? Math.round((practiced / subs.length) * 100) : 0,
      hasLatestRecord: !!(cur && core.latestRecordFor(cur, this._records)),
      isLastIndex: subs.length > 0 && idx === subs.length - 1,
    });
  },

  // ==================== 句子切换与渲染 ====================

  _applySentence(index, restored) {
    const sub = this._subs[index];
    if (!sub) {
      this.setData({ tokens: [], blindBars: [], textCn: '', hasCn: false });
      this._syncDerived();
      return;
    }
    this._stopSweep();
    const d = this.data;
    const showCn = d.settings.showTranslation;
    this.setData({
      index,
      phase: restored ? 'result' : 'idle',
      result: restored || null,
      selectedWordIndex: null,
      amplitudes: [],
      showCn,
      textCn: sub.textCn || '',
      hasCn: !!sub.textCn,
      blindRevealed: false,
    });
    this._renderTokens();
    this._syncDerived();
  },

  /** 字幕 token / 盲读遮挡条 / 字号档位（音标模式替换展示文本） */
  _renderTokens() {
    const sub = this._subs[this.data.index];
    if (!sub) return;
    const ipaMap = this.data.settings.textMode === 'ipa' ? this._ipaCache : null;
    const tokens = core.buildSentenceTokens(sub, ipaMap).map((t) => ({
      d: t.d,
      w: t.w,
      s: t.s,
      sv: this._vocabSet[core.cleanWordKey(t.w)] ? 1 : 0,
    }));
    // 盲读遮挡条：宽 = 字号×0.62×词长（dp→rpx ×2），高 = 字号 + 6dp
    const fsPx = [34, 40, 48][this.data.settings.fontSizeLevel] || 40;
    const blindBars = core.buildBlindBars(sub.textEn).map((len) => ({
      w: Math.round(fsPx * 0.62 * len),
      h: fsPx + 12,
    }));
    this.setData({
      tokens,
      blindBars,
      blindMasked: this.data.settings.textMode === 'blind' && !this.data.blindRevealed,
    });
  },

  switchSentence(index) {
    const subs = this._subs;
    if (index < 0 || index >= subs.length || index === this.data.index) return;
    this._stopPlayback();
    tts.stop(); // AI 朗读随切句停止（单一时间轴）
    this._cancelAdvance();
    if (this.data.phase === 'recording') {
      this._pcmFrames = null;
      try { this._recorder.stop(); } catch (e) { /* 忽略 */ }
    }
    const target = subs[index];
    const restored = this._resultCache[target.id] || null;
    this._applySentence(index, restored);
    if (!restored) this._restoreFromHistory(target.id);
    this._prefetchIpa(target);
  },

  onPrev() {
    if (this.data.index <= 0 || this.data.phase === 'evaluating') return;
    this.switchSentence(this.data.index - 1);
  },

  onNext() {
    if (this.data.isLastIndex || this.data.phase === 'evaluating') return;
    this.switchSentence(this.data.index + 1);
  },

  // ==================== 字幕音标预取（IPA 模式） ====================

  _prefetchIpa(sub) {
    if (this.data.settings.textMode !== 'ipa') return;
    const target = sub || this._subs[this.data.index];
    if (!target) return;
    const keys = [];
    const seen = {};
    core.buildSentenceTokens(target, null).forEach((t) => {
      const k = core.cleanWordKey(t.w);
      if (k && !seen[k] && !(k in this._ipaCache)) {
        seen[k] = true;
        keys.push(k);
      }
    });
    keys.forEach((word) => {
      get('/api/dict/' + encodeURIComponent(word), null, { showError: false })
        .then((body) => {
          if (!(body && body.success && body.data)) return;
          const us = body.data.phonetics && body.data.phonetics.us;
          if (!us) return;
          this._ipaCache[word] = core.stripIpaSlashes(us);
          // 仍是当前句且仍在音标模式 → 重建 token 展示
          const cur = this._subs[this.data.index];
          if (cur && cur.id === target.id && this.data.settings.textMode === 'ipa') {
            this._renderTokens();
          }
        })
        .catch(() => {});
    });
  },

  // ==================== 设置（过滤即时生效） ====================

  onOpenSettings() {
    this.setData({ showSettings: true });
  },

  onCloseSettings() {
    this.setData({ showSettings: false });
  },

  onSettingChange(e) {
    const detail = e.detail || {};
    const patch = {};
    if (detail.key) patch[detail.key] = detail.value; // detail 形如 {key, value}
    const settings = core.normalizeSettings(Object.assign({}, this.data.settings, patch));
    wx.setStorageSync(SETTINGS_KEY, settings);
    const prev = this.data.settings;
    const prevSub = this._subs[this.data.index];

    const filtered = core.applyFilters(this._allSubs, this._records, settings);
    this._subs = filtered;

    // 保持当前句身份优先（同 id 找回）；被过滤排除时回落数值下标
    let newIndex = Math.max(0, Math.min(this.data.index, Math.max(0, filtered.length - 1)));
    if (prevSub) {
      const hit = filtered.findIndex((s) => s.id === prevSub.id);
      if (hit >= 0) newIndex = hit;
    }

    const patchData = {
      settings,
      effectiveThreshold: core.effectivePassThreshold(settings),
      fontSizeCls: 'se-fs-' + settings.fontSizeLevel,
    };
    if (prev.showTranslation !== settings.showTranslation) {
      patchData.showCn = settings.showTranslation; // 开关变化 → 局部覆盖回归默认
    }
    this.setData(patchData);

    const nextSub = filtered[newIndex];
    const identityChanged = !prevSub || !nextSub || prevSub.id !== nextSub.id;
    if (identityChanged || newIndex !== this.data.index) {
      if (this.data.phase === 'recording') {
        this._pcmFrames = null;
        try { this._recorder.stop(); } catch (e) { /* 忽略 */ }
      }
      this._applySentence(newIndex, nextSub ? this._resultCache[nextSub.id] || null : null);
      if (nextSub && !this._resultCache[nextSub.id]) this._restoreFromHistory(nextSub.id);
    } else {
      this._renderTokens(); // 音标/字号/盲读档位即时刷新
      this._syncDerived();
    }
    if (prev.textMode !== settings.textMode && settings.textMode === 'ipa') {
      this._prefetchIpa();
    }
  },

  // ==================== 录音与评测 ====================

  _initRecorder() {
    const rm = wx.getRecorderManager();
    this._recorder = rm;
    rm.onStart(() => {
      this._pcmFrames = [];
      this._lastAmpAt = 0;
      this._finishing = false;
      this.setData({ phase: 'recording', result: null, selectedWordIndex: null, amplitudes: [] });
    });
    rm.onFrameRecorded((res) => {
      if (!this._pcmFrames || this._destroyed) return; // 已停止/已切句/已卸载：丢弃迟到帧
      this._pcmFrames.push(res.frameBuffer);
      const now = Date.now();
      if (now - this._lastAmpAt >= 100) {
        this._lastAmpAt = now;
        const amp = core.frameAmplitude(res.frameBuffer);
        this.setData({ amplitudes: this.data.amplitudes.concat(amp).slice(-AMP_WINDOW) });
      }
    });
    // onStop 仅作兜底入口：真机 PCM 格式 stop() 后本回调可能不触发（页面
    // 永卡录音态的根因）。用户点击路径由 _finishRecording 直取内存帧评测、
    // 不等待本回调；这里只处理仍处录音态的场合（60s 时限自动停止），
    // _finishing 防重保证两条路径不会双跑评测
    rm.onStop((res) => {
      if (this._destroyed) return;
      if (this.data.phase === 'recording') {
        this._finishRecording(res && res.tempFilePath);
      }
    });
    rm.onError(() => {
      if (this._destroyed) return;
      if (this.data.phase === 'recording' || this.data.phase === 'evaluating') {
        this._pcmFrames = null;
        this.setData({ phase: 'idle', amplitudes: [] });
      }
      wx.showToast({ title: '无法启动麦克风，请检查权限设置', icon: 'none' });
    });
  },

  /** 麦克风运行时权限（对应 Android RECORD_AUDIO 请求链） */
  _ensureRecordPermission() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          const auth = res.authSetting || {};
          if (auth['scope.record'] === true) return resolve(true);
          if (auth['scope.record'] === false) {
            wx.showModal({
              title: '麦克风权限',
              content: '语音评测需要访问麦克风，请在设置中开启',
              confirmText: '去设置',
              success: (r) => {
                if (!r.confirm) return resolve(false);
                wx.openSetting({
                  success: (s2) => resolve(!!(s2.authSetting && s2.authSetting['scope.record'])),
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
  },

  async onToggleRecording() {
    const phase = this.data.phase;
    if (phase === 'evaluating') return;
    if (phase === 'recording') {
      // 直接收帧走评测，不等 onStop（真机 PCM 下 stop() 后该回调可能不触发）
      this._finishRecording();
      return;
    }
    const ok = await this._ensureRecordPermission();
    if (!ok) {
      wx.showToast({ title: '无法访问麦克风，请检查权限设置', icon: 'none' });
      return;
    }
    this._startRecording();
  },

  _startRecording() {
    this._stopPlayback();
    tts.stop(); // 录音期间静音（AI 朗读/回放一并停）
    this._cancelAdvance();
    try {
      this._recorder.start({
        format: 'PCM',          // onFrameRecorded 实时帧 → 音量波形 + 停止时封装 WAV
        sampleRate: PCM_RATE,
        numberOfChannels: 1,
        frameSize: 1,           // 1KB/帧 ≈ 32ms，音量刷新粒度
        duration: 60000,        // 60s 上限：到点自动停止（onStop 触发时兜底走评测）
      });
    } catch (e) {
      wx.showToast({ title: '无法启动麦克风，请检查权限设置', icon: 'none' });
    }
  },

  /**
   * 收尾录音并进入评测（用户点击 / onStop 兜底共用，_finishing 防重）：
   * 直取已缓冲的 PCM 内存帧（onFrameRecorded 实时流的副本），仍调用 stop()
   * 释放麦克风——但评测不依赖其回调（真机 PCM 下 onStop 可能不触发）。
   * 帧缺失时兜底读 onStop 的 PCM 临时文件（个别机型不回调帧事件）。
   */
  _finishRecording(tempFilePath) {
    if (this._finishing || this._destroyed) return;
    this._finishing = true;
    const frames = this._pcmFrames || [];
    this._pcmFrames = null; // 迟到帧一律丢弃
    try { this._recorder.stop(); } catch (e) { /* stop 失败不影响内存帧评测 */ }
    if (!frames.length && tempFilePath) {
      try {
        const buf = wx.getFileSystemManager().readFileSync(tempFilePath);
        if (buf && buf.byteLength) frames.push(buf);
      } catch (e) { /* 兜底失败 → 走"录音太短"提示 */ }
    }
    this._evaluateFrames(frames);
    setTimeout(() => { this._finishing = false; }, 1000); // 防重窗口
  },

  _evaluateFrames(frames) {
    frames = frames || [];
    let totalBytes = 0;
    for (let i = 0; i < frames.length; i++) totalBytes += frames[i].byteLength;

    this.setData({ phase: 'evaluating', amplitudes: [] });

    if (totalBytes < MIN_RECORD_BYTES) {
      this.setData({ phase: 'idle' });
      wx.showToast({ title: '录音太短，请重试', icon: 'none' });
      return;
    }
    const sub = this._subs[this.data.index];
    if (!sub) {
      this.setData({ phase: 'idle' });
      return;
    }

    // PCM → WAV 落盘：本地文件既是评测上传源，也是「回放我的发音/我」的播放源
    let localPath = '';
    let audioBase64 = '';
    try {
      const wav = core.pcmToWav(frames, PCM_RATE);
      const fs = wx.getFileSystemManager();
      localPath = wx.env.USER_DATA_PATH + '/speech_' + Date.now() + '.wav';
      fs.writeFileSync(localPath, wav, 'binary');
      audioBase64 = fs.readFileSync(localPath, 'base64');
      // 会话内只保留最近一份录音，回收旧文件
      if (this._lastWavPath && this._lastWavPath !== localPath) {
        try { fs.unlinkSync(this._lastWavPath); } catch (e) { /* 忽略 */ }
      }
      this._lastWavPath = localPath;
    } catch (e) {
      console.warn('[speech-eval] wav 封装/读取失败', e);
      wx.showToast({ title: '录音处理失败，请重试', icon: 'none' });
      this.setData({ phase: 'idle' });
      return;
    }

    post('/api/speech/evaluate', {
      episodeId: this._episodeId,
      subtitleId: sub.id,
      targetText: sub.textEn,
      audioBase64,
      rate: PCM_RATE,
    }, { timeout: 60000, showError: false })
      .then((body) => {
        if (!body || body.success === false) {
          throw Object.assign(new Error((body && (body.message || body.error)) || '评测失败，请重试'), { body });
        }
        const evaluated = core.parseEvalResponse(body);
        evaluated.userAudioPath = localPath;
        this._resultCache[sub.id] = evaluated;

        const newRecord = core.parseRecordDto({
          recognitionid: evaluated.recognitionId || Date.now(),
          accuracyScore: evaluated.pronunciation,
          overallScore: evaluated.overallScore,
          fluencyScore: evaluated.fluency,
          integrityScore: evaluated.integrity,
          speed: evaluated.speed,
          targetText: sub.textEn,
          targetStartTime: Math.round(sub.start),
          subtitleId: sub.id,
        });
        this._records.push(newRecord);

        // 评测期间可能已切句：结果只回填缓存与记录，仍在本句才翻到结果面
        const cur = this._subs[this.data.index];
        if (this._destroyed || !cur || cur.id !== sub.id) {
          this._syncDerived();
          return;
        }
        this.setData({
          phase: 'result',
          result: evaluated,
          selectedWordIndex: null,
          blindRevealed: true, // 盲读模式：新一轮结果产出即揭示原文对照
        });
        this._renderTokens();
        this._syncDerived();
        this._maybeAutoAdvance(evaluated.overallScore);
      })
      .catch((err) => {
        const cur = this._subs[this.data.index];
        if (!this._destroyed && cur && cur.id === sub.id) {
          this.setData({ phase: 'idle' });
        }
        const body = err && err.body;
        if (err && err.statusCode === 403) {
          // 配额墙：后端 message 携带升级文案（月池/日池共用 403 口径）
          wx.showToast({ title: (body && body.message) || '今日免费评测次数已用完', icon: 'none', duration: 2500 });
          this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
        } else {
          wx.showToast({ title: (err && err.message) || '评测失败，请重试', icon: 'none' });
        }
      });
  },

  /** 达标 1.5s 后自动跳下一句（Android maybeAutoAdvance 同口径） */
  _maybeAutoAdvance(score) {
    if (!this.data.settings.autoAdvance) return;
    if (score < this.data.effectiveThreshold) return;
    if (this.data.isLastIndex) return;
    this._cancelAdvance();
    this._advanceTimer = setTimeout(() => {
      this._advanceTimer = null;
      this.switchSentence(this.data.index + 1);
    }, AUTO_ADVANCE_DELAY);
  },

  _cancelAdvance() {
    if (this._advanceTimer) {
      clearTimeout(this._advanceTimer);
      this._advanceTimer = null;
    }
  },

  onRetryRecording() {
    this._cancelAdvance();
    this.setData({ phase: 'idle', result: null, selectedWordIndex: null });
  },

  // ==================== 历史结果恢复（重进页面 / 切到已练句） ====================

  _restoreFromHistory(subtitleId) {
    const sub = this._subs.find((s) => s.id === subtitleId);
    if (!sub) return;
    const record = core.latestRecordFor(sub, this._records);
    if (!record || !record.recognitionid) return;

    if (!this._resultCache[subtitleId]) {
      const base = core.recordToResult(record);
      this._resultCache[subtitleId] = base;
      const cur = this._subs[this.data.index];
      if (cur && cur.id === subtitleId &&
        this.data.phase !== 'recording' && this.data.phase !== 'evaluating') {
        this.setData({ phase: 'result', result: base, selectedWordIndex: null });
      }
    }
    // detailUrl 携带时异步回填逐词/音素明细（会话内更新的结果优先生效）
    if (!record.detailUrl) return;
    get('/api/speech/detail?id=' + record.recognitionid + '&t=' + Date.now(), null, { showError: false })
      .then((body) => {
        if (!body || body.success === false || !body.data) return;
        const merged = core.parseDetails(body.data, record.recognitionid, null);
        const cached = this._resultCache[subtitleId];
        if (!merged.words.length) return;
        if (cached && cached.recognitionId === record.recognitionid) {
          const full = Object.assign({}, cached, { words: merged.words });
          this._resultCache[subtitleId] = full;
          const cur = this._subs[this.data.index];
          const live = this.data.result;
          if (cur && cur.id === subtitleId && live && live.recognitionId === record.recognitionid) {
            this.setData({ result: full });
          }
        }
      })
      .catch(() => {});
  },

  /** 「最近得分」入口：会话缓存直接翻到结果面，否则从历史恢复 */
  onShowLatestScore() {
    if (this.data.phase === 'recording' || this.data.phase === 'evaluating') return;
    const sub = this._subs[this.data.index];
    if (!sub) return;
    const cached = this._resultCache[sub.id];
    if (!cached) {
      this._restoreFromHistory(sub.id);
      return;
    }
    this._stopPlayback();
    this._cancelAdvance();
    this.setData({ phase: 'result', result: cached, selectedWordIndex: null });
  },

  // ==================== 页内播放（单 InnerAudioContext 互斥） ====================

  _stopSweep() {
    this._sweepWords = null;
    if (this.data.sweepIdx !== -1 || this.data.sweepOn) {
      this.setData({ sweepIdx: -1, sweepOn: false });
    }
  },

  _stopPlayback() {
    this._audioEndSec = null;
    this._audioStartSec = 0;
    this._audioRate = 0;
    this._anchorAt = 0;
    this._anchorPos = 0;
    this._stalledAt = 0;
    this._landingChecked = false;
    this._lastReported = 0;
    this._clearWatchdog();
    this._stopSweep();
    const ctx = this._audio;
    this._audio = null;
    if (ctx) {
      try {
        ctx.offCanplay();
        ctx.offTimeUpdate();
        ctx.offEnded();
        ctx.offError();
      } catch (e) { /* 低版本基础库 off* 缺失时忽略 */ }
      try { ctx.stop(); ctx.destroy(); } catch (e) { /* 忽略 */ }
    }
    if (this.data.playing !== 'none') this.setData({ playing: 'none' });
  },

  _clearWatchdog() {
    if (this._audioWatchdog) {
      clearInterval(this._audioWatchdog);
      this._audioWatchdog = null;
    }
  },

  /**
   * 页内单实例播放（原声/慢速/录音回放/词级四路共用）—— Android MediaPlayer 的等价移植。
   *
   * Android 的句界精度来自两点：MediaPlayer.currentPosition 是解码器播放头的
   * 同步实时查询 + 50ms 监控循环到 endMs 即 stop。而 InnerAudioContext.currentTime
   * 只是内部进度回调（250~500ms 一次）刷新的快照，直接轮询它判停必然滞后
   * 半秒级（串到下一句开头的根因）。本实现重建"精确 currentPosition"：
   *   ① 起播锚定：ctx.startTime = startSec（等价 prepare→seekTo→start，无 seek 竞态；
   *      首帧回报比句首早 0.5s 以上才判「startTime 被平台忽略」补一次 seek——
   *      不可与墙钟期望比较，真机暖缓存首帧回报延迟且快照陈旧，会被误判成
   *      落点失败而 seek 回句首，造成句首 ~1s 重播）；
   *   ② 实时锚点（只许前跳、不许回拖）：外推以墙钟为轴 pos = anchor +
   *      (now - anchorAt)×rate，天然免疫事件管线延迟；onTimeUpdate 回报领先外推
   *      > 0.02s（onPlay 迟到 / 漏检的短暂停顿）才前跳校准（上限 1.0s 防野值），
   *      回报落后于外推 = 延迟送达的陈旧快照，一律忽略——若按「回报位置 @
   *      送达时刻」重锚，真机每次回报都会把外推时间轴向后拖一段，句尾停点
   *      随之迟到、漏出下一句开头；
   *   ③ 50ms 看门狗（同 Android delay(50)）：外推位置 ≥ endSec 即停，落点误差
   *      ≈ 看门狗粒度 + stop 延迟（~100ms 级）；onWaiting（缓冲停顿）期间冻结
   *      判停与外推，恢复需「位置比最近一次见过的回报确有推进（冻结期间原地
   *      重复的快照不得解冻）+ 距停顿 >200ms（乱序送达的停顿前快照不算）」
   *      双判据——外推在音频仍冻结时提前起跑会造成句尾提前误停。
   * 慢速倍速只在起播后设置（提前设置部分平台会忽略或把进度重置回 0）。
   */
  _playUrl(url, kind, opts) {
    if (!url) return;
    // 旧批次 mp3 的 seek 落点先天不准（新批次已迁 m4a，见 scripts/tmp-mp3-backup），
    // 命中时告警提示重转，不阻断播放
    if (/\.mp3(\?|$)/i.test(url.split('?')[0] + '')) {
      console.warn('[speech-eval] 原声为旧批次 mp3，seek 精度可能不准：', url.slice(0, 80));
    }
    audioBus.stopAll(); // 停全局播放器 / TTS / 原声片段（互斥总线）
    this._stopPlayback();
    const o = opts || {};
    const ctx = wx.createInnerAudioContext();
    this._audio = ctx;
    this._audioStartSec = o.startSec > 0 ? o.startSec : 0;
    this._audioEndSec = o.endSec != null && isFinite(o.endSec) ? o.endSec : null;
    this._audioRate = o.rate && o.rate !== 1 ? o.rate : 0;
    this._anchorPos = this._audioStartSec; // 外推锚点（起播前先按预期落点占位）
    this._anchorAt = 0;                    // 锚定墙钟时刻（0 = 尚未起播）
    this._landingChecked = false;          // 首帧落点纠偏只做一次
    this._stalledAt = 0;                   // 缓冲停顿起始时刻（0 = 未停顿）
    this._lastReported = 0;                // 最近一次见过的回报位置（停顿恢复判据）
    this._sweepWords = (kind === 'original' || kind === 'slow') ? (this._subs[this.data.index] || {}).words || null : null;

    if (this._audioStartSec > 0) {
      ctx.startTime = this._audioStartSec; // 开始播放的位置（播放时生效一次，无 seek 竞态）
    }
    ctx.src = url;
    ctx.onCanplay(() => {
      if (this._audio !== ctx) return;
      ctx.play();
      this.setData({ playing: kind });
    });
    ctx.onPlay(() => {
      if (this._audio !== ctx) return;
      this._anchorAt = Date.now();
      // 慢速倍速只能在起播后设置（提前设置部分平台忽略或重置进度到 0）
      if (this._audioRate) {
        try {
          ctx.playbackRate = this._audioRate;
        } catch (e) {
          try { ctx.playbackRate = 0.8; } catch (e2) { /* 忽略 */ }
        }
      }
    });
    ctx.onTimeUpdate(() => {
      if (this._audio !== ctx) return;
      const reported = ctx.currentTime || 0;
      const prevReported = this._lastReported;
      this._lastReported = reported;
      const now = Date.now();
      const est = this._estimatedPos();
      if (this._stalledAt) {
        // 缓冲恢复判据：位置比「最近一次见过的回报」确有推进（冻结期间原地
        // 重复的快照不得解冻，否则外推在音频仍冻结时起跑 → 句尾提前误停），
        // 且距停顿触发 > 200ms（停顿瞬间乱序送达的停顿前快照不算）
        if (reported > prevReported + 0.05 && now - this._stalledAt > 200) {
          this._anchorPos = reported;
          this._anchorAt = now;
          this._stalledAt = 0;
        }
      } else if (est == null) {
        this._anchorPos = reported;
        this._anchorAt = now;
      } else if (reported > est + 0.02 && reported <= est + 1.0) {
        // 锚点只许前跳、不许回拖：外推以墙钟为轴，天然免疫事件管线延迟；
        // 回报领先外推 > 0.02s（onPlay 迟到 / 漏检的短暂停顿）才前跳校准，
        // 上限 1.0s 防野值；回报落后于外推 = 延迟送达的陈旧快照（真机
        // onTimeUpdate 的位置是几百毫秒前的），若按「回报位置 @ 送达时刻」
        // 重锚，外推时间轴会被每次回报向后拖一段，句尾停点随之迟到——
        // 真机漏出下一句开头（"I'm Neil. An"）的根因；开发者工具事件即时
        // 送达故不受影响
        this._anchorPos = reported;
        this._anchorAt = now;
      }
      // 首帧落点纠偏（只做一次，零误报判据）：回报位置比句首还早 0.5s 以上 =
      // startTime 被平台忽略（从剧集 0 处起播）才补 seek 回句首。不可与墙钟
      // 期望比较——回报本就含已流逝时长，真机暖缓存下首帧回报延迟且快照陈旧，
      // 会被误判成落点失败而 seek 回句首，造成句首 ~1s 重播（真机二次播放
      // 串词的根因；开发者工具回报及时精确故不复现）
      if (!this._landingChecked) {
        this._landingChecked = true;
        if (this._audioStartSec > 0 && reported < this._audioStartSec - 0.5) {
          ctx.seek(this._audioStartSec);
          this._anchorPos = this._audioStartSec;
          this._anchorAt = now;
          this._stalledAt = 0;
        }
      }
      if (this._sweepWords && this._sweepWords.length) {
        this._onSweepTick(this._estimatedPos() != null ? this._estimatedPos() : reported);
      }
    });
    // 缓冲停顿：播放头不走，冻结外推与判停（防误停/误外推），恢复由 onTimeUpdate 重锚
    ctx.onWaiting && ctx.onWaiting(() => {
      if (this._audio === ctx && !this._stalledAt) this._stalledAt = Date.now();
    });
    ctx.onEnded(() => {
      if (this._audio === ctx) this._stopPlayback();
    });
    ctx.onError(() => {
      if (this._audio !== ctx) return;
      this._stopPlayback();
      wx.showToast({ title: '音频播放失败', icon: 'none' });
    });
    // 50ms 监控循环（对齐 Android monitorJob 的 delay(50)）
    this._clearWatchdog();
    this._audioWatchdog = setInterval(() => {
      if (this._audio !== ctx) {
        this._clearWatchdog();
        return;
      }
      const t = this._estimatedPos();
      if (t == null) return; // 缓冲停顿中：不判停、不外推
      if (this._sweepWords && this._sweepWords.length) {
        this._onSweepTick(t);
      }
      if (this._audioEndSec != null && t >= this._audioEndSec - 0.02) {
        this._stopPlayback();
      }
    }, 50);
  },

  /**
   * 外推播放头：锚点位置 + 墙钟流逝 × 倍速。
   * 返回 null 表示尚未起播或缓冲停顿中（播放头未在推进，不参与判停）。
   */
  _estimatedPos() {
    if (!this._anchorAt || this._stalledAt) return null;
    const rate = this._audioRate || 1;
    return this._anchorPos + ((Date.now() - this._anchorAt) / 1000) * rate;
  },

  /** 原声/慢速播放的词级扫光（词级时间戳同轴，最小差量下发） */
  _onSweepTick(t) {
    const words = this._sweepWords;
    const sub = this._subs[this.data.index];
    if (!words.length || !sub) return;
    const start = words[0].start;
    const end = words[words.length - 1].end;
    const sw = core.computeWordSweep(words, t, start, end);
    if (sw.idx !== this.data.sweepIdx || sw.on !== this.data.sweepOn) {
      this.setData({ sweepIdx: sw.idx, sweepOn: sw.on });
    }
  },

  /** AI 朗读（tts.js 全链：有道 TTS 合成 → 下载中转 → 流播/短文本 dictvoice 降级） */
  onAiReading() {
    if (this.data.phase === 'evaluating') return;
    if (this.data.playing === 'ai') {
      tts.stop();
      return;
    }
    const sub = this._subs[this.data.index];
    if (!sub) return;
    tts.speak(sub.textEn); // 状态/配额/降级均由 tts.js 编排，播放态经订阅回流
  },

  /** 原声片段（speed 1.0 / 0.75 慢速），起点优先词级时间戳 */
  _playOriginal(speed) {
    if (this.data.phase === 'evaluating') return;
    const kind = speed < 1 ? 'slow' : 'original';
    if (this.data.playing === kind) {
      this._stopPlayback();
      return;
    }
    const url = this.data.audioUrl;
    const sub = this._subs[this.data.index];
    if (!url || !sub) {
      wx.showToast({ title: '原声音频不可用', icon: 'none' });
      return;
    }
    const words = sub.words || [];
    const startSec = words.length ? words[0].start : sub.start;
    const endSec = words.length ? words[words.length - 1].end : sub.end;
    this._playUrl(url, kind, { startSec, endSec, rate: speed });
  },

  onPlayOriginal() { this._playOriginal(1); },

  onPlaySlow() { this._playOriginal(0.75); },

  /** 回放我的发音（本地 WAV 优先、云端直链回退；可只放词切片） */
  _playUserAudio(startSec, endSec, kind) {
    if (this.data.playing === kind) {
      this._stopPlayback();
      return true;
    }
    const result = this.data.result;
    const source = (result && result.userAudioPath) || (result && result.userAudioUrl) || '';
    if (!source) {
      wx.showToast({ title: '暂无录音可回放', icon: 'none' });
      return false;
    }
    this._playUrl(source, kind, {
      startSec: startSec != null ? startSec : 0,
      endSec: endSec != null ? endSec : null,
    });
    return true;
  },

  onPlayUserAudio() {
    if (this.data.phase !== 'result') return;
    this._playUserAudio(null, null, 'user');
  },

  /** 有道词典发音（type 2=美音 1=英音） */
  onPlayDictVoice(e) {
    const ds = e.currentTarget.dataset;
    const word = ds.word;
    const us = ds.us === '1' || ds.us === 1;
    const kind = us ? 'word_us' : 'word_uk';
    if (this.data.playing === kind) {
      this._stopPlayback();
      return;
    }
    const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + (us ? 2 : 1);
    this._playUrl(url, kind);
  },

  /** 词级原声：词级时间戳中定位选中词的绝对区间（模糊兜底匹配） */
  onPlayWordOriginal(e) {
    const word = e.currentTarget.dataset.word;
    if (this.data.playing === 'word_original') {
      this._stopPlayback();
      return;
    }
    const url = this.data.audioUrl;
    const sub = this._subs[this.data.index];
    const words = (sub && sub.words) || [];
    if (!url || !words.length) {
      wx.showToast({ title: '该句无词级时间戳', icon: 'none' });
      return;
    }
    const target = core.cleanWordKey(word);
    let hit = words.find((w) => core.cleanWordKey(w.word) === target);
    if (!hit) {
      let best = null;
      let bestD = Infinity;
      words.forEach((w) => {
        const d = core.cheapDistance(w.word, target);
        if (d < bestD) { bestD = d; best = w; }
      });
      hit = best;
    }
    if (!hit) {
      wx.showToast({ title: '原声中未找到该词', icon: 'none' });
      return;
    }
    this._playUrl(url, 'word_original', { startSec: hit.start, endSec: hit.end });
  },

  /** 词级「我」：录音中该词切片 */
  onPlayWordMe(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (this.data.playing === 'word_me') {
      this._stopPlayback();
      return;
    }
    const w = this.data.result && this.data.result.words && this.data.result.words[index];
    if (!w || w.start == null || w.end == null) {
      wx.showToast({ title: '该词无切片时间', icon: 'none' });
      return;
    }
    this._playUserAudio(w.start, w.end, 'word_me');
  },

  // ==================== 字幕区交互 ====================

  /** 句末「文/A」翻译切换（本地覆盖，换句/设置开关变化时回归默认） */
  onToggleCn() {
    this.setData({ showCn: !this.data.showCn });
  },

  /** 盲读「显示原文 / 重新遮挡」 */
  onToggleBlindReveal() {
    const revealed = !this.data.blindRevealed;
    this.setData({ blindRevealed: revealed, blindMasked: this.data.settings.textMode === 'blind' && !revealed });
    this._renderTokens();
  },

  /** 点词查词（与精听页同口径：清洗标点 → 词典 → 落库） */
  onWordTap(e) {
    const ds = e.currentTarget.dataset;
    const rawWord = String(ds.word || '');
    const cleanWord = rawWord.replace(/[.,!?;:"()'[\]]/g, '').trim();
    if (!cleanWord) return;
    const sub = this._subs[this.data.index];
    if (!sub) return;
    const lower = cleanWord.toLowerCase();
    this.setData({
      wordModal: {
        visible: true,
        word: cleanWord,
        dictData: null,
        loading: true,
        saving: false,
        isSaved: !!this._vocabSet[lower],
      },
    });
    get('/api/dict/' + encodeURIComponent(lower), null, { showError: false })
      .then((body) => {
        const m = this.data.wordModal;
        if (!m.visible || m.word !== cleanWord) return;
        if (body && body.success && body.data) {
          this.setData({ 'wordModal.dictData': body.data, 'wordModal.loading': false });
        } else {
          this.setData({ 'wordModal.loading': false });
        }
      })
      .catch((err) => {
        const m = this.data.wordModal;
        if (!m.visible || m.word !== cleanWord) return;
        this.setData({ 'wordModal.loading': false });
        if (err && err.code === 'DICTIONARY_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'dictionary_quota' });
        }
      });
  },

  onVocabClose() {
    this.setData({ 'wordModal.visible': false });
  },

  onVocabComplete() {
    this.setData({ 'wordModal.visible': false });
  },

  /** 保存生词（上下文取当前句原文/译文，时间戳优先词级起点） */
  onVocabSave() {
    const m = this.data.wordModal;
    const word = m.word;
    if (!word || m.saving) return;
    if (!authStore.getState().isLoggedIn) {
      wx.showToast({ title: '请先登录后再保存生词', icon: 'none' });
      return;
    }
    const sub = this._subs[this.data.index];
    this.setData({ 'wordModal.saving': true });
    const d = m.dictData || {};
    const definition = (d.definitions || [])
      .map((x) => '[' + x.pos + '] ' + x.meaning_cn)
      .join('; ');
    post('/api/vocabulary/add', {
      word,
      definition,
      contextSentence: sub ? sub.textEn : '',
      translation: (sub && sub.textCn) || '',
      episodeid: this._episodeId,
      timestamp: sub ? Math.round(sub.start) : 0,
    }, { showError: false })
      .then(() => {
        this._vocabSet[word.toLowerCase()] = true;
        this.setData({ 'wordModal.saving': false, 'wordModal.isSaved': true });
        if (this.data.tokens.length) this._renderTokens();
      })
      .catch(() => {
        this.setData({ 'wordModal.saving': false });
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      });
  },

  // ==================== 结果区交互 ====================

  /** 点橙色/红色单词展开音素诊断（<85 且有音素才可点） */
  onSelectWord(e) {
    const index = Number(e.currentTarget.dataset.index);
    const w = this.data.result && this.data.result.words && this.data.result.words[index];
    if (!w) return;
    if (w.score >= 85 || !w.phonemes.length) return;
    this.setData({ selectedWordIndex: this.data.selectedWordIndex === index ? null : index });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },
});
