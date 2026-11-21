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
 *   发音示范复用 utils/tts（真机 504 修复的下载中转 + dictvoice 降级 + 配额弹窗自持）
 *   原声/慢速切片 = Android MediaPlayer 等价移植：startTime 起播锚定 +
 *   onTimeUpdate 精确锚点 + 墙钟外推 50ms 看门狗到句尾即停（currentTime 是
 *   250~500ms 快照，直接轮询判停必然串进下一句开头）
 *
 * 与 Android 的对齐点：
 *   - 句子过滤（词数区间 + 只练未掌握）与历史匹配（subtitleId || 文本+起点差<0.5s）
 *   - 每句结果缓存（切句返回恢复）+ 历史记录恢复（云端录音直链 + detail 明细回填）
 *   - 盲读模式（遮挡/揭示，评测产出后自动揭示）、音标模式（逐词 IPA 预取缓存）
 *   - 达标 1.5s 自动跳下一句；评测配额墙（403 → 会员弹窗）
 *   - 点词查词与精听页共用 vocabulary-modal 同一口径
 */
const { get, post } = require('../../utils/request');
const core = require('../../utils/speech-core');
const authStore = require('../../store/authStore');
const audioBus = require('../../utils/audio-bus');
const { createClipPlayer } = require('../../utils/clip-player');
const tts = require('../../utils/tts');
const audioClip = require('../../utils/audio-clip');
const { findSubtitle, resolveEpisode } = require('../../utils/episode-context');
const { resolveReviewSubtitle } = require('../../utils/review-subtitle');
const { buildSentenceTokens } = require('../../utils/sentence-tokens');
const trainingLookup = require('../../utils/training-word-lookup');
const theme = require('../../utils/theme');

const SETTINGS_KEY = 'speechPracticeSettings';
const PCM_RATE = 16000;
const MIN_RECORD_BYTES = PCM_RATE * 2 * 0.5; // 0.5s 的 16bit mono PCM
const AUTO_ADVANCE_DELAY = 1500;
const AMP_WINDOW = 24; // 波形滚动窗口（渲染条数，Android takeLast(24)）

