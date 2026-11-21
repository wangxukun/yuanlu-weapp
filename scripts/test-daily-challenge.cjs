const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const storage = new Map(), requests = [], listeners = new Set();
let auth = { isLoggedIn: false, token: '', userInfo: null }, date = '2026-11-14';
const authStore = { getState: () => auth, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
const wx = { getStorageSync: (k) => storage.get(k), setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))), showToast() {} };
function load(file, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, require: (s) => imports[s] || {}, wx, console, Date, Math, setTimeout, clearTimeout,
  }, { filename: file });
  return module.exports;
}
const request = { post: (url, data, options) => new Promise((resolve, reject) => requests.push({ url, data, options, resolve, reject })) };
const shadow = load('pages/home/shadowing.js', {
  '../../store/authStore': authStore, '../../utils/request': request,
  '../../utils/speech-core': { parseEvalResponse: () => ({ words: [] }) },
  './dashboard': { chinaClock: () => ({ date }) },
});
const local = Array.from({ length: 12 }, (_, i) => ({ id: 'local-' + i, textEn: 'Local sample number ' + i,
  textCn: '本地示例', start: 0, end: 6, words: [], audioUrl: 'sample.mp3' }));
const reels = load('pages/discover/reels-api.js', { '../../utils/request': request, './reels-corpus': local });
const subjectMod = load('utils/subject.js', { '../store/authStore': authStore });
const daily = load('pages/home/daily-challenge.js', { '../../store/authStore': authStore, '../../utils/request': request,
  '../../utils/subject': subjectMod, '../discover/reels-api': reels, './shadowing': shadow, './dashboard': { chinaClock: () => ({ date }) } });
