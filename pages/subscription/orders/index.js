/**
 * pages/subscription/orders/index.js — 订单中心页（微信《小程序订单中心设置规范》合规配套）
 *
 * 规范硬性要求（mp 公告 11669729383k7cis，2022-12-31 生效）逐条落点：
 *   - 主 path 不拼参数直达：本页路径 pages/subscription/orders/index（提审表单
 *     「小程序订单中心 path」填报值；无中文、无 query）；
 *   - 展示所有涉及资金交易的订单明细：GET /api/wxpay/orders（本小程序唯一
 *     资金交易=虚拟支付会员，后端 [userid, createAt desc] 索引查询 + 白名单 DTO）；
 *   - 未登录页内引导登录、登录后停留在本页：游客横幅「立即登录」navigateTo
 *     auth 页，回流经 onShow 检测登录态自动拉列表（不跳首页不离开本页）；
 *   - 进入不白屏：loading/error/empty 三态 + 下拉刷新；已有列表时的后台
 *     刷新不闪 loading（仅空列表首拉显示加载态）。
 * 支付回调丢失兜底（对齐 wxpay.js T5.2 口径）：从支付流程回到本页时 onShow
 * 现拉，PENDING → ACTIVATED 的收敛由后端查单/推送保证，此处只读事实。
 */

const theme = require('../../../utils/theme');
const authStore = require('../../../store/authStore');
const { get } = require('../../../utils/request');
const { decorateOrders } = require('./display');

Page({
  data: {
    themeClass: '',
    dark: false,
    guest: false,   // 游客态（未登录：横幅引导，规范要求页内引导不跳走）
    loading: false, // 首拉加载态（空列表时才展示，避免后台刷新闪断）
    error: '',      // 非空 = 错误态（重试按钮）
    orders: [],
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();

    const auth = authStore.getState();
    this.setData({ guest: !auth.isLoggedIn });
    if (auth.isLoggedIn) {
      // 已登录：每次 onShow 现拉（登录回流 / 支付回流 / 下拉刷新同一入口；
      // 列表非空时静默刷新不闪 loading）
      this.loadOrders();
    }
  },

  /**
   * 拉取订单列表。载荷校验失败按错误态兜底（2xx 但结构异常属服务端问题，
   * 与 wxpay.js createOrder 同口径不静默）；401 时 request.js 已全局清 token
   * 并 toast，此处同步 authStore.logout() 切回游客横幅引导重新登录。
   */
  async loadOrders() {
    if (this._loading) return; // 防重入（onShow 与下拉刷新并发）
    this._loading = true;
    if (this.data.orders.length === 0) {
      this.setData({ loading: true, error: '' });
    }
    try {
      const body = await get('/api/wxpay/orders', {}, { showError: false });
      const rows = body && body.data && Array.isArray(body.data.orders)
        ? body.data.orders
        : null;
      if (!body || !body.success || !rows) {
        throw new Error('订单数据格式异常，请稍后重试');
      }
      this.setData({ orders: decorateOrders(rows), error: '' });
    } catch (err) {
      if (err && err.statusCode === 401) {
        authStore.logout(); // 会话失效切游客态（横幅引导重新登录，不留死重试）
        this.setData({ guest: true, orders: [], error: '' });
      } else {
        this.setData({ error: (err && err.message) || '加载失败，请稍后重试' });
      }
    } finally {
      this._loading = false;
      this.setData({ loading: false });
    }
  },

  /** 游客横幅「立即登录/注册账号」：navigateTo auth 页，登录后返回本页（规范：停留订单中心） */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  /** 空态「去订阅」：本页上级订阅页（档位购买入口） */
  onGoSubscribe() {
    wx.navigateTo({ url: '/pages/subscription/index' });
  },

  /** 错误态重试 */
  onRetry() {
    this.loadOrders();
  },

  /** 下拉刷新（onPullDownRefresh 须 return 链路收口：stopPullDownRefresh 恒达） */
  async onPullDownRefresh() {
    try {
      await this.loadOrders();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
});
