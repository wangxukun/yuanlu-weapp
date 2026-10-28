/**
 * utils/scene-favorites.js — 微剧场收藏（本地收藏夹，RESHAPE-TASK T5.2）
 *
 * 收藏对象为「微剧场」本身（sceneid + 明信片快照），存 wx storage：
 * 探索画廊的明信片卡一键收藏，favorites 页「收藏的微剧场」Tab 消费。
 * 纯本地（无需登录/后端表），容量上限 200，超出按最旧淘汰。
 */
const KEY = 'sceneFavorites';
const MAX = 200;

function load() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function save(list) {
  try {
    wx.setStorageSync(KEY, list);
  } catch (e) {
    /* 存储异常静默：收藏丢失不阻断 */
  }
}

function list() {
  return load();
}

function has(sceneid) {
  return load().some((x) => x && x.sceneid === sceneid);
}

/** 收藏/取消（toggle）：scene = { sceneid, title, coverUrl, en, zh, start, end, situationTag, cefrLabel } */
function toggle(scene) {
  const cur = load();
  const idx = cur.findIndex((x) => x && x.sceneid === scene.sceneid);
  if (idx >= 0) {
    cur.splice(idx, 1);
    save(cur);
    return false; // 已取消
  }
  cur.unshift({ ...scene, savedAt: Date.now() });
  if (cur.length > MAX) cur.length = MAX;
  save(cur);
  return true; // 已收藏
}

function remove(sceneid) {
  const cur = load().filter((x) => x && x.sceneid !== sceneid);
  save(cur);
}

module.exports = { list, has, toggle, remove, KEY };
