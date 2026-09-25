// pages/search/search — 独立搜索页
// 复刻 Web 端 app/(main)/search/page.tsx + SearchResultsContent.tsx：
// 标题区/空态/骨架屏/结果网格/无结果态文案逐字对齐；搜索输入复刻
// components/header/SearchBar.tsx（placeholder 与图标）。
// 深链 ?q= 对齐 Web /search?q=；结果卡点击进播客详情。
const theme = require('../../utils/theme');
const { get } = require('../../utils/request');

// 对齐 Web searchPodcasts({ query, limit: 40 })；REST 路由上限 50
const SEARCH_LIMIT = 40;
// 对齐发现页/Android queryInput.debounce(400)
const DEBOUNCE_MS = 400;

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    query: '',      // 输入框当前值
    searched: null, // 最近一次提交的搜索词（null = 尚未搜索，对应 Web 无 q 参数）
    results: [],
    resultRows: [], // 双列网格（与发现页同款分块渲染）
    total: 0,
    isSearching: false,
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
  },

  onLoad(options) {
    // 深链 /pages/search/search?q=xxx（对齐 Web /search?q=）
    const q = options && options.q ? decodeURIComponent(options.q) : '';
    if (q.trim()) {
      this.setData({ query: q.trim() });
      this.doSearch(q.trim());
    }
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer);
  },

  /** 输入防抖：清空立即回初始态，非空 400ms 后提交（对齐发现页 onSearchInput） */
  onSearchInput(e) {
    const query = e.detail.value || '';
    this.setData({ query });
    if (this._timer) clearTimeout(this._timer);

    if (!query.trim()) {
      this.setData({ searched: null, results: [], resultRows: [], total: 0, isSearching: false });
      return;
    }
    this._timer = setTimeout(() => this.doSearch(query.trim()), DEBOUNCE_MS);
  },

  /** 键盘「搜索」立即提交，不等防抖 */
  onConfirm(e) {
    if (this._timer) clearTimeout(this._timer);
    const q = ((e.detail && e.detail.value) || this.data.query || '').trim();
    if (q) this.doSearch(q);
  },

  onClear() {
    if (this._timer) clearTimeout(this._timer);
    this.setData({ query: '', searched: null, results: [], resultRows: [], total: 0, isSearching: false });
    // 对齐 Web generateMetadata：无 q 时标题回落「搜索」
    wx.setNavigationBarTitle({ title: '搜索' });
  },

  async doSearch(q) {
    this.setData({ isSearching: true });
    // 对齐 Web generateMetadata：query ? `"${query}" 的搜索结果` : `搜索`
    wx.setNavigationBarTitle({ title: `“${q}” 的搜索结果` });
    try {
      const res = await get(`/api/podcast/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
      // 该接口返回 {success, data, query, total} 包装（区别于 /api/podcast/list 的裸数组）
      const results = res && Array.isArray(res.data)
        ? res.data.map((p) => ({ ...p, topTags: (p.tags || []).slice(0, 2) }))
        : [];
      this.setData({
        searched: q,
        results,
        resultRows: this._chunkPairs(results),
        total: res && typeof res.total === 'number' ? res.total : results.length,
        isSearching: false,
      });
    } catch (err) {
      // request.js 已对非 2xx 全局 toast，这里只复位不重复提示
      this.setData({ searched: q, results: [], resultRows: [], total: 0, isSearching: false });
    }
  },

  /** 点击播客卡片 → 播客详情页 */
  onOpenPodcast(e) {
    wx.navigateTo({ url: `/pages/podcast/podcast?id=${e.currentTarget.dataset.id}` });
  },

  /** 无结果态「发现页面」链接（Web 端 /discover 链接的 switchTab 等价物） */
  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },

  /** 将数组按 2 个一组分块（双列网格渲染用，与发现页同款） */
  _chunkPairs(arr) {
    const rows = [];
    for (let i = 0; i < arr.length; i += 2) {
      rows.push(arr.slice(i, i + 2));
    }
    return rows;
  },
});
