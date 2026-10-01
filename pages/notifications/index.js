/**
 * pages/notifications/index.js — 「消息通知」
 *
 * 复刻 Web 端 app/(main)/notifications/NotificationsClient.tsx 的业务逻辑：
 *   - 六段类型 Tab 客户端过滤（全部/评论/回复/点赞/系统/更新），切换重置列表；
 *   - 单条点击：未读先乐观置已读（POST /read，失败静默不回滚——Web 同口径），
 *     targetUrl 可映射则跳转（/episode/{id} → 剧集页、/charts → 学习报表页）；
 *   - 一键全部已读：顶部右侧按钮（对齐 Web NotificationBell 面板头「N 条未读 +
 *     全部已读」组合；页面本体无此按钮系移动端按铃铛口径补齐）；
 *   - 删除：长按单条 → showModal 二次确认 → POST /delete {notificationIds:[id]}，
 *     成功后本地过滤移除并重算未读数（Web 为行内垃圾桶按钮 + 复选框批量删，
 *     移动端按长按删除等价承接）；
 *   - 空态：Bell 图标 40% 透明 + 「暂无(此类)通知记录」。
 *
 * 分页：后端 /api/notification/list 为全量接口（Web 同款，无分页参数），小程序端
 * 按 20 条/页客户端分页——首屏 20 条，onReachBottom 扩窗拼接，下拉刷新全量重拉
 * （对齐收听历史页的滚动加载表达；数据体量与 Web 一致全量倒序）。
 *
 * 时间文案：date-fns zh-CN formatDistanceToNow 全语义移植，见 notification-core。
 */

const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const core = require('../../utils/notification-core');
const api = require('../../utils/api/notification');
const notificationBadge = require('../../utils/notification-badge');

const PAGE_SIZE = 20;

