# Android Material 图标全量清单（Android-Meterial.md）

> **图标政策（长期有效）**：yuanlu-weapp 今后所有涉及图标的地方**必须使用 Android Material 图标**
> （`yuanlu-android` 项目 `Icons.Filled.*` 同名图标，源 = Google 官方 materialicons 24px path），
> 不再使用 lucide/自绘线性图标。新图标烘焙规范见文末。
>
> 本清单为 2026-09-27 全量走查的终态台账：全项目 210 处图标引用、252 个图标文件 →
> 223 个文件（T4.5 批次 +7〔leaderboard-primary 随「最近得分」退役删除〕、Web 口径恢复批 +3）
> → **235 个（2026-09-28 学习路径批 +12，见第四节）** → **276 个（2026-09-29 个人中心批 +38，见第八节；
> 较上批记账 235 实有 238——git 跟踪 238，历史批 3 个零头未记账，本批一并校准）**
> → **290 个（2026-10-01 我的页分组列表重构批 +11/−6，见第九节）**，**lucide 图标已 100% 替换**（125 处 SVG 换字形/改名 + 12 处 PNG 重绘 +
> 1 处重定向去重），退役旧文件 129 个已删除，`npm test` 35 套件全绿。
> PNG 重绘覆盖：tabBar 4 Tab ×2 态（8 张）+ 我的页宫格 3 张（school/history/bookmark/
> credit-card 中 history/bookmark/credit-card 沿用文件名）+ 头像 person.png + 激活态 person-active.png。

---

## 一、底部导航栏（app.json tabBar 4 Tab，PNG 81×81）

| Tab | Android 对应 | Material 图标 | 文件（默认 / 激活） | 状态 |
|-----|-------------|--------------|---------------------|------|
| 主页 | 底部导航「首页」`Icons.Filled.Home` | `home` | `home.png`（#a79e8a）/ `home-active.png`（#1f7a5c） | ✅ 已替换（lucide 房子 → Material Home） |
| 发现 | 底部导航「发现」`Icons.Filled.Explore` | `explore` | `explore.png` / `explore-active.png` | ✅ 已替换（lucide 指南针 compass → Material Explore） |
| 复习 | Android 无此 Tab（最接近：生词本 `Icons.Filled.MenuBook`） | `menu_book` | `menu-book.png` / `menu-book-active.png` | ✅ 已替换（lucide book-open → Material MenuBook） |
| 我的 | 底部导航「我的」`Icons.Filled.Person` | `person` | `person.png` / `person-active.png` | ✅ 已替换（lucide user → Material Person） |

> weapp 底栏为 Web 端结构（主页/发现/复习/我的），Android 为 首页/发现/生词本/我的；
> 图标字形按 Android 同名 Tab 一一对应，复习 Tab 取 Android 生词本 Feature 图标 MenuBook。

## 二、我的页菜单（pages/mine，对照 Android ProfileScreen.kt；2026-10-01 重构为分组列表，见第九节）

| 菜单项 | Android（ProfileScreen.kt 原值） | Material 图标 | weapp 文件 | 状态 |
|--------|--------------------------------|--------------|-----------|------|
| 学习路径 | `Icons.Filled.School`（primary） | `school` | `school-primary(-dark).svg` | ✅ 分组列表批（宫格 PNG 退役） |
| 收听历史 | `Icons.Filled.History`（secondary） | `history` | `history-accent.svg` | ✅ 分组列表批（宫格 PNG 退役） |
| 我的收藏 | `Icons.Filled.Bookmark`（#B96F0F） | `bookmark` | `bookmark-accent-deep.svg` | ✅ 分组列表批（宫格 PNG 退役；**新后缀 `-accent-deep`=Android 字面值 #b96f0f**，区别于 amber #f59e0b 系） |
| 我的订阅 | `Icons.Filled.CreditCard`（secondary） | `credit_card` | `credit-card-accent.svg` | ✅ 分组列表批（宫格 PNG 退役） |
| 控制台（管理员） | `Icons.Filled.Computer`（error） | `computer` | `computer-error.svg` | ✅ 已替换（lucide layout-dashboard → Computer） |
| 外观设置 | `Icons.Filled.Contrast`（tertiary） | `contrast` | `contrast-tertiary(-dark).svg` | ✅ 分组列表批（contrast-ink 退役；行尾带模式尾值） |
| 帮助与支持 | `Icons.AutoMirrored.Filled.HelpOutline`（tertiary） | `help_outline` | `help-outline-tertiary(-dark).svg` | ✅ 分组列表批（help-outline-ink 退役） |
| 个人中心（头像占位） | `Icons.Filled.Person` / `AccountCircle` | `person` | `person.png` 81px #a69d89 | ✅ 已替换（lucide user → Person） |
| 行尾箭头 | `Icons.AutoMirrored.Filled.KeyboardArrowRight` | `keyboard_arrow_right` | `keyboard-arrow-right-tertiary(-dark).svg`（菜单行 opacity .4 = onSurfaceVariant 40%） | ✅ 已替换（原为文字「〉」hack） |
| 发音弱项本 | Android 菜单项 `Icons.Filled.Mic`（tertiary） | `mic` | 复习 Tab 内 pron-list 页头 `mic-tertiary(-dark).svg`（**weapp 我的页按需求不含此项**） | ✅ 已是 Material（历史批次） |
| 消息通知 | Android 菜单项 `Icons.Filled.Notifications`（primary） | `notifications` | `notifications-primary(-dark).svg`（菜单行）+ `notifications-ink.svg` #767471（通知页空态） | ✅ 分组列表批换 primary 着色；ink 款保留供通知页空态 |

## 三、复习中心三 Tab（pages/review/index.js）

