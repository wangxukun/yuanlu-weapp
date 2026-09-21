// pages/channel/index — 频道详情页
// 融合复刻：数据层照搬 yuanlu-android ChannelScreen.kt + ChannelViewModel.kt
// （GET /api/channel/{name} 信封 → {platformName, podcastCount, topShows, topEpisodes}；
// topShows=该平台全部播客 totalPlays 降序，topEpisodes=playCount 降序 take 9，封面 3h 签名）；
// UI 上半部（页头/热门节目双列网格）复刻 ChannelScreen + 频道页面.jpg，
// 下半部（热门单集列表）逐字复刻本工程播客详情页 episode-row（16:9 封面 +
// 等级徽章 + 时长遮罩 + 耳机/日历数据栏，wxs 亦复用 pages/podcast/podcast.wxs）。
const { get } = require('../../utils/request');

Page({
  data: {
    name: '',
    isLoading: true,
    error: null,
    channel: null,     // { platformName, podcastCount }
    topShows: [],
    showRows: [],      // 双列分块（chunked(2) + weight(1f) 占位）
    topEpisodes: [],
  },

  onLoad(options) {
    const name = options && options.name ? decodeURIComponent(options.name) : '';
    this.setData({ name });
    if (name) {
      wx.setNavigationBarTitle({ title: name });
      this.loadChannel(name);
    }
  },

  /** 拉取频道数据（对齐 ChannelViewModel.load → ContentRepository.getChannel） */
  async loadChannel(name) {
    // 对齐 Android load(name) 的 loadedName 防重语义（retry 复用同名重拉）
    this._loadedName = name;
    this.setData({ isLoading: true, error: null });
    try {
      const res = await get(`/api/channel/${encodeURIComponent(name)}`);
      // 信封校验：!success || data == null → IOException(response.error ?: "加载频道失败")
      if (!res || !res.success || !res.data) {
        throw new Error((res && res.error) || '加载频道失败');
      }
      const d = res.data;
      const topShows = d.topShows || [];
      const topEpisodes = (d.topEpisodes || []).map((e) => ({
        ...e,
        podcastTitle: (e.podcast && e.podcast.title) || '',
        podcastCoverUrl: (e.podcast && e.podcast.coverUrl) || '',
      }));
      this.setData({
        isLoading: false,
        channel: { platformName: d.platformName, podcastCount: d.podcastCount },
        topShows,
        showRows: this._chunkPairs(topShows),
        topEpisodes,
      });
    } catch (err) {
      this.setData({ isLoading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 重试（对齐 ChannelViewModel.retry = loadedName?.let(::load)） */
  onRetry() {
    if (this._loadedName) this.loadChannel(this._loadedName);
  },

  /** 热门节目卡 → 播客详情页 */
  onOpenPodcast(e) {
    wx.navigateTo({ url: `/pages/podcast/podcast?id=${e.currentTarget.dataset.id}` });
  },

  /** 热门单集行 → 剧集详情页 */
  onOpenEpisode(e) {
    wx.navigateTo({ url: `/pages/episode/episode?id=${e.currentTarget.dataset.id}` });
  },

  /** 双列分块（对齐 topShows.chunked(2) + 单卡行 Spacer(weight(1f)) 占位） */
  _chunkPairs(arr) {
    const rows = [];
    for (let i = 0; i < arr.length; i += 2) {
      rows.push(arr.slice(i, i + 2));
    }
    return rows;
  },
});
