/**
 * pages/intensive-listening/index — 独立精听工作流页
 *
 * 复刻 Web 端 components/episode/InteractiveTranscript.tsx 的移动端全屏精听体验
 * （对齐 Android IntensiveListeningScreen 的页面定位），承接全屏播放面板
 * 「精听模式」胶囊入口与本页 ?id= 直达。
 *
 * 核心机制（对应 Web 源）：
 *   - 字幕流 + 词级扫光：页内 clip-player 位置回调 → intensive-core.findActiveIndex
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
 *   - 跟随滚动自动判定（对齐 Web useTranscriptScroll §4 的"安全带内不滚"
 *     语义，口径取"完全可见"）：切句时活动句已完全在 ScrollView 视口内
 *     （底缘扣除迷你播放条遮挡带）则页面静止仅切高亮，出视口才对齐锚点
 *     ——短句连播不再每句强制滚动（_followAnchor：SelectorQuery 异步测量
 *     + 令牌防陈旧决策，测不到 fail-open 回落原滚动）。
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
const { createClipPlayer } = require('../../utils/clip-player');
const listeningReporter = require('../../utils/listening-reporter');
const footprint = require('../../utils/study-footprint');
const authStore = require('../../store/authStore');
const core = require('../../utils/intensive-core');
const { trackEvent } = require('../../utils/track');

const RENDER_CHUNK = 40;   // 首屏渲染句数（窗口右缘初值）
const RENDER_EXTEND = 30;  // 自由浏览扩窗步长
const RENDER_AHEAD = 12;   // 自由浏览：活动句距窗口底缘的提前扩窗阈值
const WINDOW_BEHIND = 8;   // 跟随窗口：活动句后方保留句数（上缘收缩线）
const WINDOW_AHEAD = 40;   // 跟随窗口：活动句前方保留句数（窗口右缘目标）
const FOLLOW_VISIBLE_TOL = 4; // 跟随自动滚动：完全可见判定容差（px，吸收亚像素/取整误差）
const TOAST_DURATION = 4000; // 收藏成功 toast 驻留（对齐 sonner 默认 4s）
const GUEST_PREVIEW_SECONDS = 180; // 游客试听墙：未登录可听时长（与后端字幕裁剪同口径）
// 工具行开关偏好 key（跨会话记忆）：逐词/跟随默认开、译文默认关——
// 只存显式翻转值，onLoad 仅在存值偏离默认时覆盖
const PREF_KEYS = {
  wordSweep: 'intensiveWordSweep',
  autoScroll: 'intensiveAutoScroll',
  showTranslation: 'intensiveShowTranslation',
  linkRead: 'intensiveLinkRead', // 连读显微镜（T4.1，默认关）
};

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    episodeid: '',
    sceneid: '', // 微剧场模式（?sceneId=）：30 秒精研室（T4.1）
    scene: null,
    isSceneMode: false,
    rateLabel: '1x',
    phrase: null, // 词块点读坞：{ index, startWi, endWi, text, durText }
    phrasePlaying: '',
    quizPick: {}, // 精析随堂小测作答：quizIdx -> optionIdx
    insight: null, // 场景精析视图（vocabulary/sentences/quiz 预处理）
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
    linkRead: false, // 连读显微镜：极速连读词块琥珀高亮 + 词块点读选区（T4.1）
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
    // 深链预选模式（心愿卡册「捕词」入口）：直接进听写（含 0.8 倍速口径）
    const presetDictate = query && query.mode === 'dictate';
    // 微剧场模式（?sceneId=）：30 秒精研室（T4.1）；与 ?id= 剧集模式并存
    const sceneId = (query && (query.sceneId || query.scene)) || '';
    this.setData({
      episodeid: query.id || '',
      sceneid: sceneId,
      isSceneMode: !!sceneId,
      statusBarH: this._statusBarHeight(),
      ...(presetDictate ? { mode: 'dictate' } : {}),
    });
    // 工具行开关偏好回读：仅显式存过非默认值才覆盖（storage 异常/未存过
    // 均回落默认：逐词/跟随开、译文关）
    try {
      if (wx.getStorageSync(PREF_KEYS.wordSweep) === false) this.setData({ wordSweep: false });
      if (wx.getStorageSync(PREF_KEYS.autoScroll) === false) this.setData({ autoScroll: false });
      if (wx.getStorageSync(PREF_KEYS.showTranslation) === true) this.setData({ showTranslation: true });
      if (wx.getStorageSync(PREF_KEYS.linkRead) === true) this.setData({ linkRead: true });
    } catch (e) {}

    this._sentences = []; // 原始字幕
    this._views = [];     // 预处理视图模型（全量）
    this._renderEnd = 0;  // 渐进渲染窗口右缘（下标，不含）
    this._winStart = 0;   // 渲染窗口左缘（含）——左缘之外为 blank 哨兵
    this._freeScroll = false; // 自由浏览（用户手动滚动过）：窗口只增不减
    this._blanks = {};    // 下标 → blank 哨兵对象（稳定唯一 id，供 wx:key 复用）
    this._lastActive = -1;
    this._followSeq = 0; // 跟随自动滚动令牌（exec 异步回调期间切句/关跟随/卸载 → 丢弃陈旧决策）
    this._lastSwIdx = -1; // 上次下发扫光位置（与 viewList[i].swIdx 同步）
    this._lastSwOn = false; // 上次下发光斑点亮态（与 viewList[i].swOn 同步）
    this._isRenderingSweep = false; // 是否正在渲染词级扫光（用于限流防积压）
    this._lastSeekAt = 0;
    this._dictErrors = 0;
    this._dictDone = false;
    this._savingBusy = false;
    this._toastTimer = null;
    this._vocabSet = {}; // 已收藏生词小写表（/api/vocabulary/words）

    // 页内窗口播放器（整集后台播放器退役后的精研页音频内核）：InnerAudioContext
    // 经 clip-player 封装——起播锚定 startTime、墙钟外推位置免疫事件管线延迟、
    // 50ms 看门狗判停（七轮真机验证结晶）。seek 无原地实现 = 重锚起播；
    // 暂停位 _resumeAt 续播；播放态经 listening-reporter 联动收听时长心跳。
    this._playing = false;
    this._lastPos = 0;   // 最近一次位置回调（秒）
    this._resumeAt = 0;  // 暂停位（续播/暂停态跳句的落点）
    this._rate = presetDictate ? 0.8 : 1; // 听写降速 0.8 / 精读 1.0（深链预选含其中）
    this._audioUrl = ''; // 字幕接口带回的签名直链
    this._player = createClipPlayer({
      onPlaying: (k) => this._onPlayingChanged(!!k),
      onTick: (pos) => this._onTick(pos, this._playing),
      onEnded: () => this._onPlayingChanged(false),
    });
    // 词块点读慢放坞（T4.1）：独立窗口播放器，与主播放器互停
    this._phraseSeq = null;
    this._phrasePlayer = createClipPlayer({
      onPlaying: (k) => this.setData({ phrasePlaying: k || '' }),
      onEnded: (k) => this._onPhraseEnded(k),
    });

    this._unsubAuth = authStore.subscribe(() => this._syncAuth());
    this._syncAuth();

    if (this.data.isSceneMode) this._bootstrapScene(this.data.sceneid);
    else this._bootstrap();
  },

  /** 单例回退换集刷新（utils/route.singletonNavigateTo 回退/命中本页实例时
   *  调用；同集 no-op——_bootstrap 重拉，见 _syncAuth 同款用法） */
  singletonReload(query) {
    const id = query && query.id;
    if (!id || String(id) === String(this.data.episodeid)) return;
    this._playerPause(); // 换集：先收掉当前播放会话再重拉
    this.setData({ episodeid: id });
    this._bootstrap();
  },

  onUnload() {
    this._followSeq = (this._followSeq || 0) + 1; // 作废在途跟随测量回调
    if (this._unsubAuth) this._unsubAuth();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    // 页内播放会话随页面销毁结束（无跨页后台播放器；stop 会联动
    // _onPlayingChanged(false) → listening-reporter 冲刷余量）
    if (this._player) this._player.stop();
    if (this._phrasePlayer) this._phrasePlayer.stop();
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

  /**
   * 微剧场模式（T4.1）：GET /api/scenes/{id} 一次拉齐（3-6 句含词级时间戳
   * + deepDive），音频走物理切片（clipAudioUrl 直连 / 懒取 /api/clips），
   * 零整集字幕请求零整集音频（红线 2 终态）。切片起点 clipOffset 记为
   * _timeBase：播放位置 + timeBase = 原剧集时间轴，扫光/跟随/循环全复用。
   */
  async _bootstrapScene(sceneid) {
    this.setData({ isLoading: true, error: null, guestLimitOn: false });
    try {
      const body = await get('/api/scenes/' + encodeURIComponent(sceneid), null, { showError: false });
      if (!body || !body.success || !body.data || !body.data.scene) {
        throw new Error((body && body.message) || '微剧场不存在');
      }
      const d = body.data;
      const scene = d.scene;
      const clips = Array.isArray(scene.clips) ? scene.clips : [];
      if (clips.length === 0) throw new Error('暂无字幕数据');

      this._timeBase = Number(d.clipOffset) || 0;
      this._buildViews(clips);
      this.setData({
        scene: {
          episodeid: scene.episodeid || '',
          title: scene.title || '原声微剧场',
          summaryZh: scene.summaryZh || '',
          situationTag: scene.situationTag || '',
          cefrLevel: scene.cefrLevel || '',
          coverUrl: scene.coverUrl || '',
          duration: scene.duration || d.clipDuration || 0,
        },
        insight: this._buildInsight(scene.deepDive),
        isLoading: false,
        viewList: this._views.slice(0, this._renderEnd),
      });

      // 精研足迹（T5.2）：进入即记一笔（同 sceneid 去重置顶）
      footprint.record({
        sceneid: sceneid,
        title: scene.title || '原声微剧场',
        coverUrl: scene.coverUrl || '',
        duration: scene.duration || 0,
        situationTag: scene.situationTag || '',
      });

      if (d.clipAudioUrl) {
        this._audioUrl = d.clipAudioUrl;
        this._playerPlay(0);
      } else {
        get('/api/clips/' + encodeURIComponent(sceneid) + '/audio', null, { showError: false })
          .then((res) => {
            if (!res || !res.success || !res.data || !res.data.url) return;
            this._audioUrl = res.data.url;
            this._timeBase = Number(res.data.clipOffset) || this._timeBase;
            this._playerPlay(0);
          })
          .catch(() => {});
      }
      this._fetchSaveState();
    } catch (err) {
      this.setData({ error: (err && err.message) || '加载失败', isLoading: false });
    }
  },

  /** 字幕句（episode/scene 同构）→ 视图模型 + 连读词块标记（T4.1） */
  _buildViews(subtitles) {
    this._views = subtitles.map((sv, i) => {
      const words = Array.isArray(sv.words) ? sv.words : [];
      const flags = new Array(words.length).fill(false);
      const heads = new Array(words.length).fill(false);
      const ac = core.analyzeWordAcoustics(words);
      (ac.fastLinks || []).forEach((b) => {
        for (let k = b.startIdx; k <= b.endIdx && k < words.length; k++) {
          flags[k] = true;
          if (k === b.startIdx) heads[k] = true;
        }
      });
      const markedWords = words.map((w, wi) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        fl: flags[wi],
        flHead: heads[wi],
      }));
      return {
        index: i,
        id: sv.subtitleId != null ? sv.subtitleId : (sv.id != null ? sv.id : i),
        start: sv.start,
        end: sv.end != null ? sv.end : sv.start + 3,
        textEn: sv.textEn || '',
        zhClean: core.stripSpeaker(sv.textCn),
        words: markedWords,
        tsLabel: core.formatStartTime(sv.start),
        active: false,
        swIdx: -1,
        swOn: false,
      };
    });
    this._renderEnd = Math.min(this._views.length, RENDER_CHUNK);
    this._winStart = 0;
    this._freeScroll = false;
    this._lastSwIdx = -1;
    this._lastSwOn = false;
  },

  /** 场景 deepDive → 精析视图（WXML 零方法调用） */
  _buildInsight(deepDive) {
    if (!deepDive) return null;
    return {
      vocabulary: (deepDive.vocabulary || []).map((v) => ({
        word: v.word || '',
        phonetic: v.phonetic || '',
        meaning: v.meaning || '',
        reason: v.reason || '',
      })),
      sentences: (deepDive.sentences || []).map((x) => ({
        text: x.text || '',
        analysis: x.analysis || '',
      })),
      quiz: (deepDive.quiz || []).map((q, qi) => ({
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        answerIndex: Number(q.answerIndex) || 0,
        explanation: q.explanation || '',
        idx: qi,
      })),
    };
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

      // 字幕接口带回的 OSS 签名直链即本页音源（页内播放器直连，免二次拉取）
      if (subBody.audioUrl) episode.audioUrl = subBody.audioUrl;

      this._sentences = subtitles;
      this._buildViews(subtitles);
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

      this.setData({
        episode,
        isLoading: false,
        viewList: this._views.slice(0, this._renderEnd),
      });

      // 页内播放会话：字幕接口带回的签名直链即本页音源（无跨页后台播放器）
      this._audioUrl = subBody.audioUrl || episode.audioUrl || '';
      this.setData({ isPlayingHere: true });
      if (this._audioUrl) {
        this._playerPlay(0);
      } else {
        wx.showToast({ title: '暂时无法播放原声', icon: 'none' });
      }
      this._fetchSaveState();
    } catch (err) {
      this.setData({ error: (err && err.message) || '加载失败', isLoading: false });
    }
  },

  onRetry() {
    this._bootstrap();
  },

  // ==================== 页内播放会话（clip-player 适配） ====================

  /** 起播/重锚起播（seek 即重锚）。fromSec 为切片本地秒；剧集模式
   *  _timeBase=0 时与原剧集时间轴等价 */
  _playerPlay(fromSec) {
    if (!this._audioUrl) return;
    const sec = isFinite(fromSec) && fromSec > 0 ? fromSec : 0;
    this._resumeAt = sec;
    if (this._phrasePlayer) this._phrasePlayer.stop(); // 词块坞互停
    this._player.playUrl(this._audioUrl, 'episode', { startSec: sec, rate: this._rate });
  },

  /** 剧集时间轴绝对秒 → 切片本地秒（微剧场模式） */
  _absToLocal(absSec) {
    return Math.max(0, (Number(absSec) || 0) - (this._timeBase || 0));
  },

  /** 暂停并记住位置（续播从 _resumeAt 起） */
  _playerPause() {
    if (!this._playing) return;
    const pos = this._player.estimatedPos();
    if (pos != null) this._resumeAt = pos;
    this._player.stop();
  },

  /** 暂停态跳句只挪 _resumeAt；在播则重锚到目标句句首（入参为剧集绝对秒） */
  _playerSeek(absSec) {
    const local = this._absToLocal(absSec);
    if (this._playing) this._playerPlay(local);
    else this._resumeAt = local;
  },

  /** clip-player 播放态翻转 → 页面态同步 + 收听时长心跳 + 扫光预热/回落 */
  _onPlayingChanged(playing) {
    this._playing = playing;
    listeningReporter.onPlaybackState(playing); // 打卡时长数据源（原全局播放器接线）
    if (playing === this.data.isPlaying) return;
    const patch = { isPlaying: playing };
    const idx = this.data.activeIndex;
    if (idx >= 0) {
      // 暂停时 item.active 回落未读态；恢复时按当前位置就地预热扫光（原
      // 全局镜像驱动的同款语义，位置源由 timeupdate 换成 _lastPos）
      patch['viewList[' + idx + '].active'] = playing;
      if (playing) {
        const v = this._views[idx];
        if (this.data.mode === 'read' && this.data.wordSweep && v && v.words.length) {
          const sw = core.computeWordSweep(v.words, (this._lastPos || 0) + (this._timeBase || 0), v.start, v.end);
          this._lastSwIdx = sw.idx;
          this._lastSwOn = sw.on;
          patch['viewList[' + idx + '].swIdx'] = sw.idx;
          patch['viewList[' + idx + '].swOn'] = sw.on;
        }
      }
    }
    this.setData(patch);
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

  // ==================== 播放推进（clip-player 位置回调驱动） ====================

  /**
   * 每次位置回调（50ms 看门狗 + onTimeUpdate）的推进处理：循环回跳 →
   * 句定位 → 词扫光。粒度 50ms，词级高亮比原 BGM timeupdate 更细腻。
   */
  _onTick(t, playing) {
    const views = this._views;
    if (!views.length) return;
    this._lastPos = t; // 切片本地秒（重锚/词块坞共用）
    const at = t + (this._timeBase || 0); // 剧集时间轴绝对秒（扫光/跟随/循环）

    // 游客时长拦截（仅剧集模式；微剧场切片 ≤40s 天然合规，游客可完整体验）
    if (!this.data.isSceneMode && !this.data.isLoggedIn && at >= GUEST_PREVIEW_SECONDS) {
      if (!this.data.guestLimitOn) this._engageGuestLimit();
      else if (playing) this._playerPause();
      return;
    }

    // 单句循环：听写模式锁活动句，精读模式锁 loopIndex（useTranscriptScroll loopTarget）
    const loopIdx =
      this.data.mode === 'dictate' ? this.data.activeIndex : this.data.loopIndex;
    if (playing && loopIdx >= 0 && loopIdx < views.length) {
      const sub = views[loopIdx];
      if (core.shouldLoopSeek(at, sub, this._lastSeekAt, Date.now())) {
        this._lastSeekAt = Date.now();
        this._playerSeek(sub.start);
        return; // 重锚后由新位置回调接管
      }
    }

    const idx = core.findActiveIndex(views, at, this._lastActive);
    if (idx !== this.data.activeIndex) {
      this._lastActive = idx;
      this._setActive(idx, at);
      return;
    }
    if (idx >= 0 && playing && this.data.mode === 'read' && this.data.wordSweep) {
      // 词级扫光三态（computeWordSweep）：路径补丁只写进活动句视图字段，
      // 视图层重算范围收敛到该句（原页面级标量会牵动全列表词节点重算）
      const v = views[idx];
      const sw = core.computeWordSweep(v.words, at, v.start, v.end);
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
    this._playerPause();
    if (last) this._resumeAt = this._absToLocal(last.start); // 回退句首（登录前可反复试听）
    this.setData({ guestLimitOn: true });
  },

  _setActive(idx, t) {
    // prev 以 data.activeIndex 为准（_onTick 调用前 _lastActive 已先行为 idx）
    const prev = this.data.activeIndex;
    const patch = { activeIndex: idx };
    let follow = false;
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
      // 跟随滚动改走 _followAnchor 自动判定（完全可见不滚）：在 setData 之后
      // 发起——测量回调以 activeIndex 为陈旧闸，高亮先落、滚动决策随后，
      // 短句连播不再每句跳页
      follow = this.data.autoScroll;
      if (this.data.mode === 'dictate') this._resetDictation(v);
    } else {
      this._lastSwIdx = -1;
      this._lastSwOn = false;
    }
    this.setData(patch);
    if (follow) this._followAnchor(idx);
  },

  /**
   * 跟随滚动自动判定（Web useTranscriptScroll §4 的"安全带内不滚"语义，
   * 口径取用户可感的"完全可见"）：
   *   - 活动句完全在 ScrollView 视口内（顶缘不裁、底缘不含迷你播放条遮挡带）
   *     → 页面静止，仅切高亮——短句连播防每句强制对齐的跳动感；
   *   - 未完全可见（部分遮挡/越出上下缘）→ 滚动对齐锚点（原跟随位：
   *     scroll-into-view + -80 offset）。
   * SelectorQuery 异步：exec 回调期间可能已切句/关跟随 → _followSeq 令牌 +
   * activeIndex 双闸丢弃陈旧决策；节点未测到（首屏 viewList 同帧未渲染）
   * 延时重试，仍失败则回落原无条件滚动（fail-open，宁可多滚不可不跟）。
   */
  _followAnchor(idx, attempt) {
    if (!this.data.autoScroll) return;
    const v = this._views && this._views[idx];
    if (!v) return;
    const anchor = 'sub-' + v.id;
    const seq = (this._followSeq = (this._followSeq || 0) + 1);
    wx.createSelectorQuery()
      .select('.il-scroll')
      .boundingClientRect()
      .select('#' + anchor)
      .boundingClientRect()
      .exec((res) => {
        if (seq !== this._followSeq || !this.data.autoScroll) return;
        if (this.data.activeIndex !== idx) return; // 已切到更新的句子，决策作废
        const box = res && res[0];
        const item = res && res[1];
        if (!box || !item) {
          if ((attempt || 0) < 2) {
            setTimeout(() => {
              if (seq === this._followSeq) this._followAnchor(idx, (attempt || 0) + 1);
            }, 50);
          } else {
            this._scrollToAnchor(anchor); // 测不到（病态路径）→ 回落原滚动
          }
          return;
        }
        this._decideFollow(box, item, anchor);
      });
  },

  /**
   * 完全可见 → 静止；否则滚动。可见下缘取 min(滚动区底缘, 迷你条顶缘)——
   * 底部悬浮迷你条的遮挡带内不算"完全可见"（高亮/控制条被压住），
   * 迷你条未渲染或不可测时全额回退滚动区底缘。
   */
  _decideFollow(box, item, anchor) {
    const decide = (viewBottom) => {
      if (
        item.top >= box.top - FOLLOW_VISIBLE_TOL &&
        item.bottom <= viewBottom + FOLLOW_VISIBLE_TOL
      ) {
        return; // 完全可见：页面保持静止，仅句级高亮切换
      }
      this._scrollToAnchor(anchor);
    };
    const mp = this.selectComponent ? this.selectComponent('.il-mini-host') : null;
    if (!mp) return decide(box.bottom);
    wx.createSelectorQuery()
      .in(mp)
      .select('.mp-bar')
      .boundingClientRect()
      .exec((r) => {
        const bar = r && r[0];
        decide(bar && bar.top < box.bottom ? bar.top : box.bottom);
      });
  },

  /** scroll-into-view 赋值：同值不触发滚动 → 先清空再锚定强制翻转
   *  （原 onToggleAutoScroll 重开跟随的手法收敛成复用） */
  _scrollToAnchor(anchor) {
    if (anchor !== this.data.scrollIntoView) {
      this.setData({ scrollIntoView: anchor });
    } else {
      this.setData({ scrollIntoView: '' }, () => this.setData({ scrollIntoView: anchor }));
    }
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
    // 听写降速 0.8 / 精读恢复 1.0（InteractiveTranscript 的 dictate 倍速效应）；
    // clip-player 倍速须起播时锚定 → 在播则以当前位置重锚续播
    this._rate = mode === 'dictate' ? 0.8 : 1.0;
    if (this._playing) this._playerPlay(this._lastPos);
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
    // 重开跟随：收回自由浏览头部，滑窗回活动句并强制对齐锚点（显式回位
    // 意图，不受自动滚动"完全可见不滚"约束）
    if (autoScroll) {
      this._freeScroll = false;
      const idx = this.data.activeIndex;
      if (idx >= 0 && this._views[idx]) {
        const patch = {};
        this._slideWindow(idx, patch);
        if (Object.keys(patch).length) this.setData(patch);
        this._scrollToAnchor('sub-' + this._views[idx].id);
      }
    }
  },

  onToggleTranslation() {
    const showTranslation = !this.data.showTranslation;
    this.setData({ showTranslation });
    this._savePref(PREF_KEYS.showTranslation, showTranslation);
  },

  /** 连读显微镜开关（T4.1）：词块琥珀高亮 + 点词切换为词块选区 */
  onToggleLinkRead() {
    const linkRead = !this.data.linkRead;
    this.setData({ linkRead, phrase: null });
    if (this._phrasePlayer) this._phrasePlayer.stop();
    this._selAnchor = null;
    this._savePref(PREF_KEYS.linkRead, linkRead);
  },

  /** 倍速切换（画报头卡控制条）：在播则以当前位置重锚续播 */
  onRatePick(e) {
    const rate = Number(e.currentTarget.dataset.rate) || 1;
    this._rate = rate;
    this.setData({ rateLabel: rate === 0.75 ? '0.75x' : rate + 'x' });
    if (this._playing) this._playerPlay(this._lastPos);
  },

  /** 画报头卡播放/暂停 */
  onHeroToggle() {
    if (this._playing) this._playerPause();
    else this._playerPlay(this._resumeAt || 0);
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
      const sw = core.computeWordSweep(v.words, (this._lastPos || 0) + (this._timeBase || 0), v.start, v.end);
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
    this._playerPlay(this._absToLocal(v.start));
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

  /** 点词（T4.1 双态）：显微镜开 → 词块选区；关 → 查词典 */
  onWordTap(e) {
    if (this.data.linkRead) {
      this._onWordSelect(e.currentTarget.dataset);
      return;
    }
    const ds = e.currentTarget.dataset;
    const v = this._views[Number(ds.index)];
    if (!v) return;
    const w = v.words[Number(ds.wi)];
    if (!w) return;
    const cleanWord = String(w.word || '')
      .replace(/[.,!?;:"()]/g, '')
      .trim();
    if (!cleanWord) return;

    if (this.data.isPlaying) this._playerPause();

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

  // ==================== 词块点读慢放坞（T4.1 显微镜） ====================

  /** 连点两个词框选 2-4 词词块：首点定起点（pending 态提示），次点定终点 */
  _onWordSelect(ds) {
    const index = Number(ds.index);
    const wi = Number(ds.wi);
    const v = this._views[index];
    if (!v) return;
    if (this._phrasePlayer) this._phrasePlayer.stop();
    this._phraseSeq = null;

    // 首点 / 换句重选：落 pending 起点
    if (!this._selAnchor || this._selAnchor.index !== index) {
      this._selAnchor = { index, wi };
      this.setData({
        phrase: { index, startWi: wi, endWi: wi, text: v.words[wi].word, durText: '再点尾词框选 2-4 词', pending: true },
      });
      return;
    }
    // 同词再点：取消选区
    if (this._selAnchor.wi === wi) {
      this._selAnchor = null;
      this.setData({ phrase: null });
      return;
    }
    // 次点定界：顺序归一 + 钳制 ≤4 词
    let a = Math.min(this._selAnchor.wi, wi);
    let b = Math.max(this._selAnchor.wi, wi);
    if (b - a > 3) b = a + 3;
    this._selAnchor = null;
    const win = core.slicePhraseWindow(v.words, a, b);
    if (!win || !isFinite(win.startSec) || !isFinite(win.endSec)) {
      wx.showToast({ title: '该词块缺少时间戳', icon: 'none' });
      this.setData({ phrase: null });
      return;
    }
    this._phraseWin = win;
    this.setData({
      phrase: {
        index,
        startWi: a,
        endWi: b,
        text: win.phraseText,
        durText: win.endSec - win.startSec < 10
          ? (win.endSec - win.startSec).toFixed(1) + 's'
          : Math.round(win.endSec - win.startSec) + 's',
        pending: false,
      },
    });
  },

  onPhraseClose() {
    this._selAnchor = null;
    this._phraseSeq = null;
    if (this._phrasePlayer) this._phrasePlayer.stop();
    this.setData({ phrase: null });
  },

  /** 原速 / 慢镜 / 阶梯三连放（1.0 → 0.75 → 1.0） */
  onPhrasePlay(e) {
    const phrase = this.data.phrase;
    if (!phrase || phrase.pending || !this._phraseWin || !this._audioUrl) return;
    const mode = e.currentTarget.dataset.mode;
    const seq = mode === 'slow' ? [0.75] : mode === 'triple' ? [1, 0.75, 1] : [1];
    this._player.stop(); // 主播放器互停
    this._phraseSeq = seq;
    this._playPhraseAt(0, seq[0]);
  },

  _playPhraseAt(i, rate) {
    const win = this._phraseWin;
    this._phrasePlayer.playUrl(this._audioUrl, 'phrase' + i, {
      startSec: this._absToLocal(win.startSec),
      endSec: this._absToLocal(win.endSec),
      rate,
    });
  },

  /** 三连放推进：onEnded 携带序号推进到下一档 */
  _onPhraseEnded(kind) {
    if (!this._phraseSeq) {
      this.setData({ phrasePlaying: '' });
      return;
    }
    const i = Number(String(kind || '').replace('phrase', ''));
    if (!isFinite(i) || i + 1 >= this._phraseSeq.length) {
      this._phraseSeq = null;
      this.setData({ phrasePlaying: '' });
      return;
    }
    this._playPhraseAt(i + 1, this._phraseSeq[i + 1]);
  },

  /** 词块收进生词本（word=词块文本，上下文=所在句） */
  onPhraseSave() {
    const phrase = this.data.phrase;
    if (!phrase || phrase.pending) return;
    if (!this.data.isLoggedIn) {
      this._promptLogin('请先登录后再保存生词');
      return;
    }
    const v = this._views[phrase.index] || {};
    const word = String(phrase.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!word) return;
    post(
      '/api/vocabulary/add',
      {
        word,
        definition: '',
        contextSentence: v.textEn || '',
        translation: v.zhClean || '',
        episodeid: this.data.isSceneMode
          ? ((this.data.scene && this.data.scene.episodeid) || '')
          : this.data.episodeid,
        timestamp: Math.floor(this._phraseWin ? this._phraseWin.startSec : 0),
        speakUrl: '', dictUrl: '', webUrl: '', mobileUrl: '',
      },
      { showError: false }
    )
      .then(() => wx.showToast({ title: '已收进生词本', icon: 'none' }))
      .catch((err) => {
        if (err && err.statusCode === 400) {
          wx.showToast({ title: '已在生词本里', icon: 'none' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
      });
  },

  /** 精析随堂小测作答（点选项显对错 + 解析） */
  onQuizPick(e) {
    const ds = e.currentTarget.dataset;
    const q = Number(ds.q);
    if (!isFinite(q) || this.data.quizPick[q] !== undefined) return; // 已作答锁定
    this.setData({ ['quizPick.' + q]: Number(ds.o) });
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
      this._playerSeek(next.start);
    } else {
      this._playerPause();
    }
  },
});
