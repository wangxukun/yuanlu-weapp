const assert = require('node:assert/strict');
const storage = new Map();
global.wx = {
  getStorageSync: (k) => storage.get(k),
  setStorageSync: (k, value) => storage.set(k, structuredClone(value)),
  showToast() {},
};
let definition;
global.Page = (page) => { definition = page; };
require('../pages/discover/index');
const api = require('../pages/discover/reels-api');
const session = require('../pages/discover/reels-session');
const flush = () => new Promise(setImmediate);
const key = (n) => n.toString(16).padStart(16, '0');

function batch(first, count = 12, hasMore = true) {
  const items = Array.from({ length: count }, (_, i) => {
    const n = first + i;
    return { id: 'clip-' + n, episodeid: 'ep', subtitleId: n, real: true, ringKey: key(n),
      textEn: 'We can go there together again this morning.', words: [], wpm: 120, difficulty: 'B1' };
  });
  return { items, nextCursor: key(first + count - 1), hasMore, mode: 'ring' };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function openPage() {
  const page = Object.assign({}, definition, {
    data: structuredClone(definition.data),
    plays: 0,
    _syncTheme() {},
    _fetchVocabSet() {},
    _startPlayback() { this.plays++; },
    setData(patch, callback) {
      for (const [field, value] of Object.entries(patch)) {
        if (field.startsWith('filterDraft.')) this.data.filterDraft[field.split('.')[1]] = value;
        else this.data[field] = value;
      }
      if (patch.reels) {
        assert.ok(patch.reels.length <= 48);
        assert.ok('index' in patch);
        if (this.data.clip && !('sourceLocal' in patch)) {
          assert.equal(patch.reels[patch.index].id, this.data.clip.id);
        }
      }
      if (callback) callback();
    },
  });
  page.onLoad();
  await flush();
  return page;
}

function finish(page) {
  page.onSwiperFinish({ detail: { current: page.data.index, currentItemId: page.data.clip.id } });
}

function swipe(page, index) {
  page.onPullTouchStart({ touches: [{ clientY: 42 }] });
  page.onPullTouchMove({ touches: [{ clientY: 12 }] });
  page.onPullTouchEnd();
  page.onSwiperChange({ detail: { source: 'touch', current: index, currentItemId: page._reels[index].id } });
  finish(page);
}

async function continuousFeed() {
  storage.clear();
  const cursors = [];
  api.fetchFeed = ({ cursor }) => {
    cursors.push(cursor);
    return batch(cursor.length === 8 ? 1 : parseInt(cursor, 16) + 1);
  };
  const page = await openPage();
  for (let n = 2; n <= 125; n++) {
    const plays = page.plays;
    page.onNext();
    assert.equal(page.data.clip.subtitleId, n);
    assert.equal(page.data.sentenceNumber, n);
    const currentId = page.data.clip.id;
    const token = page._prepToken;
    const beforeIndex = page.data.index;
    // 回包先于动画完成。重排只改坐标，句子状态必须保留。
    const meta = page._audioMeta = { offset: n };
    const reel = page._reels[beforeIndex];
    reel.activeIdx = 2;
    const seenCount = page._seenBuffer.length;
    await flush();
    assert.equal(page.data.index, beforeIndex);
    finish(page);
    page.onSwiperChange({ detail: { source: '', current: beforeIndex, currentItemId: currentId } });
    assert.equal(page._reels[page.data.index].id, currentId);
    assert.equal(page._reels[page.data.index].activeIdx, 2);
    assert.equal(page._audioMeta, meta);
    assert.equal(page._prepToken, token);
    assert.equal(page._seenBuffer.length, seenCount);
    assert.equal(page.plays, plays + 1);
    assert.equal(page._sessionState.cursor, key(n));
    if (n === 46) {
      assert.equal(page._reels[0].subtitleId, 13);
      const backIndex = page.data.index;
      for (let i = backIndex - 1; i >= 0; i--) swipe(page, i);
      assert.equal(page.data.clip.subtitleId, 13);
      assert.equal(page.data.canPrev, false);
      page.onPullTouchStart({ touches: [{ clientY: 0 }] });
      page.onPullTouchMove({ touches: [{ clientY: 120 }] });
      assert.equal(page.data.refreshReady, false);
      page.onPullTouchCancel();
      for (let i = 1; i <= backIndex; i++) swipe(page, i);
      assert.equal(page._sessionState.cursor, key(46));
    }
  }
  swipe(page, page.data.index - 1);
  page.onUnload();
  assert.equal(session.loadSession(page._owner).cursor, key(125));
  const newPage = await openPage();
  assert.equal(cursors.at(-1), key(125));
  assert.equal(newPage.data.clip.subtitleId, 126);
  newPage.onUnload();
}

async function slowPageAndBackSwipe() {
  storage.clear();
  const delayed = deferred();
  api.fetchFeed = ({ cursor }) => {
    if (cursor === key(48)) return delayed.promise;
    return batch(cursor.length === 8 ? 1 : parseInt(cursor, 16) + 1);
  };
  const page = await openPage();
  for (let n = 2; n <= 46; n++) {
    page.onNext();
    finish(page);
    await flush();
    assert.equal(page.data.sentenceNumber, n);
  }
  for (let i = page.data.index - 1; i >= 5; i--) swipe(page, i);
  page.onPullTouchStart({ touches: [{ clientY: 100 }] });
  delayed.resolve(batch(49));
  await flush();
  const plays = page.plays;
  assert.equal(page._reels[0].subtitleId, 1);
  page.onPullTouchEnd();
  assert.equal(page.data.clip.subtitleId, 6);
  assert.equal(page.plays, plays);
  assert.equal(page._sessionState.cursor, key(46));
  for (let n = 7; n < 46; n++) {
    page.onNext();
    finish(page);
    assert.equal(page.data.sentenceNumber, n);
  }
  const change = { detail: { source: 'touch', current: 45, currentItemId: 'clip-46' } };
  page.onPullTouchStart({ touches: [{ clientY: 100 }] });
  page.onPullTouchMove({ touches: [{ clientY: 60 }] });
  page.onSwiperChange(change);
  page.onPullTouchEnd();
  page.onSwiperFinish({ detail: { current: 44, currentItemId: 'clip-45' } });
  assert.equal(page._reels[0].subtitleId, 1, '旧动画回调不能提前淘汰');
  page.data.isEvaluating = true;
  const evalToken = page._evalToken;
  page.onSwiperFinish(change);
  assert.equal(page.data.index, 33);
  assert.equal(page._evalToken, evalToken);
  assert.equal(page.data.isEvaluating, true);
  for (let n = 47; n <= 49; n++) {
    page.onNext();
    finish(page);
    assert.equal(page.data.sentenceNumber, n);
  }
  assert.equal(page._reels[0].subtitleId, 13);
  page.onUnload();
}

async function retryAndDuplicates() {
  storage.clear();
  const failed = deferred();
  const retry = deferred();
  const requests = [];
  api.fetchFeed = ({ cursor, page }) => {
    requests.push([cursor, page]);
    if (page === 1) return batch(1);
    if (requests.length === 2) return failed.promise;
    if (requests.length === 3) return retry.promise;
    return batch(13, 12, false);
  };
  const page = await openPage();
  for (let n = 2; n <= 12; n++) { page.onNext(); finish(page); }
  failed.reject(new Error('offline'));
  await flush();
  assert.equal(page.data.feedRetry, true);
  assert.equal(page.data.canNext, false);
  page.onPrev();
  page.onNext();
  finish(page);
  assert.equal(requests.length, 2);
  const request = page.onNext();
  page.onNext();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[2]);
  const duplicate = batch(1);
  duplicate.nextCursor = key(24);
  retry.resolve(duplicate);
  await request;
  assert.equal(requests[3][0], key(24));
  assert.equal(page.data.feedRetry, false);
  assert.equal(page.data.canNext, true);
  assert.equal(page._reels.length, 24);
  assert.equal(page._sessionState.cursor, key(12));
  assert.equal(page._hasMore, false);
  page.onUnload();
}

