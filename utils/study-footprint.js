/**
 * utils/study-footprint.js — 精研足迹（本地，RESHAPE-TASK T5.2）
 *
 * 微剧场精研室每次进入即记一笔（同 sceneid 去重置顶），history 页
 * 「精研足迹」消费：{ sceneid, title, coverUrl, duration, situationTag, at }。
 * 纯本地（无需登录），容量上限 200。
 */
const KEY = 'studyFootprint';
const MAX = 200;

function load() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function list() {
  return load();
}

/** 记录足迹：同 sceneid 去重并置顶（最近精研优先） */
function record(scene) {
  if (!scene || !scene.sceneid) return;
  const cur = load().filter((x) => x && x.sceneid !== scene.sceneid);
  cur.unshift({
    sceneid: scene.sceneid,
    title: scene.title || '',
    coverUrl: scene.coverUrl || '',
    duration: scene.duration || 0,
    situationTag: scene.situationTag || '',
    at: Date.now(),
  });
  if (cur.length > MAX) cur.length = MAX;
  try {
    wx.setStorageSync(KEY, cur);
  } catch (e) {
    /* 静默 */
  }
}

function clearAll() {
  try {
    wx.setStorageSync(KEY, []);
  } catch (e) {
    /* 静默 */
  }
}

module.exports = { list, record, clearAll, KEY };
