/**
 * pages/home/index — 原声心念工坊（复刻 B工程 AIStudioView.tsx「自由定制」首期）
 *
 * ── 本期范围（用户分步指令）────────────────────────────────
 * ① 顶部模块：小标题 + 按「底部模块活动标签」联动的标题/描述
 *    （四个 tab 的文案已清洗）；
 * ② 底部模块：四格分段 tab 栏，顺序为
 *    今日挑战 / 跟读接力 / 排行榜 / 自由定制（[2026-11-11] 自由定制由首位
 *    移至第 4 位，默认落新首位「今日挑战」）；
 * ③ 首期仅复刻「自由定制」标签页：想法输入（灵感预设 6 条）+ 难度 A2/B1/B2/C1
 *    四档多选（[2026-11-11] 完全去除 A1/C2，全不选 = 池内不限）+ 生成微场景 + 方案输出（主题卡 / 精选原生切片实训·词级扫光·点词查词·
 *    透视·收藏 / 实战微演练）；后续批次已补齐其余三 tab——今日挑战
 *    （真实录音评测 + daily-coach 选料）、跟读接力（relay-mock）、
 *    排行榜（leaderboard-mock，B getDailyLeaderboard 兜底）。
 *
 * ── 生成管线（意图匹配；文案=B server 兜底模板一字不差）────
 * ① 意图匹配 POST /api/scenes/match {q, levels}：DeepSeek 扩词+多证据排序的
 *    单句切片 ≤4 + 微场景 top-2（micro_scenes 15-45s，clipsJson 自带词级
 *    时间戳 → 句×词两级卡拉OK，音频经 /api/clips/{sceneid}/audio 网关）；
 * ② 无相关语料或网络失败时诚实提示，不降级到无关难度选料或本地语料。
 * plan.sourceLabel 标注来源：意图匹配/关键词匹配（·真实语料）。
 * keyVocabulary：从词级时间戳取 ≥7 字母长词 3 个。
 * 播放/扫光/查词/透视/收藏：与 pages/discover 同款机制（clip-player 窗口
 * 播放 + clipOffset 偏移协议 + /api/dict + /api/clips/deep-dive +
 * /api/sentences/toggle 双源收藏）；切片与微场景共用一个私有播放器实例
 * （_activeKind 分时），互切自动停旧起新。
 *
 * ── 文案清洗对照（B 原文 → 本页）──────────────────────────────
 *   原声心念工坊（去前缀）
 *   (daily) 每日自动剪裁…（去前缀）
 *   (custom) 为你精准切取…（去前缀）
 *   生成微场景；透视（均去前缀）
 *   实战微演练 (Roleplay Challenge)
 *
 * ── 暂缓注记（后续批次）────────────────────────────────────
 * ① 方案生成接 yuanlu LLM 路由（对齐 /api/clips/deep-dive 的 DeepSeek 范式，
 *    替换本地模板合成）；
 * ② 迁移 yuanlu-weapp 时过合规红线门禁（文案已预清洗）。
 * ── 已接真实后端（2026-11-14）──────────────────────────────
 * ⑥ 跟读接力：yuanlu /api/relay/*（真录音→评测→OSS 录音→房间持久化；
 *    语伴=corpus 切片扮演第 2 棒，第 3 棒留给真人接棒；未登录/接口失败回落
 *    relay-mock 演示房）；排行榜：/api/speech/leaderboard 今日 count 榜
 *    扩展装饰 + cheer 幂等点赞（回落 leaderboard-mock）。
 * ── 已补齐（2026-11-12，B 全局仪表卡两模块 → tab 栏上方常驻） ──
 * ④ 「今日学习进度与时段推荐」：连胜横幅（点火/7 日火苗链/里程碑
 *    进度）+ 三指标格：已接 yuanlu studio-dashboard 账号数据；
 *    时段推荐结合到期生词和账号等级，连接真实复习/评测/语料检索；
 * ⑤ 「艾宾浩斯复习清单·温故闪卡」：真实到期生词每轮 4 个，沿用服务端
 *    Leitner 间隔规则；释义/词根来自词典，原声与时间戳来自剧集字幕，
 *    提交成功后自动跳卡并同步仪表卡；不展示模拟留存率或错误次数。
 */
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const { get, post } = require('../../utils/request');
const { createClipPlayer } = require('../../utils/clip-player');
const { sentenceWindow } = require('../../utils/clip-window');
const reelsApi = require('../discover/reels-api');
const coach = require('./daily-coach');
const relayMock = require('./relay-mock');
const lbMock = require('./leaderboard-mock');
const relayApi = require('./relay-api');
const lbApi = require('./leaderboard-api');
const recorder = require('../../utils/recorder');
const smartReview = require('./smart-review');
const shadowing = require('./shadowing');
const dailyChallenge = require('./daily-challenge');
const dashboard = require('./dashboard');

const SAVED_KEY = 'studio_saved_sentences'; // 本地 mock 句子本（真实切片走服务端）

/** 静态兜底（后端不可达时用；启动后会被动态预设覆盖） */
const PRESET_IDEAS = [
  { icon: '💬', text: '日常寒暄闲聊', tag: 'daily_smalltalk' },
  { icon: '☕', text: '餐厅点单用餐', tag: 'dining' },
  { icon: '💼', text: '职场日常沟通', tag: 'workplace' },
  { icon: '🎯', text: '面试自我介绍', tag: 'interview' },
  { icon: '✈️', text: '旅行问路出行', tag: 'travel' },
  { icon: '🏥', text: '看病买药沟通', tag: 'health' },
];

/** 顶部模块：tab → 标题/描述（B header 三元链，文案已清洗；顺序=新 tab 顺序） */
const TAB_META = [
  {
    key: 'daily',
    label: '今日挑战',
    icon: '🔥',
    title: '今日专属原声挑战',
    desc: '基于你近期的生词记录与兴趣领域，每日自动剪裁 5 个阶梯原声切片，跟读即刻评测。',
  },
  {
    key: 'relay',
    label: '跟读接力',
    icon: '📡',
    title: '原声口语跟读接力坊',
    desc: '发起一段原声录音，系统自动邀请志同道合的语伴口语接棒，一键合成多声部趣味合集。',
  },
  {
    key: 'leaderboard',
    label: '排行榜',
    icon: '🏆',
    title: '今日跟读风云榜',
    desc: '实时展示全站今日开口跟读次数最多的学习者，互相鼓掌加油、试听同款代表作。',
  },
  {
    key: 'custom',
    label: '自由定制',
    icon: '🧭',
    title: '输入想法，定制微场景',
    desc: '不再盲听完整节目。为你精准切取真实母语者语境片段，直击你的沟通目标。',
  },
];

/** [2026-11-11] 自由定制选料难度池（A1/C2 产品决策移除；全不选时按池内不限发请求） */
const LEVEL_POOL = ['A2', 'B1', 'B2', 'C1'];

/** 接力真录音上限（秒）：接力句为 4-10s 切片，30s 足够含重录余量 */
const RELAY_MAX_SECONDS = 30;

/** B TIME_SLOTS 五时段推荐（逐字段；icon=时段 emoji，B lucide 图标同位替换） */
const TIME_SLOTS = [
  {
    key: 'morning', icon: '🌅', label: '晨间唤醒', timeRange: '05:00 - 09:59',
    badge: '🌅 晨间开口练习', studyType: '高频原声大声跟读 & 核心生词激活',
    reason: '早间可以从一段短句跟读开始，逐步进入英语学习状态。',
    targetMode: 'daily', suggestedPrompt: '晨间高能自信表达与抗压沟通句式', suggestedLevel: 'B2', actionText: '开启晨间开口跟读',
  },
  {
    key: 'noon', icon: '☕', label: '午间轻听', timeRange: '10:00 - 13:59',
    badge: '☕ 午间碎片轻输入', studyType: '生活场景微课 & 轻快连读磨耳朵',
    reason: '午间适合低认知负荷的趣味场景输入，在放松状态下捕捉母语者的弱读与日常寒暄节奏。',
    targetMode: 'custom', suggestedPrompt: '咖啡厅点单与偶遇朋友的自然日常闲聊', suggestedLevel: 'B1', actionText: '定制午间轻松微课',
  },
  {
    key: 'afternoon', icon: '☀️', label: '下午实战', timeRange: '14:00 - 17:59',
    badge: '☀️ 下午实战表达', studyType: '职场场景表达 & 句式精析',
    reason: '选一段职场场景原声，练习表达观点和回应不同意见。',
    targetMode: 'custom', suggestedPrompt: '商务会议中礼貌反驳对方观点的句式', suggestedLevel: 'C1', actionText: '开启职场思辨特训',
  },
  {
    key: 'evening', icon: '🌆', label: '晚间精练', timeRange: '18:00 - 21:59',
    badge: '🌆 晚间沉浸突破期', studyType: '原声跟读练习 & 四维发音纠音',
    reason: '晚间环境安静专注，适合逐词比对毫秒级卡拉OK时间戳，结合语音评分精细打磨连读音律。',
    targetMode: 'daily', suggestedPrompt: '探讨科技对未来工作与人类社会的影响', suggestedLevel: 'B2', actionText: '冲刺今日跟读挑战',
  },
  {
    key: 'night', icon: '🌙', label: '睡前潜移', timeRange: '22:00 - 04:59',
    badge: '🌙 睡前轻松复盘', studyType: '温暖叙事慢速精听 & 生词金句复盘',
    reason: '用一段温暖的故事原声和生词回顾结束今天的学习。',
    targetMode: 'custom', suggestedPrompt: '治愈系人生故事与温暖共情表达', suggestedLevel: 'B1', actionText: '定制睡前原声片段',
  },
];

/** B server 兜底文案模板（一字不差，仅 goal/level 插值） */
const PLAN_TEMPLATES = {
  culturalNuance: '母语者在真实对话中更倾向于使用生动的动词短语与微妙的抑扬顿挫，而非书面大词。',
  roleplayPrompt: '请聆听以上母语者音频，模仿其语调与停顿，完成一次 15 秒的跟读录音挑战！',
  vocabMeaning: '高频场景表达',
  vocabRootTip: '结合语境多加原声跟读，建立直接音义联结。',
};

/** B server 无 LLM key 时的场景导读模板（一字不差） */
function overviewTemplate(goal) {
  return '针对你提出的 "' + goal + '"，我们从原声切片语料库中提取了母语者最自然生动的语篇切片，带你跳出机械背诵，从真实语调、连读弱读中培养地道语感。';
}

const VOCAB_STOPWORDS = {
  because: 1, through: 1, throughout: 1, between: 1, without: 1, another: 1,
  however: 1, already: 1, recently: 1, thinking: 1, looking: 1, working: 1,
  getting: 1, talking: 1, walking: 1, feeling: 1, nothing: 1, something: 1,
  anything: 1, everything: 1, someone: 1, everyone: 1,任何人: 1, yourself: 1,
  themselves: 1, himself: 1, herself: 1, ourselves: 1, whether: 1, against: 1,
  towards: 1, around: 1, before: 1, during: 1, should: 1, altijd: 1,
  actually: 1, really: 1, always: 1, usually: 1, probably: 1, especially: 1,
  interesting: 1, important: 1, different: 1, Together: 1, together: 1,
  believed: 1, started: 1, wanted: 1, decided: 1, happened: 1,
};

function cleanDisplayText(text) {
  return String(text || '')
    .replace(/^\s*(?:\[SPEAKER_\d+\]|SPEAKER_\d+\s*:)\s*/gi, '')
    .replace(/\s*\[SPEAKER_\d+\]\s*/gi, ' ')
    .trim();
}

