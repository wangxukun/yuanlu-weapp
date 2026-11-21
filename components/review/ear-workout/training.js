const { get, post } = require('../../../utils/request');
const { fromFeedItem } = require('../../../pages/discover/reels-api');
const { scoreTier } = require('../../../utils/speech-core');

async function fetchBatch(cursor, day, level, resume) {
  const query = [ ['cursor', cursor], ['day', day], ['level', level], ['resume', resume ? '1' : '0'] ]
    .map(([key, value]) => key + '=' + encodeURIComponent(value || '')).join('&');
  const body = await get('/api/clips/blind-train?' + query, null, { showError: false });
  if (!body || !body.success || !Array.isArray(body.data.items)) throw new Error('切片加载失败');
  return { day: body.data.day, startCursor: body.data.startCursor, firstNumber: body.data.firstNumber, nextCursor: body.data.nextCursor, hasMore: body.data.hasMore,
    items: body.data.items.map(fromFeedItem) };
}

function answerWords(value) {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[‘’]/g, "'");
  return normalized.match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

// 用最长公共子序列对齐，评测漏掉一个词时后续角标仍对准原句。
function align(parts, entries) {
  const indices = parts.map((p, i) => p.key ? i : -1).filter(i => i >= 0);
  const keys = entries.map(entry => answerWords(String(entry.word || '')).join(' '));
  const lengths = Array.from({ length: indices.length + 1 }, () => new Array(keys.length + 1).fill(0));
  for (let i = indices.length - 1; i >= 0; i--) {
    for (let j = keys.length - 1; j >= 0; j--) {
      lengths[i][j] = parts[indices[i]].key === keys[j] ? 1 + lengths[i + 1][j + 1] :
        Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < indices.length && j < keys.length) {
    if (parts[indices[i]].key === keys[j]) { pairs.push([parts[indices[i++]], entries[j++]]); }
    else if (lengths[i + 1][j] > lengths[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function sentenceParts(clip, scores = []) {
  const parts = (clip.textEn.match(/[A-Za-zÀ-ž0-9]+(?:['’][A-Za-zÀ-ž0-9]+)*|[^A-Za-zÀ-ž0-9]+/g) || [])
    .map((text, i) => ({ i, text, key: answerWords(text)[0] || '', score: null }));
  for (const [part, word] of align(parts, clip.words || [])) {
    part.start = word.start;
    part.end = word.end;
  }
  for (const [part, word] of align(parts, scores)) {
    part.score = word.score;
    part.tier = scoreTier(word.score);
  }
  return parts;
}

function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

function storageKey() {
  const user = require('../../../store/authStore').getState().userInfo;
  return user && (user.userid || user.id || user.email) ? 'blind-train:' + (user.userid || user.id || user.email) : '';
}

function readDay() {
  const key = storageKey();
  let saved;
  try { saved = key && wx.getStorageSync(key); } catch (_) { /* 本地成绩不可读 */ }
  if (saved && saved.day === today())
    return { day: saved.day, scores: saved.scores || {}, seen: saved.seen || {}, progress: saved.progress || {} };
  return { day: today(), scores: {}, seen: {}, progress: {} };
}

function writeDay(saved) {
  const key = storageKey();
  try { if (key) wx.setStorageSync(key, saved); } catch (_) { /* 空间不足时仍可继续练习 */ }
}

function logPractice(progress) {
  return post('/api/clips/blind-train', progress, { showError: false });
}
module.exports = { answerWords, fetchBatch, sentenceParts, readDay, writeDay, today, logPractice };
