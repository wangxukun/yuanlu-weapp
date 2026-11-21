const trainingLookup = require('../../utils/training-word-lookup');

module.exports = {
  ...trainingLookup,

  getLookupClip() {
    const sub = this.data.subtitle;
    return sub && {
      clipid: sub.clipId, episodeid: this.data.episodeId, start: sub.episodeStart,
      textEn: sub.textEn, textCn: sub.textCn,
    };
  },

  onShow() {
    this._hidden = false;
    this._syncTheme();
    if (this._savedWords) this._syncSavedWords();
    this._resumeLookupPlayback();
  },

  onHide() {
    this._hidden = true;
  },

  onUnload() {
    this._disposed = true;
    this._hidden = true;
    this._lookupId = (this._lookupId || 0) + 1;
    this._lookupPlayback = null;
    this._savedWords = null;
  },
};
