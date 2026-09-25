/**
 * utils/speech-core.js — 语音评测纯逻辑层
 *
 * 逐项移植 Android feature/voice 的可测试逻辑（对齐 Web 端同名口径）：
 *   - DEFAULT_SETTINGS / effectivePassThreshold ← domain/model/SpeechModels.kt
 *     （PracticeSettings 字段与默认值逐项一致；严格度偏移 -5/0/+5）
 *   - applyFilters / matchesRecord / latestRecordFor
 *     ← SpeechEvalViewModel 的过滤与历史匹配口径（词数区间 + 只练未掌握；
 *       匹配 = subtitleId 相同 || 文本相同且起点差 < 0.5s）
 *   - parsePracticeData / parseEvalResult / parseDetail ← SpeechDtos.kt
 *     （有道 ISE 明细的双口径音素字段 phoneme|phone / score|pronunciation）
 *   - buildSentenceTokens / buildBlindBars / cleanWordKey / stripIpaSlashes
 *     ← SpeechEvalCard 的分词渲染与音标缓存键口径
 *   - frameAmplitude / pcmToWav ← WavRecorder + stopAndEvaluate 的端内等价
 *     （RecorderManager PCM 帧实时音量 + 16kHz mono 16bit WAV 封装）
 *   - computeWordSweep 复用 utils/intensive-core（词级扫光三态同源）
 *
 * 不依赖 wx / 任何页面状态，供 pages/speech-eval 与 scripts 单测共用
 * （模型生成、代码把门的单测口径，同 intensive-core）。
 */
var intensiveCore = require('./intensive-core');

// ==================== 设置（PracticeSettings 同构） ====================

/** 默认值逐项对齐 Android PracticeSettings / Web practice-settings-store */
var DEFAULT_SETTINGS = {
  fontSizeLevel: 1,      // 0/1/2 = 小/中/大（17/20/24sp）
  showTranslation: true, // 显示中文翻译
  showIpa: true,         // 结果区音素标注
  textMode: 'normal',    // normal | ipa | blind
  passThreshold: 80,     // 过关分数线 60..95
  strictness: 'standard',// lenient | standard | strict（偏移 -5/0/+5）
  weakThreshold: 80,     // 弱项本分数线 60..95
  minWords: 0,           // 句子最小词数（0 = 不限）
  maxWords: 50,          // 句子最大词数（>=50 = 不限）
  onlyUnmastered: false, // 只练未掌握
  autoAdvance: true,     // 达标后 1.5s 自动跳下一句
};

var STRICTNESS_OFFSETS = { lenient: -5, standard: 0, strict: 5 };

/** 生效过关线 = 过关分数线 + 严格度偏移，clamp 0..100（selectEffectivePassThreshold） */
function effectivePassThreshold(settings) {
  var offset = STRICTNESS_OFFSETS[settings.strictness];
  if (offset === undefined) offset = 0;
  return Math.max(0, Math.min(100, (settings.passThreshold | 0) + offset));
}

/** 存储读入合并默认值（容错：坏字段回落默认） */
function normalizeSettings(raw) {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    var v = raw ? raw[k] : undefined;
    out[k] = v === undefined || v === null ? DEFAULT_SETTINGS[k] : v;
  });
  if (['normal', 'ipa', 'blind'].indexOf(out.textMode) < 0) out.textMode = 'normal';
  if (['lenient', 'standard', 'strict'].indexOf(out.strictness) < 0) out.strictness = 'standard';
  out.fontSizeLevel = Math.max(0, Math.min(2, out.fontSizeLevel | 0));
  out.passThreshold = Math.max(60, Math.min(95, out.passThreshold | 0));
  out.weakThreshold = Math.max(60, Math.min(95, out.weakThreshold | 0));
  out.minWords = Math.max(0, Math.min(50, out.minWords | 0));
  out.maxWords = Math.max(0, Math.min(50, out.maxWords | 0));
  return out;
}

// ==================== 字幕 / 历史记录解析（SpeechDtos 同构） ====================

function roundInt(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n) : 0;
}

