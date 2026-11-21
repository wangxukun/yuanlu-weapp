const assert = require('node:assert/strict');
const feed = require('../pages/discover/reels-api');
const recorder = require('../utils/recorder');
const request = require('../utils/request');
const bus = require('../utils/audio-bus');
const winPlayer = require('../utils/clip-player');
const flush = () => new Promise(setImmediate);

const clips = [1, 2].map(n => feed.fromFeedItem({
  clipid: 'c' + n, episodeid: 'ep', subtitleId: n, textEn: 'Global healthcare matters.',
  ringKey: 'key' + n, words: [{word:'Global',start:40,end:41},{word:'healthcare',start:41,end:43}], textCn: '全球医疗很重要。', start: 40, end: 46, duration: 6, podcastTitle: 'StoryCorps',
}));
const plays = [];
let hooks, kind, opened = 0, evaluations = 0;
let readyImmediately = true;
winPlayer.createClipPlayer = (h) => {
  hooks = h;
  return {
    playUrl(url, k, opts) { bus.stopAll(); kind = k; plays.push(opts); if (readyImmediately) h.onPlaying(k); },
    stop() { kind = null; h.onPlaying(null); },
    getKind: () => kind, estimatedPos: () => 2.5,
  };
};

feed.fetchClipAudio = async () => ({ url: 'clip.m4a', clipOffset: 39.5 });
recorder.ensurePermission = async () => true;
recorder.start = () => { opened++; bus.stopAll(); return true; };
recorder.stop = async () => ({ base64: 'sample', duration: 2, wavPath: '/tmp/take.wav' });
const displays = [];
let displayOffline = false;
request.post = async (url, body) => {
  if (url === '/api/clips/blind-train') {
    if (body.event === 'display') {
      if (displayOffline) throw new Error('offline');
      displays.push(body.clipid);
    }
    return { success: true };
  }
  if (url === '/api/sentences/toggle') return { success: true, data: { saved: true } };
  if (url === '/api/vocabulary/add') { assert.equal(body.word, 'healthcare'); return { success: true }; }
  assert.equal(url, '/api/speech/evaluate');
  assert.equal(body.subtitleId, 1);
  assert.equal(body.scenario, 'review');
  evaluations++;
  return { success: true, data: { score: 89, details: {
    words: [{ word: 'healthcare', pronunciation: 73, phonemes: [{ phoneme: 'θ', score: 51 }] }],
  } } };
};
request.get = async url => {
  if (url.startsWith('/api/clips/blind-train?')) return {success:true,data:{day:training.today(),items:[]}};
  if (url.startsWith('/api/sentences/keys')) return {success:true,data:{subtitleIds:[]}};
  if (url.startsWith('/api/dict/')) return {success:true,data:{ definitions:[] }};
  if (url === '/api/vocabulary/words') return {success:true,data:[]};
  throw Error(url);
};
const training = require('../components/review/ear-workout/training');
const calls = [];
const fetchRealBatch = training.fetchBatch;
let failNextPage = false;
training.fetchBatch = async (cursor, day, level) => {
  calls.push([cursor, level]);
  if (failNextPage) { failNextPage = false; throw new Error('offline'); }
  return { day: training.today(), items: cursor ? [clips[0]] : clips, hasMore: !cursor, nextCursor: 'key2' };
};
const store = new Map();
const messages = [];
function setData(v, callback) {
  for (const [key,value] of Object.entries(v)) {
    const [parent, child] = key.split('.');
    if (child) this.data[parent][child] = value;
    else this.data[parent] = value;
  }
  if (callback) callback();
}
let def;
global.Component = value => { def = value; };
const audioFiles = new Set();
const fs = { copyFileSync(src, dst) { audioFiles.add(dst); }, unlinkSync(path) { audioFiles.delete(path); },
  accessSync(path) { if (!audioFiles.has(path)) throw Error('missing'); } };
global.wx = { env:{USER_DATA_PATH:'/tmp'}, getFileSystemManager:()=>fs, showToast({title}) { messages.push(title); },
  getStorageSync: key => store.get(key), setStorageSync: (key, v) => store.set(key, v) };
