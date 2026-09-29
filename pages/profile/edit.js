// 阶段 0 占位页（PROFILE-TASK T0.5）：保证 app.json 注册后编译绿。
// 正式实现 = 阶段 6（编辑资料全屏页，届时改 navigationStyle: custom），整体替换本文件。
const theme = require('../../utils/theme');

Page({
  data: { themeClass: '' },

  onShow() {
    const __t = theme.getState();
    this.setData({ themeClass: __t.rootClass });
    theme.applyChrome();
  },
});
