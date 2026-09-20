// pages/review/deck — 刷句复习卡片流（占位）
// 对齐 Web ReviewDeck.tsx：左滑下一句 / 右滑重听（阈值 offset ±90px / velocity ±400），
// 点击翻面（防误触 <10px），末尾回环；深链 ?subtitleId= 定位初始卡。
// 阶段三 T3.3 落地。
Page({
  data: {},

  onLoad(options) {
    // 预留：深链定位 options.subtitleId（findIndex 命中，未命中回落 0）
    this.launchOptions = options || {};
  }
});