require('../store/authStore').setState({userInfo:{userid:'tester'}, isLoggedIn:true});
require('../components/review/ear-workout/index');

(async () => {
  const example = {
    ...def.methods,
    data: { clip: { id:'example', textEn: 'Global, GLOBAL healthcare matters.' } },
    setData,
  };
  for (const [input, score, matched, incorrect, omitted] of [
    ['matters，GLOBAL global healthcare', 100, ['matters', 'global', 'healthcare'], [], []],
    ['global', 50, ['global'], [], ['healthcare', 'matters']],
    ['global money MONEY', 40, ['global'], ['money'], ['healthcare', 'matters']],
    ['global healthcare matters money', 86, ['global', 'healthcare', 'matters'], ['money'], []],
    ['care CARE', 0, [], ['care'], ['global', 'healthcare', 'matters']],
  ]) {
    example.data.stage = 'quiz';
    example.submit({ detail: { value: input } });
    const quiz = example.data.quiz;
    assert.equal(quiz.score, score, input);
    assert.equal(quiz.originalCount, 3);
    assert.equal(quiz.submittedCount, matched.length + incorrect.length);
    assert.deepEqual(quiz.matched, matched);
    assert.deepEqual(quiz.incorrect, incorrect);
    assert.deepEqual(quiz.omitted, omitted);
  }
  assert.equal(example.data.todayCount, 1);
  assert.equal(example.data.todayAverage, 0, '最新一轮为零也计入成绩');
  store.clear(); // 评分算例不属于下面的训练会话。
  const c = { ...def.methods, data: { ...def.data, active: true }, setData };
  const activate = (value) => { c.data.active = value; def.observers.active.call(c, value); };
  def.lifetimes.attached.call(c);
  await flush();
  assert.equal(c.data.clip.showTitle, 'StoryCorps');
  assert.deepEqual(displays, ['c1'], '仅当前展示的切片上报');
  assert.equal(c.data.todayCount, 0);
  assert.equal(c.data.todayAverage, null);
  assert.equal(c.data.stage, 'blind');
  assert.equal(plays.length, 0);
  readyImmediately = false;
  await c.toggleAudio();
  assert.equal(c.data.audio, 'loading');
  hooks.onPlaying(kind);
  readyImmediately = true;
  assert.equal(c.data.audio, 'playing');
  assert.deepEqual(plays[0], { startSec: 0.5, endSec: 6.5 });
  hooks.onEnded(kind);
  assert.deepEqual(plays[1], plays[0]);
  await c.toggleAudio();
  assert.equal(c.data.audio, 'idle');
  await c.toggleAudio();
  assert.equal(plays.at(-1).startSec, 2.5);
  c.beginQuiz();
  c.onInput({ detail: { value: 'global' } });
  c.submit({ detail: { value: { keywords: '  MATTERS， Ｇｌｏｂａｌ ' } } });
  assert.deepEqual(c.data.quiz, {
    score: 80, originalCount: 3, submittedCount: 2, precision: 100, coverage: 67,
    matched: ['matters', 'global'], incorrect: [], omitted: ['healthcare'],
  });
  c.reveal();
  assert.equal(c.data.quiz.score, 80, '迟到的跳过事件不能清除得分');
  hooks.onTick(1.75);
  assert.equal(c.data.activeWord, 2);
  await c.bookmark();
  assert.equal(c.data.saved, true);
  await c.lookup({currentTarget:{dataset:{word:'healthcare'}}});
  assert.equal(c.data.wordModal.word,'healthcare');
  await c.saveWord();
  assert.equal(c.data.wordModal.saved,true);
  c.closeLookup();
  await flush();
  await c.record();
  assert.equal(c.data.audio, 'idle');
  assert.equal(c.data.recording, 'recording');
  await c.record();
  assert.equal(c.data.recording, 'recording');
  assert.equal(evaluations, 0);
  await new Promise(ok => setTimeout(ok, 2050));
  assert.equal(c.data.recording, 'recording', '超过两秒仍可继续朗读');
  assert.equal(evaluations, 0);
  await Promise.all([c.record(), c.record()]);
  assert.equal(c.data.result.score, 89);
  assert.match(c.data.result.feedback, /healthcare.*θ/);
  assert.equal(evaluations, 1);
  c.next();
  await flush();
  assert.equal(c.data.number, 2);
  assert.equal(c.data.input, '');
  assert.equal(c.data.result, null);
  assert.equal(c.data.quiz, null);
  assert.equal(c.data.stage, 'blind');
  assert.equal(c.data.audio, 'playing');
  c.previous();
  assert.equal(c.data.stage, 'revealed');
  assert.equal(c.data.number, 1);
  assert.equal(c.data.quiz.score, 80);
  assert.equal(c.data.result.score, 89);
  c.playRecording();
  assert.equal(kind,'user');
  const frozen = c.data.activeWord;
  hooks.onTick(5);
  assert.equal(c.data.activeWord,frozen);
  const playCount = plays.length;
  hooks.onEnded('user');
  assert.equal(plays.length,playCount,'回听结束不能触发原声循环');
  c.playRecording();
  audioFiles.delete(c.data.wavPath);
  c.playRecording();
  assert.match(messages.at(-1),/录音文件不可用/);
  assert.equal(c.data.parts.find(p => p.key === 'healthcare').score, 73);
  c.next();
  c.beginQuiz();
  c.submit({detail:{value:'word '.repeat(61)}});
  assert.equal(c.data.stage,'quiz');
  assert.match(messages.at(-1),/60/);
  c.submit({ detail: { value: '  ，。 ' } });
  assert.equal(c.data.stage, 'quiz');
  c.submit({ detail: { value: 'care matters matters' } });
  assert.deepEqual(c.data.quiz, {
    score: 40, originalCount: 3, submittedCount: 2, precision: 50, coverage: 33,
    matched: ['matters'], incorrect: ['care'], omitted: ['global', 'healthcare'],
  });
  assert.equal(c.data.todayCount, 2);
  assert.equal(c.data.todayAverage, 60);
  c.retryQuiz();
  c.submit({ detail: { value: 'care' } });
  assert.equal(c.data.quiz.score, 0, '重测失手本轮记 0 分');
  assert.equal(c.data.todayAverage, 40, '同题重测取最新成绩：(80+0)/2');
  c.retryQuiz();
  c.submit({ detail: { value: 'global healthcare matters' } });
  assert.equal(c.data.quiz.score, 100);
  assert.equal(c.data.todayAverage, 90);
  let resolvePermission;
  recorder.ensurePermission = () => new Promise(ok => { resolvePermission = ok; });
  const pending = c.record();
  activate(false);
  resolvePermission(true);
  await pending;
  assert.equal(opened, 1);
  activate(true);
  failNextPage = true;
  await c.next();
  assert.equal(c.data.number, 2);
  assert.match(c.data.message, /重试/);
  await c.next();
  await flush();
  assert.equal(c.data.number, 3);
  assert.equal(c.data.last, true);
  c.beginQuiz();
  c.reveal();
  assert.equal(c.data.quiz, null);
  recorder.ensurePermission = async () => true;
  // 捕获组件设置的上限回调，覆盖到时送评和切出后的迟到事件。
  const realSetTimeout = global.setTimeout;
  let deadline, limitMs, cancelled = 0;
  recorder.cancel = () => { cancelled++; };
  try {
    global.setTimeout = (callback, ms) => { deadline = callback; limitMs = ms; return 1; };
    await c.record();
    assert.equal(limitMs, 30000);
    deadline();
    await flush();
    assert.equal(evaluations, 2);
    assert.equal(c.data.recording, 'idle');
    await c.record();
    activate(false);
    deadline();
    await flush();
    assert.equal(cancelled, 1);
    assert.equal(evaluations, 2);
    assert.equal(c.data.result.score, 89, '取消重录仍可看到上一次成功的结果');
  } finally {
    global.setTimeout = realSetTimeout;
  }
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

  const fixture = { ...def.methods, data: { ...def.data, active: true }, setData };
  def.lifetimes.attached.call(fixture);
  await flush();
  assert.equal(fixture.data.number, 3, '从当前题恢复');
  assert.equal(fixture.data.todayCount,2);
  assert.equal(fixture.data.todayAverage, 90);
  await fixture.changeLevel({detail:{value:3}});
  assert.deepEqual(calls.at(-1),['','B1']);
  assert.equal(fixture.data.number,1);
  assert.equal(fixture.data.todayCount,2);
  feed.fetchClipAudio = async () => { throw Object.assign(new Error(), {statusCode:403}); };
  await fixture.toggleAudio();
  assert.match(messages.at(-1),/会员/);
  feed.fetchClipAudio = async () => ({url:'test',clipOffset:39.5});
  fixture._player.playUrl = () => { throw Error('native'); };
  await fixture.toggleAudio();
  assert.equal(fixture.data.audio,'idle');
  assert.match(messages.at(-1),/加载失败/);
  def.lifetimes.detached.call(fixture);
  // 直接揭晓保留练习进度，但不进入盲听评分统计。
  const revealOnly = { ...def.methods, data: { stage: 'quiz', clip: { id: 'c9', textEn: 'A B C.' } }, setData };
  revealOnly.reveal();
  const day = training.readDay();
  revealOnly._refreshStats();
  assert.equal(revealOnly.data.todayCount, 2);
  assert.equal(revealOnly.data.todayAverage, 90);
  assert.ok(!('c9' in day.scores), '揭晓不贡献 0 分');
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-11-22T15:59:59Z');
    const oldDay = training.today();
    training.writeDay({ day: oldDay, scores: { yesterday: 80 }, progress: {} });
    displayOffline = true;
    await assert.rejects(training.recordDisplay({clipid:'offline', day:oldDay, position:1, level:'', cursor:'abc'}));
    Date.now = () => Date.parse('2026-11-22T16:00:00Z');
    assert.notEqual(training.today(), oldDay);
    revealOnly._refreshStats();
    assert.equal(revealOnly.data.todayCount, 0);
    assert.equal(revealOnly.data.todayAverage, null);
    displayOffline = false;
    await fetchRealBatch('',training.today(),'',true);
    assert.equal(displays.at(-1),'offline','跨日取题补传实际展示过的切片');
  } finally { Date.now = originalNow; }
  let page;
  global.Page = d => { page = { ...d, data: { ...d.data }, setData }; };
  require('../pages/review/index');
  assert.equal(page.data.tabs[page.data.activeTab].name, '盲听特训');
  // 下拉刷新：json 开启 + refreshSeq 递增通知复习本重拉 + 立即收圈
  assert.equal(JSON.parse(require('fs').readFileSync('pages/review/index.json', 'utf8')).enablePullDownRefresh, true,
    'review 页 json 开启下拉刷新');
  let pullStopped = 0;
  wx.stopPullDownRefresh = () => { pullStopped++; };
  page.data.isLoggedIn = true;
  page._seq = page.data.refreshSeq || 0; // onLoad 未跑时补初始化（++undefined 会 NaN）
  const seqBefore = page.data.refreshSeq;
  page.onPullDownRefresh();
  assert.equal(page.data.refreshSeq, seqBefore + 1, '下拉 → refreshSeq 递增（复习本重拉通道）');
  assert.equal(pullStopped, 1, '立即收圈 stopPullDownRefresh');
  for (const [pending, name] of ['生词本', '句子本', '发音弱项本'].entries()) {
    wx.getStorageSync = key => key === 'review:pendingTab' ? pending : '';
    wx.removeStorageSync = () => {};
    page.onShow();
    assert.equal(page.data.tabs[page.data.activeTab].name, name);
  }
  console.log('盲听三阶段、答题分数、循环与续播、跨页换题、录音评测和退出清理通过');
})().catch(err => { console.error(err); process.exitCode = 1; });
