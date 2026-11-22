const authStore = require('../../store/authStore');
const { get, post } = require('../../utils/request');
const recorder = require('../../utils/recorder');
const speech = require('../../utils/speech-core');
const audioBus = require('../../utils/audio-bus');
const { chinaClock } = require('./dashboard');
const PASS_SCORE = 85;
const MAX_SECONDS = 60;
const isScore = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

function emptyData() {
  return { shadowPreparingId: '', recordingClipId: '', recordingSeconds: 0,
    evaluatingClipId: '', shadowErrorClipId: '', shadowError: '', shadowAmplitude: 0,
    shadowReplayClipId: '',
    shadowSelWordClipId: '', shadowSelWordIdx: -1, shadowWordPlay: '' };
}

function resultView(body) {
  const data = body && body.data;
  const details = data && data.details || {};
  const number = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
  const score = [details.overall, data && data.score, details.pronunciation].map(number).find(isScore);
  if (!body || !body.success || !isScore(score)) throw new Error('评测结果无效，请重新录音');
  const words = (Array.isArray(details.words) ? details.words : [])
    .filter((w) => w && typeof w.word === 'string' && isScore(number(w.pronunciation)))
    .map((w) => Object.assign({}, w, { phonemes: (Array.isArray(w.phonemes) ? w.phonemes : [])
      .filter((p) => p && (p.phoneme || p.phone) && isScore(number(p.score == null ? p.pronunciation : p.score))) }));
  const parsed = speech.parseEvalResponse({ data: Object.assign({}, data, { details: Object.assign({}, details, { words }) }) });
  const saved = Number.isInteger(data.recognitionId) && data.recognitionId > 0;
  // [2026-11-13] 总分四舍五入取整展示（有道原始返回带多位小数，如 86.743744）
  const rounded = Math.round(score);
  return {
    source: 'server', recognitionId: saved ? data.recognitionId : null,
    score: rounded, accuracy: isScore(number(details.pronunciation)) ? Math.round(number(details.pronunciation)) : null,
    fluency: isScore(number(details.fluency)) ? Math.round(number(details.fluency)) : null,
    integrity: isScore(number(details.integrity)) ? Math.round(number(details.integrity)) : null,
    words: parsed.words.map((w, i) => Object.assign({}, w, { id: i,
      phonemes: w.phonemes.map((p, j) => Object.assign({}, p, { id: j })) })),
    celebrationBadge: saved ? rounded >= PASS_SCORE ? '已达标' : '继续练习' : '成绩未保存',
    feedback: !saved ? '评测已完成，但成绩未保存到账号，本次不计入挑战进度。' : rounded >= PASS_SCORE
      ? '已达到 85 分目标，评测记录已保存。' : '评测记录已保存，可以先听原声，再练习分数较低的词。',
  };
}

function applyResults(state, results, attempts) {
  if (!state || !Array.isArray(state.clips)) return state;
  const clips = state.clips.map((c) => {
    const entry = results[c.id];
    const ev = entry && entry.text === c.textEn && entry.episodeid === c.episodeid && entry.result;
    const valid = ev && ev.source === 'server' && Number.isInteger(ev.recognitionId) && ev.recognitionId > 0 && isScore(ev.score);
    return Object.assign({}, c, { evalResult: valid ? ev : null, score: valid ? ev.score : 0,
      completed: !!(valid && ev.score >= PASS_SCORE), waveBars: null, activeDiag: null });
  });
  const graded = clips.filter((c) => c.evalResult);
  // 加练句（isBonus，榜「挑战同款」追加）不计入完成度/全通关——自愿加练
  // 不改变 5 句主体的通关口径，避免已通关用户的通关横幅回退
  const base = clips.filter((c) => !c.isBonus);
  const completedCount = base.filter((c) => c.completed).length;
  return Object.assign({}, state, { clips, completedCount, baseCount: base.length,
    allCompleted: base.length > 0 && completedCount === base.length,
    completionPercent: base.length ? Math.round(completedCount * 100 / base.length) : 0,
    averageScore: graded.length ? Math.round(graded.reduce((sum, c) => sum + c.score, 0) / graded.length) : 0,
    totalShadowingCount: attempts || 0 });
}

