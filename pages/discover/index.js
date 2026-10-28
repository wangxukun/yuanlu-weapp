/**
 * pages/discover/index — 探索画廊 · 声音明信片与主题专栏（RESHAPE-TASK T4.2）
 *
 * 数据源 = GET /api/scenes/feed（阶段 1 后端语料原子化产物）：
 *   - 顶部搜索：搜表达、场景、中文意图或单词（400ms 防抖，q 透传 feed）
 *   - 声音明信片卡流：剧集封面 + 金句原文/译文 + 微播放器切片直连试听
 *     （clipId=sceneid，窗口=金句字幕绝对秒，audio-clip 换算切片内相对）
 *   - 语用场景胶囊栏 + 主题微剧场专栏（首页按 situationTag 聚合，点选过滤）
 *   - 日签海报：Canvas 绘制封面+金句+品牌落款，保存相册（尺寸自算+DPR
 *     缩放+图片先行下载，真机 canvas 三坑全防）
 * 分页：onReachBottom 追加（feed page/pageSize/total）。
 */
const { get } = require('../../utils/request');
const theme = require('../../utils/theme');

const SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 10;
/** 语用场景胶囊（运营策展口径；与语料 situationTag 对齐靠拢） */
const SCENE_CHIPS = [
  { key: '职场', label: '#职场博弈' },
  { key: '日常', label: '#日常破冰' },
  { key: '情感', label: '#情感疗愈' },
  { key: '思维', label: '#思维模型' },
  { key: '连读', label: '#高频连读' },
];