| Tab | Material 图标 | 文件（未激活 #a79e8a / 激活） | 状态 |
|-----|--------------|-------------------------------|------|
| 生词本 | `menu_book` | `menu-book-gray.svg` / `menu-book-primary.svg` | ✅ 已替换（lucide book-a） |
| 句子本 | `format_quote` | `format-quote-gray.svg` / `format-quote-primary.svg` | ✅ 已替换（lucide text-quote） |
| 发音弱项本 | `mic` | `mic-ink.svg` / `mic-ink-active.svg`（就地换 Material 字形） | ✅ 已替换 |

## 四、逐图标替换明细（本次全量 125 SVG + 11 PNG + 1 重定向）

| # | 类型 | 旧文件（lucide） | Android Material 图标 | 新文件 | 主要使用位置 | 状态 |
|---|------|------------------|----------------------|--------|--------------|------|
| 1 | 就地换字形 | `send-white.svg` | `send` | `send-white.svg` | contact | ✅ 已替换 |
| 2 | 就地换字形 | `translate.svg` | `translate` | `translate.svg` | episode | ✅ 已替换 |
| 3 | 就地换字形 | `translate-primary.svg` | `translate` | `translate-primary.svg` | intensive-listening、speech-eval、voice/eval-card | ✅ 已替换 |
| 4 | 就地换字形 | `translate-primarydark.svg` | `translate` | `translate-primarydark.svg` | speech-eval、voice/eval-card | ✅ 已替换 |
| 5 | 就地换字形 | `translate-gray.svg` | `translate` | `translate-gray.svg` | intensive-listening、speech-eval、voice/eval-card | ✅ 已替换 |
| 6 | 就地换字形 | `translate-graydark.svg` | `translate` | `translate-graydark.svg` | speech-eval、voice/eval-card | ✅ 已替换 |
| 7 | 就地换字形 | `tv.svg` | `tv` | `tv.svg` | episode | ✅ 已替换 |
| 8 | 就地换字形 | `download.svg` | `download` | `download.svg` | episode | ✅ 已替换 |
| 9 | 就地换字形 | `bookmark-border.svg` | `bookmark_border` | `bookmark-border.svg` | episode、podcast | ✅ 已替换 |
| 10 | 就地换字形 | `share.svg` | `share` | `share.svg` | episode、podcast | ✅ 已替换 |
| 11 | 就地换字形 | `list.svg` | `list` | `list.svg` | ai-deep-dive、episode | ✅ 已替换 |
| 12 | 就地换字形 | `lock.svg` | `lock` | `lock.svg` | ai-deep-dive、home、review/deck、voice/eval-card | ✅ 已替换 |
| 13 | 就地换字形 | `lock-white.svg` | `lock` | `lock-white.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 14 | 就地换字形 | `lock-amber.svg` | `lock` | `lock-amber.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 15 | 就地换字形 | `lock-faint.svg` | `lock` | `lock-faint.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 16 | 就地换字形 | `lock-faint-dark.svg` | `lock` | `lock-faint-dark.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 17 | 就地换字形 | `check-circle.svg` | `check_circle` | `check-circle.svg` | ai-deep-dive、premium-modal | ✅ 已替换 |
| 18 | 就地换字形 | `check-circle-success.svg` | `check_circle` | `check-circle-success.svg` | intensive-listening | ✅ 已替换 |
| 19 | 就地换字形 | `check-circle-success-dark.svg` | `check_circle` | `check-circle-success-dark.svg` | intensive-listening | ✅ 已替换 |
| 20 | 就地换字形 | `check-white.svg` | `check` | `check-white.svg` | sentence-tag-drawer | ✅ 已替换 |
| 21 | 就地换字形 | `mic-gray.svg` | `mic` | `mic-gray.svg` | review/deck、review/sentence-notebook | ✅ 已替换 |
| 22 | 就地换字形 | `mic-ink.svg` | `mic` | `mic-ink.svg` | review | ✅ 已替换 |
| 23 | 就地换字形 | `mic-ink-active.svg` | `mic` | `mic-ink-active.svg` | review、review/pron-notebook | ✅ 已替换 |
| 24 | 就地换字形 | `settings-ink.svg` | `settings` | `settings-ink.svg` | speech-eval | ✅ 已替换 |
| 25 | 就地换字形 | `settings-light.svg` | `settings` | `settings-light.svg` | speech-eval | ✅ 已替换 |
| 26 | 就地换字形 | `settings-primary.svg` | `settings` | `settings-primary.svg` | speech-settings | ✅ 已替换 |
| 27 | 改名替换 | `repeat-lucide-gray.svg` | `repeat` | `repeat-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 28 | 改名替换 | `repeat-lucide-graydark.svg` | `repeat` | `repeat-graydark.svg` | （本次退役删除） | ✅ 已替换 |
| 29 | 就地换字形 | `layers-primary.svg` | `layers` | `layers-primary.svg` | review/deck | ✅ 已替换 |
| 30 | 就地换字形 | `layers-gray.svg` | `layers` | `layers-gray.svg` | review/deck | ✅ 已替换 |
| 31 | 就地换字形 | `list-gray.svg` | `list` | `list-gray.svg` | review/sentence-notebook | ✅ 已替换 |
| 32 | 就地换字形 | `list-ink.svg` | `list` | `list-ink.svg` | review/sentence-notebook | ✅ 已替换 |
| 33 | 就地换字形 | `list-ink100.svg` | `list` | `list-ink100.svg` | review/sentence-notebook | ✅ 已替换 |
| 34 | 就地换字形 | `trending-up-primary.svg` | `trending_up` | `trending-up-primary.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 35 | 就地换字形 | `trending-up-primary-dark.svg` | `trending_up` | `trending-up-primary-dark.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 36 | 就地换字形 | `lightbulb-amber.svg` | `lightbulb` | `lightbulb-amber.svg` | review/diagnostic-report-card | ✅ 已替换 |
| 37 | 就地换字形 | `pause-primary.svg` | `pause` | `pause-primary.svg` | review/sentence-micro-player | ✅ 已替换 |
| 38 | 就地换字形 | `pause-primary-dark.svg` | `pause` | `pause-primary-dark.svg` | review/sentence-micro-player | ✅ 已替换 |
| 39 | 就地换字形 | `schedule-accent.svg` | `schedule` | `schedule-accent.svg` | review/vocab-review | ✅ 已替换 |
| 40 | 就地换字形 | `replay-error.svg` | `replay` | `replay-error.svg` | review/vocab-review | ✅ 已替换 |
| 41 | 就地换字形 | `play-circle-primary.svg` | `play_circle` | `play-circle-primary.svg` | intensive-listening | ✅ 已替换 |
| 42 | 改名替换 | `calendar.svg` | `date_range` | `date-range.svg` | （本次退役删除） | ✅ 已替换 |
| 43 | 改名替换 | `clock.svg` | `schedule` | `schedule.svg` | （本次退役删除） | ✅ 已替换 |
| 44 | 改名替换 | `circle-alert-error.svg` | `error` | `error.svg` | （本次退役删除） | ✅ 已替换 |
| 45 | 改名替换 | `file-text.svg` | `description` | `description.svg` | （本次退役删除） | ✅ 已替换 |
| 46 | 改名替换 | `file-text-primary.svg` | `description` | `description-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 47 | 改名替换 | `file-text-indigo.svg` | `description` | `description-indigo.svg` | （本次退役删除） | ✅ 已替换 |
| 48 | 改名替换 | `chevron-up.svg` | `keyboard_arrow_up` | `keyboard-arrow-up.svg` | （本次退役删除） | ✅ 已替换 |
| 49 | 改名替换 | `chevron-down.svg` | `keyboard_arrow_down` | `keyboard-arrow-down.svg` | （本次退役删除） | ✅ 已替换 |
| 50 | 改名替换 | `chevron-up-gray.svg` | `keyboard_arrow_up` | `keyboard-arrow-up-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 51 | 改名替换 | `chevron-down-gray.svg` | `keyboard_arrow_down` | `keyboard-arrow-down-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 52 | 改名替换 | `chevron-down-light.svg` | `keyboard_arrow_down` | `keyboard-arrow-down-light.svg` | （本次退役删除） | ✅ 已替换 |
| 53 | 改名替换 | `chevron-down-ink.svg` | `keyboard_arrow_down` | `keyboard-arrow-down-ink.svg` | （本次退役删除） | ✅ 已替换 |
| 54 | 改名替换 | `chevron-down-primary.svg` | `keyboard_arrow_down` | `keyboard-arrow-down-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 55 | 改名替换 | `chevron-down-primary-dark.svg` | `keyboard_arrow_down` | `keyboard-arrow-down-primary-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 56 | 改名替换 | `chevron-up-primary.svg` | `keyboard_arrow_up` | `keyboard-arrow-up-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 57 | 改名替换 | `chevron-up-primary-dark.svg` | `keyboard_arrow_up` | `keyboard-arrow-up-primary-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 58 | 改名替换 | `chevron-left-primary.svg` | `keyboard_arrow_left` | `keyboard-arrow-left-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 59 | 改名替换 | `chevron-left-dark.svg` | `keyboard_arrow_left` | `keyboard-arrow-left-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 60 | 改名替换 | `chevron-right-primary.svg` | `keyboard_arrow_right` | `keyboard-arrow-right-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 61 | 改名替换 | `chevron-right-dark.svg` | `keyboard_arrow_right` | `keyboard-arrow-right-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 62 | 改名替换 | `arrows-right-left-primary.svg` | `swap_horiz` | `swap-horiz-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 63 | 改名替换 | `arrows-right-left-gray.svg` | `swap_horiz` | `swap-horiz-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 64 | 改名替换 | `bookmark-outline-gray.svg` | `bookmark_border` | `bookmark-border-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 65 | 改名替换 | `bookmark-filled.svg` | `bookmark` | `bookmark.svg` | （本次退役删除） | ✅ 已替换 |
| 66 | 改名替换 | `bookmark-check-primary.svg` | `bookmark_added` | `bookmark-added-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 67 | 改名替换 | `layout-dashboard-error.svg` | `computer` | `computer-error.svg` | （本次退役删除） | ✅ 已替换 |
| 68 | 改名替换 | `palette-ink.svg` | `contrast` | `contrast-ink.svg` | （本次退役删除） | ✅ 已替换 |
| 69 | 改名替换 | `circle-help-ink.svg` | `help_outline` | `help-outline-ink.svg` | （本次退役删除） | ✅ 已替换 |
| 70 | 改名替换 | `help-circle-primary.svg` | `help_outline` | `help-outline-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 71 | 改名替换 | `book-a.svg` | `menu_book` | `menu-book-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 72 | 改名替换 | `book-a-active.svg` | `menu_book` | `menu-book-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 73 | 改名替换 | `book-open-primary.svg` | `menu_book` | `menu-book-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 74 | 改名替换 | `text-quote.svg` | `format_quote` | `format-quote-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 75 | 改名替换 | `text-quote-active.svg` | `format_quote` | `format-quote-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 76 | 改名替换 | `text-quote-primary.svg` | `format_quote` | `format-quote-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 77 | 改名替换 | `text-quote-primary-dark.svg` | `format_quote` | `format-quote-primary-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 78 | 改名替换 | `list-ordered-primary.svg` | `format_list_numbered` | `format-list-numbered-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 79 | 改名替换 | `list-ordered-gray.svg` | `format_list_numbered` | `format-list-numbered-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 80 | 改名替换 | `sparkles.svg` | `auto_awesome` | `auto-awesome.svg` | （本次退役删除） | ✅ 已替换 |
| 81 | 改名替换 | `sparkles-primary.svg` | `auto_awesome` | `auto-awesome-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 82 | 改名替换 | `sparkles-gray.svg` | `auto_awesome` | `auto-awesome-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 83 | 改名替换 | `flame-orange.svg` | `local_fire_department` | `local-fire-department-orange.svg` | （本次退役删除） | ✅ 已替换 |
| 84 | 改名替换 | `arrow-right-white.svg` | `arrow_forward` | `arrow-forward-white.svg` | （本次退役删除） | ✅ 已替换 |
| 85 | 改名替换 | `volume-2-gray.svg` | `volume_up` | `volume-up-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 86 | 改名替换 | `volume-1-white.svg` | `slow_motion_video` | `slow-motion-video-white.svg` | （本次退役删除） | ✅ 已替换 |
| 87 | 改名替换 | `volume-1-dark.svg` | `slow_motion_video` | `slow-motion-video-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 88 | 改名替换 | `volume-1-primary.svg` | `slow_motion_video` | `slow-motion-video-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 89 | 改名替换 | `repeat-1-primary.svg` | `repeat_one` | `repeat-one-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 90 | 改名替换 | `repeat-1-primary-dark.svg` | `repeat_one` | `repeat-one-primary-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 91 | 改名替换 | `eye-primary.svg` | `visibility` | `visibility-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 92 | 改名替换 | `eye-dark.svg` | `visibility` | `visibility-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 93 | 改名替换 | `eye-off-primary.svg` | `visibility_off` | `visibility-off-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 94 | 改名替换 | `eye-off-dark.svg` | `visibility_off` | `visibility-off-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 95 | 改名替换 | `refresh-ccw-light.svg` | `refresh` | `refresh-light.svg` | （本次退役删除） | ✅ 已替换 |
| 96 | 改名替换 | `refresh-ccw-gray.svg` | `refresh` | `refresh-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 97 | 改名替换 | `x-circle.svg` | `cancel` | `cancel.svg` | （本次退役删除） | ✅ 已替换 |
| 98 | 改名替换 | `infinity-accent.svg` | `all_inclusive` | `all-inclusive-accent.svg` | （本次退役删除） | ✅ 已替换 |
| 99 | 改名替换 | `stethoscope-primary.svg` | `monitor_heart` | `monitor-heart-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 100 | 改名替换 | `stethoscope-primary-dark.svg` | `monitor_heart` | `monitor-heart-primary-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 101 | 改名替换 | `stethoscope-faint.svg` | `monitor_heart` | `monitor-heart-faint.svg` | （本次退役删除） | ✅ 已替换 |
| 102 | 改名替换 | `stethoscope-faint-dark.svg` | `monitor_heart` | `monitor-heart-faint-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 103 | 改名替换 | `loader-primary.svg` | `autorenew` | `autorenew-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 104 | 改名替换 | `layout-grid-gray.svg` | `grid_view` | `grid-view-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 105 | 改名替换 | `layout-grid-ink.svg` | `grid_view` | `grid-view-ink.svg` | （本次退役删除） | ✅ 已替换 |
| 106 | 改名替换 | `layout-grid-ink100.svg` | `grid_view` | `grid-view-ink100.svg` | （本次退役删除） | ✅ 已替换 |
| 107 | 改名替换 | `book-a-warning.svg` | `warning` | `warning.svg` | （本次退役删除） | ✅ 已替换 |
| 108 | 改名替换 | `book-a-warning-dark.svg` | `warning` | `warning-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 109 | 改名替换 | `tag-info.svg` | `label` | `label-info.svg` | （本次退役删除） | ✅ 已替换 |
| 110 | 改名替换 | `tag-info-dark.svg` | `label` | `label-info-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 111 | 改名替换 | `filter-gray.svg` | `filter_list` | `filter-list-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 112 | 改名替换 | `radio-gray.svg` | `podcasts` | `podcasts-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 113 | 改名替换 | `mic-disabled.svg` | `mic_off` | `mic-off.svg` | （本次退役删除） | ✅ 已替换 |
| 114 | 改名替换 | `edit-2-gray.svg` | `edit` | `edit-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 115 | 改名替换 | `trash-2-gray.svg` | `delete` | `delete-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 116 | 改名替换 | `tag-primary.svg` | `label` | `label-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 117 | 改名替换 | `plus-gray.svg` | `add` | `add-gray.svg` | （本次退役删除） | ✅ 已替换 |
| 118 | 改名替换 | `plus-primary.svg` | `add` | `add-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 119 | 改名替换 | `plus-dark.svg` | `add` | `add-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 120 | 改名替换 | `minus-primary.svg` | `remove` | `remove-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 121 | 改名替换 | `minus-dark.svg` | `remove` | `remove-dark.svg` | （本次退役删除） | ✅ 已替换 |
| 122 | 改名替换 | `speaker-wave-gray.svg` | `volume_up` | `volume-up-osv.svg` | （本次退役删除） | ✅ 已替换 |
| 123 | 改名替换 | `headphones.svg` | `headset` | `headset.svg` | （本次退役删除） | ✅ 已替换 |
| 124 | 改名替换 | `podcast-primary.svg` | `podcasts` | `podcasts-primary.svg` | （本次退役删除） | ✅ 已替换 |
| 125 | 重定向 | `speaker-wave-primary.svg` | `→ volume-up-primary.svg` | `-` | （本次退役删除） | ✅ 已替换 |
| 126 | PNG 重绘 | `-` | `home` | `home.png` | （本次退役删除） | ✅ 已替换 |
| 127 | PNG 重绘 | `-` | `home` | `home-active.png` | （本次退役删除） | ✅ 已替换 |
| 128 | PNG 重绘 | `-` | `explore` | `explore.png` | （本次退役删除） | ✅ 已替换 |
| 129 | PNG 重绘 | `-` | `explore` | `explore-active.png` | （本次退役删除） | ✅ 已替换 |
| 130 | PNG 重绘 | `-` | `menu_book` | `menu-book.png` | （本次退役删除） | ✅ 已替换 |
| 131 | PNG 重绘 | `-` | `menu_book` | `menu-book-active.png` | （本次退役删除） | ✅ 已替换 |
| 132 | PNG 重绘 | `-` | `school` | `school.png` | （本次退役删除） | ✅ 已替换 |
| 133 | PNG 重绘 | `-` | `history` | `history.png` | （本次退役删除） | ✅ 已替换 |
| 134 | PNG 重绘 | `-` | `bookmark` | `bookmark.png` | （本次退役删除） | ✅ 已替换 |
| 135 | PNG 重绘 | `-` | `credit_card` | `credit-card.png` | （本次退役删除） | ✅ 已替换 |
| 136 | PNG 重绘 | `-` | `person` | `person.png` | （本次退役删除） | ✅ 已替换 |

### T4.5 批次（2026-09-27，闯关页 + 排行榜页，+7；同日 Web 口径恢复批 +3）

| 文件 | Material 名 | 色值 | 用途 | 状态 |
|------|------------|------|------|------|
| `arrow-back-ink.svg` | `arrow_back` | #1c1917（onSurface 浅） | 两页自定义导航返回钮 24dp | ✅ gstatic 拉取官方 path |
| `arrow-back-dark.svg` | `arrow_back` | #e8e3d9（onSurface 深） | 同上深色态 | ✅ 同字形换色 |
| `check-circle-primary-dark.svg` | `check_circle` | #4da989（primary 深） | 闯关顶栏「已达标」徽章 15dp | ✅ 本地缓存源 |
| `keyboard-arrow-right-white.svg` | `keyboard_arrow_right` | #ffffff（onPrimary） | 底部实底按钮右箭头 | ✅ 本地缓存源 |
| `emoji-events-gold.svg` | `emoji_events` | #EAB308（RankGold） | 达人榜 #1 皇冠 22dp | ✅ 存量字形换色 |
| `military-tech-silver.svg` | `military_tech` | #9CA3AF（RankSilver） | 达人榜 #2 银牌 22dp | ✅ 存量字形换色 |
| `military-tech-bronze.svg` | `military_tech` | #D97706（RankBronze） | 达人榜 #3 铜牌 22dp | ✅ 存量字形换色 |
| `workspace-premium-amber.svg` | `workspace_premium` | #D97706（amber-600） | 闯关配额胶囊预警皇冠 13dp | ✅ gstatic 拉取官方 path |
| `workspace-premium-amber-dark.svg` | `workspace_premium` | #FBBF24（amber-400） | 同上深色态 | ✅ 同字形换色 |
| `workspace-premium-white.svg` | `workspace_premium` | #ffffff | 「下一关 · 解锁 PRO」末钮 16dp | ✅ 同字形换色 |

> 烘焙脚本 `scripts/tmp-material-bake-t45.py`（版本回退 fetch + 本地缓存 + 全幅矩形
> 过滤 + 存量字形换色；金银铜色值 = Android `RankGold/RankSilver/RankBronze` 原值）。
>
> **白图教训（2026-09-27 真机走查）**：`military_tech` 存量源是 `viewBox="0 -960 960 960"`
> 网格的 Material Symbols 字形，换色烘焙时若沿用 `0 0 24 24` viewBox，路径坐标（480、
> -174、960…）整体落出视口，#2/#3 奖牌渲染成空白——**换色烘焙必须连同源 viewBox
> 一起复用**（规范第七节第 2 条「保留源 viewBox」的实例教训）；test-leaderboard.js
> 已加 viewBox 网格回归断言锁死。

### 学习路径批次（2026-09-28，pages/library/paths 列表 + 详情页，+12）

| 文件 | Material 名 | 色值 | 用途 | 状态 |
|------|------------|------|------|------|
| `auto-awesome-white.svg` | `auto_awesome` v7 | #ffffff | AI 生成按钮（会员紫渐变态）/ 生成弹窗标题与提交钮 | ✅ gstatic 拉取官方 path |
| `auto-awesome-amber.svg` | `auto_awesome` v7 | #d97706（amber-600） | AI 生成按钮免费态（· PRO 琥珀变体，Web 口径） | ✅ 同字形换色 |
| `public-white.svg` | `public` | #ffffff | 卡片 PUBLIC 角标 / 详情页公开胶囊 / 发现空态 | ✅ gstatic 拉取官方 path |
| `map-white.svg` | `map` | #ffffff | 详情页头部右上 Map 水印（CSS opacity 0.1） | ✅ 同上 |
| `playlist-add-onsurface.svg` | `playlist_add` | #655d4c（text-secondary 浅） | 添加剧集 chip / 空路径引导图 | ✅ 同上 |
| `playlist-add-onsurface-dark.svg` | `playlist_add` | #a8a29e（text-secondary 深） | 同上深色态 | ✅ 同字形换色 |
| `more-horiz-onsurface.svg` | `more_horiz` | #655d4c | 操作栏「更多」下拉菜单钮 | ✅ gstatic 拉取官方 path |
| `more-horiz-onsurface-dark.svg` | `more_horiz` | #a8a29e | 同上深色态 | ✅ 同字形换色 |
| `play-circle-white.svg` | `play_circle` | #ffffff | 操作栏「播放全部」主按钮 20dp | ✅ gstatic 拉取官方 path |
| `add-white.svg` | `add` | #ffffff | 「+ 创建新路径」按钮 / 空态 CTA | ✅ 同上 |
| `shuffle-onsurface.svg` | `shuffle` | #655d4c | 操作栏「随机播放」图标钮（Web base-content/60 灰口径） | ✅ 同上 |
| `shuffle-onsurface-dark.svg` | `shuffle` | #a8a29e | 同上深色态 | ✅ 同字形换色 |

> 烘焙脚本 `scripts/tmp-bake-path-icons.py`（直连 + Clash 7891 兜底双通道）。
>
> **矩形过滤坑补遗（2026-09-28）**：materialicons 新版源文件的全幅 bounding 底实为
> `M0 0h24v24H0z`——去空白小写归一化后是 `m00h24v24h0z`（**H0z 收笔，两个 0**），
> 与第七节示例里的 `H0V0z` / `H-24z` 写法都不同，按示例字面量匹配会漏滤、图标渲染
> 成实心方块；过滤必须以归一化后的精确串比对（`m00h24v24h0z` / `m00h24v24h-24z` /
> `m00h24v24h0v0z` + `h0v0z` 后缀兜底）。

## 五、已是 Material（历史批次已换装，本次核验存量）

| 文件 | 说明 |
|------|------|
| `alarm.svg` | 已是 Material（历史批次） |
| `bookmark-filled-accent.svg` | 已是 Material（历史批次） |
| `bookmark-filled-primary.svg` | 已是 Material（历史批次） |
| `check-circle-success-m.svg` | 已是 Material（历史批次） |
| `check-circle-success-m3.svg` | 已是 Material（历史批次） |
| `check-circle-white.svg` | 已是 Material（历史批次） |
| `close-light.svg` | 已是 Material（历史批次） |
| `close.svg` | 已是 Material（历史批次） |
| `computer.svg` | 已是 Material（历史批次） |
| `date-range-ink-dark.svg` | 新增（收听历史页日期分组头，#a8a29e 深色 ink-500） |
| `date-range-ink.svg` | 新增（收听历史页日期分组头，#857c68 浅色 ink-500） |
| `delete-error.svg` | 已是 Material（历史批次） |
| `description-secondary.svg` | 已是 Material（历史批次） |
| `emoji-events-secondary.svg` | 已是 Material（历史批次） |
| `emoji-events-success-filled.svg` | 已是 Material（历史批次） |
| `emoji-events-success.svg` | 已是 Material（历史批次） |
| `graphic-eq-dark.svg` | 已是 Material（历史批次） |
| `graphic-eq-primary.svg` | 已是 Material（历史批次） |
| `graphic-eq-white.svg` | 已是 Material（历史批次） |
| `journey-curve.svg` | 保留（装饰/自绘） |
| `journey-flag.svg` | 已是 Material（历史批次） |
| `keyboard-arrow-down-osv50-dark.svg` | 已是 Material（历史批次） |
| `keyboard-arrow-down-osv50.svg` | 已是 Material（历史批次） |
| `keyboard-arrow-right-tertiary-dark.svg` | 已是 Material（历史批次） |
| `keyboard-arrow-right-tertiary.svg` | 已是 Material（历史批次） |
| `lightbulb-accent.svg` | 已是 Material（历史批次） |
| `lock-primary-dark.svg` | 已是 Material（历史批次） |
| `lock-primary.svg` | 已是 Material（历史批次） |
| `manage-search.svg` | 已是 Material（历史批次） |
| `menu-book-onsurface-dark.svg` | 已是 Material（历史批次） |
| `menu-book-onsurface.svg` | 已是 Material（历史批次） |
| `mic-filled.svg` | 已是 Material（历史批次） |
| `mic-tertiary-dark.svg` | 已是 Material（历史批次） |
| `mic-tertiary.svg` | 已是 Material（历史批次） |
| `military-tech-info.svg` | 已是 Material（历史批次） |
| `military-tech-primary500.svg` | 已是 Material（历史批次） |
| `pause-filled.svg` | 已是 Material（历史批次） |
| `play-circle-banner.svg` | 已是 Material（历史批次） |
| `play-circle-primary-m-dark.svg` | 已是 Material（历史批次） |
| `play-circle-primary-m.svg` | 已是 Material（历史批次） |
| `play-filled-gray.svg` | 已是 Material（历史批次） |
| `play-filled-graydark.svg` | 已是 Material（历史批次） |
| `play-filled-ink.svg` | 已是 Material（历史批次） |
| `play-filled-primary.svg` | 已是 Material（历史批次） |
| `play-filled-primarydark.svg` | 已是 Material（历史批次） |
| `play-filled.svg` | 已是 Material（历史批次） |
| `psychology-banner.svg` | 已是 Material（历史批次） |
| `psychology-dark.svg` | 已是 Material（历史批次） |
| `psychology-primary.svg` | 已是 Material（历史批次） |
| `psychology-primary300.svg` | 已是 Material（历史批次） |
| `queue-music.svg` | 已是 Material（历史批次） |
| `refresh-onsurface-dark.svg` | 已是 Material（历史批次） |
| `refresh-onsurface.svg` | 已是 Material（历史批次） |
| `repeat-active-dark.svg` | 已是 Material（历史批次） |
| `repeat-active.svg` | 已是 Material（历史批次） |
| `repeat-one-active.svg` | 已是 Material（历史批次） |
| `repeat-white.svg` | 已是 Material（历史批次） |
| `repeat.svg` | 已是 Material（历史批次） |
| `schedule-accent-filled.svg` | 已是 Material（历史批次） |
| `search-off.svg` | 已是 Material（历史批次） |
| `search.svg` | 已是 Material（历史批次） |
| `shuffle-active.svg` | 已是 Material（历史批次） |
| `skip-next.svg` | 已是 Material（历史批次） |
| `skip-previous.svg` | 已是 Material（历史批次） |
| `speed-faint-dark.svg` | 已是 Material（历史批次） |
| `speed-faint.svg` | 已是 Material（历史批次） |
| `speed-secondary.svg` | 已是 Material（历史批次） |
| `stop-white.svg` | 已是 Material（历史批次） |
| `track-changes-error.svg` | 已是 Material（历史批次） |
| `track-changes-faint-dark.svg` | 已是 Material（历史批次） |
| `track-changes-faint.svg` | 已是 Material（历史批次） |
| `track-changes-primary-dark.svg` | 已是 Material（历史批次） |
| `track-changes-primary.svg` | 已是 Material（历史批次） |
| `volume-up-accent.svg` | 已是 Material（历史批次） |
| `volume-up-dark.svg` | 已是 Material（历史批次） |
| `volume-up-primary-m-dark.svg` | 已是 Material（历史批次） |
| `volume-up-primary-m.svg` | 已是 Material（历史批次） |
| `volume-up-primary.svg` | 已是 Material（历史批次） |
| `volume-up-primary70-dark.svg` | 已是 Material（历史批次） |
| `volume-up-primary70.svg` | 已是 Material（历史批次） |
| `volume-up-secondary.svg` | 已是 Material（历史批次） |
| `volume-up-white.svg` | 已是 Material（历史批次） |

## 六、保留项（非 Material、有明确理由）

| 文件 | 理由 |
|------|------|
| `journey-curve.svg` | 首页「学习之旅」蜿蜒虚线**装饰背景**，非操作图标（stroke 风格为虚线笔触所需） |

## 七、Material 图标烘焙规范（以后新图标照此执行）

1. **来源**：`https://fonts.gstatic.com/s/i/materialicons/{name}/v{1..12}/24px.svg`
   （Google 官方 materialicons 24px；老名字 v1 即有，2020 后新增图标需版本回退，
   如 `podcasts`/`download` v5、`monitor_heart` v2、`auto_awesome` v7）。
