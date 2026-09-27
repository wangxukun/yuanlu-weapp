/**
 * utils/pron-core.js — 发音弱项本纯逻辑模型（REVIEW-TASK 阶段 4，T4.1）
 *
 * 把 Web 端发音弱项本的数据语义抽离到独立模块（Node 可直接 require 单测；
 * 页面/组件只做 IO 与 setData），源文件逐一对齐：
 *
 * - parseNotebook：GET /api/speech/notebook 信封归一（app/api/speech/notebook/
 *   route.ts，Android 专用聚合接口；Web 走 SSR app/(main)/library/pronunciation/
 *   page.tsx 同源组装）→ { isPremium, weakThreshold, profile, phonemeStats,
 *   totalErrors, isTrialMode, errors }；失败/坏形状 → null（区别于「空弱项本」）
 * - parsePhonemeStats：{phoneme, avgScore(四舍五入), count, lowScoreCount} 按
 *   avgScore 升序（最弱在前）——服务端已排序，客户端防御性重排，同分保持原序
 * - normalizeProfile：core/speech-profile/dto.ts SpeechProfileDto 同构
 *   （全部评测聚合均值，无数据为 null）
 * - toRadarData：core/speech-profile/speech-profile.service.ts 逐行移植——
 *   五维 [准确度/流利度/完整度/语速适配/综合表现]，缺维以 0 计，Math.round
 * - normalizeErrorRecord：speech_recognition 行 + episode {title, coverUrl} 归一
 *   （notebook 接口仅签名封面；audioUrl/subtitleTextCn/subtitleWords/subtitleEnd
 *   补齐字段仅 errors 接口〔闯关题源〕回传，归一保留字段位、缺省 null，
 *   T4.4/T4.5 复用同一形状）
 * - lockedCount：非会员锁定条数 = totalErrors − 可见切片数（T4.4 锁定卡口径）
 *
 * weakThreshold 口径贯穿（core/speech/weak-sentences.service.ts
 * DEFAULT_WEAK_SCORE_THRESHOLD = 80；用户可在语音评测设置 60-95 调整）：
 * 弱项列表生成（服务端 Step A/C）/ 闯关达标（T4.5）/ 音素 lowScore 判定
 * 三处同源；normalizeThreshold 对接口回传值做防御性收口。
 *
 * TRIAL_REACHED 埋点：Web SSR 每次直出都埋（page.tsx isTrialMode 即
 * recordConversionEvent）；小程序 Tab 可反复激活，按 REVIEW-TASK 口径
 * 「首次进入」（会话内一次，模块级标记）去重——POST /api/track
 * {eventType:"TRIAL_REACHED", source:"pronunciation_trial",
 * metadata:{totalErrors}}，走 utils/track.js 静默 fire-and-forget。
 */

const DEFAULT_WEAK_SCORE_THRESHOLD = 80;
const WEAK_THRESHOLD_MIN = 60;
const WEAK_THRESHOLD_MAX = 95;
/** 非会员试用切片条数（Web lib/quota.ts FREE_VISIBLE_ERRORS 同源） */
const FREE_VISIBLE_ERRORS = 3;

/** 分数线归一：四舍五入后收口到 [60, 95]，非法值回落默认 80 */
function normalizeThreshold(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return DEFAULT_WEAK_SCORE_THRESHOLD;
  return Math.min(WEAK_THRESHOLD_MAX, Math.max(WEAK_THRESHOLD_MIN, n));
}

/** 可空数值归一：null/undefined/空串与非有限数 → null（「无数据」语义；
 * 注意 Number(null)===0，显式 null 必须先拦——服务端 JSON 缺数据就是显式 null） */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 薄弱音素统计归一 + 均分升序（最弱在前）。
 * 服务端（notebook/route.ts）已 Math.round + sort，此处防御性重做一遍，
 * 同分保持原序（稳定排序，不依赖引擎 sort 稳定性）。
 */
function parsePhonemeStats(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(function (item, idx) {
      return { src: item || {}, idx: idx };
    })
    .sort(function (a, b) {
      return (
        (Math.round(Number(a.src.avgScore) || 0) -
          Math.round(Number(b.src.avgScore) || 0)) ||
        a.idx - b.idx
      );
    })
    .map(function (e) {
      return {
        phoneme: String(e.src.phoneme == null ? '' : e.src.phoneme),
        avgScore: Math.round(Number(e.src.avgScore) || 0),
        count: Number(e.src.count) || 0,
        lowScoreCount: Number(e.src.lowScoreCount) || 0,
      };
    });
}

