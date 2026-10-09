// components/common/channel-card — 频道卡片
// 严格复刻 Web components/discover/ChannelCard.tsx（发现页「推荐频道」/全部频道页共用）：
// primary-50 圆角卡（rounded-xl + primary-100/70 描边）+ 16:9 频道横幅封面（品牌横幅
// OSS 签名或代表节目封面，服务端已解析）+ 「频道 Channel」大写眉标 + 加粗频道名 +
// podcasts 天线图标集数行（「N 集 · M 档节目」，档数 <3 不展示避免放大资源量小的观感）。
// 数据源 GET /api/channels（Web lib/discover-service getRecommendedChannels 公开口径）。
const theme = require('../../../utils/theme');

/** 集数展示格式：万位以上缩写，避免长数字撑破卡片（Web ChannelCard.formatEpisodeCount 同源移植） */
function formatEpisodeCount(count) {
  if (count >= 10000) {
    const wan = (count / 10000).toFixed(1).replace(/\.0$/, '');
    return `${wan}万`;
  }
  return `${count}`;
}

/** 兜底字标缩写：取前两个词的首字母（对齐 Web ui-avatars name= 的 initials 规则） */
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
}

Component({
  properties: {
    // { name, coverUrl, podcastCount, episodeCount }（utils/channels.fetchChannels 口径）
    channel: { type: Object, value: null },
  },

  data: {
    // 外观根类：组件根自持 themeClass（手动深色令牌覆盖的载体——组件样式
    // 无法命中页面层祖先类，eval-card/vocab-notebook 同款配方）
    themeClass: '',
    dark: false,
    // WXML 就绪派生（零方法调用红线）
    name: '',
    hasCover: false,
    coverUrl: '',
    coverError: false,
    initial: '',
    episodeText: '',
    showPodcastCount: false,
    podcastCount: 0,
  },

  lifetimes: {
    attached() {
      this.setData({
        themeClass: theme.rootClass(),
        dark: theme.getEffective() === 'dark',
      });
    },
  },

  observers: {
    channel(c) {
      if (!c) return;
      const hasCover = !!(c.coverUrl && c.coverUrl !== 'default_cover_url');
      this.setData({
        name: c.name || '',
        hasCover,
        coverUrl: hasCover ? c.coverUrl : '',
        coverError: false,
        initial: initialsOf(c.name),
        episodeText: formatEpisodeCount(c.episodeCount || 0),
        showPodcastCount: (c.podcastCount || 0) >= 3,
        podcastCount: c.podcastCount || 0,
      });
    },
  },

  methods: {
    /** 封面加载失败 → 本地品牌色字标兜底（外链不可达时的 Web ui-avatars 等价物） */
    _onCoverError() {
      if (this.data.coverUrl) this.setData({ coverError: true });
    },

    /** 卡片点击 → 冒泡 open 事件（页面侧跳频道详情页深链） */
    _onTap() {
      this.triggerEvent('open', { name: this.data.name });
    },
  },
});
