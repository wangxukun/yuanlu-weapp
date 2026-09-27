/**
 * components/review/pron-list — 弱项列表模块（T4.4）
 * 完整复刻 Android PronunciationNotebookScreen.kt 的四块（截图口径）：
 * ① StatsPanelHeader：Mic 页头（titleLarge 700 + 副题）+ 发音达人榜胶囊入口
 *   （secondary@0.1 底 + @0.3 边全圆）+ 三统计卡 MiniStatCard（待复习句子=totalErrors /
 *   最弱音素 '/θ/'（mono titleSmall）/ 已攻克音素 = avgScore≥85 计数）
 * ② ReviewPlanBanner：totalErrors>0 → 深青蓝横幅（浅 #3D6A8D/深 #1B3348，
 *   Psychology #9CC3E0 + 白标题 + 白@85 副文 + 白底按钮 content #3D6A8D）；
 *   =0 → CardShell「全部完成了！」CheckCircle SuccessGreen
 * ③ PhonemeRadarCard：IconBadge(TrackChanges primary) + top6 '/音素/' 雷达
 *   （pron-core.drawRadarChart，PhonemeRadarColor #4F46E5，240dp 高）；
 *   <3 点 → 「数据积累中 / 完成更多评测即可解锁雷达图」
 * ④ WeakSentenceListCard：IconBadge(EmojiEvents secondary) + 弱项句行
 *   （56dp 封面 10dp 圆角 / 剧集名 labelSmall 700 @osv70 / 原句 bodyMedium 500 /
 *   得分徽章 tone@0.12 底三档「上次得分: N」/ 中文日期）行点击 → speech-eval
 *   深链 ?id={episodeid}&focus={subtitleId}（对齐 Android onOpenSpeechEval）；
 *   非会员 lockedCount>0 → primary@0.05 锁定卡（Android 为 toast，小程序按
 *   REVIEW-TASK 权限表升级为 premium-modal(pronunciation_locked, {totalErrors})）；
 *   errors 空 → 「太棒了！/ 您目前没有待复习的弱项句子」
 */