Page({
  ...trainingLookup,
  data: {
    statusBarH: 20,
    gearRightPx: 100, // 齿轮与原生胶囊避让（右偏移 = 屏宽 - 胶囊左缘 + 8）
    dark: false,
    loop: false,
    bookmarked: false,
    themeMode: 'system',
    themeClass: '', // 手动外观根类（全局令牌体系——vocabulary-modal 等共享组件依赖；跟随系统为空走媒体查询）

    // 加载态
    loading: true,
    loadError: null,
    episodeTitle: '',
    isTrialMode: false,
    isSceneMode: true, // 微剧场模式（T5.1）
    subs: [],          // 字幕列表（供 WXML AB 接龙面板索引文本）
    // AB 角语境接龙（T5.1，仅微剧场模式）
    abMode: false,
    blindMode: false, // 换我接话：隐 B 句英文，仅示中文意图与提示词
    abPairs: [],
    abActive: -1,
    abPhase: 'idle', // idle → loading → playing → countdown → starting → recording → evaluating → result
    abCountdown: 0,
    abResult: null, // { accuracy, fluency, wpmMatch, userSec, nativeWpm, userAudioPath }
    abHints: [],
    abIntent: '',
    abZhA: false, // A 句中文翻译展开
    abZhB: false, // B 句中文翻译展开
    quotaLocked: false, // 评测日池耗尽且非会员：录音面渲染锁定引导卡（eval-card locked 同口径）

    // 句子游标与派生态
    index: 0,
    indexLabel: '0 / 0',
    subsEmpty: false,
    practicedCount: 0,
    progressPercent: 0,
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
    wordModal: null,
    lookupQuota: '',
    showPremiumModal: false,
    premiumSource: 'review_eval_quota',
  },

  onLoad(query) {
    this._playRequest = 0;
    this._abRun = 0;
    this._sources = new Map();
    this._episodeId = '';
    this._sceneId = (query && (query.sceneId || query.scene)) || '';
    this._focusSubtitleId = query && query.focus ? parseInt(query.focus, 10) : null;

    this._allSubs = [];      // 全量字幕（过滤输入）
    this._savedMap = {};     // 本集已收藏句子书签态（subtitleId → true）
    this._subs = [];         // 过滤后字幕
    this._records = [];      // 历史评测记录
    this._resultCache = {};  // subtitleId → 最近一次结果（切句恢复）
    this._ipaCache = {};     // 词键 → US 音标（已剥斜杠）
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
      themeClass: theme.rootClass(),
      dark: theme.getEffective() === 'dark',
      settings,
      effectiveThreshold: core.effectivePassThreshold(settings),
      fontSizeCls: 'se-fs-' + settings.fontSizeLevel,
    });

    this._initRecorder();
    this._unTheme = theme.subscribe(() => this._onThemeChange());
    this._onAudioInterrupt = () => {
      if (this.data.abMode && ['loading', 'playing', 'countdown'].includes(this.data.abPhase)) this._abortAb();
      else this._stopPlayback();
    };
    this._unbus = audioBus.register(this._onAudioInterrupt);
    theme.applyChrome(); // 深色下把胶囊刷成深底白图标（frontColor 联动，见 _onThemeChange 注释）

    // 发音示范走 tts.js 全链（真机 504 修复的 downloadFile 中转 + dictvoice 降级）：
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

    if (query && query.weak) {
      try {
        // 兼容微信传回编码串，以及已解码的启动参数（原句可能包含 %）。
        const raw = query.weak;
        const target = JSON.parse(raw.startsWith('{') ? raw : decodeURIComponent(raw));
        if (target.episodeid && target.text) this._weakTarget = target;
      } catch (_) { /* 参数损坏时走下方缺参提示。 */ }
    }
    this.onRetry();
  },

  onHide() {
    this._hidden = true;
    if (this.data.abMode && !['idle', 'result'].includes(this.data.abPhase)) this._abortAb();
    else this._stopPlayback();
    this._discardRecording();
    this._cancelAdvance();
  },

  onShow() {
    this._hidden = false;
    if (this._savedWords) this._syncSavedWords();
    this._resumeLookupPlayback();
  },

  onUnload() {
    this._hidden = true;
    this._lookupId = (this._lookupId || 0) + 1;
    this._lookupPlayback = null;
    this._savedWords = null;
    this._abortAb();
    this._destroyed = true; // 录音机的迟到回调不再 setData
    if (this._unbus) this._unbus();
    if (this._unTheme) this._unTheme();
    if (this._unsubTts) this._unsubTts();
    tts.stop();
    tts.setQuotaHandler(this._prevQuota || null);
    this._cancelAdvance();
    this._discardRecording();
  },

  noop() {},

  /** 收起：返回上一页（无上一页时回首页兜底） */
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
    this.setData({
      themeMode: snap.mode,
      themeClass: snap.rootClass,
      dark: snap.effective === 'dark',
    });
    // 手动深/浅色下重申胶囊前景（frontColor 白 → 胶囊深底白图标）；
    // 自定义导航页 setNavigationBarColor 不改导航栏（本就不可见），但胶囊样式联动有效
    theme.applyChrome();
  },

  // ==================== 数据加载 ====================

  async onRetry() {
    const target = this._weakTarget;
    this.setData({ loading: true, loadError: null });
    try {
      if (target) {
        const params = { episodeid: target.episodeid };
        if (target.subtitleId != null) params.subtitleId = target.subtitleId;
        if (target.timestamp > 0) params.t = target.timestamp;
        if (params.subtitleId != null || params.t != null) {
          const body = await get('/api/scenes/by-clip', params, { showError: false });
          const match = body && body.success && body.data;
          if (this._destroyed) return;
          if (match && match.sceneid && !match.nearest && await this._loadScene(match.sceneid)) return;
        }
      } else if (this._sceneId) {
        await this._loadScene(this._sceneId);
        return;
      } else {
        throw new Error('缺少练习句子或微剧场参数');
      }
    } catch (err) {
      if (this._destroyed) return;
      if (!target || err.statusCode === 401 || err.statusCode === 403) {
        this.setData({ loading: false, loadError: err.message || '微剧场加载失败' });
        return;
      }
    }
    if (!this._destroyed) await this._loadWeakSentence(target);
  },

  async _loadScene(sceneId) {
    const body = await get('/api/scenes/' + encodeURIComponent(sceneId), null, { showError: false });
    if (this._destroyed) return true;
    if (!body || !body.success || !body.data || !body.data.scene) {
      throw new Error((body && body.message) || '微剧场加载失败');
    }
    const scene = body.data.scene;
    const parsed = core.parseSceneData(body);
    let focusIndex = 0;
    if (this._weakTarget) {
      const target = this._weakTarget;
      if (scene.episodeid !== target.episodeid) return false;
      const clips = scene.clips || [];
      const candidates = clips.filter(c => target.subtitleId != null
        ? c.subtitleId === target.subtitleId
        : c.start <= target.timestamp && target.timestamp < c.end);
      focusIndex = clips.indexOf(findSubtitle(candidates, target));
      if (focusIndex < 0) return false;
    } else if (this._focusSubtitleId != null) {
      focusIndex = Math.max(0, parsed.subtitles.findIndex(sub => sub.id === this._focusSubtitleId));
    }
    this._episodeId = scene.episodeid;
    this._sceneAudio = {
      clipId: sceneId, clipAudioUrl: parsed.audioUrl, clipOffset: body.data.clipOffset,
      clipDuration: body.data.clipDuration,
    };
    this._showSentences(parsed.subtitles, scene.clips || [], parsed.episodeTitle, focusIndex, true);
    return true;
  },

  async _loadWeakSentence(target) {
    let row;
    try {
      const episode = await resolveEpisode(target.episodeid);
      row = findSubtitle(episode.subs, target);
    } catch (_) { /* 原声暂不可用时仍可依照弱项原文录音评测。 */ }
    if (this._destroyed) return;
    this._episodeId = target.episodeid;
    this._sceneAudio = null;
    const clip = {
      subtitleId: row && row.id != null ? row.id : target.subtitleId,
      textEn: target.text, textCn: row && row.textCn || '',
      start: row ? Number(row.start) : target.timestamp, end: row ? Number(row.end) : null,
      words: row && Array.isArray(row.words) ? row.words : [],
    };
    const sub = {
      id: clip.subtitleId, textEn: clip.textEn, textCn: clip.textCn,
      start: clip.start || 0, end: clip.end || clip.start || 0,
      words: clip.words.filter(w => w && typeof w.word === 'string' && w.end > w.start),
    };
    this._showSentences([sub], [clip], target.title, 0, false);
  },

  _showSentences(subtitles, clips, title, focusIndex, isSceneMode) {
    this._clips = new Map();
    this._sources.clear();
    subtitles.forEach((sub, i) => {
      this._clips.set(sub, clips[i]);
      sub.tokens = buildSentenceTokens(sub.textEn, '', sub.words, sub.start, sub.end);
    });
    this._allSubs = this._subs = subtitles;
    this.setData({
      loading: false, episodeTitle: title || '', isSceneMode, subs: subtitles,
      abPairs: isSceneMode ? core.buildAbPairs(subtitles, clips) : [],
    });
    this._applySentence(focusIndex, null);
    if (subtitles[focusIndex]) this._restoreFromHistory(subtitles[focusIndex].id);
    this._syncSavedWords();
    this._fetchSaveState();
    this._preflightQuota();
  },

  // ==================== AB 角语境接龙（T5.1，仅微剧场模式） ====================

  // 场景直链尚未生成时，用 sceneId 懒取。切片失败才按单句切片或剧集字幕定位。
  async _resolveSource(sub) {
    const scene = this._sceneAudio;
    const clip = this._clips.get(sub);
    let source;
    try {
      source = await audioClip.resolveClipSource(scene, { showError: false });
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) throw err;
    }
    const result = await resolveReviewSubtitle({
      textEn: sub.textEn, textCn: sub.textCn, subtitleId: sub.id, episodeid: this._episodeId,
      startTime: clip.start, endTime: clip.end, clipWords: clip.words, clipId: clip.clipid,
      clipAudioUrl: source && source.url, clipOffset: source && source.offset,
      clipDuration: source && source.duration,
    });
    if (!result.audioUrl) throw new Error('未找到这句的原声，请稍后重试');
    return result;
  },

  _sentenceSource(sub) {
    if (!this._sources.has(sub)) {
      const promise = this._resolveSource(sub).catch((err) => {
        this._sources.delete(sub);
        throw err;
      });
      this._sources.set(sub, promise);
    }
    return this._sources.get(sub);
  },

  onToggleAbMode() {
    if (!this.data.isSceneMode) return;
    if (!this.data.abMode && (this.data.phase === 'evaluating' || this._recordWanted)) return;
    const abMode = !this.data.abMode;
    this._abortAb();
    this._cancelAdvance();
    tts.stop();
    this.setData({ abMode, abActive: -1 });
    if (abMode) {
      this._drillSubs = this._subs;
      this._drillIndex = this.data.index;
      const focus = this._allSubs.indexOf(this._subs[this.data.index]);
      this._subs = this._allSubs;
      if (this.data.abPairs.length) this._selectPair(Math.max(0, focus - 1));
    } else {
      this._subs = this._drillSubs;
      const sub = this._subs[this._drillIndex];
      this._applySentence(this._drillIndex, sub && this._resultCache[sub.id]);
    }
  },

  onToggleBlind() {
    this.setData({ blindMode: !this.data.blindMode });
  },

  _selectPair(idx) {
    const pair = this.data.abPairs[idx];
    if (!pair) return;
    const b = this._subs[pair.bIdx];
    this.setData({ abActive: idx, abHints: core.blindHints(b.textEn, 2), abIntent: b.textCn || '',
      abZhA: false, abZhB: false });
  },

  /** A/B 句末翻译图标：展开/收起该句中文 */
  onToggleAbZh(e) {
    const side = e.currentTarget.dataset.side;
    if (side === 'a') this.setData({ abZhA: !this.data.abZhA });
    else if (side === 'b') this.setData({ abZhB: !this.data.abZhB });
  },

  /** AB 面板点词查词：语境例句按所点句（A 或 B），非当前句 */
  onAbWordTap(e) {
    if (!['idle', 'result'].includes(this.data.abPhase)) return;
    const word = e.currentTarget.dataset.word;
    const subIdx = Number(e.currentTarget.dataset.sub);
    if (!word || !/[a-z]/i.test(word) || !this._subs[subIdx]) return;
    this._abLookupSubIdx = subIdx;
    this._cancelAdvance();
    return this.onWordLookup({ detail: { word } });
  },

  /** B 句末回放自己刚才的接龙录音（与页内其他音频互斥） */
  onAbReplayUser() {
    const path = this.data.abResult && this.data.abResult.userAudioPath;
    if (!path) return;
    if (this.data.playing === 'ab-user') return this._stopPlayback();
    this._playUrl(path, 'ab-user');
  },

  onAbPick(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (!this.data.abPairs[idx]) return;
    this._abortAb();
    this._selectPair(idx);
  },

  async onAbStart() {
    const idx = this.data.abActive;
    const pair = this.data.abPairs[idx];
    if (!this.data.abMode || !pair || !['idle', 'result'].includes(this.data.abPhase)) return;
    if (this.data.quotaLocked) return this.onUnlockEval();
    this._abortAb();
    const run = this._abRun;
    this.setData({ abPhase: 'loading' });
    try {
      if (!await this._ensureRecordPermission()) throw new Error('请允许使用麦克风后再开始接龙');
      if (run !== this._abRun) return;
      const source = await this._sentenceSource(this._subs[pair.aIdx]);
      if (run !== this._abRun) return;
      this._playUrl(source.audioUrl, 'ab', {
        startSec: source.start, endSec: source.end, tokens: source.sentenceTokens,
        onPlaying: () => this.setData({ abPhase: 'playing' }),
        onEnded: () => {
          if (run !== this._abRun) return;
          if (this.data.abPhase === 'playing') this._abCountdown(idx, run);
          else {
            this._abortAb();
            wx.showToast({ title: '原声未能起播，请重试', icon: 'none' });
          }
        },
      });
    } catch (err) {
      if (run !== this._abRun) return;
      this._abortAb();
      wx.showToast({ title: err.message || '原声加载失败，请重试', icon: 'none' });
    }
  },

  _abCountdown(idx, run) {
    this.setData({ abPhase: 'countdown', abCountdown: 3 });
    this._abCountTimer = setInterval(() => {
      if (run !== this._abRun) return;
      const n = this.data.abCountdown - 1;
      if (n > 0) return this.setData({ abCountdown: n });
      clearInterval(this._abCountTimer);
      this._abCountTimer = null;
      if (this.data.quotaLocked) {
        this._abortAb();
        return this.onUnlockEval();
      }
      const pair = this.data.abPairs[idx];
      this._applySentence(pair.bIdx, null);
      this._abPending = { pair, run };
      this.setData({ abPhase: 'starting' });
      this._startRecording();
    }, 1000);
  },

  _abortAb() {
    ++this._abRun;
    clearInterval(this._abCountTimer);
    clearTimeout(this._abTimer);
    this._abCountTimer = this._abTimer = null;
    this._stopPlayback();
    const pending = this._abPending;
    this._abPending = null;
    if (pending) {
      this._discardRecording();
      this.setData({ phase: 'idle' });
    }
    this.setData({ abPhase: 'idle', abResult: null });
  },

  onAbNext() {
    const idx = this.data.abActive + 1;
    if (!this.data.abPairs[idx]) return;
    this._abortAb();
    this._selectPair(idx);
    this.onAbStart();
  },

  onAbStop() {
    if (this.data.abPhase === 'recording') this._finishRecording();
    else this._abortAb();
  },

  /**
   * 评测日池预检（闯关页 _preflightQuota 同口径）：入口即知余量，普通用户
   * 耗尽即锁定录音面（渲染「解锁无限评测」引导卡）；预检失败不置锁——评测
   * 403 时自会永久置锁兜底。scenario=learn（本页属剧集学习流；后端统一日池，
   * scenario 仅作画像维度）。
   */
  _preflightQuota() {
    if (!authStore.getState().isLoggedIn) return;
    this._fetchQuota();
  },

  /** 拉取日池余量并归一（预检与每次评测后刷新共用） */
  _fetchQuota() {
    get('/api/speech/quota?scenario=learn', null, { showError: false })
      .then((body) => {
        if (body && body.success && body.data) this._applyQuota(body.data);
      })
      .catch(() => {}); // 静默：余量刷新失败不干扰练习
  },

  /**
   * 配额状态归一（Web refreshQuota：remaining/isPremium/exhausted 三字段），
   * 双向均需证据——置锁要求耗尽证据（exhausted=true 或 remaining=0），解锁
   * 要求可用证据（isPremium 或 remaining>0）；空回包/缺字段保持现态不翻转
   * （勿因残缺回包把已锁态误开）。跨天回访余量恢复、已购会员均随回包解锁。
   */
  _applyQuota(q) {
    const src = q || {};
    const isPremium = src.isPremium === true;
    const hasRemaining = typeof src.remaining === 'number' && src.remaining > 0;
    const exhausted =
      src.exhausted === true ||
      (typeof src.remaining === 'number' && src.remaining <= 0);
    let quotaLocked = this.data.quotaLocked;
    if (isPremium || hasRemaining) quotaLocked = false;
    else if (exhausted) quotaLocked = true;
    if (quotaLocked !== this.data.quotaLocked) this.setData({ quotaLocked });
  },

  // ==================== 派生态同步 ====================

  _syncDerived() {
    const subs = this._subs;
    const idx = this.data.index;
    let practiced = 0;
    for (let i = 0; i < subs.length; i++) {
      if (core.latestRecordFor(subs[i], this._records)) practiced++;
    }
    this.setData({
      indexLabel: (idx + 1) + ' / ' + subs.length,
      subsEmpty: subs.length === 0,
      practicedCount: practiced,
      progressPercent: subs.length ? Math.round((practiced / subs.length) * 100) : 0,
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
      cardKey: 'se-' + sub.id,
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
    this._refreshBookmarked();
  },

  /** 字幕 token / 盲读遮挡条 / 字号档位（音标模式替换展示文本） */
  _renderTokens() {
    const sub = this._subs[this.data.index];
    if (!sub) return;
    const ipaMap = this.data.settings.textMode === 'ipa' ? this._ipaCache : null;
    const tokens = sub.tokens.map((t) => ({
      d: (ipaMap && ipaMap[core.cleanWordKey(t.text)]) || t.text,
      w: t.text, before: t.before, after: t.after,
      sv: this._savedWords && this._savedWords.has(core.cleanWordKey(t.text)) ? 1 : 0,
    }));
    // 盲读遮挡条：宽 = 字号×0.62×词长（dp→rpx ×2），高 = 字号 + 6dp
    const fsPx = [34, 40, 48][this.data.settings.fontSizeLevel] || 40;
    const blindBars = sub.tokens.map((token) => ({
      w: Math.round(fsPx * 0.62 * Math.max(2, token.text.length)),
      h: fsPx + 12,
    }));
    this.setData({
      tokens,
      blindBars,
      blindMasked: this.data.settings.textMode === 'blind' && !this.data.blindRevealed,
    });
  },

  switchSentence(index) {
    if (this.data.abMode || this.data.wordModal) return;
    const subs = this._subs;
    if (index < 0 || index >= subs.length || index === this.data.index) return;
    this._stopPlayback();
    tts.stop(); // 发音示范随切句停止（单一时间轴）
    this._cancelAdvance();
    this._discardRecording();
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
    target.tokens.forEach((t) => {
      const k = core.cleanWordKey(t.text);
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
    if (this.data.abMode) return;
    this.setData({ showSettings: true });
  },

  onCloseSettings() {
    this.setData({ showSettings: false });
  },

  onSettingChange(e) {
    if (this.data.abMode) return;
    const detail = e.detail || {};
    const patch = {};
    if (detail.key) patch[detail.key] = detail.value; // detail 形如 {key, value}
    const settings = core.normalizeSettings(Object.assign({}, this.data.settings, patch));
    wx.setStorageSync(SETTINGS_KEY, settings);
    const prev = this.data.settings;
    const prevSub = this._subs[this.data.index];

    const filtered = this.data.isSceneMode ? core.applyFilters(this._allSubs, this._records, settings) : this._allSubs;
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
      this._stopPlayback();
      this._discardRecording();
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
      if (this._destroyed || !this._recordWanted) return;
      if (this._abPending) {
        const { run, pair } = this._abPending;
        this.setData({ abPhase: 'recording' });
        // 自动收音上限按母语窗口 ×2 + 3 秒给足（8s 起 58s 封顶）：
        // 旧口径 windowSec + 1.8s 对学习者太紧，常在读完整句前被掐断。
        this._abTimer = setTimeout(() => {
          if (run === this._abRun && this.data.abPhase === 'recording') this._finishRecording();
        }, core.abRecordingCeilingSec(pair.bWindowSec) * 1000);
      }
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
      if (this._destroyed || !this._recordWanted) return;
      this._recordWanted = false;
      if (this._abPending) this._abortAb();
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
    // 配额锁定兜底（空闲面的按钮已被锁定卡替换，此处防余量回包竞态）
    if (this.data.quotaLocked) {
      this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
      return;
    }
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
    if (!this._hidden && !this._destroyed && !this.data.abMode && !this.data.wordModal) this._startRecording();
  },

  _discardRecording() {
    if (!this._recordWanted) return;
    this._recordWanted = false;
    this._pcmFrames = null;
    this.setData({ phase: 'idle', amplitudes: [] });
    try { this._recorder.stop(); } catch (_) {}
  },

  _startRecording() {
    this._stopPlayback();
    tts.stop(); // 录音期间静音（发音示范/回放一并停）
    this._cancelAdvance();
    this._recordWanted = true;
    try {
      this._recorder.start({
        format: 'PCM',          // onFrameRecorded 实时帧 → 音量波形 + 停止时封装 WAV
        sampleRate: PCM_RATE,
        numberOfChannels: 1,
        frameSize: 1,           // 1KB/帧 ≈ 32ms，音量刷新粒度
        duration: 60000,        // 60s 上限：到点自动停止（onStop 触发时兜底走评测）
      });
    } catch (e) {
      this._recordWanted = false;
      if (this._abPending) this._abortAb();
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
    this._recordWanted = false;
    clearTimeout(this._abTimer);
    if (this._abPending) this.setData({ abPhase: 'evaluating' });
    try { this._recorder.stop(); } catch (e) { /* stop 失败不影响内存帧评测 */ }
    if (!frames.length && tempFilePath) {
      try {
        const buf = wx.getFileSystemManager().readFileSync(tempFilePath);
        if (buf && buf.byteLength) frames.push(buf);
      } catch (e) { /* 兜底失败 → 走"录音太短"提示 */ }
    }
    this._evaluateFrames(frames);
  },

  _evaluateFrames(frames) {
    const ab = this._abPending;
    frames = frames || [];
    let totalBytes = 0;
    for (let i = 0; i < frames.length; i++) totalBytes += frames[i].byteLength;

    this.setData({ phase: 'evaluating', amplitudes: [] });

    if (totalBytes < MIN_RECORD_BYTES) {
      if (ab) this._abortAb();
      this.setData({ phase: 'idle' });
      wx.showToast({ title: '录音太短，请重试', icon: 'none' });
      return;
    }
    const sub = this._subs[this.data.index];
    if (!sub) {
      if (ab) this._abortAb();
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
      if (ab) this._abortAb();
      this.setData({ phase: 'idle' });
      return;
    }

    const userSec = totalBytes / (PCM_RATE * 2);
    post('/api/speech/evaluate', {
      episodeId: this._episodeId,
      subtitleId: sub.id,
      targetText: sub.textEn,
      audioBase64,
      rate: PCM_RATE,
    }, { timeout: 60000, showError: false })
      .then((body) => {
        if (this._destroyed || (ab && ab.run !== this._abRun)) return;
        if (!body || body.success === false) {
          throw Object.assign(new Error((body && (body.message || body.error)) || '评测失败，请重试'), { body });
        }
        const evaluated = core.parseEvalResponse(body);
        evaluated.userAudioPath = localPath;
        this._resultCache[sub.id] = evaluated;
        // AB 接龙结果（T5.1）：三指标卡（准确度/流利度/母语语速吻合度）
        if (ab) {
          const pair = ab.pair;
          const wordCount = String(sub.textEn || '').split(/\s+/).filter((w) => w.length > 0).length;
          const abResult = {
            accuracy: evaluated.pronunciation,
            fluency: evaluated.fluency,
            wpmMatch: core.computeWpmMatch(userSec, pair.bNativeWpm, wordCount),
            userSec: Math.round((userSec || 0) * 10) / 10,
            nativeWpm: pair.bNativeWpm,
            userAudioPath: localPath, // B 句末「回放我的接龙」音源（本地 WAV）
          };
          this._abPending = null;
          if (this._abTimer) { clearTimeout(this._abTimer); this._abTimer = null; }
          this.setData({ abPhase: 'result', abResult });
        }

        const newRecord = core.parseRecordDto({
          recognitionid: evaluated.recognitionId || Date.now(),
          accuracyScore: evaluated.pronunciation,
          overallScore: evaluated.overallScore,
          fluencyScore: evaluated.fluency,
          integrityScore: evaluated.integrity,
          speed: evaluated.speed,
          targetText: sub.textEn,
          targetStartTime: Math.round(this._clips.get(sub).start),
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
        this._fetchQuota(); // 评测后刷新日池：第 5 次用完即置锁，回空闲面渲染锁定卡
      })
      .catch((err) => {
        if (this._destroyed || (ab && ab.run !== this._abRun)) return;
        if (ab) this._abortAb();
        const cur = this._subs[this.data.index];
        if (!this._destroyed && cur && cur.id === sub.id) {
          this.setData({ phase: 'idle' });
        }
        const body = err && err.body;
        if (err && err.statusCode === 403) {
          // 配额墙：后端 message 携带升级文案（月池/日池共用 403 口径）；
          // 永久置锁（本会话内空闲面不再渲染录音钮，eval-card 同口径）
          wx.showToast({ title: (body && body.message) || '今日免费评测次数已用完', icon: 'none', duration: 2500 });
          this.setData({ quotaLocked: true, showPremiumModal: true, premiumSource: 'review_eval_quota' });
        } else {
          wx.showToast({ title: (err && err.message) || '评测失败，请重试', icon: 'none' });
        }
      });
  },

  /** 达标 1.5s 后自动跳下一句（Android maybeAutoAdvance 同口径） */
  _maybeAutoAdvance(score) {
    if (this._hidden || this.data.abMode || this.data.wordModal || !this.data.settings.autoAdvance) return;
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

  // ==================== 页内播放（单 InnerAudioContext 互斥） ====================

  _stopSweep() {
    this._sweepWords = null;
    if (this.data.sweepIdx !== -1 || this.data.sweepOn) {
      this.setData({ sweepIdx: -1, sweepOn: false });
    }
  },

  _stopPlayback() {
    ++this._playRequest;
    this._playOptions = null;
    if (this._player) this._player.stop();
    this._stopSweep();
  },

  _playUrl(url, kind, opts) {
    this._stopPlayback();
    if (!this._player) {
      this._player = createClipPlayer({
        onInterrupt: this._onAudioInterrupt,
        onPlaying: (active) => {
          this.setData({ playing: active || 'none' });
          if (!active) this._stopSweep();
          else if (this._playOptions && this._playOptions.onPlaying) this._playOptions.onPlaying();
        },
        onTick: (t) => this._onSweepTick(t),
        onEnded: (ended) => {
          if (this._playOptions && this._playOptions.onEnded) this._playOptions.onEnded();
          else this._maybeLoopReplay(ended);
        },
        onError: (failed) => { if (failed === 'ab') this._abortAb(); },
      });
    }
    this._playOptions = opts || {};
    this._sweepWords = this._playOptions.tokens;
    this._player.playUrl(url, kind, this._playOptions);
  },

  /** 原声/慢速播放的词级扫光（词级时间戳同轴，最小差量下发） */
  _onSweepTick(t) {
    const words = this._sweepWords;
    if (!words || !words.length) return;
    const start = words[0].start;
    const end = words[words.length - 1].end;
    const sw = core.computeWordSweep(words, t, start, end);
    if (sw.idx !== this.data.sweepIdx || sw.on !== this.data.sweepOn) {
      this.setData({ sweepIdx: sw.idx, sweepOn: sw.on });
    }
  },

  /** 发音示范（tts.js 全链：有道 TTS 合成 → 下载中转 → 流播/短文本 dictvoice 降级） */
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

  /** 全句窗口和逐词时间均来自同一个已解析音源。 */
  async _playOriginal(speed, resumeAt) {
    if (this.data.phase === 'evaluating' || this.data.phase === 'recording' || this.data.abMode) return;
    const kind = speed < 1 ? 'slow' : 'original';
    const stop = this._player && this._player.getKind() === kind && resumeAt == null;
    this._stopPlayback();
    const sub = this._subs[this.data.index];
    if (!sub || stop) return;
    const request = this._playRequest;
    try {
      const source = await this._sentenceSource(sub);
      if (request !== this._playRequest || this._hidden || this.data.wordModal) return;
      this._playUrl(source.audioUrl, kind, {
        startSec: resumeAt == null ? source.start : Math.max(source.start, resumeAt),
        endSec: source.end, rate: speed, tokens: source.sentenceTokens,
      });
    } catch (err) {
      if (request === this._playRequest) wx.showToast({ title: err.message || '原声加载失败，请重试', icon: 'none' });
    }
  },

  onPlayOriginal() { this._playOriginal(1); },

  onPlaySlow() { this._playOriginal(0.75); },

  // ==================== 收藏书签 / 单句循环（eval-card 同款口径） ====================

  /** 书签态回填：GET /api/sentences/keys（本集已收藏 subtitleId 集） */
  _fetchSaveState() {
    if (!this._episodeId) return;
    get('/api/sentences/keys?episodeid=' + this._episodeId, null, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        const map = {};
        (body.data.subtitleIds || []).forEach((id) => { map[id] = true; });
        this._savedMap = map;
        this._refreshBookmarked();
      })
      .catch(() => {});
  },

  /** 当前句书签态派生（切句/回填/toggle 后统一出口） */
  _refreshBookmarked() {
    const sub = this._subs[this.data.index];
    const bookmarked = !!(sub && this._savedMap && this._savedMap[sub.id]);
    if (bookmarked !== this.data.bookmarked) this.setData({ bookmarked });
  },

  /** 收藏书签：POST /api/sentences/toggle 乐观翻转 + saved 回填 + 失败回滚 */
  onToggleBookmark() {
    if (this._bookmarkBusy) return;
    const sub = this._subs[this.data.index];
    if (!sub) return;
    const clip = this._clips.get(sub);
    if (sub.id == null || !(clip.end > clip.start)) {
      wx.showToast({ title: '该句暂无可收藏的字幕位置', icon: 'none' });
      return;
    }
    this._bookmarkBusy = true;
    const target = !this.data.bookmarked;
    this._savedMap = Object.assign({}, this._savedMap);
    if (target) this._savedMap[sub.id] = true;
    else delete this._savedMap[sub.id];
    this._refreshBookmarked(); // 乐观翻转

    post('/api/sentences/toggle', {
      episodeid: this._episodeId,
      subtitleId: sub.id,
      startTime: this._clips.get(sub).start,
      endTime: this._clips.get(sub).end,
      enText: sub.textEn,
      zhText: sub.textCn,
    }, { showError: false })
      .then((body) => {
        if (!body || body.success === false) {
          if (target) delete this._savedMap[sub.id];
          else this._savedMap[sub.id] = true;
          this._refreshBookmarked();
          wx.showToast({ title: (body && body.message) || '操作失败，请重试', icon: 'none' });
          return;
        }
        const saved = body.data ? !!body.data.saved : target;
        this._savedMap = Object.assign({}, this._savedMap);
        if (saved) this._savedMap[sub.id] = true;
        else delete this._savedMap[sub.id];
        this._refreshBookmarked();
        wx.showToast({
          title: saved ? '已收藏至「句子本」' : '已从「句子本」移除',
          icon: 'none',
        });
      })
      .catch((err) => {
        if (target) delete this._savedMap[sub.id];
        else this._savedMap[sub.id] = true;
        this._refreshBookmarked();
        if (err && err.statusCode === 403) {
          // 句子本容量墙（满 30）：只弹会员窗不叠 toast（Web #14 口径）
          this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
        } else {
          wx.showToast({ title: (err && err.message) || '网络错误', icon: 'none' });
        }
      })
      .then(() => { this._bookmarkBusy = false; });
  },

  /** 单句循环开关：开 = 原声/慢速到窗终自动重播；关 = 播完即停（不打断在播） */
  onToggleLoop() {
    this.setData({ loop: !this.data.loop });
  },

  /** 窗终/播完时的循环重播判定：命中原声/慢速循环则重播并返回 true */
  _maybeLoopReplay(ended) {
    if (!this.data.loop) return false;
    const kind = ended || this.data.playing;
    if (kind !== 'original' && kind !== 'slow') return false;
    const speed = kind === 'slow' ? 0.75 : 1;
    this._stopPlayback();
    this._playOriginal(speed);
    return true;
  },

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
  async onPlayWordOriginal(e) {
    const word = e.currentTarget.dataset.word;
    if (this.data.playing === 'word_original') {
      this._stopPlayback();
      return;
    }
    const sub = this._subs[this.data.index];
    if (!sub) return;
    this._stopPlayback();
    const request = this._playRequest;
    let source;
    try { source = await this._sentenceSource(sub); }
    catch (err) {
      if (request === this._playRequest) wx.showToast({ title: err.message || '原声加载失败', icon: 'none' });
      return;
    }
    if (request !== this._playRequest) return;
    const url = source.audioUrl;
    const words = source.sentenceTokens.map((t) => ({ word: t.text, start: t.start, end: t.end }));
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

  onWordTap(e) {
    if (this.data.phase === 'recording' || this._recordWanted) return;
    const word = e.currentTarget.dataset.word;
    if (!word || !/[a-z]/i.test(word)) return;
    this._cancelAdvance();
    return this.onWordLookup({ detail: { word } });
  },

  getLookupClip() {
    // AB 面板点词时按所点句（A/B）取语境例句，其余场合按当前句
    const sub = this._subs[this._abLookupSubIdx != null ? this._abLookupSubIdx : this.data.index];
    const clip = sub && this._clips.get(sub);
    return clip && { ...clip, episodeid: this._episodeId };
  },

  onVocabClose() {
    this._abLookupSubIdx = null; // 查词弹窗关闭后回到「当前句」语境
    trainingLookup.onVocabClose.call(this);
  },

  getLookupPlayer() { return this; },

  onSavedWordsChange() { this._renderTokens(); },

  pauseForLookup() {
    const kind = this._player && this._player.getKind();
    const position = this._player && this._player.estimatedPos();
    this._stopPlayback();
    tts.stop();
    return kind === 'original' || kind === 'slow' ? { kind, position } : null;
  },

  resumeAfterLookup(state) {
    this._playOriginal(state.kind === 'slow' ? 0.75 : 1, state.position);
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

  /** 锁定卡解锁 CTA → 会员转化弹窗（订阅页未建〔模块 E〕，premium-modal 现行出口） */
  onUnlockEval() {
    this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },
});
