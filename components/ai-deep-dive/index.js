/**
 * components/ai-deep-dive — AI 精讲本集（PRO 专属，复刻 Web 端 EpisodeDeepDive）
 *
 * 扁平化无卡片容器（与详情页"节目介绍"模块同风格）：
 *   行1 = 标题 + PRO 徽标（非会员）+ 锁/展开箭头
 *   行2 = 紫底星星图标（整体垂直居中）+ 四分类标签 2x2 网格
 *
 * 三态流转：
 *   1. 锁定态（未登录/普通用户）：点击不展开 → PremiumModal 转化承接
 *   2. 解锁未展开（PREMIUM/ADMIN）：点击头部先 probe 探测缓存——命中安静
 *      加载，未命中才提示"首次生成约需 30-60 秒"并请求生成，完成后展开
 *   3. 已展开：四分类标签升级为过滤器（activeFilter），点击仅渲染对应分类；
 *      再次点击同一标签回到"全部"（activeFilter === 'all'）
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

// 四大分类标签（文案一字不差，与 Web 端 FEATURE_CHIPS 对齐）。
// key 与 DeepDiveContent 字段一一对应，展开后兼作 activeFilter 过滤键。
const CHIPS = [
  { key: 'vocabulary', icon: '/assets/icons/book-open.png', text: '难点词汇预扫' },
  { key: 'sentences', icon: '/assets/icons/list.svg', text: '长难句拆解' },
  { key: 'shadowing', icon: '/assets/icons/headphones.svg', text: '跟读句推荐' },
  { key: 'quiz', icon: '/assets/icons/sparkles-gray.svg', text: '理解测验' },
];

// 2x2 标签网格按行分组：真机 WebView 对 calc(50%)/flex gap 支持不稳
// （实测退化为单列竖排），改为"每行一个 row 容器 + 子项 flex:1"的
// 项目既定双列模式，宽度平分由布局引擎保证。
const CHIP_ROWS = [
  { id: 'row-0', list: CHIPS.slice(0, 2) },
  { id: 'row-1', list: CHIPS.slice(2, 4) },
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

    // 真生成态标记：仅当 probe 探测到无缓存（将触发 LLM 首次生成）时为
    // true，驱动"首次生成约需 30-60 秒"文案；缓存命中的安静加载不置位，
    // 标签网格保持可见，避免该提示一闪而过
    isGenerating: false,

    // 标签过滤：'all'（默认，四类全显）或 chips 里的 key
    activeFilter: 'all',
    // 当前过滤分类无内容时的空态提示（仅非 'all' 时可能为 true）
    filterEmpty: false,

    quizAnswers: {},
    letters: ['A', 'B', 'C', 'D'],
    chipRows: CHIP_ROWS,

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

    /** 入口点击（行1/标签透传）：登录 → 会员态分流（与 Web 端 handleClick 一致） */
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

    /** 行1 头部点击：未加载走入口分流，已加载做展开/收起切换 */
    onHeadTap() {
      if (!this.data.content) {
        this.onCardTap();
        return;
      }
      this.onHeaderTap();
    },

    /** 已加载头部点击：展开/收起切换 */
    onHeaderTap() {
      if (this.data.isLoading) return;
      this.toggleOpen();
    },

    toggleOpen() {
      this.setData({ isOpen: !this.data.isOpen });
    },

    /**
     * 四分类标签点击（catchtap，不冒泡到头部）：
     *   锁定/未加载 → 走入口分流（登录校验/转化窗/发起生成）
     *   已加载未展开 → 展开并定位到该分类
     *   已展开 → 切换过滤器；点中当前分类则回到"全部"
     */
    onChipTap(e) {
      const key = e.currentTarget.dataset.key;
      if (!this.data.content) {
        this.onCardTap();
        return;
      }
      const next = this.data.activeFilter === key ? 'all' : key;
      this.applyFilter(next, !this.data.isOpen);
    },

    /** 应用过滤器并维护空态标记；needOpen 时顺带展开 */
    applyFilter(filter, needOpen) {
      const c = this.data.content;
      const patch = {
        activeFilter: filter,
        filterEmpty: filter !== 'all' && (!c[filter] || c[filter].length === 0),
      };
      if (needOpen) patch.isOpen = true;
      this.setData(patch);
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
        // 先静默探测缓存（后端 probe=1 只查库不触发 LLM）：未命中才展示
        // "首次生成约需 30-60 秒"文案；命中（绝大多数请求路径）安静加载，
        // 避免该提示一闪而过
        let cached = false;
        try {
          const probe = await get(
            `/api/episode/deep-dive?episodeid=${this.data.episodeid}&probe=1`,
            null,
            { showError: false },
          );
          cached = !!(probe && probe.success && probe.data && probe.data.cached);
        } catch (probeErr) {
          // 会员过期缝隙：探测即被 403，直接转化窗承接，不再发主请求
          if (probeErr && probeErr.code === 'PREMIUM_REQUIRED') {
            this.setData({ isLoading: false, showPremiumModal: true });
            return;
          }
          // 探测网络异常不阻断：保守按未缓存口径继续，由主请求错误口径兜底
        }
        this.setData({ isGenerating: !cached });
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
          this.setData({
            content,
            isLoading: false,
            isGenerating: false,
            isOpen: true,
            quizAnswers: {},
            activeFilter: 'all',
            filterEmpty: false,
          });
          return;
        }
        this.setData({ isLoading: false, isGenerating: false });
        wx.showToast({ title: 'AI 精讲生成失败，请稍后重试', icon: 'none' });
      } catch (err) {
        this.setData({ isLoading: false, isGenerating: false });
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
