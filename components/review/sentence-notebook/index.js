// components/review/sentence-notebook — 句子本根视图（占位）
// 阶段二（T2.x）落地：统计/配额卡 / 搜索筛选 / 卡片与清单双视图 / 标签抽屉。
// active 由复习中心传入：当前 Tab 激活时才拉取数据（懒加载），接入真实数据后启用。
Component({
  properties: {
    active: { type: Boolean, value: false }
  },

  data: {
    placeholder: {
      icon: '/assets/icons/text-quote-active.svg',
      title: '句子本',
      desc: '收藏播客关键句，支持生词高亮、片段精听、刷句卡片流复习与 AI 影子跟读。',
      phase: '阶段二 / 三落地'
    }
  }
});
