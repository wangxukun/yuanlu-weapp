/**
 * pages/intensive-listening/index — 独立精听工作流页
 *
 * 复刻 Web 端 components/episode/InteractiveTranscript.tsx 的移动端全屏精听体验
 * （对齐 Android IntensiveListeningScreen 的页面定位），承接全屏播放面板
 * 「精听模式」胶囊入口（player-panel.onOpenIntensive → 本页 ?id=）。
 *
 * 核心机制（对应 Web 源）：
 *   - 字幕流 + 词级扫光：playerStore 订阅 timeupdate → intensive-core.findActiveIndex
 *     增量定位当前句（useTranscriptScroll 去 rAF 化），activeWordIndex 最小差量
 *     setData，WXS 视图层求高亮 class（Web SubtitleItem + useWordHighlight）；
 *   - 单句循环：shouldLoopSeek 越过句尾回 seek 句首，500ms 保护窗
 *     （useTranscriptScroll 的 loopTarget 分支）；听写模式自动锁活动句；
 *   - 听写：整句全挖空 + 去空格按词长切块三态判定（DictationItem 全量移植），
 *     倍速 0.8，全对自动跳下一句，错 3 次出提示词；
 *   - 句子收藏：/api/sentences/toggle 乐观翻转 + keys 回填书签态，成功 toast 带
 *     「添加标签/笔记」action 打开完善抽屉（QuickTagDrawer 复刻）；
 *   - 生词收藏：点词 → /api/dict/[word]（LLM 词典）→ VocabularyModal 全屏弹窗
 *     → /api/vocabulary/add 落库；
 *   - 配额墙统一走 premium-modal（sentence_quota / vocabulary_total /
 *     vocabulary_daily / dictionary_quota 场景文案已在组件内置）。
 *
 * 性能口径：字幕渐进渲染（首屏 40 句，活动句逼近窗口底缘按 30 句扩窗，
 * setData 用 viewList[i] 路径补丁追加，不整表重发）。
 */

const { get, post } = require('../../utils/request');
const audioManager = require('../../utils/audioManager');
const audioBus = require('../../utils/audio-bus');
const playerStore = require('../../store/playerStore');
const authStore = require('../../store/authStore');
const core = require('../../utils/intensive-core');

const RENDER_CHUNK = 40;   // 首屏渲染句数
const RENDER_EXTEND = 30;  // 扩窗步长
const RENDER_AHEAD = 12;   // 活动句距窗口底缘的提前扩窗阈值
const TOAST_DURATION = 4000; // 收藏成功 toast 驻留（对齐 sonner 默认 4s）

