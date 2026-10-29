/**
 * test-practice-room — 题库式跟读训练室（工具化转型阶段三）
 *
 * 断言：词典例句/语境句两种队列装载、clipId 置顶、命中词高亮、切片直链
 * 预取与词级时间轴 clipOffset 换算、手动翻页（禁自动连播）、完成结算、
 * 评测得分回填。
 */
const path = require('node:path');

const navigations = [];
let dictCalls = 0;
let sceneCalls = 0;
let clipResolved = [];

let dictPayload = {
  success: true,
  data: {
    corpusExamples: [
      { clipid: 'c1', episodeid: 'ep1', subtitleId: 11, enText: 'Compromise on the deadline.', zhText: '在期限上妥协。', duration: 6.4, words: [{ word: 'Compromise', start: 100.2, end: 101.4 }] },
      { clipid: 'c2', episodeid: 'ep1', subtitleId: 12, enText: 'A second compromise line.', zhText: '第二句。', duration: 5.1, words: [] },
      { clipid: 'c3', episodeid: 'ep2', subtitleId: 13, enText: 'Third compromise line.', zhText: null, duration: 4.8, words: [{ word: 'Third', start: 100.2, end: 101.4 }] },
    ],
  },
};
let scenePayload = {
  success: true,
  data: {
    scene: {
      sceneid: 'sX', episodeid: 'ep9', title: '面试语境',
      clips: [
        { clipid: 'k1', subtitleId: 21, textEn: 'Tell me about you.', textCn: '介绍你自己。', start: 10, end: 14, words: [] },
        { clipid: 'k2', subtitleId: 22, textEn: 'Why here?', textCn: '为什么来这里？', start: 15, end: 18, words: [] },
      ],
    },
  },
};
let clipGatewayPayload = {
  success: true,
  data: { url: 'https://oss/clip.mp3?sig', duration: 6.4, clipOffset: 100.0, clipAudioUrl: null },
};

global.wx = {
  getStorageSync: () => '',
  setStorageSync() {},
  removeStorageSync() {},
  showToast() {},
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => navigations.push(o.url),
  getWindowInfo: () => ({ statusBarHeight: 20, pixelRatio: 2 }),
  getMenuButtonBoundingClientRect: () => ({ bottom: 56 }),
  request(opts) {
    const url = opts.url;
    let data = {};
    if (url.includes('/api/dict/')) { dictCalls++; data = dictPayload; }
    else if (url.includes('/api/scenes/')) { sceneCalls++; data = scenePayload; }
    else if (url.includes('/api/clips/')) {
      clipResolved.push(url);
      data = clipGatewayPayload;
    } else data = { success: true };
    opts.success({ statusCode: 200, data });
  },
};

