const Store = require('./core.js');

class AuthStore extends Store {
  constructor() {
    super({
      isLoggedIn: false,
      userInfo: null,
      token: ''
    });
  }

  // 恢复本地会话
  init() {
    const token = wx.getStorageSync('token');
    const userInfo = wx.getStorageSync('userInfo');
    if (token) {
      this.setState({ isLoggedIn: true, token, userInfo });
      this.fetchProfile();
    }
  }

  setLoginData(token, userInfo) {
    wx.setStorageSync('token', token);
    // 先保存基础的 user info（含有 role, email 等）
    if (userInfo) {
      wx.setStorageSync('userInfo', userInfo);
      this.setState({ isLoggedIn: true, token, userInfo });
    } else {
      this.setState({ isLoggedIn: true, token });
    }
    // 异步拉取完整的 Profile 数据（含有 nickname, avatarUrl 等）
    this.fetchProfile();
  }

  logout() {
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
    this.setState({ isLoggedIn: false, token: '', userInfo: null });
  }

  // 增加 fetchProfile 真实对接 `/api/user/profile` (或视后端接口调整)
  fetchProfile() {
    const { get } = require('../utils/request');
    get('/api/user/profile').then(res => {
      // 提取核心信息，展平 User 对象
      const user = res;
      if (res.User) {
        user.email = res.User.email;
        user.phone = res.User.phone;
        user.role = res.User.role;
      }
      wx.setStorageSync('userInfo', user);
      this.setState({ userInfo: user });
    }).catch(err => {
      console.warn('获取用户信息失败', err);
    });
  }
}

module.exports = new AuthStore();