/** 真实切片 keyVocabulary：优先放入命中的用户生词，再从词级时间戳取非停用词 ≥7 字母实词补足 3 个 */
function pickVocabFromWords(words, priorityWords) {
  const seen = {};
  const out = [];
  const prio = Array.isArray(priorityWords) ? priorityWords : [];
  for (let i = 0; i < prio.length && out.length < 3; i++) {
    const w = String(prio[i] || '').replace(/[^A-Za-z-]/g, '');
    const key = w.toLowerCase();
    if (w.length >= 4 && !seen[key]) {
      seen[key] = true;
      out.push({
        word: w,
        matched: true,
        pos: '生词本',
        meaning: '你的待复习生词',
        rootTip: PLAN_TEMPLATES.vocabRootTip,
      });
    }
  }
  for (let i = 0; i < words.length && out.length < 3; i++) {
    const w = String((words[i] || {}).word || '').replace(/[^A-Za-z-]/g, '');
    const key = w.toLowerCase();
    if (w.length >= 7 && !VOCAB_STOPWORDS[key] && !seen[key]) {
      seen[key] = true;
      out.push({
        word: w,
        matched: false,
        pos: 'v./n.',
        meaning: PLAN_TEMPLATES.vocabMeaning,
        rootTip: PLAN_TEMPLATES.vocabRootTip,
      });
    }
  }
  return out;
}

/** 深析兜底（B server 无 key 降级文案，一字不差） */
const DEEP_FALLBACK = {
  connectedSpeech: '辅音结尾与元音开头发生顺滑连读，介词与弱读代词轻读降调。',
  toneAndMood: '自信、从容且具有说服力的交际语调，常见于访谈节目与商务交流。',
  paraphrase: '可替换为更加通俗的日常口语表述，或更加严谨的书面用词。',
  speakingTip: '注意喉头放松，腹式呼吸送气，重点实词重读，虚词快速带过。',
};

