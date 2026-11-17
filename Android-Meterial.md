# 原生小程序 Material 图标规范

2026-11-17 对照 assets/icons/、app.json 与烘焙脚本整理。保留历史文件名供既有引用使用，不再维护过期数量或逐批替换流水账。

## 长期规则

原生小程序新增操作图标使用 Android Material 字形（与 yuanlu-android 的 Icons.Filled.* 对应），不新增 lucide/手画近似图标。装饰曲线如 journey-curve.svg 不属于操作图标，可以保留。已有文件名与色后缀以 assets/icons/ 为准，先检索复用再加变体。

- 官方来源为 gstatic materialicons 的 24px SVG；版本需逐个查找，不能假定所有名字都存在 v1。
- 保留源 viewBox、字形 path 与镂空；以显式 fill 固化颜色。过滤非字形的全幅矩形/透明边界 path（如 M0 0h24v24H0z），避免实心方块。
- 名称下划线转连字符，复用既有颜色后缀；深色变体用 -dark。不要把多色/outline/filled 差异无条件合并成同一字形。
- SVG 用于普通 image；tabBar 使用 PNG，现有资源 81×81、默认 #a79e8a、激活 #1f7a5c，按 app.json 当前引用核对。
- scripts/tmp-material-bake.py 提供 fetch_material/bake_svg/raster_png 等辅助；PNG 采用 8× 超采样后 LANCZOS 缩小、保留透明与镂空。它是历史批量迁移脚本，含硬编码路径与大批映射，勿直接整批重跑；提取单图函数前先核对路径与输出。
- 品牌主色、强调色与深色对应从 app.wxss/theme.json 取，不把旧台账的颜色当成全部组件的新标准。

## 快速定位

| 用途 | 在哪里核对 |
| --- | --- |
| 四个底栏图标与选中态 | app.json 的 tabBar.list |
| 普通 SVG / 深色变体 | assets/icons/ 与页面/组件 WXML、JS |
| 切换主题 | utils/theme.js、app.wxss、theme.json |
| 我的页通知/收藏 | notifications-ink.svg（通知空态）、notifications-primary(-dark).svg、bookmark-accent-deep.svg |
| 新图标引用 | 修改 usingComponents/WXML/JS 的实际消费点；删除资源前全仓查引用 |

验证浅/深色可见性、填充/镂空、原生尺寸和 tabBar 实际呈现；运行相关组件脚本。不要用历史“lucide 已清零/全部测试通过”替代当次检查。

本仓库回归入口为 npm test；图标台账中的上述通知/收藏文件名仍由 scripts/test-notifications.js 校验。
