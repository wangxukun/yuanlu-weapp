// Real vocabulary review. The server owns proficiency/nextReviewAt; no local SRS writes.
const { get, post } = require('../../utils/request');
const authStore = require('../../store/authStore');
const { getIntervalLabel } = require('../../utils/srs');
const reelsApi = require('../discover/reels-api');
const { sentenceWindow } = require('../../utils/clip-window');
const BATCH_SIZE = 4;
const QUALITY = { unknown: 0, fuzzy: 1, know: 2 };
const text = (v) => typeof v === 'string' ? v : '';
const normalize = (s) => text(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const audioUrl = (v) => /^https?:\/\//i.test(text(v)) ? v.replace(/^http:/i, 'https:') : '';

function emptyData() {
  return {
    reviewStatus: 'guest', reviewMessage: '登录后复习你的生词本', reviewDueTotal: 0,
    smartReview: [], activeReviewIdx: 0, cardFlipped: false, reviewDeckOpen: false,
    reviewDoneCount: 0, reviewAllDone: false, reviewForgotCount: 0,
    reviewSubmitting: false, reviewSubmitError: '', reviewNeedsReload: false,
    reviewPlayingId: '', reviewLoadingId: '', reviewWordIdx: -1, reviewAudioKind: '',
  };
}

function contextWords(sentence, word) {
  const target = normalize(word);
  return (text(sentence).match(/\S+\s*/g) || []).map((w) => ({ word: w, isT: normalize(w) === target }));
}

function card(v, now) {
  const dict = v.dictData || {};
  const definitions = Array.isArray(dict.definitions) ? dict.definitions : [];
  const ety = dict.etymology || {};
  const proficiency = Number.isInteger(v.proficiency) && v.proficiency >= 0 ? v.proficiency : 0;
  const contextEn = text(v.contextSentence);
  const date = v.nextReviewAt ? Date.parse(v.nextReviewAt) : null;
  return {
    id: String(v.vocabularyid), vocabularyid: v.vocabularyid, word: v.word,
    definition: text(v.definition) || definitions.map((d) => text(d.meaning_cn)).filter(Boolean).join('；') || '暂无释义',
    pos: definitions.map((d) => text(d.pos)).filter(Boolean).join(' / '),
    phoneticUk: text(dict.phonetics && dict.phonetics.uk), phoneticUs: text(dict.phonetics && dict.phonetics.us),
    etymologyText: text(ety.breakdown) || [text(ety.prefix), text(ety.root), text(ety.suffix)].filter(Boolean).join(' + '),
    memoryHook: text(ety.mnemonic),
    contextEn, contextZh: text(v.translation), episodeid: text(v.episodeid), episodeTitle: text(v.episodeTitle),
    timestamp: typeof v.timestamp === 'number' && Number.isFinite(v.timestamp) && v.timestamp >= 0 ? v.timestamp : null,
    // 语境原声=切片级合规出口：episodeid+语境句（或词秒位）→ context-clip
    // 懒解析 corpus 切片，经 /api/clips/{id}/audio 网关播放（不走整集接口）
    canPlayOriginal: !!v.episodeid && (!!contextEn || (typeof v.timestamp === 'number' && Number.isFinite(v.timestamp) && v.timestamp >= 0)),
    wordAudioUrl: audioUrl(dict.audio_urls && (dict.audio_urls.us || dict.audio_urls.uk)) || audioUrl(v.speakUrl),
    clipWords: contextWords(contextEn, v.word), hasWordTimings: false,
    proficiency, nextReviewAt: v.nextReviewAt || null,
    dueLabel: date == null ? '新词待复习' : now - date >= 86400000 ? '已到期 ' + Math.floor((now - date) / 86400000) + ' 天' : '已到复习时间',
    knowInterval: getIntervalLabel(proficiency, QUALITY.know),
    reviewedToday: false, lastFeedback: '', nextReviewLabel: '',
  };
}

function buildQueue(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('生词数据格式异常');
  const seen = new Set();
  const due = rows.filter((v) => {
    if (!v || !Number.isInteger(v.vocabularyid) || v.vocabularyid <= 0 || !text(v.word).trim() || seen.has(v.vocabularyid)) return false;
    seen.add(v.vocabularyid);
    return v.status !== 'MASTERED' && (!v.nextReviewAt || Date.parse(v.nextReviewAt) <= now);
  }).sort((a, b) => (Date.parse(a.nextReviewAt || '') || 0) - (Date.parse(b.nextReviewAt || '') || 0) || a.proficiency - b.proficiency || a.vocabularyid - b.vocabularyid);
  return { dueTotal: due.length, cards: due.slice(0, BATCH_SIZE).map((v) => card(v, now)) };
}

/**
 * [2026-11-13 BUG 修复] 在字幕行词序列中定位收藏原句对应的连续片段：
 * 生词本 contextSentence 常是字幕行的子串（收藏切分 vs 现字幕行长度不一，
 * 实测病例：原句 "Slowly but surely, over time, …" ⊂ 字幕行 "This is your
 * daily dip … so that slowly but surely over time …"）——此前包含匹配命中
 * 整行后 patch.contextEn 会把卡片句子替换成整行，语境句突变形同换句。
 * 对齐成功（≥90% token 逐位相等）→ 播放窗口/词级扫光仅取原句片段，
 * 卡片句子保持不变；对齐失败退整行（替换语境句，所见即所播兜底）。
 */
function alignContextSegment(contextNorm, rowWords) {
  const ctx = contextNorm.split(' ').filter(Boolean);
  if (!ctx || ctx.length < 4 || !Array.isArray(rowWords) || !rowWords.length) return null;
  const rowN = rowWords.map((w) => normalize(w.word));
  for (let i = 0; i + ctx.length <= rowN.length; i++) {
    let hit = 0;
    for (let k = 0; k < ctx.length; k++) if (rowN[i + k] === ctx[k]) hit += 1;
    if (hit / ctx.length >= 0.9) return rowWords.slice(i, i + ctx.length);
  }
  return null;
}

/** Locate a real subtitle and use only server-provided timing. Never synthesize timing. */
function resolveAudio(item, body) {
  if (!body || !body.success || !Array.isArray(body.data)) throw new Error('原声字幕加载失败，请重试');
  const url = audioUrl(body.audioUrl);
  if (!url) throw new Error('原声暂不可用，请检查登录或剧集访问权限');
  const subs = body.data.filter((s) => normalize(s.textEn));
  const context = normalize(item.contextEn);
  let target = context && (subs.find((s) => normalize(s.textEn) === context) || subs.find((s) => {
    const candidate = normalize(s.textEn);
    return context.length >= 10 && candidate.length >= 10 && (context.includes(candidate) || candidate.includes(context));
  }));
  if (!target && item.timestamp != null) {
    const word = ' ' + normalize(item.word) + ' ';
    target = subs.find((s) => item.timestamp >= s.start && item.timestamp < s.end && (' ' + normalize(s.textEn) + ' ').includes(word));
  }
  if (!target) throw new Error('未找到该词的原声语境');
  const words = Array.isArray(target.words) ? target.words : [];
  const timed = words.length > 0 && words.every((w, i) => text(w.word) && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start && (!i || w.start >= words[i - 1].start));

  // 原句片段对齐：词级时间可用且原句是字幕行子串 → 只播/只扫原句区间，
  // 卡片语境句保持收藏原句（patch 不含 contextEn）
  if (timed && context) {
    const seg = alignContextSegment(context, words);
    if (seg && seg.length) {
      const start = seg[0].start;
      const end = seg[seg.length - 1].end;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return {
          meta: { url, offset: 0, winStart: start, winEnd: end },
          patch: {
            clipWords: seg.map((w) => ({ word: w.word, start: w.start, end: w.end, isT: normalize(w.word) === normalize(item.word) })),
            hasWordTimings: true,
          },
        };
      }
    }
  }

  const start = timed ? words[0].start : target.start;
  const end = timed ? words[words.length - 1].end : target.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('该句暂无有效原声时间信息');
  return {
    meta: { url, offset: 0, winStart: start, winEnd: end },
    patch: {
      contextEn: target.textEn, contextZh: text(target.textZh) || text(target.textCn) || item.contextZh,
      clipWords: timed ? words.map((w) => ({ word: w.word, start: w.start, end: w.end, isT: normalize(w.word) === normalize(item.word) })) : contextWords(target.textEn, item.word),
      hasWordTimings: timed,
    },
  };
}

