// pages/channel/all/index — 全部频道页
// 数据源与视觉对齐 Web app/(main)/discover/channels/page.tsx（同一 getRecommendedChannels
// 数据源 + 同款 ChannelCard）：GET /api/channels → {name, coverUrl, podcastCount,
// episodeCount, totalPlays}，封面为服务端解析的频道品牌横幅（OSS 签名）或代表节目封面，
// 排序 = channel 表 sortOrder 优先、其余按总播放量（全部收敛在服务端，与 Web 完全同口径）。
// 布局保留小程序原双列网格（每行两个），卡片由 components/common/channel-card 渲染。
// 入口：发现页「推荐频道 · 查看更多」；卡片点击 → 频道详情页（?name= 深链）。
const theme = require('../../../utils/theme');
const { fetchChannels } = require('../../../utils/channels');

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    isLoading: true,
    error: null,
    channels: [],     // ChannelItem[]: { name, coverUrl, podcastCount, episodeCount, totalPlays }
    channelRows: [],  // 双列分块
  },

  onShow() {
      // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
      const __t = theme.getState();
      this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
      theme.applyChrome();
  },

  onLoad() {
    this.loadChannels();
  },

  /** 拉取频道列表（utils/channels → GET /api/channels，Web 全部频道页同源） */
  async loadChannels() {
    this.setData({ isLoading: true, error: null });
    try {
      const channels = await fetchChannels();
      this.setData({
        isLoading: false,
        channels,
        channelRows: this._chunkPairs(channels),
      });
    } catch (err) {
      this.setData({ isLoading: false, error: (err && err.message) || '加载失败' });
    }
  },

  /** 重试（对齐 Web/Android ErrorBox onRetry = reload） */
  onRetry() {
    this.loadChannels();
  },

  /** 频道卡（channel-card 组件 open 事件）→ 频道详情页 */
  onOpenChannel(e) {
    const name = e.detail.name;
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
