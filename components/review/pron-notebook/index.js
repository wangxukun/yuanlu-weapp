// components/review/pron-notebook — 发音弱项本根视图
// 阶段四：T4.1 数据接入已落地（拉取/归一/试用埋点），画像卡（T4.2）、
// AI 诊断报告卡（T4.3）、弱项句列表（T4.4）、闯关与排行榜入口（T4.5）
// 的 UI 逐任务替换下方占位卡。
//
// T4.1（数据接入，REVIEW-TASK 阶段 4）：
// - 数据：active 首次激活拉 GET /api/speech/notebook 一次拿全
//   （{isPremium, weakThreshold, profile, phonemeStats, totalErrors,
//   isTrialMode, errors}，非会员 errors 为前 3 条试用切片）；
//   归一（音素升序/雷达五维/记录字段位）与试用埋点逻辑在 utils/pron-core
// - 刷新：refreshSeq（宿主 onShow 递增）且已加载 → 轻刷新——对齐 Android
//   PronunciationNotebookViewModel.onReenter：闯关达标句子已被后端移出
//   弱项集，从子页返回后列表自动更新
// - 失败口径：request.js 已统一 toast；从未加载成功过才亮错误态+重试，
//   已有数据时保持旧数据（loading 收起）
// - 埋点：isTrialMode 首次进入 TRIAL_REACHED（pron-core 会话内去重）
const pronCore = require('../../../utils/pron-core');
const { get } = require('../../../utils/request');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 当前 Tab 激活（首次激活懒加载，之后激活轻刷新） */
    active: { type: Boolean, value: false },
    /** 宿主页面 onShow 递增序号：通知组件刷新（从子页返回时同步数据） */
    refreshSeq: { type: Number, value: 0 },
    /** 宿主页 CEFR 弹窗打开中：透传三卡卸载 canvas（开发者工具原生层防透出） */
    popupOpen: { type: Boolean, value: false },
  },

  data: {
    loading: true,
    loaded: false,
    loadError: false,
    // 归一后的弱项本聚合（pronCore.parseNotebook；UI 任务逐卡消费）
    notebook: null,
    // 五维雷达点（toRadarData 派生，喂 speech-profile-card）
    radar: [],

    // 加载中/失败占位（T4.4 后已加载态为全量真实模块，不再需要 coming 占位）
    placeholder: {
      icon: '/assets/icons/mic-ink-active.svg',
      title: '发音弱项本',
      desc: 'AI 诊断发音弱项，五维画像 + 音素报告，逐句闯关攻克弱音。',
      phase: '加载中'
    },
    failed: {
      icon: '/assets/icons/warning.svg',
      title: '加载失败',
      desc: '网络异常，弱项本数据未能加载，请稍后重试。'
    },

    // 外观（根类；T4.2 起图标深色变体消费）
    themeClass: '',
    dark: false,
  },

  lifetimes: {
    attached() {
      this._syncTheme();
      if (this.data.active) {
        this.loadData();
      }
    },
  },

  observers: {
    active(v) {
      if (v) {
        if (this.data.loaded) this.refresh();
        else this.loadData();
      }
    },
    refreshSeq() {
      this._syncTheme();
      if (this.data.active && this.data.loaded) this.refresh();
    },
  },

  methods: {
    /** 外观根类（手动覆盖令牌；跟随系统返回空类走媒体查询）+ 生效深色 */
    _syncTheme() {
      this.setData({
        themeClass: theme.rootClass(),
        dark: theme.getEffective() === 'dark',
      });
    },

    loadData() {
      this.setData({ loading: true });
      this.refresh();
    },

    /** 拉取聚合接口：成功归一落库 + 试用埋点；失败保旧数据，首败亮错误态 */
    async refresh() {
      let res = null;
      try {
        res = await get('/api/speech/notebook');
      } catch (e) {
        res = null;
      }
      const notebook = res ? pronCore.parseNotebook(res) : null;
      if (notebook) {
        pronCore.maybeTrackTrialReach(notebook);
        this.setData({
          notebook,
          radar: pronCore.toRadarData(notebook.profile),
          loading: false,
          loaded: true,
          loadError: false,
        });
      } else if (!this.data.loaded) {
        this.setData({ loading: false, loadError: true });
      } else {
        this.setData({ loading: false });
      }
    },

    /** 错误态重试（占位卡期间的兜底入口；T4.4 接错误态 UI） */
    retry() {
      this.loadData();
    },

    /**
     * 画像卡「？」事件中继：CEFR 等级说明弹窗不能在组件深处 scroll-view 内
     * fixed 渲染（遮罩盖不全/卡片裁切叠字），转交宿主页面在根节点渲染
     */
    onCefrHint(e) {
      this.triggerEvent('cefrhint', { text: e.detail && e.detail.hintText });
    },
  },
});
