// pages/review/practice — 发音弱项闯关（占位）
// 对齐 Web library/pronunciation/practice/page.tsx：免费前 3 题试用 + 评测日池；
// 达标判定 score >= weakThreshold；试用结算墙「成就先行 → 下一关·解锁 PRO」。
// 深链 ?subtitleId= 定位某弱项句；阶段四 T4.5 落地。
Page({
  data: {},

  onLoad(options) {
    // 预留：GET /api/speech/errors 取题源与 weakThreshold
    this.launchOptions = options || {};
  }
});
