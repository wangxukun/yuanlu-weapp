/**
 * components/voice/eval-card — 语音评测卡（REVIEW-TASK T3.2）
 * 复刻 Web components/voice/SpeechEvaluationCard.tsx 三段式，播放/录音/
 * 评测内核复用 pages/speech-eval 七轮真机验证链路的底座化版本：
 *
 * - 顶部工具行：AI 朗读（tts 全链）/ 原声播放 / 慢速播放（0.75，起播后置
 *   playbackRate）/ 收藏句子书签（事件外抛父页处理）/ 单句循环（原声/慢速
 *   到窗终自动重播）/ 翻译开关 + 英文句（衬线）+ 中文（开关开时）
 * - 录音区四互斥态：配额锁定（橙虚线圆锁 + 皇冠 CTA「解锁无限评测」→
 *   自持 premium-modal(review_eval_quota)）/ 空闲（主色圆 Mic「点击录音」）/
 *   录音中（红色脉冲停止钮 + 波形动画）/ 处理中（「正在分析发音...」）
 * - 结果区：综合得分环（≥85 加 ✨；评级 ≥passThreshold「Excellent!」/
 *   ≥60「Good Job!」/ 其余「Keep Trying!」）+ 三维进度条（准确度/流利度/
 *   完整度）+ 逐词胶囊（≥85 绿 / 60-84 琥珀 / <60 红；点词展开音素行：
 *   美音/英音 dictvoice 直链 + 原声词级时间戳窗口 + 「我」录音切片）+ 再试一次
 *
 * - 状态机 idle → recording → processing → result；录音走 utils/recorder
 *   （T3.1：PCM→WAV base64、停止不依赖 onStop）；播放走 utils/clip-player
 *   （T3.2：墙钟外推 + 50ms 看门狗句界精度）
 * - 评测：POST /api/speech/evaluate {episodeId, subtitleId, targetText,
 *   audioBase64, rate:16000, scenario}（一次完成评测+落库）；403
 *   REVIEW_EVAL_QUOTA_EXCEEDED → toast + 本卡永久置锁 + premium-modal；
 *   成功后 GET /api/speech/quota 刷新余量并外抛 quota 事件
 * - 事件：evaluate {score, details, recognitionId}（父页判定达标）；
 *   quota {used, limit, exhausted}；bookmark（收藏/取消收藏交父页）
 */
const core = require('../../../utils/speech-core');
const recorder = require('../../../utils/recorder');
const clipPlayerFactory = require('../../../utils/clip-player');
const tts = require('../../../utils/tts');
const audioBus = require('../../../utils/audio-bus');
const theme = require('../../../utils/theme');
const { post, get } = require('../../../utils/request');

