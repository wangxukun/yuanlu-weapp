/**
 * components/vocabulary-modal — 生词收藏全屏弹窗
 *
 * 复刻 Web 端 components/episode/transcript/VocabularyModal.tsx 的移动端形态
 * （modal-bottom 全屏白底）：单词大标题 + 收藏/关闭、英美音标 + 发音按钮
 * （InnerAudioContext 直播 dictvoice 音源）、词性与释义卡、🧬 词源记忆折叠面板
 * （前缀琥珀/词根远青/后缀灰 chips + 拆解 + 💡记忆技巧）、例句区、底部
 * 「来源：剧集名 + 完成学习 →」。
 * 查询与落库逻辑在宿主页面（onWordTap / onVocabSave），本组件只管展示与事件。
 */

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    visible: { type: Boolean, value: false },
    word: { type: String, value: '' },
    dictData: { type: Object, value: null }, // DictEntryDTO
    loading: { type: Boolean, value: false },
    saving: { type: Boolean, value: false },
    isSaved: { type: Boolean, value: false },
    episodeTitle: { type: String, value: '' },
  },

  data: {
    etyOpen: false,       // 词源记忆面板展开态
    headerSafeTop: 0,     // 顶部控制栏安全高度（px）：避让原生胶囊按钮（Bug 3）
  },

  lifetimes: {
    attached() {
      this.setData({ headerSafeTop: this._calcHeaderSafeTop() });
    },
    detached() {
      if (this._audio) {
        this._audio.destroy();
        this._audio = null;
      }
    },
  },

  observers: {
    // 查询新词时重置折叠（对齐 VocabularyModal 的 useEffect [selectedWord]）
    word() {
      this.setData({ etyOpen: false });
    },
  },

  methods: {
    /**
     * 顶部安全高度（Bug 3）：书签/关闭图标须整体落在原生胶囊按钮下方。
     * 优先胶囊实际下缘（getMenuButtonBoundingClientRect）+ 8px 间距；
     * 取不到胶囊时退回 statusBarHeight + 48（胶囊高 ≈32 + 上下边距）。
     */
    _calcHeaderSafeTop() {
      try {
        if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
          const rect = wx.getMenuButtonBoundingClientRect();
          if (rect && rect.bottom) return rect.bottom + 8;
        }
        const win = wx.getWindowInfo
          ? wx.getWindowInfo()
          : wx.getSystemInfoSync();
        return (win.statusBarHeight || 20) + 48;
      } catch (e) {
        return 68; // 兜底：常见机型胶囊下缘约 80px 的一半高度再加余量
      }
    },
    onClose() {
      this.triggerEvent('close');
    },

    onSave() {
      if (this.data.saving || this.data.isSaved) return;
      this.triggerEvent('save');
    },

    onComplete() {
      this.triggerEvent('complete');
    },

    onToggleEty() {
      this.setData({ etyOpen: !this.data.etyOpen });
    },

    /** 英 / 美发音（Web: new Audio(url).play()） */
    onPlayAudio(e) {
      const url = e.currentTarget.dataset.url;
      if (!url) return;
      if (!this._audio) {
        this._audio = wx.createInnerAudioContext();
      }
      this._audio.stop();
      this._audio.src = url;
      this._audio.play();
    },
  },
});
