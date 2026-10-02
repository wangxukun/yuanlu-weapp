/**
 * utils/plans.js — 订阅档位单一数据源
 *
 * 复刻 Web 端 app/(main)/auth/subscribe/subscribe-client.tsx 的 AFDIAN_PLANS
 * （四档 key/名称/价格/天数/描述/权益文案逐字）与 lib/afdian-plans.ts 的
 * 价格天数白名单；定价锚点计算与 Web 逐字同口径：
 *   - 对比基准 = 周卡日单价 weeklyDaily = WEEKLY.price / WEEKLY.days；
 *   - 日均价展示 dailyPrice = (price / days).toFixed(2)（四档全展示）；
 *   - 年卡锚点 savingsVsWeekly = Math.floor((1 - price / days / weeklyDaily) * 100)，
 *     仅推荐档（YEARLY，P2-1/F7 利润最优档）且 savings > 0 时展示
 *     「较周卡省 N%」——月卡 16%、季卡 25% 按 Web 同口径算出但不展示。
 *
 * 徽章：WEEKLY/QUARTERLY/YEARLY 为中性灰 pill（N 天）；MONTHLY 为 accent
 * 加粗 pill（getLevelBadge 特判，badgeHot 标记）。
 *
 * 虚拟支付侧：priceFen = price * 100 为道具单价（分），buyQuantity 份数语义
 * = 天数倍增（SUBSCRIBE-TASK 1.3 同构口径）；qty 上限 99 对齐后端下单校验
 * （T4.3 buyQuantity 1-99）。
 *
 * decoratePlans() 每次返回全新数组（含派生字段与 qty 状态），页面实例各自
 * 持有互不污染（模块级对象会被多页面实例共享，禁止直接下发 PLANS）。
 */

const PLANS = [
  {
    key: 'WEEKLY',
    name: '周度会员',
    price: 5,
    days: 7,
    desc: '7天高级会员权益，低门槛体验所有专业功能',
    features: [
      '7天会员特权',
      '无限次语音评测',
      '完整句子跟读练习',
      '音频、文稿 PDF 下载',
      '生词无限收藏',
      '词典无限查询',
      '发音弱项本与诊断',
    ],
  },
  {
    key: 'MONTHLY',
    name: '月度会员',
    price: 18,
    days: 30,
    desc: '30天高级会员权益，适合中短期高强度需求',
    features: [
      '30天会员特权',
      '无限次语音评测',
      '完整句子跟读练习',
      '音频、文稿 PDF 下载',
      '生词无限收藏',
      '词典无限查询',
      '发音弱项本与诊断',
    ],
  },
  {
    key: 'QUARTERLY',
    name: '季度会员',
    price: 48,
    days: 90,
    desc: '90天高级会员权益，季付更划算，效率倍增',
    features: [
      '90天会员特权',
      '无限次语音评测',
      '完整句子跟读练习',
      '音频、文稿 PDF 下载',
      '生词无限收藏',
      '词典无限查询',
      '发音弱项本与诊断',
    ],
  },
  {
    key: 'YEARLY',
    name: '年度会员',
    price: 168,
    days: 365,
    desc: '365天终极会员权益，超值优待，一年无忧',
    features: [
      '365天至尊全权',
      '无限次语音评测',
      '完整句子跟读练习',
      '音频、文稿 PDF 下载',
      '生词无限收藏',
      '词典无限查询',
      '发音弱项本与诊断',
    ],
  },
];

/** 推荐徽章与高亮档（P2-1/F7：低价锚不放中位档，从月卡移至年卡） */
const POPULAR_KEY = 'YEARLY';

/** 多份购买数量边界（对齐虚拟支付 buyQuantity 1-99） */
const QTY_MIN = 1;
const QTY_MAX = 99;

/** 周卡日单价（定价锚点对比基准，与 Web subscribe-client.tsx 同式） */
function weeklyDaily() {
  const weekly = PLANS.find((p) => p.key === 'WEEKLY');
  return weekly.price / weekly.days;
}

/**
 * 装饰四档为渲染模型：预计算全部派生字段（WXML 零方法调用红线，
 * 展示态一律在此算好）。qty 初始 1，含 canDec/canInc 步进边界态。
 */
function decoratePlans() {
  const base = weeklyDaily();
  return PLANS.map((plan) => {
    const dailyPrice = (plan.price / plan.days).toFixed(2);
    const savingsVsWeekly = Math.floor(
      (1 - plan.price / plan.days / base) * 100,
    );
    const popular = plan.key === POPULAR_KEY;
    return {
      ...plan,
      priceFen: plan.price * 100,
      badgeText: plan.days + ' 天',
      badgeHot: plan.key === 'MONTHLY',
      popular,
      dailyPrice,
      savingsVsWeekly,
      showSaving: popular && savingsVsWeekly > 0,
      qty: 1,
      canDec: false,
      canInc: true,
      totalPrice: plan.price,
      totalDays: plan.days,
    };
  });
}

module.exports = {
  PLANS,
  POPULAR_KEY,
  QTY_MIN,
  QTY_MAX,
  weeklyDaily,
  decoratePlans,
};
