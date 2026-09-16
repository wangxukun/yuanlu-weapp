/**
 * utils/request.js — 全局网络请求封装
 *
 * 后端为 Web 端同一套 Next.js API（/api/**）：
 *  - 登录态：移动端专用 JWT，通过 POST /api/auth/mobile/token 获取
 *    （支持 手机号+验证码 / 邮箱+密码），有效期 30 天；
 *  - 携带方式：Authorization: Bearer <token>；
 *  - 响应约定：{ success: boolean, data?: any, error?: string }
 *    （部分旧接口直接返回裸对象，因此不强制解包，统一 resolve 整个 body）。
 *
 * 401 处理策略（对齐 Android 端 AuthInterceptor）：
 *  非 /api/auth/** 接口收到 401 → 清除本地登录态并跳转登录页，
 *  登录接口自身的 401 只代表"账号或密码错误"，不做清态处理。
 */

const { BASE_URL } = require("./config");

// ==================== 本地存储 Key ====================
const TOKEN_KEY = "yuanlu_token";
const TOKEN_EXPIRES_KEY = "yuanlu_token_expires_at";
const USER_INFO_KEY = "yuanlu_user_info";

// ==================== Token 管理 ====================

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || "";
}

function getTokenExpiresAt() {
  return wx.getStorageSync(TOKEN_EXPIRES_KEY) || 0;
}

function getUserInfo() {
  return wx.getStorageSync(USER_INFO_KEY) || null;
}

function saveLogin(token, expiresAt, userInfo) {
  wx.setStorageSync(TOKEN_KEY, token);
  wx.setStorageSync(TOKEN_EXPIRES_KEY, expiresAt || "");
  if (userInfo) wx.setStorageSync(USER_INFO_KEY, userInfo);
}

/** 判断 token 是否临近/已过期（提前 5 分钟视为过期） */
function isTokenExpired() {
  const expiresAt = getTokenExpiresAt();
  if (!expiresAt) return false; // 无过期时间记录时不主动判定
  return Date.now() >= new Date(expiresAt).getTime() - 5 * 60 * 1000;
}

function clearLogin() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(TOKEN_EXPIRES_KEY);
  wx.removeStorageSync(USER_INFO_KEY);
  const app = getApp();
  if (app) app.globalData.userInfo = null;
}

function isLoggedIn() {
  return !!getToken() && !isTokenExpired();
}

/** 登录失效后的跳转（防抖，避免并发 401 触发多次跳转） */
let redirectingToLogin = false;
function redirectToLogin() {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  wx.navigateTo({
    url: "/pages/login/login",
    complete: () => {
      redirectingToLogin = false;
    },
  });
}

// ==================== 核心请求函数 ====================

/**
 * 发起请求
 * @param {Object} options
 * @param {string}  options.url          接口路径，以 /api 开头，如 /api/episode/list
 * @param {string}  [options.method]     HTTP 方法，默认 GET
 * @param {Object}  [options.data]       请求数据（GET 时序列化为 query）
 * @param {Object}  [options.header]     额外的请求头
 * @param {boolean} [options.needAuth]   是否注入 Token，默认 true；登录接口设为 false
 * @param {boolean} [options.showError]  业务错误时是否自动 toast，默认 true
 * @param {boolean} [options.rawResponse] 为 true 时 resolve 完整 Response（含 statusCode/body），用于需要判断特殊状态码的场景
 * @returns {Promise<any>} resolve 响应 body；reject { code, message, statusCode, body }
 */
