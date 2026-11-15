const authStore = require('../../store/authStore');
const { post } = require('../../utils/request');
const { anonymousId, subject } = require('../../utils/subject');
const reelsApi = require('../discover/reels-api');
const shadowing = require('./shadowing');
const { chinaClock } = require('./dashboard');

const VERSION = 2;
function read(key) { try { return wx.getStorageSync(key); } catch (e) { return null; } }
function write(key, value) { try { wx.setStorageSync(key, value); } catch (e) { /* Session state still works. */ } }
function cacheKey(owner, date) { return 'studio_daily_v2:' + owner + ':' + date; }
function historyKey(owner) { return 'studio_daily_history_v2:' + owner; }
function before(date, days) { return new Date(Date.parse(date + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10); }
function clipKey(c) { return c.episodeid && c.subtitleId != null ? JSON.stringify([c.episodeid, c.subtitleId]) : 'local:' + c.id; }
function lastDate(r) { return [r.servedOn || '', r.practicedOn || ''].sort().pop(); }
function history(owner, today) {
  const rows = read(historyKey(owner));
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const latest = r && lastDate(r);
    return latest && latest >= before(today, 90) && latest <= today;
  }).slice(-500);
}
function record(owner, date, clips, practiced) {
  const map = {};
  history(owner, date).forEach((r) => { map[r.key] = r; });
  clips.forEach((c) => {
    const key = clipKey(c), old = map[key] || {};
    map[key] = Object.assign({}, old, { key, episodeid: c.episodeid || '', subtitleId: c.subtitleId == null ? null : c.subtitleId,
      servedOn: practiced ? old.servedOn : date, practicedOn: practiced ? date : old.practicedOn });
  });
  write(historyKey(owner), Object.keys(map).map((k) => map[k]).sort((a, b) =>
    lastDate(a).localeCompare(lastDate(b))).slice(-500));
}
function validCache(state, owner, date) {
  return state && state.cacheVersion === VERSION && state.subject === owner && state.date === date &&
    (state.source === 'local' || state.algorithmVersion === 'daily-v2') &&
    Array.isArray(state.clips) &&
    // 主体 5 句不变量看非加练句；isBonus（榜「挑战同款」追加）另计，封顶 3
    state.clips.filter((c) => !c.isBonus).length <= 5 && state.clips.length <= 8 &&
    ['complete', 'partial', 'empty'].includes(state.status);
}
function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}
function localPick(owner, date) {
  const recent = {};
  history(owner, date).forEach((r) => {
    if (r.servedOn && r.servedOn < date) recent[r.key] = r.servedOn;
  });
  const texts = {};
  return reelsApi.localReels().filter((c) => {
    const text = (c.textEn || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!text || texts[text] || (recent[clipKey(c)] && recent[clipKey(c)] >= before(date, 7))) return false;
    texts[text] = true; return true;
  }).sort((a, b) => hash(owner + date + clipKey(b)) - hash(owner + date + clipKey(a))).slice(0, 5);
}

