/**
 * pages/contact — 联系我们 / 帮助与支持（复刻 Web app/(main)/contact/ContactClient.tsx）
 *
 * 表单三字段（口径 = Web lib/form-schema.ts contactSchema）：
 *   邮箱：必填 + 格式校验；主题：必填、≤50 字；留言内容：10~1000 字 + 计数器。
 * 校验时机对齐 Web：输入中不打扰，blur（touched）后才显示错误，修正立即消错。
 * 提交：POST /api/contact（匿名，后端 zod 二次校验并发邮件）→
 *   成功 toast「留言已发送！我们会尽快回复您。」→ navigateBack（Web 为回首页）。
 */
const theme = require('../../utils/theme');
const { post } = require('../../utils/request');
const authStore = require('../../store/authStore');

// contactSchema 同口径（message 文案逐项一致）
function validateField(name, value) {
  value = String(value || '');
  if (name === 'email') {
    if (!value) return '邮箱不能为空';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '请输入有效的邮箱地址';
  }
  if (name === 'subject') {
    if (!value) return '主题不能为空';
    if (value.length > 50) return '主题不能超过50个字符';
  }
  if (name === 'message') {
    if (value.length < 10) return '留言内容至少需要10个字符';
    if (value.length > 1000) return '留言内容不能超过1000个字符';
  }
  return '';
}

function isFormValid(formData) {
  return ['email', 'subject', 'message'].every((k) => !validateField(k, formData[k]));
}

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    email: '',
    subject: '',
    message: '',
    errors: { email: '', subject: '', message: '' },
    touched: { email: false, subject: false, message: false },
    isFormValid: false,
    isLoading: false,
    messageLen: 0,
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
  },

  onLoad() {
    // 已登录用户预填邮箱（Web 无预填；小程序端属体验优化，仍可修改）
    const userInfo = authStore.getState().userInfo;
    if (userInfo && userInfo.email) {
      this.setData({ email: userInfo.email, isFormValid: isFormValid({ email: userInfo.email, subject: '', message: '' }) });
    }
  },

  onInput(e) {
    const name = e.currentTarget.dataset.name;
    const value = e.detail.value;
    const patch = { [name]: value };
    if (name === 'message') patch.messageLen = value.length;
    // 已触摸（blur 过）或正在修正错误：立即校验反馈（Web handleChange 同口径）
    if (this.data.touched[name] || this.data.errors[name]) {
      patch['errors.' + name] = validateField(name, value);
    }
    const next = Object.assign({}, this.data, patch);
    patch.isFormValid = isFormValid({ email: next.email, subject: next.subject, message: next.message });
    this.setData(patch);
  },

  onBlur(e) {
    const name = e.currentTarget.dataset.name;
    // 标记触摸 + 校验（Web handleBlur 同口径）
    this.setData({
      ['touched.' + name]: true,
      ['errors.' + name]: validateField(name, e.detail.value),
    });
  },

  async onSubmit() {
    if (this.data.isLoading) return;
    const formData = { email: this.data.email, subject: this.data.subject, message: this.data.message };
    // 提交前全量校验（防绕过；未触摸的字段此刻补显错误，对齐 Web toast 口径）
    if (!isFormValid(formData)) {
      this.setData({
        touched: { email: true, subject: true, message: true },
        errors: {
          email: validateField('email', formData.email),
          subject: validateField('subject', formData.subject),
          message: validateField('message', formData.message),
        },
      });
      wx.showToast({ title: '请修正表单中的错误', icon: 'none' });
      return;
    }
    this.setData({ isLoading: true });
    try {
      const res = await post('/api/contact', formData, { showError: false, needAuth: false, timeout: 15000 });
      if (!res || res.success === false) {
        throw new Error((res && res.message) || '发送失败');
      }
      wx.showToast({ title: '留言已发送！我们会尽快回复您。', icon: 'none', duration: 2500 });
      setTimeout(() => wx.navigateBack({ fail: () => {} }), 1200);
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '发送过程中出现错误', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },
});
