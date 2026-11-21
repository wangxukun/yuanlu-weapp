const feed = require('../../../pages/discover/reels-api');
const { createClipPlayer } = require('../../../utils/clip-player');
const { sentenceWindow } = require('../../../utils/clip-window');
const bus = require('../../../utils/audio-bus');
const recorder = require('../../../utils/recorder');
const { parseEvalResponse } = require('../../../utils/speech-core');
const { getPhonemeTip } = require('../../../utils/pron-core');
const training = require('./training');
const dictTool = require('../../../utils/dict-tool');
const theme = require('../../../utils/theme');
const { LOW_SCORE_THRESHOLD } = require('../../../utils/score-threshold');
const { get, post } = require('../../../utils/request');

const RECORD_LIMIT_SECONDS = 30;

const { answerWords } = training;

// 按不同词计算 F1，让漏听和听错各算一次误差。
function gradeKeywords(input, sentence) {
  const submitted = new Set(answerWords(input));
  if (!submitted.size) return null;
  const original = new Set(answerWords(sentence));
  const matched = [];
  const incorrect = [];
  for (const word of submitted) {
    if (original.has(word)) matched.push(word);
    else incorrect.push(word);
  }
  const omitted = Array.from(original).filter(word => !submitted.has(word));
  return {
    score: Math.round(200 * matched.length / (original.size + submitted.size)),
    originalCount: original.size,
    submittedCount: submitted.size,
    precision: Math.round(100 * matched.length / submitted.size),
    coverage: original.size ? Math.round(100 * matched.length / original.size) : 0,
    matched, incorrect, omitted,
  };
}

