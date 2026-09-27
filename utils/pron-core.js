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
};
