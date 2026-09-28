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
    /** 宿主页弹窗打开中：开发者工具下 canvas 2d 不走同层渲染、原生层悬浮于
     * 弹窗之上（真机正常），弹窗期卸载画布、关闭后重挂载重绘 */
    popupOpen: { type: Boolean, value: false },
  },

  data: {
    themeClass: '',
    dark: false,
    hasData: false,
    // canvas 显式 px 尺寸（真机 scroll-view→swiper-item 内百分比尺寸解析错，
    // 原生 canvas 层拿到异常尺寸产生大块白色占位；attached 即按窗口宽度算术定寸）
    canvasW: 0,
    canvasH: 0,
    // 三统计格展示口径（Android StatCell：round / null→— / 语速带单位）
    avgOverallText: '—',
    avgSpeedText: '—',
    // CEFR 说明文案（「？」入口经 hintopen 事件由宿主页在页面根弹窗展示）
    hintText: '',
    icons: { speed: '', speedFaint: '', help: '' },
  },

  lifetimes: {
    attached() {
      this._syncTheme();
      this._sizeCanvas();
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
    popupOpen(v) {
      if (!v && this.data.hasData) {
        // 弹窗关闭 → 画布重新挂载（wx:if），nextTick + 延时双保险重绘
        if (wx.nextTick) wx.nextTick(() => this._draw());
        setTimeout(() => this._draw(), 120);
      }
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
          // CEFR 说明弹窗入口（deck 手势指南同款图标）
          help: '/assets/icons/help-outline-primary.svg',
        },
      });
    },

    /** 展示字段与弹窗文案派生（Android SpeechProfileCard 口径；文案移入「？」弹窗） */
    _applyProfile() {
      const p = this.data.profile;
      const hasData = !!(p && Number(p.evalCount) > 0);
      const avgOverall = p ? pronCore.num(p.avgOverall) : null;
      const avgSpeed = p ? pronCore.num(p.avgSpeed) : null;
      const cefr = p ? p.cefrLevel : null;
      const hintText = hasData && cefr
        ? '根据你的评测表现，当前发音水平约为 CEFR ' +
          cefr +
          ' 级，首页「为你推荐」已按该等级匹配剧集难度。评测越多，画像越准。'
        : '在任意剧集的跟读练习中完成语音评测，即可生成专属画像并获得难度匹配推荐。';
      this.setData(
        {
          hasData,
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

    /**
     * 「？」入口：本组件深处 pron-notebook 的 scroll-view 内 fixed 弹窗会退化
     * （遮罩盖不全/卡片被滚动容器裁切叠字），root-portal 真机亦不生效，故组件
     * 内不挂弹窗，仅派发 hintopen 事件，经 pron-notebook 中继至复习 Tab 页，
     * 由页面在根节点渲染 deck 手势指南同款弹窗
     */
    onHintToggle() {
      this.triggerEvent('hintopen', { hintText: this.data.hintText });
    },

    /**
     * canvas 显式定寸（真机坑：width:100%/height:100% 穿透 scroll-view→
     * swiper-item 时部分内核解析错，原生 canvas 层尺寸异常→大块白色占位）。
     * 尺寸全部可算术推导：窗口宽 − 两侧（页面 32rpx + 卡壳 32rpx）×2；
     * 高 = 雷达块 440rpx − 上下内衬 16rpx×2 = 408rpx
     */
    _sizeCanvas() {
      try {
        const wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const r2p = (wi.windowWidth || 375) / 750;
        const canvasW = Math.round(wi.windowWidth - 128 * r2p);
        const canvasH = Math.round(408 * r2p);
        if (canvasW > 0 && canvasH > 0 && (canvasW !== this.data.canvasW || canvasH !== this.data.canvasH)) {
          this.setData({ canvasW, canvasH });
        }
      } catch (e) {
        /* 窗口信息异常时保留 wxml 的百分比兜底 */
      }
    },

    /** 雷达自绘：setData 回调（渲染完成后）再查 canvas 节点；主题色随 dark。
     *  首查失败（真机 canvas 2d 节点创建晚于组件 ready）延时 120ms 重试一次 */
    _draw(isRetry) {
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
            if (!info || !info.node) {
              if (!isRetry) setTimeout(() => this._draw(true), 120);
              return;
            }
            // 真机坑②：fields(size) 对 canvas 2d 可能返回默认内在尺寸（300×150）
            // 而非布局尺寸 → 雷达按迷你尺寸绘制、块内大面积空白。绘制尺寸一律
            // 用 _sizeCanvas 算术下发的显式 px（与内联 style 同源），查询只取 node
            const cw = this.data.canvasW || info.width;
            const ch = this.data.canvasH || info.height;
            if (!cw || !ch) {
              if (!isRetry) setTimeout(() => this._draw(true), 120);
              return;
            }
            let dpr = 1;
            try {
              const wi = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
              dpr = wi.pixelRatio || 1;
            } catch (e) {
              /* 画布清晰度兜底 1x */
            }
            pronCore.drawRadarChart(info.node, cw, ch, radar, dpr, {
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
