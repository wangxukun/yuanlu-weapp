const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const storage = new Map();
let auth = { isLoggedIn: false, token: '', userInfo: null };

const authStore = {
  getState: () => auth,
  subscribe: () => () => {},
};

const wx = {
  getStorageSync: (k) => storage.get(k),
  setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
};

function load(file, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, file), 'utf8'),
    {
      module,
      exports: module.exports,
      require: (s) => imports[s] || {},
      wx,
      console,
      Date,
      Math,
      Array,
      Number,
      Object,
      String,
      Set,
      Map,
    },
    { filename: file }
  );
  return module.exports;
}

const subjectMod = load('utils/subject.js', { '../store/authStore': authStore });
const sessionMod = load('pages/discover/reels-session.js', {
  '../../utils/subject': subjectMod,
  './reels-filters': require('../pages/discover/reels-filters'),
});

// 1. Guest initial cursor is deterministic per anonymousId, and distinct across subjects
const ownerGuest = sessionMod.subject();
assert(ownerGuest.startsWith('guest:guest_'));
const s1 = sessionMod.loadSession(ownerGuest);
assert.equal(s1.cursor.length, 8);
assert.equal(s1.seen.length, 0);

// 2. Recording seen clips updates LRU and respects capacity & TTL
const baseMs = Date.parse('2026-11-14T10:00:00Z');
const fakeClips = Array.from({ length: 12 }, (_, i) => ({
  id: 'c-' + i,
  episodeid: 'ep-' + i,
  subtitleId: i,
  ringKey: (0x10000000 + i).toString(16),
}));
sessionMod.recordSeen(s1, fakeClips.slice(0, 5), baseMs);
s1.cursor = fakeClips[4].ringKey;
sessionMod.saveSession(ownerGuest, s1);

const reloaded = sessionMod.loadSession(ownerGuest, baseMs);
assert.equal(reloaded.cursor, fakeClips[4].ringKey);
assert.equal(reloaded.seen.length, 5);

// 3. Filtering removes seen items and preserves fresh ones
const f1 = sessionMod.filterAndFallback(reloaded, fakeClips, 6, baseMs);
assert.equal(f1.softFallbackUsed, false);
assert.equal(
  f1.items.map((x) => x.id).join(','),
  ['c-5', 'c-6', 'c-7', 'c-8', 'c-9', 'c-10'].join(',')
);

// 4. Soft fallback orders by oldest seen when pool is exhausted
sessionMod.recordSeen(reloaded, fakeClips.slice(5), baseMs + 5 * 86400000);
const fExhausted = sessionMod.filterAndFallback(
  reloaded,
  fakeClips,
  5,
  baseMs + 5 * 86400000
);
assert.equal(fExhausted.softFallbackUsed, true);
assert.equal(fExhausted.items.length, 5);
assert.equal(
  fExhausted.items.map((x) => x.id).join(','),
  ['c-0', 'c-1', 'c-2', 'c-3', 'c-4'].join(','),
  'Oldest seen clips are surfaced first during soft fallback'
);

// 5. TTL eviction (> 30 days) makes items fresh again
const after31Days = baseMs + 31 * 86400000;
const fAfterTtl = sessionMod.filterAndFallback(
  reloaded,
  fakeClips.slice(0, 5),
  5,
  after31Days
);
assert.equal(fAfterTtl.softFallbackUsed, false);
assert.equal(fAfterTtl.items.length, 5);

// 6. Guest -> User login migration copies cursor & seen when user state is empty
auth = { isLoggedIn: true, token: 't1', userInfo: { userid: 'u100' } };
const userOwner = sessionMod.subject();
assert.equal(userOwner, 'user:u100');
const userSession = sessionMod.loadSession(userOwner, baseMs + 5 * 86400000);
assert.equal(userSession.cursor, reloaded.cursor, 'Migrates guest cursor to newly logged-in user');

// 7. Pending auth state does not overwrite storage
auth = { isLoggedIn: true, token: 't2', userInfo: null };
assert.equal(sessionMod.subject(), 'pending');
sessionMod.saveSession('pending', { v: 1, cursor: 'deadbeef', lap: 0, seen: [] });
assert.equal(storage.has('reels_feed_v1:pending'), false);

// 8. Corrupted storage resets cleanly
storage.set('reels_feed_v1:user:u200', { v: 999, cursor: 'INVALID!!', seen: 'bad' });
const recovered = sessionMod.loadSession('user:u200', baseMs);
assert.equal(recovered.cursor, sessionMod.initialCursor('user:u200'));
assert.equal(recovered.seen.length, 0);

// An untouched legacy session has no filter history. Keep its progress for
// when the learner switches back to the unrestricted pool.
const legacyOwner = 'user:legacy';
for (const fields of [{}, { filters: {}, positions: {} }]) {
  storage.set('reels_feed_v1:' + legacyOwner, {
    v: 1, cursor: 'deadbeef', lap: 3, seen: reloaded.seen, ...fields,
  });
  const upgraded = sessionMod.loadSession(legacyOwner, baseMs);
  assert.deepEqual({ ...upgraded.filters }, { maxWords: 10, maxWpm: 100, level: 'A2,B1,B2' });
  assert.equal(upgraded.cursor, sessionMod.initialCursor(legacyOwner));
  assert.equal(upgraded.seen.length, 5);
  sessionMod.switchFilters(upgraded, legacyOwner, {});
  assert.equal(upgraded.cursor, 'deadbeef');
  assert.equal(upgraded.lap, 3);
}

console.log(
  JSON.stringify({
    passed: true,
    cases: [
      'guest-init',
      'cursor-resume',
      'seen-filter',
      'soft-fallback-oldest-first',
      'ttl-30d-expiry',
      'guest-to-user-migration',
      'pending-auth-guard',
      'corrupt-storage-recovery',
      'legacy-defaults-and-unrestricted-cursor',
    ],
  })
);
