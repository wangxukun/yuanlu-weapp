/**
 * components/review/diagnostic-report-card — AI 发音诊断报告卡
 * 复刻 Web app/(main)/library/pronunciation/components/DiagnosticReportCard.tsx
 * 〔Android 无此卡（其 PhonemeRadarCard 归 T4.4），内容/交互以 Web 为唯一源；
 * 卡壳与头部沿用 T4.2 已确立的 Android Material3 语言（CardShell/IconBadge/
 * titleMedium），行内语义色取 Web 原值〕：
 * - 免费层：薄弱音素 Top3 实分 + 专项建议（phoneme-tips 静态映射）+ 其余模糊
 *   锁定（文字 transparent+blur / 进度条宽 ×0.4+blur / 行尾 Lock）+ 解锁引导
 *   → premium-modal（source diagnostic_report）
 * - PRO 层：Top10 全量建议 + 「近 6 个月进步曲线」懒加载
 *   GET /api/speech/diagnostic（canvas 折线，pron-core.drawTrendChart）；
 *   403（会员态过期/竞态）→ 弹窗兜底 + 收起（红线双保险）
 * - 空态：「诊断数据积累中」
 */
const pronCore = require('../../../utils/pron-core');
const { get } = require('../../../utils/request');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 音素统计（notebook.phonemeStats，均分升序 = 最弱在前） */
    stats: { type: Array, value: [] },
    isPremium: { type: Boolean, value: false },
    /** 宿主页弹窗打开中：开发者工具下 canvas 2d 不走同层渲染、原生层悬浮于
     * 弹窗之上（真机正常），弹窗期卸载画布、关闭后重挂载重绘 */
    popupOpen: { type: Boolean, value: false },
  },

  data: {
    themeClass: '',
    dark: false,
    rows: [],
    lockedCount: 0,
    isEmpty: true,
    // PRO 进步曲线（懒加载；null=未加载 / []=已加载但无记录）
    showTrend: false,
    trendLoading: false,
    trend: null,
    premiumVisible: false,
    icons: { stethoscope: '', stethoscopeFaint: '', lockFaint: '', trending: '', chevronDown: '', chevronUp: '' },
  },

  lifetimes: {
    attached() {
      this._syncTheme();
      this._applyRows();
    },
  },

  observers: {
    'stats, isPremium': function () {
      this._applyRows();
    },
    dark() {
      this._syncIcons();
    },
    popupOpen(v) {
      if (!v && this.data.showTrend && Array.isArray(this.data.trend) && this.data.trend.length > 0) {
        // 弹窗关闭 → 曲线画布重新挂载（wx:if），nextTick + 延时双保险重绘
        if (wx.nextTick) wx.nextTick(() => this._drawTrend());
        setTimeout(() => this._drawTrend(), 120);
      }
    },
  },

  methods: {
    /** 外观根类（Android Material3 卡壳语言，与画像卡同款双轨）+ 图标变体 */
    _syncTheme() {
      const dark = theme.getEffective() === 'dark';
      this.setData({ themeClass: theme.rootClass(), dark });
      this._syncIcons();
    },

    _syncIcons() {
      const d = this.data.dark;
      this.setData({
        icons: {
          stethoscope: d ? '/assets/icons/monitor-heart-primary-dark.svg' : '/assets/icons/monitor-heart-primary.svg',
          stethoscopeFaint: d ? '/assets/icons/monitor-heart-faint-dark.svg' : '/assets/icons/monitor-heart-faint.svg',
          lockFaint: d ? '/assets/icons/lock-faint-dark.svg' : '/assets/icons/lock-faint.svg',
          trending: d ? '/assets/icons/trending-up-primary-dark.svg' : '/assets/icons/trending-up-primary.svg',
          chevronDown: d ? '/assets/icons/keyboard-arrow-down-primary-dark.svg' : '/assets/icons/keyboard-arrow-down-primary.svg',
          chevronUp: d ? '/assets/icons/keyboard-arrow-up-primary-dark.svg' : '/assets/icons/keyboard-arrow-up-primary.svg',
        },
      });
    },

    /** 行视图模型 + 锁定数 + 空态（逻辑在 pron-core.diagnosticRows） */
    _applyRows() {
      const rows = pronCore.diagnosticRows(this.data.stats, this.data.isPremium);
      this.setData({
        rows,
        isEmpty: rows.length === 0,
        lockedCount: pronCore.diagnosticLockedCount(this.data.stats),
      });
    },

    /** 解锁引导 → premium-modal（source diagnostic_report，弹窗组件内置埋点） */
    openUnlock() {
      this.setData({ premiumVisible: true });
    },

    onModalClose() {
      this.setData({ premiumVisible: false });
    },

    /** PRO：进步曲线展开/收起（首次展开懒加载；已有数据直接重绘） */
    toggleTrend() {
      if (!this.data.isPremium) return;
      const next = !this.data.showTrend;
      this.setData({ showTrend: next });
      if (!next) return;
      if (this.data.trend && this.data.trend.length) {
        this._drawTrend();
      } else {
        this._loadTrend();
      }
    },

    async _loadTrend() {
      if (this.data.trendLoading) return;
      this.setData({ trendLoading: true });
      let res = null;
      let err = null;
      try {
        res = await get('/api/speech/diagnostic');
      } catch (e) {
        err = e;
      }
      // 403：会员态过期/竞态触墙——弹窗兜底 + 收起（Web 红线双保险）
      if (err && err.statusCode === 403) {
        this.setData({ trendLoading: false, showTrend: false, premiumVisible: true });
        return;
      }
      const ok = !err && res && res.success && res.data && Array.isArray(res.data.trend);
      if (ok) {
        const parsed = pronCore.parseDiagnostic(res);
        this.setData({ trendLoading: false, trend: parsed.trend }, () => {
          this._drawTrend();
        });
      } else {
        this.setData({ trendLoading: false, trend: [] });
        wx.showToast({
          title: err ? '网络错误，请稍后重试' : '诊断数据加载失败，请稍后重试',
          icon: 'none',
        });
      }
    },

    /** 曲线自绘：setData 回调（canvas wx:if 挂载后）再查节点 */
    _drawTrend() {
      const trend = this.data.trend;
      if (!trend || !trend.length) return;
      try {
        this.createSelectorQuery()
          .select('#drcTrend')
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
            pronCore.drawTrendChart(info.node, info.width, info.height, trend, dpr);
          });
      } catch (e) {
        // 画布查询失败静默（空态文案兜底已就位）
      }
    },
  },
});
