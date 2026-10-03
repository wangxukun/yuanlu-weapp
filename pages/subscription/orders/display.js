/**
 * pages/subscription/orders/display.js — 订单展示映射纯函数（订单中心页配套）
 *
 * 后端 GET /api/wxpay/orders 返回 data.orders（UserOrderDto 9 字段：金额已
 * 服务端格式化为 amountYuan、标签已落位）。本模块只补前端展示派生：
 *   - 状态色类（WXML 禁方法调用红线：映射前置到 JS）；
 *   - 时间文案：ISO → 本机时区 yyyy-MM-dd HH:mm（订单是账务事实，取等宽
 *     数字口径而非评论区的「M月D日」口语口径）；
 *   - 非法入参（null/非数组/坏时间戳）全兜底不 throw（页面渲染安全）。
 */

/** 状态 → 色类（wxss .status-* 同名类；未知状态按弱化灰处理） */
const STATUS_CLASSES = {
  ACTIVATED: 'status-done',
  PENDING: 'status-pending',
  AMOUNT_MISMATCH: 'status-processing',
  REFUNDED: 'status-muted',
  CLOSED: 'status-muted',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ISO → yyyy-MM-dd HH:mm（本机时区）；非法输入返回空串（wxml 整行留白不炸） */
function formatOrderTime(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (
    d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

/** 列表装饰：后端 DTO + 派生字段（timeText/statusClass），保序、非数组入参返 [] */
function decorateOrders(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(function (r) {
    r = r || {};
    return {
      outTradeNo: r.outTradeNo || '',
      planName: r.planName || '',
      buyQuantity: r.buyQuantity,
      amountYuan: r.amountYuan || '0.00',
      daysGranted: r.daysGranted,
      statusLabel: r.statusLabel || '',
      timeText: formatOrderTime(r.createAt),
      statusClass: STATUS_CLASSES[r.status] || 'status-muted',
    };
  });
}

module.exports = {
  STATUS_CLASSES,
  formatOrderTime,
  decorateOrders,
};
