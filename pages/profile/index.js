/**
 * pages/profile/index.js — 「个人中心」主页
 *
 * UI 复刻 Android PersonalCenterScreen.kt（阶段 2 = 骨架 + 用户信息卡 + Tab 行；
 * 阶段 3 = 旅程数据 Tab：统计三卡 + 周活动面积图；里程碑/账号与安全随阶段 4/5）：
 *   - 顶部系统导航栏「个人中心」+ 下拉刷新（对齐 PullToRefreshBox）
 *   - HeaderCard：行布局 88dp 白描边头像 + 昵称/远行客徽章(secondary 橙)/两行签名/
 *     加入日期与国家元信息/整宽描边「编辑资料」钮 → pages/profile/edit
 *   - CenterTabRow：三等分 Tab，选中 primary Bold + 56×6rpx 下划线，底部 60% 分割线
 *   - 旅程数据：StatsOverview 三卡（累计里程/连续天数/词汇路标，图标底 tint 12%）+
 *     ActivityChartCard（本周/上周分段控件 + canvas 2d 面积图：Fritsch–Carlson
 *     单调曲线 + 15%→0% 渐变面积 + 白圈数据点 + 5 刻度无网格，recharts monotone 等价）
 *
 * canvas 真机红线（9568429 教训）：宽度禁百分比——onReady 按屏宽算术 px 显式定寸，
 * style 与 canvas width/height（×dpr + ctx.scale）双下发，首绘 120ms 后重绘一次保险。
 *
 * 数据逻辑（对齐 UserProfileViewModel）：
 *   - GET /api/user/profile → utils/profile-core.js mapProfile（嵌套 User 展平 +
 *     404 兜底合成最小资料，口径同 Android toFallbackProfile）
 *   - stats/weekly/achievements 并行拉取（单源失败不阻塞主资料）；weekOffset 0/1
 *     切换重拉 weekly-activity（对齐 viewModel.changeWeek）
 *   - 编辑保存后 globalData.profileDirty → onShow 静默重拉（对齐 profileRevision）
 *   - 错误态在卡内呈现「资料加载失败 + 点击重试」（Android HeaderCard 同口径）
 */
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const core = require('../../utils/profile-core');
const api = require('../../utils/api/profile');

/** 三 Tab（对齐 CenterTab 枚举顺序） */
const TABS = [
  { key: 'journey', label: '旅程数据' },
  { key: 'milestones', label: '里程碑' },
  { key: 'security', label: '账号与安全' },
];

