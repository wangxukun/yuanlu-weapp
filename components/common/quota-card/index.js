/**
 * components/common/quota-card — 配额双栏状态卡
 * 复刻 Web 端 components/quota/QuotaStatusCard.tsx（[P3-d] 配额倒计时可视化）：
 *
 * - PRO 无限态：琥珀 infinity 徽标 + 主/副文案单行
 * - 免费双栏态：左主容量栏 + 右今日栏；每栏 = 标题左 / 状态文本右 / "已用量"进度条
 * - 三态梯度内聚于此（对齐 Web getStatusBarColor，阈值与 80% 预告同一条规则）：
 *     Safe   <80%（主题绿）
 *     Warning ≥80% 且未满（琥珀）
 *     Full   已满或耗尽（红）
 *
 * 状态文本（statusText）由调用方按各自模块口径拼装后传入——Web 端各模块文案
 * 存在细微差异（生词本「还能收藏38个」/ 句子本「还能收藏 5 句」），逐字保真。
 *
 * 使用示例（生词本，配额数字与 lib/quota.ts 常量一致）：
 * <quota-card
 *   isPremium="{{isPremium}}"
 *   premiumTitle="PRO 无限收藏 · 已收 {{stats.total}} 词"
 *   premiumSubtitle="容量不设限，每日新增也不限"
 *   primaryLabel="生词本容量"
 *   primaryStatusText="{{stats.total}}/50 · 还能收藏{{50 - stats.total}}个"
 *   primaryUsed="{{stats.total}}" primaryLimit="{{50}}"
 *   dailyLabel="今日收藏生词"
 *   dailyStatusText="{{todayAddedCount}}/5 · 剩{{5 - todayAddedCount}}次"
 *   dailyUsed="{{todayAddedCount}}" dailyLimit="{{5}}" />
 */
Component({
  properties: {
    isPremium: { type: Boolean, value: false },
    /** PRO 态主文案，如 "PRO 无限收藏 · 已收 12 词" */
    premiumTitle: { type: String, value: '' },
    /** PRO 态副文案，如 "容量不设限，每日新增也不限" */
    premiumSubtitle: { type: String, value: '' },
    /** 主栏标题（如 "生词本容量" / "句子本容量"） */
    primaryLabel: { type: String, value: '' },
    /** 主栏状态文本（如 "12/50 · 还能收藏38个"），调用方拼装 */
    primaryStatusText: { type: String, value: '' },
    primaryUsed: { type: Number, value: 0 },
    primaryLimit: { type: Number, value: 0 },
    /** 今日栏标题（如 "今日收藏生词" / "今日复习评测"） */
    dailyLabel: { type: String, value: '' },
    dailyStatusText: { type: String, value: '' },
    dailyUsed: { type: Number, value: 0 },
    dailyLimit: { type: Number, value: 0 },
  },

  data: {
    primary: { percent: 0, level: 'safe' },
    daily: { percent: 0, level: 'safe' },
  },

  observers: {
    'primaryUsed, primaryLimit': function (used, limit) {
      this.setData({ primary: this.buildBar(used, limit) });
    },
    'dailyUsed, dailyLimit': function (used, limit) {
      this.setData({ daily: this.buildBar(used, limit) });
    },
  },

  methods: {
    /**
     * 三态梯度 + 进度百分比（对齐 Web getStatusBarColor）：
     * full = used>=limit；warning = used >= ceil(limit*0.8) 且未满；safe 其余。
     */
    buildBar(used, limit) {
      const u = Number(used) || 0;
      const l = Number(limit) || 0;
      let level = 'safe';
      if (l > 0 && u >= l) {
        level = 'full';
      } else if (l > 0 && u >= Math.ceil(l * 0.8)) {
        level = 'warning';
      }
      const percent = l > 0 ? Math.min(100, (u / l) * 100) : 0;
      return { level, percent };
    },
  },
});
