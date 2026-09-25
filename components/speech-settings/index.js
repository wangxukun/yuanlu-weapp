/**
 * components/speech-settings — 语音评测设置全屏弹窗
 * 复刻 Android SpeechSettingsSheet.kt（ModalBottomSheet 移动端下拉面板）：
 * 界面与显示 / 评测与弱项 / 声音与跟读 三组；所有变更经 change 事件即时写回
 * 页面状态并持久化（写入即生效，影响本集句子过滤与过关判定）。
 * 深浅色切换经 theme 事件写全局主题偏好（本页作用域即时切换）。
 */
const core = require('../../utils/speech-core');

/** 步进器钳制表（与 Android Stepper coerce 口径一致） */
const STEPS = {
  fontSizeLevel: { min: 0, max: 2, d: 1 },
  passThreshold: { min: 60, max: 95, d: 5 },
  weakThreshold: { min: 60, max: 95, d: 5 },
  minWords: { min: 0, max: 50, d: 5 },
  maxWords: { min: 0, max: 50, d: 5 },
};

Component({
  options: {
    styleIsolation: 'apply-shared', // 复用 app.wxss 的 row/center/flex-1/tap-dim 工具类
    multipleSlots: false,
  },

  properties: {
    show: { type: Boolean, value: false },
    settings: { type: Object, value: core.DEFAULT_SETTINGS },
    themeMode: { type: String, value: 'system' }, // system | light | dark（全局偏好）
    dark: { type: Boolean, value: false },        // 当前实际生效的深浅色
  },

  data: {
    rendered: false,
    anim: false,
    fontLabel: '中',
    minLabel: '不限',
    maxLabel: '不限',
    effThreshold: 80,
  },

  observers: {
    show(v) {
      if (v) {
        this.setData({ rendered: true });
        setTimeout(() => this.setData({ anim: true }), 20);
      } else if (this.data.rendered) {
        this.setData({ rendered: false, anim: false });
      }
    },
    settings(s) {
      this._syncLabels(s);
    },
  },

  lifetimes: {
    attached() {
      // observers 对 properties 初始值的触发时机不作保证，挂载时兜底同步一次
      this._syncLabels(this.data.settings);
    },
  },

  methods: {
    /** 设置 → 步进器/生效线显示文案 */
    _syncLabels(s) {
      if (!s) return;
      this.setData({
        fontLabel: ['小', '中', '大'][s.fontSizeLevel] || '中',
        minLabel: s.minWords === 0 ? '不限' : String(s.minWords),
        maxLabel: s.maxWords >= 50 ? '不限' : String(s.maxWords),
        effThreshold: core.effectivePassThreshold(s),
      });
    },
    /** 退出动画后再卸载（scrim 渐隐 + 面板下滑） */
    requestClose() {
      this.setData({ anim: false });
      setTimeout(() => {
        this.setData({ rendered: false });
        this.triggerEvent('close');
      }, 220);
    },

    /** 分段选择（文本模式 / 严格度 / 深浅色） */
    onSegmentTap(e) {
      const ds = e.currentTarget.dataset;
      this.triggerEvent(ds.key === '__theme' ? 'theme' : 'change', {
        key: ds.key === '__theme' ? 'mode' : ds.key,
        value: ds.value,
      });
    },

    /** 步进器 −/+（钳制后发终值） */
    onStep(e) {
      const ds = e.currentTarget.dataset;
      const key = ds.key;
      const step = STEPS[key];
      if (!step) return;
      const cur = Number(this.data.settings[key]) || 0;
      const delta = Number(ds.delta) * step.d;
      const value = Math.max(step.min, Math.min(step.max, cur + delta));
      this.triggerEvent('change', { key, value });
    },

    /** Switch 开关（点击整个轨道切换） */
    onSwitchTap(e) {
      const key = e.currentTarget.dataset.key;
      this.triggerEvent('change', { key, value: !this.data.settings[key] });
    },

    noop() {},
  },
});
