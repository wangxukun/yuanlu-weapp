const { BASE_URL } = require('./config'); // 环境切换（dev/trial/prod）见 utils/config.js

/**
 * 封装微信请求，支持 Promise，自动注入 Token 及统一错误处理
 *
 * 对齐 Android 端 core/network + AuthRepositoryImpl.errorMessage() 的口径：
 *   - 4xx/5xx 响应体 { success, error | message } 中提取用户可读文案；
 *   - reject 统一为 ApiError（含 message / statusCode / body），页面可直接读 err.message；
 *   - options（高级用法，登录模块等需要行内错误展示的场景）：
 *       needAuth  默认 true，false 时不携带 Authorization（登录/发码等匿名接口）
 *       showError 默认 true，false 时错误不弹全局 Toast，由调用方自行展示
 *       timeout   请求超时毫秒数
 *   - get/post/put/delete 的第三个参数既可以是旧版 header 对象（向后兼容），
 *     也可以是 { header, needAuth, showError, timeout } 选项对象。
 */

class ApiError extends Error {
  constructor(message, statusCode, body) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.body = body || null;
    // 后端业务字段透传到顶层，兼容旧版 reject(res.data) 形态的既有消费方
    // （如 utils/tts.js 读 err.code === 'DICTIONARY_QUOTA_EXCEEDED' 触发会员弹窗）
    if (body && typeof body === 'object') {
      if (body.code !== undefined) this.code = body.code;
      if (body.error !== undefined) this.error = body.error;
      if (body.requireCaptcha) this.requireCaptcha = true;
    }
  }
}

/** 从后端响应体提取可读文案（error 优先于 message，对齐 Android errorMessage()） */
function extractMessage(data, fallback) {
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.message === 'string' && data.message) return data.message;
  }
  return fallback;
}

/** 判断第三个参数是否为选项对象（含任一保留键），否则按旧版 header 处理 */
function isOptionsLike(arg) {
  return !!arg && typeof arg === 'object' &&
    ('needAuth' in arg || 'showError' in arg || 'timeout' in arg || 'header' in arg);
}

function mergeOptions(url, method, data, arg) {
  const opts = isOptionsLike(arg) ? arg : { header: arg };
  return {
    url,
    method,
    data,
    header: opts.header || {},
    needAuth: opts.needAuth !== false,
    showError: opts.showError !== false,
    timeout: opts.timeout,
  };
}

const request = (options) => {
  const showError = options.showError !== false;
  return new Promise((resolve, reject) => {
    // 获取 Token（needAuth:false 的匿名接口不携带，避免过期 token 干扰登录）
    const token = options.needAuth === false ? '' : (wx.getStorageSync('token') || '');

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
        // HTTP 状态码 2xx 视作成功（业务失败如 success:false 由调用方自行判定）
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else if (res.statusCode === 401) {
          // Token 过期或未授权，触发重新登录流程
          wx.removeStorageSync('token');
          // 401 属全局会话事件，无论 showError 与否都提示（与既有行为一致）
          wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' });
          reject(new ApiError(extractMessage(res.data, '登录已过期，请重新登录'), 401, res.data));
        } else {
          // 其他业务错误（后端 4xx/5xx 带 { success, error | message }）
          const message = extractMessage(res.data, `请求失败（HTTP ${res.statusCode}）`);
          if (showError) {
            wx.showToast({ title: message, icon: 'none' });
          }
          reject(new ApiError(message, res.statusCode, res.data));
        }
      },
      fail: () => {
        if (showError) {
          wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        }
        // 对齐 Android Result.NetworkError 的文案
        reject(new ApiError('网络连接失败', 0, null));
      }
    });
  });
};

module.exports = {
  request,
  ApiError,
  get: (url, data, opts) => request(mergeOptions(url, 'GET', data, opts)),
  post: (url, data, opts) => request(mergeOptions(url, 'POST', data, opts)),
  put: (url, data, opts) => request(mergeOptions(url, 'PUT', data, opts)),
  delete: (url, data, opts) => request(mergeOptions(url, 'DELETE', data, opts)),
};