2. **SVG**：保留源 `viewBox`，重emit 为 `<path fill="指定色" d="...">`；
   **必须过滤全幅矩形路径**（新版源文件首/尾 path `M0 0h24v24H0z` / `H0V0z` 是 bounding 底，非字形，
   漏滤会渲染成实心方块）。色值沿用槽位既有语义色（primary #1f7a5c / accent #d98a17 / ink 系 / white 等），
   文件名 = Material 名（下划线转连字符）+ 既有色后缀。
3. **PNG**（tabBar/宫格等原生 image 位）：自研栅格化器
   `scripts/tmp-material-bake.py::raster_png`——SVG path 解析（含贝塞尔/弧线展平）→
   even-odd 扫描线填充（镂空正确）→ 8× 超采样 + LANCZOS 缩小（抗锯齿）→ 指定色着色。
   tabBar 81×81（未激活 #a79e8a / 激活 #1f7a5c），我的页宫格 64×64。
4. **命名**：与 Android `Icons.Filled.X` 一一对应（`keyboard_arrow_right` → `keyboard-arrow-right-*`）；
   深色变体沿用 `-dark` 后缀约定。
5. **验收**：替换后 `npm test` 全绿 + 更新本清单对应行。

---

## 八、个人中心模块批（2026-09-29，PROFILE-TASK T0.4，+38）

