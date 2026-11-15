/**
 * utils/subject.js — 统一主体标识（user:<uid> / guest:<anonymousId> / pending）
 * 抽自 pages/home/daily-challenge.js v2，供今日挑战与原声微流共用。
 */
const authStore = require('../store/authStore');

let memoryAnonymousId = '';

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
    /* Session state still works. */
  }
}

function anonymousId() {
  if (!memoryAnonymousId) {
    memoryAnonymousId =
      read('studio_daily_anonymous_id') ||
      'guest_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2);
  }
  write('studio_daily_anonymous_id', memoryAnonymousId);
  return memoryAnonymousId;
}

function subject() {
  const auth = authStore.getState();
  const uid = auth.userInfo && auth.userInfo.userid;
  if (auth.isLoggedIn && auth.token && !uid) return 'pending';
  return auth.isLoggedIn && auth.token && uid
    ? 'user:' + uid
    : 'guest:' + anonymousId();
}

function hashHex8(value) {
  let h = 2166136261;
  const str = String(value || '');
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

module.exports = { anonymousId, subject, hashHex8 };
