// pages/channel/all/index — 全部频道页
// 复刻 yuanlu-android feature/discover/ChannelListScreen.kt（复用 DiscoverViewModel）：
// GET /api/podcast/list → 按 platform 聚合（过滤空值）→ {name, podcastCount} 按节目数降序；
// 双列 1:1 方卡（primaryContainer=#edf7f2 圆角 16dp）、名称单行截断、
// 「X 档节目」（onPrimaryContainer 70%）、白底胶囊（Computer 图标 + 「频道主页」）。
// 入口：发现页「推荐频道 · 查看更多」；卡片点击 → 频道详情页（?name= 深链）。
const { get } = require('../../../utils/request');

Page({
  data: {
    isLoading: true,
    error: null,
    channels: [],     // ChannelEntry[]: { name, podcastCount }
    channelRows: [],  // 双列分块
  },

  onLoad() {
    this.loadChannels();
  },

  /** 拉取全量播客并按 platform 聚合（对齐 Android DiscoverViewModel.load 的 channels 派生） */
  async loadChannels() {
    this.setData({ isLoading: true, error: null });
    try {
      const podcasts = await get('/api/podcast/list');
      const channelMap = {};
      (podcasts || []).forEach((p) => {
        const name = p.platform;
        if (!name) return; // filterKeys { !name.isNullOrBlank() }
        channelMap[name] = (channelMap[name] || 0) + 1;
      });
      const channels = Object.keys(channelMap)
        .map((name) => ({ name, podcastCount: channelMap[name] }))
        .sort((a, b) => b.podcastCount - a.podcastCount); // sortedByDescending podcastCount

      this.setData({
        isLoading: false,
        channels,
        channelRows: this._chunkPairs(channels),
      });
    } catch (err) {
      this.setData({ isLoading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 重试（对齐 Android ErrorBox onRetry = viewModel::load） */
  onRetry() {
    this.loadChannels();
  },

  /** 卡片/「频道主页」点击 → 频道详情页（onOpenChannel(channel.name)） */
  onOpenChannel(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    wx.navigateTo({ url: `/pages/channel/index?name=${encodeURIComponent(name)}` });
  },

  /** 双列分块（全站同款） */
  _chunkPairs(arr) {
    const rows = [];
    for (let i = 0; i < arr.length; i += 2) {
      rows.push(arr.slice(i, i + 2));
    }
    return rows;
  },
});