/** practice-data 的字幕（startSeconds/endSeconds → start/end） */
function parseSubtitleDto(dto) {
  var start = Number(dto.startSeconds) || 0;
  return {
    id: dto.id | 0,
    textEn: String(dto.textEn || ''),
    textCn: dto.textCn || null,
    start: start,
    end: dto.endSeconds != null && isFinite(Number(dto.endSeconds))
      ? Number(dto.endSeconds)
      : start + 3,
    speaker: dto.speaker || null,
    words: Array.isArray(dto.words) ? dto.words : [],
  };
}

/** speech_recognition 历史记录（bestScore = overallScore ?? accuracyScore） */
function parseRecordDto(dto) {
  return {
    recognitionid: Number(dto.recognitionid) || 0,
    accuracyScore: roundInt(dto.accuracyScore),
    overallScore: dto.overallScore != null ? roundInt(dto.overallScore) : null,
    fluencyScore: dto.fluencyScore != null ? roundInt(dto.fluencyScore) : null,
    integrityScore: dto.integrityScore != null ? roundInt(dto.integrityScore) : null,
    speed: dto.speed != null ? roundInt(dto.speed) : null,
    targetText: String(dto.targetText || ''),
    targetStartTime: Number(dto.targetStartTime) || 0,
    subtitleId: dto.subtitleId != null ? dto.subtitleId | 0 : null,
    recognitionDate: dto.recognitionDate || '',
    detailUrl: dto.detailUrl || null,
    userAudioUrl: dto.userAudioUrl || null,
  };
}

/** GET /api/speech/practice-data 响应 → 领域形状 */
function parsePracticeData(body) {
  var data = (body && body.data) || {};
  var episode = data.episode || {};
  return {
    audioUrl: episode.audioUrl || null,
    episodeTitle: episode.title || null,
    subtitles: (Array.isArray(data.subtitles) ? data.subtitles : []).map(parseSubtitleDto),
    records: (Array.isArray(data.previousRecords) ? data.previousRecords : []).map(parseRecordDto),
    isTrialMode: !!data.isTrialMode,
  };
}

/** 有道 ISE words[i].phonemes 双口径：新版 phoneme/score，旧版 phone/pronunciation */
function parsePhonemeDto(dto) {
  var name = dto.phoneme || dto.phone;
  if (!name) return null;
  var score = dto.score != null ? dto.score : dto.pronunciation;
  return { phoneme: String(name), score: roundInt(score) };
}

function parseWordDto(dto) {
  return {
    word: String(dto.word || ''),
    score: roundInt(dto.pronunciation),
    start: dto.start != null && isFinite(Number(dto.start)) ? Number(dto.start) : null,
    end: dto.end != null && isFinite(Number(dto.end)) ? Number(dto.end) : null,
    phonemes: (Array.isArray(dto.phonemes) ? dto.phonemes : [])
      .map(parsePhonemeDto)
      .filter(function (p) { return !!p; }),
  };
}

/** 有道 ISE details → 评测结果（overall ?? pronunciation ?? fallback 兜底链） */
function parseDetails(details, recognitionId, fallbackScore) {
  var d = details || {};
  return {
    overallScore: roundInt(
      d.overall != null ? d.overall
        : d.pronunciation != null ? d.pronunciation
        : fallbackScore != null ? fallbackScore : 0
    ),
    pronunciation: roundInt(d.pronunciation != null ? d.pronunciation : 0),
    fluency: roundInt(d.fluency != null ? d.fluency : 0),
    integrity: roundInt(d.integrity != null ? d.integrity : 0),
    speed: roundInt(d.speed != null ? d.speed : 0),
    words: (Array.isArray(d.words) ? d.words : []).map(parseWordDto),
    recognitionId: recognitionId != null ? recognitionId : null,
    userAudioPath: null,
    userAudioUrl: null,
  };
}

/**
 * POST /api/speech/evaluate 响应 → 评测结果：
 * 有 details 走明细；无 details 退化为总分（四维同分，words 空）。
 */
