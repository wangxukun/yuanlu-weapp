// components/review/pron-notebook — 发音弱项本根视图（占位）
// 阶段四（T4.x）落地：语音画像 / AI 诊断报告 / 弱项句列表 / 闯关与排行榜入口。
// active 由复习中心传入：当前 Tab 激活时才拉取数据（懒加载），接入真实数据后启用。
Component({
  properties: {
    active: { type: Boolean, value: false }
  },

  data: {
    placeholder: {
      icon: '/assets/icons/mic-ink-active.svg',
      title: '发音弱项本',
      desc: 'AI 诊断发音弱项，五维画像 + 音素报告，逐句闯关攻克弱音。',
      phase: '阶段四落地'
    }
  }
});
