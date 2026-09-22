# 远路播客微信小程序复刻任务清单 (WE-TASK)

> 更新日期：2026-09-22（全量代码走查 + 3.A.8/3.A.9/3.A.10 + 标签筛选修复 + 3.B.1 剧集页接入播放 + 3.B.2 状态同步 + **3.B.3 迷你播放条与全屏面板（模块 B 完结）+ 方案 B 重构（页内播放卡退役）+ 播放器 Android 对齐重构（精听标记/定时关闭/播放列表/精听模式入口）+ 双 BUG 修复（切播丢标记/播客名、间距 2rpx）**：16 个注册页面 / 8 个组件 / 4 个 store / 9 个 utils / 14 套单测 542 断言）

## 1. 项目概览
- **复刻目标**：将现有的 `yuanlu` (Web/H5) 核心业务流平滑迁移至微信小程序端，部分特定交互参考 `yuanlu-android` 客户端。
- **技术栈（已定型，按实际落地）**：
  - 核心框架：微信小程序原生开发（JS + WXML/WXSS，CommonJS），无第三方 UI 组件库。
  - 状态管理：自研轻量 Store（`store/core.js` 发布-订阅基类），实例有 `authStore` / `playerStore` / `membershipStore`。
  - 网络请求：`utils/request.js` 唯一出口（get/post/put/delete + Bearer token 自动注入 + 401 清 token），`BASE_URL` 由 `utils/config.js` 按 envVersion 自动切换。
  - 会员/配额底座：`membershipStore`（订阅表校正）+ `premium-modal`（10 场景）+ `utils/track.js` 静默埋点 + `components/common/quota-card`。
  - 测试：`npm test` 14 套件全绿（membership 16 / home-guest 13 / premium-modal 25 / quota-card 14 / srs 20 / audio-tts 32 / login 83 / favorites 33 / search 74 / channels 89 / discover-tags 15 / episode-player 34 / player-store 14 / **mini-player 85**，共 542 断言）。
- **姊妹清单**：「复习」Tab 的详细复刻清单在 [REVIEW-TASK.md](./REVIEW-TASK.md)（19 Task + 权限映射表 + API 对照表），WE-TASK 仅保留汇总行，避免双头跟踪。

## 2. 小程序复刻难点与跨端差异抹平策略
- **音频播放器**：
  - Web H5 使用 `HTMLAudioElement`，离开页面或锁屏可能中断。
  - **小程序方案**：全局单例 `wx.getBackgroundAudioManager()`。✅ 底座已建成 `utils/audioManager.js`（锁屏 onPrev/onNext、播放列表、事件总线、close 关会话），`app.js` 已接线、`requiredBackgroundModes:["audio"]` 已声明；剧集页播放（3.B.1）与跨页迷你条/全屏面板（3.B.3）均已接入。
  - 片段播放（复习/词典场景）：`utils/audio-clip.js`（InnerAudioContext seek + 窗口截停）+ `utils/tts.js`（有道 TTS）+ `utils/audio-bus.js`（TTS ↔ 原声片段 ↔ 全局 BGM 三方互斥总线），均已随复习阶段 0 落地。
- **跟读测评（Shadowing）与录音**：
  - Web H5 依赖浏览器的 `MediaRecorder API` 获取音频流。
  - **小程序方案**：替换为 `wx.getRecorderManager()`（wav / 16kHz / mono，与有道 ISE 参数对齐）；需处理 `scope.record` 授权拒绝后的 `openSetting` 引导。底座未建（REVIEW-TASK T3.1）。
- **路由映射**：
  - Web H5 使用 Next.js App Router（如 `/home`, `/library`, `/discover`）。
  - **小程序方案**：`app.json` tabBar 4 入口（主页/发现/复习/我的，标题统一「远路播客」），详情页 `wx.navigateTo`，共注册 16 页（home / discover / review×6 / mine / auth / library-favorites / podcast / episode / search / channel×2）。
- **用户鉴权**：✅ 已落地。`wx.login` 换 code + 手机验证码/邮箱密码双通道，token 落库 `authStore`，request.js 自动注入。
- **UI 复刻口径**：图标/UI 细节必须原样复刻 Web 端（lucide 原 path，从 yuanlu node_modules 逐字提取），不接受近似替代。

---