function parseEvalResponse(body) {
  var data = (body && body.data) || {};
  var score = data.score != null ? Number(data.score) : null;
  if (data.details) return parseDetails(data.details, data.recognitionId, score);
  var s = roundInt(score);
  return {
    overallScore: s,
    pronunciation: s,
    fluency: 0,
    integrity: 0,
    speed: 0,
    words: [],
    recognitionId: data.recognitionId != null ? data.recognitionId : null,
    userAudioPath: null,
    userAudioUrl: null,
  };
}

// ==================== 过滤与历史匹配（ViewModel 同口径） ====================

/** 历史记录与字幕的匹配：subtitleId 相同 || 文本相同且起点差 < 0.5s */
function matchesRecord(sub, record) {
  return record.subtitleId === sub.id ||
    (record.targetText === sub.textEn &&
      Math.abs(record.targetStartTime - sub.start) < 0.5);
}

function countWords(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(function (w) { return w.length > 0; })
    .length;
}

/** 匹配该句的最新一次记录（recognitionid 最大即最新） */
function latestRecordFor(sub, records) {
  var latest = null;
  for (var i = 0; i < records.length; i++) {
    if (matchesRecord(sub, records[i])) {
      if (!latest || records[i].recognitionid > latest.recognitionid) latest = records[i];
    }
  }
  return latest;
}

/** 句子过滤：词数区间 + 只练未掌握（最新 bestScore 达生效线即排除） */
function applyFilters(all, records, settings) {
  var threshold = effectivePassThreshold(settings);
  return all.filter(function (sub) {
    var wordCount = countWords(sub.textEn);
    if (wordCount < settings.minWords) return false;
    if (settings.maxWords < 50 && wordCount > settings.maxWords) return false;
    if (settings.onlyUnmastered) {
      var latest = latestRecordFor(sub, records);
      if (latest && (latest.overallScore != null ? latest.overallScore : latest.accuracyScore) >= threshold) {
        return false;
      }
    }
    return true;
  });
}

/** 目标句被过滤排除时的兜底：目标之后（start ≥ 目标）最近的可见句，末句封底 */
function nearestVisibleIndexAfter(filtered, all, subtitleId) {
  var targetStart = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].id === subtitleId) { targetStart = all[i].start; break; }
  }
  for (var j = 0; j < filtered.length; j++) {
    if (filtered[j].start >= targetStart) return j;
  }
  return Math.max(0, filtered.length - 1);
}

/** 历史记录 → 基础结果卡（分数直出；fluency/integrity 缺省回落 accuracy） */
function recordToResult(record) {
  var acc = record.accuracyScore;
  return {
    overallScore: record.overallScore != null ? record.overallScore : acc,
    pronunciation: acc,
    fluency: record.fluencyScore != null ? record.fluencyScore : acc,
    integrity: record.integrityScore != null ? record.integrityScore : acc,
    speed: record.speed != null ? record.speed : 0,
    words: [],
    recognitionId: record.recognitionid,
    userAudioPath: null,
    userAudioUrl: record.userAudioUrl,
  };
}

// ==================== 渲染辅助（SpeechEvalCard 同口径） ====================

