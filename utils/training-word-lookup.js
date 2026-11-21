const { get, post } = require('./request');
const authStore = require('../store/authStore');
const dictTool = require('./dict-tool');

// 跟读页面提供当前句的语境；用卡片标识守住查词关闭后的续播位置。
module.exports = {
  getLookupPlayer() { return this.selectComponent('#training-card'); },

  _syncSavedWords() {
    const { token, isLoggedIn } = authStore.getState();
    if (this._savedWords && token === this._vocabOwner) return;
    this._vocabOwner = token;
    const saved = this._savedWords = new Set();
    if (this.data.wordModal) this.setData({ 'wordModal.isSaved': false, 'wordModal.saving': false });
    if (!isLoggedIn) return;
    get('/api/vocabulary/words', null, { showError: false }).then((body) => {
      if (saved !== this._savedWords || !Array.isArray(body && body.data)) return;
      body.data.forEach((word) => saved.add(String(word).toLowerCase()));
      if (this.onSavedWordsChange) this.onSavedWordsChange();
      if (this.data.wordModal) this.setData({ 'wordModal.isSaved': saved.has(this.data.wordModal.word) });
    }).catch(() => {});
  },

  async onWordLookup(e) {
    const word = e.detail.word.toLowerCase().replace(/’/g, "'");
    const clip = this.getLookupClip();
    if (!clip || !word || this._hidden || this.data.wordModal || this.data.finished) return;
    this._syncSavedWords();
    const lookupId = this._lookupId = (this._lookupId || 0) + 1;
    const card = this.getLookupPlayer();
    this._lookupPlayback = { key: this.data.cardKey || clip.clipid, playback: card && card.pauseForLookup() };
    this.setData({ wordModal: {
      word, loading: true, saving: false, dictData: null, isSaved: this._savedWords.has(word),
      examples: dictTool.buildClipCorpusExamples(clip, word),
    } });
    try {
      const body = await get('/api/dict/' + encodeURIComponent(word), null, { showError: false });
      if (lookupId !== this._lookupId) return;
      const entry = body && body.success && body.data;
      this.setData({
        'wordModal.loading': false,
        'wordModal.dictData': entry || null,
        'wordModal.examples': dictTool.buildClipCorpusExamples(clip, word, entry && entry.corpusExamples),
      });
    } catch (err) {
      if (lookupId !== this._lookupId) return;
      this.setData({ 'wordModal.loading': false });
      if (err.code === 'DICTIONARY_QUOTA_EXCEEDED') this.setData({ lookupQuota: 'dictionary_quota' });
      else wx.showToast({ title: '查词失败，请重新点词', icon: 'none' });
    }
  },

  async onVocabSave() {
    const m = this.data.wordModal;
    if (!m || m.saving || m.isSaved || m.loading) return;
    if (!authStore.getState().isLoggedIn) {
      wx.showModal({ title: '请先登录', content: '登录后可将这个词加入生词本', confirmText: '去登录',
        success: (r) => { if (r.confirm) this.onGoLogin(); } });
      return;
    }
    const lookupId = this._lookupId;
    const saved = this._savedWords;
    const entry = dictTool.clipVocabularyEntry(m.word, m.dictData, this.getLookupClip());
    this.setData({ 'wordModal.saving': true });
    try {
      await post('/api/vocabulary/add', entry, { showError: false });
      saved.add(m.word);
      if (lookupId !== this._lookupId || saved !== this._savedWords) return;
      if (this.onSavedWordsChange) this.onSavedWordsChange();
      wx.showToast({ title: '已加入生词本', icon: 'none' });
      this.onVocabClose();
    } catch (err) {
      if (lookupId !== this._lookupId || saved !== this._savedWords) return;
      this.setData({ 'wordModal.saving': false });
      if (err.statusCode === 400 && err.body && err.body.data && err.body.data.word) {
        saved.add(m.word);
        this.setData({ 'wordModal.isSaved': true });
      } else if (err.code === 'VOCABULARY_QUOTA_EXCEEDED' || err.code === 'VOCABULARY_DAILY_QUOTA_EXCEEDED') {
        this.setData({ lookupQuota: err.code === 'VOCABULARY_QUOTA_EXCEEDED' ? 'vocabulary_total' : 'vocabulary_daily' });
      } else {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
  },

  onLookupQuotaClose() {
    this.setData({ lookupQuota: '' }, () => this._resumeLookupPlayback());
  },

  onVocabClose() {
    this._lookupId++;
    this.setData({ wordModal: null }, () => this._resumeLookupPlayback());
  },

  _resumeLookupPlayback() {
    const resume = this._lookupPlayback;
    if (!resume || this._hidden || this.data.wordModal || this.data.lookupQuota) return;
    this._lookupPlayback = null;
    const clip = this.getLookupClip();
    if (resume.playback && clip && (this.data.cardKey || clip.clipid) === resume.key) {
      const card = this.getLookupPlayer();
      if (card) card.resumeAfterLookup(resume.playback);
    }
  },

  onVocabPractice(e) {
    const example = e.detail.example;
    if (!this.data.wordModal || !example) return;
    if (example.isCurrentClip) return this.onVocabClose();
    const word = this.data.wordModal.word;
    wx.navigateTo({
      url: '/pages/practice-room/index?word=' + encodeURIComponent(word) + '&clipId=' + encodeURIComponent(example.clipid),
      success: () => {
        this._lookupId++;
        this.setData({ wordModal: null });
      },
      fail: () => wx.showToast({ title: '未能打开跟读训练', icon: 'none' }),
    });
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/auth/index' });
  },
};
