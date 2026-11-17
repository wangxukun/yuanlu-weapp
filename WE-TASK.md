# 小程序协作与组件规则

代码索引和运行命令见 [README.md](README.md)。本文件替代已完成的逐阶段复刻清单；当前页面与功能以 app.json 和源码为准。

## 长期约束

- 中文沟通；新增代码标识符与代码注释用英文。修改前检索现有工具/组件，先复用再扩展。
- 原生小程序使用 Android Material 字形，详见 [Android-Meterial.md](Android-Meterial.md)；旧“逐字复制 Web lucide”要求已被 Material 政策取代。
- 与 Web/Android 共用账号、订阅和业务数据；后端适配保持 Web 响应兼容，schema 优先新增可空/默认值字段，不为某端重塑破坏共享表和接口。
- 生产产品边界见 [COMPANION-DESIGN.md](COMPANION-DESIGN.md)，自动检查见 scripts/test-compliance-redlines.js；当前原声语境窗口例外不能按旧“全禁字幕接口”回退。

## 组件与生命周期

- 主题色/尺寸复用 [app.wxss](app.wxss)、[theme.json](theme.json)、utils/theme.js；组件外层使用现有主题根 class，浅/深/跟随系统均验证。
- WXML 绑定不调用 indexOf/includes/map 等 JS 方法；在 JS 预计算或用 WXS。`.wrap` 只提供 flex-wrap，需要与 display:flex / `.row` 配合。
- 复用 utils/intensive-core.js 及视图层 WXS 实现听写与词扫光；高频 setData 用路径差量和既有渲染节流，不能把整份字幕每帧传入视图。
- onHide/onUnload 释放录音、音频、订阅、定时器、Canvas RAF，失效化未完成请求；账号切换与中国自然日变化隔离缓存，避免旧响应回写新账号。
- 通过 audio-bus 协调 TTS、原声、评测与接力互停；clipOffset 用于原字幕轴与切片相对轴换算，不凭词长制造时间戳。
- 自定义顶部控件避让 getMenuButtonBoundingClientRect；底部浮层留出安全区与 tabBar 空间。长句显式留换行点，避免相邻 text 节点连成不可断行文本。

## 数据与权限

- request.js 自动带 Bearer，HTTP 2xx 仍可能 success:false，调用方须判断；4xx/5xx ApiError 读取 message/statusCode/body/code；匿名请求 needAuth:false。
- membershipStore 先用本地展示角色，随后以 subscription/status 校正；最终权限与配额由后端执行。免费评测是跨入口日池，不再按 learn/review 拆月/日池。
- 复习算法复用 utils/srs.js 并与 yuanlu/lib/srs.ts 对齐；生词 quality 0/1/2，句子 SRS 按现有接口反馈。提交确认后才推进，不盲重试写请求。
- 句子元数据复用 sentence-tag-drawer；付费场景统一 premium-modal + source 埋点。小程序不恢复已裁剪的句子 CSV/Anki 导出。
- 示例语料/接力/排行榜为明确降级态；不能把模拟分数、假波形或本地收藏计入真实统计。真实数据入口在 pages/home/*-api.js、dashboard.js、shadowing.js、smart-review.js。

## 验证与剩余工作

改动后运行相关 scripts/test-* 与 npm test；结构断言应覆盖 WXML 方法调用、主题及产品边界，真机验证录音权限、回放、seek、支付和域名。不要把旧任务表的“全部通过”当作本次验证结果。

接力未完成需求单独保留于 [Relay_Module_Tasks.md](Relay_Module_Tasks.md)。我的页管理员控制台仍为占位；签名域名、隐私声明、服务端迁移和部署在发布时重新核对，见 [RESHAPE-AUDIT.md](RESHAPE-AUDIT.md)。
