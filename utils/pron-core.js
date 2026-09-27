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

/* ── AI 发音诊断报告（T4.3，Web DiagnosticReportCard.tsx + phoneme-tips.ts 移植）── */

/** 免费层可见音素数（其后模糊锁定——「看得到数据但看不到深度分析」） */
const FREE_VISIBLE_PHONEMES = 3;
const DIAGNOSTIC_TOP_N = 10;

/** IPA → 中文练习建议静态映射（core/speech/phoneme-tips.ts 逐字移植，
 * 针对中文母语学习者的高频弱音；未命中回退通用建议） */
const PHONEME_TIPS = {
  // ── 咬舌音：中文无对应，最高频弱音 ──
  'θ': { tip: '舌尖轻咬上下齿之间，气流从舌齿缝隙摩擦出——不是「斯」，舌要真伸出去', contrast: 'think vs. sink · path vs. pass' },
  'ð': { tip: '与 /θ/ 同口型但声带振动，轻咬舌尖发浊音，常见于 the/this/that', contrast: 'then vs. den · they vs. day' },
  // ── 唇齿音 vs 圆唇音 ──
  'v': { tip: '上齿轻触下唇摩擦发声，不是「乌」——w 是双唇圆拢，v 要见到牙齿', contrast: 'very vs. wary · vest vs. west' },
  'w': { tip: '双唇撮圆像吹蜡烛起点，不要碰到牙齿（碰到就成了 v）', contrast: 'wine vs. vine · wet vs. vet' },
  // ── l / r ──
  'r': { tip: '舌尖卷起不触上颚，口型收圆；中文「日」的卷舌更靠前，英语 r 更松', contrast: 'light vs. right · lace vs. race' },
  'l': { tip: '舌尖抵上齿龈；词尾 l（feel/call）舌尖要真抵住，不要吞掉', contrast: 'feel vs. fee · call vs. caw' },
  // ── 长短元音 ──
  'iː': { tip: '长音拉满、嘴角向两侧咧开（微笑状），比「衣」更靠前更紧', contrast: 'seat vs. sit · eat vs. it' },
  'ɪ': { tip: '短促放松，舌位比 iː 低且靠中——不是缩短版的「衣」，是更松的音', contrast: 'sit vs. seat · ship vs. sheep' },
  'æ': { tip: '口张大、下巴下压，介于「哎」和「安」之间；胆子放大把嘴张开', contrast: 'bad vs. bed · cat vs. ket' },
  'e': { tip: '口半开、舌位中前，比 /æ/ 嘴小一半——不要滑成「哎」', contrast: 'bed vs. bad · men vs. man' },
  'ə': { tip: 'schwa 最常见的英语元音：完全放松、短而含糊（about 的 a）', contrast: 'about · banana · sofa' },
  'ɑː': { tip: '口张大、舌后部压低，长音（father 的 a）——不是「阿」的扁音', contrast: 'car vs. 卡 · heart vs. hut' },
  'ʌ': { tip: '短促、口半开、完全放松（cup/bus 的 u），比「阿」嘴小且短', contrast: 'cup vs. carp · cut vs. cart' },
  // ── 鼻音与后鼻音 ──
  'ŋ': { tip: '舌后部抵软腭，走鼻子出气（sing/long 结尾）——不要读成 n（舌尖抵齿龈）', contrast: 'sin vs. sing · thin vs. thing' },
  // ── 摩擦/塞擦音 ──
  'ʃ': { tip: '双唇前突圆拢、气流摩擦（「嘘」的口型），比「西」更圆更靠后', contrast: 'she vs. see · ship vs. sip' },
  'tʃ': { tip: 't+ʃ 连发（「吃」更硬朗），气流一冲而出', contrast: 'chair vs. share · cheat vs. sheet' },
  'dʒ': { tip: 'tʃ 的浊音版（jeep 的 j），声带振动', contrast: 'jazz vs. chart · joke vs. choke' },
  'z': { tip: '与 s 同口型但声带振动——中文无浊辅音，喉咙要真 buzz 起来', contrast: 'zoo vs. sue · buzz vs. bus' },
  // ── 双元音（动程要足）──
  'eɪ': { tip: '从 e 滑向 ɪ，动程要完整（late/take），不要读成单元音「诶」', contrast: 'late vs. let · fate vs. fed' },
  'aɪ': { tip: '从 a 滑向 ɪ，前半开口大（like/time），不要读成「爱」的扁音', contrast: 'like vs. 莱克 · time vs. 泰姆' },
  'aʊ': { tip: '从 a 滑向 ʊ（now/out），收尾嘴唇收圆', contrast: 'now vs. 闹 · about vs. 额抱特' },
  'oʊ': { tip: '从 o 滑向 ʊ，收尾圆唇（go/know），动程比「欧」更后', contrast: 'go vs. 够 · so vs. 搜' },
};

/** 通用兜底建议（音素未命中映射时，phoneme-tips.ts 同款） */
const FALLBACK_TIP = {
  tip: '在跟读练习中放慢原声，对着音标口型重复 5 遍，再以正常语速连读 3 遍',
  contrast: '对比原声录音回放，逐词定位失分点',
};

