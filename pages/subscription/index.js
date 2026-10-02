/**
 * pages/subscription/index.js — 「我的订阅」订阅页（页面标题由原生导航栏提供，页内无大标题——2026-10-02 用户走查指令）
 *
 * 复刻 Web 端 app/(main)/auth/subscribe/subscribe-client.tsx 的档位卡结构：
 *   - 四档位卡（周/月/季/年，utils/plans.js 单源，文案逐字）；
 *   - 每卡：天数徽章（月卡 accent 特例）+ 价格与日均价锚点（年卡含
 *     「较周卡省 N%」，P2-1/F7 推荐档高亮与 MOST POPULAR 徽章）+ 档位名 +
 *     描述 + 七项权益列表；
 *   - 多份购买数量步进器（虚拟支付 buyQuantity 语义：份数 = 天数倍增，
 *     1-99，SUBSCRIBE-TASK T1.1 改动点，Web 无此元素系 weapp 特有）。
 *
 * 三态（T1.3，Web :309-318/:426-451 复刻）：
 *   - 游客态横幅：Web 游客提示区块结构对齐，文案按虚拟支付口径改写
 *     （「登录后购买，时长自动入账」——openid 自动绑定，无爱发电留言
 *     标识环节）；按钮跳 auth 页（登录回流保 source 留 T3.3）；
 *   - 会员态胶囊：ADMIN「永久高级权限」/ 有到期日「有效期至：N」/
 *     无到期日「长期有效」——expiryDate 来自 membershipStore 权威校正
 *     （subscription/status 的 formatChineseDate 值），仅 checked 后展示
 *     （本地 role 是展示缓存，乐观态展示到期日会误报）；
 *   - 未开通态：无横幅，默认档位浏览。
 *   卡按钮文案随登录态分流（Web 同款：「登录后订阅」/「一键订阅」）。
 *
 * 阶段边界（SUBSCRIBE-TASK）：CTA 按钮为占位 toast，支付链路（下单→拉起→
 * 收敛）阶段 5 接入；source 参数由 premium-modal CTA 透传（T2.1），供 T5.3
 * 埋点漏斗归因，onLoad 先行留存。
 */

const theme = require('../../utils/theme');
const plansCore = require('../../utils/plans');
const authStore = require('../../store/authStore');
const membershipStore = require('../../store/membershipStore');
const { SUBSCRIPTION_AGREEMENT } = require('./agreement');

Page({
  data: {
    themeClass: '',
    dark: false,
    // CTA 来源场景（premium-modal source 透传，T5.3 埋点用）
    source: '',
    plans: [],
    // ---- 三态（T1.3）----
    guest: false,          // 游客态（未登录）
    memberBadgeText: '',   // 会员态胶囊文案（空串 = 不展示：未开通或未校正）
    // ---- 协议全文弹层（参照 auth 页用户协议弹层模式，2026-10-02 用户指令）----
    agreementDoc: null,
  },

  onLoad(options) {
    this.setData({
      source: (options && options.source) || '',
      plans: plansCore.decoratePlans(),
    });
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    this.syncAuthState();
    // 权威校正（TTL 内命中缓存）：回包后 syncAuthState 补齐会员胶囊到期日
    membershipStore.ensureFresh();
  },

  onUnload() {
    if (this._unsubMembership) {
      this._unsubMembership();
      this._unsubMembership = null;
    }
  },

  /**
   * 三态同步：authStore 定游客/登录；membershipStore 定会员胶囊。
   * 登录回流（auth 页返回）经 onShow 与 membershipStore 订阅双路触发
   * （authStore 变化 → deriveLocal → setState → 此回调）。
   */
  syncAuthState() {
    if (!this._unsubMembership) {
      this._unsubMembership = membershipStore.subscribe(() => this.syncAuthState());
    }
    const auth = authStore.getState();
    const membership = membershipStore.getState();

    let memberBadgeText = '';
    if (auth.isLoggedIn && membership.isPremium && membership.checked) {
      if (membership.role === 'ADMIN') {
        memberBadgeText = '您是系统管理员（永久高级权限）';
      } else if (membership.expiryDate) {
        memberBadgeText = '您的高级会员有效期至：' + membership.expiryDate;
      } else {
        memberBadgeText = '您的高级会员已激活（长期有效）';
      }
    }

    this.setData({ guest: !auth.isLoggedIn, memberBadgeText });
  },

  /** 数量步进（1-99，越界钳制静默；canDec/canInc 同步驱动按钮置灰态） */
  onQtyChange(e) {
    const key = e.currentTarget.dataset.key;
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const idx = this.data.plans.findIndex((p) => p.key === key);
    if (idx < 0 || delta === 0) return;
    const plan = this.data.plans[idx];
    const qty = Math.min(
      plansCore.QTY_MAX,
      Math.max(plansCore.QTY_MIN, plan.qty + delta),
    );
    if (qty === plan.qty) return;
    this.setData({
      [`plans[${idx}].qty`]: qty,
      [`plans[${idx}].canDec`]: qty > plansCore.QTY_MIN,
      [`plans[${idx}].canInc`]: qty < plansCore.QTY_MAX,
      [`plans[${idx}].totalPrice`]: plan.price * qty,
      [`plans[${idx}].totalDays`]: plan.days * qty,
    });
  },

  /** 游客横幅「立即登录/注册账号」（T3.3 登录回流保 source 再接） */
  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },

  /**
   * 订阅按钮：游客态先去登录（Web「登录后订阅」同款分流）；已登录为
   * 占位 toast——支付链路阶段 5 接入（utils/wxpay.js，T5.1）。
   */
  onSubscribe() {
    if (this.data.guest) {
      this.onGoLogin();
      return;
    }
    wx.showToast({ title: '支付功能即将上线', icon: 'none' });
  },

  // ==================== 协议全文弹层（onOpen/onClose 与 auth 页同款） ====================
  onOpenAgreement() {
    this.setData({ agreementDoc: SUBSCRIPTION_AGREEMENT });
  },

  onCloseAgreement() {
    this.setData({ agreementDoc: null });
  },
});