Page({
  data: {
    themeClass: '',
    isLoading: true,
    query: '',
    activeTag: '',
    chips: SCENE_CHIPS,
    cards: [],
    columns: [], // 主题专栏：situationTag 聚合（复用专栏卡视觉）
    page: 1,
    total: 0,
    noMore: false,
    poster: null, // { sceneid, coverUrl, en, zh } 日签海报弹层
    posterSaving: false,
  },

  onLoad() {
    this._searchTimer = null;
    this._fetch(1, true);
  },

  onShow() {
    // 外观根类：手动模式覆盖令牌（跟随系统返回空类走媒体查询）
    this.setData({ themeClass: theme.rootClass() });
    theme.applyChrome(); // 手动深/浅色下切回本 tab 时重申导航栏
  },

  onPullDownRefresh() {
    this._fetch(1, true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.noMore || this.data.isLoading) return;
    this._fetch(this.data.page + 1, false);
  },

  /** 卡片视图模型（WXML 零方法调用：时长/标签预格式化） */
  _mapCard(item) {
    const golden = item && item.golden;
    return {
      sceneid: item.sceneid,
      title: item.title || '',
      coverUrl: item.coverUrl || '',
      situationTag: item.situationTag || '',
      cefrLabel: item.cefrLevel || '',
      durText: Math.round(item.duration || 0) + 's',
      en: (golden && golden.en) || (item.title || ''),
      zh: (golden && golden.zh) || '',
      start: (golden && golden.start) || 0,
      end: (golden && golden.end) || 0,
    };
  },

  async _fetch(page, replace) {
    this.setData({ isLoading: true });
    try {
      const params = ['page=' + page, 'pageSize=' + PAGE_SIZE];
      if (this.data.activeTag) params.push('tag=' + encodeURIComponent(this.data.activeTag));
      const q = this.data.query.trim();
      if (q) params.push('q=' + encodeURIComponent(q));
      const body = await get('/api/scenes/feed?' + params.join('&'), null, { showError: false });
      const data = (body && body.success && body.data) || {};
      const items = (data.items || []).map(this._mapCard).filter((c) => c.sceneid);
      const total = Number(data.total) || 0;
      const cards = replace ? items : this.data.cards.concat(items);
      // 主题专栏：仅首页且无筛选时按 situationTag 聚合
      let columns = this.data.columns;
      if (replace && !q && !this.data.activeTag) {
        const byTag = {};
        cards.forEach((c) => {
          const tag = c.situationTag;
          if (!tag) return;
          if (!byTag[tag]) byTag[tag] = { name: tag, coverUrl: c.coverUrl, sceneCount: 0 };
          byTag[tag].sceneCount += 1;
        });
        columns = Object.values(byTag).slice(0, 6);
      }
      this.setData({
        isLoading: false,
        cards,
        columns,
        page,
        total,
        noMore: cards.length >= total,
      });
    } catch (e) {
      this.setData({ isLoading: false, ...(replace ? { cards: [], noMore: true } : {}) });
    }
  },

  // ==================== 搜索（400ms 防抖） ====================

  onSearchInput(e) {
    const query = (e.detail && e.detail.value) || '';
    this.setData({ query });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    const trimmed = query.trim();
    if (!trimmed) {
      // 清空搜索恢复全量（保留胶囊筛选）
      this._searchTimer = setTimeout(() => this._fetch(1, true), SEARCH_DEBOUNCE_MS);
      return;
    }
    this._searchTimer = setTimeout(() => this._fetch(1, true), SEARCH_DEBOUNCE_MS);
  },

  onClearSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.setData({ query: '' });
    this._fetch(1, true);
  },

  // ==================== 胶囊 / 专栏 ====================

  /** 场景胶囊：再点同标签取消（对齐 toggle 语义） */
  onChipTap(e) {
    const key = e.currentTarget.dataset.key || '';
    const activeTag = this.data.activeTag === key ? '' : key;
    this.setData({ activeTag });
    this._fetch(1, true);
  },

  /** 专栏卡点击 → 该标签胶囊筛选（同名 key 直接透传 tag 名） */
  onColumnTap(e) {
    const name = e.currentTarget.dataset.name;
    if (!name) return;
    this.setData({ activeTag: this.data.activeTag === name ? '' : name });
    this._fetch(1, true);
  },

  // ==================== 卡片 / 日签海报 ====================

  onCardTap(e) {
    const sceneid = e.currentTarget.dataset.scene;
    if (sceneid) {
      wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + sceneid });
    }
  },

  onPosterOpen(e) {
    const ds = e.currentTarget.dataset;
    const card = this.data.cards.find((c) => c.sceneid === ds.scene);
    if (!card) return;
    this.setData({ poster: { sceneid: card.sceneid, coverUrl: card.coverUrl, en: card.en, zh: card.zh } });
  },

  onPosterClose() {
    if (this.data.posterSaving) return;
    this.setData({ poster: null });
  },

  /** Canvas 绘制：尺寸显式自算（不信 fields）+ DPR 缩放 + 图片先行下载 */
  onPosterReady() {
    const poster = this.data.poster;
    if (!poster || this._posterDrawn === poster.sceneid) return;
    this._posterDrawn = poster.sceneid;
    this._drawPoster(poster).catch(() => {
      wx.showToast({ title: '海报生成失败，请重试', icon: 'none' });
    });
  },

  async _drawPoster(poster) {
    const W = 600;
    const H = 860;
    const query = wx.createSelectorQuery().in(this);
    const field = await new Promise((resolve) => {
      query.select('#poster-canvas').fields({ node: true, size: true }).exec((res) => resolve(res && res[0]));
    });
    if (!field || !field.node) throw new Error('canvas 未挂载');
    const canvas = field.node;
    const dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // 底色
    ctx.fillStyle = '#1b1812';
    ctx.fillRect(0, 0, W, H);

    // 封面（先行下载；失败则以底色继续）
    const CH = 420;
    try {
      const info = await new Promise((resolve, reject) => {
        wx.getImageInfo({ src: poster.coverUrl, success: resolve, fail: reject });
      });
      const img = canvas.createImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = info.path;
      });
      ctx.drawImage(img, 0, 0, W, CH);
      const grad = ctx.createLinearGradient(0, CH - 160, 0, CH);
      grad.addColorStop(0, 'rgba(27,24,18,0)');
      grad.addColorStop(1, 'rgba(27,24,18,0.9)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, CH - 160, W, 160);
    } catch (e) {
      ctx.fillStyle = '#2e5d4a';
      ctx.fillRect(0, 0, W, CH);
    }

    // 金句（手动折行）
    const wrap = (text, maxChars, maxLines) => {
      const lines = [];
      let line = '';
      for (const ch of String(text || '')) {
        if (ch === '\n' || line.length >= maxChars) {
          lines.push(line);
          line = ch === '\n' ? '' : ch;
          if (lines.length >= maxLines) return lines;
        } else {
          line += ch;
        }
      }
      if (line && lines.length < maxLines) lines.push(line);
      return lines;
    };

    let y = CH + 70;
    ctx.fillStyle = '#f3efe4';
    ctx.font = '600 34px serif';
    wrap(poster.en, 26, 4).forEach((ln) => {
      ctx.fillText(ln, 48, y);
      y += 50;
    });
    if (poster.zh) {
      y += 14;
      ctx.fillStyle = 'rgba(243,239,228,0.72)';
      ctx.font = '26px sans-serif';
      wrap(poster.zh, 22, 2).forEach((ln) => {
        ctx.fillText(ln, 48, y);
        y += 40;
      });
    }

    // 品牌落款
    ctx.fillStyle = 'rgba(243,239,228,0.55)';
    ctx.font = '22px sans-serif';
    ctx.fillText('远路听说 · 今日声音日签', 48, H - 60);

    this._posterCanvas = canvas;
  },

  onPosterSave() {
    if (this.data.posterSaving || !this._posterCanvas) return;
    this.setData({ posterSaving: true });
    wx.canvasToTempFilePath({
      canvas: this._posterCanvas,
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.showToast({ title: '日签已存入相册', icon: 'none' });
            this.setData({ posterSaving: false, poster: null });
            this._posterDrawn = null;
          },
          fail: () => {
            this.setData({ posterSaving: false });
            wx.showToast({ title: '未授权保存到相册，可在设置中开启', icon: 'none' });
          },
        });
      },
      fail: () => {
        this.setData({ posterSaving: false });
        wx.showToast({ title: '海报导出失败', icon: 'none' });
      },
    });
  },
});
