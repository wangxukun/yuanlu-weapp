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
 *     vocabulary_daily / dictionary_quota 场景文案已在组件内置）；
 *   - 游客试听墙：未登录字幕裁至前 180s（后端 /api/episode/subtitles 裁 +
 *     前端同口径兜底），播放时长满 180s 落锁暂停，字幕流尾部常驻
 *     「登录后解锁全部字幕」按钮（InteractiveTranscript 同名按钮复刻）。
 *
 * 性能口径（长剧集防 setData 渲染积压，2026-10-08 重构）：
 *   - 扫光/活动态写进 viewList[i] 视图字段（active/swIdx/swOn），高频
 *     setData 走 viewList[i].xxx 路径补丁——词 class 只依赖 item 字段，
 *     视图层 WXS 重算范围收敛到活动句，不再随已渲染句数线性放大
 *     （原页面级标量 activeWordIndex/wordSweepOn 每帧牵动全列表词节点，
 *     160min 剧集播至 500+ 句时每次 setData 重算上万节点，渲染追不上
 *     通信频率 → 队列积压，暂停后高亮仍在"追帧"）；
 *   - 渲染窗口滑动化：跟随态窗口 [活动句-8, 活动句+40] 随句平移，离开
 *     窗口的句子哨兵化（blank 占位，节点总量恒定，与剧集时长无关）；
 *     用户手动滚动进入自由浏览（只增不减，活动句保底在窗），点句跳播 /
 *     重开跟随开关收回跟随态。
 *
 * 词扫光开关（小程序平台性扩展，Web 端无此控件——Web 扫光为 rAF 60fps 直写
 * DOM 无性能问题，小程序 timeupdate 离散采样且 setData 有通信成本，低端机
 * 长句仍可能卡顿；另有用户觉得光斑晃眼）：
 *   - 工具行「逐词」按钮（跟随左侧，仅精读模式显示），默认开，关→开就地预热；
 *   - 关闭后活动句仅保留句级高亮（primary-50 底 + 左缘线），词色统一；
 *   - _onTick/_setActive/_onPlayerState 预热三处以 wordSweep && 短路，
 *     关闭时高频路径补丁 setData 整体不再产生。
 *   - 工具行三开关（逐词/跟随/译文）偏好 wx storage 持久化
 *     （intensiveWordSweep/intensiveAutoScroll/intensiveShowTranslation，
 *     默认 开/开/关，只存显式翻转值，onLoad 集中回读 + _savePref 统一落盘）。
 */

const theme = require('../../utils/theme');
const { get, post } = require('../../utils/request');
const { fetchSubtitles } = require('../../utils/subtitle-cache');
const audioManager = require('../../utils/audioManager');
const audioBus = require('../../utils/audio-bus');
const playerStore = require('../../store/playerStore');
const authStore = require('../../store/authStore');
const core = require('../../utils/intensive-core');
const { trackEvent } = require('../../utils/track');