## 3. 开发任务分解 (阶段与步骤)

### 阶段一：基础设施建设 ✅ 全部完成
- [x] 1.1 初始化项目配置文件（`project.config.json`、`sitemap.json`）。
- [x] 1.2 网络请求封装：`utils/request.js`（Token 自动注入、401 拦截清 token）。⚠️ 已知语义：不处理 HTTP 200 + `success:false`，调用方须手判；403 reject 整个 body（按 `err.code` 分流，勿依赖 HTTP status）。
- [x] 1.3 状态管理基建：`store/core.js` + `authStore` / `playerStore` / `membershipStore`。
- [x] 1.4 公共样式与 UI 规范：`app.wxss` 设计令牌齐全（`--primary-600`、`.card`、`.btn-primary`、`t-*`、`pb-page-bottom(-with-player)`、z-index 体系）。

### 阶段二：全局框架搭建 ✅ 全部完成
- [x] 2.1 路由规划：`app.json` 注册 14 页（home / discover / review×6 / mine / auth / library-favorites / podcast / episode / search）。
- [x] 2.2 底部导航栏：原生 `tabBar` 4 入口，lucide 图标灰/绿双态。
- [x] 2.3 全局授权拦截：复刻 yuanlu-android `feature/auth` 登录/注册（双 Tab「手机号验证码 / 邮箱密码」、协议全文弹层与强制勾选门禁、60s 倒计时、邮箱注册三步流、token 落库回退；单测 `scripts/test-login.js`）。

### 阶段三：核心业务模块开发 (按优先级)

#### 模块 A：首页与播客列表 ✅ 全部完成（3.A.9 全部频道 + 3.A.10 频道详情已于 2026-09-21 落地）
- [x] 3.A.1 首页 UI（复刻 yuanlu-android 首页全部模块；含游客登录引导态，游客零 API 请求，单测 `test-home-guest.js`）。
- [x] 3.A.2 播客/单集详情页（播客详情复刻 yuanlu-android；单集详情复刻 yuanlu 移动端全模块）。
- [x] 3.A.3 "发现"页（复刻 `DiscoverScreen`：搜索栏[400ms 防抖就地出结果]、热门榜、为您推荐、新节目、频道横滑、标签筛选）。
- [x] 3.A.4 "我的"页（头部身份卡、数据轨迹宫格 4 入口、系统管理列表、退出登录；authStore 订阅同步）。
- [x] 3.A.5 真实数据替换 Mock（`/api/home`、`/api/discover`、用户 Profile 等接口闭环）。
- [x] 3.A.6 剧集页「AI 精讲本集」模块（`components/ai-deep-dive`：PRO 三态流转、四类精讲内容、理解测验交互、会员转化弹窗；`subscription/status` 校正锁态）。
- [x] 3.A.7 剧集标题/介绍翻译接入有道代理真实链路（`translateText` 失败静默降级，清理硬编码占位）。
- [x] 3.A.8 独立搜索页 `pages/search/search`（2026-09-21 完成）。复刻 Web 端 `/search` 页：标题区/空态/骨架屏/计数行/无结果态文案逐字一致；输入栏复刻 `header/SearchBar`（placeholder 全角引号、400ms 防抖 + 回车即搜、深链 `?q=` 对齐 `/search?q=`、导航栏标题随搜索词动态化）；结果卡含平台标签/标题/两行描述/前 2 标签/集数。图标从 Material Symbols 官方源逐字提取烘焙（`search`/`search-off`；Web 空态 `podcast_search` 在字体中不存在属上游 bug，以官方 `manage-search` 替代）。**顺带修复**：发现页 `doSearch` 把 `{success,data,total}` 整包当数组的现行 bug（就地搜索此前实际渲染错乱）+ 结果补双列分块 + 底部「搜索 "q" 的全部结果」入口跳转本页 + 🔍 emoji 升级为官方 search.svg；`test-srs.js` 硬编码「未来日期」跨天翻转的用例改为动态构造。**真机走查后二轮修正（2026-09-21）**：发现页就地搜索卡此前缺 `grid-col`（flex:1）包裹导致同列卡片宽度被标题文字撑开、大小不一——已对齐本页其他区块补包裹 + 奇数行占位；且查证 Android `DiscoverScreen` 实际未渲染 `searchResults`（「封面+标题」极简卡无复刻依据），就地搜索卡已升级为与独立搜索页完全同款的富卡（平台/单行标题/两行描述/前 2 标签/集数）。**三轮修正**：独立搜索页奇数末卡因 `flex:1` 拉满整行（对齐 Web 网格半宽 + 右侧留空的行为补 `grid-col` 占位）。单测 `scripts/test-search.js`（74 断言）。
- [x] 3.A.9 全部频道页 `pages/channel/all/index`（2026-09-21 完成）。完整复刻 Android `ChannelListScreen.kt`：发现页「推荐频道 · 查看更多」进入；`GET /api/podcast/list` → 按 platform 聚合（过滤空值、节目数降序，对齐 DiscoverViewModel）；双列 1:1 方卡（primaryContainer=`#edf7f2`/`--primary-50`、圆角 16dp=32rpx、内容垂直居中）、频道名单行截断、「X 档节目」（onPrimaryContainer 70% 透明）、白底胶囊（Material 官方 `Icons.Filled.Computer` path 烘焙 primary 色 + 「频道主页」加粗）；loading/错误重试/空态（暂无频道）三态齐备；卡片点击 → `/pages/channel/index?name=` 深链。单测 `scripts/test-channels.js`（42 断言）。
- [x] 3.A.10 频道详情页 `pages/channel/index`（2026-09-21 完成，融合复刻）。数据层照搬 Android `ChannelViewModel`/`ContentRepository`：`GET /api/channel/{name}`（信封 `{success,data:{platformName,podcastCount,topShows,topEpisodes}}`，topShows=该平台播客 totalPlays 降序、topEpisodes=playCount 降序 take 9、封面 3h 签名；success:false/404 → 错误态+重试，`loadedName` 复用）。UI 上半部复刻 `ChannelScreen.kt`+`频道页面.jpg`（titleLarge 页头 +「X 档播客」、热门节目双列 `PodcastCard`：1:1 封面 16dp 圆角、平台眉标大写字距 1.4sp、标题 2 行截断、「N episodes」）；下半部「热门单集」逐字复刻本工程播客详情页 `episode-row`（16:9 封面 + 等级徽章 + 半透明黑时长遮罩 + 播客名/标题 2 行/耳机+收听数/日历+日期，`ep-*` 样式与 `pages/podcast/podcast.wxss` 逐字一致、wxs 复用 `podcast.wxs`；channel 接口无 difficulty 字段故徽章按数据有无渲染）。跳转：节目→播客详情、单集→剧集详情。测试并入 `scripts/test-channels.js`（89 断言）。

