/**
 * pages/discover/index — 探索画廊（阶段 0 过渡态）
 *
 * 合规红线（RESHAPE-TASK T0.2）：节目榜单/新节目/全部节目网格/频道
 * 列表与节目搜索整体退役。完整形态（心愿定制栏 + 今日声音明信片 + 主题
 * 微剧场专栏，数据源 /api/scenes/*、/api/studio/*）待阶段 1 后端语料
 * 原子化就绪后按 T4.2 落地；当前仅保留主题态与静态预告卡。
 */
const theme = require('../../utils/theme');

Page({
  data: {
    themeClass: '',
  },

  onShow() {
    // 外观根类：手动模式覆盖令牌（跟随系统返回空类走媒体查询）
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏
  },
});