function request(options) {
  const {
    url,
    method = "GET",
    data = {},
    header = {},
    needAuth = true,
    showError = true,
    rawResponse = false,
  } = options;

  return new Promise((resolve, reject) => {
    // ---- 组装请求头 ----
    const reqHeader = {
      "Content-Type": "application/json",
      "X-Client": "weapp", // 服务端区分客户端来源（对齐 Android 端的 X-Client: android）
      ...header,
    };
    if (needAuth && getToken()) {
      reqHeader.Authorization = `Bearer ${getToken()}`;
    }

    wx.request({
      url: `${BASE_URL}${url}`,
      method,
      data,
      header: reqHeader,
      timeout: 15000,
      success(res) {
        const { statusCode, data: body } = res;

        // ---- HTTP 状态码统一处理 ----
        if (statusCode >= 200 && statusCode < 300) {
          // 业务层失败：约定 success === false 时携带 error 文案
          if (body && body.success === false) {
            const message = body.error || "请求失败，请稍后重试";
            if (showError) {
              wx.showToast({ title: message, icon: "none", duration: 2500 });
            }
            reject({ code: "BIZ_ERROR", message, statusCode, body });
            return;
          }
          if (rawResponse) {
            resolve(res);
          } else {
            resolve(body);
          }
          return;
        }

        switch (statusCode) {
          case 401:
            // 登录失效：非 auth 接口才清态跳转，防止把登录页自身的报错误伤
            if (!url.startsWith("/api/auth/")) {
              clearLogin();
              redirectToLogin();
            }
            reject({
              code: "UNAUTHORIZED",
              message: "登录已失效，请重新登录",
              statusCode,
              body,
            });
            break;
          case 403:
            if (showError) {
              wx.showToast({
                title: (body && body.error) || "没有权限执行此操作",
                icon: "none",
              });
            }
            reject({
              code: "FORBIDDEN",
              message: (body && body.error) || "没有权限执行此操作",
              statusCode,
              body,
            });
            break;
          case 404:
            if (showError) {
              wx.showToast({ title: "请求的资源不存在", icon: "none" });
            }
            reject({
              code: "NOT_FOUND",
              message: "请求的资源不存在",
              statusCode,
              body,
            });
            break;
          default:
            if (showError) {
              wx.showToast({
                title: (body && body.error) || `服务异常 (${statusCode})`,
                icon: "none",
              });
            }
            reject({
              code: "HTTP_ERROR",
              message: (body && body.error) || `服务异常 (${statusCode})`,
              statusCode,
              body,
            });
        }
      },
      fail(err) {
        // 网络层失败：断网 / 域名未配置 / 超时
        const message =
          err.errMsg && err.errMsg.includes("timeout")
            ? "请求超时，请检查网络后重试"
            : "网络连接失败，请检查网络";
        if (showError) {
          wx.showToast({ title: message, icon: "none" });
        }
        reject({ code: "NETWORK_ERROR", message, errMsg: err.errMsg });
      },
    });
  });
}

// ==================== 快捷方法 ====================

function get(url, data, options = {}) {
  return request({ url, method: "GET", data, ...options });
}

function post(url, data, options = {}) {
  return request({ url, method: "POST", data, ...options });
}

function put(url, data, options = {}) {
  return request({ url, method: "PUT", data, ...options });
}

function del(url, data, options = {}) {
  return request({ url, method: "DELETE", data, ...options });
}

/**
 * 移动端登录（手机号+验证码 或 邮箱+密码 二选一）
 * 对应后端 app/api/auth/mobile/token/route.ts
 * @param {Object} params { phone, code } 或 { email, password }
 * @returns {Promise<Object>} resolve { userid, token, expiresAt, nickname, ... }
 */
function mobileLogin(params) {
  return post("/api/auth/mobile/token", params, {
    needAuth: false,
  }).then((body) => {
    const { token, expiresAt, ...userInfo } = body.data;
    saveLogin(token, expiresAt, userInfo);
    const app = getApp();
    if (app) app.globalData.userInfo = userInfo;
    return body.data;
  });
}

/** 退出登录：清本地态（后续阶段可在此追加服务端登出接口） */
function logout() {
  clearLogin();
}

module.exports = {
  request,
  get,
  post,
  put,
  del,
  mobileLogin,
  logout,
  // token 相关键，供 audioManager 等模块复用
  getToken,
  isLoggedIn,
  isTokenExpired,
  getUserInfo,
  saveLogin,
  clearLogin,
};
