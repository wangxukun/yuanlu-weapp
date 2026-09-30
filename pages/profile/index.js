/**
 * pages/profile/index.js — 「个人中心」主页
 *
 * UI 复刻 Android PersonalCenterScreen.kt（阶段 2 = 骨架 + 用户信息卡 + Tab 行；
 * 阶段 3 = 旅程数据 Tab：统计三卡 + 周活动面积图；阶段 4 = 里程碑 Tab：远路里程碑
 * Canvas 路图（圆点虚线全程 + 已完成段按进度截取 + 冲线三角旗 + 进度脉冲点 RAF）
 * + 成就墙网格（排序 take(8)、emoji 直渲）；阶段 5 = 账号与安全 Tab：四卡 +
 * 绑定手机/邮箱底部弹层（发码倒计时/密码强度三项/乐观回写）+ 注销二次确认）：
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
const membershipStore = require('../../store/membershipStore');
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

/** 里程碑路图配色（MilestoneStrip L870-875：outline/surface/70%/45% 标签派生；secondary 深浅同值） */
const MS_COLORS = {
  light: {
    primary: '#1f7a5c',
    secondary: '#d98a17',
    outline: '#e3ddcf',
    surface: '#ffffff',
    labelDim: 'rgba(87, 83, 78, 0.7)',
    labelFaint: 'rgba(87, 83, 78, 0.45)',
  },
  dark: {
    primary: '#4da989',
    secondary: '#d98a17',
    outline: '#38332a',
    surface: '#1e1b16',
    labelDim: 'rgba(168, 162, 158, 0.7)',
    labelFaint: 'rgba(168, 162, 158, 0.45)',
  },
};

