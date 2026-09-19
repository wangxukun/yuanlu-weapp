const BASE_URL = 'https://www.wxkzd.com'; // 根据环境可切换为测试服

/**
 * 封装微信请求，支持 Promise，自动注入 Token 及统一错误处理
 */
const request = (options) => {
  return new Promise((resolve, reject) => {
    // 获取 Token
    const token = wx.getStorageSync('token') || '';
    
    // 构建 Headers
    const header = {
      'Content-Type': 'application/json',
      ...options.header
    };
    
    if (token) {
      header['Authorization'] = `Bearer ${token}`;
    }

    wx.request({
      url: options.url.startsWith('http') ? options.url : `${BASE_URL}${options.url}`,
      method: options.method || 'GET',
      data: options.data || {},
      header: header,
      timeout: options.timeout || 10000,
      success: (res) => {
        // HTTP 状态码 2xx 视作成功
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          // Token 过期或未授权，触发重新登录流程
          wx.removeStorageSync('token');
          // 可以在此处通知全局 authStore 进行重新登录
          wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
          reject(new Error('Unauthorized'));
        } else {
          // 其他业务错误
          wx.showToast({
            title: res.data?.message || res.data?.error || '请求失败',
            icon: 'none'
          });
          reject(res.data);
        }
      },
      fail: (err) => {
        wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        reject(err);
      }
    });
  });
};

module.exports = {
  request,
  get: (url, data, header) => request({ url, method: 'GET', data, header }),
  post: (url, data, header) => request({ url, method: 'POST', data, header }),
  put: (url, data, header) => request({ url, method: 'PUT', data, header }),
  delete: (url, data, header) => request({ url, method: 'DELETE', data, header })
};
