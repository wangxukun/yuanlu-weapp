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
      const [podcasts, tags] = await Promise.all([
        get('/api/podcast/list'),
        get('/api/tag/list')
      ]);

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
      // 对接真实搜索 API
      const results = await get(`/api/podcast/search?q=${encodeURIComponent(query)}`);
      this.setData({ searchResults: results, isSearching: false });
    } catch {
      this.setData({ searchResults: [], isSearching: false });
    }
  },

  /** 标签筛选（对齐 Android selectTag） */
  onSelectTag(e) {
    const tagId = e.currentTarget.dataset.id || null;
    const newTagId = tagId === this.data.selectedTagId ? null : tagId;
    const filtered = newTagId
      ? this.data.allPodcasts.filter(p => p.tags && p.tags.some(t => t.id === newTagId))
      : this.data.allPodcasts;

    this.setData({
      selectedTagId: newTagId,
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