/** 查词/音标键：去除词上标点后小写（保留撇号 don't） */
function cleanWordKey(word) {
  var w = String(word || '');
  var start = 0;
  var end = w.length;
  var isLetterOrApostrophe = function (c) {
    return /[a-zA-Z']/.test(c);
  };
  while (start < end && !isLetterOrApostrophe(w[start])) start++;
  while (end > start && !isLetterOrApostrophe(w[end - 1])) end--;
  return w.slice(start, end).toLowerCase();
}

/** 词典音标去斜杠（/sʌm/ → sʌm），句内按空格拼接展示 */
function stripIpaSlashes(ipa) {
  return String(ipa || '').replace(/^\/+|\/+$/g, '');
}

/** 分词渲染 token：有词级时间戳逐词绑定，无则按空白切分兜底（时间戳退化为句起点） */
function buildSentenceTokens(subtitle, ipaMap) {
  var tokens = [];
  var words = subtitle.words || [];
  var push = function (rawWord, timeStart) {
    var display = rawWord;
    if (ipaMap) {
      var hit = ipaMap[cleanWordKey(rawWord)];
      if (hit) display = hit;
    }
    tokens.push({ d: display, w: rawWord, s: timeStart });
  };
  if (words.length > 0) {
    for (var i = 0; i < words.length; i++) push(words[i].word, words[i].start);
  } else {
    var raw = String(subtitle.textEn || '').split(/\s+/).filter(function (t) { return t.length > 0; });
    for (var j = 0; j < raw.length; j++) push(raw[j], subtitle.start);
  }
  return tokens;
}

/** 盲读遮挡条：按词长生成（宽 = 字号×0.62×max(词长,2)，高 = 字号 + 6dp） */
function buildBlindBars(textEn) {
  return String(textEn || '')
    .split(/\s+/)
    .filter(function (t) { return t.length > 0; })
    .map(function (t) { return Math.max(2, t.length); });
}

/** 总分/评价与单词 chip 的双分界（>=85 primary / >=60 secondary / else error） */
function scoreTier(score) {
  if (score >= 85) return 'good';
  if (score >= 60) return 'mid';
  return 'bad';
}

/** 评级词（Excellent! / Good Job! / Keep Trying!，阈值用生效线） */
function ratingWord(score, threshold) {
  if (score >= threshold) return 'Excellent!';
  if (score >= 60) return 'Good Job!';
  return 'Keep Trying!';
}

/** 词级原声的模糊兜底匹配距离（cheapDistance） */
function cheapDistance(a, b) {
  a = String(a).toLowerCase();
  b = String(b).toLowerCase();
  if (a === b) return 0;
  var miss = 0;
  for (var i = 0; i < a.length; i++) {
    if (b.indexOf(a[i]) < 0) miss++;
  }
  return Math.abs(a.length - b.length) + miss;
}

// ==================== 录音（PCM 帧音量 + WAV 封装） ====================

/** PCM16 帧的 RMS 音量（0..100，×300 增益后截断） */
function frameAmplitude(frameBuffer) {
  var samples = new Int16Array(frameBuffer);
  if (!samples.length) return 0;
  var sum = 0;
  for (var i = 0; i < samples.length; i++) {
    var v = samples[i] / 32768;
    sum += v * v;
  }
  var rms = Math.sqrt(sum / samples.length);
  return Math.round(Math.min(100, rms * 300));
}

/** PCM 帧序列 → 16bit mono WAV（44 字节头 + 采样数据），返回 ArrayBuffer */
function pcmToWav(frames, sampleRate) {
  var total = 0;
  for (var i = 0; i < frames.length; i++) total += frames[i].byteLength;
  var buffer = new ArrayBuffer(44 + total);
  var view = new DataView(buffer);
  var writeStr = function (offset, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + total, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);   // fmt chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);    // block align
  view.setUint16(34, 16, true);   // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, total, true);
  var offset = 44;
  var bytes = new Uint8Array(buffer);
  for (var j = 0; j < frames.length; j++) {
    bytes.set(new Uint8Array(frames[j]), offset);
    offset += frames[j].byteLength;
  }
  return buffer;
}

/** 词级扫光三态（复用精听页 useWordHighlight 离散移植，两页同源） */
function computeWordSweep(words, t, start, end) {
  return intensiveCore.computeWordSweep(words, t, start, end);
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  STRICTNESS_OFFSETS: STRICTNESS_OFFSETS,
  effectivePassThreshold: effectivePassThreshold,
  normalizeSettings: normalizeSettings,
  parsePracticeData: parsePracticeData,
  parseRecordDto: parseRecordDto,
  parseDetails: parseDetails,
  parseEvalResponse: parseEvalResponse,
  matchesRecord: matchesRecord,
  countWords: countWords,
  latestRecordFor: latestRecordFor,
  applyFilters: applyFilters,
  nearestVisibleIndexAfter: nearestVisibleIndexAfter,
  recordToResult: recordToResult,
  cleanWordKey: cleanWordKey,
  stripIpaSlashes: stripIpaSlashes,
  buildSentenceTokens: buildSentenceTokens,
  buildBlindBars: buildBlindBars,
  scoreTier: scoreTier,
  ratingWord: ratingWord,
  cheapDistance: cheapDistance,
  frameAmplitude: frameAmplitude,
  pcmToWav: pcmToWav,
  computeWordSweep: computeWordSweep,
};
