/**
 * components/premium-modal — 会员转化弹窗（复刻 Web 端 PremiumModal 场景化承接）
 *
 * 使用：<premium-modal visible="{{show}}" source="vocabulary_total" vars="{{ { totalErrors: 7 } }}" bind:close="onModalClose" />
 *
 * 场景文案逐字移植自 yuanlu/components/subscription/premium-modal-scenarios.ts（单一数据源），
 * 复习模块 9 个 source + episode_deep_dive；价格锚点按 lib/afdian-plans.ts 计算：
 * 周卡 ¥5/7天起、年卡 168/365 低至 ¥0.46/天。
 *
 * 占位符规则与 Web 一致：{var} 由 vars 属性传入，任一占位符缺值回退 *Fallback 文案，
 * 绝不展示空洞占位符；未知 source 走 DEFAULT_SCENARIO。
 *
 * 打开瞬间上报 PREMIUM_MODAL_OPEN 埋点（对齐 Web ui-store.openPremiumModal 验收红线），
 * 关闭复位、可重复上报；CTA 暂为占位（订阅页未建），保留 source 透传待接入。
 */
const { trackEvent } = require('../../utils/track');

// 价格锚点（与 Web 端 WEEKLY_ANCHOR / YEARLY_ANCHOR 同源：AFDIAN_PLANS ¥5/7天、¥168/365天）
const WEEKLY_ANCHOR = '¥5/7天起';
const YEARLY_ANCHOR = '低至 ¥0.46/天';

const SCENARIOS = {
  /* ---- 复习模块：生词 / 词典配额墙 ---- */
  vocabulary_total: {
    title: '生词本已经攒满了',
    description:
      '50 个生词位已经用完。删除旧词可以腾出空间——或升级 PRO，收藏不再设限。',
    benefits: ['生词无限收藏', '词典无限查询', '发音弱项追踪'],
    priceAnchor: WEEKLY_ANCHOR + ' · ' + YEARLY_ANCHOR,
    cta: '解锁无限收藏',
  },
  vocabulary_daily: {
    title: '今日免费收藏次数已用完',
    description:
      '免费用户每天可收藏 5 个生词，明天额度自动刷新。升级 PRO 立即解除每日上限。',
    benefits: ['收藏不限量、不限天', '词典无限查询'],
    priceAnchor: WEEKLY_ANCHOR,
    cta: '解锁无限收藏',
  },
  dictionary_quota: {
    title: '今日免费词典查询已用完',
    description:
      '免费用户每天可查 30 次。查词是精读的刚需——PRO 会员词典查询不限量。',
    benefits: ['词典无限查询', '生词无限收藏', '无限语音评测'],
    priceAnchor: WEEKLY_ANCHOR,
    cta: '解锁无限查询',
  },

  /* ---- 复习模块：句子本 / 刷句 / 跟读评测 ---- */
  sentence_quota: {
    title: '这句先帮你记下了',
    description:
      '你已攒下 30 句值得反复听的表达。PRO：无限收藏 · 标签导出 · 暂存句子全部入库。',
    benefits: ['句子无限收藏', '标签整理与组卷', '暂存书签自动入库'],
    priceAnchor: 'PRO ' + WEEKLY_ANCHOR,
    cta: '无限收藏 · ' + WEEKLY_ANCHOR,
  },
  review_eval_quota: {
    title: '今日免费跟读评测已用完',
    description:
      '你今天平均 {avgScore} 分，连续学习 {streak} 天。无限评测，把每个弱音磨到满分——PRO ¥0.46/天起。',
    descriptionFallback:
      '今天的免费跟读评测圆满用完，明日额度自动就位。无限评测，把每个弱音磨到满分——PRO ¥0.46/天起。',
    benefits: ['跟读评测不限次', 'AI 逐句评分', '历史成绩对比'],
    priceAnchor: 'PRO ' + YEARLY_ANCHOR,
    cta: '无限练到满意',
  },
  sentence_review_advanced: {
    title: '高级复习模式是 PRO 专属',
    description:
      '基础刷句永久免费。标签组卷、SRS 智能调度与连续翻卡成就，帮你把句库真正盘活。',
    benefits: ['标签组卷刷句', 'SRS 智能调度', 'CSV / Anki 导出'],
    priceAnchor: 'PRO ' + YEARLY_ANCHOR,
    cta: '解锁高级复习',
  },
  sentence_export: {
    title: '句子本导出是 PRO 专属',
    description:
      '把攒下的好句子带去任何地方——CSV 表格备份，或一键导入 Anki 开始间隔重复。',
    benefits: ['CSV 全字段导出', 'Anki 卡组一键导入', '标签整理与组卷'],
    priceAnchor: 'PRO ' + WEEKLY_ANCHOR,
    cta: '解锁导出',
  },

  /* ---- 复习模块：发音弱项本 ---- */
  pronunciation_locked: {
    title: '你已发现 {totalErrors} 个发音弱点',
    titleFallback: '你的发音弱点已经就位',
    description:
      '每天免费攻克 3 个。{worstPhoneme} 是当前最需攻克的音。PRO：全量弱项 + 无限闯关 + 音素专项。',
    descriptionFallback:
      '每天免费攻克 3 个发音弱点。PRO：全量弱项 + 无限闯关 + 音素专项。',
    benefits: ['全量弱项列表', '无限闯关练习', '音素专项报告'],
    priceAnchor: '解锁全量弱项 · ' + YEARLY_ANCHOR,
    cta: '解锁全量弱项',
  },
  diagnostic_report: {
    title: '你的发音数据已经就位',
    description:
      '免费层可见五维雷达与薄弱音素概览。PRO：薄弱音素 Top10 逐个击破方案 + 逐月进步曲线，把弱音一个一个磨掉。',
    benefits: ['薄弱音素 Top10 + 专项建议', '逐月进步趋势月报', '针对弱音的闯关练习'],
    priceAnchor: 'PRO ' + YEARLY_ANCHOR,
    cta: '解锁完整诊断',
  },

  /* ---- 剧集页（已有场景） ---- */
  episode_deep_dive: {
    title: 'AI 精讲这集播客',
    description:
      '难点词汇预扫、长难句逐层拆解、跟读句推荐、理解测验——AI 把每一集变成一节精听课。PRO 专属。',
    benefits: ['难点词汇预扫 + 长难句拆解', '本集跟读句推荐', '理解测验即时检验'],
    priceAnchor: 'PRO ' + YEARLY_ANCHOR,
    cta: '解锁 AI 精讲',
  },
};

