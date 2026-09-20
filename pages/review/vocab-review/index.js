// pages/review/vocab-review — 生词卡片复习（占位）
// 对齐 Web ReviewModal.tsx：四题型（填空/选择/中译英/猜词）+ 3D 翻卡 + SRS 四档 + 总结页。
// 阶段一 T1.5 落地；本桩仅保证路由可达与深链参数不丢。
Page({
  data: {},

  onLoad(options) {
    // 预留：复习队列自取 /api/vocabulary/all 筛到期词（无服务端池）
    this.launchOptions = options || {};
  }
});
