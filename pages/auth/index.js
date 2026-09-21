/**
 * pages/auth/index.js — 登录 / 注册页逻辑
 *
 * 状态机逐条移植自 Android 端 feature/auth/LoginViewModel.kt 的 LoginUiState：
 *   - isLoading / error / isSuccess：登录与注册请求的加载、行内错误、成功态；
 *   - isSending / countdownSeconds：验证码发送中与 60s 倒计时（防重入）；
 *   - isRegisterMode：邮箱 Tab 内部「登录 ⇄ 注册」表单切换（注册仅存在于邮箱 Tab）；
 *   - notice：非侵扰提示（「注册成功，正在自动登录」），primary 色区别于 error。
 *
 * 表单字段对齐 LoginSheet.kt 的本地状态：
 *   - account：手机号 / 邮箱共用（切 Tab 一并清空）；
 *   - credential：短信验证码 / 邮箱验证码 / 邮箱登录密码复用（切模式时清空）；
 *   - registerPassword / registerConfirm：邮箱注册的密码与确认密码。
 *
 * 业务闭环（经 utils/api/auth.js → 真实后端）：
 *   发码（短信 / 邮箱）→ 倒计时；手机验证码登录（自动建号）；
 *   邮箱注册（verify-code → sign-up）成功后用同一凭据自动登录；
 *   登录成功 → authStore.setLoginData 落库 token（订阅页自动刷新）→ 路由回退。
 */

const authService = require('../../utils/api/auth');
const { USER_AGREEMENT, PRIVACY_POLICY } = require('./agreement');

