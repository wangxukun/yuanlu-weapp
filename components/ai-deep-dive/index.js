/**
 * components/ai-deep-dive — AI 精讲本集（PRO 专属，复刻 Web 端 EpisodeDeepDive）
 *
 * 三态流转：
 *   1. 锁定态（未登录/普通用户）：点击不展开 → PremiumModal 转化承接
 *   2. 解锁未展开（PREMIUM/ADMIN）：点击卡片请求生成（首次 30-60s）并展开
 *   3. 已展开：按四类渲染（难点词汇预扫/长难句拆解/跟读句推荐/理解测验），可收起
 *
 * 权限口径与 Web 端一致：客户端按 role 乐观判锁（PREMIUM/ADMIN 解锁），
 * 服务端 /api/episode/deep-dive 为最终门禁——403 PREMIUM_REQUIRED（会员过期
 * 缝隙）同样弹转化窗兜底。
 *
 * 数据结构（DeepDiveContent，与后端 episode-deep-dive.service 产出对齐）：
 *   vocabulary: [{ word, phonetic?, meaning, reason? }]
 *   sentences:  [{ text, analysis }]
 *   shadowing:  [{ text, reason? }]
 *   quiz:       [{ question, options[], answer(索引), explanation? }]
 */

const { get } = require('../../utils/request');
const authStore = require('../../store/authStore');

// 四大分类胶囊（文案一字不差，与 Web 端 FEATURE_CHIPS 对齐）
const CHIPS = [
  { icon: '/assets/icons/book-open.png', text: '难点词汇预扫' },
  { icon: '/assets/icons/list.svg', text: '长难句拆解' },
  { icon: '/assets/icons/headphones.svg', text: '跟读句推荐' },
  { icon: '/assets/icons/sparkles-gray.svg', text: '理解测验' },
];

Component({
  properties: {
    episodeid: { type: String, value: '' },
  },

  data: {
    isLoggedIn: false,
    isPremium: false,

    content: null,
    isLoading: false,
    isOpen: false,

    quizAnswers: {},
    letters: ['A', 'B', 'C', 'D'],
    chips: CHIPS,

    showPremiumModal: false,
  },

  lifetimes: {
    attached() {
      this.unsubscribeAuth = authStore.subscribe(() => this.syncAuthState());
      this.syncAuthState();
    },
    detached() {
      if (this.unsubscribeAuth) this.unsubscribeAuth();
    },
  },

  methods: {
    syncAuthState() {
      const { isLoggedIn, userInfo } = authStore.getState();
      const role = (userInfo && userInfo.role) || '';
      this.setData({
        isLoggedIn: !!isLoggedIn,
        isPremium: role === 'PREMIUM' || role === 'ADMIN',
      });
      // profile 的 role 是 DB 展示缓存（P0-1 后会员事实在订阅表），纯移动端
      // 付费用户可能滞后为 USER——用 subscription/status 的派生 role 校正锁态，
      // 口径与 Web 端会话同步一致（deriveDisplayRole：ADMIN 直通/有效订阅→PREMIUM）
      if (isLoggedIn) this.refreshMembership();
    },

    async refreshMembership() {
      try {
        const res = await get('/api/user/subscription/status');
        if (res && res.role) {
          this.setData({ isPremium: res.role === 'PREMIUM' || res.role === 'ADMIN' });
        }
      } catch (e) {
        // 校正失败保持本地 role 兜底；服务端 403 门禁仍会兜住越权
      }
    },

    /** 入口卡点击：登录 → 会员态分流（与 Web 端 handleClick 一致） */
    onCardTap() {
      if (!this.data.isLoggedIn) {
        wx.showToast({ title: 'AI 精讲仅对会员开放，请先登录', icon: 'none' });
        return;
      }
      if (!this.data.isPremium) {
        this.setData({ showPremiumModal: true });
        return;
      }
      if (this.data.content) {
        this.toggleOpen();
        return;
      }
      this.load();
    },

    /** 已加载卡头部点击：展开/收起切换 */
    onHeaderTap() {
      if (this.data.isLoading) return;
      this.toggleOpen();
    },

    toggleOpen() {
      this.setData({ isOpen: !this.data.isOpen });
    },

    /** 收起并通知页面回滚到卡片锚点（对齐 Web 端 scrollIntoView 行为） */
    onCollapse() {
      this.setData({ isOpen: false });
      this.triggerEvent('collapse');
    },

    async load() {
      if (this.data.content || this.data.isLoading) return;
      this.setData({ isLoading: true });
      try {
        const res = await get(
          `/api/episode/deep-dive?episodeid=${this.data.episodeid}`,
        );
        if (res && res.success && res.data && res.data.content) {
          const content = res.data.content;
          // 防御：LLM 产出/缓存缺字段时兜底为空数组，避免渲染异常
          content.vocabulary = content.vocabulary || [];
          content.sentences = content.sentences || [];
          content.shadowing = content.shadowing || [];
          content.quiz = content.quiz || [];
          this.setData({ content, isLoading: false, isOpen: true, quizAnswers: {} });
          return;
        }
        this.setData({ isLoading: false });
        wx.showToast({ title: 'AI 精讲生成失败，请稍后重试', icon: 'none' });
      } catch (err) {
        this.setData({ isLoading: false });
        // 403：服务端判定非有效会员（role 过期缝隙等）→ 转化弹窗承接
        if (err && err.code === 'PREMIUM_REQUIRED') {
          this.setData({ showPremiumModal: true });
          return;
        }
        // 其余错误码（NO_SUBTITLE/LLM_UNAVAILABLE/网络异常）：
        // request.js 已统一 toast，这里静默复位不阻断剧集页
      }
    },

    /** 理解测验：每题作答一次，即时反馈对错 */
    onPickOption(e) {
      const { qi, oi } = e.currentTarget.dataset;
      if (this.data.quizAnswers[qi] !== undefined) return;
      this.setData({ [`quizAnswers.${qi}`]: oi });
    },

    onPremiumModalClose() {
      this.setData({ showPremiumModal: false });
    },
  },
});
