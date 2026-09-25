/**
 * utils/theme.js — 外观主题（跟随系统 / 浅色 / 深色）
 *
 * 口径对齐 Web next-themes（system|light|dark，localStorage 持久化）与
 * Android ThemeMode；深色令牌值对齐 Web/Android 深色板（ink-950 页底/
 * surface #1E1B16/primary-400 等，同语音评测页深色板）。
 *
 * 双轨生效机制（受微信平台能力限制的取舍）：
 *   ① 跟随系统：app.json darkmode:true + theme.json（导航/tabBar/页面底色
 *      由微信原生切换）+ app.wxss 的 prefers-color-scheme 媒体查询令牌块；
 *   ② 手动浅色/深色：页面根视图类 .theme-light/.theme-dark 重声明语义令牌
 *      （特异性高于 page 选择器，可覆盖系统态）+ wx.setTabBarStyle /
 *      wx.setNavigationBarColor 同步 chrome。已接线页面（四个 tab 页等，
 *      根视图挂 {{themeClass}} + onShow 刷新）整页生效；未接线页面在手动
 *      模式下仍随系统（接线方式见各 tab 页样例）。
 *
 * 页面接入：onShow 里 `this.setData({ themeClass: theme.rootClass() })`，
 * WXML 根视图 class 追加 `{{themeClass}}`；改动主题入口在「我的-外观设置」，
 * 同页即时 setData 生效，其余页面下次 onShow 刷新。
 */
const STORAGE_KEY = 'appThemeMode';
const MODES = ['system', 'light', 'dark'];
const MODE_LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };

// chrome 色（与 theme.json 双端一致；手动模式经 API 覆盖系统态）
const CHROME = {
  light: {
    tabColor: '#a79e8a', tabSelected: '#1f7a5c', tabBg: '#ffffff', tabBorder: 'black',
    navFront: '#000000', navBg: '#faf8f3',
  },
  dark: {
    tabColor: '#736c5f', tabSelected: '#4da989', tabBg: '#1e1b16', tabBorder: 'white',
    navFront: '#ffffff', navBg: '#151310',
  },
};

const listeners = new Set();
let cachedMode = null;
let cachedSystemTheme = null;

function notify() {
  const snapshot = getState();
  for (const fn of Array.from(listeners)) {
    try {
      fn(snapshot);
    } catch (e) {
      /* 单个监听器异常不影响其他 */
    }
  }
}

function normalize(mode) {
  return MODES.indexOf(mode) >= 0 ? mode : 'system';
}

/** 用户选择（storage 持久化，缺省跟随系统） */
function getMode() {
  if (cachedMode === null) {
    try {
      cachedMode = normalize(wx.getStorageSync(STORAGE_KEY) || 'system');
    } catch (e) {
      cachedMode = 'system';
    }
  }
  return cachedMode;
}

/** 系统主题（darkmode:true 时可读；读不到按浅色） */
function getSystemTheme() {
  if (cachedSystemTheme) return cachedSystemTheme;
  try {
    const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    cachedSystemTheme = info && info.theme === 'dark' ? 'dark' : 'light';
  } catch (e) {
    cachedSystemTheme = 'light';
  }
  return cachedSystemTheme;
}

/** 生效主题：手动选择优先，跟随系统取系统主题 */
function getEffective() {
  const mode = getMode();
  return mode === 'system' ? getSystemTheme() : mode;
}

/** 页面根视图类：手动模式返回覆盖类，跟随系统返回空（走媒体查询） */
function rootClass() {
  const mode = getMode();
  if (mode === 'dark') return 'theme-dark';
  if (mode === 'light') return 'theme-light';
  return '';
}

/** 同步 chrome（tabBar 全局 + 当前页导航栏；自定义导航页静默失败） */
function applyChrome() {
  const c = CHROME[getEffective()] || CHROME.light;
  try {
    wx.setTabBarStyle({
      color: c.tabColor,
      selectedColor: c.tabSelected,
      backgroundColor: c.tabBg,
      borderStyle: c.tabBorder,
      fail: () => { /* 非 tab 场景忽略 */ },
    });
  } catch (e) { /* 忽略 */ }
  try {
    wx.setNavigationBarColor({
      frontColor: c.navFront,
      backgroundColor: c.navBg,
      fail: () => { /* 自定义导航页（如语音评测）忽略 */ },
    });
  } catch (e) { /* 忽略 */ }
}

/**
 * 设置外观模式：持久化 + 同步 chrome + 通知订阅者（页面据此刷新根类）。
 * 返回生效后的快照。
 */
function setMode(mode) {
  const next = normalize(mode);
  cachedMode = next;
  try {
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (e) { /* 存储失败保持内存态 */ }
  applyChrome();
  notify();
  return getState();
}

/** App onLaunch：监听系统主题翻转（仅跟随系统模式需要联动） */
function init() {
  if (typeof wx.onThemeChange === 'function') {
    wx.onThemeChange((res) => {
      cachedSystemTheme = res && res.theme === 'dark' ? 'dark' : 'light';
      if (getMode() === 'system') {
        applyChrome();
        notify();
      }
    });
  }
}

function getState() {
  return {
    mode: getMode(),
    modeLabel: MODE_LABELS[getMode()],
    effective: getEffective(),
    rootClass: rootClass(),
  };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 单测隔离：复位缓存与监听器 */
function _reset() {
  cachedMode = null;
  cachedSystemTheme = null;
  listeners.clear();
}

module.exports = {
  MODES,
  MODE_LABELS,
  getMode,
  setMode,
  getSystemTheme,
  getEffective,
  rootClass,
  applyChrome,
  init,
  getState,
  subscribe,
  _reset,
  STORAGE_KEY,
};
