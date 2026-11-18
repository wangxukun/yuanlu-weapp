/**
 * pages/discover/index — 原声微流（SoundBite Reels · yuanlu 真实语料版）
 *
 * ── 模块意图（四功能）────────────────────────────────────────
 * ① 极简微刷：swiper 纵向轻划切换切片（4～10s 纯正原生单句），
 *    背景融合原节目封面毛玻璃氛围层；
 * ② 卡拉OK级毫秒扫光：wordsJson 词级时间戳 − clipOffset（切片本地
 *    时间轴，对齐 weapp speech-core 协议），当前词琥珀点亮、已读词
 *    转主题绿，50ms onTick 最小差量 setData；
 * ③ 点词即查：/api/dict/[word] + vocabulary-modal（A工程 成熟链路）；
 * ④ 深度透视：POST /api/clips/deep-dive（DeepSeek 四维分析 + 服务端
 *    兜底文案），网络不可达回落 B 原型固定文案。
 *
 * ── 数据与音频 ───────────────────────────────────────────────
 * feed：GET /api/clips/feed（isJunkClip 4-10s 门禁 + 红线词过滤 + 每集≤2
 *   + 页种子乱序）；网络失败回落 reels-corpus 本地 mock（real:false，
 *   头部亮「沙箱语料」徽章）。滑至倒数第 3 条自动翻页追加。
 * 音频：唯一出口 /api/clips/{id}/audio（{url, duration, clipOffset}）。
 *   feed 预签条直连；未签条滑到时懒取（OSS 永久缓存，二次滑过秒播）。
 *   会员专享 403 → toast 提示（feed 侧亮「会员专享」pill）。
 * 收藏：真实切片（episodeid+subtitleId 齐备）走 /api/sentences/toggle
 *   乐观翻转（原迁移注记②就此闭合）；本地 mock 仍走 wx storage。
 * 播放内核：utils/clip-player（暂停=记位重建 / 倍速保位重放 / 循环=重放，
 *   循环重播闪烁 120ms 去抖）。
 *
 * ── 沙箱注记（迁 yuanlu-weapp 时）──────────────────────────
 * ① 文案过 compliance 红线门禁（敏感字样改「透视/分析」口径）；
 * ② 假跟读评测换 components/voice/eval-card 真评测（原迁移注记④）。
 */
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const { get, post } = require('../../utils/request');
const { createClipPlayer } = require('../../utils/clip-player');
const { sentenceWindow } = require('../../utils/clip-window');
const reelsApi = require('./reels-api');
const reelsSession = require('./reels-session');

const RATES = [0.75, 1, 1.25];
const SAVED_KEY = 'reels_saved_sentences'; // 本地 mock 句子本（真实切片走服务端）
const EVAL_FEEDBACK = '流利度 94%！特别注意连读处的舌尖轻触，整体语感极佳。';
const EVAL_DURATION_MS = 2200; // B 原型假评测时长
const PAGE_SIZE_CAP = 48; // swiper 渲染上限（翻页追加封顶）
const PULL_THRESHOLD = 80; // DIY 下拉刷新阈值（px）
const PRELOAD_MARGIN = 3; // 距底多少条预取下一页

/** 后端不可达时的本地兜底（B server 无 key 降级文案，一字不差） */
const DEEP_FALLBACK = {
  connectedSpeech: '辅音结尾与元音开头发生顺滑连读，介词与弱读代词轻读降调。',
  toneAndMood: '自信、从容且具有说服力的交际语调，常见于访谈节目与商务交流。',
  paraphrase: '可替换为更加通俗的日常口语表述，或更加严谨的书面用词。',
  speakingTip: '注意喉头放松，腹式呼吸送气，重点实词重读，虚词快速带过。',
};

