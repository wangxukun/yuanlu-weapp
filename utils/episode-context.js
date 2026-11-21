/**
 * utils/episode-context.js — 语境原声解析器（2026-11-15 用户裁决放开红线：
 * 「听原声语境」允许使用整集字幕接口 /api/episode/subtitles 解析签名整集
 * URL + 字幕句窗口，播放走 audio-clip 显式窗口模式）
 *
 * A工程 pages/home/smart-review.js resolveAudio 同款匹配链：
 *   enText 精确 → 归一化（忽略大小写/标点/空白）→ timestamp 落窗且句含生词。
 * 剧集级结果缓存 2 小时（签名 URL 有效期内复用；失败不缓存可重试）。
 */
const { get } = require('./request');

const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/** 文本归一化（audio-clip 同款规则：收藏语境句与字幕文本常有标点差异） */
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[.,!?;:"'’“”()\-—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// episodeid → { promise, at }
const episodeCache = new Map();

/** 拉取剧集字幕与签名整集音频（未登录仅回前 180s 预览——窗口越界时由调用方 toast） */
function resolveEpisode(episodeid) {
  const hit = episodeCache.get(episodeid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = get('/api/episode/subtitles', { id: episodeid }, { showError: false, timeout: 15000 })
    .then((body) => {
      if (!body || !body.success || !Array.isArray(body.data) || !body.audioUrl) {
        throw new Error('原声字幕加载失败');
      }
      const url = /^https?:\/\//i.test(body.audioUrl) ? body.audioUrl.replace(/^http:/i, 'https:') : '';
      if (!url) throw new Error('原声暂不可用');
      return { url, subs: body.data };
    });
  episodeCache.set(episodeid, { promise, at: Date.now() });
  promise.catch(() => episodeCache.delete(episodeid)); // 失败不缓存
  return promise;
}

function findSubtitle(subs, p) {
  const text = String((p && p.text) || '').trim();
  const word = String((p && p.word) || '').toLowerCase();
  const ts = p && typeof p.timestamp === 'number' && Number.isFinite(p.timestamp) ? p.timestamp : null;

  const cleaned = subs.filter((s) => s && s.textEn);
  const sameText = (s) => text && normalizeText(s.textEn) === normalizeText(text);
  return (
    (p.subtitleId != null && cleaned.find((s) => s.id === p.subtitleId && (!text || sameText(s)))) ||
    (ts != null && cleaned.find((s) => Number(s.start) <= ts && ts < Number(s.end) && sameText(s))) ||
    (text ? cleaned.find((s) => s.textEn.trim() === text) : null) ||
    (text ? cleaned.find((s) => normalizeText(s.textEn) === normalizeText(text)) : null) ||
    (ts != null && word
      ? cleaned.find(
          (s) =>
            Number(s.start) <= ts &&
            ts < Number(s.end) &&
            (' ' + normalizeText(s.textEn) + ' ').includes(' ' + normalizeText(word) + ' '),
        )
      : null)
  );
}

/**
 * 解析「语境句 → 整集窗口」。
 * @param {Object} p
 * @param {string} p.episodeid
 * @param {string} [p.text] 语境句（生词本 contextSentence / 弱项本 targetText）
 * @param {string} [p.word] 生词（timestamp 兜底分支的句内包含校验）
 * @param {number} [p.timestamp] 词在剧集中的秒位（兜底）
 * @returns {Promise<{url,start,end,words}>} 命中字幕行窗口；未命中抛错（调用方 toast）
 */
async function resolveContext(p) {
  const episodeid = p && p.episodeid;
  if (!episodeid) throw new Error('缺少剧集信息');
  const { url, subs } = await resolveEpisode(episodeid);
  const target = findSubtitle(subs, p);
  if (!target) throw new Error('未找到该句的原声语境');
  const start = Number(target.start) || 0;
  const end = Number(target.end) || 0;
  if (!(end > start)) throw new Error('原声窗口无效');
  return {
    url,
    start,
    end,
    words: Array.isArray(target.words) ? target.words : [],
  };
}

module.exports = { resolveEpisode, resolveContext, findSubtitle };
