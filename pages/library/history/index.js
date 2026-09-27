/**
 * pages/library/history/index.js — 「收听历史」
 *
 * 逻辑移植自 Android 端 feature/history：
 *   - HistoryViewModel.kt：UiState（isLoading/isRefreshing/error/filter/items/total/
 *     page/isLoadingMore/endReached）+ 服务端分页与状态过滤（切换重置重拉、
 *     下拉刷新清空重载、滚动到底自动加载下一页、在途/到底/出错防重入）；
 *   - HistoryUiState.groupByTimeline：今天 / 昨天 / 更早显示具体日期（如 2026年9月4日），
 *     数据已按 listenAt 倒序返回，分组保持首次出现顺序（近 → 远）。
 *
 * API（对齐 ContentApi.kt 收听历史段，需登录）：
 *   GET /api/user/history?page=1&pageSize=20&status=all|in-progress|finished
 *   信封 { success, data: { items, total, hasMore } }；progressSeconds 为 Float 需取整，
 *   duration 服务端已格式化为 "M:SS"。
 */

const theme = require('../../../utils/theme');
const { get } = require('../../../utils/request');
const authStore = require('../../../store/authStore');

const PAGE_SIZE = 20;

/** 状态过滤器（对齐 HistoryFilter：apiValue / 中文标签） */
const FILTERS = [
  { key: 'all', api: 'all', label: '全部' },
  { key: 'in-progress', api: 'in-progress', label: '进行中' },
  { key: 'finished', api: 'finished', label: '已完成' },
];

/** "M:SS"（对齐 Android formatMillis：%d:%02d，负值钳 0） */
function formatMillis(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m + ':' + String(ss).padStart(2, '0');
}

/**
 * "2026-09-06T07:00:00.123Z" → 本地时区 Date；解析失败返回 null
 * （对齐 parseUtcToLocal：后端送 UTC ISO 串，真机 JSC 对带毫秒/Z 的
 * ISO 解析存在兼容差异，手工拼 UTC 分量后交 Date.UTC 换算本地时区）
 */
function parseUtcToLocal(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const date = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  );
  return isNaN(date.getTime()) ? null : date;
}

