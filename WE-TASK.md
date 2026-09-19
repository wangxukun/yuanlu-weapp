# 远路播客微信小程序复刻任务清单 (WE-TASK)

## 1. 项目概览
- **复刻目标**：将现有的 `yuanlu` (Web/H5) 核心业务流平滑迁移至微信小程序端，部分特定交互参考 `yuanlu-android` 客户端。
- **技术栈确认**：
  - 核心框架：微信小程序原生开发 (WXML/WXSS/JS或TS)
  - 状态管理：考虑引入轻量级状态管理（如 `mobx-miniprogram`）或自行封装类似 Zustand 的 Store 机制。
  - 网络请求：基于 `wx.request` 封装统一的 HTTP 客户端。

## 2. 小程序复刻难点与跨端差异抹平策略
- **音频播放器**：
  - Web H5 使用 `HTMLAudioElement`，离开页面或锁屏可能中断。
  - **小程序方案**：必须替换为全局单例 `wx.getBackgroundAudioManager()`，并在 `app.js` 或全局 Store 中接管播放状态，支持系统锁屏控制。
- **跟读测评（Shadowing）与录音**：
  - Web H5 依赖浏览器的 `MediaRecorder API` 获取音频流。
  - **小程序方案**：替换为 `wx.getRecorderManager()`。需处理小程序的录音权限申请（`wx.authorize`），并注意音频格式（推荐 `mp3` 或 `aac`）与后端接口的兼容。
- **路由映射**：
  - Web H5 使用 Next.js App Router（如 `/home`, `/library`, `/discover`）。
  - **小程序方案**：在 `app.json` 中配置 `tabBar` 作为一级导航（首页、发现、我的等），其余详情页（单集、播客详情）使用 `wx.navigateTo`，并在返回时处理状态同步。
- **用户鉴权**：
  - Web H5 使用 Auth.js (NextAuth) 进行鉴权。
  - **小程序方案**：对接 `wx.login` 换取 `code`，与远端交换 Token，通过 Request Header 的 `Authorization` 维护会话。

---

## 3. 开发任务分解 (阶段与步骤)

### 阶段一：基础设施建设
- [x] 1.1 初始化项目配置文件（调整 `project.config.json`，清理冗余）。
- [x] 1.2 网络请求封装：基于 `wx.request` 封装 HTTP Request 模块，实现 Token 自动注入和 401 拦截处理。
- [x] 1.3 状态管理基建：搭建基础的 Store 结构（如 `playerStore`, `authStore`, `practiceStore`）。
- [x] 1.4 公共样式与 UI 规范：配置全局颜色变量、字体规范（对齐 Tailwind 设计系统），引入基础 UI 组件库（如可选的 Vant Weapp）。

### 阶段二：全局框架搭建
- [x] 2.1 路由规划：在 `app.json` 中注册核心页面（`pages/home/index`, `pages/discover/index`, `pages/review/index`, `pages/mine/index`，以及 `pages/auth/index`）。
- [x] 2.2 底部导航栏：配置原生 `tabBar`，包含“主页”、“发现”、“复习”、“我的”4个核心入口。
- [x] 2.3 全局授权拦截：完全复刻 yuanlu 项目的登录逻辑（提供手机号/邮箱及验证码/密码的登录入口），替换原有静默登录方案。

### 阶段三：核心业务模块开发 (按优先级)

#### 模块 A：首页与播客列表
- [x] 3.A.1 首页 UI 搭建（完整复刻 yuanlu-android 首页页面的所有模块）。
- [x] 3.A.2 播客/单集详情页搭建（播客详情页完整复刻 yuanlu-android ；单集详情页完整复刻 yuanlu 移动端页面所有模块）。
- [x] 3.A.3 "发现"页 UI 搭建（完整复刻 yuanlu-android `DiscoverScreen` 的所有模块：搜索栏、热门榜 `RankedPodcastCard`、为您推荐 `PodcastCard`、新节目、频道横滑列表、标签筛选 `FilterChip`）。
- [x] 3.A.4 "我的"页面 UI 搭建（复刻 yuanlu `auth/mine/page.tsx` 的所有模块：头部身份卡片（头像/昵称/角色徽章）、数据轨迹宫格（学习路径/收听历史/我的收藏/我的订阅）、系统管理列表（外观设置/帮助与支持）、退出登录按钮）。
- [x] 3.A.5 使用生产环境下的真实数据替换阶段三模块 A 下所有 UI 页面的 Mock 数据（对接 `/api/home`、`/api/discover`、用户 Profile 等后端接口）。

#### 模块 B：音频播放器（核心难点）
- [ ] 3.B.1 后台播放适配：集成 `wx.getBackgroundAudioManager()`。
- [ ] 3.B.2 状态同步：实现播放进度、时长的 Store 同步，对接微信锁屏界面的上一首/下一首/暂停操作。
- [ ] 3.B.3 迷你播放条与全屏面板：实现跨页面的底部迷你播放器，并支持弹出全屏播放详情。

#### 模块 C：跟读测评系统
- [ ] 3.C.1 评测界面重构：复刻 `ImmersiveSpeechPractice`，包含字幕滚动、中英对照、播放参考音。
- [ ] 3.C.2 录音与打分交互：对接 `wx.getRecorderManager()` 录音，长按/点击录制，上传至 `/api/speech/practice-data` 或对应云端节点，展示打分（`fluency`, `accuracy` 等）。
- [ ] 3.C.3 弱项本与设置面板同步（注意：此部分部分复杂 UI 动画和手势，可向 Android 端参考优化）。

#### 模块 D：个人中心与句子收藏
- [ ] 3.D.1 用户中心页（`pages/library/index`）。
- [ ] 3.D.2 播放历史（Listening History）展示。
- [ ] 3.D.3 句子本与生词本（Favorites, Vocabulary, Saved Sentences）列表展示。

### 阶段四：测试与多端适配
- [ ] 4.1 真机调试与鉴权全链路走查。
- [ ] 4.2 性能优化：长列表滚动优化、录音文件分片/压缩。
- [ ] 4.3 平台特有 Bug 修复：处理 iOS/Android 微信运行时的表现差异。