async function boundedScanAndStaleResponse() {
  storage.clear();
  const late = deferred();
  const requests = [];
  api.fetchFeed = ({ page, cursor }) => {
    requests.push(cursor);
    if (page === 1) return batch(requests.length === 1 ? 1 : 101);
    if (page === 5) return late.promise;
    return { ...batch(1), nextCursor: key(12 * page) };
  };
  const page = await openPage();
  for (let n = 2; n <= 12; n++) { page.onNext(); finish(page); }
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(page.data.feedRetry, true);
  const obsolete = page.onNext();
  assert.equal(requests.at(-1), key(48));
  await page._refreshFeed();
  late.resolve(batch(13));
  await obsolete;
  assert.equal(page._reels[0].subtitleId, 101);
  assert.equal(page._reels.length, 12);
  assert.equal(page.data.sentenceNumber, 1);
  page.onUnload();
}

async function hiddenFirstPage() {
  storage.clear();
  const first = deferred();
  api.fetchFeed = () => first.promise;
  const page = await openPage();
  page.onHide();
  first.resolve(batch(1));
  await flush();
  assert.equal(page.plays, 0);
  assert.equal(page._seenBuffer.length, 0);
  page.onShow();
  assert.equal(page.plays, 1);
  assert.equal(page._sessionState.cursor, key(1));
  page.onUnload();
}

