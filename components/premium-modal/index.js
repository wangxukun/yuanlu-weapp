/**
 * components/premium-modal — 会员转化弹窗（复刻 Web 端 PremiumModal 的场景化承接）
 *
 * 使用：<premium-modal visible="{{show}}" source="episode_deep_dive" bind:close="onModalClose" />
 * CTA 目前为占位（订阅页未建，见 WE-TASK 3.D/后续规划），上线订阅页后替换 onCta。
 */

const SCENARIOS = {
  episode_deep_dive: {
    title: 'AI 精讲这集播客',
    description:
      '难点词汇预扫、长难句逐层拆解、跟读句推荐、理解测验——AI 把每一集变成一节精听课。PRO 专属。',
    benefits: [
      '难点词汇预扫 + 长难句拆解',
      '本集跟读句推荐',
      '理解测验即时检验',
    ],
  },
};

Component({
  properties: {
    visible: { type: Boolean, value: false },
    source: { type: String, value: 'episode_deep_dive' },
  },

  data: {
    scenario: SCENARIOS.episode_deep_dive,
  },

  observers: {
    source(val) {
      this.setData({ scenario: SCENARIOS[val] || SCENARIOS.episode_deep_dive });
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },
    noop() {},
    onCta() {
      // TODO: 订阅页落地后改为 wx.navigateTo({ url: '/pages/subscription/index?source=' + this.data.source })
      this.onClose();
      wx.showToast({ title: '订阅功能即将上线', icon: 'none' });
    },
  },
});
