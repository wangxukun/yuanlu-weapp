/**
 * pages/discover/reels-session.js — 原声微流环形游标与本地已看 LRU 存储
 *
 * 存储键：reels_feed_v1:<owner>
 * 结构：{ v: 1, cursor: string, lap: number, updatedAt: number, seen: [[key, dayNum, count], ...] }
 */
const { subject, hashHex8 } = require('../../utils/subject');

const VERSION = 1;
const CAPACITY = 600;
const TTL_DAYS = 30;
const DAY_MS = 86400000;

function read(key) {
  try {
    return wx.getStorageSync(key);
  } catch (e) {
    return null;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    /* Memory state still works. */
  }
}

function todayDayNum(nowMs) {
  const ms = typeof nowMs === 'number' ? nowMs : Date.now();
  return Math.floor((ms + 8 * 3600000) / DAY_MS);
}

function storageKey(owner) {
  return 'reels_feed_v1:' + owner;
}

function initialCursor(owner) {
  return hashHex8(owner);
}

function clipSeenKey(clip) {
  if (!clip) return '';
  if (clip.episodeid && clip.subtitleId != null) {
    return clip.episodeid + ':' + clip.subtitleId;
  }
  return 'local:' + (clip.id || clip.clipid || '');
}

function validCursor(c) {
  return typeof c === 'string' && /^[0-9a-f]{1,32}$/.test(c);
}

function normalizeState(raw, owner, nowDay) {
  const minDay = nowDay - TTL_DAYS;
  const fallbackCursor = initialCursor(owner);
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION) {
    return {
      v: VERSION,
      cursor: fallbackCursor,
      lap: 0,
      updatedAt: Date.now(),
      seen: [],
    };
  }
  const seen = Array.isArray(raw.seen)
    ? raw.seen
        .filter(
          (row) =>
            Array.isArray(row) &&
            typeof row[0] === 'string' &&
            row[0] &&
            Number.isInteger(row[1]) &&
            row[1] >= minDay &&
            row[1] <= nowDay + 1
        )
        .sort((a, b) => a[1] - b[1])
        .slice(-CAPACITY)
    : [];
  return {
    v: VERSION,
    cursor: validCursor(raw.cursor) ? raw.cursor : fallbackCursor,
    lap: Number.isInteger(raw.lap) && raw.lap >= 0 ? raw.lap : 0,
    updatedAt: Number(raw.updatedAt) || Date.now(),
    seen,
  };
}

function loadSession(owner, nowMs) {
  const nowDay = todayDayNum(nowMs);
  const effectiveOwner =
    !owner || owner === 'pending' ? 'guest:pending' : owner;
  let raw = read(storageKey(effectiveOwner));
  if (!raw && effectiveOwner.startsWith('user:')) {
    const guestId = read('studio_daily_anonymous_id');
    if (guestId) {
      const guestRaw = read(storageKey('guest:' + guestId));
      if (guestRaw && guestRaw.v === VERSION) {
        raw = guestRaw;
        write(storageKey(effectiveOwner), raw);
      }
    }
  }
  return normalizeState(raw, effectiveOwner, nowDay);
}

function saveSession(owner, state) {
  if (!owner || owner === 'pending') return;
  write(storageKey(owner), state);
}

function recordSeen(state, clips, nowMs) {
  const nowDay = todayDayNum(nowMs);
  const minDay = nowDay - TTL_DAYS;
  const map = new Map();
  (state.seen || []).forEach((row) => {
    if (row[1] >= minDay) map.set(row[0], [row[0], row[1], row[2] || 1]);
  });
  (clips || []).forEach((c) => {
    const k = clipSeenKey(c);
    if (!k) return;
    const old = map.get(k);
    map.set(k, [k, nowDay, old ? (old[2] || 1) + 1 : 1]);
  });
  state.seen = Array.from(map.values())
    .sort((a, b) => a[1] - b[1])
    .slice(-CAPACITY);
  state.updatedAt = typeof nowMs === 'number' ? nowMs : Date.now();
  return state;
}

function filterAndFallback(state, items, targetCount, nowMs) {
  const nowDay = todayDayNum(nowMs);
  const minDay = nowDay - TTL_DAYS;
  const seenMap = new Map();
  (state.seen || []).forEach((row) => {
    if (row[1] >= minDay) seenMap.set(row[0], row[1]);
  });
  const fresh = [];
  const stale = [];
  const batchKeys = new Set();
  (items || []).forEach((it) => {
    const k = clipSeenKey(it);
    if (!k || batchKeys.has(k)) return;
    batchKeys.add(k);
    if (seenMap.has(k)) {
      stale.push({ item: it, seenDay: seenMap.get(k) });
    } else {
      fresh.push(it);
    }
  });
  stale.sort((a, b) => a.seenDay - b.seenDay);
  const cap = targetCount || 12;
  if (fresh.length >= cap) {
    return { items: fresh.slice(0, cap), softFallbackUsed: false };
  }
  const combined = fresh.concat(
    stale.slice(0, cap - fresh.length).map((s) => s.item)
  );
  return {
    items: combined,
    softFallbackUsed: combined.length > fresh.length,
  };
}

module.exports = {
  subject,
  initialCursor,
  clipSeenKey,
  loadSession,
  saveSession,
  recordSeen,
  filterAndFallback,
  todayDayNum,
};