function listeningTip(clip) {
  const tip = clip.phoneticTip || '';
  if (tip && !tip.startsWith('本句语速') && !tip.includes('跟随扫光')) return tip;
  const words = clip.textEn.match(/[a-z]+(?:['’-][a-z]+)*/gi) || [];
  const weak = words.findIndex(word => /^(and|to|for|of|the|a|an|at|was|that|or|as|you|has|them|can|from|are|were)$/i.test(word));
  if (weak >= 0) {
    const phrase = words.slice(Math.max(0, weak - 1), weak + 2).join(' ');
    return '重听 “' + phrase + '”，留意 ' + words[weak] + ' 是否轻而短，再模仿它和相邻词的衔接。';
  }
  return '重听 “' + words.slice(0, 3).join(' ') + '”，找出读得最重的音节，再跟着原声模仿词与词之间的过渡。';
}

function assessmentFeedback(result) {
  let weakest;
  for (const word of result.words) {
    if (!word.word) continue;
    for (const sound of word.phonemes) {
      if (sound.score < LOW_SCORE_THRESHOLD && (!weakest || sound.score < weakest.score)) {
        weakest = { ...sound, word: word.word };
      }
    }
  }
  if (weakest) {
    const phoneme = weakest.phoneme.replace(/\//g, '');
    return '练习 ' + weakest.word + ' 中的 /' + phoneme + '/。' + getPhonemeTip(phoneme).tip;
  }
  const weakWords = result.words.filter(w => w.word && w.score < LOW_SCORE_THRESHOLD).sort((a, b) => a.score - b.score);
  if (weakWords.length) return '重听 ' + weakWords[0].word + '，先模仿重读音节，再连同前后词读一遍。';
  return '再听一遍原声，跟着重读音节打拍子，然后用同样的节奏连读整句。';
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { active: { type: Boolean, value: false } },
  data: {
    clip: null, number: 0, stage: 'blind', input: '', quiz: null, recordLimit: RECORD_LIMIT_SECONDS,
    loading: false, message: '', audio: 'idle', recording: 'idle', result: null,
    last: false, levels: ['全部', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'], levelIndex: 0,
    parts: [], activeWord: -1, pastWord: -1, canPrevious: false, saved: false, saving: false,
    wavPath: '', wordModal: null, todayCount: 0, todayAverage: 0,
  },
  lifetimes: {
    attached() {
      this._epoch = 0;
      this._audioSeq = 0;
      this._items = [];
      this._history = [];
      this._audioFiles = new Set();
      this._lookupId = 0;
      this._index = -1;
      this._refreshStats();
      this._player = createClipPlayer({
        onPlaying: (kind) => this.setData({ audio: kind === 'user' ? 'user' : kind ? 'playing' : 'idle' }),
        onTick: pos => this._tick(pos),
        onEnded: kind => {
          if (kind === 'ear' && this.data.active && !this.data.wordModal) this._playWindow(this._window.winStart);
        },
      });
      this._unbus = bus.register(() => this._pauseAudio());
      if (this.data.active) this.loadPage();
    },
    detached() {
      this._deactivate();
      this._unbus();
      this._clearFiles();
    },
  },
  observers: {
    active(value) {
      if (!this._player) return;
      if (!value) this._deactivate();
      else if (this._day && this._day !== training.today()) this._reset(this.data.levelIndex);
      else if (!this.data.clip && !this.data.loading) this.loadPage();
      else if (this.data.clip) this._readBookmark();
    },
  },
  methods: {
    _deactivate() {
      this._epoch++;
      this._pauseAudio();
      clearTimeout(this._recordTimer);
      if (this.data.recording === 'recording') recorder.cancel();
      this._lookupId++;
      this.setData({ recording: 'idle', loading: false, saving: false, wordModal: null });
    },
    _clearFiles() {
      for (const path of this._audioFiles) {
        try { wx.getFileSystemManager().unlinkSync(path); } catch (_) { /* 已被回收 */ }
      }
      this._audioFiles.clear();
    },
    _refreshStats() {
      const { scores, seen } = training.readDay();
      const values = Object.values(scores);
      // 题数含直接揭晓的题；均分只统计提交过评分的题，揭晓不贡献 0 分。
      this.setData({
        todayCount: new Set([...Object.keys(scores), ...Object.keys(seen)]).size,
        todayAverage: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
      });
    },
    _reset(levelIndex, restart = false) {
      this._deactivate();
      this._clearFiles();
      this._items = [];
      this._history = [];
      this._index = -1;
      this._day = '';
      this.setData({ levelIndex, clip: null, canPrevious: false, last: false });
      this._refreshStats();
      return this.loadPage(restart === true);
    },
    changeLevel(e) {
      const index = Number(e.detail.value);
      if (index !== this.data.levelIndex && this.data.recording === 'idle') return this._reset(index);
    },
    async loadPage(restart) {
      if (!this.data.active || this.data.loading) return;
      const level = this.data.levelIndex ? this.data.levels[this.data.levelIndex] : '';
      const expanding = this._items.length > 0;
      const progress = training.readDay().progress[level] || {};
      let cursor = expanding ? this._nextCursor : restart === true ? '' : progress.cursor || '';
      let number = expanding ? this.data.number + 1 : restart === true ? 1 : progress.number || 1;
      const epoch = this._epoch;
      this._pauseAudio();
      this.setData({ loading: true, message: '' });
      try {
        const day = expanding ? this._day : training.today();
        const resume = !expanding && restart !== true && !progress.number;
        const batch = await training.fetchBatch(cursor, day, level, resume);
        if (epoch !== this._epoch) return;
        if (day !== batch.day) {
          this._clearFiles();
          this._items = [];
          this._history = [];
          this._index = -1;
          this.setData({ clip: null, canPrevious: false });
          this._refreshStats();
          cursor = '';
          number = 1;
        }
        if (resume && batch.startCursor) {
          cursor = batch.startCursor;
          number = batch.firstNumber;
        }
        if (!batch.items.length) {
          if (!expanding && cursor) {
            this.setData({ loading: false });
            return this.loadPage(true);
          }
          const finished = this._items.length > 0;
          this.setData({ loading: false, last: finished, message: finished ? '这一轮已完成' : '暂无符合条件的切片' });
          return;
        }
        const index = this._items.length;
        for (const clip of batch.items) {
          this._items.push({ clip, before: cursor, number: number++ });
          cursor = clip.ringKey;
        }
        this._day = batch.day;
        this._nextCursor = batch.nextCursor;
        this._hasMore = batch.hasMore;
        this._select(index, expanding || restart === true);
      } catch (err) {
        if (epoch === this._epoch) this.setData({ loading: false, message: '切片加载失败，请重试' });
      }
    },
    _select(index, autoplay) {
      this._pauseAudio();
      if (this._index >= 0) {
        const { stage, input, quiz, result, wavPath, parts } = this.data;
        this._history[this._index] = { stage, input, quiz, result, wavPath, parts };
      }
      this._epoch++;
      this._index = index;
      this._window = null;
      this._position = null;
      const { clip, before, number } = this._items[index];
      const previous = this._history[index];
      this.setData({ clip, number, tip: listeningTip(clip), stage: 'blind', input: '', quiz: null,
        result: null, wavPath: '', parts: training.sentenceParts(clip), ...previous,
        recording: 'idle', loading: false, message: '', activeWord: -1, pastWord: -1,
        saved: false, saving: false, canPrevious: index > 0, last: index === this._items.length - 1 && !this._hasMore });
      const local = training.readDay();
      local.progress[this.data.levelIndex ? this.data.levels[this.data.levelIndex] : ''] = { cursor: before, number };
      training.writeDay(local);
      this._readBookmark();
      if (autoplay && this.data.stage === 'blind') this.toggleAudio();
    },
    previous() {
      if (this._index > 0 && !this.data.loading && this.data.recording === 'idle') this._select(this._index - 1, false);
    },
    next() {
      if (!this.data.active || this.data.stage !== 'revealed' || this.data.loading || this.data.recording !== 'idle') return;
      if (this._day !== training.today() || this.data.last) return this._reset(this.data.levelIndex, true);
      if (this._index + 1 >= this._items.length) return this.loadPage();
      this._select(this._index + 1, true);
    },
    _tick(pos) {
      if (this.data.stage !== 'revealed' || this._player.getKind() !== 'ear' || !this._window) return;
      const time = pos + this._window.offset;
      let activeWord = -1, pastWord = -1;
      for (const part of this.data.parts) {
        if (part.end <= time) pastWord = part.i;
        else if (part.start <= time && time < part.end) { activeWord = part.i; break; }
      }
      if (activeWord !== this.data.activeWord || pastWord !== this.data.pastWord) this.setData({ activeWord, pastWord });
    },
    _pauseAudio() {
      this._audioSeq++;
      if (this._player.getKind() === 'ear' && this._window) {
        const position = this._player.estimatedPos();
        if (position != null) this._position = position - this._window.winStart;
      }
      this._player.stop();
      if (this.data.audio !== 'idle') this.setData({ audio: 'idle' });
    },
    _playWindow(startSec) {
      const win = this._window;
      try {
        this._player.playUrl(win.url, 'ear', { startSec, endSec: win.winEnd });
        if (this._player.getKind() && this.data.audio !== 'playing') this.setData({ audio: 'loading' });
      } catch (err) {
        this._pauseAudio();
        wx.showToast({ title: '原声加载失败，请重试', icon: 'none' });
      }
    },
    async toggleAudio() {
      const clip = this.data.clip;
      if (!clip || !this.data.active || this.data.loading || this.data.recording !== 'idle') return;
      if (this.data.audio === 'user') this._pauseAudio();
      else if (this.data.audio !== 'idle') return this._pauseAudio();
      const seq = ++this._audioSeq;
      this.setData({ audio: 'loading' });
      try {
        // 手动起播刷新签名（含失败重试）；单句循环直接重用当前音源。
        const source = await feed.fetchClipAudio(clip.id);
        if (seq !== this._audioSeq) return;
        if (!source.url) throw new Error();
        this._window = { ...sentenceWindow(clip, source.clipOffset), url: source.url };
        const win = this._window;
        const offset = this._position || 0;
        this._playWindow(offset > 0 && offset < win.winEnd - win.winStart ? win.winStart + offset : win.winStart);
      } catch (err) {
        if (seq === this._audioSeq) {
          this.setData({ audio: 'idle' });
          wx.showToast({ title: err.statusCode === 403 ? '该原声需会员权限' : '原声加载失败，请重试', icon: 'none' });
        }
      }
    },
    async _readBookmark() {
      const clip = this.data.clip;
      const epoch = this._epoch;
      const revision = this._bookmarkRevision;
      try {
        const body = await get('/api/sentences/keys?episodeid=' + encodeURIComponent(clip.episodeid), null, { showError: false });
        if (this._epoch === epoch && revision === this._bookmarkRevision && body.success)
          this.setData({ saved: body.data.subtitleIds.some(id => String(id) === String(clip.subtitleId)) });
      } catch (_) { /* 收藏按钮仍可由服务端翻转 */ }
    },
    async bookmark() {
      if (this.data.saving || this.data.loading) return;
      const epoch = this._epoch;
      this._bookmarkRevision = (this._bookmarkRevision || 0) + 1;
      const clip = this.data.clip;
      this.setData({ saving: true });
      try {
        const body = await post('/api/sentences/toggle', { episodeid: clip.episodeid, subtitleId: clip.subtitleId,
          startTime: clip.start, endTime: clip.end, enText: clip.textEn, zhText: clip.textCn }, { showError: false });
        if (!body.success) throw new Error(body.message || '收藏失败');
        if (this._epoch === epoch) {
          this.setData({ saved: body.data.saved });
          wx.showToast({ title: body.data.saved ? '已收藏到句子本' : '已取消收藏', icon: 'none' });
        }
      } catch (err) {
        if (epoch === this._epoch) wx.showToast({ title: err.message || '收藏失败', icon: 'none' });
      } finally {
        if (epoch === this._epoch) this.setData({ saving: false });
      }
    },
    playRecording() {
      if (!this.data.wavPath || this.data.recording !== 'idle' || this.data.loading) return;
      if (this._player.getKind() === 'user') return this._pauseAudio();
      try {
        wx.getFileSystemManager().accessSync(this.data.wavPath);
        this._pauseAudio();
        this._player.playUrl(this.data.wavPath, 'user');
      } catch (_) { wx.showToast({ title: '录音文件不可用，请重新跟读', icon: 'none' }); }
    },
    async lookup(e) {
      const word = e.currentTarget.dataset.word;
      if (!word || this.data.loading || this.data.recording !== 'idle' || this.data.wordModal) return;
      const request = ++this._lookupId;
      const clip = this.data.clip;
      this._resumeEar = ['playing', 'loading'].includes(this.data.audio);
      this._pauseAudio();
      this.setData({ wordModal: { word, loading: true, saving: false, saved: false,
        examples: dictTool.buildClipCorpusExamples(clip, word) },
        portalTheme: 'theme-' + theme.getEffective() });
      get('/api/vocabulary/words', null, { showError: false }).then(body => {
        if (this._lookupId === request && Array.isArray(body.data) && body.data.some(w => w.toLowerCase() === word))
          this.setData({ 'wordModal.saved': true });
      }).catch(() => {});
      try {
        const body = await get('/api/dict/' + encodeURIComponent(word), null, { showError: false });
        if (!body.success) throw new Error(body.message || '查询失败');
        if (request === this._lookupId) this.setData({ 'wordModal.entry': body.data,
          'wordModal.examples': dictTool.buildClipCorpusExamples(clip, word, body.data.corpusExamples) });
      } catch (err) {
        if (request === this._lookupId) wx.showToast({ title: err.message || '查词失败', icon: 'none' });
      } finally {
        if (request === this._lookupId) this.setData({ 'wordModal.loading': false });
      }
    },
    closeLookup() {
      this._lookupId++;
      this.setData({ wordModal: null });
      if (this._resumeEar && this.data.active) this.toggleAudio();
      this._resumeEar = false;
    },
    lookupPractice(e) {
      const example = e.detail.example;
      if (example.isCurrentClip) return this.closeLookup();
      const word = this.data.wordModal.word;
      this._resumeEar = false;
      this.closeLookup();
      wx.navigateTo({ url: '/pages/practice-room/index?word=' + encodeURIComponent(word) + '&clipId=' + encodeURIComponent(example.clipid) });
    },
    async saveWord() {
      const m = this.data.wordModal;
      if (!m || m.saving || m.saved || m.loading) return;
      const request = this._lookupId;
      this.setData({ 'wordModal.saving': true });
      try {
        const body = await post('/api/vocabulary/add', dictTool.clipVocabularyEntry(m.word, m.entry, this.data.clip), { showError: false });
        if (body.success === false) throw new Error(body.message || '保存失败');
        if (request === this._lookupId) this.setData({ 'wordModal.saved': true });
      } catch (err) {
        if (request === this._lookupId) {
          if (err.statusCode === 400 && err.body && err.body.data && err.body.data.word) this.setData({ 'wordModal.saved': true });
          else wx.showToast({ title: err.message || '保存失败', icon: 'none' });
        }
      } finally {
        if (request === this._lookupId) this.setData({ 'wordModal.saving': false });
      }
    },
    beginQuiz() { if (this.data.stage === 'blind') this.setData({ stage: 'quiz' }); },
    onInput(e) { this.setData({ input: e.detail.value }); },
    submit(e) {
      if (this.data.stage !== 'quiz') return;
      // 键盘确认直接给字符串，表单提交给以 input.name 为键的当前值。
      const value = e.detail.value;
      const input = typeof value === 'string' ? value :
        (value && typeof value.keywords === 'string' ? value.keywords : this.data.input);
      if (answerWords(input).length > 60) {
        wx.showToast({ title: '每次最多提交 60 个词', icon: 'none' });
        return;
      }
      const quiz = gradeKeywords(input, this.data.clip.textEn);
      if (!quiz) {
        wx.showToast({ title: '请输入听到的英文词，或点直接揭晓', icon: 'none' });
        return;
      }
      this.setData({ stage: 'revealed', quiz });
      if (this.data.clip && this.data.clip.id) {
        const local = training.readDay();
        // 同题多次推测只记当日最好成绩，重测失手不拉低均分。
        local.scores[this.data.clip.id] = Math.max(local.scores[this.data.clip.id] || 0, quiz.score);
        local.seen[this.data.clip.id] = 1;
        training.writeDay(local);
        this._refreshStats();
      }
      this._logPractice();
    },
    reveal() {
      if (this.data.stage !== 'quiz') return;
      this.setData({ stage: 'revealed', quiz: null });
      if (this.data.clip && this.data.clip.id) {
        // 直接揭晓也算练过一题：计入题数，但不贡献 0 分。
        const local = training.readDay();
        local.seen[this.data.clip.id] = 1;
        training.writeDay(local);
        this._refreshStats();
      }
      this._logPractice();
    },
    _logPractice() {
      const epoch = this._epoch;
      training.logPractice({ clipid: this.data.clip.id, day: this._day, position: this.data.number,
        level: this.data.levelIndex ? this.data.levels[this.data.levelIndex] : '', cursor: this.data.clip.ringKey }).catch(() => {
        if (epoch === this._epoch) wx.showToast({ title: '练习记录同步失败', icon: 'none' });
      });
    },
    retryQuiz() {
      if (this.data.recording === 'idle' && !this.data.loading) this.setData({ stage: 'quiz', input: '', quiz: null });
    },
    async record() {
      if (this.data.recording === 'recording') {
        if (Date.now() - this._recordStart >= 600) return this.finishRecording();
        wx.showToast({ title: '已开始录音，读完再点一次', icon: 'none' });
        return;
      }
      if (this.data.recording !== 'idle' || this.data.loading || !this.data.active || this.data.stage !== 'revealed') return;
      this._pauseAudio();
      const epoch = this._epoch;
      this.setData({ recording: 'permission' });
      try {
        const allowed = await recorder.ensurePermission();
        if (epoch !== this._epoch) return;
        if (!allowed || !recorder.start({ ensurePerm: false })) throw new Error('无法使用麦克风，请检查录音权限');
        this._recordStart = Date.now();
        this.setData({ recording: 'recording' });
        this._recordTimer = setTimeout(() => {
          if (epoch === this._epoch) this.finishRecording();
        }, RECORD_LIMIT_SECONDS * 1000);
      } catch (err) {
        if (epoch === this._epoch) {
          this.setData({ recording: 'idle' });
          wx.showToast({ title: err.message || '录音未启动', icon: 'none' });
        }
      }
    },
    async finishRecording() {
      if (this.data.recording !== 'recording') return;
      clearTimeout(this._recordTimer);
      const epoch = this._epoch;
      const clip = this.data.clip;
      this.setData({ recording: 'scoring' });
      try {
        const take = await recorder.stop();
        if (epoch !== this._epoch) return;
        if (!take.base64 || take.duration < 0.5) throw new Error('录音太短，请再试一次');
        const body = await post('/api/speech/evaluate', {
          episodeId: clip.episodeid, subtitleId: clip.subtitleId, targetText: clip.textEn,
          audioBase64: take.base64, rate: recorder.PCM_RATE, scenario: 'review',
        }, { timeout: 60000, showError: false });
        if (epoch !== this._epoch) return;
        if (!body || !body.success || !body.data) throw new Error('评测失败，请重试');
        const result = parseEvalResponse(body);
        let path = take.wavPath || '';
        if (path) {
          const owned = wx.env.USER_DATA_PATH + '/blind_' + Date.now() + '.wav';
          try {
            wx.getFileSystemManager().copyFileSync(path, owned);
            this._audioFiles.add(owned);
            path = owned;
          } catch (_) { /* 空间不足时沿用共享录音的临时文件 */ }
        }
        if (this._audioFiles.delete(this.data.wavPath)) {
          try { wx.getFileSystemManager().unlinkSync(this.data.wavPath); } catch (_) { /* 已回收 */ }
        }
        this.setData({ wavPath: path, parts: training.sentenceParts(clip, result.words),
          result: { score: result.overallScore, words: result.words, feedback: assessmentFeedback(result) } });
      } catch (err) {
        if (epoch === this._epoch) wx.showToast({ title: (err.body && err.body.message) || err.message || '评测失败，请重试', icon: 'none' });
      } finally {
        if (epoch === this._epoch) this.setData({ recording: 'idle' });
      }
    },
  },
});