Page({
  data: {
    episodeid: '',
    episode: null,
    isLoading: true,
    error: null,
    statusBarH: 20,

    mode: 'read', // 精读 | 听写（对齐 Web transcriptMode）
    viewList: [], // 渐进渲染的字幕视图模型
    activeIndex: -1,
    activeWordIndex: -1, // 扫光位置（见 _onTick；-1=句首前，len=整句读完）
    wordSweepOn: false,  // 当前词光斑是否点亮（间隙/读毕时 false → 全部回落已读色）
    isPlaying: false,
    isPlayingHere: false, // 全局播放器当前会话即本集（对齐 isPlayingThisEpisode）
    autoScroll: true,
    showTranslation: false,
    loopIndex: -1,
    scrollIntoView: '',

    isLoggedIn: false,
    savedMap: {}, // subtitleId -> SavedSentenceItem | true（书签态 + 最新收藏记录）

    // 收藏成功 toast：{ type:'saved'|'removed', quote, sentence }
    toast: null,
    // 句子完善抽屉（非 null 打开）
    drawerSentence: null,

    // 生词弹窗（对齐 Web VocabularyModal props）
    wordModal: {
      visible: false,
      word: '',
      dictData: null,
      loading: false,
      saving: false,
      isSaved: false,
      contextEn: '',
      contextZh: '',
      timestamp: 0,
    },

    // 会员转化弹窗（配额墙）
    showPremiumModal: false,
    premiumSource: 'sentence_quota',

    // 听写状态（仅活动句渲染输入框，页面级单份即可）
    dictInput: '',
    dictSlots: [],
    dictHint: false,
  },

  onLoad(query) {
    this.setData({
      episodeid: query.id || '',
      statusBarH: this._statusBarHeight(),
    });

    this._sentences = []; // 原始字幕
    this._views = [];     // 预处理视图模型（全量）
    this._renderEnd = 0;  // 渐进渲染窗口右缘（下标，不含）
    this._lastActive = -1;
    this._lastSeekAt = 0;
    this._dictErrors = 0;
    this._dictDone = false;
    this._savingBusy = false;
    this._toastTimer = null;
    this._exiting = false; // 关闭音频联动退栈的一次性门闩
    this._vocabSet = {}; // 已收藏生词小写表（/api/vocabulary/words）

    this._unsubAuth = authStore.subscribe(() => this._syncAuth());
    this._syncAuth();

    // 全局播放器镜像：timeupdate 驱动扫光 / 跟随 / 单句循环
    this._unsubPlayer = playerStore.subscribe((s) => this._onPlayerState(s));
    this._onPlayerState(playerStore.getState());

    this._bootstrap();
  },

  onUnload() {
    if (this._unsubAuth) this._unsubAuth();
    if (this._unsubPlayer) this._unsubPlayer();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    // 播放会话保留：返回后由迷你条 / 全屏面板继续控制（对齐 Web 精听页返回行为）
  },

  noop() {},

  // ==================== 初始化 ====================

  _statusBarHeight() {
    try {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync();
      return info.statusBarHeight || 20;
    } catch (e) {
      return 20;
    }
  },

  async _bootstrap() {
    const { episodeid } = this.data;
    if (!episodeid) {
      this.setData({ error: '缺少剧集参数', isLoading: false });
      return;
    }
    this.setData({ isLoading: true, error: null });
    try {
      const [episode, subBody] = await Promise.all([
        get(`/api/episode/detail?id=${episodeid}`),
        get(`/api/episode/subtitles?id=${episodeid}`),
      ]);
      const subtitles = (subBody && subBody.data) || [];
      if (!Array.isArray(subtitles) || subtitles.length === 0) {
        throw new Error('暂无字幕数据');
      }

      // 字幕接口带回的 OSS 签名直链回填剧集对象，audioManager 起播免二次拉取
      if (subBody.audioUrl) episode.audioUrl = subBody.audioUrl;

      this._sentences = subtitles;
      this._views = subtitles.map((s, i) => ({
        index: i,
        id: s.id,
        start: s.start,
        end: s.end != null ? s.end : s.start + 3,
        textEn: s.textEn || '',
        zhClean: core.stripSpeaker(s.textCn),
        words: Array.isArray(s.words) ? s.words : [],
        tsLabel: core.formatStartTime(s.start),
      }));
      this._renderEnd = Math.min(this._views.length, RENDER_CHUNK);
      this.setData({
        episode,
        isLoading: false,
        viewList: this._views.slice(0, this._renderEnd),
      });

      // 带着既有播放会话进页时，按当前进度初始化活动句
      const st = playerStore.getState();
      if (
        st.hasEpisode &&
        st.currentEpisode &&
        String(st.currentEpisode.episodeid) === String(episodeid)
      ) {
        const initIdx = core.findActiveIndex(this._views, st.currentTime || 0, -1);
        if (initIdx >= 0) this._setActive(initIdx, st.currentTime || 0);
      }

      this._ensurePlaying(episode);
      this._fetchSaveState();
    } catch (err) {
      this.setData({ error: (err && err.message) || '加载失败', isLoading: false });
    }
  },

  onRetry() {
    this._bootstrap();
  },

  /**
   * 起播保障：本集未在播 → 互停其他音源后精听起播；已在播 → 补精听标记，
   * 暂停则续播（对齐 episode 页 onStartListening / 面板 onOpenIntensive 链路）
   */
  _ensurePlaying(episode) {
    const st = playerStore.getState();
    const same =
      st.hasEpisode &&
      st.currentEpisode &&
      String(st.currentEpisode.episodeid) === String(this.data.episodeid);
    if (!same) {
      audioBus.stopAll();
      audioManager.playEpisode(episode, { intensive: true });
    } else {
      audioManager.setIntensiveMode(true);
      if (!st.isPlaying) audioManager.play();
    }
  },

  _syncAuth() {
    const s = authStore.getState();
    const changed = s.isLoggedIn !== this.data.isLoggedIn;
    this.setData({ isLoggedIn: s.isLoggedIn });
    if (!changed) return; // profile 刷新等非登录态翻转不重复拉书签/生词表
    if (s.isLoggedIn) {
      this._fetchSaveState();
    } else {
      this.setData({ savedMap: {} });
    }
  },

  /** 书签态 + 已收藏生词表回填（对齐 InteractiveTranscript 两个 useEffect） */
  _fetchSaveState() {
    const { episodeid, isLoggedIn } = this.data;
    if (!isLoggedIn || !episodeid) return;
    get(`/api/sentences/keys?episodeid=${episodeid}`, null, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        const map = {};
        (body.data.subtitleIds || []).forEach((id) => {
          map[id] = true;
        });
        this.setData({ savedMap: map });
      })
      .catch(() => {});
    get('/api/vocabulary/words', null, { showError: false })
      .then((body) => {
        const arr =
          body && body.success && Array.isArray(body.data) ? body.data : [];
        const set = {};
        arr.forEach((w) => {
          set[String(w).toLowerCase()] = true;
        });
        this._vocabSet = set;
      })
      .catch(() => {});
  },

  // ==================== 播放联动（playerStore 镜像驱动） ====================

  _onPlayerState(s) {
    const wasHere = this.data.isPlayingHere;
    const here = !!(
      s.hasEpisode &&
      s.currentEpisode &&
      String(s.currentEpisode.episodeid) === String(this.data.episodeid)
    );
    const playing = !!(here && s.isPlaying);
    const patch = {};
    if (playing !== this.data.isPlaying) patch.isPlaying = playing;
    if (here !== this.data.isPlayingHere) patch.isPlayingHere = here;

    if (!here) {
      this._lastActive = -1;
      if (this.data.activeIndex !== -1) patch.activeIndex = -1;
      if (this.data.activeWordIndex !== -1) patch.activeWordIndex = -1;
      if (Object.keys(patch).length) this.setData(patch);
      // 关闭联动（Bug 1）：本集会话被全局关闭（底部迷你条/全屏面板的 × →
      // audioManager.close 清空会话）时，精听页失去存在意义，随音频停止一并返回
      if (wasHere && !s.hasEpisode) this._exitPage();
      return;
    }
    if (Object.keys(patch).length) this.setData(patch);
    this._onTick(s.currentTime || 0, playing);
  },

  /** 关闭音频联动退出：navigateBack，无上一页（分享直入等）时回首页 */
  _exitPage() {
    if (this._exiting) return; // close 会连发 episodeChange + stop，防重复退栈
    this._exiting = true;
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' }),
    });
  },

  /**
   * 每次 timeupdate/seek 的推进处理：循环回跳 → 句定位 → 词扫光。
   * BGM timeupdate 约 250-500ms 一帧，词级高亮粒度与之对齐。
   */
  _onTick(t, playing) {
    const views = this._views;
    if (!views.length) return;

    // 单句循环：听写模式锁活动句，精读模式锁 loopIndex（useTranscriptScroll loopTarget）
    const loopIdx =
      this.data.mode === 'dictate' ? this.data.activeIndex : this.data.loopIndex;
    if (playing && loopIdx >= 0 && loopIdx < views.length) {
      const sub = views[loopIdx];
      if (core.shouldLoopSeek(t, sub, this._lastSeekAt, Date.now())) {
        this._lastSeekAt = Date.now();
        audioManager.seek(sub.start);
        return; // seek 后由新 timeupdate 接管
      }
    }

    const idx = core.findActiveIndex(views, t, this._lastActive);
    if (idx !== this.data.activeIndex) {
      this._lastActive = idx;
      this._setActive(idx, t);
      return;
    }
    if (idx >= 0 && playing && this.data.mode === 'read') {
      // 词级扫光三态（computeWordSweep）：两个标量最小差量下发
      const v = views[idx];
      const sw = core.computeWordSweep(v.words, t, v.start, v.end);
      if (
        sw.idx !== this.data.activeWordIndex ||
        sw.on !== this.data.wordSweepOn
      ) {
        this.setData({ activeWordIndex: sw.idx, wordSweepOn: sw.on });
      }
    }
  },

  _setActive(idx, t) {
    const patch = { activeIndex: idx };
    if (idx >= 0) {
      const v = this._views[idx];
      const sw =
        this.data.mode === 'read' && this.data.isPlaying && v.words.length
          ? core.computeWordSweep(v.words, t, v.start, v.end)
          : { idx: -1, on: false };
      patch.activeWordIndex = sw.idx;
      patch.wordSweepOn = sw.on;

      this._maybeExtend(idx);
      if (this.data.autoScroll) {
        const anchor = 'sub-' + v.id;
        if (anchor !== this.data.scrollIntoView) patch.scrollIntoView = anchor;
      }
      if (this.data.mode === 'dictate') this._resetDictation(v);
    } else {
      patch.activeWordIndex = -1;
    }
    this.setData(patch);
  },

  /** 活动句逼近渲染窗底缘时扩窗（路径补丁追加，不整表重发） */
  _maybeExtend(activeIdx) {
    const total = this._views.length;
    if (activeIdx < 0 || this._renderEnd >= total) return;
    if (activeIdx <= this._renderEnd - RENDER_AHEAD) return;
    let newEnd = this._renderEnd;
    while (newEnd < total && newEnd < activeIdx + RENDER_AHEAD) {
      newEnd += RENDER_EXTEND;
    }
    this._appendRender(newEnd);
  },

  /** 手动滚动到底时再补一窗 */
  onScrollLower() {
    if (this._renderEnd >= this._views.length) return;
    this._appendRender(Math.min(this._views.length, this._renderEnd + RENDER_EXTEND));
  },

  _appendRender(newEnd) {
    if (newEnd <= this._renderEnd) return;
    const patch = {};
    for (let i = this._renderEnd; i < newEnd; i++) {
      patch['viewList[' + i + ']'] = this._views[i];
    }
    this._renderEnd = newEnd;
    this.setData(patch);
  },

  // ==================== 顶部工具区 ====================

  onBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' }),
    });
  },

  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setData({ mode });
    // 听写降速 0.8 / 精读恢复 1.0（InteractiveTranscript 的 dictate 倍速效应）
    audioManager.setPlaybackRate(mode === 'dictate' ? 0.8 : 1.0);
    if (mode === 'dictate' && this.data.activeIndex >= 0) {
      this._resetDictation(this._views[this.data.activeIndex]);
    }
  },

  onToggleAutoScroll() {
    this.setData({ autoScroll: !this.data.autoScroll });
  },

  onToggleTranslation() {
    this.setData({ showTranslation: !this.data.showTranslation });
  },

  // ==================== 字幕卡交互 ====================

  /** 点卡片任意处跳播该句（Web handleCardJump：无选区即跳） */
  onCardTap(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const v = this._views[idx];
    if (!v) return;
    this._jumpTo(v);
  },

  _jumpTo(v) {
    this._lastSeekAt = Date.now();
    audioManager.seek(v.start);
    audioManager.play();
  },

  /** 单句循环开关（SubtitleItem.onToggleLoop + useTranscriptScroll 回跳） */
  onToggleLoop(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const v = this._views[idx];
    if (!v) return;
    if (this.data.loopIndex === idx) {
      this.setData({ loopIndex: -1 });
    } else {
      this.setData({ loopIndex: idx });
      this._jumpTo(v);
    }
  },

  // ==================== 生词收藏（点词 → 词典 → 落库） ====================

  /** 点词查词典（Web handleWordClick：清洗标点 → 暂停 → 拉取 /api/dict/[word]） */
  onWordTap(e) {
    const ds = e.currentTarget.dataset;
    const v = this._views[Number(ds.index)];
    if (!v) return;
    const w = v.words[Number(ds.wi)];
    if (!w) return;
    const cleanWord = String(w.word || '')
      .replace(/[.,!?;:"()]/g, '')
      .trim();
    if (!cleanWord) return;

    if (this.data.isPlaying) audioManager.pause();

    const lower = cleanWord.toLowerCase();
    this.setData({
      wordModal: {
        visible: true,
        word: cleanWord,
        dictData: null,
        loading: true,
        saving: false,
        isSaved: !!this._vocabSet[lower],
        contextEn: v.textEn,
        contextZh: v.zhClean,
        timestamp: w.start,
      },
    });

    get('/api/dict/' + encodeURIComponent(lower), null, { showError: false })
      .then((body) => {
        // 期间已换词 / 已关闭则丢弃
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

  /** 保存生词（Web handleSaveVocabulary 同款请求体） */
  onVocabSave() {
    const m = this.data.wordModal;
    const word = m.word;
    if (!word || this.data.wordModal.saving) return;
    if (!this.data.isLoggedIn) {
      this._promptLogin('请先登录后再保存生词');
      return;
    }
    this.setData({ 'wordModal.saving': true });
    const d = m.dictData || {};
    const definition = (d.definitions || [])
      .map((x) => '[' + x.pos + '] ' + x.meaning_cn)
      .join('; ');

    post(
      '/api/vocabulary/add',
      {
        word,
        definition,
        contextSentence: m.contextEn,
        translation: m.contextZh,
        episodeid: this.data.episodeid,
        timestamp: m.timestamp,
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
        // 同词已收藏（后端 400）→ 覆盖为已收藏态
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

  // ==================== 句子收藏（书签态 + toast + 完善抽屉） ====================

  /** 收藏 / 取消收藏（乐观翻转，对齐 Web useOptimistic + toggleSentenceSave） */
  onToggleSave(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const v = this._views[idx];
    if (!v) return;
    if (!this.data.isLoggedIn) {
      this._promptLogin('登录后即可收藏句子到句子本');
      return;
    }
    if (this._savingBusy) return;
    this._savingBusy = true;

    const original = this.data.savedMap;
    const wasSaved = !!original[v.id];
    const optimistic = {};
    Object.keys(original).forEach((k) => {
      optimistic[k] = original[k];
    });
    if (wasSaved) delete optimistic[v.id];
    else optimistic[v.id] = true;
    this.setData({ savedMap: optimistic });

    post(
      '/api/sentences/toggle',
      {
        episodeid: this.data.episodeid,
        subtitleId: v.id,
        startTime: v.start,
        endTime: v.end,
        enText: v.textEn,
        zhText: v.zhClean,
      },
      { showError: false }
    )
      .then((body) => {
        this._savingBusy = false;
        if (!body || !body.success || !body.data) {
          this.setData({ savedMap: original });
          wx.showToast({ title: (body && body.message) || '收藏失败，请重试', icon: 'none' });
          return;
        }
        if (body.data.saved) {
          const next = {};
          Object.keys(optimistic).forEach((k) => {
            next[k] = optimistic[k];
          });
          next[v.id] = body.data.sentence || true;
          this.setData({ savedMap: next });
          this._showToast({
            type: 'saved',
            quote: v.textEn.slice(0, 32),
            sentence: body.data.sentence,
          });
        } else {
          const next = {};
          Object.keys(optimistic).forEach((k) => {
            next[k] = optimistic[k];
          });
          delete next[v.id];
          this.setData({ savedMap: next });
          this._showToast({ type: 'removed' });
        }
      })
      .catch((err) => {
        this._savingBusy = false;
        this.setData({ savedMap: original });
        if (err && err.code === 'SENTENCE_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '收藏失败，请重试', icon: 'none' });
      });
  },

  _showToast(t) {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this.setData({ toast: t });
    const duration = t.type === 'removed' ? 2000 : TOAST_DURATION;
    this._toastTimer = setTimeout(() => {
      this.setData({ toast: null });
      this._toastTimer = null;
    }, duration);
  },

  onToastDismiss() {
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    this.setData({ toast: null });
  },

  /** toast action「添加标签/笔记」→ 打开完善抽屉（对齐 sonner action → QuickTagDrawer） */
  onToastAction() {
    const t = this.data.toast;
    if (!t || !t.sentence) return;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = null;
    this.setData({ toast: null, drawerSentence: t.sentence });
  },

  onDrawerClose() {
    this.setData({ drawerSentence: null });
  },

  /** 抽屉保存成功 → 就地更新书签态里的 tags/note */
  onDrawerUpdated(e) {
    const { id, tags, note } = e.detail || {};
    if (id == null || !this.data.savedMap[id]) return;
    this.setData({
      ['savedMap.' + id]: Object.assign({}, this.data.savedMap[id], { tags, note }),
    });
  },

  onPremiumClose() {
    this.setData({ showPremiumModal: false });
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

  // ==================== 听写模式 ====================

  /** 切换听写句时重置输入（DictationItem 的 isActive 重置效应） */
  _resetDictation(v) {
    const built = core.buildDictation(v.textEn, '');
    this._dictErrors = 0;
    this._dictDone = false;
    this.setData({
      dictInput: '',
      dictSlots: built.slots.map((s, i) => ({ i, status: s.status, input: s.input, target: s.target, punct: s.punct })),
      dictHint: false,
    });
  },

  onDictInput(e) {
    const value = (e.detail && e.detail.value) || '';
    const v = this._views[this.data.activeIndex];
    if (!v) return;
    const built = core.buildDictation(v.textEn, value);
    const showHint = this.data.dictHint;
    const slots = built.slots.map((s, i) => ({
      i,
      status: s.status,
      input: s.input,
      target: s.target,
      punct: s.punct,
      hint: showHint && s.status !== 'correct',
    }));
    this.setData({ dictInput: value, dictSlots: slots });
    if (built.isCorrect && !this._dictDone) this._dictationSuccess();
  },

  /** 键盘确认：未全对记一次错误，满 3 次开提示词（DictationItem.handleKeyDown） */
  onDictConfirm() {
    if (this._dictDone) return;
    const v = this._views[this.data.activeIndex];
    if (!v) return;
    const built = core.buildDictation(v.textEn, this.data.dictInput);
    if (!built.isCorrect) {
      this._dictErrors += 1;
      if (this._dictErrors >= 3 && !this.data.dictHint) {
        this.setData({
          dictHint: true,
          dictSlots: this.data.dictSlots.map((s) =>
            s.status !== 'correct' ? Object.assign({}, s, { hint: true }) : s
          ),
        });
      }
    }
  },

  /** 全对自动跳下一句；末句暂停（handleDictationSuccess） */
  _dictationSuccess() {
    this._dictDone = true;
    this._lastSeekAt = Date.now();
    const next = this._views[this.data.activeIndex + 1];
    if (next) {
      audioManager.seek(next.start);
    } else {
      audioManager.pause();
    }
  },
});
