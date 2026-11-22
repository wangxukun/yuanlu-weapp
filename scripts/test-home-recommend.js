/**
 * test-home-recommend — 原声工坊主页·推荐与身份接线（2026-11-15 迁移配套重写）
 *
 * 静态契约断言：时段推荐双模式应用（今日挑战 tab/自由定制生成）、跨页路由
 * 约定（复习 pendingTab storage、评测/接力去 banned 路由）、登录门禁与
 * request 底座复用。运行时行为由 daily-challenge/reels-session 套件覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

const js = read('pages/home/index.js');
const dashboard = read('pages/home/dashboard.js');
const shadowing = read('pages/home/shadowing.js');

// —— 场景 A：时段推荐应用（onApplyTimeRec） ——
assert(js.includes('onApplyTimeRec'), 'A 时段推荐应用入口');
assert(js.includes("targetMode === 'review'") && js.includes('onMetricVocabulary'), 'A 复习模式→闪卡抽屉');
assert(js.includes("activeTab: 'daily'") && js.includes('isLooping: true'), 'A daily 模式→今日挑战 tab 循环播');
assert(js.includes('this.generate(rec.suggestedPrompt)'), 'A custom 模式→自动生成微场景');
assert(dashboard.includes('recommendations(') && dashboard.includes('suggestedLevel'), 'A 登录态推荐覆写（等级）');

// —— 场景 B：跨页路由约定 ——
assert(js.includes("'review:pendingTab'"), 'B 金句库跳复习走 pendingTab storage（生产约定）');
assert(!js.includes('speech-eval/index?id='), 'B 零已退役 ?id= 整集路由');
assert(!shadowing.includes('speech-eval/index?id='), 'B 发音详情改本卡报告（零 ?id= 路由）');

// —— 场景 C：登录门禁与请求底座 ——
assert(js.includes('_promptLogin') && shadowing.includes('_shadowToken'), 'C 登录门禁工具');
assert(js.includes("require('../../utils/request')"), 'C 复用统一请求底座');
assert(dashboard.includes('/api/user/stats/studio-dashboard'), 'C 仪表卡接口');
assert(dashboard.includes('showError: false'), 'C 静默装载（401 不打扰）');

// —— 场景 D：录音评测链完整性 ——
assert(shadowing.includes('/api/speech/evaluate') && shadowing.includes('/api/speech/quota'), 'D 评测+配额接口');
assert(read('utils/recorder.js').includes('isDevtools'), 'D recorder 带 devtools 兼容分支');
assert(js.includes('_cancelRelayRecording') || shadowing.includes('_cancelShadowing'), 'D 录音取消清理');

// —— 场景 E1：仪表卡入口「切 tab/展开 + 锚点置顶」契约 ——
const wxmlHome = read('pages/home/index.wxml');
assert(js.includes('_scrollAnchorToTop') && js.includes("wx.pageScrollTo"), 'E1 置顶滚动助手存在');
assert(wxmlHome.includes('id="stTabsRow"') && wxmlHome.includes('id="stReviewDeck"'), 'E1 锚点 id（tab 栏/闪卡清单）');
assert(js.split("_scrollAnchorToTop('#stTabsRow')").length - 1 >= 4, 'E1 四入口滚动 tab 栏（今日跟读/思辨特训/跟读冲刺/发起接力）');
assert(js.includes("_scrollAnchorToTop('#stReviewDeck')"), 'E1 展开闪卡清单滚动置顶（积累单词量/到期生词复习）');

// —— 场景 E2：趣味合集连播链契约（T11——连播态不被单棒播放路径清空） ——
assert(js.includes('if (!(opts && opts.compilation)) this._stopCompilation()'), 'E2 连播链内旁路清连播态');
assert(js.split('compilation: true').length - 1 >= 2, 'E2 连播两调用点（起播/棒次推进）携 compilation 标记');
assert(js.includes('_advanceBaton') && js.includes('_armBatonFallback') && !js.includes('_scheduleBaton(room'),
  'E2 连播推进=自然播完事件驱动（_advanceBaton）+时长兜底（_armBatonFallback），固定 5.2s 定时器退役');

// —— 场景 E3：接力第 1 棒草稿三态契约（评测后不立即建房） ——
assert(read('pages/home/index.js').includes('relayDraft') && read('pages/home/index.js').includes('onSubmitRelayDraft') && read('pages/home/index.js').includes('onRetryRelayDraft') && read('pages/home/index.js').includes('onPlayRelayDraft'), 'E3 草稿三态处理器齐（试听/重录/提交）');
assert(read('pages/home/index.js').includes('_relayRoomCreated'), 'E3 建房成功收尾抽公共函数');

// —— 场景 E4：发起人撤销契约（撤销接口+isMine 透传+二次确认） ——
const relayApiSrc = read('pages/home/relay-api.js');
assert(relayApiSrc.includes('cancelRoom') && relayApiSrc.includes('/api/relay/cancel'), 'E4 撤销 API 存在');
assert(relayApiSrc.includes('isMine: !!r.isMine'), 'E4 mapRoom 透传 isMine（映射层铁律）');
assert(read('pages/home/index.js').includes('onCancelRelay') && read('pages/home/index.js').includes('wx.showModal'), 'E4 撤销处理器含二次确认');

// —— 场景 E5：接力分层小窗口契约（T15+T7） ——
const relayApi2 = read('pages/home/relay-api.js');
assert(relayApi2.includes('recruitBatch') && relayApi2.includes('totalRecruiting') && relayApi2.includes('recruitHasMore'), 'E5 分层响应三字段透传（映射层铁律）');
assert(read('pages/home/index.js').includes('onRelaySwapRecruits') && read('pages/home/index.js').includes('relayTotalRecruiting'), 'E5 换一批处理器+全站计数');

// —— 场景 E6：同句仅一接力+接棒草稿三态契约（T16/T17） ——
const js6 = read('pages/home/index.js');
assert(read('pages/home/relay-api.js').includes('starterClipId'), 'E6 starterClipId 映射层透传');
assert(js6.includes('relayInitMap') && js6.includes('已发起过接力'), 'E6 同句拦截（map+提示）');
assert(js6.includes("d.mode === 'join'") && js6.includes('提交交接棒') === false, 'E6 接棒草稿提交分支');
assert(js6.includes('请先处理当前草稿'), 'E6 草稿期间锁发起/接棒入口');

// —— 场景 E7：管理员治理删除契约 ——
assert(read('pages/home/relay-api.js').includes('adminDeleteRoom'), 'E7 管理员删除 API 存在');
assert(read('pages/home/index.js').includes('onDeleteRelayByAdmin') && read('pages/home/index.js').includes('relayIsAdmin'), 'E7 删除处理器+角色门禁');

// —— 场景 E8：起录预备倒计时契约（T8） ——
const js8 = read('pages/home/index.js');
assert(js8.includes('_startRelayPrep') && js8.includes('_relayRecordGo') && js8.includes('_cancelRelayPrep'), 'E8 预备倒计时三件套（起/开麦/取消）');
assert(js8.includes('relayPrepCountdown') && read('pages/home/index.wxml').includes('st-rl-prep'), 'E8 预备浮层数据与节点');

// —— 场景 E：榜「挑战同款」加练契约（课外金句 → 今日挑战第 6+ 句） ——
const lbApi = read('pages/home/leaderboard-api.js');
assert(lbApi.includes('featuredClip: e.featuredClip'), 'E 映射层透传 featuredClip（丢弃即退化为仅播放）');
assert(js.includes('_appendDailyBonus') && js.includes('entry.featuredClip && entry.featuredClip.clipid'),
  'E onLbPractice 加练分支接入');
assert(read('pages/home/daily-challenge.js').includes('isBonus'), 'E 加练句 isBonus 标记');

// 用物理切片时间驱动页面的实际扫光回调。字幕使用整集绝对时间。
async function testWorkshopPlaybackAndPractice() {
  let page;
  global.Page = config => { page = config; };
  global.wx = { getStorageSync: () => '' };
  require('../pages/home/index');
  page.setData = patch => Object.assign(page.data, patch);
  page._player = { playUrl() {} };
  const scene = page._mapScene({ sentences: [100, 101, 102, 103].map(start => ({
    start, end: start + 0.8, words: [
      { word: 'go', start, end: start + 0.2 },
      { word: 'go', start: start + 0.5, end: start + 0.7 },
    ],
  })) });
  page.data.plan = { scenes: [scene], clips: [{ words: scene.sentences[0].words }] };
  page._audioMeta = { offset: 100, winStart: 0, winEnd: 4 };
  page._activeKind = 'scene';
  page.data.sceneActiveIdx = 0;
  page._playWindow(page._audioMeta, 0);
  page._onTick(0.4);
  assert(page.data.sceneActiveSent === 0 && page.data.sceneWordIdx === 0, '整段连播：词间静音保持前词');
  page._onTick(0.9);
  assert(page.data.sceneActiveSent === 0 && page.data.sceneWordIdx === 1, '整段连播：句间静音保持前句末词');
  page._onTick(1.1);
  assert(page.data.sceneActiveSent === 1 && page.data.sceneWordIdx === 0, '整段连播：新句从句内首词开始');
  page.data.sceneSentLoop = 3;
  page._audioMeta = { offset: 100, winStart: 3, winEnd: 3.8 };
  page._playWindow(page._audioMeta, 0);
  page._onTick(3.6);
  page._onTick(3.1);
  assert(page.data.sceneActiveSent === 3 && page.data.sceneWordIdx === 1, '单播第 4 句：延迟回调无法倒退游标');
  const wordClass = wxmlHome.match(/class="st-word {{([^}]+)}}"/)[1];
  const vm = require('node:vm');
  const css = (si, wi) => vm.runInNewContext(wordClass, { ...page.data, playing: true, sci: 0, si, wi });
  assert([0, 1, 2].every(si => !css(si, 0) && !css(si, 1)) && css(3, 0) === 'st-word--past' &&
    css(3, 1) === 'st-word--cur', '第 4 句当前词与已读词只在本句着色');
  page._playWindow(page._audioMeta, 0);
  assert(page.data.sceneActiveSent === 3 && page.data.sceneWordIdx === 0, '单句循环回到所选句首');
  page._activeKind = 'clip';
  page.data.activeIdx = 0;
  page._audioMeta = { offset: 100, winStart: 0, winEnd: 1 };
  page._playWindow(page._audioMeta, 0);
  page._onTick(0.4);
  assert(page.data.activeWordIndex === 0, '精选切片：词间静音保持首词');
  page._onTick(0.8);
  page._onTick(0.3);
  assert(page.data.activeWordIndex === 1, '精选切片：句尾及延迟回调保持末词');
  page._playWindow(page._audioMeta, 0);
  assert(page.data.activeWordIndex === 0, '精选切片循环正常复位');

  page.data.daily = { clips: [{ id: 'daily', words: scene.sentences[0].words }] };
  page._activeKind = 'daily';
  page.data.dailyActiveIdx = 0;
  page._playWindow(page._audioMeta, 0);
  page._onTick(0.4);
  assert(page.data.activeWordIndex === 0, '今日挑战词间停顿保持高亮');
  page._onTick(0.8);
  page._onTick(0.2);
  assert(page.data.activeWordIndex === 1, '今日挑战的延迟回调不会倒退');
  page._playWindow(page._audioMeta, 0);
  assert(page.data.activeWordIndex === 0, '今日挑战循环从首词重新扫光');

  const recorder = require('../utils/recorder');
  recorder.ensurePermission = async () => true;
  recorder.start = () => true;
  recorder.stop = async () => ({ bytes: 32000, base64: 'audio', wavPath: 'test.wav' });
  page._shadowToken = () => 'test';
  page._syncShadowIdentity = page._pausePlayback = page._stopCompilation = page._scrollAnchorToTop = () => {};
  page._loadDashboard = page._igniteStreakBySpeech = () => {};
  page._shadowSeq = 0;
  let target, evaluated;
  page._relayRecordStart = opts => { target = opts; };
  wx.request = opts => {
    if (opts.url.endsWith('/api/speech/evaluate')) evaluated = opts.data;
    opts.success({ statusCode: 200, data: { success: true, data: { score: 90, recognitionId: 7 } } });
  };
  page.data.plan.scenes = [page._mapScene({ sceneid: 'scene-a', episodeid: 'ep', sentences: [
    { start: 100, end: 102, textEn: 'First.', subtitleId: 3, clipid: 'solo' },
    { start: 102, end: 105, textEn: 'Second.', subtitleId: 4 },
  ] })];
  page.data.plan.clips = [{ id: 'solo', episodeid: 'ep', real: true, textEn: 'First.', subtitleId: 3 }];
  for (const [ds, id, subtitleId, text, path] of [
    [{ source: 'scene', sci: 0, idx: 1 }, 'ms:scene-a:s4', 4, 'Second.', 'plan.scenes[0].sentences[1]'],
    [{ source: 'scene', sci: 0, idx: 0 }, 'solo', 3, 'First.', 'plan.scenes[0].sentences[0]'],
    [{ source: 'clip', idx: 0 }, 'solo', 3, 'First.', 'plan.clips[0]'],
  ]) {
    const e = { currentTarget: { dataset: ds } };
    page.onDailyRelayLaunch(e);
    page.onStartCreateRelay();
    assert(page.data.customRelayClip.textEn === text && target.clipId === id && target.subtitleId === subtitleId,
      path + ' 接力预选及领读录音对应所点原句');
    await page.onDailyShadowStart(e);
    assert(page.data.recordingClipId === page._practiceClip(ds).id, path + ' 开始录音');
    await page.onDailyShadowStart(e);
    assert(evaluated.targetText === text && evaluated.subtitleId === subtitleId &&
      page.data[path + '.evalResult'].score === 90, path + ' 按原句提交并回填评分');
  }
  assert(page.data.daily.clips.length === 1 && !page.data.daily.clips[0].evalResult, '自由定制练习独立于每日题目');
}

testWorkshopPlaybackAndPractice().then(() => {
  if (failed) throw new Error(failed + ' 项失败');
  console.log('✓ home-recommend 全部通过');
}).catch(err => { console.error(err); process.exitCode = 1; });