/** SpeechProfileDto 归一（聚合均值缺数据为 null；evalCount 缺省 0） */
function normalizeProfile(obj) {
  const src = obj || {};
  return {
    evalCount: Number(src.evalCount) || 0,
    avgOverall: num(src.avgOverall),
    avgAccuracy: num(src.avgAccuracy),
    avgFluency: num(src.avgFluency),
    avgIntegrity: num(src.avgIntegrity),
    avgSpeed: num(src.avgSpeed),
    speedFitScore: num(src.speedFitScore),
    cefrLevel:
      typeof src.cefrLevel === 'string' && src.cefrLevel ? src.cefrLevel : null,
  };
}

/** 雷达维度（speech-profile.service.ts toRadarData 同款：dim → DTO 字段） */
const RADAR_DIMS = [
  ['准确度', 'avgAccuracy'],
  ['流利度', 'avgFluency'],
  ['完整度', 'avgIntegrity'],
  ['语速适配', 'speedFitScore'],
  ['综合表现', 'avgOverall'],
];

/** 画像 → 五维雷达点（缺维以 0 计，前端提示数据积累中；Math.round 同源） */
function toRadarData(profile) {
  const p = profile || {};
  return RADAR_DIMS.map(function (d) {
    const v = num(p[d[1]]);
    return {
      dim: d[0],
      score: v === null ? 0 : Math.round(v),
      fullMark: 100,
    };
  });
}

/** 弱项句子记录归一（notebook 与 errors 接口共用的 WeakRecordDto 口径） */
function normalizeErrorRecord(item) {
  const src = item || {};
  const ep = src.episode || {};
  return {
    recognitionid: src.recognitionid,
    episodeid: src.episodeid || '',
    episodeTitle: ep.title || '',
    // notebook 已签名封面（3h）；空串/缺省统一 ''
    episodeCoverUrl: ep.coverUrl || '',
    // audioUrl/字幕补齐字段仅 errors 接口回传，notebook 恒空（字段位保留）
    episodeAudioUrl: ep.audioUrl || '',
    targetText: src.targetText || '',
    targetStartTime:
      typeof src.targetStartTime === 'number' ? src.targetStartTime : null,
    subtitleId: typeof src.subtitleId === 'number' ? src.subtitleId : null,
    subtitleTextCn: src.subtitleTextCn || null,
    subtitleWords: Array.isArray(src.subtitleWords) ? src.subtitleWords : null,
    subtitleEnd: num(src.subtitleEnd),
    accuracyScore: num(src.accuracyScore),
    overallScore: num(src.overallScore),
    speed: num(src.speed),
    recognitionDate: src.recognitionDate || '',
  };
}

/**
 * GET /api/speech/notebook 信封解析：success 才归一，失败/坏形状 → null
 * （与句子列表「失败 → []」不同：弱项本无空列表语义，调用方据 null 亮错误态）。
 */
function parseNotebook(res) {
  const d = res && res.success && res.data ? res.data : null;
  if (!d) return null;
  return {
    isPremium: !!d.isPremium,
    weakThreshold: normalizeThreshold(d.weakThreshold),
    profile: normalizeProfile(d.profile),
    phonemeStats: parsePhonemeStats(d.phonemeStats),
    totalErrors: Number(d.totalErrors) || 0,
    isTrialMode: !!d.isTrialMode,
    errors: (Array.isArray(d.errors) ? d.errors : []).map(normalizeErrorRecord),
  };
}

/** 非会员锁定条数（T4.4 锁定卡「还有 N 条弱项句子待攻克」；会员恒 0） */
function lockedCount(notebook) {
  if (!notebook) return 0;
  const n = notebook.totalErrors - (notebook.errors || []).length;
  return n > 0 ? n : 0;
}

/* ── TRIAL_REACHED 埋点（会话内一次）────────────────────────── */

/** 模块级会话标记（测试经 resetTrialTrackState 复位） */
let _trialTracked = false;

function resetTrialTrackState() {
  _trialTracked = false;
}

/**
 * 试用触墙埋点：isTrialMode（非会员且 totalErrors > FREE_VISIBLE_ERRORS，
 * 服务端判定）首次进入时上报一次。
 * @param {object} notebook parseNotebook 归一结果
 * @param {function} [tracker] 上报函数（默认 utils/track.trackEvent；测试注入桩）
 * @returns {boolean} 本次是否真正上报
 */
