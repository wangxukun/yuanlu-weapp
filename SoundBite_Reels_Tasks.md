# SoundBite Reels（原声微流）任务清单

> 对照规范：[原声微流.md](./原声微流.md)
> 审查范围：`pages/discover/{index.js, index.wxml, index.wxss, reels-api.js}`，关联 `components/sentence-tag-drawer`、`components/vocabulary-modal`、`components/voice/eval-card`、`utils/clip-player`、`utils/recorder`、后端 `core/corpus/reels-feed.service.ts`
> 生成日期：2026-11-18

## 已确认决策

| 决策点 | 结论 |
|---|---|
| F2 跟读 | **接真实录音评测**（`utils/recorder` + `POST /api/speech/evaluate`） |
| F5 回 Tab | **自动续播**（从离开时的相对位置续播） |
| F1 沙箱语料标签/笔记 | **仅存本地 storage**（不调 `/api/sentences/meta`） |

---

## P0 · Bug（影响正确性）

- [x] **B1 扫光词间隙闪回**
  - 位置：`index.js` `_onTick`
  - 现象：词与词间隙 `activeWordIndex = -1`，所有已读绿词瞬间回落原色，播放中持续闪烁。
  - 方案：间隙保持“最后一个已开始的词”索引（或拆分 `pastIndex` / `curIndex`）；`isPast` 用 pastIndex 判定，`isCurrent` 仅在词窗内点亮。

- [x] **B2 评测定时器跨切片泄漏**
  - 位置：`index.js` `_applyClip`
  - 现象：评测中滑走，`isEvaluating` 被重置但定时器未清，评分会弹到新切片上。
  - 方案：切片切换时 `clearTimeout(this._evalTimer)` 并取消在途录音/评测请求；结果回写前校验切片令牌。

- [x] **B3 收藏态被旧缓存覆盖**
  - 位置：`index.js` `_toggleRealSentence` / `_applySavedKeys`
  - 现象：toggle 后 `_savedKeysByEp` 未同步，滑走再滑回同集切片时书签态被旧缓存回滚。
  - 方案：toggle 成功后同步更新 `_savedKeysByEp[episodeid]`，或合并为单一缓存源。

- [x] **B4 本地兜底语料丢失发音贴士**
  - 位置：`reels-api.js` `fromLocalClip`
  - 方案：补映射 `phoneticTip: c.phoneticTip || ''`。

- [x] **B5 无词级时间戳时点词查整句**
  - 位置：`index.wxml` 英文原句 `wx:else` 分支
  - 方案：前端按空格切分 `textEn` 生成 tokens 渲染（无扫光、可点词），`onWordTap` 兼容 token 来源。

- [x] **B6 深度透视竞态**
  - 位置：`index.js` `onDeepDive`
  - 方案：增加请求令牌，过期响应丢弃；可选按句子文本缓存分析结果。

---

## P1 · 功能缺失 / 不完整

- [x] **F1 收藏后自动弹出「完善句子笔记与标签」抽屉**（规范 ⑦）
  - 在 `index.json` 注册 `sentence-tag-drawer`。
  - 真实切片：`/api/sentences/toggle` 返回 `saved=true` 时，用 `body.data.sentence` 设置 `drawerSentence` 唤起抽屉；`bind:updated` 回写本地书签记录，`bind:close` 置空。
  - 沙箱语料：标签与笔记**仅存本地 storage**（`reels_saved_sentences` 记录追加 `tags` / `note`）；需为抽屉增加本地模式（如 `local` 属性或 `save` 事件交给宿主处理），本地模式不调 `/api/sentences/meta`。
  - 取消收藏时不弹抽屉。