Page({
  ...dashboard.methods,
  ...smartReview.methods,
  ...shadowing.methods,
  ...dailyChallenge.methods,
  data: {
    themeClass: '',
    dark: false,

    tabs: TAB_META,
    activeTab: 'daily', // [2026-11-11] 自由定制移至第 4 位，默认落新首位「今日挑战」
    header: TAB_META[0], // 顶部模块联动（标题/描述）
    presetIdeas: PRESET_IDEAS,

    // ── 今日学习进度与时段推荐（B 全局仪表卡；tab 栏上方常驻） ──
    timeSlots: TIME_SLOTS,
    selectedTimeSlot: 'morning', // 选中时段（onLoad 按当前钟点初始化）
    currentTimeSlot: 'morning', // 当前所处时段
    activeTimeRec: TIME_SLOTS[0], // 选中时段的推荐内容（WXML 无法 find，选时同步派生）
    currentTimeLabel: '',
    ...dashboard.emptyData(),
    streakCelebrating: false,

    // ── 真实生词复习队列 ──
    ...smartReview.emptyData(),

    // ── 自由定制 ──
    inputIdea: '',
    // 四档难度多选（[2026-11-11] 完全去除 A1/C2——选项不展示、选料不过池；
    // 全部取消 = 池内不限，见 generate() 的 LEVEL_POOL 兜底）
    levelOptions: ['A2', 'B1', 'B2', 'C1'].map((v) => ({
      v,
      on: true,
    })),
    isGenerating: false,
    presetRefreshing: false, // 灵感预设刷新中（刷新按钮转圈）
    noMatch: false, // [UX] 意图检索语义不相关 → 诚实提示，不降级
    searchError: false, // [铁律 7] 检索服务不可达/超时 → 诚实错误，不造假结果
    plan: null, // { themeTitle, scenarioOverview, culturalNuance, roleplayPrompt, source, clips[] }

    // ── 今日挑战 ──
    daily: null, // { date, clips[5], completedCount, averageScore, allCompleted, userHistorySummary, source }
    dailyLoading: true,
    dailyError: '',
    refreshingDaily: false,
    dailyActiveIdx: -1, // daily.clips 下标（与 activeIdx/sceneActiveIdx 三源互斥）
    dailyLoadingIdx: -1,
    ...shadowing.emptyData(),

    // ── 跟读接力（B relay tab；房间=relay-mock 内存态） ──
    relayRooms: [],
    relayLoading: true,
    recruitingCount: 0,
    showCreateRelay: false,
    newRelayTitle: '',
    selectedRelayClipId: '',
    relayRecording: '', // 'create' | roomId —— 录音中（真录音链，relayCountdown=已录秒数）
    relayCountdown: 0,
    relaySubmitting: false, // 录音已停、评测+建房/接棒提交中
    playingRoomId: '', // 合集连播中的房间
    playingStep: 0, // 连播当前棒（1 基）
    relayActiveSegId: '', // 单棒试听中的段 id
    relayWordIdx: -1, // 单棒试听词级扫光

    // ── 排行榜（B leaderboard tab；数据=leaderboard-mock 本地态） ──
    leaderboard: null, // { date, totalParticipants, entries[], myEntry, nextTargetDiff, nextTargetName }
    lbRefreshing: false, // 榜单重算中（刷新按钮转圈）
    lbCheeringId: '', // 点赞缩放动画中的条目 id（400ms）

    // ── 切片播放（clip/scene/daily/relay 分时复用同一私有播放器） ──
    activeIdx: -1, // plan.clips 下标（custom 卡）
    playing: false,
    isLooping: false, // [2026-11-15] 听原声默认单次播放（句末循环钮可手动开；时段冲刺/挑战同款仍按需置 true）
    activeWordIndex: -1,
    loadingClipIdx: -1, // 懒取直链中的卡片（播放键转 spinner）

    // ── 微场景（top-2 连续语境 · 句×词两级卡拉OK + 句级循环/透视/收藏） ──
    sceneActiveIdx: -1, // plan.scenes 下标（与 activeIdx/dailyActiveIdx 互斥）
    sceneLoadingIdx: -1, // 懒取场景音频中的卡（整段或句级共用）
    sceneSentLoop: -1, // 句级循环中的句下标（活动场景内；-1=整段连播模式）
    sceneWordIdx: -1, // 场景内全局词序（跨句连续扫光）
    sceneActiveSent: -1, // 当前朗读句

    // ── 深析 bottom-sheet ──
    deepOpen: false,
    deepLoading: false,
    deepAnalysis: null,
    deepSentence: '',
    deepSource: '',

    // ── 生词弹窗 ──
    wordModal: {
      visible: false,
      word: '',
      episodeTitle: '',
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
    this._rate = 1;
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._prepToken = 0;
    this._audioMeta = null; // {url, offset, winStart, winEnd}
    this._activeKind = 'clip'; // 'clip' | 'scene' | 'daily' | 'relay'（同一私有播放器分时复用）
    this._lastSceneWord = -99;
    this._lastSceneSent = -99;
    this._wordCtx = null; // 查词/收藏上下文（切片词/场景词共用）
    this._relayRecTimer = null; // 接力录音 3s 倒计时（create/join 共用）
    this._batonTimer = null; // 合集连播 5.2s 接力棒
    this._relaySeg = null; // 单棒播放上下文 {id, words, offset, winEnd}
    this._vocabSet = {};
    this._saved = this._loadSaved();
    this._savedSub = {}; // 'episodeid:subtitleId' → true
    this._savedKeysByEp = {};
    this._savingBusy = false;

    this._player = createClipPlayer({
      // 循环重放 stop→重建的瞬时闪烁，120ms 去抖（discover 同款）
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

    this._initShadowing();
    this._initDailyChallenge();
    this._syncTheme();
    this._fetchVocabSet();
    this._loadDaily(false);
    this._loadRelayRooms();
    this._loadPresetIdeas(); // [需求一] 启动时动态生成灵感预设

    this._initDashboard();
    this._initSmartReview();
  },

  onShow() {
    this._syncShadowIdentity();
    this._loadDaily(false);
    this._syncTheme();
    this._tickDashboardClock();
    this._loadDashboard(); // 从真实复习/评测/收藏页面返回时同步
    this._loadSmartReview();
    if (!this._clockTimer) this._clockTimer = setInterval(() => this._tickDashboardClock(), 30000);
  },

  /** 下拉刷新：全模块真实数据一次拉齐（今日挑战走当日缓存口径保进度） */
  async onPullDownRefresh() {
    this._pausePlayback();
    this._stopCompilation();
    await Promise.all([
      this._loadDaily(false),
      this._loadDashboard(true),
      this._loadRelayRooms(),
      this._loadLeaderboard(),
      this._loadSmartReview(true),
    ]).catch(() => { /* 单模块失败不阻塞收起刷新动画 */ });
    wx.stopPullDownRefresh();
  },

  onHide() {
    this._cancelShadowing();
    if (this._clockTimer) clearInterval(this._clockTimer);
    this._clockTimer = null;
    this._pausePlayback();
    this._stopCompilation();
  },

  onUnload() {
    this._disposeShadowing();
    this._disposeDailyChallenge();
    this._disposeDashboard();
    this._disposeSmartReview();
    this._player.stop();
    if (this._playingFalseTimer) clearTimeout(this._playingFalseTimer);
    if (this._relayRecTimer) clearInterval(this._relayRecTimer);
    this._cancelRelayRecording();
    if (this._batonTimer) clearTimeout(this._batonTimer);
    if (this._clockTimer) clearInterval(this._clockTimer);
    if (this._cheerTimer) clearTimeout(this._cheerTimer);
    if (this._streakPopTimer) clearTimeout(this._streakPopTimer);
    if (this._streakCheerTimer) clearTimeout(this._streakCheerTimer);
  },

  _syncTheme() {
    this.setData({
      themeClass: theme.rootClass(),
      dark: theme.getEffective() === 'dark',
    });
    theme.applyChrome();
  },

  /* ---------------- 今日学习进度与时段推荐（B 全局仪表卡） ---------------- */

  /** 连胜派生字段（B milestone/badge/progress 计算逐字） */
  /** 连胜派生（B 参照口径）：里程碑 <14→14 / <21→21 / 否则恒 30；
   *  段位 ≥21👑 / ≥14🌟 / >0🔥 / 0🌱。7 日火苗链不再本地派生——由
   *  /api/streak week 供给真实最近 7 天（真星期标签+真实点亮态）。 */
  _syncStreakDerived() {
    const days = this.data.streakDays;
    const milestone = days < 14 ? 14 : days < 21 ? 21 : 30;
    this.setData({
      streakMilestone: milestone,
      streakRemain: Math.max(0, milestone - days),
      streakProgress: Math.min(100, Math.round((days / milestone) * 100)),
      streakBadge:
        days >= 21 ? '👑 三周传奇语感大师' : days >= 14 ? '🌟 双周不辍领航者' : days > 0 ? '🔥 坚韧原声破壁者' : '🌱 从今天开始积累',
    });
  },

  /** 点亮今日连胜（手动通道）：当日幂等由服务端唯一约束权威判重。 */
  onStreakTap() {
    if (this.data.dashboardStatus !== 'ready') return this.onDashboardRetry();
    if (this.data.streakSubmitting) return;
    if (!this._shadowToken()) return this._promptLogin('登录后点亮今日连胜');
    this.setData({ streakSubmitting: true });
    post('/api/streak/ignite', {}, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) {
          throw new Error((body && body.error) || '点亮失败，请重试');
        }
        this._applyStreakData(body.data);
        if (body.data.justIgnited) this._streakCelebrate(false);
        else this._streakCheer('✨ 连胜能量满格！你已坚持连续 ' + body.data.streakDays + ' 天原声输入，保持这份热忱！');
      })
      .catch((err) => wx.showToast({ title: err.message || '点亮失败，请重试', icon: 'none' }))
      .then(() => this.setData({ streakSubmitting: false }));
  },

  /** 服务端连胜状态回填（ignite/GET 共用；week 真实 7 日链一并刷新） */
  _applyStreakData(d) {
    this.setData({
      streakDays: d.streakDays || 0,
      streakIgnited: !!d.ignitedToday,
      streakPercentile: d.percentile || 0,
      streakWeek: Array.isArray(d.week) && d.week.length === 7 ? d.week : this.data.streakWeek,
    });
    this._syncStreakDerived();
  },

  /** 跟读开口自动验收（SPEECH 通道）：评测成功后携 recognitionId 点灯，
   *  失败静默（不影响评测主流程）；今日已点亮则不重复涨天（服务端幂等）。 */
  _igniteStreakBySpeech(recognitionId) {
    if (!this._shadowToken() || !recognitionId) return;
    post('/api/streak/ignite', { recognitionId }, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        this._applyStreakData(body.data);
        if (body.data.justIgnited) this._streakCelebrate(true);
      })
      .catch(() => { /* 点灯失败不打扰评测结果 */ });
  },

  /** Q弹 750ms + 金色横幅 4s（B handleTriggerStreakCelebration 同款） */
  _streakCelebrate(fromShadowing) {
    this.setData({ streakCelebrating: true });
    if (this._streakPopTimer) clearTimeout(this._streakPopTimer);
    this._streakPopTimer = setTimeout(() => {
      this._streakPopTimer = null;
      this.setData({ streakCelebrating: false });
    }, 750);
    this._streakCheer(fromShadowing
      ? '🎉 开口跟读打卡成功！连续学习突破 ' + this.data.streakDays + ' 天，击败全站 ' + this.data.streakPercentile + '% 学习者！'
      : '🔥 今日连胜火苗已点亮！连续学习达 ' + this.data.streakDays + ' 天，离 14 天荣耀徽章更近一步！');
  },

  _streakCheer(text) {
    this.setData({ streakCheerText: text });
    if (this._streakCheerTimer) clearTimeout(this._streakCheerTimer);
    this._streakCheerTimer = setTimeout(() => {
      this._streakCheerTimer = null;
      if (this.data.streakCheerText) this.setData({ streakCheerText: '' });
    }, 4000);
  },

  // 沙箱挑战/排行榜/闪卡的本地变化不能覆盖服务端指标。
  _syncMetrics() {},

  /** 时段 pill 点选 */
  onSlotTap(e) {
    const key = e.currentTarget.dataset.key;
    const rec = this.data.timeSlots.find((t) => t.key === key);
    this._manualTimeSlot = true;
    if (rec) this.setData({ selectedTimeSlot: key, activeTimeRec: rec });
  },

  /**
   * 一键应用：到期生词进入真实复习；跟读进入真实评测；其余检索时段语料。
   */
  onApplyTimeRec() {
    if (this._shadowBusy()) return;
    const rec = this.data.activeTimeRec;
    if (!rec) return;
    if (rec.targetMode === 'review') return this.onMetricVocabulary();
    if (rec.targetMode === 'daily') {
      // B handleApplyTimeRecommendation 同款：切「今日挑战」tab 并循环播放
      // 第一条未完成切片（不再跳转语音评测全屏页）
      const clips = (this.data.daily && this.data.daily.clips) || [];
      const idx = clips.findIndex((c) => c.real && !c.completed);
      const fallback = clips.findIndex((c) => c.real);
      const target = idx >= 0 ? idx : fallback;
      this._pausePlayback();
      this._stopCompilation();
      this.setData({
        activeTab: 'daily',
        header: TAB_META.find((t) => t.key === 'daily'),
        isLooping: true, // B playClip(nextClip, { loop: true })
      });
      this._scrollAnchorToTop('#stTabsRow');
      if (target >= 0) {
        this._applyDailyClip(target);
        return;
      }
      // 尚无真实挑战素材时，按时段意图检索真实语料，不播放本地示例。
    }
    this.setData({
      activeTab: 'custom',
      header: TAB_META.find((t) => t.key === 'custom'),
      inputIdea: rec.suggestedPrompt,
      levelOptions: this.data.levelOptions.map((o) => ({
        v: o.v,
        on: o.v === rec.suggestedLevel,
      })),
    });
    this._scrollAnchorToTop('#stTabsRow');
    this.generate(rec.suggestedPrompt);
  },

  /**
   * 锚点置顶滚动（pageScrollTo selector 模式）。offsetTop 实测语义：
   * **再向下多滚 offsetTop 像素**——正值越大目标元素越被顶入吸顶区下方
   * （12→48 遮得更多的实证）；要元素顶停在吸顶内容之下留呼吸间隙，
   * 须取负值：元素顶距视口顶 = −offsetTop（−36 实测档位：露出完整且不空旷）。
   * tab 面板为 wx:if 异步渲染，延迟一拍再定位。
   */
  _scrollAnchorToTop(selector) {
    setTimeout(() => {
      wx.pageScrollTo({ selector, offsetTop: -36, duration: 320, fail: () => {} });
    }, 80);
  },

  /** 三指标入口均指向已接真实后端的功能。 */
  onMetricRank() {
    if (!authStore.getState().isLoggedIn) return this._promptLogin('登录后查看今日跟读榜');
    // [2026-11-14] 用户口径：不再跳全屏「发音达人榜」页，改切主页排行榜 tab
    this._pausePlayback();
    this.setData({
      activeTab: 'leaderboard',
      header: TAB_META.find((t) => t.key === 'leaderboard'),
    });
    this._scrollAnchorToTop('#stTabsRow');
  },

  onMetricVocabulary() {
    if (!authStore.getState().isLoggedIn) return this._promptLogin('登录后先复习生词');
    // [2026-11-13] 用户口径：点击改为切换闪卡清单展开/收起（不再跳全屏复习窗口）
    this._pausePlayback();
    const open = !this.data.reviewDeckOpen;
    this.setData({ reviewDeckOpen: open });
    if (open) this._scrollAnchorToTop('#stReviewDeck');
  },

  onMetricSentences() {
    if (!authStore.getState().isLoggedIn) return this._promptLogin('登录后查看金句库');
    this._pausePlayback();
    // 生产仓复习页约定：switchTab 不能带参，经 storage 传递（1=发音本/金句库）
    try { wx.setStorageSync('review:pendingTab', 1); } catch (e) { /* 跳默认 tab */ }
    wx.switchTab({ url: '/pages/review/index' });
  },

  /* ---------------- 底部模块：四格 tab（顺序重排版） ---------------- */

  /* ---------------- [需求一] 动态灵感预设 ---------------- */

  /** 启动/刷新：从后端拉语料实况生成的 6 条灵感（失败静默保留当前值） */
  async _loadPresetIdeas() {
    try {
      const ideas = await reelsApi.fetchPresetIdeas();
      if (ideas && ideas.length >= 3) {
        this.setData({ presetIdeas: ideas });
      }
    } catch (e) {
      /* 网络失败保留静态兜底 */
    }
  },

  /** 刷新按钮 → 重新拉取（转圈反馈） */
  async onRefreshPresets() {
    if (this.data.presetRefreshing) return;
    this.setData({ presetRefreshing: true });
    await this._loadPresetIdeas();
    this.setData({ presetRefreshing: false });
  },

  onTabTap(e) {
    if (this._shadowBusy()) {
      wx.showToast({ title: '请先停止录音或等待评测完成', icon: 'none' });
      return;
    }
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.activeTab) return;
    const meta = TAB_META.find((t) => t.key === key);
    // 切走自定义页时停窗口播放（占位 tab 无音频语境）
    this._pausePlayback();
    this.setData({ activeTab: key, header: meta });
  },

  /* ---------------- 自由定制：输入与生成 ---------------- */

  onIdeaInput(e) {
    this.setData({ inputIdea: e.detail.value });
  },

  /** 难度多选翻转（全不选 = 池内不限——生成时按 LEVEL_POOL 兜底，A1/C2 恒不入池） */
  onLevelTap(e) {
    const lvl = e.currentTarget.dataset.level;
    const i = this.data.levelOptions.findIndex((o) => o.v === lvl);
    if (i < 0) return;
    this.setData({ ['levelOptions[' + i + '].on']: !this.data.levelOptions[i].on });
  },

  /** 已选难度（逗号串给 feed 的 level 多选参数；空 = 不限） */
  _selectedLevels() {
    return this.data.levelOptions.filter((o) => o.on).map((o) => o.v);
  },

  onPresetTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    // [BUG 2026-11-11] 必须读动态 presetIdeas——此前误读静态 PRESET_IDEAS，
    // 导致动态预设（新闻时事讨论…）点击后按静态同名下标（日常寒暄闲聊…）搜索
    const idea = this.data.presetIdeas[idx];
    if (!idea) return;
    this.setData({ inputIdea: idea.text });
    this.generate(idea.text);
  },

  onGenerate() {
    this.generate();
  },

  /**
   * 生成微场景（B handleGenerate 升级版）：
   * ① 意图匹配（POST /api/scenes/match：DeepSeek 扩词 + 多证据排序的单句切片
   *    ≤4 条 + 微场景 top-2 15-45s 连续语境，次场优先不同 episodeid）；
   * ② 语义无匹配或网络异常时诚实提示，不回落无关语料。
   * 文案始终走 B 兜底模板（goal 插值）；plan.sourceLabel 标注选料来源。
   */
  async generate(queryText) {
    const goal = (queryText || this.data.inputIdea || '').trim();
    if (!goal || this.data.isGenerating) return;

    this.setData({ isGenerating: true, noMatch: false, searchError: false });
    // [2026-11-11] 全不选 = 池内不限（按四档池发请求），A1/C2 完全不进选料
    const picked = this._selectedLevels();
    const levels = picked.length ? picked : LEVEL_POOL;

    let clips = null;
    let scenes = []; // [2026-11-11] top-2 微场景（原单 scene 升级）
    let source = 'local';
    let matchKind = '';
    try {
      const m = await reelsApi.matchStudio(goal, levels);
      if (m && m.noMatch) {
        // [UX 2026-11-09] 后端语义快裁判「无相关语料」——诚实提示并终止，
        // 绝不降级到不相关的难度选料/本地语料（宁空勿歪）；仅网络失败才回落
        this._pausePlayback();
        this._prepToken += 1;
        this._audioMeta = null;
        this.setData({
          isGenerating: false,
          noMatch: true,
          plan: null,
          activeIdx: -1,
          activeWordIndex: -1,
          sceneActiveIdx: -1,
          sceneLoadingIdx: -1,
          sceneSentLoop: -1,
          sceneWordIdx: -1,
          sceneActiveSent: -1,
        });
        return;
      }
      if (m && (m.clips.length || (m.scenes && m.scenes.length))) {
        matchKind = m.source;
        if (m.clips.length) clips = m.clips.slice(0, 4);
        // [2026-11-11] 后端 top-2 场景（次场优先不同 episodeid 保语境多样）
        scenes = (m.scenes || []).slice(0, 2).map((s) => this._mapScene(s));
        source = 'match';
      }
    } catch (e) {
      /* [铁律 7·2026-11-09] 网络失败/超时 → 诚实错误提示。
         原「难度选料 feed → 本地 mock」降级链已摘除——那正是
         「看起来有结果但语义全不相关」的假结果来源（宁空勿歪）。
         注：本地语料仅供微流页浏览兜底（头部亮「沙箱语料」徽章），
         意图检索路径不再使用。 */
      this._pausePlayback();
      this._prepToken += 1;
      this._audioMeta = null;
      this.setData({
        isGenerating: false,
        searchError: true,
        plan: null,
        activeIdx: -1,
        activeWordIndex: -1,
        sceneActiveIdx: -1,
        sceneLoadingIdx: -1,
        sceneSentLoop: -1,
        sceneWordIdx: -1,
        sceneActiveSent: -1,
      });
      return;
    }
    if (!clips || !clips.length) {
      // match 返回成功但零切片且未标 noMatch（理论边角）——按无相关语料处理
      this.setData({ isGenerating: false, noMatch: true, plan: null });
      return;
    }

    const planClips = clips.map((c, i) => ({
      idx: i,
      id: c.id,
      textEn: c.textEn,
      textCn: c.textCn,
      phoneticSecret: c.phoneticTip || '',
      words: c.words || [],
      showTitle: c.showTitle,
      keyVocabulary: source === 'local' && c.keywords
        ? c.keywords.map((k) => ({
            word: k,
            pos: 'v./n.',
            meaning: PLAN_TEMPLATES.vocabMeaning,
            rootTip: PLAN_TEMPLATES.vocabRootTip,
          }))
        : pickVocabFromWords(c.words || []),
      real: !!c.real,
      episodeid: c.episodeid || '',
      subtitleId: c.subtitleId != null ? c.subtitleId : null,
      start: c.start,
      end: c.end,
      duration: c.duration,
      clipAudioUrl: c.clipAudioUrl || null,
      clipOffset: c.audioOffset || 0,
      saved: this._isClipSaved(c),
    }));

    // 换方案：停旧播放并重置
    this._pausePlayback();
    this._prepToken += 1;
    this._audioMeta = null;
    this._lastWordIdx = -99;

    this.setData({
      isGenerating: false,
      plan: {
        themeTitle: '「' + goal.slice(0, 16) + '」原声穿透训练',
        scenarioOverview: overviewTemplate(goal),
        culturalNuance: PLAN_TEMPLATES.culturalNuance,
        roleplayPrompt: PLAN_TEMPLATES.roleplayPrompt,
        source,
        sourceLabel:
          source === 'match'
            ? matchKind === 'llm'
              ? '意图匹配 · 真实语料'
              : '关键词匹配 · 真实语料'
            : source === 'feed'
              ? '难度选料 · 真实语料'
              : '沙箱语料',
        clips: planClips,
        scenes,
      },
      activeIdx: -1,
      activeWordIndex: -1,
      playing: false,
      sceneActiveIdx: -1,
      sceneLoadingIdx: -1,
      sceneSentLoop: -1,
      sceneWordIdx: -1,
      sceneActiveSent: -1,
    });

    this._backfillSavedKeys(planClips);
    // 场景句收藏态回填（真实 subtitleId 按集拉 keys）
    scenes.forEach((sc, sci) => {
      if (sc.episodeid && sc.sentences.some((x) => x.subtitleId != null)) {
        this._fetchSceneSavedKeys(sc.episodeid, sci);
      }
    });
  },

  /** 生成后书签态回填（真实条按集拉 keys，最多 4 集） */
  _backfillSavedKeys(clips) {
    if (!authStore.getState().isLoggedIn) return;
    const eps = [...new Set(clips.filter((c) => c.real && c.episodeid).map((c) => c.episodeid))];
    eps.forEach((ep) => this._fetchSavedKeys(ep, clips));
  },

  /** prefix: 'plan.clips'（默认）或 'daily.clips'——书签态回填双源共用 */
  _fetchSavedKeys(episodeid, clips, prefix) {
    const pfx = prefix || 'plan.clips';
    if (this._savedKeysByEp[episodeid]) {
      this._applySavedKeys(episodeid, this._savedKeysByEp[episodeid], clips, pfx);
      return;
    }
    get('/api/sentences/keys?episodeid=' + encodeURIComponent(episodeid), null, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        const ids = {};
        ((body.data.subtitleIds || []) || []).forEach((id) => {
          ids[episodeid + ':' + id] = true;
        });
        this._savedKeysByEp[episodeid] = ids;
        const list =
          clips ||
          (pfx === 'daily.clips'
            ? this.data.daily && this.data.daily.clips
            : this.data.plan && this.data.plan.clips);
        this._applySavedKeys(episodeid, ids, list, pfx);
      })
      .catch(() => {});
  },

  _applySavedKeys(episodeid, ids, clips, prefix) {
    if (!Array.isArray(clips)) return;
    const pfx = prefix || 'plan.clips';
    const patch = {};
    clips.forEach((c, i) => {
      if (c.episodeid !== episodeid || c.subtitleId == null) return;
      const hit = !!ids[episodeid + ':' + c.subtitleId];
      if (!!hit !== !!c.saved) patch[pfx + '[' + i + '].saved'] = hit;
    });
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 场景句收藏态回填（scenes[sci].sentences[si].saved；与 _fetchSavedKeys 同源缓存） */
  _fetchSceneSavedKeys(episodeid, sci) {
    const apply = (ids) => {
      const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[sci];
      if (!sc) return;
      const patch = {};
      sc.sentences.forEach((sent, si) => {
        if (sent.subtitleId == null) return;
        const hit = !!ids[episodeid + ':' + sent.subtitleId];
        if (!!hit !== !!sent.saved) {
          patch['plan.scenes[' + sci + '].sentences[' + si + '].saved'] = hit;
        }
      });
      if (Object.keys(patch).length) this.setData(patch);
    };
    if (this._savedKeysByEp[episodeid]) {
      apply(this._savedKeysByEp[episodeid]);
      return;
    }
    get('/api/sentences/keys?episodeid=' + encodeURIComponent(episodeid), null, { showError: false })
      .then((body) => {
        if (!body || !body.success || !body.data) return;
        const ids = {};
        ((body.data.subtitleIds || []) || []).forEach((id) => {
          ids[episodeid + ':' + id] = true;
        });
        this._savedKeysByEp[episodeid] = ids;
        apply(ids);
      })
      .catch(() => {});
  },

  /* ---------------- 微场景（连续语境 · 句×词两级卡拉OK） ---------------- */

  /** 后端 scene → 视图模型（词打全局序 gi，跨句连续扫光；句带 subtitleId 收藏键） */
  _mapScene(s) {
    let g = 0;
    const sentences = (s.sentences || []).map((x) => {
      const words = ((x.words || []).map((w) => Object.assign({}, w, { gi: g++ })));
      return {
        textEn: x.textEn,
        textCn: x.textCn || '',
        subtitleId: x.subtitleId != null ? x.subtitleId : null,
        start: x.start,
        end: x.end,
        saved: false,
        words,
      };
    });
    return {
      id: s.sceneid,
      episodeid: s.episodeid || '',
      title: s.title || '',
      summaryZh: s.summaryZh || '',
      tag: s.situationTag || '',
      cefr: s.cefrLevel || '',
      duration: s.duration || 0,
      sentences,
      totalWords: g,
    };
  },

  /**
   * 场景整段连播键（多卡版）：本卡整段活动中 → 暂停/续播；否则起播该卡整段
   * （懒取 sceneid 网关切片；若正在句级循环则切回整段模式）。
   */
  onScenePlay(e) {
    const sci = Number(e.currentTarget.dataset.sci);
    const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[sci];
    if (!sc) return;
    if (
      this._activeKind === 'scene' &&
      this.data.sceneActiveIdx === sci &&
      this.data.sceneSentLoop < 0
    ) {
      if (this.data.playing) {
        this._pausePlayback();
      } else {
        this._startPlayback(this._atEnd ? 0 : this._relPos);
      }
      return;
    }
    this._startSceneWhole(sci);
  },

  /** 整段模式起播（词扫光跨句连续；句级循环态清零） */
  _startSceneWhole(sci) {
    this._pausePlayback();
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastSceneWord = -99;
    this._lastSceneSent = -99;
    this._prepToken += 1;
    this._audioMeta = null;
    this._activeKind = 'scene';
    this.setData({
      sceneActiveIdx: sci,
      sceneSentLoop: -1,
      sceneLoadingIdx: sci,
      activeIdx: -1,
      dailyActiveIdx: -1,
      activeWordIndex: -1,
      sceneWordIdx: -1,
      sceneActiveSent: -1,
    });
    this._startPlayback(0);
  },

  /**
   * 句级原声循环（场景卡内每句右侧按钮）：把场景物理切片的播放窗口收窄到
   * [句.start-offset, 句.end-offset]（临时 _audioMeta 窗口），暂停/续播/循环
   * 全部复用 clip-player 既有窗口机制；词级扫光沿用场景 gi（仅该句点亮）。
   */
  onSceneSentLoop(e) {
    const ds = e.currentTarget.dataset;
    const sci = Number(ds.sci);
    const si = Number(ds.si);
    const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[sci];
    const sent = sc && sc.sentences[si];
    if (!sc || !sent) return;
    // 该句已在循环中 → 暂停/续播
    if (
      this._activeKind === 'scene' &&
      this.data.sceneActiveIdx === sci &&
      this.data.sceneSentLoop === si
    ) {
      if (this.data.playing) {
        this._pausePlayback();
      } else {
        this._startPlayback(this._atEnd ? 0 : this._relPos);
      }
      return;
    }
    this._pausePlayback();
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastSceneWord = -99;
    this._lastSceneSent = -99;
    this._prepToken += 1;
    this._audioMeta = null;
    this._activeKind = 'scene';
    this.setData({
      sceneActiveIdx: sci,
      sceneSentLoop: si,
      sceneLoadingIdx: sci,
      sceneActiveSent: si,
      activeIdx: -1,
      dailyActiveIdx: -1,
      activeWordIndex: -1,
      sceneWordIdx: -1,
    });
    const token = this._prepToken;
    this._prepareSceneAudio(sc)
      .then((meta) => {
        if (token !== this._prepToken) return;
        const off = meta.offset;
        const winStart = Math.max(0, sent.start - off);
        const winEnd = Math.min(meta.winEnd, Math.max(winStart + 0.3, sent.end - off));
        this._audioMeta = Object.assign({}, meta, { winStart, winEnd });
        this.setData({ sceneLoadingIdx: -1 });
        this._playWindow(this._audioMeta, 0);
      })
      .catch((err) => {
        if (token !== this._prepToken) return;
        this.setData({ sceneLoadingIdx: -1 });
        if (err && err.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        wx.showToast({ title: '切片加载失败，稍后再试', icon: 'none' });
      });
  },

  /** 场景音频懒取：/api/clips/{sceneid}/audio（15-45s 物理切片，同款协议） */
  _prepareSceneAudio(sc) {
    return reelsApi.fetchClipAudio(sc.id).then((r) => {
      if (r && r.exclusive) {
        const err = new Error('PREMIUM_REQUIRED');
        err.exclusive = true;
        throw err;
      }
      if (!r || !r.url) throw new Error('audio unavailable');
      return {
        url: r.url,
        offset: r.clipOffset,
        winStart: 0,
        winEnd: r.duration || sc.duration + 1,
      };
    });
  },

  /** 场景句词点击查词（上下文=所在句，收藏带场景 episodeid） */
  onSceneWordTap(e) {
    const ds = e.currentTarget.dataset;
    const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[Number(ds.sci)];
    const sent = sc && sc.sentences[Number(ds.si)];
    if (!sent) return;
    const w = sent.words[Number(ds.wi)];
    const raw = (w && w.word) || sent.textEn;
    const clean = String(raw).replace(/^[^\w]+|[^\w]+$/g, '');
    if (!clean) return;
    this._wordCtx = {
      episodeid: sc.episodeid || '',
      title: sc.title,
      textEn: sent.textEn,
      textCn: sent.textCn,
      start: (w && w.start) || sent.start,
    };
    this._openWordModal(clean);
  },

  /** 场景句透视（与切片卡 onClipDeepDive 同构，句子=场景句） */
  onSceneDeepDive(e) {
    const ds = e.currentTarget.dataset;
    const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[Number(ds.sci)];
    const sent = sc && sc.sentences[Number(ds.si)];
    if (!sent) return;
    this.setData({
      deepOpen: true,
      deepLoading: true,
      deepAnalysis: null,
      deepSentence: sent.textEn,
      deepSource: '',
    });
    reelsApi
      .fetchDeepDive(sent.textEn)
      .then((a) => {
        this.setData({
          deepLoading: false,
          deepAnalysis: a || DEEP_FALLBACK,
          deepSource: a ? a.source : 'fallback',
        });
      })
      .catch(() => {
        this.setData({ deepLoading: false, deepAnalysis: DEEP_FALLBACK, deepSource: 'fallback' });
      });
  },

  /** 场景句收藏（真实 subtitleId 走服务端 toggle；缺失键时本地兜底） */
  onSceneSentBookmark(e) {
    const ds = e.currentTarget.dataset;
    const sci = Number(ds.sci);
    const si = Number(ds.si);
    const sc = this.data.plan && this.data.plan.scenes && this.data.plan.scenes[sci];
    const sent = sc && sc.sentences[si];
    if (!sent) return;
    const path = 'plan.scenes[' + sci + '].sentences[' + si + '].saved';
    if (sc.episodeid && sent.subtitleId != null) {
      // 复用 daily 双源真实 toggle（entry 需 episodeid/subtitleId/start/end 同构）
      this._toggleDailyReal(Object.assign({}, sent, { episodeid: sc.episodeid }), si, path);
      return;
    }
    if (this._isSavedText(sent.textEn)) {
      this._saved = this._saved.filter((s) => s.textEn !== sent.textEn);
      this._persistSaved();
      this.setData({ [path]: false });
      wx.showToast({ title: '已移出句子本', icon: 'none' });
      return;
    }
    this._saved.unshift({
      id: 'sent-' + Date.now(),
      episodeid: sc.episodeid || sc.id,
      episodeTitle: sc.title,
      start: sent.start,
      textEn: sent.textEn,
      textCn: sent.textCn,
      tags: ['定制微场景', '场景句'],
      savedAt: this._todayStr(),
    });
    this._persistSaved();
    this.setData({ [path]: true });
    wx.showToast({ title: '已收藏到句子本', icon: 'none' });
  },

  /* ---------------- 切片播放（B playClip/togglePlay/toggleLoop） ---------------- */

  /** 播放窗口解析：真实条预签直连/懒取网关，本地条整轨窗口 */
  _prepareAudio(clip) {
    if (!clip.real) {
      return Promise.resolve({
        url: clip.clipAudioUrl,
        offset: 0,
        winStart: clip.start,
        winEnd: clip.end,
      });
    }
    if (clip.clipAudioUrl) {
      return Promise.resolve().then(() => Object.assign(
        { url: clip.clipAudioUrl }, sentenceWindow(clip, clip.clipOffset)
      ));
    }
    return reelsApi.fetchClipAudio(clip.id).then((r) => {
      if (r && r.exclusive) {
        const err = new Error('PREMIUM_REQUIRED');
        err.exclusive = true;
        throw err;
      }
      if (!r || !r.url) throw new Error('audio unavailable');
      return Object.assign({ url: r.url }, sentenceWindow(clip, r.clipOffset));
    });
  },

  /** 卡片播放键：非活动卡=起播并循环；活动卡=暂停/续播（B onClick 同款） */
  onClipPlay(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.plan && this.data.plan.clips[idx];
    if (!clip) return;

    if (idx === this.data.activeIdx) {
      if (this.data.playing) {
        this._pausePlayback();
      } else {
        this._startPlayback(this._atEnd ? 0 : this._relPos);
      }
      return;
    }
    this._applyClip(idx);
  },

  _applyClip(idx) {
    const clips = this.data.plan.clips;
    const clip = clips[idx];
    if (!clip) return;
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastSceneWord = -99;
    this._lastSceneSent = -99;
    this._prepToken += 1;
    this._audioMeta = null;
    this._activeKind = 'clip';
    this.setData({
      activeIdx: idx,
      activeWordIndex: -1,
      sceneActiveIdx: -1,
      sceneSentLoop: -1,
      sceneWordIdx: -1,
      sceneActiveSent: -1,
      dailyActiveIdx: -1,
    });
    this._startPlayback(0);
  },

  /** 今日挑战卡播放激活（与 _applyClip 同构，daily 维度） */
  _applyDailyClip(idx) {
    const clip = this.data.daily && this.data.daily.clips[idx];
    if (!clip) return;
    if (clip.available === false) { wx.showToast({ title: '这条素材暂不可用', icon: 'none' }); return; }
    // 先停一切在播源（我的发音回放/接力/闪卡语境），再切换 daily 播放态
    this._pausePlayback();
    this._relPos = 0;
    this._atEnd = false;
    this._lastWordIdx = -99;
    this._lastSceneWord = -99;
    this._lastSceneSent = -99;
    this._prepToken += 1;
    this._audioMeta = null;
    this._activeKind = 'daily';
    this.setData({
      dailyActiveIdx: idx,
      activeWordIndex: -1,
      activeIdx: -1,
      sceneActiveIdx: -1,
      sceneSentLoop: -1,
      sceneWordIdx: -1,
      sceneActiveSent: -1,
    });
    this._startPlayback(0);
  },

  _startPlayback(fromRel) {
    const kind = this._activeKind; // 'clip' | 'scene' | 'daily' | 'relay'
    const isScene = kind === 'scene';
    const isDaily = kind === 'daily';
    const clip = isScene
      ? null
      : isDaily
        ? this.data.daily && this.data.daily.clips[this.data.dailyActiveIdx]
        : this.data.plan && this.data.plan.clips[this.data.activeIdx];
    const sc =
      isScene && this.data.sceneActiveIdx >= 0
        ? this.data.plan && this.data.plan.scenes && this.data.plan.scenes[this.data.sceneActiveIdx]
        : null;
    if ((!isScene && !clip) || (isScene && !sc)) return;
    this._atEnd = false;

    if (this._audioMeta) {
      this._playWindow(this._audioMeta, fromRel);
      return;
    }

    const token = this._prepToken;
    const loadingPatch = isScene
      ? { sceneLoadingIdx: this.data.sceneActiveIdx }
      : isDaily
        ? { dailyLoadingIdx: this.data.dailyActiveIdx }
        : { loadingClipIdx: this.data.activeIdx };
    const donePatch = isScene
      ? { sceneLoadingIdx: -1 }
      : isDaily
        ? { dailyLoadingIdx: -1 }
        : { loadingClipIdx: -1 };
    this.setData(loadingPatch);
    const prepare = isScene ? this._prepareSceneAudio(sc) : this._prepareAudio(clip);
    prepare
      .then((meta) => {
        if (token !== this._prepToken) return;
        this._audioMeta = meta;
        this.setData(donePatch);
        this._playWindow(meta, fromRel);
      })
      .catch((err) => {
        if (token !== this._prepToken) return;
        this.setData(donePatch);
        if (err && err.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        wx.showToast({ title: '切片加载失败，稍后再试', icon: 'none' });
      });
  },

  _playWindow(meta, fromRel) {
    const rel = Math.min(Math.max(fromRel || 0, 0), Math.max(0, meta.winEnd - meta.winStart - 0.05));
    this._player.playUrl(meta.url, 'studio', {
      startSec: meta.winStart + rel,
      endSec: meta.winEnd,
      rate: this._rate !== 1 ? this._rate : 0,
    });
  },

  _pausePlayback() {
    if (this.data.recordingClipId || this.data.shadowPreparingId) this._cancelShadowing();
    this._stopReviewAudio(); // 同时取消尚未返回的原声请求，防止切页后自动起播
    if (!this.data.playing) return;
    const meta = this._audioMeta;
    const pos = this._player.estimatedPos();
    if (meta && pos != null) {
      this._relPos = Math.min(Math.max(pos - meta.winStart, 0), meta.winEnd - meta.winStart);
    }
    this._player.stop();
  },

  _onClipEnd() {
    // 接力单棒/合集/闪卡语境/我的发音回放/音素诊断发音为顺序播放，不循环
    if (this._activeKind === 'relay' || this._activeKind === 'review' || this._activeKind === 'shadow-user' || this._activeKind === 'shadow-word') {
      this._atEnd = true;
      this._relPos = 0;
      // 连播中：本棒自然播完即时推进（T9——固定 5.2s 会掐断长句；末棒
      // 无下一棒定时器故此前总能播完，即本 BUG 的不对称表现）
      if (this._activeKind === 'relay' && this.data.playingRoomId) {
        const room = (this.data.relayRooms || []).find((r) => r.id === this.data.playingRoomId);
        if (room) this._advanceBaton(room, this.data.playingStep);
      }
      return;
    }
    if (this.data.isLooping) {
      this._startPlayback(0);
      return;
    }
    this._atEnd = true;
    this._relPos = 0;
  },

  /** 活动卡循环键（B: 仅 active 卡显示） */
  onToggleLoop() {
    this.setData({ isLooping: !this.data.isLooping });
  },

  /** 词级扫光（offset 协议同 discover；切片=词窗判定，场景=跨句全局词序+句高亮） */
  _onTick(pos) {
    const meta = this._audioMeta;

    // 接力单棒/闪卡语境试听：词级点亮（B isWordCurrent 同款，当前词实底高亮）
    if (this._activeKind === 'relay' || this._activeKind === 'review') {
      const seg = this._relaySeg;
      if (!seg || !Array.isArray(seg.words) || !seg.words.length) return;
      const offset = meta ? meta.offset : 0;
      const winEnd = meta ? meta.winEnd : seg.winEnd;
      let wi = -1;
      if (pos >= winEnd) {
        wi = seg.words.length;
      } else {
        for (let i = 0; i < seg.words.length; i++) {
          const w = seg.words[i];
          if (pos >= w.start - offset && pos < w.end - offset) {
            wi = i;
            break;
          }
        }
      }
      if (wi !== this._lastWordIdx) {
        this._lastWordIdx = wi;
        this.setData(this._activeKind === 'review' ? { reviewWordIdx: wi } : { relayWordIdx: wi });
      }
      return;
    }

    if (this._activeKind === 'scene') {
      const sc =
        this.data.sceneActiveIdx >= 0
          ? this.data.plan && this.data.plan.scenes && this.data.plan.scenes[this.data.sceneActiveIdx]
          : null;
      if (!sc) return;
      const offset = meta ? meta.offset : 0;
      const winEnd = meta ? meta.winEnd : sc.duration;
      let gi = -1;
      let si = -1;
      if (pos >= winEnd) {
        gi = sc.totalWords;
      } else {
        for (let s = 0; s < sc.sentences.length; s++) {
          const sent = sc.sentences[s];
          if (pos < sent.start - offset || pos >= sent.end - offset) continue;
          si = s;
          for (let k = 0; k < sent.words.length; k++) {
            const w = sent.words[k];
            if (pos >= w.start - offset && pos < w.end - offset) {
              gi = w.gi;
              break;
            }
          }
          break; // 命中句后不再跨句（词间隙 gi=-1，句保持高亮）
        }
      }
      const patch = {};
      if (gi !== this._lastSceneWord) {
        this._lastSceneWord = gi;
        patch.sceneWordIdx = gi;
      }
      if (si >= 0 && si !== this._lastSceneSent) {
        this._lastSceneSent = si;
        patch.sceneActiveSent = si;
      }
      if (Object.keys(patch).length) this.setData(patch);
      return;
    }

    const kind = this._activeKind;
    const idx = kind === 'daily' ? this.data.dailyActiveIdx : this.data.activeIdx;
    const clip =
      kind === 'daily'
        ? this.data.daily && this.data.daily.clips[idx]
        : this.data.plan && this.data.plan.clips[idx];
    if (!clip || !Array.isArray(clip.words) || !clip.words.length) return;
    const offset = meta ? meta.offset : 0;
    const winEnd = meta ? meta.winEnd : clip.end;
    let wi = -1;
    if (pos >= winEnd) {
      wi = clip.words.length;
    } else {
      for (let i = 0; i < clip.words.length; i++) {
        const w = clip.words[i];
        if (pos >= w.start - offset && pos < w.end - offset) {
          wi = i;
          break;
        }
      }
    }
    if (wi !== this._lastWordIdx) {
      this._lastWordIdx = wi;
      this.setData({ activeWordIndex: wi });
    }
  },

  /* ---------------- 今日挑战（B daily tab） ---------------- */

  /** 今日挑战与账号统计统一使用北京时间。 */
  _todayStr() {
    return dashboard.chinaClock().date;
  },

  /** 切片 → 挑战卡视图模型（B server 兜底映射同款：reason/focus/词汇） */
  _mapDailyClip(reel, idx, hitVocab, source) {
    const longWords = pickVocabFromWords(reel.words || [], reel.matchedWords || []);
    const tv =
      source === 'local' && reel.keywords
        ? reel.keywords.map((k) => ({ word: k, matched: false, pos: '重点词', meaning: '高频原生表达' }))
        : longWords.map((v) => ({ word: v.word, matched: !!v.matched, pos: v.pos || '重点词', meaning: v.meaning || '高频原生表达' }));
    return {
      id: reel.id,
      order: idx + 1,
      showTitle: reel.showTitle,
      topic: reel.topic || '',
      difficulty: reel.difficulty || '',
      start: reel.start,
      end: reel.end,
      duration: reel.duration,
      textEn: cleanDisplayText(reel.textEn),
      textCn: cleanDisplayText(reel.textCn),
      words: reel.words || [],
      matchedWords: reel.matchedWords || [],
      phoneticFocus: reel.phoneticTip || '母语者意群停顿与弱读训练',
      targetVocabulary: tv,
      personalizedReason: reel.selectionReason === 'cooldown_reuse'
        ? '间隔一段时间后再练习这句话，巩固自然节奏与发音。'
        : hitVocab
        ? '关联你的生词「' + (reel.matchedWords || []).slice(0, 2).join(', ') + '」，用新句子练习发音与用法。'
        : '通过' + (reel.topic || '原声表达') + '主题，练习自然节奏与连读。',
      real: !!reel.real,
      episodeid: reel.episodeid || '',
      subtitleId: reel.subtitleId != null ? reel.subtitleId : null,
      clipAudioUrl: reel.clipAudioUrl || null,
      clipOffset: reel.audioOffset || 0,
      completed: false,
      score: 0,
      evalResult: null,
      waveBars: null,
      activeDiag: null,
      saved: this._isClipSaved(reel),
    };
  },

  /** 挑战卡播放键（与 onClipPlay 同构，daily 维度） */
  onDailyPlay(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.daily && this.data.daily.clips[idx];
    if (!clip) return;
    if (idx === this.data.dailyActiveIdx) {
      if (this.data.playing) {
        this._pausePlayback();
      } else {
        this._startPlayback(this._atEnd ? 0 : this._relPos);
      }
      return;
    }
    this._applyDailyClip(idx);
  },

  /** 挑战卡点词查词（上下文走 _wordCtx 通道） */
  onDailyWordTap(e) {
    const ds = e.currentTarget.dataset;
    const clip = this.data.daily && this.data.daily.clips[Number(ds.di)];
    if (!clip) return;
    const wordEntry = (clip.words || [])[Number(ds.wi)];
    const vocab = (clip.targetVocabulary || []).find((v) => v.word === ds.word);
    const raw = (wordEntry && wordEntry.word) || ds.word || clip.textEn;
    const clean = String(raw).replace(/^[^\w]+|[^\w]+$/g, '');
    if (!clean) return;
    this._wordCtx = {
      episodeid: clip.episodeid || '',
      title: clip.showTitle,
      textEn: clip.textEn,
      textCn: clip.textCn,
      start: (wordEntry && wordEntry.start) || (vocab && null) || clip.start,
    };
    this._openWordModal(clean);
  },

  /** 挑战卡透视 */
  onDailyDeepDive(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.daily && this.data.daily.clips[idx];
    if (!clip) return;
    this.setData({
      deepOpen: true,
      deepLoading: true,
      deepAnalysis: null,
      deepSentence: clip.textEn,
      deepSource: '',
    });
    reelsApi
      .fetchDeepDive(clip.textEn)
      .then((a) => {
        this.setData({
          deepLoading: false,
          deepAnalysis: a || DEEP_FALLBACK,
          deepSource: a ? a.source : 'fallback',
        });
      })
      .catch(() => {
        this.setData({ deepLoading: false, deepAnalysis: DEEP_FALLBACK, deepSource: 'fallback' });
      });
  },

  /** 挑战卡收藏（双源，写 daily.clips[i].saved） */
  onDailyBookmark(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.daily && this.data.daily.clips[idx];
    if (!clip) return;
    const path = 'daily.clips[' + idx + '].saved';
    if (clip.real && clip.episodeid && clip.subtitleId != null) {
      this._toggleDailyReal(clip, idx, path);
      return;
    }
    if (this._isSavedText(clip.textEn)) {
      this._saved = this._saved.filter((s) => s.textEn !== clip.textEn);
      this._persistSaved();
      this.setData({ [path]: false });
      wx.showToast({ title: '已移出句子本', icon: 'none' });
      return;
    }
    this._saved.unshift({
      id: 'sent-' + Date.now(),
      episodeid: clip.episodeid || clip.id,
      episodeTitle: clip.showTitle,
      start: clip.start,
      textEn: clip.textEn,
      textCn: clip.textCn,
      tags: ['今日挑战', clip.topic || '原声跟读'],
      savedAt: this._todayStr(),
    });
    this._persistSaved();
    this.setData({ [path]: true });
    wx.showToast({ title: '已收藏到句子本', icon: 'none' });
  },

  _toggleDailyReal(clip, idx, path) {
    if (!authStore.getState().isLoggedIn) {
      this._promptLogin('登录后即可收藏句子到句子本');
      return;
    }
    if (this._savingBusy) return;
    const key = clip.episodeid + ':' + clip.subtitleId;
    const wasSaved = !!this._savedSub[key];
    this._savingBusy = true;
    this.setData({ [path]: !wasSaved });
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
        if (!body || !body.success || !body.data) {
          this.setData({ [path]: wasSaved });
          wx.showToast({ title: (body && body.message) || '收藏失败，请重试', icon: 'none' });
          return;
        }
        this._loadDashboard(true);
        if (body.data.saved) {
          this._savedSub[key] = true;
          this.setData({ [path]: true });
          wx.showToast({ title: '已收藏到句子本', icon: 'none' });
        } else {
          delete this._savedSub[key];
          this.setData({ [path]: false });
          wx.showToast({ title: '已取消收藏', icon: 'none' });
        }
      })
      .catch((err) => {
        this._savingBusy = false;
        this.setData({ [path]: wasSaved });
        if (err && err.code === 'SENTENCE_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '收藏失败，请重试', icon: 'none' });
      });
  },

  /* ---------------- 跟读接力（yuanlu /api/relay/*；未登录/接口失败回落 relay-mock） ---------------- */

  async _loadRelayRooms() {
    const apply = (rooms) => this.setData({
      relayRooms: rooms,
      recruitingCount: rooms.filter((r) => r.status === 'recruiting').length,
      relayLoading: false,
    });
    // 未登录不发请求（401 会全局 toast「登录已过期」），直接本地演示房兜底
    if (!this._shadowToken()) return apply(relayMock.listRooms());
    try {
      apply(await relayApi.fetchRooms());
    } catch (e) {
      apply(relayMock.listRooms());
    }
  },

  /** 展开/收起发起面板（展开时预选今日挑战第 1 条切片） */
  onToggleCreateRelay() {
    const next = !this.data.showCreateRelay;
    const patch = { showCreateRelay: next };
    if (next && !this.data.selectedRelayClipId) {
      const first = this.data.daily && this.data.daily.clips[0];
      if (first) patch.selectedRelayClipId = first.id;
    }
    this.setData(patch);
  },

  onSelectRelayClip(e) {
    this.setData({ selectedRelayClipId: e.currentTarget.dataset.id });
  },

  onRelayTitleInput(e) {
    this.setData({ newRelayTitle: e.detail.value });
  },

  /** 今日挑战卡「发起接力」入口（B daily 卡 Radio 按钮：预选切片+命名+跳 tab 开面板） */
  onDailyRelayLaunch(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.daily && this.data.daily.clips[idx];
    if (!clip) return;
    this._pausePlayback();
    const meta = TAB_META.find((t) => t.key === 'relay');
    this.setData({
      activeTab: 'relay',
      header: meta,
      showCreateRelay: true,
      selectedRelayClipId: clip.id,
      newRelayTitle: '《' + (clip.topic || '原声') + '》原声口语接力',
    });
    this._scrollAnchorToTop('#stTabsRow');
  },

  /** 真录音链（复刻 shadowing 录音→评测骨架）：配额→权限→录音→评测→建房/接棒。
   *  复用 WXML 的 relayRecording('create'|roomId) 忙态；relayCountdown 由假倒计时
   *  改为已录秒数（30s 自动收）。评测走 /api/speech/evaluate（配额/会员弹窗
   *  分流复用 shadowing 同款错误码），携 recognitionId+同段录音到 relay 域。 */
  async _relayRecordStart(opts) {
    // opts: { mode:'create'|'join', busyKey, episodeId, subtitleId, targetText, clipId?, roomId? }
    this._pausePlayback();
    this._stopCompilation();
    ++this._prepToken; // 开麦前作废挂起的原声懒取
    const token = this._shadowToken();
    try {
      const quota = await get('/api/speech/quota', { scenario: 'learn' }, { showError: false });
      if (token !== this._shadowToken()) return;
      if (!quota || !quota.success || !quota.data) throw new Error('无法获取评测余量，请重试');
      if (quota.data.exhausted) {
        this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
        return;
      }
      const permitted = await recorder.ensurePermission();
      if (token !== this._shadowToken()) return;
      if (!permitted) throw new Error('需要麦克风权限，请授权后重试');
      if (!recorder.start({ ensurePerm: false })) throw new Error('录音启动失败，请重试');
      this._relayRecCtx = Object.assign({ token, startedAt: Date.now() }, opts);
      this.setData({ relayRecording: opts.busyKey, relayCountdown: 0 });
      if (this._relayRecTimer) clearInterval(this._relayRecTimer);
      this._relayRecTimer = setInterval(() => {
        const ctx = this._relayRecCtx;
        if (!ctx || !this.data.relayRecording) return this._cancelRelayRecording();
        const seconds = Math.min(RELAY_MAX_SECONDS, Math.floor((Date.now() - ctx.startedAt) / 1000));
        this.setData({ relayCountdown: seconds });
        if (seconds >= RELAY_MAX_SECONDS || !recorder.getState().recording) this._relayRecordFinish();
      }, 250);
    } catch (err) {
      this._cancelRelayRecording();
      wx.showToast({ title: err.message || '录音启动失败，请重试', icon: 'none' });
    }
  },

  /** 停录→评测→建房/接棒（提交期 relaySubmitting 挡住按钮重复点击） */
  _relayRecordFinish() {
    const ctx = this._relayRecCtx;
    if (!ctx || !this.data.relayRecording) return;
    if (this._relayRecTimer) clearInterval(this._relayRecTimer);
    this._relayRecTimer = null;
    const token = this._shadowToken();
    const current = () => ctx === this._relayRecCtx && token === this._shadowToken();
    this.setData({ relayRecording: '', relayCountdown: 0, relaySubmitting: true });
    (async () => {
      try {
        const audio = await recorder.stop();
        if (!current()) return;
        if (audio.bytes < 16000 || !audio.base64) throw new Error('录音太短或未采集到声音，请重新录制');
        const body = await post('/api/speech/evaluate', {
          episodeId: ctx.episodeId,
          subtitleId: ctx.subtitleId == null ? undefined : ctx.subtitleId,
          targetText: ctx.targetText, audioBase64: audio.base64, rate: 16000, scenario: 'learn',
        }, { showError: false, timeout: 60000 });
        if (!current()) return;
        const evalData = body && body.data;
        if (!body || !body.success || !evalData || !evalData.recognitionId) {
          const err = new Error((body && (body.error || body.message)) || '评测失败，请重新录音');
          err.body = body || null;
          throw err;
        }
        const room = ctx.mode === 'create'
          ? await relayApi.createRoom({
              clipId: ctx.clipId, title: this.data.newRelayTitle,
              recognitionId: evalData.recognitionId, audioBase64: audio.base64,
            })
          : await relayApi.joinRoom({
              roomId: ctx.roomId,
              recognitionId: evalData.recognitionId, audioBase64: audio.base64,
            });
        if (!current()) return;
        // 新房置顶去重，招募计数重算（B finishCreate/finishJoin 同款收尾）
        const rooms = [room].concat(this.data.relayRooms.filter((r) => r.id !== room.id));
        this.setData({
          relayRooms: rooms,
          recruitingCount: rooms.filter((r) => r.status === 'recruiting').length,
          showCreateRelay: ctx.mode === 'create' ? false : this.data.showCreateRelay,
          newRelayTitle: ctx.mode === 'create' ? '' : this.data.newRelayTitle,
        });
        this._loadLeaderboard();
        this._igniteStreakBySpeech(evalData.recognitionId); // 接力开口也算连胜验收
        // 工具模拟器录音评测恒 0 分（微信官方限制）：链路照走，归因提示
        if (recorder.isDevtools()) {
          wx.showToast({ title: '工具录音评分恒 0 分（微信限制），真机预览出真分', icon: 'none' });
        }
        this._startCompilation(room);
      } catch (err) {
        if (!current()) return;
        const code = err && (err.error || err.code || (err.body && err.body.error));
        if (code === 'EVALUATION_QUOTA_EXCEEDED' || code === 'REVIEW_EVAL_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
        } else {
          wx.showToast({ title: (err.body && err.body.error) || err.message || '提交失败，请重试', icon: 'none' });
        }
      } finally {
        if (current()) {
          this._relayRecCtx = null;
          this.setData({ relaySubmitting: false });
        }
      }
    })();
  },

  _cancelRelayRecording() {
    this._relayRecCtx = null;
    if (this._relayRecTimer) clearInterval(this._relayRecTimer);
    this._relayRecTimer = null;
    if (this.data.relayRecording || this.data.relaySubmitting) {
      this.setData({ relayRecording: '', relayCountdown: 0, relaySubmitting: false });
    }
    try { if (recorder.getState().recording) recorder.cancel(); } catch (e) { /* 已停 */ }
  },

  /** 录第 1 棒并邀请接力（B finishCreateRelayRoom：创建房间→关面板→自动连播新合集） */
  onStartCreateRelay() {
    if (this.data.relaySubmitting || (this.data.relayRecording && this.data.relayRecording !== 'create')) return;
    if (this.data.relayRecording === 'create') return this._relayRecordFinish(); // 再点=停录提交
    if (!this._shadowToken()) return this._promptLogin('登录后发起跟读接力');
    const clips = (this.data.daily && this.data.daily.clips) || [];
    const clip = clips.find((c) => c.id === this.data.selectedRelayClipId) || clips[0];
    if (!clip) {
      wx.showToast({ title: '暂无切片可选，先去今日挑战看看', icon: 'none' });
      return;
    }
    if (!clip.real || !clip.episodeid || !String(clip.textEn || '').trim()) {
      wx.showToast({ title: '示例素材不支持接力，请先装载今日真实挑战', icon: 'none' });
      return;
    }
    this._relayRecordStart({
      mode: 'create', busyKey: 'create',
      episodeId: clip.episodeid, subtitleId: clip.subtitleId,
      targetText: clip.textEn, clipId: clip.id,
    });
  },

  /** 接棒压轴（B finishJoinRelayRoom：join→刷新→自动连播合成合集） */
  onJoinRelay(e) {
    const roomId = e.currentTarget.dataset.rid;
    if (!roomId || this.data.relaySubmitting || (this.data.relayRecording && this.data.relayRecording !== roomId)) return;
    if (this.data.relayRecording === roomId) return this._relayRecordFinish(); // 再点=停录提交
    if (!this._shadowToken()) return this._promptLogin('登录后接棒压轴');
    const room = this.data.relayRooms.find((r) => r.id === roomId);
    const p = room && room.nextPromptSegment;
    if (!room || room.status !== 'recruiting' || !p) return;
    if (!p.episodeid || !String(p.textEn || '').trim()) {
      wx.showToast({ title: '该接力房暂不可接棒（示例数据）', icon: 'none' });
      return;
    }
    this._relayRecordStart({
      mode: 'join', busyKey: roomId,
      episodeId: p.episodeid, subtitleId: p.subtitleId,
      targetText: p.textEn, roomId,
    });
  },

  /** 点赞（真实房当日幂等；未登录/mock 房保留乐观） */
  onLikeRelay(e) {
    const rid = e.currentTarget.dataset.rid;
    const room = this.data.relayRooms.find((r) => r.id === rid);
    if (!room) return;
    const optimistic = this.data.relayRooms.map((r) =>
      r.id === rid ? Object.assign({}, r, { likes: r.likes + 1, likedByMe: true }) : r
    );
    this.setData({ relayRooms: optimistic });
    if (!this._shadowToken()) return;
    relayApi.likeRoom(rid).then((d) => {
      // 服务端权威计数回写（仍在本页数据未被刷新覆盖时）
      if (this.data.relayRooms === optimistic) {
        this.setData({
          relayRooms: optimistic.map((r) =>
            r.id === rid ? Object.assign({}, r, { likes: d.likes, likedByMe: d.likedByMe }) : r
          ),
        });
      }
    }).catch(() => { /* 乐观保留 */ });
  },

  /** 单棒试听（B playRelaySegmentAudio：点击即重播该棒，词级点亮） */
  onPlayRelaySeg(e) {
    const ds = e.currentTarget.dataset;
    const room = this.data.relayRooms.find((r) => r.id === ds.rid);
    const seg = room && room.segments.find((s) => s.id === ds.sid);
    if (seg) this._playRelaySeg(seg, { sweep: true });
  },

  /** 招募中房「先听原声示范」（B nextPromptSegment playClip；真实提示棒懒取切片音频） */
  onPlayPromptDemo(e) {
    const room = this.data.relayRooms.find((r) => r.id === e.currentTarget.dataset.rid);
    const p = room && room.nextPromptSegment;
    if (!p) return;
    if (p.audioUrl) {
      // mock 房：整轨直链 + start/end 窗口
      this._playRelaySeg(
        Object.assign({ id: room.id + '-prompt', real: false, clipAudioUrl: p.audioUrl }, p),
        { sweep: true }
      );
      return;
    }
    if (!p.clipid) return;
    reelsApi.fetchClipAudio(p.clipid)
      .then((r) => {
        if (r && r.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        if (!r || !r.url) throw new Error('audio unavailable');
        this._playRelaySeg({
          id: room.id + '-prompt', real: false, clipAudioUrl: r.url,
          start: 0, end: r.duration || p.duration || 0,
          words: p.words || [], textEn: p.textEn, textCn: p.textCn,
        }, { sweep: true });
      })
      .catch((err) => {
        if (err && err.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        wx.showToast({ title: '切片加载失败，稍后再试', icon: 'none' });
      });
  },

  /** 播放一段接力音频（单棒/示范/闪卡语境；sweep=true 时点亮词级；opts.kind='review' 走闪卡扫光通道） */
  _playRelaySeg(seg, opts) {
    const kind = (opts && opts.kind) || 'relay';
    this._pausePlayback();
    // 连播链内（opts.compilation）不清连播态——_stopCompilation 会清
    // playingRoomId/playingStep，令 _scheduleBaton 守卫恒提前退出（T11）；
    // 单棒试听/示范等手动播放仍默认停连播
    if (!(opts && opts.compilation)) this._stopCompilation();
    this._activeKind = kind;
    this._lastWordIdx = -99;
    this._relaySeg = { id: seg.id, words: seg.words || [], offset: 0, winEnd: seg.end };
    const patch = { relayActiveSegId: '', relayWordIdx: -1, reviewPlayingId: '', reviewWordIdx: -1 };
    if (opts && opts.sweep) {
      if (kind === 'review') patch.reviewPlayingId = String(seg.id).replace('review-clip-', '');
      else patch.relayActiveSegId = seg.id;
    }
    this.setData(patch);

    const token = ++this._prepToken;
    this._audioMeta = null;
    this._prepareAudio(seg)
      .then((meta) => {
        if (token !== this._prepToken) return;
        this._audioMeta = meta;
        this._relaySeg.offset = meta.offset;
        this._relaySeg.winEnd = meta.winEnd;
        this._playWindow(meta, 0);
      })
      .catch((err) => {
        if (token !== this._prepToken) return;
        if (err && err.exclusive) {
          wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
          return;
        }
        wx.showToast({ title: '切片加载失败，稍后再试', icon: 'none' });
      });
  },

  /** 一键连播/停止合集（B handlePlayCompilation：同房再点=停；5.2s 接力棒推进） */
  onPlayCompilation(e) {
    const rid = e.currentTarget.dataset.rid;
    if (this.data.playingRoomId === rid) {
      this._pausePlayback();
      this._stopCompilation();
      return;
    }
    const room = this.data.relayRooms.find((r) => r.id === rid);
    if (room && room.segments.length) this._startCompilation(room);
  },

  _startCompilation(room) {
    this._pausePlayback();
    this._activeKind = 'relay';
    this.setData({ playingRoomId: room.id, playingStep: 1, relayActiveSegId: '' });
    this._playRelaySeg(room.segments[0], { sweep: false, compilation: true });
    this._armBatonFallback(room, 1);
  },

  /** 推进到下一棒（末棒则收播复位）——由本棒自然播完（_onClipEnd）触发 */
  _advanceBaton(room, step) {
    if (this.data.playingRoomId !== room.id) return;
    const next = step + 1;
    if (next <= room.segments.length) {
      this.setData({ playingStep: next });
      this._playRelaySeg(room.segments[next - 1], { sweep: false, compilation: true });
      this._armBatonFallback(room, next);
    } else {
      this._stopCompilation();
    }
  },

  /**
   * 兜底定时器（本棒时长 + 3s）：正常由 _onClipEnd 事件推进并在此重置；
   * 仅当结束事件丢失（懒取失败/低版本异常）时接管，防止连播悬挂
   */
  _armBatonFallback(room, step) {
    if (this._batonTimer) clearTimeout(this._batonTimer);
    const seg = room.segments[step - 1] || {};
    const dur = Math.max(1, Number(seg.duration) || 5.2);
    this._batonTimer = setTimeout(() => {
      this._batonTimer = null;
      if (this.data.playingRoomId !== room.id) return;
      this._advanceBaton(room, step);
    }, dur * 1000 + 3000);
  },

  _stopCompilation() {
    if (this._batonTimer) {
      clearTimeout(this._batonTimer);
      this._batonTimer = null;
    }
    if (this.data.playingRoomId || this.data.playingStep) {
      this.setData({ playingRoomId: '', playingStep: 0 });
    }
  },

  /* ---------------- 排行榜（B leaderboard tab；数据=leaderboard-mock） ---------------- */

  /**
   * 组榜：登录态走 yuanlu /api/speech/leaderboard（今日 count 榜，扩展装饰
   * streak/badge/代表作/点赞/myEntry）；未登录/接口失败回落 lbMock.build
   * （B 客户端兜底同款）。userCount/userScore 仅 mock 路径消费。
   */
  async _loadLeaderboard(userCount, userScore) {
    const applyMock = () => {
      const d = this.data.daily;
      const count = userCount != null ? userCount : (d && (d.totalShadowingCount || d.completedCount)) || 0;
      const score = userScore != null ? userScore : (d && d.averageScore) || 88;
      this.setData({ leaderboard: lbMock.build(count, score), lbRefreshing: false });
      this._syncMetrics();
    };
    if (!this._shadowToken()) return applyMock();
    try {
      const lb = await lbApi.fetchDaily();
      this.setData({ leaderboard: lb, lbRefreshing: false });
      this._syncMetrics(); // 榜名次/跟读数随之刷新（真实口径）
    } catch (e) {
      applyMock();
    }
  },

  /** 刷新按钮（B 网络往返转圈；本地组榜同步——延迟一拍让转圈可见） */
  onLbRefresh() {
    if (this.data.lbRefreshing) return;
    this.setData({ lbRefreshing: true });
    setTimeout(() => this._loadLeaderboard(), 250);
  },

  /**
   * 点赞（真实榜：当日幂等 social_likes，服务端权威计数回写；mock/未登录：
   * 本地乐观 +1 且按日落 storage——B handleCheerUser 同款不可撤销）。
   */
  onLbCheer(e) {
    const id = e.currentTarget.dataset.id;
    const lb = this.data.leaderboard;
    if (!lb || this.data.lbCheeringId) return;
    const target = lb.entries.find((en) => en.id === id);
    if (!target) return;
    const optimistic = Object.assign({}, lb, {
      entries: lb.entries.map((en) =>
        en.id === id ? Object.assign({}, en, { likes: en.likes + 1, likedByMe: true }) : en
      ),
    });
    this.setData({ leaderboard: optimistic, lbCheeringId: id });
    setTimeout(() => {
      if (this.data.lbCheeringId === id) this.setData({ lbCheeringId: '' });
    }, 400);
    if (!this._shadowToken()) {
      lbMock.markCheered(id);
      return;
    }
    lbApi.cheer(id).then((d) => {
      if (this.data.leaderboard === optimistic) {
        this.setData({
          leaderboard: Object.assign({}, optimistic, {
            entries: optimistic.entries.map((en) =>
              en.id === id ? Object.assign({}, en, { likes: d.likes, likedByMe: d.likedByMe }) : en
            ),
          }),
        });
      }
    }).catch(() => { /* 乐观保留（B 同款 POST 失败不回滚） */ });
  },

  /**
   * 挑战同款（B handlePracticeLeaderboardSentence：命中今日挑战切片 → 跳
   * daily tab 循环播该卡；未命中 → B 造临时切片（0.45s/词合成时间戳 + ogg
   * 环境音，weapp 播不了）→ 沙箱改播本地语料真音频代表作（relay 段协议）。
   */
  onLbPractice(e) {
    const id = e.currentTarget.dataset.id;
    const lb = this.data.leaderboard;
    const entry = lb && lb.entries.find((en) => en.id === id);
    if (!entry) return;
    const clips = (this.data.daily && this.data.daily.clips) || [];
    const mi = clips.findIndex(
      (c) => c.id === entry.featuredClipId || c.textEn === entry.featuredSentence
    );
    if (mi >= 0) {
      this._pausePlayback();
      this._stopCompilation();
      this.setData({
        activeTab: 'daily',
        header: TAB_META.find((t) => t.key === 'daily'),
        isLooping: false, // 只播放该句，不循环（用户口径）
      });
      this._applyDailyClip(mi);
      return;
    }
    // 榜代表作命中真实 corpus 切片：作为「同款加练」句加入今日挑战（第 6+
    // 句，isBonus 不计通关口径），切过去播一次（不循环）
    if (entry.featuredClip && entry.featuredClip.clipid) {
      const reel = reelsApi.fromFeedItem(entry.featuredClip);
      const idx = this._appendDailyBonus(reel);
      this._pausePlayback();
      this._stopCompilation();
      this.setData({
        activeTab: 'daily',
        header: TAB_META.find((t) => t.key === 'daily'),
        isLooping: false,
      });
      if (idx >= 0) this._applyDailyClip(idx);
      return;
    }
    const local = reelsApi.localReels().find((r) => r.id === entry.featuredClipId);
    if (local) {
      this._playRelaySeg(
        {
          id: 'lb-' + entry.id,
          textEn: entry.featuredSentence,
          textCn: local.textCn,
          audioUrl: local.audioUrl,
          start: local.start,
          end: local.end,
          words: local.words || [],
          real: false,
          clipAudioUrl: local.audioUrl,
        },
        { sweep: true }
      );
      return;
    }
    // 真实榜代表作（cuid 切片，非本地 clip-* 语料）：懒取物理切片即播
    if (entry.featuredClipId) {
      reelsApi.fetchClipAudio(entry.featuredClipId)
        .then((r) => {
          if (r && r.exclusive) {
            wx.showToast({ title: '该原声切片为会员专享', icon: 'none' });
            return;
          }
          if (!r || !r.url) throw new Error('audio unavailable');
          this._playRelaySeg({
            id: 'lb-' + entry.id, real: false, clipAudioUrl: r.url,
            start: 0, end: r.duration || 0,
            textEn: entry.featuredSentence, textCn: '', words: [],
          }, { sweep: true });
        })
        .catch(() => wx.showToast({ title: '代表作音频加载失败', icon: 'none' }));
      return;
    }
    wx.showToast({ title: '该学员今日暂无代表作音频', icon: 'none' });
  },

  /** 我的站位卡「去跟读冲榜」（B setActiveTab('daily')，不起播） */
  onLbGoDaily() {
    this._pausePlayback();
    this.setData({
      activeTab: 'daily',
      header: TAB_META.find((t) => t.key === 'daily'),
    });
  },

  /* ---------------- 点词查词 ---------------- */

  onWordTap(e) {
    const ds = e.currentTarget.dataset;
    const clipIdx = Number(ds.ci);
    const clip = this.data.plan && this.data.plan.clips[clipIdx];
    if (!clip) return;
    const wordEntry = (clip.words || [])[Number(ds.wi)];
    const raw = (wordEntry && wordEntry.word) || ds.word || clip.textEn;
    const clean = String(raw).replace(/^[^\w]+|[^\w]+$/g, '');
    if (!clean) return;
    this._wordCtx = {
      episodeid: clip.episodeid || '',
      title: clip.showTitle,
      textEn: clip.textEn,
      textCn: clip.textCn,
      start: (wordEntry && wordEntry.start) || clip.start,
    };
    this._openWordModal(clean);
  },

  /** 打开词典弹窗（切片词/场景词共用；上下文已存 this._wordCtx） */
  _openWordModal(clean) {
    const lower = clean.toLowerCase();
    this.setData({
      wordModal: {
        visible: true,
        word: clean,
        episodeTitle: (this._wordCtx && this._wordCtx.title) || '',
        dictData: null,
        loading: true,
        saving: false,
        isSaved: !!this._vocabSet[lower],
      },
    });

    get('/api/dict/' + encodeURIComponent(lower), null, { showError: false })
      .then((body) => {
        const m = this.data.wordModal;
        if (!m.visible || m.word !== clean) return;
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
    const ctx = this._wordCtx || {};

    post(
      '/api/vocabulary/add',
      {
        word,
        definition,
        contextSentence: ctx.textEn || '',
        translation: ctx.textCn || '',
        episodeid: ctx.episodeid || '',
        timestamp: ctx.start || 0,
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
        this._loadDashboard(true);
        this._loadSmartReview(true);
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

  onClipDeepDive(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.plan && this.data.plan.clips[idx];
    if (!clip) return;
    this.setData({
      deepOpen: true,
      deepLoading: true,
      deepAnalysis: null,
      deepSentence: clip.textEn,
      deepSource: '',
    });
    reelsApi
      .fetchDeepDive(clip.textEn)
      .then((a) => {
        this.setData({
          deepLoading: false,
          deepAnalysis: a || DEEP_FALLBACK,
          deepSource: a ? a.source : 'fallback',
        });
      })
      .catch(() => {
        this.setData({ deepLoading: false, deepAnalysis: DEEP_FALLBACK, deepSource: 'fallback' });
      });
  },

  onDeepClose() {
    this.setData({ deepOpen: false });
  },

  noop() {},

  /* ---------------- 句子收藏（双源） ---------------- */

  onToggleBookmark(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const clip = this.data.plan && this.data.plan.clips[idx];
    if (!clip) return;
    if (clip.real && clip.episodeid && clip.subtitleId != null) {
      this._toggleRealSentence(clip, idx);
      return;
    }
    // 本地 mock：wx storage
    if (this._isSavedText(clip.textEn)) {
      this._saved = this._saved.filter((s) => s.textEn !== clip.textEn);
      this._persistSaved();
      this.setData({ ['plan.clips[' + idx + '].saved']: false });
      wx.showToast({ title: '已移出句子本', icon: 'none' });
      return;
    }
    this._saved.unshift({
      id: 'sent-' + Date.now(),
      episodeid: clip.episodeid || clip.id,
      episodeTitle: clip.showTitle,
      start: clip.start,
      textEn: clip.textEn,
      textCn: clip.textCn,
      tags: ['定制微场景', this._selectedLevels().join('/') || '不限难度'],
      savedAt: new Date().toISOString().split('T')[0],
    });
    this._persistSaved();
    this.setData({ ['plan.clips[' + idx + '].saved']: true });
    wx.showToast({ title: '已收藏到句子本', icon: 'none' });
  },

  _toggleRealSentence(clip, idx) {
    if (!authStore.getState().isLoggedIn) {
      this._promptLogin('登录后即可收藏句子到句子本');
      return;
    }
    if (this._savingBusy) return;
    const key = clip.episodeid + ':' + clip.subtitleId;
    const wasSaved = !!this._savedSub[key];
    this._savingBusy = true;
    this.setData({ ['plan.clips[' + idx + '].saved']: !wasSaved });

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
        if (!body || !body.success || !body.data) {
          this.setData({ ['plan.clips[' + idx + '].saved']: wasSaved });
          wx.showToast({ title: (body && body.message) || '收藏失败，请重试', icon: 'none' });
          return;
        }
        this._loadDashboard(true);
        if (body.data.saved) {
          this._savedSub[key] = true;
          this.setData({ ['plan.clips[' + idx + '].saved']: true });
          wx.showToast({ title: '已收藏到句子本', icon: 'none' });
        } else {
          delete this._savedSub[key];
          this.setData({ ['plan.clips[' + idx + '].saved']: false });
          wx.showToast({ title: '已取消收藏', icon: 'none' });
        }
      })
      .catch((err) => {
        this._savingBusy = false;
        this.setData({ ['plan.clips[' + idx + '].saved']: wasSaved });
        if (err && err.code === 'SENTENCE_QUOTA_EXCEEDED') {
          this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
          return;
        }
        wx.showToast({ title: (err && err.message) || '收藏失败，请重试', icon: 'none' });
      });
  },

  _isClipSaved(clip) {
    if (clip.real && clip.episodeid && clip.subtitleId != null) {
      return !!this._savedSub[clip.episodeid + ':' + clip.subtitleId];
    }
    return this._isSavedText(clip.textEn);
  },

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