/** 宽松邮箱格式：局部@域名（对齐 Android EMAIL_REGEX 的前端校验强度） */
const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Page({
  data: {
    // ---- 表单模式 ----
    activeTab: 'phone', // 'phone' | 'email'（对齐 isPhoneMode）
    isRegisterMode: false, // 邮箱 Tab 内部：false=登录（默认）/ true=注册
    // ---- 表单字段（对齐 LoginSheet 的本地状态） ----
    account: '',
    credential: '',
    registerPassword: '',
    registerConfirm: '',
    passwordVisible: false,
    agreed: false,
    focusField: '', // 当前聚焦输入框（描边高亮）
    // ---- 协议全文弹层 ----
    agreementDoc: null,
    // ---- LoginUiState ----
    isLoading: false,
    isSending: false,
    countdownSeconds: 0,
    notice: '',
    error: '',
  },

  countdownTimer: null,

  // ==================== Tab 与模式切换 ====================

  /** 双 Tab 切换：清空全部表单字段并回到登录表单（注册态仅存在于邮箱 Tab） */
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;
    this.setData({
      activeTab: tab,
      account: '',
      credential: '',
      registerPassword: '',
      registerConfirm: '',
      isRegisterMode: false,
      notice: '',
      error: '',
    });
  },

  /** 邮箱 Tab → 注册表单（清空 credential，即登录密码） */
  onSwitchToRegister() {
    this.setData({
      isRegisterMode: true,
      credential: '',
      notice: '',
      error: '',
    });
  },

  /** 邮箱 Tab → 登录表单（清空验证码与两组密码） */
  onSwitchToLogin() {
    this.setData({
      isRegisterMode: false,
      credential: '',
      registerPassword: '',
      registerConfirm: '',
      notice: '',
      error: '',
    });
  },

  // ==================== 表单输入 ====================

  /** 手机 Tab 只留数字最多 11 位（对齐 filter(Char::isDigit).take(11)） */
  onAccountInput(e) {
    const raw = String(e.detail.value || '');
    const account = this.data.activeTab === 'phone'
      ? raw.replace(/\D/g, '').slice(0, 11)
      : raw;
    this.setData({ account, error: '' });
  },

  /** 验证码场景只留数字最多 6 位；邮箱登录密码原样保留 */
  onCredentialInput(e) {
    const raw = String(e.detail.value || '');
    const numeric = this.data.activeTab === 'phone' || this.data.isRegisterMode;
    const credential = numeric ? raw.replace(/\D/g, '').slice(0, 6) : raw;
    this.setData({ credential, error: '' });
  },

  onRegisterPasswordInput(e) {
    this.setData({ registerPassword: String(e.detail.value || ''), error: '' });
  },

  onRegisterConfirmInput(e) {
    this.setData({ registerConfirm: String(e.detail.value || ''), error: '' });
  },

  onTogglePasswordVisible() {
    this.setData({ passwordVisible: !this.data.passwordVisible });
  },

  onFieldFocus(e) {
    this.setData({ focusField: e.currentTarget.dataset.field || '' });
  },

  onFieldBlur() {
    this.setData({ focusField: '' });
  },

  // ==================== 协议勾选与全文 ====================

  onToggleAgreement() {
    this.setData({ agreed: !this.data.agreed });
  },

  onOpenAgreement(e) {
    const key = e.currentTarget.dataset.doc;
    this.setData({
      agreementDoc: key === 'user' ? USER_AGREEMENT : PRIVACY_POLICY,
    });
  },

  onCloseAgreement() {
    this.setData({ agreementDoc: null });
  },

  // ==================== 发送验证码（60s 倒计时 + 防重入） ====================

  /** 手机 Tab → 短信登录验证码；邮箱注册 Tab → 邮箱注册验证码 */
  onSendCode() {
    const { activeTab, account, isSending, countdownSeconds } = this.data;
    if (isSending || countdownSeconds > 0) return; // 防重入

    if (activeTab === 'phone') {
      if (!account || account.length !== 11) {
        this.setData({ error: '请输入11位手机号码' });
        return;
      }
      this.setData({ isSending: true, error: '' });
      authService
        .sendSmsCode(account)
        .then(() => {
          this.setData({ isSending: false });
          this.startCountdown();
          wx.showToast({ title: '验证码已发送', icon: 'success' });
        })
        .catch((err) => {
          this.setData({ isSending: false, error: err.message || '验证码发送失败' });
        });
    } else {
      if (!EMAIL_REGEX.test(account)) {
        this.setData({ error: '请输入正确的邮箱地址' });
        return;
      }
      this.setData({ isSending: true, error: '' });
      authService
        .sendEmailVerificationCode(account)
        .then(() => {
          this.setData({ isSending: false });
          this.startCountdown();
          wx.showToast({ title: '验证码已发送', icon: 'success' });
        })
        .catch((err) => {
          this.setData({ isSending: false, error: err.message || '验证码发送失败' });
        });
    }
  },

  /** 60 秒倒计时（对齐 startCountdown：60 downTo 1，结束归零） */
  startCountdown() {
    this.clearCountdown();
    this.setData({ countdownSeconds: 60 });
    this.countdownTimer = setInterval(() => {
      const next = this.data.countdownSeconds - 1;
      if (next <= 0) {
        this.clearCountdown();
        this.setData({ countdownSeconds: 0 });
      } else {
        this.setData({ countdownSeconds: next });
      }
    }, 1000);
  },

  clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },

  // ==================== 登录 / 注册提交 ====================

  onSubmit() {
    const { activeTab, isRegisterMode, isLoading, agreed } = this.data;
    if (isLoading) return; // loading 防抖

    // 协议门禁（对齐 Android enabled = agreed && !isLoading 的禁用语义，
    // 小程序补充显式提示以覆盖 dim 态误触与键盘 confirm 等旁路入口）
    if (!agreed) {
      wx.showToast({
        title: '请先阅读并同意《用户协议》和《隐私政策》',
        icon: 'none',
        duration: 2500,
      });
      return;
    }

    if (activeTab === 'phone') {
      this.submitSmsLogin();
    } else if (isRegisterMode) {
      this.submitEmailRegister();
    } else {
      this.submitEmailLogin();
    }
  },

  /** 手机验证码登录（未注册自动建号，对齐 loginWithSms） */
  submitSmsLogin() {
    const { account, credential } = this.data;
    if (!account || !credential) {
      this.setData({ error: '请输入手机号和验证码' });
      return;
    }

    this.setData({ isLoading: true, error: '' });
    authService
      .loginWithSms(account, credential)
      .then(() => this.handleLoginSuccess())
      .catch((err) => {
        this.setData({ isLoading: false, error: err.message || '登录失败，请稍后重试' });
      });
  },

  /** 邮箱密码登录（对齐 loginWithPassword） */
  submitEmailLogin() {
    const { account, credential } = this.data;
    if (!account || !credential) {
      this.setData({ error: '请输入邮箱和密码' });
      return;
    }

    this.setData({ isLoading: true, error: '' });
    authService
      .loginWithPassword(account, credential)
      .then(() => this.handleLoginSuccess())
      .catch((err) => {
        this.setData({ isLoading: false, error: err.message || '登录失败，请稍后重试' });
      });
  },

  /**
   * 邮箱注册：verify-code → sign-up 成功后，用同一凭据自动登录
   * （邮箱分支不会自动建号，注册与登录必须分离——对齐 register 的串联逻辑）。
   */
  submitEmailRegister() {
    const { account: email, credential: code, registerPassword, registerConfirm } = this.data;

    if (!email || !code || !registerPassword || !registerConfirm) {
      this.setData({ error: '请填写完整注册信息' });
      return;
    }
    if (code.length !== 6) {
      this.setData({ error: '请输入6位邮箱验证码' });
      return;
    }
    if (registerPassword.length < 6) {
      this.setData({ error: '密码至少需要6位' });
      return;
    }
    if (registerPassword !== registerConfirm) {
      this.setData({ error: '两次输入的密码不一致' });
      return;
    }

    this.setData({ isLoading: true, error: '', notice: '' });
    authService
      .verifyAndSignUp(email, code, registerPassword)
      .then(() => {
        this.setData({ notice: '注册成功，正在自动登录' });
        return authService.loginWithPassword(email, registerPassword);
      })
      .then(() => this.handleLoginSuccess())
      .catch((err) => {
        this.setData({ isLoading: false, error: err.message || '注册失败，请稍后重试' });
      });
  },

  /**
   * 登录成功：token 已在服务层经 authStore.setLoginData 写入本地存储，
   * 订阅 authStore 的页面（首页引导态 / 我的页）会自动刷新；此处完成路由回退。
   */
  handleLoginSuccess() {
    this.setData({ isLoading: false, isSuccess: true, notice: '' });
    wx.showToast({ title: '登录成功', icon: 'success' });
    this.finishLogin();
  },

  /** 登录成功后的返回策略：有上级页面则返回，否则落回首页 tab */
  finishLogin() {
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/home/index' });
      }
    }, 600);
  },

  // ==================== 生命周期 ====================

  onLoad() {
    // 进入页面即重置为初始登录态（对齐弹层每次打开的干净状态）
  },

  onUnload() {
    // 对齐 ViewModel.onCleared：离开页面时停掉倒计时
    this.clearCountdown();
  },
});
