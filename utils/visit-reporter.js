/**
 * utils/visit-reporter.js — 小程序访问上报（对齐 Web 端 PageTracker → VisitorLog）
 *
 * 服务端契约（yuanlu 仓库 app/api/track-visit/route.ts）：
 *   POST /api/track-visit { path }，path 为小程序本地路由（可带 query），
 *   服务端统一加 "wxapp/" 前缀写入 VisitorLog，与 Web 访问合并进入
 *   访问日志页 / 转化分析页「在线 · 登录用户 / 游客」热力图；
 *   同日同 IP 的游客/登录去重规则对小程序同样生效。响应恒 204。
 *
 * 实现口径（对齐 utils/track.js 的三条铁律）：
 * - 不走 utils/request.js：其失败 toast / 401 清 token 属 UI 副作用，
 *   埋点绝不能影响主流程，故直接 wx.request + 手动带 token
 * - 未登录也上报（游客按 IP 计入在线统计，token 缺省即匿名）
 * - 任何失败静默吞掉
 *
 * 挂载方式：require 即激活（同 store/playerStore）——劫持全局 Page
 * 构造器，为所有页面的 onShow 统一串入一次上报。app.js 的模块求值
 * 先于任何页面文件加载，钩子因此覆盖全部 28 个 Page() 页面；
 * 页面自身的 onShow 原样保留（上报在前、业务在后，且互不影响）。
 */
const { BASE_URL } = require('./config');

const TAG = '[visit-reporter]';
const DEDUP_WINDOW_MS = 5000; // 同一页面 5s 内重复 onShow 只记一次（tab 快速来回切防刷）
const MAX_PATH_LEN = 240; // 服务端契约：客户端 path ≤240 字符（加 wxapp/ 前缀后 ≤246 <255 列宽）

let lastPath = '';
let lastAt = 0;

/** 组装 "route?key=val"（query 编码、丢弃空值），截断到契约上限 */
function composePath(route, options) {
  let path = route || 'unknown';
  const query = [];
  if (options && typeof options === 'object') {
    Object.keys(options).forEach((k) => {
      const v = options[k];
      if (v !== undefined && v !== null && v !== '') {
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
    });
  }
  if (query.length) path += '?' + query.join('&');
  return path.slice(0, MAX_PATH_LEN);
}

function send(path) {
  try {
    const header = { 'content-type': 'application/json' };
    const token = wx.getStorageSync('token');
    if (token) {
      header.Authorization = 'Bearer ' + token;
    }
    wx.request({
      url: BASE_URL + '/api/track-visit',
      method: 'POST',
      header,
      data: { path },
      success: () => {},
      fail: () => {},
    });
  } catch (e) {
    // 上报失败静默，绝不影响 UI
  }
}

/**
 * 上报一次页面访问（Page 钩子自动调用，也可手动调用）。
 * page 取页面实例：route（如 pages/episode/detail）+ options（onLoad 参数）。
 */
function report(page) {
  try {
    const path = composePath(page && page.route, page && page.options);
    const now = Date.now();
    if (path === lastPath && now - lastAt < DEDUP_WINDOW_MS) return;
    lastPath = path;
    lastAt = now;
    send(path);
  } catch (e) {
    // 任何异常都不外抛（onShow 内不能因埋点挂掉）
  }
}

/** 劫持全局 Page 构造器（幂等；页面文件未定义 onShow 时仅上报） */
function installPageHook() {
  if (typeof Page !== 'function' || Page.__visitHooked) return;
  const originalPage = Page;
  const hooked = function (options) {
    options = options || {};
    const userOnShow = options.onShow;
    options.onShow = function () {
      report(this);
      if (typeof userOnShow === 'function') userOnShow.call(this);
    };
    return originalPage(options);
  };
  hooked.__visitHooked = true;
  Page = hooked;
  console.log(TAG, 'Page 访问上报钩子已安装');
}

installPageHook();

module.exports = { report, composePath, installPageHook };