const methods = {
  _initSmartReview() {
    this._reviewDisposed = false;
    this._reviewSeq = 0;
    this._reviewAudioSeq = 0;
    this._reviewToken = '';
    this.setData(emptyData());
    this._reviewUnsubscribe = authStore.subscribe(() => {
      if (this._reviewToken !== this._reviewAuthToken()) this._loadSmartReview();
    });
  },

  _reviewAuthToken() {
    const auth = authStore.getState();
    return auth.isLoggedIn ? auth.token || '' : '';
  },

  _loadSmartReview(force) {
    if (this._reviewDisposed) return Promise.resolve();
    const token = this._reviewAuthToken();
    if (token !== this._reviewToken || !token) {
      this._reviewSeq++;
      this._reviewPending = null;
      this._reviewReloadAfterSubmit = false;
      this._reviewToken = token;
      this._stopReviewAudio();
      this.setData(emptyData());
    }
    if (!token) return Promise.resolve();
    if (this.data.reviewSubmitting) {
      this._reviewReloadAfterSubmit = true;
      return Promise.resolve();
    }
    if (this._reviewPending && !force) return this._reviewPending;
    const seq = ++this._reviewSeq;
    this._stopReviewAudio();
    this.setData({ reviewStatus: 'loading', reviewMessage: '正在同步到期生词…', reviewSubmitError: '' });
    const current = () => !this._reviewDisposed && seq === this._reviewSeq && token === this._reviewAuthToken();
    const pending = get('/api/vocabulary/all', null, { showError: false })
      .then((body) => {
        if (!current()) return;
        if (!body || !body.success) throw new Error('生词加载失败');
        const queue = buildQueue(body.data);
        this.setData(Object.assign(emptyData(), {
          reviewStatus: queue.cards.length ? 'ready' : 'empty',
          reviewMessage: queue.cards.length ? '按到期时间排序 · 每轮最多 ' + BATCH_SIZE + ' 词' : '暂无到期生词，收藏新词或到期后再来复习',
          smartReview: queue.cards, reviewDueTotal: queue.dueTotal,
          reviewDeckOpen: this.data.reviewDeckOpen,
        }));
      })
      .catch((err) => {
        if (!current()) return;
        this.setData(Object.assign(emptyData(), {
          reviewStatus: err && err.statusCode === 401 ? 'guest' : 'error',
          reviewMessage: err && err.statusCode === 401 ? '登录已过期，请重新登录' : '复习清单加载失败，请重试',
        }));
      })
      .finally(() => { if (seq === this._reviewSeq) this._reviewPending = null; });
    this._reviewPending = pending;
    return pending;
  },

  onReviewRetry() {
    if (this.data.reviewStatus === 'guest') return wx.navigateTo({ url: '/pages/auth/index' });
    return this._loadSmartReview();
  },

  onReviewPillTap(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (this.data.reviewSubmitting || !Number.isInteger(idx) || !this.data.smartReview[idx]) return;
    this._stopReviewAudio();
    this.setData({ activeReviewIdx: idx, cardFlipped: false, reviewDeckOpen: true });
  },
  onToggleReviewDeck() {
    this._stopReviewAudio();
    this.setData({ reviewDeckOpen: !this.data.reviewDeckOpen });
  },
  onFlipCard() {
    if (!this.data.reviewSubmitting) this.setData({ cardFlipped: !this.data.cardFlipped });
  },
  onResetReview() { return this._loadSmartReview(); },

  async onReviewFeedback(e) {
    const fb = e.currentTarget.dataset.fb;
    const item = this.data.smartReview[this.data.activeReviewIdx];
    if (!Object.prototype.hasOwnProperty.call(QUALITY, fb) || !item || item.reviewedToday || this.data.reviewSubmitting || this.data.reviewNeedsReload || this.data.reviewStatus !== 'ready') return;
    const token = this._reviewAuthToken();
    if (!token || token !== this._reviewToken) return this._loadSmartReview();
    const seq = this._reviewSeq;
    const current = () => !this._reviewDisposed && seq === this._reviewSeq && token === this._reviewAuthToken();
    this._stopReviewAudio();
    this.setData({ reviewSubmitting: true, reviewSubmitError: '' });
    try {
      const body = await post('/api/vocabulary/review', { vocabularyid: item.vocabularyid, quality: QUALITY[fb] }, { showError: false });
      if (!current()) return;
      const v = body && body.data;
      if (!body.success || !v || v.vocabularyid !== item.vocabularyid || !Number.isInteger(v.proficiency) || v.proficiency < 0 || !v.nextReviewAt || !Number.isFinite(Date.parse(v.nextReviewAt))) throw new Error('复习结果未确认');
      const nextDate = new Date(Date.parse(v.nextReviewAt) + 8 * 3600000).toISOString().slice(0, 10);
      const list = this.data.smartReview.map((c) => c.id !== item.id ? c : Object.assign({}, c, {
        reviewedToday: true, lastFeedback: fb, proficiency: v.proficiency, nextReviewAt: v.nextReviewAt,
        nextReviewLabel: fb === 'unknown' ? '仍在到期队列，可再练一轮' : '下次复习：' + nextDate + '（北京时间）',
      }));
      const next = list.findIndex((c) => !c.reviewedToday);
      this.setData({ smartReview: list, reviewDoneCount: list.filter((c) => c.reviewedToday).length,
        reviewForgotCount: list.filter((c) => c.lastFeedback === 'unknown').length,
        reviewAllDone: next < 0, activeReviewIdx: next < 0 ? this.data.activeReviewIdx : next,
        cardFlipped: false, reviewDueTotal: Math.max(0, this.data.reviewDueTotal - (fb === 'unknown' ? 0 : 1)),
      });
      this._loadDashboard(true);
    } catch (err) {
      if (!current()) return;
      if (err && err.statusCode === 401) {
        this.setData(Object.assign(emptyData(), { reviewMessage: '登录已过期，请重新登录' }));
      } else {
        // A timed-out write may have committed. Require a fresh server queue before any retry.
        this.setData({ reviewSubmitError: '保存未确认，请刷新队列后继续', reviewNeedsReload: true });
      }
    } finally {
      if (current()) {
        this.setData({ reviewSubmitting: false });
        if (this._reviewReloadAfterSubmit) {
          this._reviewReloadAfterSubmit = false;
          this._loadSmartReview(true);
        }
      }
    }
  },

  _stopReviewAudio() {
    this._reviewAudioSeq = (this._reviewAudioSeq || 0) + 1;
    if (this._activeKind === 'review') {
      if (this._player) this._player.stop();
      this._audioMeta = null;
      this._activeKind = 'clip';
      this.setData({ playing: false });
    }
    this.setData({ reviewPlayingId: '', reviewLoadingId: '', reviewWordIdx: -1, reviewAudioKind: '' });
  },

  async onPlayReviewAudio(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.smartReview[idx];
    if (!item || !item.canPlayOriginal || this.data.reviewStatus !== 'ready' || this.data.reviewSubmitting) return;
    if ((this.data.reviewPlayingId === item.id && this.data.reviewAudioKind === 'original' && this.data.playing) || this.data.reviewLoadingId === item.id) return this._stopReviewAudio();
    this._pausePlayback();
    this._stopCompilation();
    const prep = ++this._prepToken;
    const seq = ++this._reviewAudioSeq;
    const token = this._reviewAuthToken();
    const current = () => !this._reviewDisposed && seq === this._reviewAudioSeq && prep === this._prepToken && token === this._reviewAuthToken();
    this.setData({ reviewLoadingId: item.id });
    try {
      // 合规切片级出口：语境句懒解析为 corpus 切片 → /api/clips/{id}/audio 网关
      const q = await get('/api/vocabulary/context-clip', {
        episodeid: item.episodeid,
        text: item.contextEn || '',
        word: item.word,
        timestamp: item.timestamp == null ? undefined : item.timestamp,
      }, { showError: false });
      if (!current()) return;
      if (!q || !q.success || !q.data) {
        throw new Error((q && (q.error || q.message)) || '未找到该词的原声语境');
      }
      const clip = q.data;
      const audio = await reelsApi.fetchClipAudio(clip.clipid);
      if (!current()) return;
      if (audio && audio.exclusive) throw new Error('该原声语料为会员专享');
      if (!audio || !audio.url) throw new Error('原声暂不可用，请重试');
      const meta = Object.assign({ url: audio.url }, sentenceWindow(clip, audio.clipOffset));
      const words = Array.isArray(clip.words) ? clip.words : [];
      this.setData({ reviewPlayingId: item.id, reviewAudioKind: 'original', reviewWordIdx: -1,
        activeIdx: -1, dailyActiveIdx: -1, sceneActiveIdx: -1, relayActiveSegId: '', activeWordIndex: -1 });
      this._activeKind = 'review';
      this._lastWordIdx = -99;
      this._relaySeg = { words, winEnd: meta.winEnd };
      this._audioMeta = meta;
      this._player.playUrl(meta.url, 'studio', { startSec: meta.winStart, endSec: meta.winEnd });
    } catch (err) {
      if (current()) wx.showToast({ title: err.message || '原声加载失败，请重试', icon: 'none' });
    } finally {
      if (current()) this.setData({ reviewLoadingId: '' });
    }
  },

  onPlayReviewWord(e) {
    const item = this.data.smartReview[Number(e.currentTarget.dataset.idx)];
    if (!item || !item.wordAudioUrl || this.data.reviewStatus !== 'ready' || this.data.reviewSubmitting) return;
    if (this.data.reviewPlayingId === item.id && this.data.reviewAudioKind === 'word' && this.data.playing) return this._stopReviewAudio();
    this._pausePlayback();
    this._stopCompilation();
    this._prepToken++;
    this._activeKind = 'review';
    this._relaySeg = { words: [] };
    this.setData({ reviewPlayingId: item.id, reviewAudioKind: 'word', reviewWordIdx: -1,
      activeIdx: -1, dailyActiveIdx: -1, sceneActiveIdx: -1, relayActiveSegId: '', activeWordIndex: -1 });
    this._player.playUrl(item.wordAudioUrl, 'studio');
  },

  _disposeSmartReview() {
    this._reviewDisposed = true;
    this._reviewSeq++;
    this._stopReviewAudio();
    if (this._reviewUnsubscribe) this._reviewUnsubscribe();
  },
};

module.exports = { emptyData, buildQueue, resolveAudio, methods };