function editField(page, field, value) {
  page.onFilterInput({ currentTarget: { dataset: { field } }, detail: { value } });
}

async function filterPools() {
  storage.clear();
  const calls = [];
  api.fetchFeed = ({ cursor, filters }) => {
    calls.push({ cursor, filters });
    const start = cursor.length === 8 ? (filters.level ? 101 : 1) : parseInt(cursor, 16) + 1;
    return batch(start);
  };
  const page = await openPage();
  page.onNext();
  finish(page);
  page.onOpenFilters();
  editField(page, 'minWords', '15');
  editField(page, 'maxWords', '8');
  page.onApplyFilters();
  assert.equal(calls.length, 1);
  assert.equal(page.data.filterErrorField, 'minWords');
  page.onCloseFilters();
  assert.equal(page.data.clip.subtitleId, 2);
  page.onOpenFilters();
  assert.deepEqual(page.data.filterDraft, {});
  for (const [field, value] of Object.entries({ minWords: 8, maxWords: 15, minWpm: 110, maxWpm: 145 })) {
    editField(page, field, String(value));
  }
  for (const level of ['B1', 'A2']) page.onFilterLevel({ currentTarget: { dataset: { level } } });
  await page.onApplyFilters();
  const expected = { minWords: 8, maxWords: 15, minWpm: 110, maxWpm: 145, level: 'A2,B1' };
  assert.deepEqual(page._sessionState.filters, expected);
  for (let n = 102; n <= 161; n++) {
    page.onNext();
    finish(page);
    await flush();
    assert.equal(page.data.clip.subtitleId, n);
    assert.equal(page.data.sentenceNumber, n - 100);
  }
  for (const call of calls.slice(1)) assert.deepEqual(call.filters, expected);
  page.onUnload();
  const reopened = await openPage();
  assert.deepEqual(calls.at(-1), { cursor: key(161), filters: expected });
  assert.equal(reopened.data.clip.subtitleId, 162);
  assert.ok(reopened._sessionState.seen.some(([seen]) => seen === 'ep:2'));
  await reopened.onClearFilters();
  assert.deepEqual(calls.at(-1), { cursor: key(2), filters: {} });
  assert.equal(reopened.data.clip.subtitleId, 3);
  reopened.onUnload();
}

async function filterRecovery() {
  storage.clear();
  const old = deferred();
  let response = () => old.promise;
  api.fetchFeed = ({ filters, cursor }) => filters.minWords ? response(cursor) : batch(1);
  const page = await openPage();
  const openWithMin = (n) => {
    page.onOpenFilters();
    editField(page, 'minWords', n);
    return page.onApplyFilters();
  };
  const obsolete = openWithMin('10');
  response = () => Promise.reject(new Error('offline'));
  await openWithMin('12');
  assert.equal(page.data.feedState, 'error');
  assert.equal(page.data.sourceLocal, false);
  old.resolve(batch(70));
  await obsolete;
  assert.equal(page.data.clip, null);
  assert.equal(page.data.feedState, 'error');
  let scanned = 0;
  response = (cursor) => {
    scanned++;
    return { items: [], mode: 'ring', hasMore: true, nextCursor: cursor + '1' };
  };
  await page.onRetryFirstPage();
  assert.equal(scanned, 3);
  assert.equal(page.data.feedState, 'more');
  const expectedCursor = page._firstScan.cursor;
  response = (cursor) => {
    assert.equal(cursor, expectedCursor);
    return { items: [], mode: 'ring', hasMore: false, nextCursor: cursor };
  };
  await page.onRetryFirstPage();
  assert.equal(page.data.feedState, 'empty');
  assert.equal(page.data.clip, null);
  await page.onClearFilters();
  assert.equal(page.data.feedState, '');
  assert.ok(page.data.clip);
  page.onUnload();
}