- [x] **F2 真实跟读录音测评**（规范 ⑧）
  - 复用 `utils/recorder`（权限 / 音频互斥）与 `POST /api/speech/evaluate`（与 `eval-card` 同一契约：`episodeId, subtitleId, targetText` 等）。
  - 交互：点麦克风开始录音（暂停原声循环，按钮珊瑚红脉冲）→ 再点或超时自动停止 → 评测中状态 → 字幕下方渐显翡翠绿评分横幅（真实总分 + 流利度/连读等分项点评）→ 恢复原声循环。
  - **逐词发音得分与句末回放按钮**：评测完成后在每个英语单词后以更小字号展示单词发音得分并按分数段分层着色（`≥85` 翡翠绿 `good`、`60~84` 琥珀橙 `mid`、`<60` 珊瑚红 `bad`）；在英语句末渲染「回放我的发音」圆形喇叭图标按钮（点击暂停原声循环并回放本次录音，播完自动恢复原声循环；录音仅存页面内存，不持久化保存）。
  - 录音过短、无麦克风权限、网络错误：toast 提示并复位。
  - 未登录：登录引导；配额耗尽：`premium-modal` 配额墙；评测后刷新 `/api/speech/quota`。
  - 沙箱语料（无 `subtitleId`）：提示“该切片暂不支持评测”或按 `targetText` 评测（以后端契约为准）。
  - 切片切换 / 页面隐藏时取消录音与在途评测（与 B2 合并处理）。

- [ ] **F3 词典弹窗注入原声语境例句**（规范 ⑤）
  - 将当前切片 `textEn / textCn` 组装为 `corpusExamples: [{ clipid, zh, parts: [{ t, hl }] }]`（命中词 `hl=true`）传入 `vocabulary-modal`。

- [ ] **F4 发音机密贴士常驻**（规范 ④ / 第 2 步）
  - 后端 `phoneticTip` 为 null 时前端生成通用兜底文案（如基于 wpm / 句中连读候选）。
  - 胶囊增加「🔊 发音机密」标题，还原琥珀胶囊样式。

- [ ] **F5 回到 Tab 自动续播**（规范 ② 进入即播）
  - `onHide` 记录 `_resumeOnShow = playing` 与相对位置；`onShow` 若 `_resumeOnShow` 为真则 `_startPlayback(this._relPos)`。
  - 弹窗打开（词典 / 深度透视 / 标签抽屉）或录音中时不自动续播。

---

## P2 · UI 还原与体验

- [ ] **U1 背景模糊参数对齐规范**：blur 约 64px（≈128rpx），opacity 浅色 0.25 / 深色 0.35，遮罩浅色 75% / 深色 70%，深浅双轨分别设置。
- [ ] **U2 背景切换过渡**：封面双层交替 + opacity transition，避免硬切。
- [ ] **U3 倍速文案**：`1x` → `1.0x`（0.75x / 1.0x / 1.25x）。
- [ ] **U4 评测 UI 细节**：录音中按钮外圈扩散光环；评分横幅增加“流利度 / 连读”分项小标签。
- [ ] **U5 扫光渲染性能**：`activeWordIndex` 变化导致最多 48 个 swiper-item 词节点重算；改为仅当前项路径补丁（如 `reels[i].activeIdx`）或 WXS 收敛。

---

## P3 · 真机验证

- [ ] **V1 循环无缝度**：当前循环为 stop→重建实例，UI 已去抖但音频可能有空白；真机评估，必要时改为同实例 seek。
- [ ] **V2 变速不变调**：iOS / Android InnerAudioContext `playbackRate` 音高保持情况。
- [ ] **V3 跟读链路**（F2 完成后）：麦克风权限、录音与播放互斥、评测接口与配额。
- [ ] **V4 回 Tab 续播**（F5 完成后）：与其他页面音频互斥总线的交互。

---

## 已达标（无需改动）

单句循环开关、0.75 / 1 / 1.25 取模切换、当前词琥珀高亮与已读词变绿、标点清洗、生词收藏与配额墙、深度透视四维卡片与兜底文案、顶部呼吸信标 / 序号 / 日月切换、上下条切换清空评分横幅。全局迷你播放器隐藏：小程序无全局迷你播放条，不适用。