function maybeTrackTrialReach(notebook, tracker) {
  if (!notebook || !notebook.isTrialMode) return false;
  if (_trialTracked) return false;
  _trialTracked = true;
  const fire =
    tracker ||
    function (eventType, source, metadata) {
      require('./track').trackEvent(eventType, source, metadata);
    };
  fire('TRIAL_REACHED', 'pronunciation_trial', {
    totalErrors: notebook.totalErrors,
  });
  return true;
}

/* ── 五维雷达几何（recharts RadarChart 等价，canvas 自绘用）──────────
 * 坐标口径：数学角（y 向上）计算，输出换算 canvas 坐标（y 向下）；
 * 首维正上方（90°）、顺时针均分——与 recharts PolarAngleAxis 渲染序一致
 * （准确度顶、流利度右上、完整度右下、语速适配左下、综合表现左上）。 */

/** 维度顶点角度（度）：count 维 → [90, 90-360/n, …] */
function radarAngles(count) {
  const n = Math.floor(Number(count) || 0);
  if (n <= 0) return [];
  const step = 360 / n;
  const out = [];
  for (var i = 0; i < n; i++) out.push(90 - i * step);
  return out;
}

/** 角度 → canvas 坐标点（x = cx + r·cosθ，y = cy − r·sinθ） */
function radarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/** 半径 r 的等分环顶点（PolarGrid 五边形网格环；角度口径同上） */
function radarRingPoints(cx, cy, r, count) {
  return radarAngles(count).map(function (a) {
    return radarPoint(cx, cy, r, a);
  });
}

/** 得分多边形顶点：半径按 score/100 缩放（收口 0-100；环半径 r 对应满分） */
function radarScorePoints(scores, cx, cy, r) {
  const arr = Array.isArray(scores) ? scores : [];
  return radarAngles(arr.length).map(function (a, i) {
    var s = Number(arr[i]);
    if (!isFinite(s)) s = 0;
    s = Math.min(100, Math.max(0, s));
    return radarPoint(cx, cy, r * (s / 100), a);
  });
}

/* ── 雷达渲染（canvas 2d 自绘，逐行对齐 Android feature/pronunciation/RadarChart.kt）：
 * 网格环 4 档 + 中心辐条 1px；数据多边形 20% 填充 + 2px 描边（画像紫 #7C3AED，
 * Android ProfileRadarColor，双态恒值）；维度标签 12sp·SemiBold 锚在顶点外
 * 6dp/2dp（横/纵）偏移，按象限对齐；外圈半径 = 短半边 − 34dp 标签留白。
 * 网格/标签色随主题（Android isDark 分支）：浅 #E5E7EB/#6B7280、深 #3A342C/#A8A29E ── */
const RADAR_GRID_STROKE_LIGHT = '#E5E7EB';
const RADAR_GRID_STROKE_DARK = '#3A342C';
const RADAR_TICK_FILL_LIGHT = '#6B7280';
const RADAR_TICK_FILL_DARK = '#A8A29E';
const RADAR_LINE_STROKE = '#7C3AED';
const RADAR_FILL = 'rgba(124, 58, 237, 0.2)';
const RADAR_GRID_LEVELS = 4;
const RADAR_LABEL_PAD = 34;
const RADAR_LABEL_FONT = 12;
const RADAR_LABEL_GAP_X = 6;
const RADAR_LABEL_GAP_Y = 2;
const RADAR_LABEL_LINE_H = 16;

/** 多边形路径（moveTo 首点 + closePath） */
function polygonPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach(function (p, i) {
    if (i) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
  });
  ctx.closePath();
}

/**
 * 五维雷达自绘（weapp canvas 2d node；Node 单测传 mock node/ctx 同样可驱动）。
 * Android RadarChart.kt 逐行等价：4 环网格 + 辐条 1px、数据多边形 0.2 填充 +
 * 2px 描边、标签锚在外圈顶点外偏移（dx>1 右移 6dp 左对齐 / dx<-1 左移 6dp
 * 右对齐 / 中缝居中；dy>1 下方 +2dp / dy<-1 上方 −行高−2dp / 中垂居中）。
 * @param {object} node canvas 节点（getContext('2d')）
 * @param {number} cssW/cssH CSS 像素尺寸（rpx 换算后）
 * @param {Array<{dim, score}>} radar toRadarData 输出
 * @param {number} dpr 设备像素比（缺省 1）
 * @param {object} [opts] { gridColor, labelColor, strokeColor, fill, gridRingCount }
 *        （缺省浅色主题 + 画像紫；深色传 #3A342C/#A8A29E）
 */
