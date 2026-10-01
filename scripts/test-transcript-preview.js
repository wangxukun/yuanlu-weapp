/**
 * scripts/test-transcript-preview.js — 非会员文稿预览弹层单测（Node 环境，mock wx + Component）
 *
 * 验证目标（DOWNLOAD-TASK T1.4，复刻源 yuanlu TranscriptPreviewModal.tsx；
 * 拦截卡 2026-10-01 改版 = premium-modal episode_audio_download 场景卡）：
 *   A. preview 数据映射：podcastTitle/episodeTitle/coverUrl/subtitles/页数公式
 *   B. 兜底链：preview 为 null 时回退 episode 字段（Web ?: 链逐级对齐）
 *   C. 页数公式：max(1, 1 + ceil(max(0, total - 8) / 12))
 *   D. 说话人标记剥离：[SPEAKER_n]: 前缀清除（与 Web replace 同式）
 *   E. 事件：close 透传；CTA 内置（关弹层 + 占位 toast，不再由页面二次弹会员窗）
 *   F. WXML/WXSS 静态：与 Web 逐字文案关键串 + pm-* 场景卡结构与 @import 单源
 *   G. 拦截卡数据：episode_audio_download 场景基线的文稿专属裁剪（标题/去描述/权益仅文稿行），
 *      priceAnchor/cta 仍单源跟随场景，premium-modal 弹窗本体不受影响
 *   H. 触墙埋点红线：打开瞬间 PREMIUM_MODAL_OPEN(episode_audio_download)，同开不重报、关复位可再报
 *
 * 运行：node scripts/test-transcript-preview.js
 */

const fs = require('fs');
const path = require('path');

const toasts = [];
const trackRequests = [];

global.wx = {
  getStorageSync() {
    return '';
  },
  setStorageSync() {},
  getAccountInfoSync() {
    return { miniProgram: { envVersion: 'develop' } };
  },
  showToast(o) {
    toasts.push(o.title);
  },
  request(opts) {
    trackRequests.push(opts);
    opts.success && opts.success({ statusCode: 204 });
  },
};

let componentDef = null;
global.Component = (cfg) => {
  componentDef = cfg;
};

require('../components/transcript-preview');
// 注：transcript-preview 顶部 require premium-modal（取 getScenario 单源），
// 其 Component() 先注册后被覆盖，最终 componentDef 为被测组件本体

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('PASS:', msg);
  } else {
    console.error('FAIL:', msg);
    failed++;
  }
}

function makeInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(componentDef.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    events: [],
    triggerEvent(name) {
      this.events.push(name);
    },
  };
  Object.assign(inst, componentDef.methods);
  return inst;
}
function fire(inst, preview, episode) {
  componentDef.observers['preview, episode'].call(inst, preview, episode);
}
function fireVisible(inst, visible) {
  componentDef.observers.visible.call(inst, visible);
}

// —— A. preview 数据映射 ——
const modal = makeInstance();
fire(modal, {
  podcastTitle: 'Test Podcast',
  episodeTitle: 'Episode One',
  coverUrl: 'https://oss/cover1',
  subtitles: [
    { textEn: 'Hello world.', textCn: '[SPEAKER_1]: 你好，世界。' },
    { textEn: 'Second line.', textCn: '第二行。' },
  ],
  totalSubtitles: 20,
}, null);
assert(modal.data.podcastTitle === 'Test Podcast', 'A podcastTitle 取 preview');
assert(modal.data.episodeTitle === 'Episode One', 'A episodeTitle 取 preview');
assert(modal.data.coverUrl === 'https://oss/cover1', 'A coverUrl 取 preview');
assert(modal.data.subtitles.length === 2, 'A subtitles 透传');
assert(modal.data.subtitles[0].textCn === '你好，世界。', 'D/A 中文说话人标记 [SPEAKER_1]: 剥离');
assert(modal.data.subtitles[1].textCn === '第二行。', 'D/A 无标记原文不动');
assert(modal.data.subtitles[0].textEn === 'Hello world.', 'A 英文原样');
assert(modal.data.pageCount === 2, 'C/A total=20 → 1+ceil(12/12)=2 页');

// —— B. 兜底链（preview null / 缺字段） ——
fire(modal, null, { title: 'Ep Title', coverUrl: 'https://oss/c9', podcastTitle: 'PT', podcast: { title: 'PP' } });
assert(modal.data.podcastTitle === 'PT', 'B preview null → podcastTitle 回退 episode.podcastTitle');
assert(modal.data.episodeTitle === 'Ep Title', 'B episodeTitle 回退 episode.title');
assert(modal.data.coverUrl === 'https://oss/c9', 'B coverUrl 回退 episode.coverUrl');
assert(modal.data.subtitles.length === 0, 'B 无 subtitles → 空数组（WXML 空态）');
assert(modal.data.pageCount === 1, 'C/B total 缺省 → 1 页下限');

