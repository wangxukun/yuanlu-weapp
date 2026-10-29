/**
 * pages/discover — 专项特训（第二 Tab，工具化转型重构）
 *
 * 三段式静态骨架（无信息流、无滚动容器）：
 *   1. 发音急救箱：薄弱音素诊断卡（mock 画像，接入语音评测画像后替换）
 *      →「立即攻克」进发音闯关
 *   2. 语境卡册书架：两列网格（display: grid），方形封面 + 书名 + 进度条
 *      → 点卡片进我的卡册（学习路径）
 *   3. 今日一测：固定高度单卡「今日微剧场听写」→「开始测试」取最新微场景
 *      进精研室（听写语境）
 */
const theme = require('../../utils/theme');
const { get } = require('../../utils/request');

/** 书架空壳数据（骨架期静态；进度在卡册资产接入后改由接口下发）。
 *  封面图标为书架专属批（work/record_voice_over/flight/history_edu，
 *  统一 #1f7a5c，不与任何存量图标重复） */
const SHELF_BOOKS = [
  { key: 'work', title: '职场高频句', cover: '/assets/icons/work-primary.svg', progress: 20 },
  { key: 'daily', title: '日常开口说', cover: '/assets/icons/record-voice-over-primary.svg', progress: 45 },
  { key: 'travel', title: '旅行出行', cover: '/assets/icons/flight-primary.svg', progress: 10 },
  { key: 'campus', title: '校园课堂', cover: '/assets/icons/history-edu-primary.svg', progress: 0 },
];

Page({
  data: {
    themeClass: '',
    // 发音急救箱（骨架期 mock 画像；语音评测画像接入后替换）
    weakPhoneme: '/θ/ 齿间音',
    books: SHELF_BOOKS,
    testBusy: false,
  },

  onLoad() {
    this.setData({ themeClass: theme.rootClass() });
  },

  onShow() {
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome();
  },

  /** 发音急救箱 → 发音闯关（薄弱音素专项） */
  onPhonemeGo() {
    wx.navigateTo({ url: '/pages/review/practice/index' });
  },

  /** 书架卡片 → 我的卡册（学习路径） */
  onBookTap() {
    wx.navigateTo({ url: '/pages/library/paths/index' });
  },

  /** 今日一测：取最新微场景进精研室听写（失败 toast，不中断骨架） */
  async onDailyTestTap() {
    if (this.data.testBusy) return;
    this.setData({ testBusy: true });
    try {
      const body = await get('/api/scenes/feed?page=1&pageSize=1', null, { showError: false });
      const sceneid = body && body.success && body.data && body.data.items
        && body.data.items[0] && body.data.items[0].sceneid;
      if (sceneid) {
        wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + sceneid });
      } else {
        wx.showToast({ title: '今日题库准备中，稍后再来', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '题库加载失败，请重试', icon: 'none' });
    } finally {
      this.setData({ testBusy: false });
    }
  },
});
