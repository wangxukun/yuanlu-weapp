/**
 * components/sentence-tag-drawer — 句子收藏完善抽屉（底部 BottomSheet）
 *
 * 复刻 Web 端 components/sentence/QuickTagDrawer.tsx：收藏成功 toast 的
 * 「添加标签/笔记」action 打开。原句 + 译文预览、7 个预设分类标签多选、
 * 自定义标签（≤20 字）、个人学习笔记（≤2000 字），提交走真实
 * POST /api/sentences/meta { id, tags, note }，成功后 triggerEvent('updated')
 * 回传最新 tags/note 供宿主就地更新书签态。
 */

const { post } = require('../../utils/request');

/** 快捷标签预设（与 Web 端 PRESET_SENTENCE_TAGS 完全一致，共 7 个） */
const PRESET_SENTENCE_TAGS = [
  '地道表达',
  '长难句',
  '写作素材',
  '商务职场',
  '面试金句',
  '高频俚语',
  '发音重点',
];

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 待编辑的句子（SavedSentenceItem）；null 时抽屉关闭（对齐 Web sentence prop） */
    sentence: { type: Object, value: null },
  },

  data: {
    presets: PRESET_SENTENCE_TAGS,
    selectedTags: [],
    customTags: [], // 已加入的自定义标签（不在预设内，accent 底色 + ✕）
    note: '',
    customTagInput: '',
    isAddingTag: false,
    isSaving: false,
  },

  observers: {
    sentence(v) {
      if (!v) return;
      this.setData({
        selectedTags: v.tags && v.tags.length ? v.tags.slice() : ['地道表达'],
        note: v.note || '',
        customTagInput: '',
        isAddingTag: false,
        isSaving: false,
      });
      this._syncCustomTags();
    },
  },

  methods: {
    noop() {},

    _syncCustomTags() {
      const custom = (this.data.selectedTags || []).filter(
        (t) => PRESET_SENTENCE_TAGS.indexOf(t) === -1
      );
      this.setData({ customTags: custom });
    },

    onToggleTag(e) {
      const tag = e.currentTarget.dataset.tag;
      const sel = this.data.selectedTags.slice();
      const i = sel.indexOf(tag);
      if (i >= 0) sel.splice(i, 1);
      else sel.push(tag);
      this.setData({ selectedTags: sel });
      this._syncCustomTags();
    },

    onStartAddTag() {
      this.setData({ isAddingTag: true });
    },

    onCustomInput(e) {
      this.setData({ customTagInput: e.detail.value });
    },

    /** 确认添加自定义标签（回车 / ✓ 按钮同路径） */
    onConfirmAddTag() {
      const val = (this.data.customTagInput || '').trim();
      if (val && this.data.selectedTags.indexOf(val) === -1) {
        this.setData({ selectedTags: this.data.selectedTags.concat(val) });
      }
      this.setData({ customTagInput: '', isAddingTag: false });
      this._syncCustomTags();
    },

    onNoteInput(e) {
      this.setData({ note: e.detail.value });
    },

    onClose() {
      this.triggerEvent('close');
    },

    /** 保存标签与笔记：POST /api/sentences/meta，成功 toast + updated + close */
    async onSave() {
      if (this.data.isSaving || !this.data.sentence) return;
      this.setData({ isSaving: true });
      const finalTags =
        this.data.selectedTags.length > 0 ? this.data.selectedTags : ['地道表达'];
      const finalNote = this.data.note.trim() || null;
      try {
        const res = await post(
          '/api/sentences/meta',
          { id: this.data.sentence.id, tags: finalTags, note: finalNote },
          { showError: false }
        );
        if (res && res.success) {
          wx.showToast({ title: '✨ 句子笔记与标签已保存！', icon: 'none' });
          this.triggerEvent('updated', {
            id: this.data.sentence.id,
            tags: finalTags,
            note: finalNote,
          });
          this.triggerEvent('close');
        } else {
          wx.showToast({ title: (res && res.message) || '保存失败', icon: 'none' });
          this.setData({ isSaving: false });
        }
      } catch (err) {
        wx.showToast({ title: '网络错误', icon: 'none' });
        this.setData({ isSaving: false });
      }
    },
  },
});