/** 未知 source / 未传 source 时的通用兜底（对齐 Web DEFAULT_SCENARIO） */
const DEFAULT_SCENARIO = {
  title: '这里是会员专享内容',
  description:
    '为了支持网站长期高质量运转，此内容仅向赞助会员开放。如果您喜欢这里的内容，欢迎加入我们的会员社区，享受专属权益。',
  benefits: ['无限语音评测', '词典与生词不限量', '音频与文稿下载'],
  priceAnchor: WEEKLY_ANCHOR + ' · ' + YEARLY_ANCHOR,
  cta: '去看看赞助方案',
};

/**
 * 用变量填充 {var} 占位符；任一占位符缺值返回 null（调用方回退 *Fallback）。
 * 与 Web fillTemplate 逐行对齐。
 */
function fillTemplate(template, vars) {
  if (template.indexOf('{') === -1) return template;
  if (!vars) return null;
  let complete = true;
  const filled = template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    if (value === undefined) {
      complete = false;
      return '';
    }
    return String(value);
  });
  return complete ? filled : null;
}

/** 按 source 解析场景：未知走 DEFAULT，占位符缺值走 fallback */
function resolveScenario(source, vars) {
  if (!source || !SCENARIOS[source]) {
    return DEFAULT_SCENARIO;
  }
  const scenario = SCENARIOS[source];
  const title = fillTemplate(scenario.title, vars);
  const description = fillTemplate(scenario.description, vars);
  return Object.assign({}, scenario, {
    title: title !== null ? title : scenario.titleFallback || scenario.title,
    description:
      description !== null
        ? description
        : scenario.descriptionFallback || scenario.description,
  });
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    source: { type: String, value: 'episode_deep_dive' },
    /** 场景文案个性化变量（{var} 占位符取值，如 pronunciation_locked 的 totalErrors） */
    vars: { type: Object, value: null },
  },

  data: {
    scenario: DEFAULT_SCENARIO,
  },

  observers: {
    'visible, source, vars': function (visible, source, vars) {
      this.setData({ scenario: resolveScenario(source, vars) });
      // 打开瞬间上报转化埋点（对齐 Web ui-store.openPremiumModal）；
      // 关闭复位，允许下次打开再次上报
      if (visible) {
        if (!this._tracked) {
          this._tracked = true;
          trackEvent('PREMIUM_MODAL_OPEN', source || 'unknown');
        }
      } else {
        this._tracked = false;
      }
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