Page({
  data: {
    themeClass: '',
    dark: false,
    tabs: core.TABS,
    tab: 'ALL',
    // ---- 列表态 ----
    isLoading: true,
    error: '',
    needLogin: false,
    items: [], // 当前 Tab 的渲染窗口（客户端分页切片）
    total: 0, // 当前 Tab 过滤后总数
    unreadCount: 0,
    page: 0, // 已渲染的页数（0 基）
    endReached: false,
    isLoadingMore: false,
    markingAll: false,
  },

  onLoad() {
    this._all = []; // 全量展示模型（已装饰，Tab 过滤的源）
    this._deleting = false; // 删除在途锁（showModal 回调异步）
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    // 首载在 onLoad 后由这里触发；登录页返回后自动补拉
    if (!this._hasLoaded) this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().then(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    // 离开通知页（navigateBack）时后台重拉一次未读态：此刻页面栈顶即将变回
    // Tab 页，异步回包落在 Tab 页上下文，tabBar 红点 API 可用——修复「非 Tab
    // 页内隐藏红点报 not TabBar page 失败 → 读完红点钉死」的兜底链路
    // （回到「我的」Tab 另有 mine.onShow 重拉双保险）。
    notificationBadge.syncUnreadBadge().catch(() => {});
  },

  onReachBottom() {
    this.loadMore();
  },

  // ==================== 数据获取 ====================

  async fetch() {
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, error: '' });
      return;
    }
    if (this._loading) return;
    this._loading = true;
    this.setData({ isLoading: true, error: '', needLogin: false });
    try {
      const dto = await api.getNotifications();
      this._hasLoaded = true;
      this._all = core.mapList(dto).items;
      this.setData({ unreadCount: this._countUnread() });
      this._syncBadge();
      this.applyFilter(this.data.tab);
    } catch (err) {
      this.setData({
        isLoading: false,
        error: (err && err.message) || '通知加载失败',
      });
    } finally {
      this._loading = false;
    }
  },

  /** 全量列表 → 当前 Tab 过滤 + 回到第 1 页窗口 */
  applyFilter(tab) {
    const filtered = core.filterByTab(this._all, tab);
    this.setData({
      tab,
      items: filtered.slice(0, PAGE_SIZE),
      total: filtered.length,
      page: 0,
      endReached: filtered.length <= PAGE_SIZE,
      isLoading: false,
      isLoadingMore: false,
    });
  },

  /** 滚动到底扩窗（客户端分页：无在途请求，仅切片拼接） */
  loadMore() {
    const d = this.data;
    if (d.isLoading || d.isLoadingMore || d.endReached || d.error) return;
    const filtered = core.filterByTab(this._all, d.tab);
    const nextPage = d.page + 1;
    const items = filtered.slice(0, (nextPage + 1) * PAGE_SIZE);
    this.setData({
      items,
      page: nextPage,
      endReached: items.length >= filtered.length,
    });
  },

  /** 切换类型 Tab：重置窗口（对齐 Web setActiveTab + setSelectedIds([])） */
  onSelectTab(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.tab) return;
    this.applyFilter(id);
  },

  _countUnread() {
    return this._all.filter((n) => !n.isRead).length;
  },

  /** 未读数变化后同步「我的」Tab 红点（全部读完/删除未读后即时消失） */
  _syncBadge() {
    notificationBadge.applyUnreadBadge(this.data.unreadCount);
  },

  // ==================== 交互（已读 / 删除 / 跳转） ====================

  /** 点单条：未读 → 乐观置已读（Web handleRead 口径）；可映射 → 跳转 */
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    const item = this._all.find((n) => n.id === id);
    if (!item) return;
    if (!item.isRead) this._markReadLocally(id);
    if (item.target) {
      wx.navigateTo({ url: item.target });
    }
  },

  /** 乐观已读：本地置位 + 未读数重算；POST 失败静默（Web 同口径不回滚） */
  _markReadLocally(id) {
    const idx = this._all.findIndex((n) => n.id === id);
    if (idx < 0 || this._all[idx].isRead) return;
    this._all[idx] = Object.assign({}, this._all[idx], { isRead: true });
    const patch = { unreadCount: this._countUnread() };
    const viewIdx = this.data.items.findIndex((n) => n.id === id);
    if (viewIdx >= 0) {
      patch['items[' + viewIdx + '].isRead'] = true;
    }
    this.setData(patch);
    this._syncBadge();
    api.markRead(id).catch((err) => {
      console.error('markRead failed:', err && err.message);
    });
  },

  /** 一键全部已读（Web markAllAsRead 口径：成功后整列表置已读、未读清零） */
  async onMarkAll() {
    if (this.data.markingAll || this.data.unreadCount === 0) return;
    this.setData({ markingAll: true });
    try {
      await api.markAllRead();
      this._all = this._all.map((n) => Object.assign({}, n, { isRead: true }));
      // items 与 _all 同源对象副本：整窗替换（不可变更新，避免逐条路径补丁）
      const filtered = core.filterByTab(this._all, this.data.tab);
      this.setData({
        unreadCount: 0,
        items: filtered.slice(0, (this.data.page + 1) * PAGE_SIZE),
      });
      this._syncBadge();
    } catch (err) {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ markingAll: false });
    }
  },

  /** 长按删除：二次确认 → POST /delete → 本地移除 + 未读数重算 */
  onLongPressItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._deleting) return;
    wx.showModal({
      title: '删除通知',
      content: '确定要删除这条通知吗？',
      confirmText: '删除',
      confirmColor: '#d2503f',
      success: (res) => {
        if (!res.confirm) return;
        this._deleteByIds([id]);
      },
    });
  },

  async _deleteByIds(ids) {
    if (this._deleting) return;
    this._deleting = true;
    try {
      await api.removeNotifications(ids);
      // 对齐 Web handleDelete 成功分支：从列表过滤移除（未读项随之计入未读重算）
      this._all = this._all.filter((n) => ids.indexOf(n.id) < 0);
      const filtered = core.filterByTab(this._all, this.data.tab);
      const page = Math.max(0, Math.min(this.data.page, Math.ceil(filtered.length / PAGE_SIZE) - 1));
      const items = filtered.slice(0, (page + 1) * PAGE_SIZE);
      this.setData({
        items,
        total: filtered.length,
        page,
        endReached: items.length >= filtered.length,
        unreadCount: this._countUnread(),
      });
      this._syncBadge();
    } catch (err) {
      wx.showToast({ title: '删除失败，请重试', icon: 'none' });
    } finally {
      this._deleting = false;
    }
  },

  onRetry() {
    this.setData({ isLoading: true, error: '' });
    this.fetch();
  },

  /** 未登录错误框的「去登录」 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
});
