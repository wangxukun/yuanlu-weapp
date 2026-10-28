/**
 * pages/library/history/index — 精研足迹（RESHAPE-TASK T5.2 重建）
 *
 * 数据源 = utils/study-footprint 本地足迹（微剧场精研室每次进入自动记录，
 * 同 sceneid 去重置顶）：
 *   - 今天 / 更早 两段分组，卡片 = 封面 + 标题 + 场景标签 + 时长 + 重研入口；
 *   - 清空足迹（确认弹窗）；
 *   - 空态引导去探索画廊。原「收听历史（剧集列表）」已随合规重塑退役。
 */
const theme = require('../../../utils/theme');
const footprint = require('../../../utils/study-footprint');

Page({
  data: {
    themeClass: '',
    dark: false,
    today: [], // 今日足迹（预格式化）
    earlier: [],
    total: 0,
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    this.refresh();
  },

  refresh() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayAt = startOfToday.getTime();
    const fmtTime = (at) => {
      const d = new Date(at);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      return h + ':' + m;
    };
    const fmtDate = (at) => {
      const d = new Date(at);
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    };
    const all = footprint.list().map((x) => ({
      at: x.at,
      sceneid: x.sceneid,
      title: x.title || '',
      coverUrl: x.coverUrl || '',
      durText: Math.round(x.duration || 0) + 's',
      situationTag: x.situationTag || '',
      timeText: fmtTime(x.at),
      dateText: fmtDate(x.at),
    }));
    this.setData({
      today: all.filter((x) => x.at >= todayAt).map(({ at, ...rest }) => rest),
      earlier: all.filter((x) => x.at < todayAt).map(({ at, ...rest }) => rest),
      total: all.length,
    });
  },

  onSceneTap(e) {
    const sceneid = e.currentTarget.dataset.scene;
    if (sceneid) wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + sceneid });
  },

  onClearAll() {
    if (!this.data.total) return;
    wx.showModal({
      title: '清空精研足迹',
      content: '将清除全部 ' + this.data.total + ' 条足迹（不影响学习统计）',
      confirmText: '清空',
      confirmColor: '#e0403f',
      success: (r) => {
        if (!r.confirm) return;
        footprint.clearAll();
        this.refresh();
        wx.showToast({ title: '已清空', icon: 'none' });
      },
    });
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },
});