#### 模块 B：音频播放器（核心难点，✅ 全部完成，2026-09-21/22）
- [x] 3.B.1 剧集页接入播放（2026-09-21 完成）。「开始精听」/hero 封面 → `audioBus.stopAll()` 互停（停 TTS/复习原声片段）→ `audioManager.playEpisode`（BGM 单例；无直链时经 `/api/episode/subtitles` 解析 OSS 签名直链）；锁屏元数据注入（title/epname/singer/coverImgUrl）；播放列表 = 当前剧集 + 相关剧集（ended 自动连播、锁屏上/下一首）；「开始精听」按钮文案与图标（含 hero 封面右下角播放浮钮）随播放态幂等切换（`isCurrentPlaying` 派生态，暂停/他集在播均正确回落）。控件图标 12 个从 Material 官方源提取烘焙（play/pause FILL、skip/replay/forward/repeat/repeat_one/shuffle）。**2026-09-22 方案 B 重构**：页内播放控制卡退役（对齐 Web 剧集页无页内卡、控件全在全局 bar/sheet 的结构，消除双份控件实现）；起播链路与 isCurrentPlaying 派生保留，播放控制收敛到 3.B.3 迷你条+全屏面板。单测 `scripts/test-episode-player.js`（26 断言，mock BGM 全链路）
- [x] 3.B.2 状态同步（2026-09-21 完成）。`store/playerStore.js` 从空架子重写为 **audioManager 的全局只读镜像 store**：模块加载即订阅全部播放事件（play/pause/stop/ended/waiting/timeupdate/episodeChange/modeChange/seek/error），快照字段（当前剧集/播放态/缓冲/进度/时长/倍速/循环模式/播放列表）与事实源 `getState()` 全字段一致；跨页面组件统一用与 authStore 同款的 `subscribe` 感知播放态（3.B.3 迷你播放条直用），播放命令仍走 audioManager（单向依赖，状态经事件回流永不分叉），app.js 已接线激活。锁屏三键回调链（`onPrev`/`onNext`/`onPause`）与 ended 自动连播经 mock BGM 验证。单测 `scripts/test-player-store.js`（14 断言）。
- [x] 3.B.3 迷你播放条与全屏面板（2026-09-22 完成，模块 B 完结）。**`components/player/mini-player`**（复刻 Web `MobilePlayerBar`）：顶缘 2px 渐变进度线 + 封面缩略图（播放中黑色遮罩叠 4 根白色均衡器条，0/200/400/600ms 延迟）+ 标题/播客名（兜底「远路播客」）+ primary 播放圆钮 + 关闭钮；无会话（hasEpisode=false）整条不渲染；订阅 playerStore（timeupdate 400ms 节流）。**`components/player/player-panel`**（复刻 Web `MobilePlayerSheet`，按小程序单屏滚动习惯做同源映射）：上滑入场全屏浮层，header（chevron-down 收起 /「📖 精读」pill / close 关闭播放器）+ 16:9 封面（点击跳剧集页）+ 标题/播客名 + 拖拽进度条（拖动期不追 timeupdate）+ 当前/剩余双时间 + 大控件行（倍速 1→1.25→1.5→2→0.75 / 上下首 / primary 播放大钮 / 循环含随机）+ **精读字幕**（`/api/episode/subtitles` 当前行高亮 + 自动跟随 scroll-into-view，用户手动滚动后暂停 8s + 译文开关 + 点行 seek + 加载/空态）+ 底部悬浮迷你控制条（对齐 Web Floating Mini Player：进度线 + 标题 + mono 当前/总时长 + 播放/下一首/关闭）。**互斥闭环**：`audioManager` 新增 `close()`（停声+清空会话/播放列表，对齐 Web closePlayer）；迷你条/面板/剧集页恢复播放前一律 `audioBus.stopAll()`（反向「片段开播停 BGM」audio-bus 原有）。**接入 10 页**：tabBar 四页（home/discover/review/mine，`elevated` 上移让出原生 tabBar，内容区 `pb-page-bottom-with-player` 已预留）+ 6 详情页（podcast/search/channel/channel-all/favorites/**episode**，贴底 + 底部留白已让位）；auth/复习子页桩不接。图标新增 Material 官方 `close`/`center_focus_strong` 2 枚烘焙。单测 `scripts/test-mini-player.js`（44 断言，假时钟驱动节流/自动跟随时序，mock BGM 全链路）。**方案 B 重构（2026-09-22，用户确认）**：剧集页页内播放控制卡退役、改挂迷你条（对齐 Web 剧集页无页内卡的结构，消除双份控件实现，播放控制单一来源）；快退 15s/快进 30s 由面板大控件行承接（五枚主行：快退/上一首/播放/下一首/快进；倍速与循环移次行 chips）；面板封面跳转加页面栈守卫（栈顶已是目标剧集页时 no-op，防重复入栈）。**遗留**：复习 Tab swiper 内容区底部让位随 REVIEW-TASK notebook 填充时处理。**Android 对齐重构（2026-09-22 二轮，参照 yuanlu-android `FullScreenPlayerScreen`/`MiniPlayerBar`/`PlayerController` + 3 张截图，用户指令）**：① **UI 减法**——面板顶部「精读」pill 与整个字幕模块（字幕加载/当前行高亮/自动跟随/译文开关/点行 seek/悬浮迷你控制条）彻底移除；② **精听标记贯通**——audioManager 新增 `isIntensiveMode`（「开始精听」起播置位、普通起播复位、`setIntensiveMode` 手动补标记、close 复位），迷你条副标题行前「精听」小标签（GraphicEq 9dp 图标 + 9sp 粗体，Primary600@12% 底，对齐 Android MiniPlayerBar），面板封面右上角「精听中」角标；③ **迷你条互斥与间距**——面板展开时条体 `wx:if` 整条隐藏（关闭恢复），tabBar 页与导航条间距 mb-1（8rpx，后经双 BUG 修复调整为固定 2rpx，见本条末段）；④ **定时关闭真实逻辑**（对齐 Android applySleepConfig/handleSleepOnEpisodeEnded）：`SleepConfig` 三态（minutes→1s 倒计时到点**暂停** / episodes→ended 结算递减、到量**停不连播** / episodeEnd→播完整集即停）+ `lastSleepConfig` 记忆 + 定时弹层（上次定时 Switch 快捷重开/取消、按时间行「播完整集声音再停止」单选、15/30/60/90 分胶囊、**自定义分钟输入**（Android 为 toast 占位，小程序做成真实 wx.showModal editable）、按集数 播完本集/2/3/5 集、定时启播占位），定时按钮激活时转主题色并显示 mm:ss 倒计时或 describe 文案；⑤ **播放列表弹层**（Android 为 toast 占位，小程序按真实队列实现）：当前集高亮 + 均衡器动效 + 点条目切播 + 点当前集重播；⑥ **精听模式橙色胶囊**（Accent500，页面最底部，GraphicEq 白图标）：补精听标记 + practice 深链跳 episode 页自动起播精听（`_maybeAutoPractice`：详情与相关剧集就绪后自动起播；已在播本集仅补标记），栈顶守卫（已是本集剧集页时直接调 `page.onStartListening()` 不重复入栈）；⑦ 控制排对齐截图五枚（倍速/上一首/播放/下一首/循环，±15s/±30s 随字幕模块一并移除）；⑧ 图标烘焙 Material 官方 `graphic_eq`（primary/白 双色）、`queue_music`、`alarm`；⑨ playerStore 镜像扩展 isIntensiveMode/sleepTimer/lastSleepConfig + `sleepTimer`/`sleepTimerFired` 事件。单测 `test-mini-player.js` 重写（84 断言：定时三态全链路/精听标记/互斥/播放列表切播/守卫/WXML 减法验证）+ `test-episode-player.js`（32 断言：精听置位 + practice 深链）。**遗留**：独立精听工作流页（对齐 Android `IntensiveListeningScreen`，现为 episode 页 practice 深链承接）待精听专项模块。**双 BUG 修复（2026-09-22，用户反馈）**：① 播放列表切播后迷你条丢失精听标签与播客名——切播改透传当前 intensive 标记（同一精听会话内换集不复位；普通起播复位语义不变），episode 页构建播放列表时为 related 条目回填 podcastTitle/coverUrl（list-by-podcastid 缺字段，兜底链与相关剧集行一致）；② tabBar 页播放条与导航条间距过大——tabBar 页 webview 视口底边即原生 tabBar 顶边，导航高度/safe 偏移全部多余，`.mp-elevated` 改为固定 `bottom: 2rpx`。

#### 模块 C：跟读测评系统（→ 详细拆解见 REVIEW-TASK.md 阶段 3）
> 本模块与「复习」Tab 的语音评测共底座（eval-card / recorder / 有道 ISE），统一由 REVIEW-TASK 跟踪，此处仅汇总：
- [ ] 3.C.1 录音底座 `utils/recorder.js`（wav/16k/mono → base64；授权拒绝引导）〔REVIEW-TASK T3.1〕
- [ ] 3.C.2 语音评测卡 `components/voice/eval-card`（四互斥态录音区、逐词胶囊、音素对比、三维评分）〔REVIEW-TASK T3.2〕
- [ ] 3.C.3 刷句复习卡组流 `pages/review/deck`（拖拽手势 ±90px/±400px·s⁻¹、翻面、三模式）〔REVIEW-TASK T3.3〕
- [ ] 3.C.4 AI 影子跟读页 `pages/review/shadowing`（现为桩，复用 eval-card）〔REVIEW-TASK T3.4〕
- [ ] 3.C.5 剧集页内跟读入口（Web 端 `?practice=true&subtitleId=` 场景；弱项本暂降级跳闯关页，见 REVIEW-TASK 风险 #7）

#### 模块 D：个人中心与句子收藏（⏳ 收藏已毕，余 3 个死链页面）
- [x] 3.D.1 用户中心页：由 `pages/mine/index` 承担（原规划的 `pages/library/index` 不再单独建页，3.A.4 已覆盖，本项关闭）。
- [ ] 3.D.2 收听历史页 `pages/library/history/index`（mine 宫格入口当前指向**未注册页面**，点击报错；对齐 Web `/library/history`）。
- [x] 3.D.3 我的收藏 `pages/library/favorites`（双 Tab「播客系列 (X)/单集 (Y)」+ 搜索过滤 + 封面卡片 + 乐观取消收藏/失败回滚；单测 `test-favorites.js`）。
- [ ] 3.D.4 学习路径页 `pages/library/paths/index`（mine 宫格死链入口之二，对齐 Web `/library/paths`）。
- [ ] 3.D.5 我的订阅页 `pages/library/subscribe/index`（mine 宫格死链入口之三；与订阅/虚拟支付排期联动）。
- [ ] 3.D.6 个人资料编辑页 `pages/profile/index`（mine 头部点击跳转，当前死链；头像/昵称编辑，注意微信头像昵称填写能力）。

#### 模块 E：订阅与支付转化（新增，未开始）
- [ ] 3.E.1 订阅页 `pages/subscription/index`（premium-modal 全部 10 场景 CTA 仍是「即将上线」占位；Web 端 `/subscription` 会员权益对比 + 价格档位复刻）。
- [ ] 3.E.2 微信虚拟支付接入（合规红线：微信内必须走虚拟支付，爱发电必被拒；个人主体可开通；微信外 H5 暂留爱发电看数据）。
- [ ] 3.E.3 类目与主体规划（拟用 工具-信息查询；长期迁个体工商户，见记忆「上线合规与虚拟支付」）。

### 阶段四：测试与多端适配（未开始）
- [ ] 4.1 真机调试与鉴权全链路走查（登录/登出/token 过期/游客引导态）。
- [ ] 4.2 合法域名配置（真机阻断级）：OSS 签名直链域名 + `dict.youdao.com`（dictvoice/TTS）加入 request/downloadFile 合法域名；开发者工具 `urlCheck:false` 不暴露此问题。
- [ ] 4.3 性能优化：长列表滚动优化、录音文件分片/压缩。
- [ ] 4.4 平台特有 Bug：iOS/Android 微信运行时差异（InnerAudioContext seek 精度、录音/播放互斥、CSS 3D `backface-visibility` 前缀等）。
- [ ] 4.5 录音评测真机闭环：wav/16k/mono 产物被有道 ISE 正常评测（REVIEW-TASK 阶段 3 最先打通项）。

### 工程债与清理（走查发现，随近任务顺手处理）
- [x] 5.1 ~~死代码清理~~ → **已解决（2026-09-21）**：`pages/home/home.*` 四件套（阶段一 10 行 TODO 桩，未注册、零引用）已删除，现役首页为 `pages/home/index.*`；`npm test` 11 套件回归全绿。
- [ ] 5.2 `utils/config.js` dev `BASE_URL` 当前临时指向生产 `https://www.wxkzd.com`（commit cad6670，便于真机预览联调），联调完切回 `localhost:3000`。
- [ ] 5.3 mine 页 3 个死链宫格入口在对应页面建成前做隐藏或「敬请期待」降级，避免线上点击报错。
- [ ] 5.4 「外观设置」当前仅 toast 占位（"小程序暂不支持主题切换"），确认产品口径后转正式任务或移除入口。
- [ ] 5.5 premium-modal CTA 全量占位 → 随 3.E.1 订阅页接线（含 `source` 透传归因）。
- [x] 5.6 ~~发现页频道死链~~ → **已解决（3.A.9 + 3.A.10）**：`pages/channel/all`（全部频道）与 `pages/channel/index`（频道详情）均已建成注册，发现页「查看更多」与频道卡入口全链路激活。
- [x] 5.7 发现页「分类标签」筛选失效（2026-09-21 修复）：根因是标签行数据源 `/api/tag/list` 为标签全库（课程/语法型），与播客实际挂的标签交集≈0（线上实测 20 个仅 1 个命中），点 19/20 个标签过滤恒空——Android `FilterChip` 同款失效（Web 发现页本无此模块）。修复：标签行改由 `/api/podcast/list` 播客 tags 派生（按命中数降序，线上派生 41 个、每个必命中），并修复区头标题恒显 `tags[0].name` 的小 bug（改 `selectedTagName` 维护）。单测 `scripts/test-discover-tags.js`（15 断言，含线上数据回放）。