/** IPA → 建议查询（归一化：有道返回可能带斜杠/空白，/θ/ → θ） */
function getPhonemeTip(phoneme) {
  const key = String(phoneme || '').replace(/\//g, '').trim();
  return PHONEME_TIPS[key] || FALLBACK_TIP;
}

/**
 * 诊断卡行视图模型（Web topPhonemes.map 内联口径逐项）：
 * - Top10 截取（stats 已升序 = 最弱在前）
 * - visible = isPremium || idx < 3；锁定行：barWidth ×0.4（blur 由样式层实现）
 * - 进度条三档（scoreTier：≥80 good 绿 / ≥60 mid 琥珀 / 其余 low 红）
 * - 音素符号两档色（scoreClass：<60 error / 其余 warn；与进度条口径不同，Web 原样）
 * - meta 文案「评测 N 次 · 低分 N 次」与 tip（getPhonemeTip）预计算
 */
function diagnosticRows(stats, isPremium) {
  return (Array.isArray(stats) ? stats : [])
    .slice(0, DIAGNOSTIC_TOP_N)
    .map(function (ph, idx) {
      const src = ph || {};
      const avgScore = Math.round(Number(src.avgScore) || 0);
      const visible = !!isPremium || idx < FREE_VISIBLE_PHONEMES;
      const tip = getPhonemeTip(src.phoneme);
      return {
        phoneme: String(src.phoneme == null ? '' : src.phoneme),
        avgScore,
        count: Number(src.count) || 0,
        lowScoreCount: Number(src.lowScoreCount) || 0,
        visible,
        scoreTier: avgScore >= 80 ? 'good' : avgScore >= 60 ? 'mid' : 'low',
        scoreClass: avgScore < 60 ? 'error' : 'warn',
        barWidth: visible ? avgScore : Math.round(avgScore * 0.4),
        metaText: '评测 ' + (Number(src.count) || 0) + ' 次 · 低分 ' + (Number(src.lowScoreCount) || 0) + ' 次',
        tipText: tip.tip,
        tipContrast: tip.contrast,
      };
    });
}

/** 非会员锁定音素数（Top10 − 免费 3，下限 0） */
function diagnosticLockedCount(stats) {
  const n = Math.min(Array.isArray(stats) ? stats.length : 0, DIAGNOSTIC_TOP_N) - FREE_VISIBLE_PHONEMES;
  return n > 0 ? n : 0;
}

/**
 * GET /api/speech/diagnostic 信封解析（PRO 专属；非会员 403 由调用方捕获弹窗）：
 * {success, data:{phonemes, trend}} → 归一 {phonemes(升序 Top10), trend(月份升序)}
 */
function parseDiagnostic(res) {
  const d = res && res.success && res.data ? res.data : null;
  if (!d) return null;
  const trend = (Array.isArray(d.trend) ? d.trend : [])
    .map(function (t) {
      const src = t || {};
      return {
        month: String(src.month || ''),
        avgScore: Math.round(Number(src.avgScore) || 0),
        count: Number(src.count) || 0,
      };
    })
    .filter(function (t) { return t.month; })
    .sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; });
  return {
    phonemes: parsePhonemeStats(d.phonemes).slice(0, DIAGNOSTIC_TOP_N),
    trend,
  };
}

/* ── 进步曲线渲染（canvas 2d，recharts LineChart 视觉等价）── */
const TREND_LINE = '#4F46E5'; // Web Line stroke（indigo-600，音素雷达同族色）
const TREND_GRID = 'rgba(107, 114, 128, 0.15)'; // CartesianGrid currentColor opacity .1
const TREND_TICK = '#6B7280';
const TREND_AXIS_LEFT = 28; // YAxis width
const TREND_AXIS_BOTTOM = 18; // X 标签行高
const TREND_PAD_TOP = 8;

/**
 * 近 6 个月进步曲线自绘：水平虚线网格（Y 0/25/50/75/100）+ 平滑折线
 * （中点二次贝塞尔近似 recharts type="monotone"）+ 半径 4 圆点 + 月份标签。
 */