> 复刻源：yuanlu-android `feature/profile/`（PersonalCenterScreen / EditProfileDialog /
> BindAccountSheets）。色值 = `theme/Color.kt` 原值；烘焙驱动
> `scripts/tmp-profile-bake-icons.py`（取源逻辑同第七节，直连失败自动回退 Clash 7891）。
> 本批新增两个色角色后缀：**`-variant(-dark)` = onSurfaceVariant（#57534e / #a8a29e）**、
> **`-onsurface(-dark)` = onSurface（#1c1917 / #e8e3d9）**；其余沿用既有语义后缀
> （`-primary(-dark)` #1f7a5c/#4da989、`-accent` #d98a17〔schedule-accent 先例，深浅同值〕、
> `-tertiary(-dark)` #4a7fa5/#7fa8c8〔mic-tertiary 先例〕、`-error` #d2503f 深浅同值、`-white`）。
> ⚠️ 注意：`keyboard-arrow-right-tertiary(-dark)` 历史批为 #a79e8a 暖灰（行尾箭头槽位），
> 与本批 `-tertiary`=#4a7fa5 含义不同，引用时勿混淆。

| 区块 | Material 图标 | 文件（色） | 备注 |
|------|--------------|-----------|------|
| 用户信息卡·等级徽章/累计里程 | `Hiking` | hiking-primary(-dark).svg / hiking-accent.svg | 徽章=secondary 橙（L408 tint），里程卡=primary |
| 用户信息卡·加入日期 | `CalendarMonth` | calendar-month-variant(-dark).svg | |
| 用户信息卡·国家 | `Place` | place-variant(-dark).svg | |
| 头像占位（主页 40%/编辑 35% 透明度） | `Person` | person-variant(-dark).svg | CSS opacity 调透 |
| 旅程·连续天数/目标横幅 | `LocalFireDepartment` | local-fire-department-accent.svg | #d98a17；闯关卡 -orange(#f97316) 历史批**不动** |
| 旅程·词汇路标 | `Bookmark` | bookmark-tertiary(-dark).svg | |
| 安全·手机号 | `Smartphone` | smartphone-primary(-dark).svg | |
| 安全·邮箱 | `Email` | email-accent.svg | |
| 安全·登录密码 | `Lock` | lock-tertiary(-dark).svg | |
| 安全·注销 | `PersonRemove` | person-remove-error.svg | error 深浅同值，单变体 |
| 安全·已验证对勾 | `CheckCircle` | check-circle-primary.svg | 补浅色款；-primary-dark 既有 |
| 安全·未绑定警示 | `Warning` | warning.svg（复用） | Android secondary 深浅同值，深色模式沿用同文件 |
| 绑定弹层 leading | `PhoneIphone`/`Password`/`Mail`/`Lock` | phone-iphone-variant(-dark) / password-variant(-dark) / mail-variant(-dark) / lock-variant(-dark).svg | OutlinedTextField leading 默认 onSurfaceVariant |
| 密码强度达标对勾 | `Check` | check-primary(-dark).svg | check-white 为保存按钮既有件 |
| 编辑资料·头部/Tab1 | `Person` | person-primary(-dark).svg | |
| 编辑资料·Tab2 | `Tune` | tune-primary(-dark) / tune-variant(-dark).svg | 选中/未选中 |
| 编辑资料·头像角标 | `CameraAlt` | camera-alt-white.svg | |
| 编辑资料·关闭 | `Close` | close-onsurface(-dark).svg | 区别于 premium-modal 的 close.svg(#a79e8a) |

> 新增缓存源 11 个：hiking / calendar_month / smartphone / email / person_remove /
> place / camera_alt / tune / mail / phone_iphone / password（均 v1 命中，全幅矩形过滤通过）。

## 学习报表模块（2026-09-30 · Web 严格源，图标取 Material 对应物）

> 学习报表 Web 端独有（yuanlu-android 无对应实现），复刻源 =
> yuanlu `LearningReportView.tsx`（lucide BarChart3/CalendarCheck/Flame/BookMarked）。
> Material 对应：`BarChart`（三柱）/`EventAvailable`（带勾日历）/`LocalFireDepartment`/`Bookmark`。
> 四宫格图标统一 primary 绿（Web 源码 label 行灰 40%，按用户提供的截图四绿观感取绿——偏离记录在案）。
> 新增缓存源 1 个：event_available（v1 命中，全幅矩形过滤通过）。

| 区块 | Material 图标 | 文件（色） | 备注 |
|------|--------------|-----------|------|
| 报表页头 + 入口卡 + 四宫格「近 7 天时长」 | `BarChart` | bar-chart-primary(-dark).svg | |
| 四宫格「目标达成」 | `EventAvailable` | event-available-primary(-dark).svg | |
| 四宫格「连续打卡」 | `LocalFireDepartment` | local-fire-department-primary(-dark).svg | 绿款；accent 橙款既有 |
| 四宫格「新收生词」 | `Bookmark` | bookmark-primary(-dark).svg | 绿款；tertiary 蓝款既有 |

## 九、我的页分组列表重构批（2026-10-01，+11/−6）

> 复刻源 = yuanlu-android `feature/profile/ProfileScreen.kt` MenuCard/MenuRow：
> 全卡 r24dp=48rpx、卡内 labelMedium 区块标题、34dp 圆角方形（r10dp）tint 12% 图标底 +
> 19dp 着色图标、bodyLarge 标题、外观设置尾值（跟随系统/浅色/深色）、onSurfaceVariant 40% 行尾箭头。
> weapp 结构按需求裁剪：「学习与记录」不含发音弱项本、第二卡（Android 原题「账户与系统设置」，
> weapp 改题「**订阅与系统设置**」）不含个人中心项（个人资料仍走头部用户卡点击），
> 另插学习成果 1×4 数据看板（无图标，纯数值）；**项间无分隔线**（MenuRow 源码本无 divider，
> 初版按需求加细线，后按用户指令取消回归源码口径）。
> 烘焙驱动 `scripts/tmp-mine-bake-icons.py`（取源逻辑同第七节，直连失败回退 Clash 7891）。

| 菜单项 | Material 图标 | 文件（色） | 备注 |
|--------|--------------|-----------|------|
| 学习路径 | `School` | school-primary(-dark).svg | #1f7a5c/#4da989 |
| 收听历史 | `History` | history-accent.svg | #d98a17 深浅同值 |
| 我的收藏 | `Bookmark` | bookmark-accent-deep.svg | **新后缀 `-accent-deep`=#b96f0f**（Android Color(0xFFB96F0F) 字面值；区别于 amber #f59e0b/#D97706 系），深浅同值 |
| 我的订阅 | `CreditCard` | credit-card-accent.svg | #d98a17 |
| 外观设置 | `Contrast` | contrast-tertiary(-dark).svg | #4a7fa5/#7fa8c8 |
| 消息通知 | `Notifications` | notifications-primary(-dark).svg | #1f7a5c/#4da989；通知页空态仍用 notifications-ink.svg |
| 帮助与支持 | `HelpOutline` | help-outline-tertiary(-dark).svg | #4a7fa5/#7fa8c8 |
| 控制台 | `Computer` | computer-error.svg（复用） | #d2503f |

> 新增缓存源 2 个：contrast / notifications（school/history/bookmark/credit_card/help_outline
> 缓存既有）；全部 v1 命中，全幅矩形过滤通过。
> 退役 6 个：school.png / history.png / bookmark.png / credit-card.png（旧宫格）+
> contrast-ink.svg / help-outline-ink.svg（旧系统列表）。

## 十、下载模块批（2026-10-01，DOWNLOAD-TASK T3.3，+1）

> 音频离线缓存「已下载」态图标。gstatic 直连/Clash 代理均失败，字形路径取
> MUI DownloadDone（material-icons 官方 React 版，与 Google 源同字形）双源交叉确认；
> 下划线 + 对勾几何自检通过；无全幅矩形路径（老式绝对坐标字形，同 download.svg 家族）。

| 用途 | Material 图标 | 文件（色） | 备注 |
|------|--------------|-----------|------|
| 剧集页音频按钮「已下载」态 | `download_done` | download-done.svg | #64748b（与 download.svg text-secondary 同色，深浅同值） |
| 剧集页音频按钮「已下载」态 | `download_done` | download-done.svg | #64748b（与 download.svg text-secondary 同色，深浅同值） |
| 我的页「离线缓存」行（T3.5） | `download`（复用已烘焙字形） | download-primary(-dark).svg | #1f7a5c/#4da989（本地重着色，非新烘焙） |
