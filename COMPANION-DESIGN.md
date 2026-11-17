# 小程序产品边界与共享后端约束

代码核对：2026-11-17。本文记录当前工程约束，不以旧版类目分析或历史签约记录保证审核结果。

## 当前页面与数据

四 Tab 为原声工坊（自由定制/今日挑战/跟读接力/日榜）、原声微流、复习、我的；入口见 app.json。已移除目录/频道/剧集详情页、后台整集播放内核与整集下载。保留微剧场精研、切片跟读/听写、复习三本、个人报表、订阅订单、通知与私人收藏。

- 主学习素材来自 yuanlu/app/api/clips/、scenes/、studio/；短音频网关支持 clipid/sceneid，默认 AAC/ADTS，协议含 url/duration/clipOffset。不是旧文档所称 MP3 永久格式。
- 今日挑战使用 POST /api/clips/daily-challenge；按用户和中国自然日固定清单，缓存与加练分开；后端契约见 [DAILY-CHALLENGE.md](../yuanlu/DAILY-CHALLENGE.md)。
- 主页连胜 GET /api/streak + POST /api/streak/ignite，来自 weapp_streak_log；手动点亮或有效的当日评测均可，不按分数门槛，与网站 user_daily_activity 收听达标分离。
- dashboard 其他指标来自 /api/user/stats/studio-dashboard；跟读、智能复习、接力和日榜均已有真实接口，游客/错误分支仍有演示回落，不能说“全部是 mock”或“全链路无 mock”。
- 账号、订阅、词句收藏共用后端。membershipStore 用 subscription/status 校正展示权限；支付复用 utils/wxpay.js 与后端 core/wxpay/，不重建另一套会员事实。

## 当前约束与明确例外

1. 不恢复整集目录页、后台音频模式、download-manager、audioManager、playerStore、mini-player、player-panel 或 ?id= 整集精研/评测入口；当前精研/评测页使用 sceneId。
2. 切片/微场景学习音频优先走 /api/clips/{id}/audio；**2026-11-15 起已有原声语境窗口例外**：utils/episode-context.js 可请求 /api/episode/subtitles，取得签名整集 URL 与真实字幕窗，再由 audio-clip 的显式 url/start/end 通道截窗播放。这会传输整集源，不能再宣称“所有请求均为短文件”或“字幕接口零调用”。该例外不恢复整集浏览、后台播放或下载。
3. 用户可见文案遵循现有工坊/语境/精析口径；扫描禁止 AI、大模型、智能、非品牌播客/podcast、电台、社区等模式，品牌“远路播客”有明确例外。精确范围以 scripts/test-compliance-redlines.js 为准，不扩大为“全仓零字符串”。
4. 不恢复公共评论区；现有跟读接力、日榜和点赞是已实现功能，应单独核对其内容、隐私与审核材料，不能以“零公共互动”概括。
5. 复用既有复习、词级时间轴、录音评测、付费链路；共享后端改动保持 Web/Android 兼容。新增 schema 与接口不得按旧全量复刻计划破坏现有消费端。

## 发布前

运行 [发布检查](RESHAPE-AUDIT.md)。每次按真实功能更新隐私声明、后台域名、内容来源和审核说明。原“全部原创”“只有短音频”“必过审”等模板没有本次证据，不可直接用于提审。
