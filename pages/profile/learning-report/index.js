/**
 * pages/profile/learning-report/index — 学习报表（个人中心阶段 8）
 * 复刻源：Web yuanlu app/(main)/library/learning-report/LearningReportView.tsx
 *   + components/stats/LearningHeatmap.tsx（Android 无对应实现，Web 为严格源）
 *
 * 数据：GET /api/user/stats/learning-report（服务端按会员切片：免费 7 天 / PRO 365 天，
 *   DTO 与 Web core/stats/learning-report.service 同源）。
 * 分层：
 *   - 公共：页头权限副标题 + 近 7 天四宫格 + 逐日面积图（紫 #4f46e5 同 Web 硬编码）
 *   - PRO（isPremium）：月/季/年趋势 + 全年热力图（view 网格 + 横向滚动）+ 智能学习建议
 *   - 免费：amber 虚线解锁卡 → premium-modal stats_report 场景（弹窗 + 埋点红线）
 * 会员口径：ensureFresh 权威校正后再拉取（切片与渲染同源）；升级返回时 isPremium
 *   变化自动重拉（365 天切片就位），对齐 Web SSR「一份数据按身份切片」语义。
 * 真机红线：canvas 显式算术 px 定寸贯穿 style 与绘制；节点挂载 token 重试 120ms×8 +
 *   成功后保险帧；缓冲区 scale(dpr) 先行（否则内容挤左上 1/dpr）。
 */
const theme = require('../../../utils/theme');
const authStore = require('../../../store/authStore');
const membershipStore = require('../../../store/membershipStore');
const core = require('../../../utils/profile-core');
const api = require('../../../utils/api/profile');

/** 图表配色（Web LearningReportView Area 硬编码 #4f46e5 不随主题；轴/网格随主题） */
const AREA_COLOR = '#4f46e5';
const AREA_FILL = 'rgba(79, 70, 229, 0.15)';
const CHART_COLORS = {
  light: { grid: 'rgba(28, 25, 23, 0.1)', label: 'rgba(87, 83, 78, 0.75)' },
  dark: { grid: 'rgba(232, 227, 217, 0.12)', label: 'rgba(168, 162, 158, 0.75)' },
};