const pronCore = require('../../../utils/pron-core');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 归一弱项本聚合（pronCore.parseNotebook 输出） */
    notebook: { type: Object, value: null },
  },

  data: {
    themeClass: '',
    dark: false,
    // 统计面板
    totalErrors: 0,
    weakestPhoneme: '-',
    masteredCount: 0,
    // 音素雷达
    radarReady: false,
    // 弱项句列表
    rows: [],
    lockedCount: 0,
    // 锁定卡弹窗（vars: {totalErrors: lockedCount}）
    premiumVisible: false,
    premiumVars: null,
    icons: {
      mic: '', emojiEventsSecondary: '', description: '', trackChangesError: '',
      emojiEventsSuccess: '', psychology: '', playCircle: '', checkCircle: '',
      trackChangesPrimary: '', trackChangesFaint: '', lockPrimary: '',
    },
  },

  lifetimes: {
    attached() {
      this._syncTheme();
      this._applyNotebook();
    },
    ready() {
      this._drawRadar();
    },
  },

  observers: {
    notebook() {
      this._applyNotebook();
    },
    dark() {
      this._syncIcons();
      this._drawRadar(); // 网格/标签色随主题
    },
  },

  methods: {
    _syncTheme() {
      const dark = theme.getEffective() === 'dark';
      this.setData({ themeClass: theme.rootClass(), dark });
      this._syncIcons();
    },

    _syncIcons() {
      const d = this.data.dark;
      this.setData({
        icons: {
          mic: d ? '/assets/icons/mic-tertiary-dark.svg' : '/assets/icons/mic-tertiary.svg',
          emojiEventsSecondary: '/assets/icons/emoji-events-secondary.svg', // secondary 双态恒 #D98A17
          description: '/assets/icons/description-secondary.svg',
          trackChangesError: '/assets/icons/track-changes-error.svg', // error 双态恒 #D2503F
          emojiEventsSuccess: '/assets/icons/emoji-events-success-filled.svg', // SuccessGreen 恒值
          psychology: '/assets/icons/psychology-banner.svg', // 横幅浅色 #9CC3E0 恒值
          playCircle: '/assets/icons/play-circle-banner.svg', // 按钮文字色 #3D6A8D 恒值
          checkCircle: '/assets/icons/check-circle-success-m3.svg',
          trackChangesPrimary: d ? '/assets/icons/track-changes-primary-dark.svg' : '/assets/icons/track-changes-primary.svg',
          trackChangesFaint: d ? '/assets/icons/track-changes-faint-dark.svg' : '/assets/icons/track-changes-faint.svg',
          lockPrimary: d ? '/assets/icons/lock-primary-dark.svg' : '/assets/icons/lock-primary.svg',
        },
      });
    },

    /** 全量派生：统计面板 / 雷达就绪 / 行装饰 / 锁定数（逻辑在 pron-core） */
    _applyNotebook() {
      const nb = this.data.notebook;
      if (!nb) return;
      const derived = pronCore.notebookStats(nb);
      const radar = pronCore.phonemeRadarPoints(nb.phonemeStats);
      const lockedCount = pronCore.lockedCount(nb);
      this._radarPoints = radar;
      this.setData(
        {
          totalErrors: nb.totalErrors,
          weakestPhoneme: derived.weakestPhoneme || '-',
          masteredCount: derived.masteredPhonemeCount,
          radarReady: radar.length >= 3,
          rows: (nb.errors || []).map(pronCore.decorateWeakRow),
          lockedCount,
          premiumVars: lockedCount > 0 ? { totalErrors: lockedCount } : null,
        },
        () => {
          this._drawRadar();
        },
      );
    },

    /** 音素雷达自绘（strokeColor = PhonemeRadarColor #4F46E5，随主题网格/标签色） */
    _drawRadar() {
      const points = this._radarPoints;
      if (!points || points.length < 3) return;
      const dark = this.data.dark;
      try {
        this.createSelectorQuery()
          .select('#plPhonemeRadar')
          .fields({ node: true, size: true })
          .exec((res) => {
            const info = res && res[0];
            if (!info || !info.node || !info.width) return;
            let dpr = 1;
            try {
              const wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
              dpr = wi.pixelRatio || 1;
            } catch (e) {
              /* 画布清晰度兜底 1x */
            }
            pronCore.drawRadarChart(info.node, info.width, info.height, points, dpr, {
              strokeColor: '#4F46E5',
              gridColor: dark
                ? pronCore.RADAR_GRID_STROKE_DARK
                : pronCore.RADAR_GRID_STROKE_LIGHT,
              labelColor: dark
                ? pronCore.RADAR_TICK_FILL_DARK
                : pronCore.RADAR_TICK_FILL_LIGHT,
            });
          });
      } catch (e) {
        // 画布查询失败静默（空态/统计不受影响）
      }
    },

    /* ── 导航（Android Route 回调的小程序等价） ── */

    /** 发音达人榜（社区功能，所有用户开放）→ T4.5 排行榜页 */
    openLeaderboard() {
      wx.navigateTo({ url: '/pages/review/leaderboard/index' });
    },

    /** 开始闯关复习 → T4.5 闯关页 */
    openPractice() {
      wx.navigateTo({ url: '/pages/review/practice/index' });
    },

    /** 弱项句行 → 语音评测页定位该句（Android onOpenSpeechEval；focus=subtitleId） */
    openSpeechEval(e) {
      const i = e.currentTarget.dataset.index;
      const row = this.data.rows[i];
      if (!row || !row.episodeid) return;
      let url = '/pages/speech-eval/index?id=' + row.episodeid;
      if (row.subtitleId !== null) url += '&focus=' + row.subtitleId;
      wx.navigateTo({ url });
    },

    /** 锁定卡 → premium-modal（pronunciation_locked，Android 为 toast 的小程序升级口径） */
    openUnlock() {
      this.setData({ premiumVisible: true });
    },

    onModalClose() {
      this.setData({ premiumVisible: false });
    },
  },
});