const RENDER_CHUNK = 40;   // 首屏渲染句数（窗口右缘初值）
const RENDER_EXTEND = 30;  // 自由浏览扩窗步长
const RENDER_AHEAD = 12;   // 自由浏览：活动句距窗口底缘的提前扩窗阈值
const WINDOW_BEHIND = 8;   // 跟随窗口：活动句后方保留句数（上缘收缩线）
const WINDOW_AHEAD = 40;   // 跟随窗口：活动句前方保留句数（窗口右缘目标）
const TOAST_DURATION = 4000; // 收藏成功 toast 驻留（对齐 sonner 默认 4s）
const GUEST_PREVIEW_SECONDS = 180; // 游客试听墙：未登录可听时长（与后端字幕裁剪同口径）
// 工具行开关偏好 key（跨会话记忆）：逐词/跟随默认开、译文默认关——
// 只存显式翻转值，onLoad 仅在存值偏离默认时覆盖
const PREF_KEYS = {
  wordSweep: 'intensiveWordSweep',
  autoScroll: 'intensiveAutoScroll',
  showTranslation: 'intensiveShowTranslation',
};

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    episodeid: '',
    episode: null,
    isLoading: true,
    error: null,
    statusBarH: 20,

    mode: 'read', // 精读 | 听写（对齐 Web transcriptMode）
    viewList: [], // 渐进渲染的字幕视图模型（离开窗口的项哨兵化 blank:true）
    activeIndex: -1,
    // 词扫光态随活动句视图字段 viewList[activeIndex] 下发（swIdx/swOn/active），
    // 高频路径补丁只让活动句的绑定重算——不再放页面级标量（见文件头性能口径）
    isPlaying: false,
    isPlayingHere: false, // 全局播放器当前会话即本集（对齐 isPlayingThisEpisode）
    autoScroll: true, // 跟随开关（默认开；偏好持久化，见 PREF_KEYS）
    showTranslation: false, // 译文开关（默认关；偏好持久化，见 PREF_KEYS）
    wordSweep: true, // 词级扫光开关（平台性扩展；关闭仅留句级高亮，见文件头）
    loopIndex: -1,
    scrollIntoView: '',

    isLoggedIn: false,
    guestLimitOn: false, // 游客试听墙已落锁（播放时长满 180s 拦截暂停）
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

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
  },

  onLoad(query) {
    this.setData({
      episodeid: query.id || '',
      statusBarH: this._statusBarHeight(),
    });
    // 工具行开关偏好回读：仅显式存过非默认值才覆盖（storage 异常/未存过
    // 均回落默认：逐词/跟随开、译文关）
    try {
      if (wx.getStorageSync(PREF_KEYS.wordSweep) === false) this.setData({ wordSweep: false });
      if (wx.getStorageSync(PREF_KEYS.autoScroll) === false) this.setData({ autoScroll: false });
      if (wx.getStorageSync(PREF_KEYS.showTranslation) === true) this.setData({ showTranslation: true });
    } catch (e) {}

    this._sentences = []; // 原始字幕
    this._views = [];     // 预处理视图模型（全量）
    this._renderEnd = 0;  // 渐进渲染窗口右缘（下标，不含）
    this._winStart = 0;   // 渲染窗口左缘（含）——左缘之外为 blank 哨兵
    this._freeScroll = false; // 自由浏览（用户手动滚动过）：窗口只增不减
    this._blanks = {};    // 下标 → blank 哨兵对象（稳定唯一 id，供 wx:key 复用）
    this._lastActive = -1;
    this._lastSwIdx = -1; // 上次下发扫光位置（与 viewList[i].swIdx 同步）
    this._lastSwOn = false; // 上次下发光斑点亮态（与 viewList[i].swOn 同步）
    this._isRenderingSweep = false; // 是否正在渲染词级扫光（用于限流防积压）
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

  /** 单例回退换集刷新（utils/route.singletonNavigateTo 回退/命中本页实例时
   *  调用；同集 no-op——_bootstrap 重拉不打断播放会话，见 _syncAuth 同款用法） */
  singletonReload(query) {
    const id = query && query.id;
    if (!id || String(id) === String(this.data.episodeid)) return;
    this.setData({ episodeid: id });
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
    this.setData({ isLoading: true, error: null, guestLimitOn: false });
    try {
      const [episode, subBody] = await Promise.all([
        get(`/api/episode/detail?id=${episodeid}`),
        fetchSubtitles(episodeid),
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
        // 词光态（原页面级标量 activeWordIndex/wordSweepOn 下沉到活动句字段，
        // 使高频 setData 的视图层重算收敛到单句，见文件头性能口径）
        active: false, // 活动句且本集在播（词三态总开关，暂停时回落）
        swIdx: -1,     // 扫光位置（-1=句首前，len=整句读完）
        swOn: false,   // 光斑是否点亮（间隙/读毕时 false → 全部回落已读色）
      }));
      // 游客试听墙（对齐 Web 端口径）：后端未登录时已把字幕裁至前 180s
      // （start < 180），前端同口径再裁一次防后端放开后泄漏；音频不受此裁剪
      // 影响（detail 接口对游客仍签发直链、整集连播），越界续播由 _onTick
      // 的时长拦截兜底
      if (!authStore.getState().isLoggedIn) {
        const cutLen = this._views.findIndex(
          (v) => v.start >= GUEST_PREVIEW_SECONDS
        );
        if (cutLen > 0) this._views = this._views.slice(0, cutLen);
      }

      this._renderEnd = Math.min(this._views.length, RENDER_CHUNK);
      this._winStart = 0; // 换集重拉（singletonReload/_syncAuth）复位窗口态
      this._freeScroll = false;
      this._lastSwIdx = -1;
      this._lastSwOn = false;
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
    if (!this.data.isLoading && this._views.length) {
      // 登录态翻转 → 180s 试听墙口径切换（全量 ↔ 裁剪），重拉字幕与书签态；
      // 播放会话不打断（_ensurePlaying 同集只补精听标记/续播，拦截点续播）
      if (!s.isLoggedIn) this.setData({ savedMap: {} });
      this._bootstrap();
      return;
    }
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
    const wasPlaying = this.data.isPlaying;
    const here = !!(
      s.hasEpisode &&
      s.currentEpisode &&
      String(s.currentEpisode.episodeid) === String(this.data.episodeid)
    );
    const playing = !!(here && s.isPlaying);
    const patch = {};
    if (playing !== wasPlaying) patch.isPlaying = playing;
    if (here !== this.data.isPlayingHere) patch.isPlayingHere = here;

    if (!here) {
      this._lastActive = -1;
      this._lastSwIdx = -1;
      this._lastSwOn = false;
      const idx = this.data.activeIndex;
      if (idx !== -1) {
        patch.activeIndex = -1;
        patch['viewList[' + idx + '].active'] = false;
      }
      if (Object.keys(patch).length) this.setData(patch);
      // 关闭联动（Bug 1）：本集会话被全局关闭（底部迷你条/全屏面板的 × →
      // audioManager.close 清空会话）时，精听页失去存在意义，随音频停止一并返回
      if (wasHere && !s.hasEpisode) this._exitPage();
      return;
    }

    // 播放/暂停翻转 → 活动句词光同步：暂停时 item.active 回落全部已读色外
    // 的未读态（原 WXS 以页面级 isPlaying 短路，现由 item.active 承载须显式
    // 翻转）；恢复时按当前进度就地预热扫光，免等下一帧 timeupdate
    if (playing !== wasPlaying) {
      const idx = this.data.activeIndex;
      if (idx >= 0) {
        patch['viewList[' + idx + '].active'] = playing;
        if (playing) {
          const v = this._views[idx];
          if (this.data.mode === 'read' && this.data.wordSweep && v.words.length) {
            const sw = core.computeWordSweep(v.words, s.currentTime || 0, v.start, v.end);
            this._lastSwIdx = sw.idx;
            this._lastSwOn = sw.on;
            patch['viewList[' + idx + '].swIdx'] = sw.idx;
            patch['viewList[' + idx + '].swOn'] = sw.on;
          }
        }
      }
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

    // 游客时长拦截：未登录试听满 180s → 落锁暂停；已落锁后经迷你条/全屏面板
    // 再点播放或拖进度越界 → 就地再拦（180s 内跳句/循环/听写不受影响）
    if (!this.data.isLoggedIn && t >= GUEST_PREVIEW_SECONDS) {
      if (!this.data.guestLimitOn) this._engageGuestLimit();
      else if (playing) audioManager.pause();
      return;
    }

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
    if (idx >= 0 && playing && this.data.mode === 'read' && this.data.wordSweep) {
      // 词级扫光三态（computeWordSweep）：路径补丁只写进活动句视图字段，
      // 视图层重算范围收敛到该句（原页面级标量会牵动全列表词节点重算）
      const v = views[idx];
      const sw = core.computeWordSweep(v.words, t, v.start, v.end);
      if (sw.idx !== this._lastSwIdx || sw.on !== this._lastSwOn) {
        if (this._isRenderingSweep) {
          // 如果上一帧扫光还在渲染队列中，主动丢弃当前帧，防止队列积压
          // 这会使得高亮在性能受限时跳跃前进，而不是持续滞后并在暂停后继续"追帧"
          return;
        }
        this._lastSwIdx = sw.idx;
        this._lastSwOn = sw.on;
        this._isRenderingSweep = true;
        this.setData({
          ['viewList[' + idx + '].swIdx']: sw.idx,
          ['viewList[' + idx + '].swOn']: sw.on,
        }, () => {
          this._isRenderingSweep = false;
        });
      }
    }
  },

  /**
   * 游客试听墙落锁：回退到最后一句句首（登录前仍可反复试听前 180s）并暂停。
   * 解锁按钮由 WXML 按 !isLoggedIn 常驻字幕流尾部（对齐 Web
   * InteractiveTranscript「登录后解锁全部字幕」的渲染条件）。
   */
  _engageGuestLimit() {
    const last = this._views[this._views.length - 1];
    if (last) {
      this._lastSeekAt = Date.now();
      audioManager.seek(last.start);
    }
    audioManager.pause();
    this.setData({ guestLimitOn: true });
  },

  _setActive(idx, t) {
    // prev 以 data.activeIndex 为准（_onTick 调用前 _lastActive 已先行为 idx）
    const prev = this.data.activeIndex;
    const patch = { activeIndex: idx };
    if (prev >= 0 && prev !== idx) {
      patch['viewList[' + prev + '].active'] = false;
    }
    if (idx >= 0) {
      const v = this._views[idx];
      const sw =
        this.data.mode === 'read' && this.data.wordSweep && this.data.isPlaying && v.words.length
          ? core.computeWordSweep(v.words, t, v.start, v.end)
          : { idx: -1, on: false };
      this._lastSwIdx = sw.idx;
      this._lastSwOn = sw.on;
      patch['viewList[' + idx + '].active'] = true;
      patch['viewList[' + idx + '].swIdx'] = sw.idx;
      patch['viewList[' + idx + '].swOn'] = sw.on;

      this._slideWindow(idx, patch);
      if (this.data.autoScroll) {
        const anchor = 'sub-' + v.id;
        if (anchor !== this.data.scrollIntoView) patch.scrollIntoView = anchor;
      }
      if (this.data.mode === 'dictate') this._resetDictation(v);
    } else {
      this._lastSwIdx = -1;
      this._lastSwOn = false;
    }
    this.setData(patch);
  },

  /** blank 哨兵（wx:key 需稳定唯一 id；同下标复用同一对象减少分配） */
  _blankAt(i) {
    if (!this._blanks[i]) this._blanks[i] = { id: 'blank-' + i, blank: true };
    return this._blanks[i];
  },

  /**
   * 渲染窗口平移（长剧集节点总量恒定的关键）：
   *   - 跟随态：窗口 [activeIdx-WINDOW_BEHIND, activeIdx+WINDOW_AHEAD] 随句
   *     滑动，离开窗口的句子哨兵化（渲染节点数恒定 ~50 句，与剧集时长无关）；
   *   - 自由浏览（用户手动滚动过）：退化为只增不减（原 _maybeExtend 口径），
   *     但活动句保底收进窗口（上缘回填/底缘扩窗），保证扫光路径补丁永远
   *     落在真实节点上。
   * 平移路径并入调用方（_setActive 等）的同一份 patch，一次 setData 收口。
   */
  _slideWindow(activeIdx, patch) {
    const total = this._views.length;
    if (activeIdx < 0) return;

    if (this._freeScroll) {
      if (activeIdx < this._winStart) {
        for (let i = activeIdx; i < this._winStart; i++) {
          patch['viewList[' + i + ']'] = this._views[i];
        }
        this._winStart = activeIdx;
      }
      if (this._renderEnd < total && activeIdx > this._renderEnd - RENDER_AHEAD) {
        let newEnd = this._renderEnd;
        while (newEnd < total && newEnd < activeIdx + RENDER_AHEAD) {
          newEnd += RENDER_EXTEND;
        }
        this._appendInto(newEnd, patch);
      }
      return;
    }

    const winStart = Math.max(0, activeIdx - WINDOW_BEHIND);
    const winEnd = Math.min(total, activeIdx + WINDOW_AHEAD);
    if (winStart > this._winStart) {
      for (let i = this._winStart; i < winStart; i++) {
        const item = this.data.viewList[i];
        if (!item || !item.blank) {
          patch['viewList[' + i + ']'] = this._blankAt(i);
        }
      }
    } else if (winStart < this._winStart) {
      // 回退 seek：上缘重新回填
      for (let i = winStart; i < this._winStart; i++) {
        patch['viewList[' + i + ']'] = this._views[i];
      }
    }
    this._winStart = winStart;
    this._appendInto(winEnd, patch);
  },

  /** 右缘追加进 patch（路径补丁逐项赋值，不整表重发） */
  _appendInto(newEnd, patch) {
    if (newEnd <= this._renderEnd) return;
    for (let i = this._renderEnd; i < newEnd; i++) {
      patch['viewList[' + i + ']'] = this._views[i];
    }
    this._renderEnd = newEnd;
  },

  /** 手动滚动到底：进入自由浏览（只增不减），再补一窗 */
  onScrollLower() {
    this._freeScroll = true;
    if (this._renderEnd >= this._views.length) return;
    const patch = {};
    this._appendInto(Math.min(this._views.length, this._renderEnd + RENDER_EXTEND), patch);
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 手动滚动到顶：进入自由浏览，上缘回退一窗（阅读更早的句子） */
  onScrollUpper() {
    this._freeScroll = true;
    if (this._winStart <= 0) return;
    const newStart = Math.max(0, this._winStart - RENDER_EXTEND);
    const patch = {};
    for (let i = this._winStart - 1; i >= newStart; i--) {
      patch['viewList[' + i + ']'] = this._views[i];
    }
    this._winStart = newStart;
    if (Object.keys(patch).length) this.setData(patch);
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

  /** 工具行偏好落盘（storage 异常静默——偏好丢失不阻断交互） */
  _savePref(key, value) {
    try {
      wx.setStorageSync(key, value);
    } catch (e) {}
  },

  onToggleAutoScroll() {
    const autoScroll = !this.data.autoScroll;
    this.setData({ autoScroll });
    this._savePref(PREF_KEYS.autoScroll, autoScroll);
    // 重开跟随：收回自由浏览头部，滑窗回活动句并对齐锚点
    if (autoScroll) {
      this._freeScroll = false;
      const idx = this.data.activeIndex;
      if (idx >= 0) {
        const patch = {};
        this._slideWindow(idx, patch);
        const anchor = 'sub-' + this._views[idx].id;
        if (anchor !== this.data.scrollIntoView) {
          patch.scrollIntoView = anchor;
        } else {
          // 锚点未变也要强制回滚（scroll-into-view 同值不触发滚动）：
          // 先清空再锚定，两次 setData 产生属性翻转
          this.setData({ scrollIntoView: '' });
          patch.scrollIntoView = anchor;
        }
        if (Object.keys(patch).length) this.setData(patch);
      }
    }
  },

  onToggleTranslation() {
    const showTranslation = !this.data.showTranslation;
    this.setData({ showTranslation });
    this._savePref(PREF_KEYS.showTranslation, showTranslation);
  },

  /**
   * 词扫光开关（仅精读模式；听写本就无扫光，按钮隐藏）：
   *   - 关闭：清当前活动句扫光字段（wordCls 对 active=true + swIdx=-1 自然
   *     回落全词统一色，WXS 无需改），_onTick 扫光分支被 guard 短路，
   *     高频路径补丁 setData 整体停发；
   *   - 重开：按当前进度就地预热（免等下一帧 timeupdate）。
   * 偏好 storage 持久化，晃眼敏感/低端机用户无需每次重进再关。
   */
  onToggleWordSweep() {
    const wordSweep = !this.data.wordSweep;
    this.setData({ wordSweep });
    this._savePref(PREF_KEYS.wordSweep, wordSweep);

    const idx = this.data.activeIndex;
    if (idx < 0 || this.data.mode !== 'read') return;
    const v = this._views[idx];
    if (!v) return;
    if (!wordSweep) {
      this._lastSwIdx = -1;
      this._lastSwOn = false;
      this.setData({
        ['viewList[' + idx + '].swIdx']: -1,
        ['viewList[' + idx + '].swOn']: false,
      });
    } else if (this.data.isPlaying && v.words.length) {
      const st = playerStore.getState();
      const sw = core.computeWordSweep(v.words, st.currentTime || 0, v.start, v.end);
      this._lastSwIdx = sw.idx;
      this._lastSwOn = sw.on;
      this.setData({
        ['viewList[' + idx + '].swIdx']: sw.idx,
        ['viewList[' + idx + '].swOn']: sw.on,
      });
    }
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
    // 点句跳播 = 回到跟随意图（跟随开关关着则保持自由浏览——窗口不跳移，
    // 防止用户视口附近的句子被滑走清屏）；窗口/锚点由下一帧 _setActive 收口
    this._freeScroll = !this.data.autoScroll;
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

  /** 游客试听墙「登录后解锁全部字幕」→ 登录页（项目登录跳转惯例 navigateTo auth；
   *  登录成功 authStore 翻转 → 本页 _syncAuth 自动重拉全量字幕并从拦截点续播，
   *  auth 页 finishLogin 检测到上级页自动 navigateBack 回本页） */
  onUnlockLogin() {
    trackEvent('GUEST_SUBTITLE_UNLOCK_CLICK', 'intensive_listening');
    wx.navigateTo({ url: '/pages/auth/index' });
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
