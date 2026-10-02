/**
 * components/transcript-preview — 非会员文稿预览弹层（DOWNLOAD-TASK T1.4）
 *
 * 复刻源：yuanlu/components/episode/summarize/TranscriptPreviewModal.tsx（Web 唯一实现，
 * Android 无对应卡——按项目口径：内容=Web、容器风格=小程序既有弹层先例 premium-modal）。
 * 结构：文稿预览徽标 + PDF 纸张复刻（页眉/标题块/双语句块/页脚 + 底部渐隐遮罩）
 *       + 会员拦截卡。
 *
 * 拦截卡（2026-10-01 用户指令改版）：不再复刻 Web 原版「皇冠 + 会员专享内容」卡，
 * 改为 premium-modal 的 episode_audio_download 场景卡——样式经 wxss @import 复用
 * pm-* 类零漂移，数据/埋点/CTA 逻辑同样单源引自 premium-modal（getScenario 导出）：
 *   - 打开瞬间上报 PREMIUM_MODAL_OPEN（source=episode_audio_download，同红线：关复位可再报）
 *   - CTA 对齐 premium-modal.onCta 真路由（关弹层 + 跳订阅页 source=场景键，
 *     T2.1 同款，2026-10-02 真机走查补齐本组件漏网接线）
 * 卡面文案在场景基线上按用户指令（2026-10-01 二次精减）做文稿专属裁剪：
 *   标题「文稿下载是会员专属」、去整段描述、权益仅留「文稿 PDF 下载」；
 *   价格锚点/CTA 仍单源跟随场景（改场景两弹窗同改），premium-modal 弹窗本体不受影响。
 *
 * 使用：<transcript-preview visible="{{show}}" preview="{{transcriptPreview}}" episode="{{episode}}"
 *        bind:close="onTranscriptPreviewClose" />
 * preview 契约（GET /api/episode/transcript-preview）：{ podcastTitle, episodeTitle, coverUrl, subtitles[{textEn,textCn}], totalSubtitles }
 * 预览失败时页面传 null → 纸张区显示「暂无预览数据」（Web 静默降级口径） */
const { trackEvent } = require('../../utils/track');
const { getScenario } = require('../premium-modal/index');

/** 与 Web 同式：剥离中文译文里的说话人标记 [SPEAKER_n]: */
function stripSpeaker(text) {
  return String(text || '').replace(/\[SPEAKER_\d+\]:\s*/g, '');
}

/** 与 Web 同式页数公式：1 + ceil(max(0, total - 8) / 12)，下限 1 */
function calcPageCount(total) {
  const n = Number(total) || 0;
  return Math.max(1, 1 + Math.ceil(Math.max(0, n - 8) / 12));
}

/** 拦截卡 = 下载场景基线的文稿专属裁剪（用户指令 2026-10-01）：
 *  标题改文稿语境、去描述、权益仅留「文稿 PDF 下载」；
 *  priceAnchor/cta 不覆写 → 仍随场景单源联动 */
const TRANSCRIPT_BENEFIT = '文稿 PDF 下载';
const INTERCEPT = (() => {
  const base = getScenario('episode_audio_download');
  return Object.assign({}, base, {
    title: '文稿下载是会员专属',
    description: '',
    benefits: base.benefits.filter((b) => b === TRANSCRIPT_BENEFIT),
  });
})();

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
    // 拦截卡（场景基线裁剪版，见 INTERCEPT 注释）
    intercept: INTERCEPT,
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
    // 触墙即转化曝光：与 premium-modal 同款红线（打开瞬间上报、同开不重报、关复位）
    visible: function (visible) {
      if (visible) {
        if (!this._tracked) {
          this._tracked = true;
          trackEvent('PREMIUM_MODAL_OPEN', 'episode_audio_download');
        }
      } else {
        this._tracked = false;
      }
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },
    /** 拦截卡 CTA：订阅页真路由（T2.1 同款；本组件是下载模块期的内置卡，
     *  当时对齐占位行为，T2.1 只接了 premium-modal 本体——2026-10-02 真机
     *  走查补上）。source 固定场景键 episode_audio_download（与上方
     *  PREMIUM_MODAL_OPEN 上报同源，订阅页 T5.3 归因一致） */
    onCta() {
      this.onClose();
      wx.navigateTo({
        url: '/pages/subscription/index?source=episode_audio_download',
      });
    },
    noop() {},
  },
});