/** 热力图周几标注列（Web WEEKDAY_LABELS：偶行显示，奇行留空占位） */
const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', '日'];

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    // ---- 页级三态 ----
    isLoading: true,
    loadError: '',
    // ---- 权限 ----
    isPremium: false,
    headerIcon: '/assets/icons/bar-chart-primary.svg',
    // ---- 视图模型（WXML 零方法调用） ----
    statCards: [], // 四宫格
    suggestions: [], // PRO 智能建议（≤3 条）
    heatMonthLabels: [],
    heatWeeks: [], // [[{cls:'lv0'..'lv4'|'lvx'}]] 周一列化网格
    weekdayLabels: WEEKDAY_LABELS,
    // ---- 趋势 ----
    range: 90, // 30 月 / 90 季 / 365 年（Web 默认 90）
    // ---- canvas 显式算术 px（onReady 下发，真机红线） ----
    chartW: 0,
    last7H: 0,
    trendH: 0,
    // ---- premium-modal（免费锁定卡承接） ----
    pmVisible: false,
  },

  onLoad() {
    this._hasLoaded = false;
    this._dpScale = 0; // dp→px 系数（屏宽/375），onReady 计算
    this._last7Token = 0;
    this._trendToken = 0;
    this._report = null; // mapReport 后的原始序列（趋势切片输入）
  },

  onReady() {
    // canvas 尺寸红线：显式算术 px（禁百分比），水平内缩 = 页 32×2 + 卡 40×2 = 144rpx
    const info = wx.getSystemInfoSync();
    const ww = info.windowWidth || 375;
    this._dpScale = ww / 375;
    this.setData({
      chartW: Math.round((ww * (750 - 144)) / 750),
      last7H: Math.round((352 * ww) / 750), // Web h-44 = 176dp
      trendH: Math.round((448 * ww) / 750), // Web h-56 = 224dp
    });
  },

  onShow() {
    // 外观：根类 + 图标变体 + chrome；生效主题变化时重建视图模型并重绘
    const __t = theme.getState();
    const themeChanged = this._lastThemeEffective && this._lastThemeEffective !== __t.effective;
    this._lastThemeEffective = __t.effective;
    this.setData(
      Object.assign(
        { themeClass: __t.rootClass, dark: __t.effective === 'dark' },
        this.buildIcons(__t.effective === 'dark'),
      ),
    );
    theme.applyChrome();
    if (themeChanged && this._report) {
      this.applyReport(this._report);
      this.requestDraw();
    }

    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, loadError: '请先登录后再查看学习报表' });
      this._hasLoaded = false;
      return;
    }

    // 会员口径：先权威校正再决定拉取（切片与渲染同源）；isPremium 变化（如升级返回）
    // 强制重拉——服务端会改发 365 天切片
    membershipStore.ensureFresh().then((s) => {
      const premium = !!(s && s.isPremium);
      const changed = premium !== this.data.isPremium;
      this.setData({ isPremium: premium });
      if (!this._hasLoaded || changed) {
        this.fetchReport({ showLoading: !this._hasLoaded });
      }
    });
  },

  onHide() {},

  onPullDownRefresh() {
    return this.fetchReport({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  // ==================== 数据获取 ====================

  async fetchReport(opts = {}) {
    const showLoading = opts.showLoading !== false;
    if (showLoading) this.setData({ isLoading: true, loadError: '' });
    try {
      const raw = await api.getLearningReport();
      this._report = core.mapReport(raw);
      this._hasLoaded = true;
      this.applyReport(this._report);
      this.setData({ isLoading: false, loadError: '' });
      this.requestDraw();
    } catch (e) {
      // 静默刷新失败保留旧数据（对齐主页下拉刷新口径）
      if (showLoading) {
        this.setData({ isLoading: false, loadError: '报表加载失败，请稍后重试' });
      }
    }
  },

  /** report → 四宫格/建议/热力图/趋势切片视图模型 */
  applyReport(report) {
    const brief = core.reportBrief(report.days);
    const suggestions = core.reportSuggestions(brief, report.streakDays, report.dailyGoalMins);
    const grid = core.heatmapGrid(report.days);
    this.setData({
      statCards: this.buildStatCards(brief, report),
      suggestions: suggestions,
      heatMonthLabels: grid.monthLabels,
      heatWeeks: grid.weeks.map(function (week) {
        return week.map(function (c) {
          return { cls: c ? 'lv' + c.level : 'lvx' };
        });
      }),
    });
  },

  /** 四宫格（Web 4 stat cards：时长/目标达成/连续打卡/新收生词；图标统一 primary 绿） */
  buildStatCards(brief, report) {
    const dark = this.data.dark;
    return [
      {
        key: 'minutes',
        label: '近 7 天时长',
        value: String(brief.hours),
        unit: '小时',
        value2: String(brief.minsPart),
        unit2: '分',
        icon: dark ? '/assets/icons/bar-chart-primary-dark.svg' : '/assets/icons/bar-chart-primary.svg',
      },
      {
        key: 'active',
        label: '目标达成',
        value: String(brief.activeDays),
        unit: '/ 7 天',
        value2: '',
        unit2: '',
        icon: dark ? '/assets/icons/event-available-primary-dark.svg' : '/assets/icons/event-available-primary.svg',
      },
      {
        key: 'streak',
        label: '连续打卡',
        value: String(report.streakDays),
        unit: '天',
        value2: '',
        unit2: '',
        icon: dark ? '/assets/icons/local-fire-department-primary-dark.svg' : '/assets/icons/local-fire-department-primary.svg',
      },
      {
        key: 'words',
        label: '新收生词',
        value: String(brief.wordsLearned),
        unit: '个',
        value2: '',
        unit2: '',
        icon: dark ? '/assets/icons/bookmark-primary-dark.svg' : '/assets/icons/bookmark-primary.svg',
      },
    ];
  },

  /** 页头/图标变体（主题切换即时换肤） */
  buildIcons(dark) {
    return {
      headerIcon: dark
        ? '/assets/icons/bar-chart-primary-dark.svg'
        : '/assets/icons/bar-chart-primary.svg',
    };
  },

  // ==================== 趋势切换 ====================

  onChangeRange(e) {
    const range = Number(e.currentTarget.dataset.range);
    if (range !== 30 && range !== 90 && range !== 365) return;
    if (range === this.data.range) return;
    this.setData({ range: range });
    this.requestTrendDraw();
  },

  // ==================== 绘制（canvas 2d 面积图） ====================

  requestDraw() {
    this.requestLast7Draw();
    this.requestTrendDraw();
  },

  requestLast7Draw() {
    this._last7Token = (this._last7Token || 0) + 1;
    this.tryDraw('#last7Chart', this._last7Token, 0, this.drawLast7.bind(this));
  },

  requestTrendDraw() {
    this._trendToken = (this._trendToken || 0) + 1;
    this.tryDraw('#trendChart', this._trendToken, 0, this.drawTrend.bind(this));
  },

  /**
   * 挂载重试（真机红线）：骨架/wx:if 未挂载时 token 循环 120ms×8；
   * 成功后同参保险帧（attempt=-1 不再续订）。
   */
  tryDraw(selector, token, attempt, draw) {
    const field = selector === '#last7Chart' ? '_last7Token' : '_trendToken';
    if (!this[field] || token !== this[field]) return; // 已有新请求，旧循环作废
    if (!this.data.chartW) return;
    this.createSelectorQuery()
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this[field] || token !== this[field]) return;
        const entry = res && res[0];
        if (!entry || !entry.node) {
          if (attempt >= 0 && attempt < 8) {
            setTimeout(() => this.tryDraw(selector, token, attempt + 1, draw), 120);
          }
          return;
        }
        draw(entry.node);
        if (attempt >= 0) {
          setTimeout(() => this.tryDraw(selector, token, -1, draw), 120);
        }
      });
  },

  /** 近 7 天逐日（免费层核心）：紫面积 + 虚线网格 + X 轴 MM-DD 全显 */
  drawLast7(canvas) {
    const days = (this._report && this._report.days) || [];
    this.drawAreaChart(canvas, days.slice(-7), this.data.chartW, this.data.last7H, 1);
  },

  /** 趋势报表：range 切片 + X 标签抽稀（首尾 + 约每 1/6 处） */
  drawTrend(canvas) {
    if (!this.data.isPremium || !this._report) return;
    const range = this.data.range;
    this.drawAreaChart(
      canvas,
      this._report.days.slice(-range),
      this.data.chartW,
      this.data.trendH,
      core.xLabelStride(Math.min(range, this._report.days.length)),
    );
  },

  /** 面积图（Web AreaChart type=monotone 等价）：几何/曲线走 profile-core 纯函数 */
  drawAreaChart(canvas, days, W, H, stride) {
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!days || days.length === 0) return;
    // 缓冲区是 W*dpr 设备像素、几何全是 CSS 逻辑像素——必须先 scale(dpr) 再画
    ctx.scale(dpr, dpr);

    const mode = theme.getState().effective === 'dark' ? 'dark' : 'light';
    const colors = CHART_COLORS[mode];
    const ds = this._dpScale || W / 375;
    const geo = core.chartGeometry(
      W,
      H,
      days.map(function (d) {
        return d.minutes;
      }),
      ds,
    );
    const fontPx = 10 * ds;
    ctx.font = fontPx + 'px sans-serif';

    // 水平虚线网格（Web CartesianGrid strokeDasharray="3 3" opacity 0.1）
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    geo.yTicks.forEach(function (t) {
      ctx.beginPath();
      ctx.moveTo(geo.leftPad, t.y);
      ctx.lineTo(W - geo.rightPad, t.y);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Y 轴 5 刻度（数字无单位，Web YAxis allowDecimals={false} 口径走 chartYMax 阶梯）
    ctx.fillStyle = colors.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    geo.yTicks.forEach(function (t) {
      const label = String(t.value);
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, geo.leftPad - tw - geo.tickGapX, t.y);
    });

    // 单调平滑曲线（Fritsch–Carlson）
    const mp = core.monotonePath(geo.points);
    if (!mp.start) return;

    // 面积（Web fillOpacity 0.15 纯色，非渐变）
    ctx.beginPath();
    ctx.moveTo(mp.start.x, mp.start.y);
    mp.segments.forEach(function (s) {
      ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    });
    ctx.lineTo(geo.points[geo.points.length - 1].x, geo.topPad + geo.chartH);
    ctx.lineTo(geo.points[0].x, geo.topPad + geo.chartH);
    ctx.closePath();
    ctx.fillStyle = AREA_FILL;
    ctx.fill();

    // 线：#4f46e5 2dp（Web strokeWidth 2）
    ctx.beginPath();
    ctx.moveTo(mp.start.x, mp.start.y);
    mp.segments.forEach(function (s) {
      ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    });
    ctx.strokeStyle = AREA_COLOR;
    ctx.lineWidth = 2 * ds;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // X 轴日期标签 MM-DD（首尾 + 每 stride 个；居中钳制到画布内）
    ctx.fillStyle = colors.label;
    ctx.textBaseline = 'top';
    const n = days.length;
    geo.points.forEach(function (p, i) {
      if (i !== 0 && i !== n - 1 && i % stride !== 0) return;
      const label = String(days[i].date || '').slice(5);
      if (!label) return;
      const tw = ctx.measureText(label).width;
      const x = Math.min(Math.max(p.x - tw / 2, 0), W - tw);
      ctx.fillText(label, x, geo.topPad + geo.chartH + geo.labelGapY);
    });
  },

  // ==================== 免费锁定层（stats_report 场景承接） ====================

  onUnlock() {
    this.setData({ pmVisible: true });
  },

  onPmClose() {
    this.setData({ pmVisible: false });
  },

  onRetry() {
    this.fetchReport({ showLoading: true });
  },
});