const methods = {
  _initDailyChallenge() {
    this._dailyRequest = null;
    this._dailyAuthUnsub = authStore.subscribe(() => this._loadDaily(false));
  },
  _disposeDailyChallenge() { if (this._dailyAuthUnsub) this._dailyAuthUnsub(); },

  _showDaily(state, owner) {
    this._dailyKey = cacheKey(owner, state.date);
    this.setData({ daily: state, dailyLoading: false, refreshingDaily: false, dailyError: '' });
    this._applyShadowResults();
    record(owner, state.date, state.clips, false);
    state.clips.forEach((c) => { if (c.real && c.episodeid) this._fetchSavedKeys(c.episodeid, null, 'daily.clips'); });
    const first = state.clips.find((c) => c && c.real && c.available !== false && !c.clipAudioUrl && c.id);
    if (first && reelsApi.fetchClipAudio) {
      reelsApi.fetchClipAudio(first.id).then((r) => {
        if (!r || !r.url || !this.data.daily || this.data.daily.date !== state.date) return;
        const idx = this.data.daily.clips.findIndex((c) => c.id === first.id);
        if (idx >= 0) {
          this.data.daily.clips[idx].clipAudioUrl = r.url;
          if (typeof r.clipOffset === 'number') this.data.daily.clips[idx].clipOffset = r.clipOffset;
        }
      }).catch(() => {});
    }
    this._loadLeaderboard();
  },

  _loadDaily(force) {
    const date = chinaClock().date, owner = subject(), key = cacheKey(owner, date);
    if (this._shadowDisposed) return Promise.resolve();
    if (owner === 'pending') {
      this.setData({ daily: null, dailyLoading: false, dailyError: '正在同步账号，请稍后刷新。' });
      return Promise.resolve();
    }
    // A corpus assignment is locked for the day; an offline local fallback can be upgraded on manual refresh.
    let cached = validCache(this.data.daily, owner, date) ? this.data.daily : read(key);
    if (!validCache(cached, owner, date)) {
      const legacy = read('studio_daily_' + date), claim = read('studio_daily_legacy_owner:' + date);
      if (legacy && Array.isArray(legacy.clips) && legacy.clips.length === 5 && (!claim || claim === owner)) {
        write('studio_daily_legacy_owner:' + date, owner);
        cached = Object.assign({}, legacy, { cacheVersion: VERSION, subject: owner, date, status: 'complete', algorithmVersion: 'daily-v2' });
        write(key, shadowing.applyResults(cached, {}, 0));
      }
    }
    if (validCache(cached, owner, date) && (cached.source !== 'local' || !force)) {
      this._showDaily(cached, owner);
      return Promise.resolve();
    }
    if (this._dailyRequest && this._dailyRequest.key === key) return this._dailyRequest.promise;
    this._pausePlayback();
    this.setData({ daily: null, dailyLoading: true, refreshingDaily: !!force, dailyError: '', dailyActiveIdx: -1 });
    const current = () => !this._shadowDisposed && subject() === owner && chinaClock().date === date;
    const run = async () => {
      let data, source = 'corpus';
      try {
        const body = await post('/api/clips/daily-challenge', {
          anonymousId: anonymousId(),
          localHistory: history(owner, date).filter((r) => r.episodeid && Number.isInteger(r.subtitleId)).map((r) => ({
            episodeid: r.episodeid, subtitleId: r.subtitleId, servedOn: r.servedOn, practicedOn: r.practicedOn,
          })),
        }, { showError: false, timeout: 20000 });
        if (!current()) return;
        if (!body || !body.success || !body.data || !Array.isArray(body.data.items) || body.data.items.length > 5 ||
          !['complete', 'partial', 'empty'].includes(body.data.status)) throw new Error('INVALID_DAILY_RESPONSE');
        if (body.data.date !== date) { this.setData({ dailyError: '日期已更新，请校准设备时间后重试。' }); return; }
        data = body.data;
      } catch (err) {
        if (!current()) return;
        if (err && err.statusCode === 401) { this.setData({ dailyError: '登录已过期，请重新登录。' }); return; }
        source = 'local';
        const local = localPick(owner, date);
        data = { date, items: local, status: local.length === 5 ? 'complete' : local.length ? 'partial' : 'empty', algorithmVersion: 'offline-v1', fallbackStage: 'network_fallback' };
      }
      if (!current()) return;
      const clips = data.items.map((item, index) => {
        const reel = source === 'local' ? item : reelsApi.fromFeedItem(item);
        reel.matchedWords = item.matchedWords || [];
        reel.selectionReason = item.selectionReason;
        reel.available = item.available !== false;
        const clip = this._mapDailyClip(reel, index, reel.matchedWords.length > 0, source);
        clip.available = reel.available;
        clip.sentenceKey = item.sentenceKey || clipKey(clip);
        if (item.evaluation && item.evaluation.recognitionId && source === 'corpus' && clip.available) {
          this._shadowResults = this._shadowResults || {};
          const old = this._shadowResults && this._shadowResults[clip.id];
          if (!old || old.result.recognitionId < item.evaluation.recognitionId) {
            const result = shadowing.resultView({ success: true, data: item.evaluation });
            this._shadowResults[clip.id] = { text: clip.textEn, episodeid: clip.episodeid, result };
          }
        }
        return clip;
      });
      const summary = source === 'local' ? '连接暂不可用，今天先听备用示例；示例不支持跟读评测。' :
        data.status === 'empty' ? '今天暂无合适的新素材，明天再来看看。' :
        data.status === 'partial' ? '今天先练这 ' + clips.length + ' 条，近期练过的内容已尽量避开。' :
        '今天的 5 条已固定，结合生词与不同主题选取，明天继续探索新内容。';
      const state = { cacheVersion: VERSION, subject: owner, date, assignmentId: data.assignmentId || null,
        algorithmVersion: data.algorithmVersion, status: data.status, fallbackStage: data.fallbackStage,
        clips, completedCount: 0, averageScore: 0, allCompleted: false, totalShadowingCount: 0,
        userHistorySummary: summary, source };
      this._persistDaily(state);
      // Persist restored account scores separately, as with successful local assessments.
      if (this._shadowCacheKey) write(this._shadowCacheKey, { results: this._shadowResults, attempts: this._shadowAttempts });
      this._showDaily(state, owner);
    };
    const promise = run().catch(() => { if (current()) this.setData({ dailyError: '今日挑战暂不可用，请稍后重试。' }); })
      .finally(() => {
        if (this._dailyRequest && this._dailyRequest.key === key) this._dailyRequest = null;
        if (current()) this.setData({ dailyLoading: false, refreshingDaily: false });
      });
    this._dailyRequest = { key, promise };
    return promise;
  },

  _persistDaily(state) { write(cacheKey(state.subject || subject(), state.date), shadowing.applyResults(state, {}, 0)); },

  /**
   * 榜单「挑战同款」追加加练句（今日挑战第 6+ 句，isBonus 标记）：
   * 已在挑战中→直接返回其下标（跳转即播不重复加）；加练封顶 3 条；
   * 写回当日缓存持久化 + 登记 served 历史（防明日选料重复下发）；
   * 返回新卡下标（-1=不可加）。
   */
  _appendDailyBonus(reel) {
    const state = this.data.daily;
    if (!state || !Array.isArray(state.clips) || !reel || !reel.id) return -1;
    const exists = state.clips.findIndex((c) => c.id === reel.id);
    if (exists >= 0) return exists;
    if (state.clips.filter((c) => c.isBonus).length >= 3) {
      wx.showToast({ title: '加练已满 3 句，先消化现有句子', icon: 'none' });
      return -1;
    }
    const mapped = this._mapDailyClip(reel, state.clips.length, false, 'corpus');
    mapped.isBonus = true;
    const next = shadowing.applyResults(
      Object.assign({}, state, { clips: state.clips.concat([mapped]) }),
      this._shadowResults || {},
      this._shadowAttempts || 0,
    );
    write(cacheKey(state.subject || subject(), state.date), next);
    this.setData({ daily: next });
    if (mapped.real && mapped.episodeid) this._fetchSavedKeys(mapped.episodeid, null, 'daily.clips');
    record(state.subject || subject(), state.date, [mapped], false);
    return next.clips.length - 1;
  },
  _recordDailyPractice(clip) { record(subject(), chinaClock().date, [clip], true); },
  onRefreshDaily() {
    if (this.data.refreshingDaily || this._shadowBusy()) return;
    this._pausePlayback();
    this._loadDaily(true);
  },
};

module.exports = { methods, subject, cacheKey, history, record, localPick, validCache };