const PCM_RATE = 16000;
const MIN_RECORD_BYTES = PCM_RATE * 2 * 0.5; // 0.5s 的 16bit mono PCM
const AMP_WINDOW = 24; // 波形滚动窗口（Android takeLast(24)）

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 当前句：{textEn, textCn, words[{word,start,end}], audioUrl, start, end} */
    subtitle: { type: Object, value: null },
    /** 字幕定位 id（评测入参与跟读跳转依据） */
    subtitleId: { type: null, value: null },
    episodeId: { type: String, value: '' },
    episodeTitle: { type: String, value: '' },
    /** 评测场景（review = 刷句跟读/闯关共用日池） */
    evalScenario: { type: String, value: 'review' },
    /** 配额锁定（父页预检透传；403 后本卡自持永久置锁） */
    quotaLocked: { type: Boolean, value: false },
    /** 历史结果（有则入场即结果态） */
    previousResult: { type: Object, value: null },
    /** 过关分数线（达标判定与 Excellent 档文案） */
    passThreshold: { type: Number, value: 80 },
    /** 收藏书签态（高亮由父页传入；toggle 动作经 bookmark 事件外抛） */
    bookmarked: { type: Boolean, value: false },
  },

  data: {
    phase: 'idle', // idle | recording | processing | result
    amplitudes: [],
    result: null,
    selectedWordIndex: null,
    playing: '', // '' | ai | original | slow | user | word_us | word_uk | word_original | word_me
    loop: false,
    showCn: false,
    locked: false,
    showPremiumModal: false,
    premiumSource: '',
    // 外观根类：组件根自持 themeClass（手动深色令牌覆盖的载体——组件样式
    // 无法命中页面层祖先类，vocab-notebook 同款配方）
    themeClass: '',
    // WXML 就绪派生（零方法调用红线）
    textEn: '',
    textCn: '',
    hasCn: false,
    rating: '',
    ratingSub: '',
  },

  lifetimes: {
    attached() {
      this._unsubTts = tts.subscribe((s) => this._onTtsState(s));
      this._unbus = audioBus.register(() => this._player && this._player.stop());
      this._unsubAmp = recorder.onAmplitude((amp) => {
        this.setData({ amplitudes: this.data.amplitudes.concat(amp).slice(-AMP_WINDOW) });
      });
      this._player = clipPlayerFactory.createClipPlayer({
        onPlaying: (k) => this.setData({ playing: k || '' }),
        onEnded: (kind) => {
          // 单句循环：原声/慢速自然到窗终后自动重播
          if ((kind === 'original' || kind === 'slow') && this.data.loop) {
            const kindMap = { original: 1, slow: 0.75 };
            this._playOriginal(kindMap[kind]);
          }
        },
      });
      this.setData({ locked: this.data.quotaLocked });
      this.setData({
        themeClass: theme.rootClass(),
        dark: theme.getEffective() === 'dark',
      });
      this._applySubtitle();
    },
    detached() {
      if (this._unsubTts) this._unsubTts();
      if (this._unbus) this._unbus();
      if (this._unsubAmp) this._unsubAmp();
      if (this._player) this._player.stop();
      recorder.cancel(); // 若仍在录，丢弃并释放麦克风
      tts.stop();
    },
  },

  observers: {
    subtitle() {
      this._applySubtitle();
    },
    quotaLocked(v) {
      if (v && !this.data.locked) this.setData({ locked: true });
    },
  },

  methods: {
    /** 换句重置（previousResult 有则直接结果态）；播放/录音随 detached 或显式停 */
    _applySubtitle() {
      const sub = this.data.subtitle || {};
      const prev = this.data.previousResult;
      if (this._player) this._player.stop();
      this.setData({
        textEn: sub.textEn || '',
        textCn: sub.textCn || '',
        hasCn: !!sub.textCn,
        phase: prev ? 'result' : 'idle',
        result: prev || null,
        selectedWordIndex: null,
        amplitudes: [],
        showCn: false,
        rating: '',
        ratingSub: '',
      });
      if (prev) this._applyRating(prev.overallScore);
    },

    /** 评级文案（spec 口径：≥passThreshold「Excellent!」/ ≥60「Good Job!」/ 其余「Keep Trying!」） */
    _applyRating(score) {
      const th = this.data.passThreshold;
      const rating = score >= th ? 'Excellent!' : score >= 60 ? 'Good Job!' : 'Keep Trying!';
      const ratingSub = score >= th
        ? '已过关（≥' + th + '），发音很棒！'
        : '继续练习，达到 ' + th + ' 分即可过关';
      this.setData({ rating, ratingSub });
    },

    _onTtsState(s) {
      // AI 朗读态回流：playing==='ai' 且 TTS 停止 → 复位
      if (this.data.playing === 'ai' && !(s && (s.playingText || s.playingUrl))) {
        this.setData({ playing: '' });
      }
    },

    /* ---------------- 顶部工具行 ---------------- */

    /** AI 朗读（tts.js 全链：合成→下载中转→降级；状态/配额由 tts 编排） */
    onAiReading() {
      if (this.data.phase === 'processing') return;
      if (this.data.playing === 'ai') {
        tts.stop();
        return;
      }
      if (!this.data.textEn) return;
      this._player.stop();
      this.setData({ playing: 'ai' }); // 先置态供按钮高亮（Web 同款）
      tts.speak(this.data.textEn);
    },

    /** 原声/慢速片段（speed 1.0 / 0.75；起点优先词级时间戳） */
    _playOriginal(speed) {
      const sub = this.data.subtitle || {};
      const url = sub.audioUrl;
      if (!url || !sub.textEn) {
        wx.showToast({ title: '原声音频不可用', icon: 'none' });
        return;
      }
      const words = sub.words || [];
      const startSec = words.length ? words[0].start : sub.start;
      const endSec = words.length ? words[words.length - 1].end : sub.end;
      this._player.playUrl(url, speed < 1 ? 'slow' : 'original', {
        startSec, endSec, rate: speed,
      });
    },

    _onPlayOriginalTap() {
      if (this.data.phase === 'processing') return;
      if (this.data.playing === 'original') {
        this._player.stop();
        return;
      }
      this._playOriginal(1);
    },

    _onPlaySlowTap() {
      if (this.data.phase === 'processing') return;
      if (this.data.playing === 'slow') {
        this._player.stop();
        return;
      }
      this._playOriginal(0.75);
    },

    /** 收藏书签：POST /api/sentences/toggle 真收藏/取消（精听页同款语义），
     *  成功翻转本地态 + toast；403 sentence_quota → 自持 premium-modal */
    onToggleBookmark() {
      if (this._bookmarkBusy) return;
      const sub = this.data.subtitle || {};
      if (this.data.subtitleId == null) {
        wx.showToast({ title: '该句缺少字幕定位，无法收藏', icon: 'none' });
        return;
      }
      if (!sub.textEn) return;
      this._bookmarkBusy = true;
      const target = !this.data.bookmarked;
      this.setData({ bookmarked: target }); // 乐观翻转
      post('/api/sentences/toggle', {
        episodeid: this.data.episodeId,
        subtitleId: this.data.subtitleId,
        startTime: sub.start,
        endTime: sub.end,
        enText: sub.textEn,
        zhText: sub.textCn,
      }, { showError: false })
        .then((body) => {
          if (!body || body.success === false) {
            this.setData({ bookmarked: !target }); // 失败回滚
            wx.showToast({ title: (body && body.message) || '操作失败，请重试', icon: 'none' });
            return;
          }
          const saved = body.data ? !!body.data.saved : target;
          this.setData({ bookmarked: saved });
          wx.showToast({
            title: saved ? '已收藏至「句子本」' : '已从「句子本」移除',
            icon: 'none',
          });
          this.triggerEvent('bookmark', { subtitleId: this.data.subtitleId, saved });
        })
        .catch((err) => {
          this.setData({ bookmarked: !target });
          if (err && err.statusCode === 403) {
            // 句子本容量墙（满 30）：toast 由 request.js 统一，弹会员窗
            this.setData({ showPremiumModal: true, premiumSource: 'sentence_quota' });
          }
          // 其余失败 toast 由 request.js 统一（showError:false 时手补）
          if (!err || err.statusCode !== 403) {
            wx.showToast({ title: (err && err.message) || '网络错误', icon: 'none' });
          }
        })
        .then(() => { this._bookmarkBusy = false; });
    },

    /** 单句循环开关（开：原声/慢速到窗终自动重播；关：播完即停） */
    onToggleLoop() {
      this.setData({ loop: !this.data.loop });
    },

    /** 翻译开关 */
    onToggleCn() {
      this.setData({ showCn: !this.data.showCn });
    },

    /* ---------------- 录音区（四态） ---------------- */

    async onToggleRecording() {
      const phase = this.data.phase;
      if (phase === 'processing') return;
      if (this.data.locked) {
        // 配额锁定态：皇冠 CTA → 会员转化
        this.setData({ showPremiumModal: true, premiumSource: 'review_eval_quota' });
        return;
      }
      if (phase === 'recording') {
        this._finishRecording();
        return;
      }
      // idle → 起录（权限/互斥由 utils/recorder 编排）
      const ok = await recorder.start();
      if (!ok) {
        wx.showToast({ title: '无法访问麦克风，请检查权限设置', icon: 'none' });
        return;
      }
      this._player.stop();
      tts.stop();
      this.setData({ phase: 'recording', amplitudes: [], result: null, selectedWordIndex: null });
    },

    /** 停止录音并评测（T3.1 底座：直取内存帧，不依赖 onStop） */
    async _finishRecording() {
      this.setData({ phase: 'processing', amplitudes: [] });
      const { base64, wavPath, bytes } = await recorder.stop();
      if (bytes < MIN_RECORD_BYTES) {
        this.setData({ phase: 'idle' });
        wx.showToast({ title: '录音太短，请重试', icon: 'none' });
        return;
      }
      this._evaluate(base64, wavPath);
    },

    /** 评测 REST（一次完成评测+落库）：POST /api/speech/evaluate */
    _evaluate(audioBase64, wavPath) {
      const sub = this.data.subtitle || {};
      post('/api/speech/evaluate', {
        episodeId: this.data.episodeId,
        subtitleId: this.data.subtitleId,
        targetText: sub.textEn,
        audioBase64,
        rate: PCM_RATE,
        scenario: this.data.evalScenario,
      }, { timeout: 60000, showError: false })
        .then((body) => {
          if (!body || body.success === false) {
            throw Object.assign(
              new Error((body && (body.message || body.error)) || '评测失败，请重试'),
              { body },
            );
          }
          const result = core.parseEvalResponse(body);
          result.userAudioPath = wavPath || '';
          this._applyRating(result.overallScore);
          this.setData({ phase: 'result', result, selectedWordIndex: null });
          this.triggerEvent('evaluate', {
            score: result.overallScore,
            details: result,
            recognitionId: result.recognitionId,
          });
          this._refreshQuota();
        })
        .catch((err) => {
          this.setData({ phase: 'idle' });
          if (err && err.statusCode === 403) {
            // 配额墙：toast + 本卡永久置锁 + 会员转化（spec 口径）
            const body = err && err.body;
            wx.showToast({
              title: (body && body.message) || '今日免费评测次数已用完',
              icon: 'none', duration: 2500,
            });
            this.setData({ locked: true, showPremiumModal: true, premiumSource: 'review_eval_quota' });
            this.triggerEvent('quota', { exhausted: true });
          } else {
            wx.showToast({ title: (err && err.message) || '评测失败，请重试', icon: 'none' });
          }
        });
    },

    /** 每次评测后刷新日池余量并外抛（父页更新配额胶囊） */
    async _refreshQuota() {
      try {
        const res = await get('/api/speech/quota?scenario=' + this.data.evalScenario);
        if (res && res.success && res.data) {
          this.triggerEvent('quota', res.data);
        }
      } catch (e) {
        // 静默：余量刷新失败不干扰结果展示
      }
    },

    onRetryRecording() {
      this._player.stop();
      this.setData({ phase: 'idle', result: null, selectedWordIndex: null });
    },

    onPremiumClose() {
      this.setData({ showPremiumModal: false });
    },

    /* ---------------- 结果区：逐词胶囊 + 音素对比 ---------------- */

    /** 点词展开音素诊断（仅 <85 且有音素明细的可点） */
    onSelectWord(e) {
      const index = Number(e.currentTarget.dataset.index);
      const w = this.data.result && this.data.result.words && this.data.result.words[index];
      if (!w || !w.phonemes || !w.phonemes.length) return;
      this.setData({ selectedWordIndex: this.data.selectedWordIndex === index ? null : index });
    },

    /** 回放我的发音（本地 WAV 优先） */
    onPlayUserAudio() {
      if (this.data.phase !== 'result') return;
      if (this.data.playing === 'user') {
        this._player.stop();
        return;
      }
      const result = this.data.result || {};
      const source = result.userAudioPath || result.userAudioUrl || '';
      if (!source) {
        wx.showToast({ title: '暂无录音可回放', icon: 'none' });
        return;
      }
      this._player.playUrl(source, 'user');
    },

    /** 有道词典发音（type 2=美音 1=英音） */
    onPlayDictVoice(e) {
      const ds = e.currentTarget.dataset;
      const word = ds.word;
      const us = ds.us === '1' || ds.us === 1;
      const kind = us ? 'word_us' : 'word_uk';
      if (this.data.playing === kind) {
        this._player.stop();
        return;
      }
      const url = 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) +
        '&type=' + (us ? 2 : 1);
      this._player.playUrl(url, kind);
    },

    /** 词级原声：词级时间戳定位选中词区间（模糊兜底匹配） */
    onPlayWordOriginal(e) {
      const word = e.currentTarget.dataset.word;
      if (this.data.playing === 'word_original') {
        this._player.stop();
        return;
      }
      const sub = this.data.subtitle || {};
      const url = sub.audioUrl;
      const words = sub.words || [];
      if (!url || !words.length) {
        wx.showToast({ title: '该句无词级时间戳', icon: 'none' });
        return;
      }
      const target = core.cleanWordKey(word);
      let hit = words.find((w) => core.cleanWordKey(w.word) === target);
      if (!hit) {
        let best = null;
        let bestD = Infinity;
        words.forEach((w) => {
          const d = core.cheapDistance(w.word, target);
          if (d < bestD) { bestD = d; best = w; }
        });
        hit = best;
      }
      if (!hit) {
        wx.showToast({ title: '原声中未找到该词', icon: 'none' });
        return;
      }
      this._player.playUrl(url, 'word_original', { startSec: hit.start, endSec: hit.end });
    },

    /** 词级「我」：录音中该词切片（有道返回的词级相对时间） */
    onPlayWordMe(e) {
      const index = Number(e.currentTarget.dataset.index);
      if (this.data.playing === 'word_me') {
        this._player.stop();
        return;
      }
      const result = this.data.result || {};
      const w = result.words && result.words[index];
      if (!w || w.start == null || w.end == null) {
        wx.showToast({ title: '该词无切片时间', icon: 'none' });
        return;
      }
      const source = result.userAudioPath || result.userAudioUrl || '';
      if (!source) {
        wx.showToast({ title: '暂无录音可回放', icon: 'none' });
        return;
      }
      this._player.playUrl(source, 'word_me', { startSec: w.start, endSec: w.end });
    },
  },
});
