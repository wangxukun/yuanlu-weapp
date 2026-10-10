/**
 * utils/subtitle-cache.js — 剧集字幕接口内存缓存（GET /api/episode/subtitles）
 *
 * 背景（长剧集精读页加载慢，2026-10-10）：160min 剧集的字幕接口带全量词级
 * 时间轴，响应体可达数 MB。原链路里同一份字幕会被重复下载：
 *   - audioManager.playEpisode 在剧集无直链时拉一次（只为取 audioUrl）；
 *   - 精读页 _bootstrap 再拉一次（取字幕）；
 *   - 退出精读页再进、登录态不变的 singletonReload 等又各拉一次。
 * 大包串行/并行重复下载 + JSON 解析阻塞逻辑线程，是「打开精读页加载字幕很慢」
 * 的主因之一。本模块把这些调用收口为一份：
 *   - 在途去重：同 key 并发请求复用同一个 Promise（起播与进页并发只下一次）；
 *   - 短 TTL：15min 内复用（后端签发的 OSS 直链有效期 3h，留足余量）；
 *   - LRU 上限 2 份：长剧集字幕对象体量大，避免常驻内存膨胀；
 *   - 只缓存「有字幕」的成功响应：后端 OSS 拉取失败降级为空字幕时不落缓存，
 *     下次进入可重试；请求失败即剔除；
 *   - key 含登录 token：游客（裁至前 180s、无直链）与登录态（全量 + 直链）
 *     的响应互不串用，登录态翻转后自然走新请求。
 *
 * 大包下载给更宽的超时（30s，request 默认 10s 在弱网下长剧集易超时失败）。
 */
const { get } = require('./request');

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 2;
const TIMEOUT_MS = 30000;

const cache = new Map(); // key → { at, promise }

function tokenOf() {
  try {
    return (typeof wx !== 'undefined' && wx.getStorageSync && wx.getStorageSync('token')) || '';
  } catch (e) {
    return '';
  }
}

function keyOf(episodeid) {
  return String(episodeid) + '|' + tokenOf();
}

function hasSubtitles(body) {
  return !!(body && Array.isArray(body.data) && body.data.length > 0);
}

/**
 * 拉取剧集字幕（带缓存）。
 * @param {string} episodeid
 * @param {{force?: boolean, showError?: boolean}} [opts]
 *   force 跳过缓存强制重拉（重试按钮）；showError 透传 request（默认 true）
 * @returns {Promise<{success, data: Array, audioUrl}>} 与 request.get 同口径的响应体
 */
function fetchSubtitles(episodeid, opts) {
  const o = opts || {};
  const key = keyOf(episodeid);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && !o.force && now - hit.at < TTL_MS) {
    // LRU 触碰：移到队尾
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }

  const entry = { at: now, promise: null };
  entry.promise = get('/api/episode/subtitles?id=' + episodeid, null, {
    showError: o.showError !== false,
    timeout: TIMEOUT_MS,
  }).then(
    (body) => {
      // 空字幕（后端降级）不缓存，下次进入重试
      if (!hasSubtitles(body) && cache.get(key) === entry) cache.delete(key);
      return body;
    },
    (err) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }
  );

  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return entry.promise;
}

/** 剔除某集缓存（不传则全部清空） */
function invalidate(episodeid) {
  if (episodeid == null) {
    cache.clear();
    return;
  }
  const prefix = String(episodeid) + '|';
  Array.from(cache.keys()).forEach((k) => {
    if (k.indexOf(prefix) === 0) cache.delete(k);
  });
}

module.exports = {
  fetchSubtitles,
  invalidate,
  _size: () => cache.size, // 测试钩子
  TTL_MS,
  MAX_ENTRIES,
};
