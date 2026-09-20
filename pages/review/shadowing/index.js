// pages/review/shadowing — AI 影子跟读评测（占位）
// 对齐 Web SentenceShadowingPractice.tsx：复用语音评测卡（录音 → 有道 ISE → 逐词/音素评分）。
// 深链 ?id=（收藏句 id，优先）/ ?subtitleId=（兜底）定位；阶段三 T3.4 落地。
Page({
  data: {},

  onLoad(options) {
    // 预留：按 id / subtitleId 定位当前句，拉字幕与签名音频注入评测卡
    this.launchOptions = options || {};
  }
});