/** 本地日 key（对齐 calendarKey：同年同日归一组） */
function dayKey(date) {
  return date.getFullYear() * 1000 + dayOfYear(date);
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

/** 具体日期标签："2026年9月4日"（月/日无前导零） */
function chineseDateLabel(date) {
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

/**
 * 按收听日期分组：今天 / 昨天 / 更早显示具体日期（对齐 groupByTimeline）。
 * 依赖 items 倒序，组顺序 = 首次出现顺序。
 */
function groupByTimeline(items) {
  const now = new Date();
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(now.getTime() - 86400000));

  const byLabel = {};
  const order = [];
  items.forEach((item) => {
    const date = parseUtcToLocal(item.listenAt);
    const label =
      !date
        ? '更早'
        : dayKey(date) === todayKey
          ? '今天'
          : dayKey(date) === yesterdayKey
            ? '昨天'
            : chineseDateLabel(date);
    if (!(label in byLabel)) {
      byLabel[label] = [];
      order.push(label);
    }
    byLabel[label].push(item);
  });
  return order.map((label) => ({ label, items: byLabel[label] }));
}

/** DTO → 展示模型（对齐 HistoryItemDto.toDomain + progressRatio/percentText 派生） */
function mapItem(raw) {
  const episode = (raw && raw.episode) || {};
  const progressSeconds = Math.round(Number(raw.progressSeconds) || 0);
  const durationSeconds = Number(episode.durationSeconds) || 0;
  const ratio =
    durationSeconds > 0
      ? Math.min(1, Math.max(0, progressSeconds / durationSeconds))
      : 0;
  const isFinished = !!raw.isFinished;
  // duration 服务端已格式化 "M:SS"，缺失时回退秒数换算（对齐 progressText()）
  const durationText =
    (episode.duration || '').trim() || formatMillis(durationSeconds);
  return {
    historyid: raw.historyid,
    listenAt: raw.listenAt || '',
    episodeId: episode.id || '',
    title: episode.title || '',
    category: episode.category || '',
    thumbnailUrl: episode.thumbnailUrl || '',
    progressSeconds,
    isFinished,
    ratio,
    percent: Math.round(ratio * 100),
    progressText: '已听 ' + formatMillis(progressSeconds) + ' / ' + durationText,
  };
}

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    filters: FILTERS,
    // ---- HistoryUiState ----
    isLoading: true,
    error: '',
    needLogin: false, // 错误态区分「去登录」与「重试」
    filter: 'all', // 'all' | 'in-progress' | 'finished'
    groups: [], // 渲染源：[{ label, items }]
    items: [], // 展示模型全量（页脚到底判定与分组源）
    total: 0,
    page: 0,
    isLoadingMore: false,
    endReached: false,
  },

  onLoad() {
    this._loading = false; // 在途请求防重入（对齐 loadMore 的 isLoading 闸）
    this._hasLoaded = false;
  },

  onShow() {
    // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    // 首载在 onLoad 后由这里触发；登录页返回后（此前被登录闸拦下）自动补拉
    if (!this._hasLoaded) this.fetch(1, { showLoading: true });
  },

  onUnload() {},

  onPullDownRefresh() {
    // 对齐 refresh()：清回第 1 页重载，成功后替换列表
    this.fetch(1, { showLoading: false }).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    // 对齐滚动接近末尾自动加载（weapp 惯例以 onReachBottom 表达）
    this.loadMore();
  },

  // ==================== 数据获取（对齐 HistoryViewModel.load） ====================

  async fetch(page, opts = {}) {
    const showLoading = opts.showLoading !== false;
    // 登录闸：未登录不发请求，落在引导态（对齐后端需登录 + favorites 页口径）
    if (!authStore.getState().isLoggedIn) {
      this.setData({ isLoading: false, needLogin: true, error: '' });
      return;
    }
    if (this._loading) return;
    this._loading = true;
    if (page > 1) this.setData({ isLoadingMore: true });
    else if (showLoading) this.setData({ isLoading: true, error: '', needLogin: false });

    try {
      const res = await get(
        '/api/user/history?page=' + page + '&pageSize=' + PAGE_SIZE + '&status=' + this.data.filter
      );
      const data = (res && res.data) || {};
      const fresh = page === 1;
      const incoming = (data.items || []).map(mapItem);
      const items = fresh ? incoming : this.data.items.concat(incoming);
      this._hasLoaded = true;
      this.setData({
        isLoading: false,
        isLoadingMore: false,
        error: '',
        needLogin: false,
        items,
        groups: groupByTimeline(items),
        total: Number(data.total) || 0,
        page,
        endReached: !data.hasMore,
      });
    } catch (err) {
      this.setData({
        isLoading: false,
        isLoadingMore: false,
        error: (err && err.message) || '收听历史加载失败',
      });
    } finally {
      this._loading = false;
    }
  },

  /** 切换状态过滤：重置分页与列表后重拉（对齐 selectFilter） */
  onSelectFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.filter) return;
    this.setData({
      filter: key,
      items: [],
      groups: [],
      total: 0,
      page: 0,
      endReached: false,
      isLoading: true,
      error: '',
    });
    this.fetch(1, { showLoading: false });
  },

  /** 加载下一页（对齐 loadMore 的四重防重入闸） */
  loadMore() {
    const d = this.data;
    if (d.isLoading || d.isLoadingMore || d.endReached || d.error) return;
    this.fetch(d.page + 1);
  },

  onRetry() {
    this.setData({ isLoading: true, error: '' });
    this.fetch(1, { showLoading: false });
  },

  /** 登录态错误框的「去登录」 */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  // ==================== 跳转 ====================

  onOpenEpisode(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/episode/episode?id=' + id });
  },
});