const methods = {
  _initShadowing() {
    this._shadowSeq = 0;
    this._shadowDisposed = false;
    this._shadowResults = {};
    this._shadowAttempts = 0;
    this._shadowIdentity = '';
    this._shadowAuthUnsub = authStore.subscribe(() => this._syncShadowIdentity());
    this._shadowBusUnsub = audioBus.register(() => {
      if (this.data.recordingClipId) this._cancelShadowing();
    });
    this._shadowAmpUnsub = recorder.onAmplitude((amp) => {
      if (this.data.recordingClipId) this.setData({ shadowAmplitude: Math.round(Math.max(0, Math.min(100, amp))) });
    });
    this._syncShadowIdentity();
  },

  _shadowToken() {
    const auth = authStore.getState();
    return auth.isLoggedIn ? auth.token || '' : '';
  },

  _syncShadowIdentity() {
    const auth = authStore.getState();
    const token = this._shadowToken();
    const userId = auth.userInfo && auth.userInfo.userid;
    const date = chinaClock().date;
    const identity = token + ':' + (userId || '') + ':' + date;
    if (identity === this._shadowIdentity) return;
    this._cancelShadowing();
    this._shadowIdentity = identity;
    this._shadowResults = {};
    this._shadowAttempts = 0;
    this._shadowCacheKey = token && userId ? 'studio_shadow_v1:' + userId + ':' + date : '';
    if (this._shadowCacheKey) {
      try {
        const saved = wx.getStorageSync(this._shadowCacheKey);
        if (saved && saved.results && typeof saved.results === 'object') {
          this._shadowResults = saved.results;
          this._shadowAttempts = Number.isInteger(saved.attempts) && saved.attempts >= 0 ? saved.attempts : 0;
        }
      } catch (e) { /* Cache is optional; server history remains available. */ }
    }
    this._applyShadowResults();
  },

  _applyShadowResults() {
    if (this.data.daily) this.setData({ daily: applyResults(this.data.daily, this._shadowResults || {}, this._shadowAttempts) });
  },

  _shadowBusy() {
    return !!(this.data.shadowPreparingId || this.data.recordingClipId || this.data.evaluatingClipId);
  },

  _practiceClip(ds) {
    const plan = this.data.plan;
    if (ds.source === 'scene') {
      const scene = plan && plan.scenes[Number(ds.sci)];
      return scene && scene.sentences[Number(ds.idx)];
    }
    if (ds.source === 'clip') return plan && plan.clips[Number(ds.idx)];
    return this.data.daily && this.data.daily.clips[Number(ds.idx)];
  },

  async onDailyShadowStart(e) {
    const target = e.currentTarget.dataset;
    const clip = this._practiceClip(target);
    if (!clip) return;
    if (this.data.recordingClipId === clip.id) return this._finishDailyRecording();
    if (this._shadowBusy() || this.data.relayRecording || this.data.relaySubmitting || this.data.relayPrepCountdown || this.data.isGenerating) return;
    if (!this._shadowToken()) return this._promptLogin('登录后开始跟读并保存评测记录');
    if (clip.available === false) {
      wx.showToast({ title: '这条素材暂不可用，请练习其他内容', icon: 'none' });
      return;
    }
    if (!clip.real || !clip.episodeid || !String(clip.textEn || '').trim()) {
      wx.showToast({ title: '今天的备用示例仅支持试听', icon: 'none' });
      return;
    }
    this._syncShadowIdentity();
    this._pausePlayback();
    this._stopCompilation();
    ++this._prepToken; // Invalidate pending original audio before opening the microphone.
    const seq = ++this._shadowSeq;
    const token = this._shadowToken();
    const current = () => !this._shadowDisposed && seq === this._shadowSeq && token === this._shadowToken();
    this.setData({ shadowPreparingId: clip.id, shadowError: '', shadowErrorClipId: '', shadowReplayClipId: '' });
    this._shadowReplay = null;
    try {
      const quota = await get('/api/speech/quota', { scenario: 'learn' }, { showError: false });
      if (!current()) return;
      if (!quota || !quota.success || !quota.data) throw new Error('无法获取评测余量，请重试');
      if (quota.data.exhausted) {
        this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
        return;
      }
      const permitted = await recorder.ensurePermission();
      if (!current()) return;
      if (!permitted) throw new Error('需要麦克风权限才能跟读，请授权后重试');
      if (!recorder.start({ ensurePerm: false })) throw new Error('录音启动失败，请重试');
      this._shadowRecording = { clip, target, seq, token, startedAt: Date.now() };
      this.setData({ recordingClipId: clip.id, recordingSeconds: 0, shadowAmplitude: 0 });
      this._shadowTimer = setInterval(() => {
        if (!current()) return;
        const seconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - this._shadowRecording.startedAt) / 1000));
        this.setData({ recordingSeconds: seconds });
        if (seconds >= MAX_SECONDS || (seconds >= MAX_SECONDS - 1 && !recorder.getState().recording)) this._finishDailyRecording();
        else if (!recorder.getState().recording) {
          this._cancelShadowing();
          this.setData({ shadowErrorClipId: clip.id, shadowError: '录音已中断，请重新录制' });
        }
      }, 250);
    } catch (err) {
      if (current()) this.setData({ shadowErrorClipId: clip.id, shadowError: err.message || '录音启动失败，请重试' });
    } finally {
      if (current()) this.setData({ shadowPreparingId: '' });
    }
  },

  async _finishDailyRecording() {
    const recording = this._shadowRecording;
    if (!recording || !this.data.recordingClipId) return;
    clearInterval(this._shadowTimer);
    this._shadowTimer = null;
    const { clip, target, seq, token } = recording;
    const current = () => !this._shadowDisposed && seq === this._shadowSeq && token === this._shadowToken();
    this.setData({ recordingClipId: '', evaluatingClipId: clip.id, shadowAmplitude: 0 });
    try {
      const audio = await recorder.stop();
      if (!current()) return;
      if (audio.bytes < 16000 || !audio.base64) throw new Error('录音太短或未采集到声音，请重新录制');
      this._shadowReplay = { clipId: clip.id, path: audio.wavPath };
      this.setData({ shadowReplayClipId: audio.wavPath ? clip.id : '' });
      const body = await post('/api/speech/evaluate', {
        episodeId: clip.episodeid, subtitleId: clip.subtitleId == null ? undefined : clip.subtitleId,
        targetText: clip.textEn, audioBase64: audio.base64, rate: 16000, scenario: 'learn',
      }, { showError: false, timeout: 60000 });
      if (!current()) return;
      const result = resultView(body);
      if (target && target.source) {
        const path = target.source === 'scene'
          ? 'plan.scenes[' + Number(target.sci) + '].sentences[' + Number(target.idx) + ']'
          : 'plan.clips[' + Number(target.idx) + ']';
        const selected = this._practiceClip(target);
        if (selected && selected.id === clip.id) {
          this.setData({ [path + '.evalResult']: result, [path + '.completed']: !!result.recognitionId && result.score >= PASS_SCORE });
        }
      } else if (result.recognitionId) {
        if (this._recordDailyPractice) this._recordDailyPractice(clip);
        this._shadowResults[clip.id] = { text: clip.textEn, episodeid: clip.episodeid, result };
        this._shadowAttempts++;
        if (this._shadowCacheKey) {
          try { wx.setStorageSync(this._shadowCacheKey, { results: this._shadowResults, attempts: this._shadowAttempts }); } catch (e) { /* Server saved; storage failure must not discard the score. */ }
        }
        this._applyShadowResults();
      } else {
        const clips = this.data.daily.clips.map(c => c.id === clip.id ? { ...c, evalResult: result } : c);
        this.setData({ daily: { ...this.data.daily, clips } });
      }
      if (result.recognitionId) {
        this._loadDashboard(true);
        // 开口跟读自动验收连胜（SPEECH 通道，当日幂等；失败静默）
        this._igniteStreakBySpeech(result.recognitionId);
        // 工具模拟器录音格式与移动端不同（微信官方限制，Console 有提示），
        // 云端评测按标准 16k WAV 解析必然全 0——归因提示而非让用户误判故障；
        // 报告照常展示（链路验证价值保留），真实评分走真机预览。
        if (result.score === 0 && recorder.isDevtools()) {
          this.setData({
            shadowErrorClipId: clip.id,
            shadowError: '工具录音格式与云端评测不兼容（微信官方限制），评分恒为 0 分；录音与回放功能正常，真实评分请用真机预览',
          });
        }
      }
    } catch (err) {
      if (!current()) return;
      const code = err && (err.error || err.code || (err.body && err.body.error));
      if (code === 'EVALUATION_QUOTA_EXCEEDED' || code === 'REVIEW_EVAL_QUOTA_EXCEEDED') {
        this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
      }
      this.setData({ shadowErrorClipId: clip.id,
        shadowError: err.statusCode === 0 ? '网络超时，结果尚未确认；可先查看评测记录，避免重复评测' :
          (err.body && err.body.message) || err.message || '评测失败，请重新录音' });
    } finally {
      if (current()) {
        this._shadowRecording = null;
        this.setData({ evaluatingClipId: '' });
      }
    }
  },

  onCancelDailyRecording() { this._cancelShadowing(); },

  _cancelShadowing() {
    this._shadowSeq = (this._shadowSeq || 0) + 1;
    if (this._shadowTimer) clearInterval(this._shadowTimer);
    this._shadowTimer = null;
    if (this._shadowRecording) recorder.cancel();
    this._shadowRecording = null;
    this._shadowReplay = null;
    this.setData(emptyData());
  },

  onPlayDailyRecording(e) {
    const clip = this._practiceClip(e.currentTarget.dataset);
    const audio = this._shadowReplay;
    if (!clip || !audio || audio.clipId !== clip.id || this._shadowBusy()) return;
    if (this._activeKind === 'shadow-user' && this.data.playing) return this._pausePlayback();
    this._pausePlayback();
    this._stopCompilation();
    this._prepToken++;
    this._activeKind = 'shadow-user';
    this._audioMeta = null;
    // 我的发音回放与「听原声」互斥：清 daily 活动卡——否则听原声按钮残留
    // 「暂停」态，且回放结束后 _activeKind 仍为 shadow-user，点听原声会走进
    // _startPlayback 的 shadow-user 分支（取自由定制 tab 切片）而无效
    this.setData({ dailyActiveIdx: -1, activeIdx: -1, sceneActiveIdx: -1, activeWordIndex: -1 });
    this._player.playUrl(audio.path, 'studio');
  },

  /* ---------- 逐词发音胶囊 + 音素诊断面板（speech-eval 同款交互） ---------- */

  /** 当前展开诊断的词（多卡互斥：shadowSelWordClipId + shadowSelWordIdx） */
  _selectedShadowWord(clip) {
    if (!clip || this.data.shadowSelWordClipId !== clip.id) return null;
    const w = clip.evalResult && clip.evalResult.words[this.data.shadowSelWordIdx];
    return w || null;
  },

  /** 点橙/红词：切换音素诊断面板（绿词与无音素词不响应，se-chip--click 同口径） */
  onShadowWordTap(e) {
    const ds = e.currentTarget.dataset;
    const clip = this._practiceClip(ds);
    const sw = clip && clip.evalResult && clip.evalResult.words[Number(ds.wi)];
    if (!sw) return;
    if (sw.score >= 85 || !sw.phonemes.length) return;
    this._pausePlayback();
    const sel = this.data.shadowSelWordClipId === clip.id && this.data.shadowSelWordIdx === Number(ds.wi);
    this.setData({
      shadowSelWordClipId: sel ? '' : clip.id,
      shadowSelWordIdx: sel ? -1 : Number(ds.wi),
      shadowWordPlay: '',
    });
  },

  /** 音素诊断四路对比起播前统一隔离：停旧源、清 daily 活动卡（防听原声按钮
   *  残留「暂停」态）、通道标记 shadow-word（_onClipEnd 不循环不复位听原声） */
  _shadowWordPlayStart(kind) {
    this._pausePlayback();
    this._stopCompilation();
    this._prepToken++;
    this._activeKind = 'shadow-word';
    this._audioMeta = null;
    this.setData({ shadowWordPlay: kind, dailyActiveIdx: -1, activeIdx: -1, sceneActiveIdx: -1, activeWordIndex: -1 });
  },

  /** 有道词典发音：美音(type=2)/英音(type=1)，与 speech-eval onPlayDictVoice 同链 */
  onShadowDictVoice(e) {
    const ds = e.currentTarget.dataset;
    const us = ds.us === '1' || ds.us === 1;
    const kind = us ? 'us' : 'uk';
    if (this.data.shadowWordPlay === kind && this.data.playing) {
      this._pausePlayback();
      return;
    }
    const clip = this._practiceClip(ds);
    const sw = clip && this._selectedShadowWord(clip);
    if (!sw) return;
    const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(sw.word) + '&type=' + (us ? 2 : 1);
    this._shadowWordPlayStart(kind);
    this._player.playUrl(url, 'studio');
  },

  /** 词级原声：字幕词级时间戳精确/模糊匹配 → 切片窗口播放（切片轴 = 绝对秒 − clipOffset） */
  onShadowWordOriginal(e) {
    const ds = e.currentTarget.dataset;
    if (this.data.shadowWordPlay === 'orig' && this.data.playing) {
      this._pausePlayback();
      return;
    }
    const clip = this._practiceClip(ds);
    const sw = clip && this._selectedShadowWord(clip);
    if (!sw || !clip.words || !clip.words.length) {
      wx.showToast({ title: '该句无词级时间戳', icon: 'none' });
      return;
    }
    const target = speech.cleanWordKey(sw.word);
    let hit = clip.words.find((w) => speech.cleanWordKey(w.word) === target);
    if (!hit) {
      let best = null;
      let bestD = Infinity;
      clip.words.forEach((w) => {
        const d = speech.cheapDistance(w.word, target);
        if (d < bestD) { bestD = d; best = w; }
      });
      hit = best;
    }
    if (!hit) {
      wx.showToast({ title: '原声中未找到该词', icon: 'none' });
      return;
    }
    this._shadowWordPlayStart('orig');
    const seq = this._prepToken;
    const original = clip.sceneId
      ? this._prepareSceneAudio(this.data.plan.scenes[Number(ds.sci)], Number(ds.idx))
      : this._prepareAudio(clip);
    original.then((meta) => {
      if (seq !== this._prepToken || this._activeKind !== 'shadow-word') return;
      const off = meta.offset || clip.clipOffset || 0;
      this._player.playUrl(meta.url, 'studio', {
        startSec: Math.max(0, hit.start - off),
        endSec: Math.max(0.3, hit.end - off),
      });
    }).catch(() => {
      if (seq !== this._prepToken) return;
      this.setData({ shadowWordPlay: '' });
      wx.showToast({ title: '原声音频不可用', icon: 'none' });
    });
  },

  /** 词级「我」：本次录音（wavPath）中该词切片（有道词级 start/end 相对录音时间轴） */
  onShadowWordMe(e) {
    const ds = e.currentTarget.dataset;
    if (this.data.shadowWordPlay === 'me' && this.data.playing) {
      this._pausePlayback();
      return;
    }
    const clip = this._practiceClip(ds);
    const sw = clip && this._selectedShadowWord(clip);
    const audio = this._shadowReplay;
    if (!clip || !sw || !audio || audio.clipId !== clip.id || !audio.path) {
      wx.showToast({ title: '本次会话录音不可用', icon: 'none' });
      return;
    }
    if (sw.start == null || sw.end == null) {
      wx.showToast({ title: '该词无切片时间', icon: 'none' });
      return;
    }
    this._shadowWordPlayStart('me');
    this._player.playUrl(audio.path, 'studio', {
      startSec: Math.max(0, sw.start),
      endSec: Math.max(sw.start + 0.3, sw.end),
    });
  },

  _disposeShadowing() {
    this._shadowDisposed = true;
    this._cancelShadowing();
    if (this._shadowAuthUnsub) this._shadowAuthUnsub();
    if (this._shadowAmpUnsub) this._shadowAmpUnsub();
    if (this._shadowBusUnsub) this._shadowBusUnsub();
  },
};

module.exports = { emptyData, resultView, applyResults, methods };