Page({
  data: {
    themeClass: '',
    dark: false,

    feedLoading: true, // 首刷 feed 装载态
    sourceLocal: false, // true = 后端不可达，回落本地 mock 语料
    reels: [], // swiper 渲染列表（统一视图模型）
    clip: null, // 当前切片镜像（顶栏/操作栏/弹窗取字段）
    index: 0,
    canPrev: false,
    canNext: true,

    // DIY 下拉刷新（竖滑 swiper 拦截手势，原生 onPullDownRefresh 不可用）
    pullShift: 0, // 下拉位移（px，含阻尼）
    pullHintY: -60, // 提示条 translateY（px，负值藏于顶上）
    refreshReady: false, // 拉足阈值，释放即刷新
    refreshing: false,

    playing: false,
    audioLoading: false, // 切片直链懒取中（播放键转 spinner）
    isLooping: true,
    rateLabel: '1x',
    activeWordIndex: -1,
    pastWordIndex: -1,
    coverOk: true,

    isSaved: false,

    isEvaluating: false,
    evalScore: 0,
    evalFeedback: EVAL_FEEDBACK,

    deepOpen: false,
    deepLoading: false,
    deepAnalysis: null,
    deepSentence: '',
    deepSource: '', // 'llm' | 'fallback'（badge 文案）

    wordModal: {
      visible: false,
      word: '',
      dictData: null,
      loading: false,
      saving: false,
      isSaved: false,
    },

    showPremiumModal: false,
    premiumSource: 'dictionary_quota',
  },

  /* ---------------- 生命周期 ---------------- */

  onLoad() {
    this._reels = [];
    this._page = 1;
    this._hasMore = false;
    this._fetchingFeed = false;
    this._owner = reelsSession.subject();
    this._sessionState = reelsSession.loadSession(this._owner);
    this._nextCursor = this._sessionState.cursor;
    this._furthestIdx = -1;
    this._seenBuffer = [];
    this._rate = 1;
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastPastIdx = -99;
    this._evalTimer = null;
    this._evalToken = 0;
    this._deepToken = 0;
    this._deepCache = {};
    this._vocabSet = {};
    this._saved = this._loadSaved(); // 本地 mock 句子本
    this._savedSub = {}; // 真实句子书签：'episodeid:subtitleId' → true
    this._savedKeysByEp = {}; // episodeid → subtitleIds 集合缓存
    this._savingBusy = false;
    this._prepToken = 0; // 音频懒取令牌（快速轻划丢弃过期结果）
    this._audioMeta = null; // {url, offset, winStart, winEnd} 当前切片播放窗口

    this._player = createClipPlayer({
      // 循环重放路径 = stop→playUrl 重建，playing 瞬时 false→true 闪烁，
      // 120ms 去抖吞掉（真实暂停/播完的置 false 仅延迟 120ms，无感）
      onPlaying: (k) => {
        if (this._playingFalseTimer) {
          clearTimeout(this._playingFalseTimer);
          this._playingFalseTimer = null;
        }
        if (k !== null) {
          this.setData({ playing: true });
        } else {
          this._playingFalseTimer = setTimeout(() => {
            this._playingFalseTimer = null;
            this.setData({ playing: false });
          }, 120);
        }
      },
      onTick: (pos) => this._onTick(pos),
      onEnded: () => this._onClipEnd(),
    });

    this._syncTheme();
    this._bootstrap();
    this._fetchVocabSet();
  },

  onShow() {
    this._syncTheme();
    const currentOwner = reelsSession.subject();
    if (currentOwner !== 'pending' && currentOwner !== this._owner) {
      this._flushSession();
      this._owner = currentOwner;
      this._sessionState = reelsSession.loadSession(this._owner);
      this._nextCursor = this._sessionState.cursor;
    }
  },

  onHide() {
    // 切 tab 礼让音频互斥总线：停窗口播放（回 tab 不自动续播，重按播放键续）
    this._pausePlayback();
    this._evalToken += 1;
    if (this._evalTimer) {
      clearTimeout(this._evalTimer);
      this._evalTimer = null;
    }
    if (this.data.isEvaluating) {
      this.setData({ isEvaluating: false });
    }
    this._flushSession();
  },

  onUnload() {
    this._flushSession();
    this._player.stop();
    if (this._evalTimer) clearTimeout(this._evalTimer);
    if (this._playingFalseTimer) clearTimeout(this._playingFalseTimer);
  },

  _flushSession() {
    if (!this._sessionState) return;
    if (this._seenBuffer && this._seenBuffer.length) {
      reelsSession.recordSeen(this._sessionState, this._seenBuffer);
      this._seenBuffer = [];
    }
    reelsSession.saveSession(this._owner, this._sessionState);
  },

  async _fetchRingPageWithSeenFilter(cursor) {
    let cur = cursor || this._sessionState.cursor;
    const rawPool = [];
    let hasMore = false;
    let wrapped = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await reelsApi.fetchFeed({ page: this._page, cursor: cur });
      if (!r || !r.items.length) break;
      rawPool.push(...r.items);
      hasMore = r.hasMore;
      if (r.wrapped) wrapped = true;
      cur = r.nextCursor || cur;
      const filtered = reelsSession.filterAndFallback(
        this._sessionState,
        rawPool,
        12
      );
      if (!filtered.softFallbackUsed && filtered.items.length >= 6) {
        return {
          items: filtered.items,
          hasMore,
          nextCursor: cur,
          wrapped,
        };
      }
      if (!r.hasMore || !r.nextCursor || r.nextCursor === cur) break;
    }
    if (!rawPool.length) return null;
    const finalPick = reelsSession.filterAndFallback(
      this._sessionState,
      rawPool,
      12
    );
    return {
      items: finalPick.items,
      hasMore,
      nextCursor: cur,
      wrapped,
    };
  },

  _syncTheme() {
    this.setData({
      themeClass: theme.rootClass(),
      dark: theme.getEffective() === 'dark',
    });
    theme.applyChrome();
  },

  /* ---------------- feed 装载（真实语料 + 本地回落） ---------------- */

  /* ── DIY 下拉刷新：首条(index=0)向下拖拽 → 阈值内跟手提示 → 释放刷新 ── */

  onPullTouchStart(e) {
    const t = e.touches && e.touches[0];
    this._pullY0 = t ? t.clientY : null;
    this._pullActive = t != null && this.data.index === 0 && !this.data.refreshing;
  },

  onPullTouchMove(e) {
    if (!this._pullActive || this._pullY0 == null || this.data.refreshing) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dy = t.clientY - this._pullY0;
    if (dy <= 0) {
      if (this.data.pullShift) this.setData({ pullShift: 0, pullHintY: -60, refreshReady: false });
      return;
    }
    // 超阈值后半阻尼，封顶 1.6×阈值
    const shift = dy <= PULL_THRESHOLD ? dy : PULL_THRESHOLD + (dy - PULL_THRESHOLD) / 2;
    const clamped = Math.min(Math.round(shift), Math.round(PULL_THRESHOLD * 1.6));
    this.setData({
      pullShift: clamped,
      pullHintY: Math.min(clamped - 56, 72),
      refreshReady: clamped >= PULL_THRESHOLD,
    });
  },

  onPullTouchEnd() {
    this._pullActive = false;
    this._pullY0 = null;
    if (this.data.refreshing) return;
    if (this.data.refreshReady) return this._refreshFeed();
    if (this.data.pullShift) this.setData({ pullShift: 0, pullHintY: -60, refreshReady: false });
  },

  onPullTouchCancel() {
    this._pullActive = false;
    this._pullY0 = null;
    if (!this.data.refreshing && this.data.pullShift) {
      this.setData({ pullShift: 0, pullHintY: -60, refreshReady: false });
    }
  },

  /** 释放刷新：从最远已看游标续取新一批 → 回到首条自动起播 */
  async _refreshFeed() {
    this.setData({ refreshReady: false, refreshing: true, pullShift: PULL_THRESHOLD, pullHintY: 24 });
    this._pausePlayback();
    this._flushSession();
    this._page = 1;
    this._furthestIdx = -1;
    this._hasMore = false;
    let ok = false;
    try {
      const startCursor = this._sessionState.cursor || this._nextCursor;
      const r = await this._fetchRingPageWithSeenFilter(startCursor);
      if (r && r.items.length) {
        this._reels = r.items;
        this._hasMore = r.hasMore;
        this._nextCursor = r.nextCursor || startCursor;
        if (r.wrapped) this._sessionState.lap = (this._sessionState.lap || 0) + 1;
        this.setData({ reels: this._reels, sourceLocal: false, index: 0 });
      } else {
        this._useLocalFallback();
        this.setData({ index: 0 });
      }
      ok = true;
    } catch (e) {
      ok = false;
    }
    this.setData({ refreshing: false, pullShift: 0, pullHintY: -60 });
    if (ok) this._applyClip(0, { autoplay: true });
    wx.showToast({ title: ok ? '已刷新' : '刷新失败，稍后再试', icon: 'none' });
  },

  async _bootstrap() {
    try {
      const r = await this._fetchRingPageWithSeenFilter(this._sessionState.cursor);
      if (r && r.items.length) {
        this._reels = r.items;
        this._hasMore = r.hasMore;
        this._nextCursor = r.nextCursor || this._sessionState.cursor;
        if (r.wrapped) this._sessionState.lap = (this._sessionState.lap || 0) + 1;
        this.setData({ reels: this._reels, sourceLocal: false, feedLoading: false });
      } else {
        this._useLocalFallback();
      }
    } catch (e) {
      this._useLocalFallback();
    }
    this._applyClip(0, { autoplay: true });
  },

  _useLocalFallback() {
    const allLocal = reelsApi.localReels();
    const filtered = reelsSession.filterAndFallback(
      this._sessionState,
      allLocal,
      allLocal.length
    );
    this._reels = filtered.items.length ? filtered.items : allLocal;
    this._hasMore = false;
    this.setData({ reels: this._reels, sourceLocal: true, feedLoading: false });
  },

  /** 翻页追加（滑至倒数 PRELOAD_MARGIN 条触发；swiper 渲染封顶） */
  _loadMore() {
    if (this._fetchingFeed || !this._hasMore || this.data.sourceLocal) return;
    if (this._reels.length >= PAGE_SIZE_CAP) return;
    this._fetchingFeed = true;
    this._page += 1;
    this._fetchRingPageWithSeenFilter(this._nextCursor)
      .then((r) => {
        this._fetchingFeed = false;
        if (r && r.items.length) {
          const existingKeys = new Set(this._reels.map(reelsSession.clipSeenKey));
          const deduped = r.items.filter(
            (it) => !existingKeys.has(reelsSession.clipSeenKey(it))
          );
          this._reels = this._reels.concat(deduped).slice(0, PAGE_SIZE_CAP);
          this._hasMore = r.hasMore;
          this._nextCursor = r.nextCursor || this._nextCursor;
          if (r.wrapped) this._sessionState.lap = (this._sessionState.lap || 0) + 1;
          this.setData({ reels: this._reels });
        } else {
          this._hasMore = false;
        }
      })
      .catch(() => {
        this._fetchingFeed = false;
        this._hasMore = false;
      });
  },

  /* ---------------- 切片切换（轻划 swiper / 按钮） ---------------- */

  /** swiper 纵向轻划（e.detail.current 为目标下标） */
  onSwiperChange(e) {
    const idx = e.detail.current;
    if (idx === this.data.index) return;
    this._applyClip(idx, { autoplay: true });
  },

  _applyClip(idx, opts) {
    const clip = this._reels[idx];
    if (!clip) return;
    const autoplay = !opts || opts.autoplay !== false;
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastPastIdx = -99;
    this._prepToken += 1; // 作废在途懒取
    this._evalToken += 1; // 作废在途跟读评测
    if (this._evalTimer) {
      clearTimeout(this._evalTimer);
      this._evalTimer = null;
    }
    this._audioMeta = null;

    // 游标只随最远到达下标前进（回划不倒退游标；预取未看条下次启动仍可出现）
    if (this._sessionState) {
      this._seenBuffer.push(clip);
      if (idx > this._furthestIdx) {
        this._furthestIdx = idx;
        if (clip.real && clip.ringKey) {
          this._sessionState.cursor = clip.ringKey;
        }
      }
      if (this._seenBuffer.length >= 6) {
        this._flushSession();
      }
    }

    this.setData({
      clip,
      index: idx,
      canPrev: idx > 0,
      canNext: idx < this._reels.length - 1,
      activeWordIndex: -1,
      pastWordIndex: -1,
      coverOk: true,
      isSaved: this._isClipSaved(clip),
      isEvaluating: false,
      evalScore: 0,
      audioLoading: false,
    });

    if (autoplay) this._startPlayback(0);
    if (clip.real && clip.episodeid) this._fetchSavedKeys(clip.episodeid);
    if (idx >= this._reels.length - PRELOAD_MARGIN) this._loadMore();
  },

  onPrev() {
    if (this.data.index <= 0) return;
    this._applyClip(this.data.index - 1, { autoplay: true });
  },

  onNext() {
    if (this.data.index >= this._reels.length - 1) return;
    this._applyClip(this.data.index + 1, { autoplay: true });
  },

  /* ---------------- 播放控制 ---------------- */

  /** 解析当前切片的播放窗口；预签条直连，未签条懒取网关 */
  _prepareAudio(clip) {
    if (!clip.real) {
      // 本地 mock：整轨窗口 [start,end]，offset=0（词时间戳即轨内绝对值）
      return Promise.resolve({
        url: clip.clipAudioUrl,
        offset: 0,
        winStart: clip.start,
        winEnd: clip.end,
      });
    }
    if (clip.clipAudioUrl) {
      // 预签与懒取使用同一句界，排除文件尾部 padding 中的下一句
      return Promise.resolve().then(() => Object.assign(
        { url: clip.clipAudioUrl }, sentenceWindow(clip, clip.audioOffset)
      ));
    }
    return reelsApi.fetchClipAudio(clip.id).then((r) => {
      if (r && r.exclusive) {
        const err = new Error('PREMIUM_REQUIRED');
        err.exclusive = true;
        throw err;
      }
      if (!r || !r.url) throw new Error('audio unavailable');
      // 回填视图模型：二次滑过免再取
      const reel = this._reels.find((x) => x.id === clip.id);
      if (reel) {
        reel.clipAudioUrl = r.url;
        reel.audioOffset = r.clipOffset;
      }
      return Object.assign({ url: r.url }, sentenceWindow(clip, r.clipOffset));
    });
  },

  /** 窗口起播：fromRel 为切片内相对位置（暂停续播/换速保位复用） */
  _startPlayback(fromRel) {
    const clip = this.data.clip;
    if (!clip) return;
    this._atEnd = false;

    if (this._audioMeta) {
      this._playWindow(this._audioMeta, fromRel);
      return;
    }

    const token = this._prepToken;
    this.setData({ audioLoading: true });
    this._prepareAudio(clip)
      .then((meta) => {
        if (token !== this._prepToken) return; // 已轻划到别的切片
        this._audioMeta = meta;
        this.setData({ audioLoading: false });
        this._playWindow(meta, fromRel);
      })
      .catch((err) => {
        if (token !== this._prepToken) return;
        this.setData({ audioLoading: false });
        if (err && err.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        wx.showToast({ title: '切片加载失败，稍后再试', icon: 'none' });
      });
  },

  _playWindow(meta, fromRel) {
    const rel = Math.min(Math.max(fromRel || 0, 0), Math.max(0, meta.winEnd - meta.winStart - 0.05));
    this._player.playUrl(meta.url, 'reel', {
      startSec: meta.winStart + rel,
      endSec: meta.winEnd,
      rate: this._rate !== 1 ? this._rate : 0,
    });
  },

  /** 暂停：clip-player 无 pause 口，记相对位置后停实例 */
  _pausePlayback() {
    if (!this.data.playing) return;
    const meta = this._audioMeta;
    const clip = this.data.clip;
    const pos = this._player.estimatedPos();
    if (meta && clip && pos != null) {
      this._relPos = Math.min(Math.max(pos - meta.winStart, 0), meta.winEnd - meta.winStart);
    }
    this._player.stop(); // → onPlaying(null) → playing=false
  },

  onTogglePlay() {
    if (this.data.audioLoading) return;
    if (this.data.playing) {
      this._pausePlayback();
      return;
    }
    // 非循环播完后再按播放：回句首（B togglePlay 的越界回跳分支）
    this._startPlayback(this._atEnd ? 0 : this._relPos);
  },

  /** 到窗终：循环则重放；否则停驻 */
  _onClipEnd() {
    if (this.data.isLooping) {
      this._startPlayback(0);
      return;
    }
    this._atEnd = true;
    this._relPos = 0;
  },

  onToggleLoop() {
    this.setData({ isLooping: !this.data.isLooping });
  },

  /** 倍速 0.75/1/1.25 循环；播放中保位重放，暂停中仅记速 */
  onToggleRate() {
    const idx = RATES.indexOf(this._rate);
    const next = RATES[(idx + 1) % RATES.length];
    this._rate = next;
    this.setData({ rateLabel: String(next) + 'x' });
    if (this.data.playing) {
      const meta = this._audioMeta;
      const pos = this._player.estimatedPos();
      const rel = meta && pos != null ? pos - meta.winStart : 0;
      this._startPlayback(rel);
    }
  },

  /* ---------------- 词级扫光（毫秒时间戳 − clipOffset） ---------------- */

  /**
   * 词窗判定：pos∈[w.start,w.end) 为当前词 activeWordIndex；pos >= w.end 为已读词
   * pastWordIndex（词间间隙 activeWordIndex=-1，但 pastWordIndex 保持上一个已读词，
   * 避免已读绿词在词间间隙闪回原色）。50ms 一帧仅索引翻转才 setData。
   */
  _onTick(pos) {
    const clip = this.data.clip;
    const meta = this._audioMeta;
    if (!clip || !Array.isArray(clip.words) || !clip.words.length) return;
    const offset = meta ? meta.offset : 0;
    const winEnd = meta ? meta.winEnd : clip.end;
    let idx = -1;
    let pastIdx = -1;
    if (pos >= winEnd) {
      idx = clip.words.length;
      pastIdx = clip.words.length - 1;
    } else {
      for (let i = 0; i < clip.words.length; i++) {
        const w = clip.words[i];
        const s = w.start - offset;
        const e = w.end - offset;
        if (pos >= s && pos < e) {
          idx = i;
          pastIdx = i - 1;
          break;
        }
        if (pos >= e) {
          pastIdx = i;
        }
      }
    }
    if (idx !== this._lastWordIdx || pastIdx !== this._lastPastIdx) {
      this._lastWordIdx = idx;
      this._lastPastIdx = pastIdx;
      this.setData({ activeWordIndex: idx, pastWordIndex: pastIdx });
    }
  },

  onCoverError() {
    this.setData({ coverOk: false });
  },

  /* ---------------- 深浅切换 ---------------- */

  onToggleTheme() {
    const next = theme.getEffective() === 'dark' ? 'light' : 'dark';
    theme.setMode(next);
    this._syncTheme();
  },

  /* ---------------- 点词查词（/api/dict + vocabulary-modal） ---------------- */

  onWordTap(e) {
    const clip = this.data.clip;
    if (!clip) return;
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    let raw = ds.word;
    if (!raw && ds.wi !== undefined) {
      const wi = Number(ds.wi);
      raw =
        (Array.isArray(clip.words) && clip.words[wi] && clip.words[wi].word) ||
        (Array.isArray(clip.tokens) && clip.tokens[wi]) ||
        '';
    }
    if (!raw) raw = (Array.isArray(clip.tokens) && clip.tokens[0]) || clip.textEn;
    const clean = String(raw).replace(/^[^\w]+|[^\w]+$/g, ''); // B 的首尾标点清洗
    if (!clean) return;

    const lower = clean.toLowerCase();
    this.setData({
      wordModal: {
        visible: true,
        word: clean,
        dictData: null,
        loading: true,
        saving: false,
        isSaved: !!this._vocabSet[lower],
      },
    });

    get('/api/dict/' + encodeURIComponent(lower), null, { showError: false })
      .then((body) => {
        const m = this.data.wordModal;
        if (!m.visible || m.word !== clean) return; // 期间已换词/关闭则丢弃
        if (body && body.success && body.data) {
          this.setData({ 'wordModal.dictData': body.data, 'wordModal.loading': false });
        } else {
          this.setData({ 'wordModal.loading': false });
        }
      })
      .catch((err) => {
        const m = this.data.wordModal;
        if (!m.visible || m.word !== clean) return;
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

  /** 保存生词（登录门控 + 配额墙；真实切片带真实 episodeid） */
  onVocabSave() {
    const m = this.data.wordModal;
    const word = m.word;
    if (!word || m.saving) return;
    if (!authStore.getState().isLoggedIn) {
      this._promptLogin('请先登录后再保存生词');
      return;
    }
    this.setData({ 'wordModal.saving': true });
    const d = m.dictData || {};
    const definition = (d.definitions || [])
      .map((x) => '[' + x.pos + '] ' + x.meaning_cn)
      .join('; ');
    const clip = this.data.clip || {};

    post(
      '/api/vocabulary/add',
      {
        word,
        definition,
        contextSentence: clip.textEn || '',
        translation: clip.textCn || '',
        episodeid: clip.episodeid || clip.id || '',
        timestamp: clip.start || 0,
        speakUrl: (d.audio_urls && d.audio_urls.us) || '',
        dictUrl: '',
        webUrl: '',
        mobileUrl: '',
      },
      { showError: false }
    )
      .then(() => {
        this._vocabSet[word.toLowerCase()] = true;
        this.setData({
          'wordModal.saving': false,
          'wordModal.isSaved': true,
          'wordModal.visible': false,
        });
        wx.showToast({ title: '已加入生词本', icon: 'none' });
      })
      .catch((err) => {
        this.setData({ 'wordModal.saving': false });
        if (err && err.statusCode === 400) {
          this._vocabSet[word.toLowerCase()] = true;
          this.setData({ 'wordModal.isSaved': true });
          return;
        }
        if (err && err.code === 'VOCABULARY_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'vocabulary_total' });
          return;
        }
        if (err && err.code === 'VOCABULARY_DAILY_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'vocabulary_daily' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  _fetchVocabSet() {
    if (!authStore.getState().isLoggedIn) return;
    get('/api/vocabulary/words', null, { showError: false })
      .then((body) => {
        const arr = body && body.success && Array.isArray(body.data) ? body.data : [];
        const set = {};
        arr.forEach((w) => {
          set[String(w).toLowerCase()] = true;
        });
        this._vocabSet = set;
      })
      .catch(() => {});
  },

  _promptLogin(content) {
    wx.showModal({
      title: '请先登录',
      content,
      confirmText: '去登录',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/auth/index' });
      },
    });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
  },

  /* ---------------- 深度透视（POST /api/clips/deep-dive） ---------------- */

  onDeepDive() {
    const clip = this.data.clip;
    if (!clip) return;
    const sentence = clip.textEn || '';
    const token = (this._deepToken = (this._deepToken || 0) + 1);
    const cached = this._deepCache && this._deepCache[sentence];
    if (cached) {
      this.setData({
        deepOpen: true,
        deepLoading: false,
        deepAnalysis: cached,
        deepSentence: sentence,
        deepSource: cached.source || 'llm',
      });
      return;
    }
    this.setData({
      deepOpen: true,
      deepLoading: true,
      deepAnalysis: null,
      deepSentence: sentence,
      deepSource: '',
    });
    reelsApi
      .fetchDeepDive(sentence)
      .then((a) => {
        if (token !== this._deepToken || !this.data.deepOpen || this.data.deepSentence !== sentence) {
          return;
        }
        if (a && this._deepCache) {
          this._deepCache[sentence] = a;
        }
        this.setData({
          deepLoading: false,
          deepAnalysis: a || DEEP_FALLBACK,
          deepSource: a ? a.source : 'fallback',
        });
      })
      .catch(() => {
        if (token !== this._deepToken || !this.data.deepOpen || this.data.deepSentence !== sentence) {
          return;
        }
        this.setData({ deepLoading: false, deepAnalysis: DEEP_FALLBACK, deepSource: 'fallback' });
      });
  },

  onDeepClose() {
    this._deepToken = (this._deepToken || 0) + 1;
    this.setData({ deepOpen: false, deepLoading: false });
  },

  noop() {},

  /* ---------------- 跟读测评（B 原型假评测；迁移换 eval-card） ---------------- */

  onShadowing() {
    if (this.data.isEvaluating) return;
    const evalToken = (this._evalToken = (this._evalToken || 0) + 1);
    const targetClipId = this.data.clip && this.data.clip.id;
    this.setData({ isEvaluating: true, evalScore: 0 });
    if (this._evalTimer) clearTimeout(this._evalTimer);
    this._evalTimer = setTimeout(() => {
      this._evalTimer = null;
      if (evalToken !== this._evalToken) return;
      if (!this.data.clip || this.data.clip.id !== targetClipId) return;
      this.setData({
        isEvaluating: false,
        evalScore: Math.floor(88 + Math.random() * 10),
      });
    }, EVAL_DURATION_MS);
  },

  /* ---------------- 句子收藏（真实切片走服务端 toggle） ---------------- */

  onToggleBookmark() {
    const clip = this.data.clip;
    if (!clip) return;
    if (clip.real && clip.episodeid && clip.subtitleId != null) {
      this._toggleRealSentence(clip);
      return;
    }
    // 本地 mock：wx storage 句子本（B 的收藏记录字段原样）
    if (this._isSavedText(clip.textEn)) {
      this._saved = this._saved.filter((s) => s.textEn !== clip.textEn);
      this._persistSaved();
      this.setData({ isSaved: false });
      wx.showToast({ title: '已移出句子本', icon: 'none' });
      return;
    }
    const record = {
      id: 'sent-' + Date.now(),
      episodeid: clip.episodeid || clip.id,
      episodeTitle: clip.showTitle,
      start: clip.start,
      textEn: clip.textEn,
      textCn: clip.textCn,
      tags: ['原声微流', clip.topic || '精听'],
      savedAt: new Date().toISOString().split('T')[0],
    };
    this._saved.unshift(record);
    this._persistSaved();
    this.setData({ isSaved: true });
    wx.showToast({ title: '已收藏到句子本', icon: 'none' });
  },

  /** 真实切片收藏：/api/sentences/toggle 乐观翻转（intensive 同款契约） */
  _toggleRealSentence(clip) {
    if (!authStore.getState().isLoggedIn) {
      this._promptLogin('登录后即可收藏句子到句子本');
      return;
    }
    if (this._savingBusy) return;
    const key = clip.episodeid + ':' + clip.subtitleId;
    const wasSaved = !!this._savedSub[key];
    this._savingBusy = true;
    this.setData({ isSaved: !wasSaved });

    post(
      '/api/sentences/toggle',
      {
        episodeid: clip.episodeid,
        subtitleId: clip.subtitleId,
        startTime: clip.start,
        endTime: clip.end,
        enText: clip.textEn,
        zhText: clip.textCn,
      },
      { showError: false }
    )
      .then((body) => {
        this._savingBusy = false;
        const isCurrentClip =
          this.data.clip &&
          this.data.clip.episodeid === clip.episodeid &&
          this.data.clip.subtitleId === clip.subtitleId;
        if (!body || !body.success || !body.data) {
          if (isCurrentClip) this.setData({ isSaved: wasSaved });
          wx.showToast({ title: (body && body.message) || '收藏失败，请重试', icon: 'none' });
          return;
        }
        if (body.data.saved) {
          this._savedSub[key] = true;
          if (!this._savedKeysByEp[clip.episodeid]) {
            this._savedKeysByEp[clip.episodeid] = {};
          }
          this._savedKeysByEp[clip.episodeid][key] = true;
          if (isCurrentClip) this.setData({ isSaved: true });
          wx.showToast({ title: '已收藏到句子本', icon: 'none' });
        } else {
          this._savedSub[key] = false;
          if (this._savedKeysByEp[clip.episodeid]) {
            delete this._savedKeysByEp[clip.episodeid][key];
          }
          if (isCurrentClip) this.setData({ isSaved: false });
          wx.showToast({ title: '已取消收藏', icon: 'none' });
        }
      })
      .catch((err) => {
        this._savingBusy = false;
        const isCurrentClip =
          this.data.clip &&
          this.data.clip.episodeid === clip.episodeid &&
          this.data.clip.subtitleId === clip.subtitleId;
        if (isCurrentClip) this.setData({ isSaved: wasSaved });
        if (err && err.code === 'SENTENCE_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '收藏失败，请重试', icon: 'none' });
      });
  },

  _isClipSaved(clip) {
    if (clip.real && clip.episodeid && clip.subtitleId != null) {
      return this._savedSub[clip.episodeid + ':' + clip.subtitleId] === true;
    }
    return this._isSavedText(clip.textEn);
  },

  /** 书签态回填：按集拉 /api/sentences/keys（缓存），仅刷新当前切片 */
  _fetchSavedKeys(episodeid) {
    if (!authStore.getState().isLoggedIn) return;
    if (this._savedKeysByEp[episodeid]) {
      this._applySavedKeys(episodeid, this._savedKeysByEp[episodeid]);
      return;
    }
    get('/api/sentences/keys?episodeid=' + encodeURIComponent(episodeid), null, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        const ids = this._savedKeysByEp[episodeid] || {};
        ((body.data.subtitleIds || []) || []).forEach((id) => {
          const k = episodeid + ':' + id;
          if (this._savedSub[k] === false) return; // 用户在请求期间已显式取消收藏
          ids[k] = true;
          this._savedSub[k] = true;
        });
        this._savedKeysByEp[episodeid] = ids;
        this._applySavedKeys(episodeid, ids);
      })
      .catch(() => {});
  },

  _applySavedKeys(episodeid, ids) {
    const clip = this.data.clip;
    if (!clip || clip.episodeid !== episodeid) return;
    const key = episodeid + ':' + clip.subtitleId;
    const hit = !!(ids && ids[key]);
    if (hit !== this.data.isSaved) this.setData({ isSaved: hit });
  },

  /* ---------------- 本地 mock 句子本 storage ---------------- */

  _isSavedText(textEn) {
    return this._saved.some((s) => s.textEn === textEn);
  },

  _loadSaved() {
    try {
      const v = wx.getStorageSync(SAVED_KEY);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  },

  _persistSaved() {
    try {
      wx.setStorageSync(SAVED_KEY, this._saved);
    } catch (e) {
      /* 存储异常不打断交互 */
    }
  },
});
