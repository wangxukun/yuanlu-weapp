const request = require('../../utils/request').request;
const authStore = require('../../store/authStore');

Page({
  data: {
    activeTab: 'phone', // 'phone' | 'email'
    phone: '',
    code: '',
    email: '',
    password: '',
    countdown: 0,
    agreed: false,
    isLoading: false
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (this.data.activeTab !== tab) {
      this.setData({ activeTab: tab, code: '', password: '' });
    }
  },

  onInput() {
    // 触发双向绑定更新
  },

  onAgreeChange(e) {
    this.setData({ agreed: e.detail.value.length > 0 });
  },

  async sendSmsCode() {
    if (this.data.phone.length !== 11) {
      return wx.showToast({ title: '请输入有效的手机号码', icon: 'none' });
    }

    try {
      // 模拟 API 请求或真实对接
      const res = await request({
        url: '/api/auth/sms/send',
        method: 'POST',
        data: {
          phone: this.data.phone,
          scene: 'LOGIN'
        }
      });
      
      if (res.success) {
        wx.showToast({ title: '验证码已发送', icon: 'success' });
        this.setData({ countdown: 60 });
        this.timer = setInterval(() => {
          if (this.data.countdown > 0) {
            this.setData({ countdown: this.data.countdown - 1 });
          } else {
            clearInterval(this.timer);
          }
        }, 1000);
      } else {
        wx.showToast({ title: res.error || '发送失败', icon: 'none' });
      }
    } catch (err) {
      console.error(err);
    }
  },

  async onSubmit() {
    if (!this.data.agreed) return wx.showToast({ title: '请先同意协议', icon: 'none' });
    
    this.setData({ isLoading: true });

    let loginData = {};
    if (this.data.activeTab === 'phone') {
      if (!this.data.phone || !this.data.code) {
        this.setData({ isLoading: false });
        return wx.showToast({ title: '信息填写不完整', icon: 'none' });
      }
      loginData = { type: 'sms', phone: this.data.phone, code: this.data.code };
    } else {
      if (!this.data.email || !this.data.password) {
        this.setData({ isLoading: false });
        return wx.showToast({ title: '信息填写不完整', icon: 'none' });
      }
      loginData = { type: 'password', email: this.data.email, password: this.data.password };
    }

    try {
      const res = await request({
        url: '/api/auth/mobile/token',
        method: 'POST',
        data: loginData
      });

      if (res && res.success && res.data && res.data.token) {
        // 保存登录态到 store
        authStore.setLoginData(res.data.token, res.data.user);
        wx.showToast({ title: '登录成功', icon: 'success' });
        
        setTimeout(() => {
          wx.navigateBack({
            fail: () => {
              // 如果没有上一页，回首页
              wx.switchTab({ url: '/pages/home/index' });
            }
          });
        }, 1000);
      } else {
        wx.showToast({ title: '登录失败，请重试', icon: 'none' });
      }
    } catch (err) {
      console.error(err);
      wx.showToast({ title: err.message || '登录失败', icon: 'none' });
    } finally {
      this.setData({ isLoading: false });
    }
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
  }
});
