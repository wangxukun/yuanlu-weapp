const { get } = require('../../utils/request');

Page({
  data: {
    isLoading: true,
    error: null,

    // 搜索
    query: '',
    searchResults: null,
    isSearching: false,

    // 分类标签
    tags: [],
    selectedTagId: null,
    selectedTagName: '',

    // 区块数据
    trending: [],      // 热门榜 (totalPlays 降序 TOP6)
    editorPicks: [],   // 为您推荐 (isEditorPick)
    newPodcasts: [],   // 新节目 (createAt 降序前 8)
    channels: [],      // 推荐频道 (platform 聚合)

    // 全部播客 & 过滤后
    allPodcasts: [],
    filteredPodcasts: [],

    // 搜索防抖定时器
    _searchTimer: null
  },

  onLoad() {
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().then(() => wx.stopPullDownRefresh());
  },

  /** 加载发现页全量数据 */
  async loadData() {
    this.setData({ isLoading: true, error: null });
    try {
      // 对接真实 API (对齐 Android ContentApi 路由)
      const podcasts = await get('/api/podcast/list');

      // 分类标签数据源：由播客列表实际挂的标签派生（按命中播客数降序）。
      // 不用 /api/tag/list —— 那是标签全库（课程/语法型），与播客实际标签
      // 交集≈0（2026-09-21 实测 20 个仅 1 个命中），点了必空；Android 端
      // FilterChip 即因同款数据源失效。派生保证每个 chip 至少命中 1 档。
      const tagMap = {};
      podcasts.forEach(p => (p.tags || []).forEach(t => {
        if (!t || t.id == null) return;
        if (!tagMap[t.id]) tagMap[t.id] = { id: t.id, name: t.name, count: 0 };
        tagMap[t.id].count += 1;
      }));
      const tags = Object.values(tagMap).sort((a, b) => b.count - a.count);

      // 客户端派生区块（对齐 Android DiscoverViewModel）
      const trending = [...podcasts]
        .sort((a, b) => (b.totalPlays || 0) - (a.totalPlays || 0))
        .slice(0, 10); // TOP 10

      const editorPicks = podcasts.filter(p => p.isEditorPick);

      const newPodcasts = podcasts
        .filter(p => p.createAt)
        .sort((a, b) => new Date(b.createAt) - new Date(a.createAt))
        .slice(0, 8); // TOP 8

      // 频道聚合
      const channelMap = {};
      podcasts.forEach(p => {
        if (p.platform) {
          channelMap[p.platform] = (channelMap[p.platform] || 0) + 1;
        }
      });
      const channels = Object.entries(channelMap)
        .map(([name, count]) => ({ name, podcastCount: count }))
        .sort((a, b) => b.podcastCount - a.podcastCount);

      // 热门榜每行两列：预处理成二维数组供 WXML 双列渲染
      const trendingRows = this._chunkPairs(trending.slice(0, 6)); // 截取前6供UI展示
      const picksRows = this._chunkPairs(editorPicks.slice(0, 6));
      const newRows = this._chunkPairs(newPodcasts.slice(0, 6));
      const channelRows = this._chunkPairs(channels.slice(0, 6));
      const allRows = this._chunkPairs(podcasts);

      this.setData({
        isLoading: false,
        allPodcasts: podcasts,
        filteredPodcasts: podcasts,
        filteredRows: allRows,
        tags,
        trending, trendingRows,
        editorPicks, picksRows,
        newPodcasts, newRows,
        channels, channelRows
      });
    } catch (err) {
      this.setData({ isLoading: false, error: err.message || '加载失败' });
    }
  },

  /** 搜索输入（400ms 防抖，对齐 Android queryInput.debounce(400)） */
  onSearchInput(e) {
    const query = e.detail.value;
    this.setData({ query });
    if (this.data._searchTimer) clearTimeout(this.data._searchTimer);

    if (!query.trim()) {
      this.setData({ searchResults: null, isSearching: false });
      return;
    }

    const timer = setTimeout(() => this.doSearch(query.trim()), 400);
    this.data._searchTimer = timer;
  },

  onClearSearch() {
    if (this.data._searchTimer) clearTimeout(this.data._searchTimer);
    this.setData({ query: '', searchResults: null, isSearching: false });
  },

  async doSearch(query) {
    this.setData({ isSearching: true });
    try {
      // 对接真实搜索 API（该接口返回 {success, data, query, total} 包装，取 data 数组）
      const res = await get(`/api/podcast/search?q=${encodeURIComponent(query)}`);
      const results = Array.isArray(res.data)
        ? res.data.map((p) => ({ ...p, topTags: (p.tags || []).slice(0, 2) }))
        : [];
      this.setData({ searchResults: results, searchResultRows: this._chunkPairs(results), isSearching: false });
    } catch {
      this.setData({ searchResults: [], searchResultRows: [], isSearching: false });
    }
  },

  /** 搜索结果底部「查看全部结果」→ 独立搜索页（对齐 Web SearchBar 下拉的“搜索 q 的全部结果”） */
  onOpenFullSearch() {
    const q = (this.data.query || '').trim();
    if (!q) return;
    wx.navigateTo({ url: `/pages/search/search?q=${encodeURIComponent(q)}` });
  },

  /** 标签筛选（对齐 Android selectTag 的 toggle 语义：再点同标签取消） */
  onSelectTag(e) {
    const tagId = e.currentTarget.dataset.id || null;
    const newTagId = tagId === this.data.selectedTagId ? null : tagId;
    const filtered = newTagId
      ? this.data.allPodcasts.filter(p => p.tags && p.tags.some(t => t.id === newTagId))
      : this.data.allPodcasts;
    const selectedTag = newTagId
      ? this.data.tags.find(t => t.id === newTagId)
      : null;

    this.setData({
      selectedTagId: newTagId,
      selectedTagName: selectedTag ? selectedTag.name : '',
      filteredPodcasts: filtered,
      filteredRows: this._chunkPairs(filtered)
    });
  },

  /** 点击播客卡片 → 播客详情页 */
  onOpenPodcast(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/podcast/podcast?id=${id}` });
  },

  /** 点击频道卡片 */
  onOpenChannel(e) {
    const name = e.currentTarget.dataset.name;
    wx.navigateTo({ url: `/pages/channel/index?name=${encodeURIComponent(name)}` });
  },

  /** 查看全部频道 */
  onViewAllChannels() {
    wx.navigateTo({ url: '/pages/channel/all/index' });
  },

  // ---- 工具方法 ----

  /** 将数组按 2 个一组分块（双列网格渲染用） */
  _chunkPairs(arr) {
    const result = [];
    for (let i = 0; i < arr.length; i += 2) {
      result.push(arr.slice(i, i + 2));
    }
    return result;
  }
});
