/**
 * scripts/test-transcript-preview.js — 非会员文稿预览弹层单测（Node 环境，mock Component）
 *
 * 验证目标（DOWNLOAD-TASK T1.4，复刻源 yuanlu TranscriptPreviewModal.tsx）：
 *   A. preview 数据映射：podcastTitle/episodeTitle/coverUrl/subtitles/页数公式
 *   B. 兜底链：preview 为 null 时回退 episode 字段（Web ?: 链逐级对齐）
 *   C. 页数公式：max(1, 1 + ceil(max(0, total - 8) / 12))
 *   D. 说话人标记剥离：[SPEAKER_n]: 前缀清除（与 Web replace 同式）
 *   E. 事件：close / cta 透传（页面拉起 premium-modal 的接线依据）
 *   F. WXML 静态：与 Web 逐字文案关键串
 *
 * 运行：node scripts/test-transcript-preview.js
 */

const fs = require('fs');
const path = require('path');

global.wx = {}; // 组件不触 wx API，占位防 require 链异常

let componentDef = null;
global.Component = (cfg) => {
  componentDef = cfg;
};

require('../components/transcript-preview');

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

// —— E. 事件透传 ——
modal.events.length = 0;
modal.onClose();
modal.onCta();
assert(modal.events[0] === 'close' && modal.events[1] === 'cta', 'E close/cta 事件透传（页面接线依据）');

// —— F. WXML 静态文案（与 Web 逐字） ——
const wxml = fs.readFileSync(path.join(__dirname, '../components/transcript-preview/index.wxml'), 'utf8');
[
  '文稿预览',
  'AI翻译 仅供参考',
  '暂无预览数据',
  '远路播客    wxkzd.com',
  '共{{pageCount}}页，第 1 页',
  '这里是会员专享内容',
  '为了支持网站长期高质量运转，此内容仅向赞助会员开放。如果您喜欢这里的内容，欢迎加入我们的会员社区，享受专属权益。',
  '去看看赞助方案',
  '暂不需要',
].forEach((frag) => assert(wxml.includes(frag), `F WXML 含 ${frag}`));

console.log('----------------------------------------');
if (failed === 0) {
  console.log(`ALL TRANSCRIPT-PREVIEW TESTS PASSED (${passed} 断言)`);
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
