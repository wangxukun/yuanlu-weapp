/**
 * pages/discover/reels-api.js — 原声微流后端服务层（yuanlu 真实语料）
 *
 * 三个后端契约（均为 A工程 utils/request 直连，走 config.js BASE_URL）：
 *   GET  /api/clips/feed?page=N        → { data: { items[], hasMore } }
 *   GET  /api/clips/{clipid}/audio     → { data: { url, duration, clipOffset } }（唯一音频出口）
 *   POST /api/clips/deep-dive          → { data: { connectedSpeech, toneAndMood,
 *                                                paraphrase, speakingTip, source } }
 *
 * 统一视图模型（真实/本地 mock 双源同构，页面播放与扫光逻辑零分支）：
 *   { id, episodeid, subtitleId, showTitle, topic, difficulty, coverUrl,
 *     start, end, duration, textEn, textCn, words[]（字幕时间轴·绝对秒）,
 *     wpm, isExclusive, clipAudioUrl, audioOffset, real }
 *   播放口径：物理切片文件本地时间轴 0→fileDur，扫光词时 = word.start −
 *   audioOffset（对齐 weapp speech-core「字幕统一减 clipOffset」协议）；
 *   本地 mock 为整轨窗口 [start,end]、offset=0。
 *
 * 网络不可达时页面回落 reels-corpus 本地语料（real:false），沙箱永不白屏。
 */
const { get, post } = require('../../utils/request');
const { filterKey } = require('./reels-filters');
const corpus = require('./reels-corpus');

/** Tokenize sentence by whitespace for word-tap when timed words are absent */
function tokenizeTextEn(textEn) {
  if (!textEn || typeof textEn !== 'string') return [];
  return textEn.trim().split(/\s+/).filter(Boolean);
}

