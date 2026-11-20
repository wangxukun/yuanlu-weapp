const assert = require('node:assert/strict');
const feed = require('../pages/discover/reels-api');
const recorder = require('../utils/recorder');
const request = require('../utils/request');
const bus = require('../utils/audio-bus');
const winPlayer = require('../utils/clip-player');
const flush = () => new Promise(setImmediate);

const clips = [1, 2].map(n => feed.fromFeedItem({
  clipid: 'c' + n, episodeid: 'ep', subtitleId: n, textEn: 'Global healthcare matters.',
  textCn: '全球医疗很重要。', start: 40, end: 46, duration: 6, podcastTitle: 'StoryCorps',
}));
const plays = [];
let hooks, kind, opened = 0, evaluations = 0;
winPlayer.createClipPlayer = (h) => {
  hooks = h;
  return {
    playUrl(url, k, opts) { bus.stopAll(); kind = k; plays.push(opts); h.onPlaying(k); },
    stop() { kind = null; h.onPlaying(null); },
    getKind: () => kind, estimatedPos: () => 2.5,
  };
};
feed.fetchFeed = async page => ({ items: page === 1 ? clips : [clips[0]], hasMore: page === 1 });
feed.fetchClipAudio = async () => ({ url: 'clip.m4a', clipOffset: 39.5 });
recorder.ensurePermission = async () => true;
recorder.start = () => { opened++; bus.stopAll(); return true; };
recorder.stop = async () => ({ base64: 'sample', duration: 2 });
request.post = async (url, body) => {
  assert.equal(url, '/api/speech/evaluate');
  assert.equal(body.subtitleId, 1);
  assert.equal(body.scenario, 'review');
  evaluations++;
  return { success: true, data: { score: 89 } };
};
let def;
global.Component = value => { def = value; };
global.wx = { showToast() {} };
require('../components/review/ear-workout/index');

(async () => {
  const c = { ...def.methods, data: { ...def.data, active: true }, setData(v) { Object.assign(this.data, v); } };
  const activate = (value) => { c.data.active = value; def.observers.active.call(c, value); };
  def.lifetimes.attached.call(c);
  await flush();
  assert.equal(c.data.clip.showTitle, 'StoryCorps');
  assert.equal(c.data.stage, 'blind');
  assert.equal(plays.length, 0);
  await c.toggleAudio();
  assert.deepEqual(plays[0], { startSec: 0.5, endSec: 6.5 });
  hooks.onEnded();
  assert.deepEqual(plays[1], plays[0]);
  await c.toggleAudio();
  assert.equal(c.data.audio, 'idle');
  await c.toggleAudio();
  assert.equal(plays.at(-1).startSec, 2.5);
  c.beginQuiz();
  c.submit({ detail: { value: '  GLOBAL HealthCare ' } });
  assert.equal(c.data.quizScore, 100);
  await c.record();
  assert.equal(c.data.audio, 'idle');
  assert.equal(c.data.recording, 'recording');
  await c.finishRecording();
  assert.equal(c.data.result.score, 89);
  assert.equal(evaluations, 1);
  c.next();
  await flush();
  assert.equal(c.data.number, 2);
  assert.equal(c.data.input, '');
  assert.equal(c.data.result, null);
  assert.equal(c.data.quizScore, null);
  assert.equal(c.data.stage, 'blind');
  assert.equal(c.data.audio, 'playing');
  c.beginQuiz();
  c.submit({ detail: { value: 'no match' } });
  assert.equal(c.data.quizScore, 70);
  let resolvePermission;
  recorder.ensurePermission = () => new Promise(ok => { resolvePermission = ok; });
  const pending = c.record();
  activate(false);
  resolvePermission(true);
  await pending;
  assert.equal(opened, 1);
  activate(true);
  await c.next();
  await flush();
  assert.equal(c.data.number, 3);
  assert.equal(c.data.last, true);
  c.beginQuiz();
  c.reveal();
  assert.equal(c.data.quizScore, null);
  activate(false);
  assert.equal(kind, null);
  activate(true);
  let resolveSource;
  feed.fetchClipAudio = () => new Promise(ok => { resolveSource = ok; });
  const starting = c.toggleAudio();
  activate(false);
  resolveSource({ url: 'late.m4a', clipOffset: 39.5 });
  await starting;
  assert.equal(kind, null, '切出后迟到的音源不能起播');
  def.lifetimes.detached.call(c);
  let page;
  global.Page = d => { page = { ...d, data: { ...d.data }, setData(v) { Object.assign(this.data, v); } }; };
  require('../pages/review/index');
  assert.equal(page.data.tabs[page.data.activeTab].name, '盲听特训');
  for (const [pending, name] of ['生词本', '句子本', '发音弱项本'].entries()) {
    wx.getStorageSync = key => key === 'review:pendingTab' ? pending : '';
    wx.removeStorageSync = () => {};
    page.onShow();
    assert.equal(page.data.tabs[page.data.activeTab].name, name);
  }
  console.log('盲听三阶段、答题分数、循环与续播、跨页换题、录音评测和退出清理通过');
})().catch(err => { console.error(err); process.exitCode = 1; });
