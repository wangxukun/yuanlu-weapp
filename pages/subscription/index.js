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
 * 支付链路（SUBSCRIBE-TASK T5.1+T5.2）：CTA 按钮 → utils/wxpay.js pay()（版本
 * 闸 → 静默 wx.login → bind（T3.3 即签即用）→ 下单 → requestVirtualPayment）；
 * 弱成功后置「支付处理中」态并轮询 subscription/status 收敛（2s×8 次对齐 Web
 * 切回补查口径 P2-2/F5）——收敛 = ensureFresh(true)+成功提示（会员胶囊到期日
 * 经 store 订阅自动刷新）；超时 = 「订单处理中，稍后在我的订阅查看」（后端
 * 兜底查单 T4.5 保证最终一致）。source 参数由 premium-modal CTA 透传（T2.1），
 * 供 T5.3 埋点漏斗归因，onLoad 先行留存。
 */

const theme = require('../../utils/theme');
const plansCore = require('../../utils/plans');
const authStore = require('../../store/authStore');
const membershipStore = require('../../store/membershipStore');
const wxpay = require('../../utils/wxpay');
const { trackEvent } = require('../../utils/track');
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
    payPending: false,     // 支付处理中（T5.2：弱成功后轮询收敛期横幅）
    // ---- 协议全文弹层（参照 auth 页用户协议弹层模式，2026-10-02 用户指令）----
    agreementDoc: null,
  },

  onLoad(options) {
    const source = (options && options.source) || '';
    this.setData({
      source,
      plans: plansCore.decoratePlans(),
    });
    // 漏斗首事件（T5.3）：source 归因缺省 unknown 与 PREMIUM_MODAL_OPEN 口径一致
    trackEvent('SUBSCRIBE_PAGE_VIEW', source || 'unknown');
  },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    this.syncAuthState();
    // 权威校正（TTL 内命中缓存）：回包后 syncAuthState 补齐会员胶囊到期日；
    // 购买在途（支付 sheet 回跳/回调丢失兜底窗内）强制刷新——Web 切回补查同款
    if (this._purchasing) membershipStore.ensureFresh(true);
    else membershipStore.ensureFresh();
  },

  onUnload() {
    this._destroyed = true; // 轮询在途时退出页面：跳过后续 setData/toast
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
   * 订阅按钮（SUBSCRIBE-TASK T3.3/T5.1）：游客态先去登录（Web「登录后订阅」
   * 同款分流，登录回流经 membershipStore 订阅自动刷新三态，source 留存本页
   * 不丢）；已登录 → 按钮携带的档位 key 走 wxpay.pay 全链路（版本闸 → 静默
   * wx.login → bind 即签即用 → 下单 → requestVirtualPayment）。
   */
  onSubscribe(e) {
    if (this.data.guest) {
      this.onGoLogin();
      return;
    }
    const key = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.key
      : '';
    this._startPurchase(key);
  },

  /**
   * 购买流程入口（防重入锁覆盖支付+收敛全程；份数取档位卡步进器当前 qty）。
   * T5.2：拉起即置「支付处理中」横幅 → pollSettlement 轮询收敛；判定基准 =
   * 购买前会员快照（新入会 isPremium 翻转 / 续费 expiryDate 变化）。
   * T5.4 修复：横幅自拉起即置位（回调丢失静默窗内也有反馈）；outcome
   * 'unknown'（success 回调丢失兜底，真机首单实测命中）与 'success' 同走
   * 轮询收敛——发货以服务端为准，前端不臆断成败。
   */
  async _startPurchase(planKey) {
    const plan = this.data.plans.find((p) => p.key === planKey);
    if (!plan) return;
    if (this._purchasing) return;
    this._purchasing = true;
    const qty = plan.qty; // 份数购买时点定格（轮询期步进器可再动，埋点/下单同源）
    try {
      const base = membershipStore.getState();
      const baseline = { isPremium: base.isPremium, expiryDate: base.expiryDate };
      this.setData({ payPending: true });
      const result = await wxpay.pay(plan.key, qty, {
        callbackTimeoutMs: this._payCallbackTimeoutMs, // 测试注入口，缺省 90s
      });
      if (result.outcome !== 'success' && result.outcome !== 'unknown') {
        // 取消/失败/前置失败已按层 toast，横幅随分支清理
        if (!this._destroyed) this.setData({ payPending: false });
        return;
      }
      const settled = await wxpay.pollSettlement({
        baseline,
        fetchState: async () => {
          await membershipStore.ensureFresh(true);
          return membershipStore.getState();
        },
        sleepFn: this._pollSleepFn, // 测试注入口，运行时缺省真实 2s 间隔
      });
      if (this._destroyed) return;
      this.setData({ payPending: false });
      if (settled === 'converged') {
        // 漏斗末事件（T5.3）：以后端发货收敛为准——success 回调不可信不作依据
        trackEvent('PAY_SUCCESS', planKey, {
          outTradeNo: result.outTradeNo,
          buyQuantity: qty,
        });
        // 轮询内已 ensureFresh(true)，会员胶囊经 store 订阅自动刷新到期日
        wx.showToast({ title: '支付成功，会员已激活', icon: 'none' });
      } else {
        wx.showToast({ title: '订单处理中，稍后在我的订阅查看', icon: 'none' });
      }
    } finally {
      this._purchasing = false;
    }
  },

  // ==================== 协议全文弹层（onOpen/onClose 与 auth 页同款） ====================
  onOpenAgreement() {
    this.setData({ agreementDoc: SUBSCRIPTION_AGREEMENT });
  },

  onCloseAgreement() {
    this.setData({ agreementDoc: null });
  },
});