function page() {
  return { ...daily.methods, data: {}, _shadowResults: {}, _shadowAttempts: 0, _shadowDisposed: false,
    setData(patch) { Object.assign(this.data, patch); }, _pausePlayback() {}, _shadowBusy() { return false; },
    _fetchSavedKeys() {}, _loadLeaderboard() {},
    _applyShadowResults() { this.data.daily = shadow.applyResults(this.data.daily, this._shadowResults, this._shadowAttempts); },
    _mapDailyClip(reel, index) { return { ...reel, order: index + 1, available: reel.available }; },
  };
}
function response(count = 5, day = date, evaluations = false) {
  return { success: true, data: { date: day, status: count === 5 ? 'complete' : count ? 'partial' : 'empty',
    assignmentId: 'assignment-' + day, algorithmVersion: 'daily-v2', fallbackStage: 'normal',
    items: Array.from({ length: count }, (_, i) => ({ clipid: 'clip-' + i, episodeid: 'ep-' + i, subtitleId: i,
      textEn: 'Sentence number ' + i, textCn: '句子', duration: 6, start: 0, end: 6, words: [],
      matchedWords: i === 0 ? ['number'] : [], evaluation: evaluations && i === 0 ? { recognitionId: 42, score: 90 } : null })) } };
}
function session(uid) { auth = uid ? { isLoggedIn: true, token: 'token-' + uid, userInfo: { userid: uid } } : { isLoggedIn: false }; }
async function resolveLoad(p, body) {
  const promise = p._loadDaily(false);
  requests.at(-1).resolve(body);
  await promise;
}
(async () => {
  session('u1');
  const p = page();
  const first = p._loadDaily(false), same = p._loadDaily(false);
  assert.equal(first, same); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/clips/daily-challenge');
  requests[0].resolve(response(5, date, true)); await first;
  assert.equal(p.data.daily.completedCount, 1, 'Server history restores completion');
  assert.equal(p.data.daily.clips[0].id, 'clip-0', 'Uses existing feed item adapter');
  const ids = p.data.daily.clips.map((c) => c.id).join();
  const n = requests.length;
  await p._loadDaily(true);
  assert.equal(requests.length, n, 'Refresh never rerolls a cached day');
  assert.equal(p.data.daily.clips.map((c) => c.id).join(), ids);
  const reopened = page(); await reopened._loadDaily(false);
  assert.equal(requests.length, n, 'Same-day storage restores without selection');
  assert.equal(reopened.data.daily.clips.map((c) => c.id).join(), ids);
  assert.equal(daily.history('user:u1', date).length, 5);
  p._recordDailyPractice(p.data.daily.clips[0]);
  assert.equal(daily.history('user:u1', date).find((r) => r.subtitleId === 0).practicedOn, date);

  date = '2026-11-15';
  const tomorrow = p._loadDaily(false);
  assert.equal(requests.at(-1).data.localHistory.length, 5);
  requests.at(-1).resolve(response(1)); await tomorrow;
  assert.equal(p.data.daily.status, 'partial');
  const partialRequests = requests.length; await p._loadDaily(true);
  assert.equal(requests.length, partialRequests, 'Partial results are cached');
  date = '2026-11-16'; await resolveLoad(p, response(0));
  assert.equal(p.data.daily.source, 'corpus'); assert.equal(p.data.daily.clips.length, 0);
  const emptyRequests = requests.length; await p._loadDaily(true);
  assert.equal(requests.length, emptyRequests, 'Empty success is not a network failure');

  date = '2026-11-17';
  const offline = p._loadDaily(false); requests.at(-1).reject({ statusCode: 0 }); await offline;
  assert.equal(p.data.daily.source, 'local');
  const offlineIds = p.data.daily.clips.map((c) => c.id);
  const offlineRequests = requests.length; await p._loadDaily(false);
  assert.equal(requests.length, offlineRequests, 'Passive reload keeps cached offline assignment without spamming network');
  const retryOffline = p._loadDaily(true); requests.at(-1).reject({ statusCode: 0 }); await retryOffline;
  assert.deepEqual(p.data.daily.clips.map((c) => c.id), offlineIds, 'Manual refresh while still offline keeps deterministic local cards');
  const recoverOnline = p._loadDaily(true); requests.at(-1).resolve(response(5, date)); await recoverOnline;
  assert.equal(p.data.daily.source, 'corpus', 'Manual refresh upgrades local fallback once network recovers');
  date = '2026-11-18';
  const nextOffline = p._loadDaily(false); requests.at(-1).reject({ statusCode: 0 }); await nextOffline;
  assert(!p.data.daily.clips.some((c) => offlineIds.includes(c.id)), 'Local fallback also avoids recent repeats');

  date = '2026-11-19'; session('u1');
  const late = p._loadDaily(false), pending = requests.at(-1);
  session('u2'); const other = p._loadDaily(false), otherReq = requests.at(-1);
  pending.resolve(response()); await late;
  assert.equal(p.data.daily, null, 'Stale account response cannot overwrite another account');
  otherReq.resolve(response(2)); await other;
  assert.equal(p.data.daily.subject, 'user:u2');
  assert.equal(daily.history('user:u2', date).length, 2);
  assert.notEqual(daily.cacheKey('user:u1', date), daily.cacheKey('user:u2', date));

  date = '2026-11-20';
  const midnight = p._loadDaily(false), midnightReq = requests.at(-1);
  date = '2026-11-21'; midnightReq.resolve(response(5, '2026-11-20')); await midnight;
  assert.equal(p.data.daily, null, 'Late previous-day response is discarded');
  await resolveLoad(p, response()); assert.equal(p.data.daily.date, date);

  date = '2026-11-22';
  const expired = p._loadDaily(false); requests.at(-1).reject({ statusCode: 401 }); await expired;
  assert.equal(p.data.daily, null); assert.match(p.data.dailyError, /登录/);
  assert.equal(storage.has(daily.cacheKey('user:u2', date)), false);
  auth = { isLoggedIn: true, token: 'pending', userInfo: null };
  const pendingCount = requests.length; await p._loadDaily(false);
  assert.equal(requests.length, pendingCount, 'Do not cache authenticated results as a guest before profile resolves');

  date = '2026-11-23'; session('legacy-user');
  storage.set('studio_daily_' + date, { clips: response().data.items.map(reels.fromFeedItem), date, source: 'corpus' });
  const legacyCount = requests.length; await p._loadDaily(false);
  assert.equal(requests.length, legacyCount); assert.equal(p.data.daily.algorithmVersion, 'daily-v2');
  session('different-user'); const different = p._loadDaily(false);
  assert.equal(requests.length, legacyCount + 1, 'Old unscoped cache may only be claimed once');
  requests.at(-1).resolve(response()); await different;

  const template = fs.readFileSync(path.join(root, 'pages/home/index.wxml'), 'utf8');
  assert(!template.includes('daily.completedCount * 20'));
  assert(template.includes('daily.clips.length || 0'));
  assert(template.includes('刷新进度'));

  // 预签直链时效：过期作废（今日挑战缓存固化旧签名 → OSS 403 播放失败的根因）
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(reels.freshAudioUrl('https://oss/x.aac?Expires=' + exp), true, '未过期直链可用');
  assert.equal(reels.freshAudioUrl('https://oss/x.aac?Expires=' + exp + '&Signature=s'), true, '带签名参数仍可解析');
  assert.equal(reels.freshAudioUrl('https://oss/x.aac?Expires=' + (exp - 3599)), false, '仅剩 1 秒视为过期（60s 余量）');
  assert.equal(reels.freshAudioUrl('https://oss/x.aac?Expires=' + Math.floor(Date.now() / 1000)), false, '已到期直链过期');
  assert.equal(reels.freshAudioUrl('https://oss/x.aac'), true, '无 Expires 参数按未过期（本地/相对路径）');
  assert.equal(reels.freshAudioUrl(''), true, '空值不误判');

  console.log(JSON.stringify({ passed: true, requests: requests.length, scenarios: ['same-day', 'refresh', 'progress', 'partial', 'empty', 'history', 'offline', 'account-switch', 'midnight', 'expired-auth', 'legacy', 'stale-audio-url'] }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
