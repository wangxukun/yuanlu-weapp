/**
 * components/review/speech-profile-card — 发音能力画像卡
 * 完整复刻 Android feature/pronunciation/PronunciationNotebookScreen.kt 的
 * SpeechProfileCard（Material3）：标题行（Speed 图标底衬 + CEFR 纯文字胶囊）
 * → 五维雷达（RadarChart.kt 等价 canvas 自绘，渲染在 utils/pron-core）→
 * 三统计格（评测次数/综合得分/平均语速）→ 说明条。
 *
 * 主题口径（Android theme/Color.kt 原值）：
 * - surface 浅 #FFFFFF / 深 #1E1B16；onSurface 浅 #1C1917 / 深 #E8E3D9
 * - 内嵌底（background/surfaceVariant）浅 #FAF8F3 / 深 #26221C
 * - onSurfaceVariant 浅 #57534E / 深 #A8A29E；outline 浅 #E5E0D5 / 深 #3A342C（@0.4 边框）
 * - secondary 双态恒 #D98A17（accent-500，与 Web globals.css 深色 #ECB35E 不同——
 *   以 Android 为准）；雷达网格/标签色随主题（浅 #E5E7EB/#6B7280、深 #3A342C/#A8A29E），
 *   数据多边形紫 #7C3AED 双态恒值
 * - 图标 Material Icons.Filled（Speed/Info 官方 24px path 烘焙，非 lucide）
 */
const pronCore = require('../../../utils/pron-core');
const theme = require('../../../utils/theme');

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 归一画像（pronCore.normalizeProfile 输出） */
    profile: { type: Object, value: null },
    /** 五维雷达点（pronCore.toRadarData 输出：[{dim, score, fullMark}]） */
    radar: { type: Array, value: [] },
  },

  data: {
    themeClass: '',
    dark: false,
    hasData: false,
    // 三统计格展示口径（Android StatCell：round / null→— / 语速带单位）
    avgOverallText: '—',
    avgSpeedText: '—',
    // 说明条（Android 单一 Text：CEFR 版「」引号 / 无数据版引导）
    hintIsCefr: false,
    hintText: '',
    icons: { speed: '', speedFaint: '', infoHint: '' },
  },

  lifetimes: {
    attached() {
      this._syncTheme();
      this._applyProfile();
    },
    ready() {
      this._draw();
    },
  },

  observers: {
    'profile, radar': function () {
      this._applyProfile();
    },
    dark() {
      this._syncIcons();
      this._draw(); // 雷达网格/标签色随主题，深浅切换需重绘
    },
  },

  methods: {
    /** 外观根类（组件内 var 双轨，不依赖全局令牌）+ 图标变体 */
    _syncTheme() {
      const dark = theme.getEffective() === 'dark';
      this.setData({ themeClass: theme.rootClass(), dark });
      this._syncIcons();
    },

    _syncIcons() {
      const d = this.data.dark;
      this.setData({
        icons: {
          // IconBadge tint=secondary 双态恒 #D98A17
          speed: '/assets/icons/speed-secondary.svg',
          speedFaint: d ? '/assets/icons/speed-faint-dark.svg' : '/assets/icons/speed-faint.svg',
          // 说明条：CEFR 版 Info tint=secondary；无数据版 onSurfaceVariant 随主题
          infoHint: this.data.hintIsCefr
            ? '/assets/icons/info-secondary.svg'
            : d
              ? '/assets/icons/info-onsurface-dark.svg'
              : '/assets/icons/info-onsurface.svg',
        },
      });
    },

    /** 展示字段与说明文案派生（Android SpeechProfileCard 内联口径） */
    _applyProfile() {
      const p = this.data.profile;
      const hasData = !!(p && Number(p.evalCount) > 0);
      const avgOverall = p ? pronCore.num(p.avgOverall) : null;
      const avgSpeed = p ? pronCore.num(p.avgSpeed) : null;
      const cefr = p ? p.cefrLevel : null;
      const hintIsCefr = hasData && !!cefr;
      const hintText = hintIsCefr
        ? '根据你的评测表现，当前发音水平约为 CEFR ' +
          cefr +
          ' 级，首页「为你推荐」已按该等级匹配剧集难度。评测越多，画像越准。'
        : '在任意剧集的跟读练习中完成语音评测，即可生成专属画像并获得难度匹配推荐。';
      this.setData(
        {
          hasData,
          hintIsCefr,
          hintText,
          avgOverallText: avgOverall === null ? '—' : String(Math.round(avgOverall)),
          avgSpeedText: avgSpeed === null ? '—' : Math.round(avgSpeed) + ' 词/分',
        },
        () => {
          this._syncIcons();
          this._draw();
        },
      );
    },

    /** 雷达自绘：setData 回调（渲染完成后）再查 canvas 节点；主题色随 dark */
    _draw() {
      if (!this.data.hasData) return;
      const radar = this.data.radar || [];
      if (!radar.length) return;
      const dark = this.data.dark;
      try {
        this.createSelectorQuery()
          .select('#spcRadar')
          .fields({ node: true, size: true })
          .exec((res) => {
            const info = res && res[0];
            if (!info || !info.node || !info.width) return;
            let dpr = 1;
            try {
              const wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
              dpr = wi.pixelRatio || 1;
            } catch (e) {
              /* 画布清晰度兜底 1x */
            }
            pronCore.drawRadarChart(info.node, info.width, info.height, radar, dpr, {
              gridColor: dark
                ? pronCore.RADAR_GRID_STROKE_DARK
                : pronCore.RADAR_GRID_STROKE_LIGHT,
              labelColor: dark
                ? pronCore.RADAR_TICK_FILL_DARK
                : pronCore.RADAR_TICK_FILL_LIGHT,
            });
          });
      } catch (e) {
        // 画布查询失败静默（统计格/徽章不受影响）
      }
    },
  },
});