async function enforceReturnedLimits() {
  storage.clear();
  const nine = "We'll take this short walk to the park today.";
  const long = nine + ' ' + nine + ' one more time.';
  const first = batch(101);
  first.items = first.items.map((clip) => ({ ...clip, textEn: long, wordCount: 4, wpm: 99 }));
  const second = batch(113, 7);
  second.items = [
    { ...second.items[0], textEn: nine, wpm: 100 },
    { ...second.items[1], textEn: nine, wpm: 101 },
    { ...second.items[2], textEn: nine, wpm: 0 },
    { ...second.items[3], textEn: nine, wpm: 99, words: [{word: long}] },
    { ...second.items[4], textEn: '', wpm: 99, words: [{word: nine}] },
    { ...second.items[5], textEn: nine + ' again', wpm: 95 },
    { ...second.items[6], textEn: '', wpm: 95 },
  ];
  const final = batch(120, 2, false);
  final.items[0].wpm = 170;
  final.items[1].wpm = 90;
  const cursors = [];
  api.fetchFeed = ({ cursor, filters }) => {
    if (!filters.maxWords) return batch(1);
    assert.deepEqual(filters, { maxWords: 9, maxWpm: 100 });
    cursors.push(cursor);
    if (cursors.length === 1) return first;
    if (cursors.length === 2) return second;
    if (cursors.length === 3) return { items: [], hasMore: true, mode: 'ring', nextCursor: key(120) };
    return final;
  };
  const page = await openPage();
  page.onOpenFilters();
  editField(page, 'maxWords', '9');
  editField(page, 'maxWpm', '100');
  await page.onApplyFilters();
  await flush();
  assert.deepEqual(page._reels.map((c) => c.subtitleId), [113, 117, 121]);
  assert.deepEqual(cursors.slice(1), [first.nextCursor, second.nextCursor, key(120)]);
  assert.equal(page.data.clip.subtitleId, 113);
  assert.equal(page.data.sourceLocal, false);
  page.onNext();
  finish(page);
  assert.equal(page.data.clip.subtitleId, 117);
  page.onUnload();
}

async function smallFilterPool() {
  storage.clear();
  const ids = batch(1, 48).items;
  api.fetchFeed = ({ cursor, filters }) => {
    if (!filters.minWords) return batch(1001);
    const offset = cursor.length === 8 ? 0 : parseInt(cursor, 16) % ids.length;
    const items = ids.slice(offset, offset + 12);
    return { items, mode: 'ring', nextCursor: items.at(-1).ringKey, hasMore: true };
  };
  const page = await openPage();
  page.onOpenFilters();
  editField(page, 'minWords', '1');
  await page.onApplyFilters();
  for (let n = 2; n <= 48; n++) { page.onNext(); finish(page); await flush(); }
  if (page.data.feedRetry) await page.onNext();
  assert.equal(page._hasMore, false);
  assert.equal(page.data.feedRetry, false);
  assert.equal(page.data.clip.subtitleId, 48);
  page.onUnload();
}

async function filterPlayback() {
  storage.clear();
  api.fetchFeed = () => batch(1);
  const page = await openPage();
  const pending = deferred();
  page._startPlayback = definition._startPlayback;
  page._prepareAudio = () => pending.promise;
  let playStarts = [];
  page._playWindow = (_, rel) => playStarts.push(rel);
  page._startPlayback(0);
  page.onOpenFilters();
  pending.resolve({ winStart: 0, winEnd: 5 });
  await flush();
  assert.deepEqual(playStarts, []);
  page.onCloseFilters();
  await flush();
  assert.deepEqual(playStarts, [0]);
  page.data.playing = true;
  page._player.estimatedPos = () => 2.5;
  page.onOpenFilters();
  page.onCloseFilters();
  assert.deepEqual(playStarts, [0, 2.5]);
  page._player.getKind = () => 'user';
  let resumed;
  page._player.playUrl = (...args) => { resumed = args; };
  page.data.evalUserAudioPath = 'sample.wav';
  page.data.playingUserAudio = true;
  page.onOpenFilters();
  page.onCloseFilters();
  assert.deepEqual(resumed, ['sample.wav', 'user', { startSec: 2.5 }]);
  page.onUnload();
}

(async () => {
  await enforceReturnedLimits();
  await filterPools();
  await filterRecovery();
  await filterPlayback();
  await smallFilterPool();
  await continuousFeed();
  await slowPageAndBackSwipe();
  await retryAndDuplicates();
  await boundedScanAndStaleResponse();
  await hiddenFirstPage();
  console.log('✓ reels-window 连刷 125 句、同句重映射、回看、续取、重试与过期回包全部通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });
