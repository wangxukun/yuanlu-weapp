# RESHAPE-AUDIT — 真机提审前审计清单（阶段 6 收口交付物）

> 生成日期：2026-10-28 ｜ 对应 RESHAPE-TASK 阶段 6 T6.2 第 2 点
> 本文档是小程序提交审核前的**最终真机验证步骤**，须在微信开发者工具 + 真机预览中逐项确认。

---

## 一、部署前置（生产环境操作顺序）

| # | 操作 | 仓库 | 说明 |
|---|---|---|---|
| 1 | `npx prisma migrate deploy` | yuanlu | 部署两个 additive migration：`20261028120000`（corpus 两表）+ `20261028130000`（clipNote/clipQuestion） |
| 2 | 服务器安装 ffmpeg | 运维 | `dnf install -y --nogpgcheck https://mirrors.aliyun.com/rpmfusion/free/el/rpmfusion-free-release-8.noarch.rpm && dnf install -y ffmpeg`（或静态二进制 → `/usr/local/bin/ffmpeg`） |
| 3 | `npx tsx scripts/build-corpus-index.ts` | yuanlu | 全量灌库（支持 `--limit=N` 分批、`--dry` 预览、`--episode=<id>` 单集重建）；幂等可重跑 |
| 4 | 部署 yuanlu 应用 | 运维 | 两个新增 API 路由组（clips/scenes/studio）随 Next.js 自动生效；**纯 additive，网页版零感知** |
| 5 | 上传小程序代码 | yuanlu-weapp | 微信开发者工具上传新版本 |

---

## 二、真机预览 Network 面板审计（三零验收）

在微信开发者工具（或 vConsole）打开 Network 面板，逐页操作并确认：

### 红线 1：零播客剧集列表接口请求

| 页面 | 操作 | Network 面板应零出现 |
|---|---|---|
| 主页 | 下拉刷新、点击心愿签各入口 | `/api/episode/list`、`/api/episode/list-by-podcastid`、`/api/podcast/list`、`/api/podcast/search` |
| 探索画廊 | 搜索"职场"、点击胶囊/专栏/明信片 | 同上 |
| 复习中心 | 切换三 Tab、出处胶囊 | 同上 |
| 收藏/足迹 | 两 Tab 切换、重研 | `/api/episode/favorite/*` |

### 红线 2：零整集音频请求

| 页面 | 操作 | Network 面板应只出现 |
|---|---|---|
| 微剧场精研室 | 从探索画廊/处方卡/收藏进入 | `/api/scenes/{sceneid}` + `/api/clips/{sceneid}/audio`（≤280KB 的 mp3） |
| 心愿卡册详情 | 心愿工坊生成后进入 | `/api/learning-paths/{id}`（返回含 clip 行）+ `/api/clips/{clipid}/audio` |
| AB 角接龙 | 开始接龙 | 同微剧场切片（不出现 `/api/speech/practice-data`） |

**禁止出现**：`/api/episode/subtitles`（整集字幕请求）或音频文件 > 500KB（整集直链）——**微剧场/卡册/AB 接龙链路全部走切片**。唯一例外：`?id=` 剧集模式精研页（从复习出处胶囊未命中微剧场时回落），该链路在下一版本全量收敛。

### 红线 3：零「AI/大模型/智能/播客」敏感字样

| 位置 | 检查方式 |
|---|---|
| 全部页面标题/按钮/弹窗/输入框 placeholder | 视觉走查 |
| mine 页菜单/关于页/协议页/订阅页 | 视觉走查 |
| `npm run test:compliance` | 自动化（115+ 文件裸扫） |

### 红线 4：零 UGC 评论区

| 页面 | 操作 | 预期 |
|---|---|---|
| 微剧场精研室 | 全页浏览 | 无评论区/发表框/点赞钮 |

---

## 三、合规门禁自动化（已内置 `npm test` 首项）

```bash
node scripts/test-compliance-redlines.js
```

动态解析 `app.json` 已注册页面 + 组件传递闭包（当前 121 文件），断言：
- 零「AI」（词边界）/ 零「大模型」/ 零「智能」/ 零「播客」
- 零 `mini-player` / `player-panel` / `audioManager` / `playerStore` / `download-manager` / `transcript-preview` 残留
- 零 `/api/comment` 调用
- JSON 文件全部可解析

---

## 四、功能走查清单（核心交互路径）

| # | 路径 | 验证点 |
|---|---|---|
| 1 | 主页 → 心愿定制签输入 → 召唤定制 | 跳转心愿工坊弹窗预填自动开门 |
| 2 | 心愿工坊 → 输入心愿 → 勾选「融合生词」→ 开始定制 | toast「策展 N 张原声卡」+ 直达卡册详情 |
| 3 | 卡册详情 → 策展人手记 + 原声卡流 → 点微播放器 | 切片试听（首访转码缓存）+ 点睛批注展示 |
| 4 | 卡册卡 → 跟读 | 跳语音评测页 |
| 5 | 卡册卡 → 捕词 | 跳精研页听写模式（0.8x 预置） |
| 6 | 主页 → 今日五分钟处方卡 | 三类卡展示（生词重逢/弱音狙击/微剧场）+ 微播放器切片试听 |
| 7 | 探索画廊 → 搜索 → 明信片 ♥ 收藏 | 收藏 toast + ♥ 变色 |
| 8 | 探索画廊 → 明信片 → 日签 | Canvas 海报弹层 + 保存到相册 |
| 9 | 精研室（sceneId 模式）→ ⚡连读显微镜 → 连点两词 → 三连放 | 词块选区+琥珀高亮+⚡标+三段慢放 |
| 10 | 精研室 → 精析 Tab | 重点词汇/长难句/随堂小测作答 |
| 11 | 语音评测（sceneId 模式）→ AB 角接龙 → 开始接龙 | A 原声→倒数→自动录音→三指标卡 |
| 12 | 语音评测 → 换我接话 | B 句英文隐藏，仅显中文意图+提示词 |
| 13 | 复习 → 句子本 → 出处胶囊 | 微剧场精研室直达（未收录回落剧集模式） |
| 14 | 我的 → 精研足迹 | 今天/更早分组+重研+清空 |
| 15 | 我的 → 我的收藏 → 微剧场 Tab | 收藏卡流+微播放器+移除 |
| 16 | 订阅页 → 购买 → 微信虚拟支付拉起 | 支付流程完整走通 |

---

## 五、当前遗留事项

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 1 | `?id=` 剧集模式精研页仍播整集音频 | 有意保留 | 所有入口已优先走 `?sceneId=`；剧集模式仅在 by-clip 未命中时回落，后续版本可全量退役 |
| 2 | 日签海报小程序码 | 暂缓 | 需后端提供按 sceneid 生成 `getwxacodeunlimit` 图片接口，当前以品牌落款承接 |
| 3 | 真机 ffmpeg 切片首次延迟 | 观察 | 首访某切片约 1-3s（转码+上传），后续命中缓存秒开；可预热关键切片 |
