// components/review/vocab-notebook — 生词本根视图（占位）
// 阶段一（T1.x）落地：统计栏 / 配额卡 / 筛选与卡片列表 / 四题型复习入口。
// active 由复习中心传入：当前 Tab 激活时才拉取数据（懒加载），接入真实数据后启用。
Component({
  properties: {
    active: { type: Boolean, value: false }
  },

  data: {
    placeholder: {
      icon: '/assets/icons/book-a-active.svg',
      title: '生词本',
      desc: '收录剧集生词，按遗忘曲线安排复习，支持填空、选择、中译英、猜词四题型练习。',
      phase: '阶段一落地'
    }
  }
});