function drawRadarChart(node, cssW, cssH, radar, dpr, opts) {
  if (!node || typeof node.getContext !== 'function') return false;
  const ctx = node.getContext('2d');
  if (!ctx || !cssW || !cssH) return false;
  const arr = Array.isArray(radar) ? radar : [];
  const angles = radarAngles(arr.length);
  if (!angles.length) return false;

  const o = opts || {};
  const gridColor = o.gridColor || RADAR_GRID_STROKE_LIGHT;
  const labelColor = o.labelColor || RADAR_TICK_FILL_LIGHT;
  const strokeColor = o.strokeColor || RADAR_LINE_STROKE;
  const fillColor = o.fill || RADAR_FILL;
  const rings = Math.max(1, Math.floor(Number(o.gridRingCount) || RADAR_GRID_LEVELS));

  const d = Number(dpr) || 1;
  node.width = Math.round(cssW * d);
  node.height = Math.round(cssH * d);
  if (ctx.setTransform) {
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch (e) { /* 基础库兜底 */ }
  }
  if (ctx.scale) ctx.scale(d, d);

  const w = cssW;
  const h = cssH;
  const cx = w / 2;
  const cy = h / 2;
  // Android：outerRadius = min(min(w,h)/2, w/2) − 34dp（标签留白）≈ 短半边 − 34
  const R = Math.min(w, h) / 2 - RADAR_LABEL_PAD;
  if (!(R > 0)) return false;

  ctx.clearRect(0, 0, w, h);

  // 同心网格环（1px）+ 中心辐条（1px）
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (var lv = 1; lv <= rings; lv++) {
    polygonPath(ctx, radarRingPoints(cx, cy, (R * lv) / rings, angles.length));
    ctx.stroke();
  }
  ctx.beginPath();
  angles.forEach(function (a) {
    const p = radarPoint(cx, cy, R, a);
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  // 数据多边形（20% 填充 + 2px 描边，对齐 recharts Radar fillOpacity=0.2 / Android Stroke(2.dp)）
  const scores = arr.map(function (r) { return (r && Number(r.score)) || 0; });
  polygonPath(ctx, radarScorePoints(scores, cx, cy, R));
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // 维度标签（外圈顶点外偏移；textBaseline=top 等价 drawText topLeft 语义）
  ctx.fillStyle = labelColor;
  ctx.font = '600 ' + RADAR_LABEL_FONT + 'px sans-serif';
  ctx.textBaseline = 'top';
  angles.forEach(function (a, i) {
    const anchor = radarPoint(cx, cy, R, a);
    const dx = anchor.x - cx;
    const dy = anchor.y - cy;
    const label = String((arr[i] && arr[i].dim) || '');
    let textW = label.length * RADAR_LABEL_FONT; // CJK 每字≈字号宽（measureText 缺席兜底）
    if (typeof ctx.measureText === 'function') {
      try { textW = ctx.measureText(label).width; } catch (e) { /* 兜底估宽 */ }
    }
    if (dx > 1) {
      ctx.textAlign = 'left';
      ctx.fillText(label, anchor.x + RADAR_LABEL_GAP_X, labelY(dy, anchor.y));
    } else if (dx < -1) {
      ctx.textAlign = 'right';
      ctx.fillText(label, anchor.x - RADAR_LABEL_GAP_X, labelY(dy, anchor.y));
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(label, anchor.x, labelY(dy, anchor.y));
    }
  });
  return true;
}

/** 标签纵向落点（Android dy 分支：下方 +2dp / 上方 −行高−2dp / 中垂居中） */
function labelY(dy, anchorY) {
  if (dy > 1) return anchorY + RADAR_LABEL_GAP_Y;
  if (dy < -1) return anchorY - RADAR_LABEL_LINE_H - RADAR_LABEL_GAP_Y;
  return anchorY - RADAR_LABEL_LINE_H / 2;
}

module.exports = {
  DEFAULT_WEAK_SCORE_THRESHOLD,
  WEAK_THRESHOLD_MIN,
  WEAK_THRESHOLD_MAX,
  FREE_VISIBLE_ERRORS,
  normalizeThreshold,
  num,
  parsePhonemeStats,
  normalizeProfile,
  toRadarData,
  normalizeErrorRecord,
  parseNotebook,
  lockedCount,
  resetTrialTrackState,
  maybeTrackTrialReach,
  radarAngles,
  radarPoint,
  radarRingPoints,
  radarScorePoints,
  drawRadarChart,
  RADAR_GRID_STROKE_LIGHT,
  RADAR_GRID_STROKE_DARK,
  RADAR_TICK_FILL_LIGHT,
  RADAR_TICK_FILL_DARK,
};