function applyPatch(data, patch) {
  Object.keys(patch).forEach((key) => {
    if (!/[.[]/.test(key)) { data[key] = patch[key]; return; }
    const path = key.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = data;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (cur[k] === undefined || typeof cur[k] !== 'object') {
        cur[k] = /^\d+$/.test(path[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[path[path.length - 1]] = patch[key];
  });
}

let page = null;
global.Page = (cfg) => {
  page = Object.assign({}, cfg, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    setData(patch) { applyPatch(this.data, patch); },
  });
};

// audio-clip 单例打桩（页面 require 前覆写，避免真实 InnerAudioContext 链路）
const audioClip = require('../utils/audio-clip');
const playCalls = [];
let clipState = {};
audioClip.play = (params) => { playCalls.push(params); };
audioClip.stop = () => { clipState = {}; };
audioClip.getState = () => clipState;
audioClip.subscribe = () => () => {};
audioClip.resolveClipSource = async (params) => {
  clipResolved.push('resolve:' + params.clipId);
  return { url: clipGatewayPayload.data.url, duration: clipGatewayPayload.data.duration, offset: clipGatewayPayload.data.clipOffset };
};

require('../pages/practice-room/index');
const authStore = require('../store/authStore');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

(async () => {
  // —— 场景 A：词典例句队列 + clipId 置顶 + 命中词高亮 ——
  page.onLoad({ word: 'compromise', clipId: 'c3' });
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.loading === false && page.data.total === 3, 'A 词典例句装载 3 题');
  assert(page.data.items[0].clipid === 'c3' && page.data.items[1].clipid === 'c1',
    'A clipId 参数置顶该例句');
  assert(page.data.sourceLabel === '查单词 · compromise' && page.data.word === 'compromise', 'A 题源标签与命中词');
  assert(Array.isArray(page.data.current.parts) && page.data.current.parts.some((p) => p.hl),
    'A 命中词三段高亮（WXML 零方法调用）');
  assert(page.data.current.evalSubtitle.textEn === page.data.items[0].textEn, 'A eval-card subtitle 同步当前题');

  // —— 场景 B：切片直链预取 + 词级时间轴 clipOffset 换算 ——
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.items[0].audioReady === true && page.data.items[0].audioUrl.indexOf('sig') !== -1,
    'B 切片直链经 /api/clips 网关预取');
  const rebased = page.data.current.evalSubtitle.words[0];
  assert(Math.abs(rebased.start - 0.2) < 1e-6 && Math.abs(rebased.end - 1.4) < 1e-6,
    'B 词级时间轴按 clipOffset 换算切片相对秒（100.2-100≈0.2，浮点容差）');

  // —— 场景 C：中央播放钮（audio-clip 打桩验证调用口径） ——
  page.onPlayTap();
  assert(playCalls[0] && playCalls[0].clipId === 'c3' && playCalls[0].key === 'pr:c3',
    'C 播放钮走切片直连（key=pr:{clipid}）');

  // —— 场景 D：评测回填 + 手动翻页（禁自动连播） ——
  page.onEvaluate({ detail: { score: 87 } });
  assert(page.data.scores[0] === 87 && page.data.lastScore === 87, 'D 评测得分回填当前题');
  page.onNext();
  assert(page.data.index === 1 && page.data.lastScore === null, 'D 手动下一句（不自动连播，得分态复位）');
  assert(page.data.current.clipid === 'c1', 'D 第二题为置顶后的 c1');

  // —— 场景 E：完成结算 ——
  page.onNext(); // 第 3 题
  page.onEvaluate({ detail: { score: 93 } });
  page.onNext(); // 最后一题下一句 → 结算
  assert(page.data.finished === true && page.data.avgText === '90 分',
    'E 全部完成进入结算（(87+93)/2=90，不自动跳走）');
  page.onRestart();
  assert(page.data.finished === false && page.data.index === 0 && page.data.scores.length === 0,
    'E 再来一轮复位');

  // —— 场景 F：语境句队列（sceneId 模式） ——
  sceneCalls = 0;
  page.onLoad({ sceneId: 'sX' });
  await new Promise((r) => setTimeout(r, 0));
  assert(sceneCalls === 1 && page.data.total === 2 && page.data.items[1].episodeid === 'ep9',
    'F 场景模式装载 2 句（episodeid 场景级回填）');
  assert(page.data.current.parts === null && page.data.current.durText === '4s',
    'F 场景模式无命中词高亮 / durText 预格式化');

  // —— 场景 G：错误分支 ——
  dictPayload = { success: true, data: { corpusExamples: [] } };
  page.onLoad({ word: 'nodata' });
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.loadError.indexOf('暂无原声例句') !== -1, 'G 无例句 → 错误态（回首页出口）');
  page.onLoad({});
  await new Promise((r) => setTimeout(r, 0));
  assert(page.data.loadError === '缺少训练参数', 'G 缺参守卫');

  // —— 场景 H：WXML 手动翻页口径（禁 swiper/自动连播） ——
  const wxml = require('node:fs').readFileSync(path.join(__dirname, '../pages/practice-room/index.wxml'), 'utf8');
  assert(!wxml.includes('<swiper'), 'H 题库式无 swiper（禁手势滑动连播）');
  assert(wxml.includes('bindtap="onNext"'), 'H 【下一句】为手动点击翻页');

  authStore.logout && authStore.logout();
  console.log('----------------------------------------');
  if (failed === 0) console.log('ALL PRACTICE-ROOM TESTS PASSED');
  else { console.error(failed + ' TEST(S) FAILED'); process.exitCode = 1; }
})();