/** hex → rgba（脉冲圈 primary 半透明，milestonePulsePoint.alpha） */
function rgbaFromHex(hex, alpha) {
  const v = parseInt(String(hex).replace('#', ''), 16);
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + alpha + ')';
}

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
    // ---- 学习报表入口卡（阶段 8：权限双文案副标题） ----
    isPremium: false, // membershipStore 快照；onShow refreshMembership 校正
    reportEntryIcon: '/assets/icons/bar-chart-primary.svg',
    reportArrowIcon: '/assets/icons/keyboard-arrow-right-primary.svg',
    // ---- 里程碑 Tab（阶段 4） ----
    msH: 0, // 路图 canvas 高（256rpx 换算 px，onReady 下发）
    msKmText: '0.0', // 卡头胶囊 formatKm(totalKm)（stats 缺失按 0）
    achievementsLoading: false,
    achievements: null, // { items, unlockedCount }（mapAchievements）
    achTiles: [], // 排序后前 8（页面展示口径，Android take(8)）
    // ---- 账号与安全（阶段 5；SecurityFormState 等价，WXML 零方法调用） ----
    securitySheet: '', // '' | 'phone' | 'email'（页内底部弹层）
    bindForm: {
      phone: '',
      email: '',
      code: '',
      password: '',
      confirmPassword: '',
      passwordVisible: false,
      isSendingCode: false,
      isSubmitting: false,
      countdownSeconds: 0,
      notice: '',
      error: '',
    },
    bindUi: {
      criteria: { length: false, hasLetter: false, hasNumber: false, allMet: false },
      confirmMatch: false,
      canSendCode: false,
      submitEnabled: false,
    },
    deleteConfirmOpen: false,
    deletingAccount: false,
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
      msH: Math.round((256 * ww) / 750), // 里程碑 canvas 128dp
    });
  },

  onShow() {
    // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申；
    // 生效主题变化时重建统计卡图标变体并重绘图表（canvas 取色即时主题）
    const __t = theme.getState();
    const themeChanged = this._lastThemeEffective && this._lastThemeEffective !== __t.effective;
    this._lastThemeEffective = __t.effective;
    this.setData(
      Object.assign(
        { themeClass: __t.rootClass, dark: __t.effective === 'dark' },
        this.buildReportEntryIcons(__t.effective === 'dark'),
      ),
    );
    theme.applyChrome();
    if (themeChanged) {
      if (this.data.stats) {
        this.setData({ statCards: this.buildStatCards(this.data.stats) });
      }
      this.requestChartDraw();
      if (this.data.activeTab === 'milestones') this.requestMilestoneDraw();
    }

    // 登录闸：入口是 mine 页已登录的用户信息卡，此为守门态
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, loadError: '', isPremium: false });
      this._hasLoaded = false;
      return;
    }

    // 学习报表入口卡副标题口径：乐观快照先行 + subscription/status 静默校正
    // （会员判定事实在订阅表，role 展示缓存不作数——与锁态校正同款红线）
    this.setData({ isPremium: membershipStore.getState().isPremium });
    membershipStore.ensureFresh().then((s) => {
      if (s && s.isPremium !== this.data.isPremium) {
        this.setData({ isPremium: s.isPremium });
      }
    });

    // 首载全量拉取；编辑页保存（阶段 6）置 profileDirty → 返回后静默刷新
    if (!this._hasLoaded) {
      this.fetchAll({ showLoading: true });
    } else if (getApp().globalData.profileDirty) {
      getApp().globalData.profileDirty = false;
      this.fetchAll({ silent: true });
    } else if (this.data.activeTab === 'milestones' && this.data.stats) {
      // onHide 已停脉冲动画：回前台续跑（数据在，仅重挂绘制）
      this.requestMilestoneDraw();
    }
  },

  /** 后台/卸载必须停脉冲 RAF（后台耗电 + 回显重影，任务清单 T7.3 红线） */
  onHide() {
    this.stopMilestoneAnim();
  },

  onUnload() {
    this.stopMilestoneAnim();
    this.stopCountdown();
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
        achievementsLoading: true,
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
            msKmText: stats ? stats.kmText : '0.0',
          });
          if (this.data.activeTab === 'milestones') this.requestMilestoneDraw();
        })
        .catch(() => {
          this.setData({ stats: null, statsLoading: false, statCards: [], msKmText: '0.0' });
          if (this.data.activeTab === 'milestones') this.requestMilestoneDraw();
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
        .then((r) => {
          const ach = core.mapAchievements(r);
          this.setData({
            achievements: ach,
            achTiles: ach.items.slice(0, 8), // Android take(8)，4 列两行
            achievementsLoading: false,
          });
        })
        .catch(() => this.setData({ achievementsLoading: false })),
    ];

    await Promise.all([profileTask, ...sideTasks]);
    this._loading = false;
    this._hasLoaded = true;
    if (showLoading) {
      // 首载空白画布 BUG 修复：主内容（含图表 canvas）此刻才挂载——周数据可能先于
      // profile 落定，彼时 requestChartDraw 查不到尚未挂载的节点，必须在此补触发
      this.setData({ isLoading: false });
      this.requestChartDraw();
      if (this.data.activeTab === 'milestones') this.requestMilestoneDraw();
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

  // ==================== 学习报表入口卡（阶段 8） ====================

  /** 入口卡图标变体（主题切换即时换肤） */
  buildReportEntryIcons(dark) {
    return {
      reportEntryIcon: dark
        ? '/assets/icons/bar-chart-primary-dark.svg'
        : '/assets/icons/bar-chart-primary.svg',
      reportArrowIcon: dark
        ? '/assets/icons/keyboard-arrow-right-primary-dark.svg'
        : '/assets/icons/keyboard-arrow-right-primary.svg',
    };
  },

  onOpenLearningReport() {
    wx.navigateTo({ url: '/pages/profile/learning-report/index' });
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

  // ==================== 里程碑路图（MilestoneStrip L866-993） ====================

  /** 触发路图重绘（token 作废旧循环 + 停旧脉冲；挂载重试 120ms×8 + 保险帧同周图） */
  requestMilestoneDraw() {
    this._msToken = (this._msToken || 0) + 1;
    this.stopMilestoneRaf();
    this.tryMilestoneDraw(this._msToken, 0);
  },

  tryMilestoneDraw(token, attempt) {
    if (!this._msToken || token !== this._msToken) return;
    if (!this.data.chartW || !this.data.msH) return;
    const query = this.createSelectorQuery();
    query
      .select('#milestoneChart')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!this._msToken || token !== this._msToken) return;
        const entry = res && res[0];
        if (!entry || !entry.node) {
          if (attempt >= 0 && attempt < 8) {
            setTimeout(() => this.tryMilestoneDraw(token, attempt + 1), 120);
          }
          return;
        }
        this.drawMilestoneChart(entry.node, this.data.stats);
        if (attempt >= 0) {
          setTimeout(() => this.tryMilestoneDraw(token, -1), 120); // 真机首绘保险帧
        }
      });
  },

  /** 停脉冲动画并作废在途绘制/重试（onHide/onUnload/切走 Tab） */
  stopMilestoneAnim() {
    this._msToken = (this._msToken || 0) + 1;
    this.stopMilestoneRaf();
  },

  stopMilestoneRaf() {
    if (this._msRafId != null && this._msCanvas && this._msCanvas.cancelAnimationFrame) {
      try {
        this._msCanvas.cancelAnimationFrame(this._msRafId);
      } catch (err) {
        /* 节点已销毁（页面卸载竞态）——忽略 */
      }
    }
    this._msRafId = null;
  },

  /**
   * 里程碑路图 canvas 2d：全程圆点虚线（outline）+ 已完成段 primary 实线
   * （quadMidPath 采样折线按 progressRatio 截取，PathMeasure+dash 裁剪等价）+
   * 节点（达成实心+secondary 冲线三角旗 / 未达成空心）+ 双侧标签 + 进度脉冲点
   * （0<km<全程 时 canvas.requestAnimationFrame 2s 线性循环，token 作废即停）。
   */
  drawMilestoneChart(canvas, stats) {
    this.stopMilestoneRaf();
    this._msCanvas = canvas;
    const W = this.data.chartW;
    const H = this.data.msH;
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    const mode = theme.getState().effective === 'dark' ? 'dark' : 'light';
    const colors = MS_COLORS[mode];
    const ds = this._dpScale || W / 375;
    const geo = core.milestoneGeometry(W, H, ds);
    const km = stats ? stats.totalKm : 0;
    const reached = core.milestoneReached(km);
    const kmTexts = core.milestoneKmTexts();
    const ratio = core.milestoneProgress(km);
    const smooth = core.quadMidPath(geo.xs, geo.ys);
    const sampled = core.sampleQuadPath(smooth, 48); // 供长度测量与截取
    const done = ratio > 0 ? core.clipPolyline(sampled, ratio) : [];

    const render = function (pulsePoint) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // 缓冲区为设备像素、几何为逻辑像素——先 scale 再画（真机挤左上坑）
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 全程圆点虚线（outline 2.5dp 圆端；0.1 长度 + 9dp 间隔，圆端帽成点）
      if (smooth.start) {
        ctx.beginPath();
        ctx.moveTo(smooth.start.x, smooth.start.y);
        smooth.quads.forEach(function (q) {
          ctx.quadraticCurveTo(q.cx, q.cy, q.x, q.y);
        });
        ctx.lineTo(smooth.end.x, smooth.end.y);
        ctx.setLineDash(geo.dash);
        ctx.strokeStyle = colors.outline;
        ctx.lineWidth = geo.strokeWidth;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 已完成段实线（primary，按进度截取）
      if (done.length > 1) {
        ctx.beginPath();
        ctx.moveTo(done[0].x, done[0].y);
        for (let i = 1; i < done.length; i++) ctx.lineTo(done[i].x, done[i].y);
        ctx.strokeStyle = colors.primary;
        ctx.lineWidth = geo.strokeWidth;
        ctx.stroke();
      }

      // 节点 + 冲线旗 + 标签（名称在下、km 在上）
      ctx.textAlign = 'center';
      core.MILESTONES.forEach(function (m, i) {
        const x = geo.xs[i];
        const y = geo.ys[i];
        ctx.setLineDash([]);
        if (reached[i]) {
          ctx.beginPath();
          ctx.arc(x, y, geo.nodeRadius, 0, Math.PI * 2);
          ctx.fillStyle = colors.primary;
          ctx.fill();
          const fp = core.milestoneFlagPoints(x, y, geo);
          ctx.beginPath();
          ctx.moveTo(fp[0].x, fp[0].y);
          for (let k = 1; k < fp.length; k++) ctx.lineTo(fp[k].x, fp[k].y);
          ctx.closePath();
          ctx.fillStyle = colors.secondary;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, geo.nodeRadius, 0, Math.PI * 2);
          ctx.fillStyle = colors.surface;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, geo.nodeRadius, 0, Math.PI * 2);
          ctx.strokeStyle = colors.outline;
          ctx.lineWidth = geo.hollowStroke;
          ctx.stroke();
        }
        // 名称（节点下 y+r+6dp）：达成 primary SemiBold 10sp / 未达成 70%
        ctx.textBaseline = 'top';
        ctx.font = (reached[i] ? '600 ' : '') + 10 * ds + 'px sans-serif';
        ctx.fillStyle = reached[i] ? colors.primary : colors.labelDim;
        ctx.fillText(m.name, x, y + geo.nodeRadius + geo.labelBelow);
        // km（上方 y-r-15dp / y-r-7dp，bottom 基线等价 Kotlin 减文字高）：达成 secondary / 未达成 45%
        ctx.textBaseline = 'bottom';
        ctx.font = (reached[i] ? '500 ' : '') + 9 * ds + 'px sans-serif';
        ctx.fillStyle = reached[i] ? colors.secondary : colors.labelFaint;
        ctx.fillText(kmTexts[i], x, y - geo.nodeRadius - (reached[i] ? geo.kmAboveReached : geo.kmAboveLocked));
      });

      // 当前进度脉冲点（呼吸圈 + 实心 4dp）
      if (pulsePoint) {
        ctx.beginPath();
        ctx.arc(pulsePoint.x, pulsePoint.y, pulsePoint.radius, 0, Math.PI * 2);
        ctx.fillStyle = rgbaFromHex(colors.primary, pulsePoint.alpha);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pulsePoint.x, pulsePoint.y, pulsePoint.dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = colors.primary;
        ctx.fill();
      }
    };

    render(null);

    // 脉冲动画：仅 0 < km < 全程 启动（满程/零里程静态一帧）；token 作废即停
    if (km > 0 && km < core.MILESTONE_TOTAL_KM && canvas.requestAnimationFrame) {
      const token = this._msToken;
      const started = Date.now();
      const self = this;
      const frame = function () {
        if (!self._msToken || token !== self._msToken) return;
        const p = ((Date.now() - started) % 2000) / 2000;
        render(core.milestonePulsePoint(km, geo, p));
        self._msRafId = canvas.requestAnimationFrame(frame);
      };
      this._msRafId = canvas.requestAnimationFrame(frame);
    }
  },

  // ==================== 交互 ====================

  /** Tab 切换（本地态，不重拉；面板 wx:if 重建触发进出场动画；canvas 挂载态随 Tab 重建） */
  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.activeTab) return;
    const leaving = this.data.activeTab;
    this.setData({ activeTab: key });
    if (leaving === 'milestones') this.stopMilestoneAnim(); // 脉冲随画布卸载必须停
    if (key === 'journey') this.requestChartDraw();
    if (key === 'milestones') this.requestMilestoneDraw();
  },

  /** 编辑资料 → 全屏编辑页（阶段 6 实现） */
  onOpenEdit() {
    wx.navigateTo({ url: '/pages/profile/edit' });
  },

  /** 卡内错误态重试（对齐 HeaderCard onRetry） */
  onRetry() {
    this.fetchAll({ showLoading: true });
  },

  /** 全部查看 → snackbar 同文案 toast（Android 不建独立页，成就墙规划即此一格） */
  onAllAchievements() {
    wx.showToast({ title: '完整成就墙 即将上线', icon: 'none' });
  },

  // ==================== 账号与安全（SecuritySection + BindAccountSheets + 注销，阶段 5） ====================

  /** 弹层/遮罩 catchtap 占位（catchtap 空串不生效坑，须实名 handler） */
  noop() {},

  /** 绑定派生重算（强度三项/两密一致/发码与提交可用性——WXML 零方法调用红线） */
  recomputeBindDerived() {
    const f = this.data.bindForm;
    const c = core.passwordCriteria(f.password);
    const criteria = {
      length: c.length,
      hasLetter: c.hasLetter,
      hasNumber: c.hasNumber,
      allMet: c.length && c.hasLetter && c.hasNumber,
    };
    const confirmMatch = f.confirmPassword.length > 0 && f.password === f.confirmPassword;
    const sheet = this.data.securitySheet;
    let submitEnabled = false;
    if (sheet === 'phone') {
      submitEnabled = !f.isSubmitting && f.phone.length === 11 && f.code.length === 6;
    } else if (sheet === 'email') {
      submitEnabled = !f.isSubmitting && f.code.length === 6 && criteria.allMet && confirmMatch;
    }
    this.setData({
      bindUi: {
        criteria: criteria,
        confirmMatch: confirmMatch,
        canSendCode: sheet === 'phone'
          ? core.validateBindPhone(f.phone) == null
          : core.validateBindEmail(f.email) == null,
        submitEnabled: submitEnabled,
      },
    });
  },

  /** 重置绑定表单（开弹层/提交成功后，SecurityFormState() 等价） */
  resetBindForm() {
    this.stopCountdown();
    this.setData({
      bindForm: {
        phone: '',
        email: '',
        code: '',
        password: '',
        confirmPassword: '',
        passwordVisible: false,
        isSendingCode: false,
        isSubmitting: false,
        countdownSeconds: 0,
        notice: '',
        error: '',
      },
    });
    this.recomputeBindDerived();
  },

  onOpenBindPhone() {
    this.resetBindForm();
    this.setData({ securitySheet: 'phone' });
    this.recomputeBindDerived(); // sheet 落定后重算（canSendCode 分派依赖它）
  },

  onOpenBindEmail() {
    this.resetBindForm();
    this.setData({ securitySheet: 'email' });
    this.recomputeBindDerived();
  },

  onCloseSheet() {
    if (this.data.bindForm.isSubmitting) return; // 提交中不允许关闭（VM 同口径）
    this.setData({ securitySheet: '' });
    // 对齐 VM closeSecuritySheet：停倒计时 + 整表单重置（SecurityFormState()）
    this.resetBindForm();
  },

  /** 手机号输入：过滤非数字、截 11 位、清 error（VM onPhoneChange 口径） */
  onPhoneInput(e) {
    const v = String((e.detail || {}).value || '').replace(/\D/g, '').slice(0, 11);
    this.setData({ 'bindForm.phone': v, 'bindForm.error': '' });
    this.recomputeBindDerived();
  },

  /** 邮箱输入：trim（VM 口径） */
  onEmailInput(e) {
    const v = String((e.detail || {}).value || '').trim();
    this.setData({ 'bindForm.email': v, 'bindForm.error': '' });
    this.recomputeBindDerived();
  },

  /** 验证码输入：过滤非数字、截 6 位 */
  onCodeInput(e) {
    const v = String((e.detail || {}).value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({ 'bindForm.code': v, 'bindForm.error': '' });
    this.recomputeBindDerived();
  },

  onPasswordInput(e) {
    this.setData({ 'bindForm.password': String((e.detail || {}).value || ''), 'bindForm.error': '' });
    this.recomputeBindDerived();
  },

  onConfirmPasswordInput(e) {
    this.setData({ 'bindForm.confirmPassword': String((e.detail || {}).value || ''), 'bindForm.error': '' });
    this.recomputeBindDerived();
  },

  onTogglePasswordVisible() {
    this.setData({ 'bindForm.passwordVisible': !this.data.bindForm.passwordVisible });
  },

  /** 60s 发码倒计时（时间戳驱动，真机后台冻结回前台不跳变累计误差） */
  startCountdown() {
    this.stopCountdown();
    this._countdownEnd = Date.now() + 60000;
    this.setData({ 'bindForm.countdownSeconds': 60 });
    this._countdownTimer = setInterval(() => {
      const remaining = Math.ceil((this._countdownEnd - Date.now()) / 1000);
      if (remaining <= 0) {
        this.stopCountdown();
        this.setData({ 'bindForm.countdownSeconds': 0 });
      } else {
        this.setData({ 'bindForm.countdownSeconds': remaining });
      }
    }, 1000);
  },

  stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  },

  /** 网络类失败文案对齐 Android Result.NetworkError */
  netOrMessage(err, fallback) {
    if (err && err.statusCode === 0) return '网络连接失败，请重试';
    return (err && err.message) || fallback;
  },

  /** 发送验证码（手机 scene=BIND / 邮箱 bind-email/send；成功 notice + 倒计时） */
  async onSendCode() {
    const f = this.data.bindForm;
    if (f.isSendingCode || f.countdownSeconds > 0) return;
    const isPhone = this.data.securitySheet === 'phone';
    const invalid = isPhone ? core.validateBindPhone(f.phone) : core.validateBindEmail(f.email);
    if (invalid) {
      this.setData({ 'bindForm.error': invalid });
      return;
    }
    this.setData({ 'bindForm.isSendingCode': true, 'bindForm.error': '', 'bindForm.notice': '' });
    try {
      if (isPhone) {
        await api.sendBindPhoneCode(f.phone);
        this.setData({ 'bindForm.isSendingCode': false, 'bindForm.notice': '验证码发送成功' });
      } else {
        await api.sendBindEmailCode(f.email);
        this.setData({
          'bindForm.isSendingCode': false,
          'bindForm.notice': '验证码已发送，请检查您的邮箱',
        });
      }
      this.startCountdown();
    } catch (err) {
      this.setData({
        'bindForm.isSendingCode': false,
        'bindForm.error': this.netOrMessage(err, '验证码发送失败，请稍后重试'),
      });
    }
  },

  /** 提交绑定（校验链文案照抄 VM；成功乐观回写 profile 不整页重拉——JWT 旧值口径） */
  async onSubmitBind() {
    const f = this.data.bindForm;
    if (f.isSubmitting) return;
    const isPhone = this.data.securitySheet === 'phone';
    if (isPhone) {
      const invalid = core.validateBindPhone(f.phone);
      if (invalid) {
        this.setData({ 'bindForm.error': invalid });
        return;
      }
      if (f.code.length !== 6) {
        this.setData({ 'bindForm.error': '请输入6位验证码' });
        return;
      }
    } else {
      const invalid = core.validateBindEmail(f.email);
      if (invalid) {
        this.setData({ 'bindForm.error': invalid });
        return;
      }
      if (f.code.length !== 6) {
        this.setData({ 'bindForm.error': '请输入6位邮箱验证码' });
        return;
      }
      if (!this.data.bindUi.criteria.allMet) {
        this.setData({ 'bindForm.error': '密码未达到强度要求' });
        return;
      }
      if (!this.data.bindUi.confirmMatch) {
        this.setData({ 'bindForm.error': '两次输入的密码不一致' });
        return;
      }
    }
    this.setData({ 'bindForm.isSubmitting': true, 'bindForm.error': '', 'bindForm.notice': '' });
    try {
      const old = this.data.profile || {};
      let patch;
      if (isPhone) {
        await api.bindPhone(f.phone, f.code);
        // 乐观回写：phone + 脱敏重算 + hasPhone（JWT 签发于绑定前，重拉反而丢失）
        patch = { phone: f.phone, phoneMasked: core.maskPhone(f.phone), hasPhone: true };
        wx.showToast({ title: '绑定成功', icon: 'none' });
      } else {
        await api.bindEmailConfirm(f.email, f.code, f.password);
        patch = {
          email: f.email,
          emailMasked: core.maskEmail(f.email),
          hasRealEmail: true,
          passwordSet: true, // 绑定邮箱同时设置登录密码
        };
        wx.showToast({ title: '邮箱绑定成功', icon: 'none' });
      }
      this.stopCountdown();
      this.setData({ securitySheet: '', profile: Object.assign({}, old, patch) });
      this.resetBindForm();
    } catch (err) {
      this.setData({
        'bindForm.isSubmitting': false,
        'bindForm.error': this.netOrMessage(err, '绑定失败，请稍后重试'),
      });
    }
  },

  // ---- 注销（DeleteAccountConfirmDialog + VM deleteAccount） ----

  onOpenDeleteConfirm() {
    this.setData({ deleteConfirmOpen: true });
  },

  /** 注销请求进行中不允许关闭（防重复提交） */
  onCloseDeleteConfirm() {
    if (this.data.deletingAccount) return;
    this.setData({ deleteConfirmOpen: false });
  },

  /** 确认注销：DELETE → logout → toast → 约 1.2s 后 navigateBack 回 mine 游客态 */
  async onConfirmDelete() {
    if (this.data.deletingAccount) return;
    this.setData({ deletingAccount: true });
    try {
      await api.deleteSelfAccount();
      authStore.logout();
      this.stopCountdown();
      this.setData({ deletingAccount: false, deleteConfirmOpen: false, accountDeleted: true });
      wx.showToast({ title: '账号已成功注销', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err) {
      this.setData({ deletingAccount: false, deleteConfirmOpen: false });
      wx.showToast({ title: this.netOrMessage(err, '注销失败，请稍后重试'), icon: 'none' });
    }
  },

  /** 未登录守门态 → 登录页 */
  onLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
});
