/**
 * 个人中心：用户资料、勋章墙与账号安全。
 * 资料编辑后按 profileDirty 静默刷新。
 */
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const core = require('../../utils/profile-core');
const api = require('../../utils/api/profile');
const { FILTERS, buildMedals, showMedals } = require('./badge-wall');
const { THEMES, drawBadgePoster } = require('./badge-poster');

const TABS = [
  { key: 'badges', label: '勋章墙' },
  { key: 'security', label: '账号与安全' },
];

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
    activeTab: TABS[0].key,
    medalFilters: FILTERS,
    medalDimension: 'all',
    medals: [],
    shownMedals: [],
    selectedMedal: null,
    medalStats: null,
    litCount: 0,
    medalsLoading: false,
    medalsError: '',
    posterOpen: false,
    posterTheme: THEMES[0].key,
    posterThemes: THEMES.map(({ key, label }) => ({ key, label })),
    posterReady: false,
    posterBusy: false,
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
  },

  onShow() {
    const appearance = theme.getState();
    this.setData({ themeClass: appearance.rootClass, dark: appearance.effective === 'dark' });
    theme.applyChrome();

    // 登录闸：入口是 mine 页已登录的用户信息卡，此为守门态
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, loadError: '' });
      this._hasLoaded = false;
      if (this.data.posterOpen) this.onCloseBadgePoster();
      this.setData({ medals: [], shownMedals: [], selectedMedal: null, medalStats: null, litCount: 0 });
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

  onUnload() {
    this._posterCanvas = null;
    this._unloaded = true;
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
    const showLoading = !opts.silent && opts.showLoading !== false;

    if (showLoading) {
      this.setData({
        isLoading: true,
        needLogin: false,
        loadError: '',
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

    await Promise.all([profileTask, this.loadMedals()]);
    this._loading = false;
    this._hasLoaded = true;
    if (showLoading) this.setData({ isLoading: false });
  },

  async loadMedals() {
    if (this.data.medalsLoading) return;
    this.setData({ medalsLoading: true, medalsError: '' });
    try {
      const [raw, streak, stats] = await Promise.all([
        api.getAchievements(),
        api.getStreakStatus().catch(() => null),
        api.getStatsOverview().then(core.mapStats).catch(() => null),
      ]);
      if (!Array.isArray(raw)) throw new Error('Bad achievements response');
      if (this._unloaded || !authStore.getState().isLoggedIn) return;
      const previous = this.data.medalStats;
      const medalStats = stats || previous || streak ? {
        ...(stats || previous), streakDays: streak ? streak.streakDays : previous && previous.streakDays,
      } : null;
      const achievements = core.mapAchievements(raw);
      const medals = buildMedals(achievements.items, medalStats);
      const selected = this.data.selectedMedal;
      this.setData({
        medals,
        medalStats,
        litCount: achievements.unlockedCount,
        ...showMedals(medals, this.data.medalDimension, selected && selected.id),
      });
      if (this.data.posterOpen && this._posterCanvas) this.paintBadgePoster();
    } catch (err) {
      if (!this._unloaded) this.setData({ medalsError: '成就加载失败，请重试' });
    } finally {
      if (!this._unloaded) this.setData({ medalsLoading: false });
    }
  },

  onRefreshMedals() {
    return this.loadMedals();
  },

  onMedalFilter(e) {
    const dimension = e.currentTarget.dataset.key;
    if (dimension === this.data.medalDimension || !FILTERS.some((filter) => filter.key === dimension)) return;
    const selected = this.data.selectedMedal;
    this.setData({
      medalDimension: dimension,
      ...showMedals(this.data.medals, dimension, selected && selected.id),
    });
  },

  onSelectMedal(e) {
    const medal = this.data.shownMedals.find((item) => item.id === e.currentTarget.dataset.id);
    if (medal) this.setData({ selectedMedal: medal });
  },

  onOpenBadgePoster() {
    if (this.data.posterOpen || !this.data.medals.length) return;
    const request = {};
    this._posterRequest = request;
    this.setData({ posterOpen: true, posterReady: false }, () => {
      this.createSelectorQuery().select('#badgePoster').fields({ node: true }).exec((res) => {
        if (this._posterRequest !== request || this._unloaded) return;
        this._posterCanvas = res && res[0] && res[0].node;
        if (this._posterCanvas) this.paintBadgePoster();
        else {
          this.onCloseBadgePoster();
          wx.showToast({ title: '海报预览暂不可用', icon: 'none' });
        }
      });
    });
  },

  paintBadgePoster() {
    try {
      drawBadgePoster(this._posterCanvas, this.data.posterTheme, this.data.medalStats, this.data.medals);
      if (!this.data.posterReady) this.setData({ posterReady: true });
    } catch (err) {
      this.onCloseBadgePoster();
      wx.showToast({ title: '海报预览暂不可用', icon: 'none' });
    }
  },

  onPosterTheme(e) {
    const key = e.currentTarget.dataset.key;
    if (this.data.posterBusy || key === this.data.posterTheme || !THEMES.some((theme) => theme.key === key)) return;
    this.setData({ posterTheme: key });
    if (this._posterCanvas) this.paintBadgePoster();
  },

  onCloseBadgePoster() {
    this._posterRequest = null;
    this._posterCanvas = null;
    this.setData({ posterOpen: false, posterReady: false, posterBusy: false });
  },

  onExportBadgePoster(e) {
    const canvas = this._posterCanvas;
    if (!canvas || this.data.posterBusy) return;
    const share = e.currentTarget.dataset.action === 'share';
    this.setData({ posterBusy: true });
    const isCurrent = () => this._posterCanvas === canvas && !this._unloaded;
    const finish = () => {
      if (isCurrent()) this.setData({ posterBusy: false });
    };
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'png',
      success: ({ tempFilePath }) => {
        if (!isCurrent()) return;
        if (share) {
          if (wx.showShareImageMenu) {
            wx.showShareImageMenu({ path: tempFilePath, complete: finish });
          } else {
            wx.previewImage({ urls: [tempFilePath], complete: finish });
          }
        } else {
          wx.saveImageToPhotosAlbum({
            filePath: tempFilePath,
            success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
            fail: (err) => {
              if (err && /auth|deny|denied/i.test(err.errMsg || '')) {
                wx.previewImage({ urls: [tempFilePath] });
              } else {
                wx.showToast({ title: '保存失败，请重试', icon: 'none' });
              }
            },
            complete: finish,
          });
        }
      },
      fail: () => {
        if (isCurrent()) wx.showToast({ title: '海报生成失败', icon: 'none' });
        finish();
      },
    });
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab || !TABS.some((tab) => tab.key === key)) return;
    this.setData({ activeTab: key });
  },

  /** 编辑资料 → 全屏编辑页（阶段 6 实现） */
  onOpenEdit() {
    wx.navigateTo({ url: '/pages/profile/edit' });
  },

  /** 卡内错误态重试（对齐 HeaderCard onRetry） */
  onRetry() {
    this.fetchAll({ showLoading: true });
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