/** Generate a persistent pronunciation secret tip when backend phoneticTip is absent */
function buildFallbackPhoneticTip(textEn, wpm, words) {
  const numWpm = Number(wpm) || 0;
  if (numWpm > 0) {
    return '本句语速 ' + numWpm + ' 词/分钟，建议 0.75x 慢速跟上后再常速跟读。';
  }
  const list =
    Array.isArray(words) && words.length > 0
      ? words.map((w) => (w && w.word) || '')
      : tokenizeTextEn(textEn);
  // Detect common consonant-to-vowel linking pair
  for (let i = 0; i < list.length - 1; i++) {
    const a = String(list[i] || '').replace(/[^\w']/g, '');
    const b = String(list[i + 1] || '').replace(/[^\w']/g, '');
    if (a && b && /[bcdfghjklmnpqrstvwxz]$/i.test(a) && /^[aeiou]/i.test(b)) {
      return "注意 '" + a + ' ' + b + "' 处的辅元连读与介词/冠词弱读过渡。";
    }
  }
  return '注意句中实词重读与虚词弱读的节奏对比，跟随扫光捕捉母语语感。';
}

/** 后端 feed item → 统一视图模型 */
function fromFeedItem(it) {
  const words = Array.isArray(it.words) ? it.words : [];
  const textEn = it.textEn || '';
  const wpm = it.wpm || 0;
  return {
    id: it.clipid,
    episodeid: it.episodeid,
    subtitleId: it.subtitleId,
    showTitle: it.podcastTitle || it.showTitle || '原声节目',
    topic: it.topic || '',
    difficulty: it.difficulty || '',
    coverUrl: it.coverUrl || '',
    start: it.start,
    end: it.end,
    duration: it.duration,
    textEn,
    textCn: it.textCn,
    words,
    tokens: words.length > 0 ? [] : tokenizeTextEn(textEn),
    phoneticTip: it.phoneticTip || buildFallbackPhoneticTip(textEn, wpm, words),
    wpm,
    isExclusive: !!it.isExclusive,
    clipAudioUrl: it.clipAudioUrl || null,
    // 预签条为精确 cutStart；懒取条先用 start 近似，网关取回后覆盖
    audioOffset: typeof it.clipOffset === 'number' ? it.clipOffset : it.start,
    ringKey: it.ringKey || '',
    swOn: false,
    activeIdx: -1,
    pastIdx: -1,
    real: true,
  };
}

/** 本地 mock 语料 → 同构视图模型（整轨窗口，offset=0） */
function fromLocalClip(c) {
  const words = Array.isArray(c.words) ? c.words : [];
  const textEn = c.textEn || '';
  const wpm = c.wpm || 0;
  return {
    id: c.id,
    episodeid: '',
    subtitleId: null,
    showTitle: c.showTitle,
    topic: c.topic,
    difficulty: c.difficulty,
    coverUrl: c.coverUrl,
    start: c.start,
    end: c.end,
    duration: c.end - c.start,
    textEn,
    textCn: c.textCn,
    words,
    tokens: words.length > 0 ? [] : tokenizeTextEn(textEn),
    phoneticTip: c.phoneticTip || buildFallbackPhoneticTip(textEn, wpm, words),
    wpm,
    isExclusive: false,
    clipAudioUrl: c.audioUrl, // soundhelix 整轨即音源
    audioOffset: 0,
    swOn: false,
    activeIdx: -1,
    pastIdx: -1,
    real: false,
  };
}

/** 拉取切片流一页（支持 page 或 ring cursor；level 可选：cefrLevel 精确过滤，如 B1/B2/C1）；失败返回 null */
async function fetchFeed(pageOrOpts, level) {
  let page = 1;
  let cursor = null;
  let lvl = level;
  if (pageOrOpts && typeof pageOrOpts === 'object') {
    page = pageOrOpts.page || 1;
    cursor = typeof pageOrOpts.cursor === 'string' ? pageOrOpts.cursor : null;
    lvl = pageOrOpts.level || level;
  } else {
    page = pageOrOpts || 1;
  }
  let url = '/api/clips/feed?page=' + page;
  if (cursor !== null) url += '&cursor=' + encodeURIComponent(cursor);
  const extra = pageOrOpts && typeof pageOrOpts === 'object' && pageOrOpts.filters;
  const query = extra && filterKey(extra);
  if (query) url += '&' + query;
  if (lvl && !(extra && extra.level)) url += '&level=' + encodeURIComponent(lvl);
  const body = await get(url, null, { showError: false });
  if (body && body.success && Array.isArray(body.data && body.data.items)) {
    return {
      items: body.data.items.map(fromFeedItem),
      hasMore: !!body.data.hasMore,
      nextCursor: body.data.nextCursor || '',
      wrapped: !!body.data.wrapped,
      mode: body.data.mode || 'legacy',
    };
  }
  return null;
}

/** 懒取物理切片直链（预签缺失/过期条；OSS 永久缓存后秒回） */
async function fetchClipAudio(clipid) {
  const body = await get('/api/clips/' + encodeURIComponent(clipid) + '/audio', null, { showError: false });
  if (body && body.success && body.data && body.data.url) {
    return {
      url: body.data.url,
      duration: Number(body.data.duration) || 0,
      clipOffset: Number(body.data.clipOffset) || 0,
      exclusive: false,
    };
  }
  // 403 会员专享：request 抛错走 catch；这里兜成功但无 url 的形况
  return { exclusive: body && body.code === 'PREMIUM_REQUIRED' };
}

/** 预签直链是否仍在有效期（60s 安全余量；无 Expires 参数按未过期）。
 *  切片签名仅 1 小时：今日挑战等长生命周期对象会把预热直链写进当日缓存，
 *  过期后仍直接播 → OSS 403 → InnerAudioContext onError「音频播放失败」。 */
function freshAudioUrl(url, nowMs) {
  const m = /[?&]Expires=(\d+)/.exec(String(url || ''));
  if (!m) return true;
  return Number(m[1]) * 1000 - (nowMs == null ? Date.now() : nowMs) > 60000;
}

/** 句级语言学四维分析；失败/限流兜底返回 null（页面用本地兜底文案） */
async function fetchDeepDive(sentence) {
  const body = await post('/api/clips/deep-dive', { sentence }, { showError: false });
  if (body && body.success && body.data && body.data.connectedSpeech) {
    return {
      connectedSpeech: body.data.connectedSpeech,
      toneAndMood: body.data.toneAndMood,
      paraphrase: body.data.paraphrase,
      speakingTip: body.data.speakingTip,
      source: body.data.source === 'llm' ? 'llm' : 'fallback',
    };
  }
  return null;
}

/** 本地语料全量（网络不可达时的沙箱回落源） */
function localReels() {
  return corpus.map(fromLocalClip);
}

/**
 * 意图定制选料匹配：POST /api/scenes/match {q, levels[]}
 * → { clips[](feed item 同构), scene|null, source: 'llm'|'keyword' }
 * 失败返回 null（调用方回落难度选料 feed）。
 */
async function matchStudio(goal, levels) {
  const body = await post(
    '/api/scenes/match',
    { q: goal, levels: levels || [] },
    // 冷调用实测 ~20s（扩词+快裁两次 LLM，30min 缓存后秒回）——
    // 默认 10s 超时会误判网络失败触发降级，此处单独放宽
    { showError: false, timeout: 30000 }
  );
  if (body && body.success && body.data) {
    // [2026-11-11] scenes：top-2 微场景（旧端仅 scene 时归一为单元素数组）
    const scenes = Array.isArray(body.data.scenes)
      ? body.data.scenes
      : body.data.scene
        ? [body.data.scene]
        : [];
    return {
      clips: Array.isArray(body.data.clips) ? body.data.clips.map(fromFeedItem) : [],
      scenes,
      scene: body.data.scene || null,
      source: body.data.source === 'llm' ? 'llm' : 'keyword',
      // [UX] 后端语义快裁判「无相关语料」→ 前端诚实提示，不再静默降级
      noMatch: body.data.noMatch === true,
    };
  }
  return null;
}

/** 拉取动态灵感预设（GET /api/scenes/preset-ideas）；失败返回 null（调用方用静态兜底） */
async function fetchPresetIdeas() {
  const body = await get('/api/scenes/preset-ideas', null, { showError: false });
  if (body && body.success && body.data && Array.isArray(body.data.ideas) && body.data.ideas.length >= 3) {
    return body.data.ideas.map((it) => ({
      icon: it.icon || '💡',
      text: it.text || '',
      tag: it.tag || '',
    }));
  }
  return null;
}

module.exports = { fromFeedItem, fromLocalClip, tokenizeTextEn, buildFallbackPhoneticTip, fetchFeed, fetchClipAudio, freshAudioUrl, fetchDeepDive, localReels, matchStudio, fetchPresetIdeas };