/** 周活动图配色（主题令牌对应 hex；标签为 onSurfaceVariant 75%） */
const CHART_COLORS = {
  light: { primary: '#1f7a5c', label: 'rgba(87, 83, 78, 0.75)' },
  dark: { primary: '#4da989', label: 'rgba(168, 162, 158, 0.75)' },
};

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    // ---- 页级三态 ----
    isLoading: true, // 首载骨架（HeaderCard 内头像+三行 shimmer）
    needLogin: false,
    loadError: '', // 资料加载失败（卡内错误态，非页级拦断）
    // ---- 用户信息卡视图模型（core.mapProfile，WXML 零方法调用） ----
    profile: null,
    // ---- Tab 行 ----
    tabs: TABS,
    activeTab: 'journey',
    // ---- 旅程数据（阶段 3） ----
    statsLoading: false,
    statCards: [], // 三卡视图模型（值/单位/副文案/图标/色调类）
    activityLoading: false,
    weekOffset: 0, // 0 本周 / 1 上周
    weekly: [],
    chartW: 0, // canvas 显式算术 px（onReady 下发，真机红线）
    chartH: 0,
    // ---- 阶段 4 数据位（已并行拉取缓存） ----
    achievements: null,
  },

  onLoad() {
    this._loading = false;
    this._hasLoaded = false;
    this._weekLoading = false;
    this._dpScale = 0; // dp→px 系数（屏宽/375），onReady 计算
  },

  onReady() {
    // canvas 尺寸红线：显式算术 px（禁百分比），贯穿 style 与绘制
    const info = wx.getSystemInfoSync();
    const ww = info.windowWidth || 375;
    this._dpScale = ww / 375;
    this.setData({
      // 水平内缩 = 页 32×2 + 卡 40×2 = 144rpx
      chartW: Math.round((ww * (750 - 144)) / 750),
      chartH: Math.round((440 * ww) / 750),
    });
  },

  onShow() {
    // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申；
    // 生效主题变化时重建统计卡图标变体并重绘图表（canvas 取色即时主题）
    const __t = theme.getState();
    const themeChanged = this._lastThemeEffective && this._lastThemeEffective !== __t.effective;
    this._lastThemeEffective = __t.effective;
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    if (themeChanged) {
      if (this.data.stats) {
        this.setData({ statCards: this.buildStatCards(this.data.stats) });
      }
      this.requestChartDraw();
    }

    // 登录闸：入口是 mine 页已登录的用户信息卡，此为守门态
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, loadError: '' });
      this._hasLoaded = false;
      return;
    }

    // 首载全量拉取；编辑页保存（阶段 6）置 profileDirty → 返回后静默刷新
    if (!this._hasLoaded) {
      this.fetchAll({ showLoading: true });
    } else if (getApp().globalData.profileDirty) {
      getApp().globalData.profileDirty = false;
      this.fetchAll({ silent: true });
    }
  },

  onPullDownRefresh() {
    // 对齐 Android refresh()：静默重拉，失败保留旧数据
    this.fetchAll({ silent: true }).then(() => wx.stopPullDownRefresh());
  },

  // ==================== 数据获取（对齐 UserProfileViewModel.load） ====================

  async fetchAll(opts = {}) {
    if (this._loading) return;
    this._loading = true;
    const showLoading = opts.showLoading !== false;

    if (showLoading) {
      this.setData({
        isLoading: true,
        needLogin: false,
        loadError: '',
        statsLoading: true,
        activityLoading: true,
      });
    }

    // 主资料：主导卡内成功/错误态（404 已在 api 层归一为 null → mapProfile 兜底）
    const profileTask = api
      .getProfile()
      .then((raw) => {
        const vm = core.mapProfile(raw, authStore.getState().userInfo);
        this.setData({ profile: vm, loadError: vm ? '' : '资料加载失败' });
      })
      .catch(() => {
        this.setData({ profile: null, loadError: '资料加载失败' });
      });

    // 副三源：静默并行，单源失败仅留空（区块自判空态/骨架）
    const sideTasks = [
      api
        .getStatsOverview()
        .then((r) => {
          const stats = core.mapStats(r);
          this.setData({
            stats: stats,
            statsLoading: false,
            statCards: stats ? this.buildStatCards(stats) : [],
          });
        })
        .catch(() => {
          this.setData({ stats: null, statsLoading: false, statCards: [] });
        }),
      api
        .getWeeklyActivity(this.data.weekOffset)
        .then((r) => this.setData({ weekly: core.mapWeekly(r) }))
        .catch(() => {})
        .then(() => {
          this.setData({ activityLoading: false });
          this.requestChartDraw();
        }),
      api
        .getAchievements()
        .then((r) => this.setData({ achievements: core.mapAchievements(r) }))
        .catch(() => {}),
    ];

    await Promise.all([profileTask, ...sideTasks]);
    this._loading = false;
    this._hasLoaded = true;
    if (showLoading) {
      // 首载空白画布 BUG 修复：主内容（含图表 canvas）此刻才挂载——周数据可能先于
      // profile 落定，彼时 requestChartDraw 查不到尚未挂载的节点，必须在此补触发
      this.setData({ isLoading: false });
      this.requestChartDraw();
    }
  },

  /** 统计三卡视图模型（值/文案钉死对齐 StatsOverviewSection L511-549） */
  buildStatCards(stats) {
    const dark = this.data.dark;
    return [
      {
        key: 'km',
        label: '累计里程',
        value: stats.kmText,
        unit: 'km',
        subtext: stats.hoursText + 'h 精听',
        tintClass: 'tint-primary',
        icon: dark ? '/assets/icons/hiking-primary-dark.svg' : '/assets/icons/hiking-primary.svg',
      },
      {
        key: 'streak',
        label: '连续天数',
        value: String(stats.streakDays),
        unit: '天',
        subtext: '',
        tintClass: 'tint-secondary',
        icon: '/assets/icons/local-fire-department-accent.svg',
      },
      {
        key: 'words',
        label: '词汇路标',
        value: String(stats.wordsLearned),
        unit: '词',
        subtext: '',
        tintClass: 'tint-tertiary',
        icon: dark ? '/assets/icons/bookmark-tertiary-dark.svg' : '/assets/icons/bookmark-tertiary.svg',
      },
    ];
  },

  // ==================== 周活动图（ActivityChartCard L609-764） ====================

  /** 本周/上周分段控件（对齐 viewModel.changeWeek：切换即重拉） */
  async onChangeWeek(e) {
    const offset = Number(e.currentTarget.dataset.offset) === 1 ? 1 : 0;
    if (offset === this.data.weekOffset || this._weekLoading) return;
    this._weekLoading = true;
    this.setData({ weekOffset: offset, activityLoading: true });
    try {
      const r = await api.getWeeklyActivity(offset);
      this.setData({ weekly: core.mapWeekly(r) });
    } catch (err) {
      this.setData({ weekly: [] });
    }
    this.setData({ activityLoading: false });
    this._weekLoading = false;
    this.requestChartDraw();
  },

  /**
   * 触发图表重绘（token 作废旧循环）：
   * - 节点可能尚未挂载（首载主内容 wx:if 刚翻转 / Tab 刚切回 / 周切换 spinner→canvas），
   *   查不到节点时 120ms 重试、封顶 8 次（≈1s）——否则一次查空即永远停在空白画布；
   * - 绘制成功后再同参重绘一帧作真机首绘保险（attempt=-1，不再续订）。
   */
  requestChartDraw() {
    this._chartToken = (this._chartToken || 0) + 1;
    this.tryChartDraw(this._chartToken, 0);
  },

  tryChartDraw(token, attempt) {
    if (!this._chartToken || token !== this._chartToken) return; // 已有新请求，旧循环作废
    if (!this.data.chartW || !this.data.chartH) return;
    const weekly = this.data.weekly || [];
    const query = this.createSelectorQuery();
    query
      .select('#weeklyChart')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this._chartToken || token !== this._chartToken) return;
        const entry = res && res[0];
        if (!entry || !entry.node) {
          if (attempt >= 0 && attempt < 8) {
            setTimeout(() => this.tryChartDraw(token, attempt + 1), 120);
          }
          return;
        }
        this.drawWeeklyChart(entry.node, weekly);
        if (attempt >= 0) {
          // 真机首绘保险：成功后 120ms 同参重绘一帧（不再续订）
          setTimeout(() => this.tryChartDraw(token, -1), 120);
        }
      });
  },

  /** canvas 2d 面积图：几何/曲线全走 profile-core 纯函数，颜色取即时主题 */
  drawWeeklyChart(canvas, items) {
    const W = this.data.chartW;
    const H = this.data.chartH;
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!items || !items.length) return; // 空周数据不画（保留占位高度，Android 同口径）
    // 缓冲区是 W*dpr 设备像素、几何全是 CSS 逻辑像素——必须先 scale(dpr) 再画，
    // 否则内容全部挤在缓冲区左上 1/dpr 角（真机 dpr=3 实测左上 1/3）
    ctx.scale(dpr, dpr);

    const mode = theme.getState().effective === 'dark' ? 'dark' : 'light';
    const colors = CHART_COLORS[mode];
    const geo = core.chartGeometry(
      W,
      H,
      items.map(function (it) {
        return it.minutes;
      }),
      this._dpScale || W / 375
    );
    const fontPx = 10 * (this._dpScale || W / 375);
    ctx.font = fontPx + 'px sans-serif';

    // Y 轴 5 刻度（仅刻度无网格线，Android/Web 已移除 CartesianGrid）
    ctx.fillStyle = colors.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    geo.yTicks.forEach(function (t) {
      const tw = ctx.measureText(t.label).width;
      ctx.fillText(t.label, geo.leftPad - tw - geo.tickGapX, t.y);
    });

    // 单调平滑曲线（Fritsch–Carlson，严格过点、极值不过冲）
    const mp = core.monotonePath(geo.points);
    if (!mp.start) return;

    // 渐变面积（primary 15% → 0%）
    const area = ctx.createLinearGradient(0, geo.topPad, 0, geo.topPad + geo.chartH);
    area.addColorStop(0, colors.primary + '26'); // 0x26 ≈ 15%
    area.addColorStop(1, colors.primary + '00');
    ctx.beginPath();
    ctx.moveTo(mp.start.x, mp.start.y);
    mp.segments.forEach(function (s) {
      ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    });
    ctx.lineTo(geo.points[geo.points.length - 1].x, geo.topPad + geo.chartH);
    ctx.lineTo(geo.points[0].x, geo.topPad + geo.chartH);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    // 线：primary 2.5dp 圆端圆拐
    ctx.beginPath();
    ctx.moveTo(mp.start.x, mp.start.y);
    mp.segments.forEach(function (s) {
      ctx.bezierCurveTo(s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    });
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = geo.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 数据点：白圈 4dp + primary 实心 3dp（Web dot r3 stroke white 2 等价）
    geo.points.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, geo.dotOuter, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, geo.dotInner, 0, Math.PI * 2);
      ctx.fillStyle = colors.primary;
      ctx.fill();
    });

    // X 轴星期标签（服务端中文，居中钳制到画布内）
    ctx.fillStyle = colors.label;
    ctx.textBaseline = 'top';
    geo.points.forEach(function (p, i) {
      const label = items[i].day || '';
      const tw = ctx.measureText(label).width;
      const x = Math.min(Math.max(p.x - tw / 2, 0), W - tw);
      ctx.fillText(label, x, geo.topPad + geo.chartH + geo.labelGapY);
    });
  },

  // ==================== 交互 ====================

  /** Tab 切换（本地态，不重拉；面板 wx:if 重建触发进出场动画；旅程页重挂 canvas） */
  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.activeTab) return;
    this.setData({ activeTab: key });
    if (key === 'journey') this.requestChartDraw();
  },

  /** 编辑资料 → 全屏编辑页（阶段 6 实现） */
  onOpenEdit() {
    wx.navigateTo({ url: '/pages/profile/edit' });
  },

  /** 卡内错误态重试（对齐 HeaderCard onRetry） */
  onRetry() {
    this.fetchAll({ showLoading: true });
  },

  /** 未登录守门态 → 登录页 */
  onLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
});
