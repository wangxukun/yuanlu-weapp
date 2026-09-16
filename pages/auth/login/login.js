/**
 * pages/auth/login/login.js — 登录页交互逻辑
 *
 * 移植自 Android 端 LoginViewModel.kt 的状态机：
 *   - 表单校验：手机号 11 位（1 开头）、验证码 6 位；
 *   - 验证码倒计时：发送成功后 60s 锁定「获取验证码」（startCountdown）；
 *   - 防重入：isSending / isLoading 期间忽略重复触发（对齐 uiState 防抖）；
 *   - 行内错误：uiState.error 的等价实现，输入时自动清除（clearError）。
 *
 * 接口：
 *   - 发送验证码 POST /api/auth/sms/send { phone, scene: "LOGIN" }
 *     （注意：业务失败也返回 HTTP 200，由 request.js 按 success:false 转为 reject）
 *   - 登录       POST /api/auth/mobile/token（经 utils/request.js 的 mobileLogin，
 *     成功后自动把 token/expiresAt/用户信息写入本地存储）
 */

const { post, mobileLogin } = require("../../../utils/request");

Page({
  data: {
    phone: "",
    code: "",
    agreed: false, // 协议勾选（登录按钮的前置条件）
    countdownSeconds: 0, // >0 时「获取验证码」显示倒计时并禁用
    isSending: false, // 验证码发送中
    isLoading: false, // 登录请求中（按钮 loading + 防抖）
    error: "", // 行内错误文案（uiState.error）
  },

  countdownTimer: null,

  // ==================== 表单输入 ====================

  onPhoneInput(e) {
    // 只留数字、最多 11 位（对齐 Android 的 filter(Char::isDigit).take(11)）
    const phone = String(e.detail.value || "").replace(/\D/g, "").slice(0, 11);
    this.setData({ phone, error: "" });
  },

  onCodeInput(e) {
    const code = String(e.detail.value || "").replace(/\D/g, "").slice(0, 6);
    this.setData({ code, error: "" });
  },

  // ==================== 协议勾选 ====================

  onToggleAgreement() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 协议全文页待后续阶段实现，当前以摘要弹窗过渡 */
  onOpenUserAgreement() {
    wx.showModal({
      title: "用户协议",
      content:
        "完整协议内容可通过远路播客官网查看，小程序内置协议页面将在后续版本提供。",
      showCancel: false,
      confirmText: "我知道了",
    });
  },

  onOpenPrivacyPolicy() {
    wx.showModal({
      title: "隐私政策",
      content:
        "完整隐私政策可通过远路播客官网查看，小程序内置协议页面将在后续版本提供。",
      showCancel: false,
      confirmText: "我知道了",
    });
  },

  // ==================== 发送验证码 ====================

  onSendCode() {
    const { phone, isSending, countdownSeconds } = this.data;
    // 防重入：发送中 / 倒计时中直接忽略（对齐 ViewModel 的 if 判断）
    if (isSending || countdownSeconds > 0) return;

    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ error: "请输入11位手机号码" });
      return;
    }

    this.setData({ isSending: true, error: "" });

    post(
      "/api/auth/sms/send",
      { phone, scene: "LOGIN" },
      { needAuth: false, showError: false }
    )
      .then(() => {
        this.setData({ isSending: false });
        this.startCountdown();
        wx.showToast({ title: "验证码已发送", icon: "success" });
      })
      .catch((err) => {
        // 阿里云滑块风控：requireCaptcha 标识（HTTP 200 + success:false）
        const isCaptcha =
          err && err.body && err.body.requireCaptcha === true;
        this.setData({
          isSending: false,
          error: isCaptcha
            ? "触发安全验证，请稍后重试或改用邮箱登录"
            : err.message || "验证码发送失败，请稍后重试",
        });
      });
  },

  /** 60 秒倒计时（对齐 startCountdown：60 downTo 1） */
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

  // ==================== 登录 ====================

  onLogin() {
    const { phone, code, agreed, isLoading } = this.data;
    // loading 防抖：请求进行中忽略重复点击
    if (isLoading) return;

    // 协议未勾选：给出 Toast 提示（Android 端为禁用按钮，小程序补充显式提示）
    if (!agreed) {
      wx.showToast({
        title: "请先阅读并同意《用户协议》和《隐私政策》",
        icon: "none",
        duration: 2500,
      });
      return;
    }

    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ error: "请输入11位手机号码" });
      return;
    }
    if (code.length !== 6) {
      this.setData({ error: "请输入6位验证码" });
      return;
    }

    this.setData({ isLoading: true, error: "" });

    // mobileLogin 内部完成：POST /api/auth/mobile/token → token/用户信息
    // 持久化到 wx.setStorageSync（对齐 Android TokenStore.saveToken）
    mobileLogin({ phone, code, type: "sms" }, { showError: false })
      .then(() => {
        wx.showToast({ title: "登录成功", icon: "success" });
        this.finishLogin();
      })
      .catch((err) => {
        this.setData({
          isLoading: false,
          error: err.message || "登录失败，请稍后重试",
        });
      });
  },

  /** 登录成功后的返回策略：有上级页面则返回，否则落回首页 tab */
  finishLogin() {
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: "/pages/home/home" });
      }
    }, 600);
  },

  // ==================== 微信一键登录（骨架） ====================

  /**
   * 微信一键登录事件处理（阶段三接通后端后启用）：
   *
   * 1. 用户点击按钮 → 微信弹出手机号授权弹窗（需企业主体认证的小程序，
   *    个人主体调用会直接失败；开发环境下基础库会返回 mock code）；
   * 2. 用户同意后回调 e.detail.code（动态令牌，5 分钟内有效，一次性）；
   * 3. 将 code POST 到后端待建接口（如 /api/auth/weapp/login），
   *    后端用 code + access_token 调 phonenumber.getPhoneNumber 换取真实手机号，
   *    再复用 signMobileToken 签发与 /api/auth/mobile/token 同构的 JWT 返回；
   * 4. 小程序端复用 request.js 的 saveLogin 落库并跳转，流程与短信登录收敛一致。
   */
  onWxLogin(e) {
    const detail = e.detail || {};

    // 用户拒绝授权 / 环境不支持时 errMsg 存在且无 code
    if (!detail.code) {
      wx.showToast({ title: "已取消授权", icon: "none" });
      return;
    }
    if (!this.data.agreed) {
      wx.showToast({
        title: "请先阅读并同意《用户协议》和《隐私政策》",
        icon: "none",
        duration: 2500,
      });
      return;
    }

    this.setData({ isLoading: true, error: "" });

    // TODO(阶段三): 替换为真实后端接口
    // post("/api/auth/weapp/login", { code: detail.code }, { needAuth: false })
    //   .then((body) => { const { token, expiresAt, ...userInfo } = body.data; ... })
    this.setData({ isLoading: false });
    wx.showToast({
      title: "微信登录即将开放，请先使用手机号登录",
      icon: "none",
    });
  },

  // ==================== 生命周期 ====================

  onUnload() {
    // 对齐 ViewModel.onCleared：离开页面时停掉倒计时协程
    this.clearCountdown();
  },
});
