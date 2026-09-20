/**
 * utils/track.js — 转化事件上报（对齐 Web 端 POST /api/track）
 *
 * 完全静默的 fire-and-forget：
 * - 不走 utils/request.js（其失败会全局 toast，埋点绝不能影响 UI）
 * - 未登录也允许上报（后端 /api/track 对游客记 userid 为空）
 * - 任何失败静默吞掉（对齐 Web fetch().catch(() => {})）
 *
 * eventType 白名单由后端 CONVERSION_EVENT_TYPES 执法
 * （当前客户端使用：PREMIUM_MODAL_OPEN / TRIAL_REACHED）。
 */
const { BASE_URL } = require('./config');

function trackEvent(eventType, source, metadata) {
  try {
    const header = { 'content-type': 'application/json' };
    const token = wx.getStorageSync('token');
    if (token) {
      header.Authorization = 'Bearer ' + token;
    }
    const data = { eventType, source: source || 'unknown' };
    if (metadata) {
      data.metadata = metadata;
    }
    wx.request({
      url: BASE_URL + '/api/track',
      method: 'POST',
      header,
      data,
      success: () => {},
      fail: () => {},
    });
  } catch (e) {
    // 上报失败静默，绝不影响 UI
  }
}

module.exports = { trackEvent };