fire(modal, null, { title: 'T2', podcast: { title: 'Pod From Nest' } });
assert(modal.data.podcastTitle === 'Pod From Nest', 'B podcastTitle 二级回退 episode.podcast.title');
fire(modal, null, null);
assert(modal.data.podcastTitle === '远路播客', 'B 全缺 → 远路播客兜底（Web 同款）');

// —— C. 页数公式全覆盖 ——
const cases = [
  [8, 1], [9, 2], [20, 2], [21, 3], [100, 9], [0, 1], [undefined, 1],
];
cases.forEach(([total, expect]) => {
  fire(modal, { totalSubtitles: total, subtitles: [] }, null);
  assert(modal.data.pageCount === expect, `C total=${total} → ${expect} 页`);
});

// —— D. 空态数据 ——
fire(modal, { subtitles: [], totalSubtitles: 5 }, null);
assert(modal.data.subtitles.length === 0 && modal.data.pageCount === 1, 'D 空字幕 → 空态（暂无预览数据）');

// —— E. 事件与内置 CTA ——
modal.events.length = 0;
modal.onClose();
assert(modal.events[0] === 'close', 'E close 事件透传');
toasts.length = 0;
modal.onCta();
assert(modal.events[1] === 'close', 'E CTA → 关弹层（close 事件，对齐 premium-modal.onCta）');
assert(toasts[0] === '订阅功能即将上线', 'E CTA → 占位 toast（订阅页落地后同步切真路由）');

// —— G. 拦截卡数据（场景基线的文稿专属裁剪，用户指令 2026-10-01 精减） ——
const itc = modal.data.intercept;
assert(itc.title === '文稿下载是会员专属', 'G 拦截卡标题改为文稿语境');
assert(itc.description === '', 'G 拦截卡描述已去除（空串 + WXML 条件渲染）');
assert(
  Array.isArray(itc.benefits) && itc.benefits.length === 1 && itc.benefits[0] === '文稿 PDF 下载',
  'G 拦截卡权益仅剩「文稿 PDF 下载」一行',
);
assert(
  itc.benefits.indexOf('音频无限下载') === -1 && itc.benefits.indexOf('离线精听') === -1,
  'G 音频无限下载/离线精听两行已去除',
);
const { getScenario } = require('../components/premium-modal/index');
const baseScenario = getScenario('episode_audio_download');
assert(itc.priceAnchor === baseScenario.priceAnchor && itc.priceAnchor === '¥5/7天起 · 低至 ¥0.46/天', 'G 价格锚点仍单源跟随场景');
assert(itc.cta === baseScenario.cta && itc.cta === '解锁下载', 'G CTA 仍单源跟随场景');
// premium-modal 弹窗本体不受裁剪影响（音频按钮触墙仍是完整场景卡）
assert(baseScenario.title === '音频与文稿下载是会员专属' && baseScenario.benefits.length === 3, 'G premium-modal 场景本体不受影响');

// —— H. 触墙埋点红线（打开瞬间上报/同开不重报/关复位可再报） ——
trackRequests.length = 0;
const trkModal = makeInstance();
fireVisible(trkModal, false);
assert(trackRequests.length === 0, 'H 关闭态不埋点');
fireVisible(trkModal, true);
assert(trackRequests.length === 1, 'H 打开瞬间上报一次');
fireVisible(trkModal, true);
assert(trackRequests.length === 1, 'H 同开不重复上报');
fireVisible(trkModal, false);
fireVisible(trkModal, true);
assert(trackRequests.length === 2, 'H 关闭复位后再次打开可再报');
const trk = trackRequests[1];
assert(
  trk.data.eventType === 'PREMIUM_MODAL_OPEN' && trk.data.source === 'episode_audio_download',
  'H 载荷 {eventType: PREMIUM_MODAL_OPEN, source: episode_audio_download}',
);

// —— F. WXML/WXSS 静态（逐字文案 + 场景卡结构 + 样式单源） ——
const wxml = fs.readFileSync(path.join(__dirname, '../components/transcript-preview/index.wxml'), 'utf8');
[
  '文稿预览',
  'AI翻译 仅供参考',
  '暂无预览数据',
  '远路播客    wxkzd.com',
  '共{{pageCount}}页，第 1 页',
  '{{intercept.title}}',
  'wx:if="{{intercept.description}}"',
  'wx:for="{{intercept.benefits}}"',
  '{{intercept.priceAnchor}}',
  '{{intercept.cta}}',
  '暂不开通',
  'pm-icon-circle',
  'pm-benefit-row',
  'pm-cta',
].forEach((frag) => assert(wxml.includes(frag), `F WXML 含 ${frag}`));
const wxss = fs.readFileSync(path.join(__dirname, '../components/transcript-preview/index.wxss'), 'utf8');
assert(wxss.includes('@import "../premium-modal/index.wxss"'), 'F WXSS @import premium-modal（拦截卡样式单源零漂移）');
assert(!wxss.includes('.tp-crown') && !wxss.includes('.tp-int-cta'), 'F 旧版拦截卡样式已退役');

console.log('----------------------------------------');
if (failed === 0) {
  console.log(`ALL TRANSCRIPT-PREVIEW TESTS PASSED (${passed} 断言)`);
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
