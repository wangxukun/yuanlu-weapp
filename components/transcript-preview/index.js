/**
 * components/transcript-preview — 非会员文稿预览弹层（DOWNLOAD-TASK T1.4）
 *
 * 复刻源：yuanlu/components/episode/summarize/TranscriptPreviewModal.tsx（Web 唯一实现，
 * Android 无对应卡——按项目口径：内容=Web、容器风格=小程序既有弹层先例 premium-modal）。
 * 结构：文稿预览徽标 + PDF 纸张复刻（页眉/标题块/双语句块/页脚 + 底部渐隐遮罩）+ 会员拦截卡。
 * 拦截卡文案与 Web 逐字一致（与 premium-modal DEFAULT_SCENARIO 同源）；
 * CTA Web 跳 /auth/subscribe，小程序订阅页未建 → triggerEvent('cta') 由页面拉起 premium-modal 同场景承接。
 *
 * 使用：<transcript-preview visible="{{show}}" preview="{{transcriptPreview}}" episode="{{episode}}"
 *        bind:close="onTranscriptPreviewClose" bind:cta="onTranscriptPreviewCta" />
 * preview 契约（GET /api/episode/transcript-preview）：{ podcastTitle, episodeTitle, coverUrl, subtitles[{textEn,textCn}], totalSubtitles }
 * 预览失败时页面传 null → 纸张区显示「暂无预览数据」（Web 静默降级口径）。
 */

/** 与 Web 同式：剥离中文译文里的说话人标记 [SPEAKER_n]: */
function stripSpeaker(text) {
  return String(text || '').replace(/\[SPEAKER_\d+\]:\s*/g, '');
}

/** 与 Web 同式页数公式：1 + ceil(max(0, total - 8) / 12)，下限 1 */
function calcPageCount(total) {
  const n = Number(total) || 0;
  return Math.max(1, 1 + Math.ceil(Math.max(0, n - 8) / 12));
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    /** 接口预览数据；null = 拉取失败（空态） */
    preview: { type: Object, value: null },
    /** 兜底字段源（Web：preview?.podcastTitle || episode.podcast?.title || '远路播客'） */
    episode: { type: Object, value: null },
  },

  data: {
    podcastTitle: '远路播客',
    episodeTitle: '',
    coverUrl: '',
    subtitles: [],
    pageCount: 1,
  },

  observers: {
    'preview, episode': function (preview, episode) {
      const ep = episode || {};
      const pv = preview || {};
      const subtitles = Array.isArray(pv.subtitles)
        ? pv.subtitles.map((s) => ({
            textEn: s.textEn || '',
            textCn: stripSpeaker(s.textCn),
          }))
        : [];
      this.setData({
        podcastTitle: pv.podcastTitle || ep.podcastTitle || (ep.podcast && ep.podcast.title) || '远路播客',
        episodeTitle: pv.episodeTitle || ep.title || '',
        coverUrl: pv.coverUrl || ep.coverUrl || '',
        subtitles,
        pageCount: calcPageCount(pv.totalSubtitles),
      });
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },
    /** 拦截卡 CTA：页面侧关闭预览并拉起 premium-modal（episode_audio_download） */
    onCta() {
      this.triggerEvent('cta');
    },
    noop() {},
  },
});
