/**
 * utils/api/notification.js — 「消息通知」接口封装
 *
 * 端点对照后端 yuanlu app/api/notification/**：
 *   - GET  /api/notification/list   裸 { unreadCount, notifications[] }
 *     （全量按 notificationAt 倒序，无分页参数——小程序端按 20 条/页客户端
 *     分页，Web 同款全量接口）
 *   - POST /api/notification/read   { notificationId } 单条 / { all: true } 全部
 *     （Web 端用 PATCH；wx.request 无 PATCH，走后端 POST 别名——同
 *     episode/progress 路由先例，生产部署前 405 属部署落差）
 *   - POST /api/notification/delete { notificationIds: number[] } 批量/单条
 *     （Web 端用 DELETE 携 JSON body；wx.request DELETE 带体存在平台差异，
 *     统一走后端 POST 别名兜底）
 *
 * 读写均 showError:false——页面自管反馈：已读链路失败静默（Web 同口径的
 * 乐观更新），删除/全部已读失败由页面 toast 固定文案。
 */
const { get, post } = require('../request');

/** 通知列表（含未读总数；入口角标与页面共用） */
function getNotifications() {
  return get('/api/notification/list', undefined, { showError: false });
}

/** 标记单条已读（乐观链路，失败由调用方静默） */
function markRead(notificationId) {
  return post('/api/notification/read', { notificationId }, { showError: false });
}

/** 一键全部已读 */
function markAllRead() {
  return post('/api/notification/read', { all: true }, { showError: false });
}

/** 批量删除（单条传 [id]；成功回 { success, count }） */
function removeNotifications(notificationIds) {
  return post('/api/notification/delete', { notificationIds }, { showError: false });
}

module.exports = {
  getNotifications,
  markRead,
  markAllRead,
  removeNotifications,
};
