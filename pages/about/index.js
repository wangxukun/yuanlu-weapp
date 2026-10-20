/**
 * pages/about — 关于远路播客 + 公众号关注承接（04 清单 T4）
 * 纯静态页（无接口）：品牌介绍 + <official-account /> 关注组件 + 官网/支持入口。
 * 组件渲染规则由微信平台控制：公众号与小程序同主体且已关联、用户未关注才显示；
 * 不满足条件时不渲染、不占位，页面文案与布局不受影响（开发者工具同样不渲染，真机验收）。
 */
const theme = require('../../utils/theme');

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
  },

  onShow() {
    // 外观：根类（手动模式覆盖）+ 生效深色（图标变体）+ chrome 重申
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass, dark: __t.effective === 'dark' });
    theme.applyChrome();
    // official-account 排查：进入场景值（组件仅特定场景渲染，vConsole 查看）
    const enter = wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : {};
    console.log('[about] enter scene:', enter.scene, 'path:', enter.path);
  },

  // official-account 诊断回调（vConsole 查看；验收完成后可移除）
  onOfficialLoad(e) {
    console.log('[official-account] load', e && e.detail);
  },
  onOfficialError(e) {
    console.error('[official-account] error', e && e.detail);
  },

  onCopySite() {
    wx.setClipboardData({ data: 'https://wxkzd.com' }); // 系统自带"已复制"toast
  },
});
