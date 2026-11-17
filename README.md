# 远路小程序 · 原声学习工具

代码核对：2026-11-17。原生 WXML/WXSS/JavaScript 工程，后端共用 [yuanlu](../yuanlu/README.md)。不要与 [yl-weapp](../yl-weapp/README.md) 中的原型/试验工程混同。

## 开发入口

微信开发者工具导入本目录；页面注册与四 Tab 以 [app.json](app.json) 为准：原声工坊、原声微流、复习、我的。npm ci 后按组件依赖需要构建 npm；[project.config.json](project.config.json) 为 miniprogram 工程配置。

[utils/config.js](utils/config.js) 当前 dev/trial/prod 均指向 https://www.wxkzd.com；本地联调须显式修改 dev.BASE_URL，并启动 yuanlu。localhost 只适用于开发者工具，真机使用可达的局域网地址。`urlCheck:false` 不证明正式包的域名配置正确。

```powershell
npm ci
npm test
node scripts/test-compliance-redlines.js
```

没有独立 test:compliance npm script，直接运行上面的 Node 脚本；npm test 已包含它。测试集合以 package.json 为准，勿复制固定套件数。真实录音、播放、支付另做真机验证。

## 快速索引

| 需求 | 代码 |
| --- | --- |
| 启动、主题、访问上报 | [app.js](app.js)、[utils/theme.js](utils/theme.js)、[utils/visit-reporter.js](utils/visit-reporter.js) |
| 网络 / 身份 / 会员 | [utils/request.js](utils/request.js)、[store/authStore.js](store/authStore.js)、[store/membershipStore.js](store/membershipStore.js) |
| 工坊、挑战、接力与日榜 | [pages/home](pages/home)：index.js 编排；daily-challenge、dashboard、shadowing、smart-review、relay-api、leaderboard-api 分工 |
| 微流 / 精研 / 训练 | [pages/discover](pages/discover)、[pages/intensive-listening](pages/intensive-listening)、[pages/practice-room](pages/practice-room) |
| 复习三本 / 闪卡 / 跟读 / 闯关 | [pages/review](pages/review)、[components/review](components/review) |
| 音频与词级时间轴 | [utils/clip-player.js](utils/clip-player.js)、[utils/clip-window.js](utils/clip-window.js)、[utils/audio-clip.js](utils/audio-clip.js)、[utils/audio-bus.js](utils/audio-bus.js) |
| 原声语境例外 | [utils/episode-context.js](utils/episode-context.js)；边界见 [产品约束](COMPANION-DESIGN.md) |
| 录音、评测与设置 | [utils/recorder.js](utils/recorder.js)、[utils/speech-core.js](utils/speech-core.js)、[components/voice/eval-card](components/voice/eval-card)、[components/speech-settings](components/speech-settings) |
| 生词、句子、标签 | utils/vocab-core.js、sentence-core.js、srs.js；components/vocabulary-modal/、sentence-tag-drawer/ |
| 个人资料 / 报表 / 收藏 / 足迹 | [pages/profile](pages/profile)、[pages/library](pages/library)、utils/profile-core.js、scene-favorites.js、study-footprint.js |
| 订阅 / 订单 / 支付 | [pages/subscription](pages/subscription)、[utils/wxpay.js](utils/wxpay.js)、[utils/plans.js](utils/plans.js) |

[协作与组件规则](WE-TASK.md) · [图标规范](Android-Meterial.md) · [发布检查](RESHAPE-AUDIT.md) · [接力待办](Relay_Module_Tasks.md)
