const feed = require('../../../pages/discover/reels-api');
const { createClipPlayer } = require('../../../utils/clip-player');
const { sentenceWindow } = require('../../../utils/clip-window');
const bus = require('../../../utils/audio-bus');
const recorder = require('../../../utils/recorder');
const { parseEvalResponse } = require('../../../utils/speech-core');
const { post } = require('../../../utils/request');

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { active: { type: Boolean, value: false } },
  data: {
    clip: null, number: 0, stage: 'blind', input: '', quizScore: null,
    loading: false, message: '', audio: 'idle', recording: 'idle', result: null,
    last: false,
  },
  lifetimes: {
    attached() {
      this._epoch = 0;
      this._audioSeq = 0;
      this._player = createClipPlayer({
        onPlaying: (kind) => this.setData({ audio: kind ? 'playing' : 'idle' }),
        onEnded: () => {
          if (this.data.active) this._playWindow(this._window.winStart);
        },
      });
      this._unbus = bus.register(() => this._pauseAudio());
      if (this.data.active) this.loadPage();
    },
    detached() {
      this._deactivate();
      this._unbus();
    },
  },
  observers: {
    active(value) {
      if (!this._player) return;
      if (!value) this._deactivate();
      else if (!this.data.clip && !this.data.loading) this.loadPage();
    },
  },
  methods: {
    _deactivate() {
      this._epoch++;
      this._pauseAudio();
      clearTimeout(this._recordTimer);
      if (this.data.recording === 'recording') recorder.cancel();
      this.setData({ recording: 'idle', loading: false });
    },
    async loadPage() {
      if (!this.data.active || this.data.loading) return;
      const advance = !!this.data.clip;
      const page = advance && !this.data.last ? this._page + 1 : 1;
      const epoch = this._epoch;
      this._pauseAudio();
      this.setData({ loading: true, message: '' });
      try {
        const batch = await feed.fetchFeed(page);
        if (epoch !== this._epoch) return;
        if (!batch) throw new Error();
        const items = batch.items.filter((clip) => clip.id && clip.textEn && clip.end > clip.start);
        if (!items.length) {
          this.setData({ loading: false, last: advance, message: advance ? '这一轮已完成' : '暂无盲听切片' });
          return;
        }
        this._items = items;
        this._page = page;
        this._hasMore = batch.hasMore;
        this._select(0, page === 1 ? 1 : this.data.number + 1, advance);
      } catch (err) {
        if (epoch === this._epoch) this.setData({ loading: false, message: '切片加载失败，请重试' });
      }
    },
    _select(index, number, autoplay) {
      this._pauseAudio();
      this._epoch++;
      this._index = index;
      this._window = null;
      this._position = null;
      this.setData({
        clip: this._items[index], number, stage: 'blind', input: '', quizScore: null,
        result: null, recording: 'idle', loading: false, message: '',
        last: index === this._items.length - 1 && !this._hasMore,
      });
      if (autoplay) this.toggleAudio();
    },
    next() {
      if (!this.data.active || this.data.stage !== 'revealed' || this.data.loading || this.data.recording !== 'idle') return;
      if (this._index + 1 >= this._items.length) return this.loadPage();
      this._select(this._index + 1, this.data.number + 1, true);
    },
    _pauseAudio() {
      this._audioSeq++;
      if (this._player.getKind()) this._position = this._player.estimatedPos();
      this._player.stop();
      if (this.data.audio !== 'idle') this.setData({ audio: 'idle' });
    },
    _playWindow(startSec) {
      const win = this._window;
      this._player.playUrl(win.url, 'ear', { startSec, endSec: win.winEnd });
      this.setData({ audio: 'playing' });
    },
    async toggleAudio() {
      const clip = this.data.clip;
      if (!clip || !this.data.active || this.data.loading || this.data.recording !== 'idle') return;
      if (this.data.audio !== 'idle') return this._pauseAudio();
      const seq = ++this._audioSeq;
      this.setData({ audio: 'loading' });
      try {
        // 手动起播刷新签名（含失败重试）；单句循环直接重用当前音源。
        const source = await feed.fetchClipAudio(clip.id);
        if (seq !== this._audioSeq) return;
        if (!source.url) throw new Error();
        this._window = { ...sentenceWindow(clip, source.clipOffset), url: source.url };
        const win = this._window;
        const pos = this._position;
        this._playWindow(pos != null && pos >= win.winStart && pos < win.winEnd ? pos : win.winStart);
      } catch (err) {
        if (seq === this._audioSeq) {
          this.setData({ audio: 'idle' });
          wx.showToast({ title: err.statusCode === 403 ? '该原声需会员权限' : '原声加载失败，请重试', icon: 'none' });
        }
      }
    },
    beginQuiz() { this.setData({ stage: 'quiz' }); },
    onInput(e) { this.setData({ input: e.detail.value }); },
    submit(e) {
      if (this.data.stage !== 'quiz') return;
      const input = String(e.detail.value == null ? this.data.input : e.detail.value).trim().toLowerCase();
      const hit = input.length > 2 && this.data.clip.textEn.toLowerCase().includes(input);
      this.setData({ stage: 'revealed', quizScore: hit ? 100 : 70 });
    },
    reveal() { this.setData({ stage: 'revealed', quizScore: null }); },
    async record() {
      if (this.data.recording === 'recording') return this.finishRecording();
      if (this.data.recording !== 'idle' || this.data.loading || !this.data.active || this.data.stage !== 'revealed') return;
      this._pauseAudio();
      const epoch = this._epoch;
      this.setData({ recording: 'permission', result: null });
      try {
        const allowed = await recorder.ensurePermission();
        if (epoch !== this._epoch) return;
        if (!allowed || !recorder.start({ ensurePerm: false })) throw new Error('无法使用麦克风，请检查录音权限');
        this.setData({ recording: 'recording' });
        this._recordTimer = setTimeout(() => this.finishRecording(), 2000);
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
        const weak = result.words.filter(w => w.score < 75).map(w => w.word).slice(0, 3);
        this.setData({ result: { score: result.overallScore, feedback: weak.length
          ? '再听一遍 ' + weak.join('、') + '，对照原声练习发音。'
          : '再听一遍原声，对照重音和连读节奏。' } });
      } catch (err) {
        if (epoch === this._epoch) wx.showToast({ title: (err.body && err.body.message) || err.message || '评测失败，请重试', icon: 'none' });
      } finally {
        if (epoch === this._epoch) this.setData({ recording: 'idle' });
      }
    },
  },
});