function drawTrendChart(node, cssW, cssH, trend, dpr) {
  if (!node || typeof node.getContext !== 'function') return false;
  const ctx = node.getContext('2d');
  const arr = Array.isArray(trend) ? trend : [];
  if (!ctx || !cssW || !cssH || arr.length === 0) return false;

  const d = Number(dpr) || 1;
  node.width = Math.round(cssW * d);
  node.height = Math.round(cssH * d);
  if (ctx.setTransform) {
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); } catch (e) { /* 基础库兜底 */ }
  }
  if (ctx.scale) ctx.scale(d, d);

  const w = cssW;
  const h = cssH;
  const plotL = TREND_AXIS_LEFT;
  const plotR = w - 8;
  const plotT = TREND_PAD_TOP;
  const plotB = h - TREND_AXIS_BOTTOM;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;
  if (plotW <= 0 || plotH <= 0) return false;

  const yFor = function (score) { return plotB - (Math.min(100, Math.max(0, score)) / 100) * plotH; };
  const xFor = function (i) {
    return arr.length === 1 ? plotL + plotW / 2 : plotL + (plotW * i) / (arr.length - 1);
  };

  ctx.clearRect(0, 0, w, h);

  // 水平虚线网格 + Y 刻度（0/25/50/75/100，字号 11）
  ctx.strokeStyle = TREND_GRID;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.fillStyle = TREND_TICK;
  ctx.font = '400 11px sans-serif';
  ctx.textBaseline = 'middle';
  for (var v = 0; v <= 100; v += 25) {
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(String(v), plotL - 4, y);
  }
  ctx.setLineDash([]);

  // 月份标签（X 轴，居中于各点下方）
  arr.forEach(function (t, i) {
    ctx.textAlign = 'center';
    ctx.fillText(t.month, xFor(i), plotB + 9);
  });

  // 平滑折线（中点二次贝塞尔）+ 数据点
  const pts = arr.map(function (t, i) { return { x: xFor(i), y: yFor(t.avgScore) }; });
  ctx.strokeStyle = TREND_LINE;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (var k = 1; k < pts.length; k++) {
    const prev = pts[k - 1];
    const cur = pts[k];
    const mx = (prev.x + cur.x) / 2;
    ctx.quadraticCurveTo(mx, prev.y, mx, (prev.y + cur.y) / 2);
    ctx.quadraticCurveTo(mx, cur.y, cur.x, cur.y);
  }
  ctx.stroke();
  ctx.fillStyle = TREND_LINE;
  pts.forEach(function (p) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
  return true;
}

/* ── 弱项列表（T4.4，Android PronunciationUtils.kt + SpeechNotebook 派生口径）── */

/** 得分档位（Android ScoreTone：≥80 good / ≥60 mid / 其余 bad，Web 列表徽章同口径） */
function classifyScore(score) {
  const n = Math.round(Number(score) || 0);
  if (n >= 80) return 'good';
  if (n >= 60) return 'mid';
  return 'bad';
}

/**
 * ISO 时间 → 「Y年M月D日」（Android formatZhDate，Web toLocaleDateString zh-CN 等价）。
 * 带偏移 ISO 按本地时区换算；解析失败回退原串前 10 位。
 */
function formatZhDate(iso) {
  const s = String(iso || '');
  if (!s) return '';
  let d = new Date(s);
  if (isNaN(d.getTime())) d = new Date(s.slice(0, 10));
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 薄弱音素雷达点：最弱前 6 项，标签包 /音素/（Android phonemeRadarPoints） */
function phonemeRadarPoints(stats, limit) {
  const n = limit === undefined ? 6 : limit;
  return (Array.isArray(stats) ? stats : [])
    .slice(0, n)
    .map(function (s) {
      const src = s || {};
      return {
        dim: '/' + String(src.phoneme == null ? '' : src.phoneme) + '/',
        score: Math.round(Number(src.avgScore) || 0),
      };
    });
}

/** notebook 派生统计（Android SpeechNotebook.weakestPhoneme/masteredPhonemeCount）：
 * 最弱音素 '/θ/'（无数据 null）/ 已攻克音素（avgScore ≥ 85 计数） */
function notebookStats(notebook) {
  const stats = notebook && Array.isArray(notebook.phonemeStats) ? notebook.phonemeStats : [];
  const first = stats[0];
  return {
    weakestPhoneme: first && first.phoneme ? '/' + first.phoneme + '/' : null,
    masteredPhonemeCount: stats.filter(function (s) {
      return Math.round(Number((s || {}).avgScore) || 0) >= 85;
    }).length,
  };
}

/** 弱项句行装饰（Android WeakSentenceRow + record.lastScore 口径）：
 * lastScore = overallScore ?? accuracyScore（round）；tone 三档；得分徽章与中文日期预计算 */
function decorateWeakRow(record) {
  const src = record || {};
  const overall = num(src.overallScore);
  const accuracy = num(src.accuracyScore);
  const lastScore = Math.round(overall !== null ? overall : accuracy !== null ? accuracy : 0);
  return {
    recognitionid: src.recognitionid,
    episodeid: src.episodeid || '',
    episodeTitle: src.episodeTitle || '未知播客',
    episodeCoverUrl: src.episodeCoverUrl || '',
    targetText: src.targetText || '',
    subtitleId: typeof src.subtitleId === 'number' ? src.subtitleId : null,
    lastScore,
    tone: classifyScore(lastScore),
    scoreText: '上次得分: ' + lastScore,
    dateText: formatZhDate(src.recognitionDate),
  };
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
  FREE_VISIBLE_PHONEMES,
  DIAGNOSTIC_TOP_N,
  PHONEME_TIPS,
  getPhonemeTip,
  diagnosticRows,
  diagnosticLockedCount,
  parseDiagnostic,
  drawTrendChart,
  classifyScore,
  formatZhDate,
  phonemeRadarPoints,
  notebookStats,
  decorateWeakRow,
};
