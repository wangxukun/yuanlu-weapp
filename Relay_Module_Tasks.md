# 跟读接力 · 当前实现与待办

代码核对：2026-11-17。前端 [pages/home/index.js](pages/home/index.js) 的 _relayRecordStart/_relayRecordFinish、_playRelaySeg/_advanceBaton；请求适配 [relay-api.js](pages/home/relay-api.js)。后端 [relay.service.ts](../yuanlu/core/relay/relay.service.ts)、[app/api/relay](../yuanlu/app/api/relay)。

## 已实现的约定

- 第 1 棒真人评测后立即建房；Elena 用真实 corpus 切片补第 2 棒；第 3 棒留给真人，RECRUITING → COMPLETED。不同于参考原型的“立即自动补满”。
- 先查评测余量/麦克风权限，最长录音 30 秒，停止后真实评测，再携 recognitionId 与录音建房/接棒；不使用随机分数。
- 合集以自然播完事件推进，时长+3 秒定时器兜底；_playRelaySeg 的 compilation 选项保留连播状态，旧“只播第 1 棒”修复已在代码中。
- 房间状态动画、待接棒角标、邀请头像状态与演示标识已存在，不再重复列为开发任务。
- 伴随切片候选门禁/难度/跨剧集与话题优先级查 pickCompanionClips；不把某次“12 万条”统计写作固定事实。

## 待完成需求

- [x] **T12 试听后提交**（✅ 2026-11-17 已实施）：评测后存草稿（分数+试听本机录音/重录走完整配额链/满意才 createRoom/可放弃）；抽屉脚草稿面板三键+放弃；提交前不建房不计接力；join 模式保持即时。
- [x] **T13 发起人撤销**（✅ 2026-11-17 已实施）：POST /api/relay/cancel（发起人+RECRUITING+第3棒无真人三校验，硬删房+级联棒次；OSS 录音留孤儿清理；评测/连胜保留=开口是学习事实）；RoomView.isMine 透传；房头「撤销接力」入口+Modal 二次确认；后端 7 项权限矩阵实测通过。
- [x] **T5 动态合集文案**（✅ 2026-11-17 已实施）：源码「播客合集」→「节目合集」；存量 2/2 compilation JSON 幂等清洗完毕（yuanlu 后端提交）。

## 可选设计（未承诺实施）

- T7 超时系统补第 3 棒：会改变真人接棒设计，先明确产品规则。
- T8 起录前 3-2-1 倒计时：只增加预备态，不替换真实录音/评测。
- T6 导演点评 LLM 化：当前模板点评；若接模型，需保留失败回退与动态文案检查。

## 验证重点

三棒长短句顺序播完、扫光同步、快速切换房间、离页/换号取消录音、失败后不误建房、重复提交与第三棒抢占、配额和音频域名；真机录音/评测/回放须单独验收。
