/**
 * pages/home/daily-coach.js — 今日挑战数据引擎（B工程 api.ts 逐字移植）
 *
 * 三块纯函数（与 B 保持同构，保证沙箱行为与原型一致）：
 * ① buildPronunciationCoachData — 音节诊断预设 + 动态双音节兜底 + 36 柱
 *    双轨声学波形（native 有机包络 / user 按诊断染色含凹陷）；
 * ② evalFallback — 跟读评测兜底（B api.evaluateSpeech 无服务端时的本地
 *    算法：baseScore 84-95、四维分、固定点评文案、徽章）；
 * ③ dateSeed / seededPick — B server /api/ai/daily-challenge 兜底的
 *    date 种子打分选料（(seed+idx*7)%100，逐字移植）。
 *
 * 清洗口径：本模块文案均为 B 原文且不含敏感字样（评分按钮等
 * 页面文案在 index.js/WXML 层另行清洗）。
 */

/** B api.ts SYLLABLE_PRESETS 一字不差（6 个高难词的音节诊断预设） */
const SYLLABLE_PRESETS = {
  isolation: {
    word: 'isolation',
    syllableBreakdown: [
      { text: 'i', status: 'accurate' },
      { text: 'so', status: 'accurate' },
      { text: 'la', status: 'error' },
      { text: 'tion', status: 'warning' }
    ],
    focusSyllable: '-la-',
    status: 'error',
    standardIpa: '/ˌaɪ.səˈleɪ.ʃən/',
    userDetectedIpa: '/ˌaɪ.səˈle.ʃən/ (双元音 /eɪ/ 滑动不饱满)',
    issueType: '重读音节双元音扁平 & 能量偏弱',
    acousticDiff: '第 3 音节 [-la-] 声强峰值比母语者低 31%，双元音滑音时长短 55ms',
    mouthShape: '双唇由半开向两侧微展，下颌先降后微抬',
    tonguePosition: '舌面前部由中低位向高前位 /ɪ/ 顺滑过渡',
    articulationTip: '重音落在第三音节 -la- 上，切忌读成单音 /e/；需明显做出 /e/ 滑向 /ɪ/ 的动程，并拉长元音时长。'
  },
  evaluate: {
    word: 'evaluate',
    syllableBreakdown: [
      { text: 'e', status: 'accurate' },
      { text: 'val', status: 'warning' },
      { text: 'u', status: 'accurate' },
      { text: 'ate', status: 'accurate' }
    ],
    focusSyllable: '-val-',
    status: 'warning',
    standardIpa: '/ɪˈvæl.ju.eɪt/',
    userDetectedIpa: '/ɪˈve.ju.eɪt/ (梅花音 /æ/ 开口度不足 & 舌侧音 /l/ 弱化)',
    issueType: '前元音 /æ/ 开口度偏小',
    acousticDiff: '第 2 音节 [-val-] 第一共振峰偏低，声波包络上升沿稍慢',
    mouthShape: '双唇向两侧拉宽，上下齿间可容纳两指宽度',
    tonguePosition: '舌尖紧抵下齿背，舌前部压低，收尾时舌尖轻触上齿龈发 /l/',
    articulationTip: '发 -val- 时下巴主动向下打开，确保梅花音 /æ/ 清脆饱满，随后舌尖上抬抵住上齿龈完成 /l/ 过渡。'
  },
  unprecedented: {
    word: 'unprecedented',
    syllableBreakdown: [
      { text: 'un', status: 'accurate' },
      { text: 'prec', status: 'error' },
      { text: 'e', status: 'warning' },
      { text: 'dent', status: 'accurate' },
      { text: 'ed', status: 'accurate' }
    ],
    focusSyllable: '-prec-',
    status: 'error',
    standardIpa: '/ʌnˈpres.ɪ.den.tɪd/',
    userDetectedIpa: '/ʌnˈpriː.sɪ.den.tɪd/ (误读为长元音 /iː/ 且重音滞后)',
    issueType: '主重音元音误读 & 辅音连缀 /pr/ 爆破不足',
    acousticDiff: '第 2 音节 [-prec-] 高频擦音能量偏移，音节时长过长 42ms',
    mouthShape: '双唇紧闭蓄气后迅速张开，嘴角微收',
    tonguePosition: '舌尖卷起接近上颚发 /r/，紧接短促前元音 /e/',
    articulationTip: '注意 -prec- 中的 e 发短促的 /e/（同 press），绝不能读成 /priː/！重音果断砸在第二音节上。'
  },
  choreography: {
    word: 'choreography',
    syllableBreakdown: [
      { text: 'cho', status: 'accurate' },
      { text: 're', status: 'accurate' },
      { text: 'og', status: 'error' },
      { text: 'ra', status: 'warning' },
      { text: 'phy', status: 'accurate' }
    ],
    focusSyllable: '-og-',
    status: 'error',
    standardIpa: '/ˌkɔː.riˈɑː.ɡrə.fi/',
    userDetectedIpa: '/ˌtʃɔː.riˈoʊ.ɡrə.fi/ (重音节后元音 /ɑː/ 读成双元音)',
    issueType: '多音节主重音位置与美式大开口 /ɑː/ 偏差',
    acousticDiff: '第 3 音节 [-og-] 波形振幅不足标准原声的 64%，缺乏重音落点感',
    mouthShape: '口腔纵向大开，双唇自然放松不圆唇',
    tonguePosition: '舌身后缩并压低，声带充分振动',
    articulationTip: '主重音落在第三音节 -og- (/ˈɑːɡ/)，嘴巴纵向张大发美式 /ɑː/，紧接着第四音节 -ra- 迅速弱读为 /rə/。'
  },
  fundamentally: {
    word: 'fundamentally',
    syllableBreakdown: [
      { text: 'fun', status: 'accurate' },
      { text: 'da', status: 'accurate' },
      { text: 'men', status: 'error' },
      { text: 'tal', status: 'warning' },
      { text: 'ly', status: 'accurate' }
    ],
    focusSyllable: '-men-',
    status: 'error',
    standardIpa: '/ˌfʌn.dəˈmen.təl.i/',
    userDetectedIpa: '/ˈfʌn.də.men.təl.i/ (主次重音倒置 & 鼻音共鸣不足)',
    issueType: '主次重音倒置 & 齿龈爆破音未闪音化',
    acousticDiff: '第 1 音节过重而第 3 音节 [-men-] 能量偏弱 29%，语调平直',
    mouthShape: '双唇自然微张，鼻腔通道打开',
    tonguePosition: '舌尖抵上齿龈发鼻音 /n/，美音中后接 -tal- 常弱化为鼻腔爆破',
    articulationTip: '前面的 fun- 是次重音，真正的主重音在第三音节 -men- 上！在 -men- 上提高音高并加强鼻音共鸣。'
  },
  disruption: {
    word: 'disruption',
    syllableBreakdown: [
      { text: 'dis', status: 'accurate' },
      { text: 'rup', status: 'warning' },
      { text: 'tion', status: 'accurate' }
    ],
    focusSyllable: '-rup-',
    status: 'warning',
    standardIpa: '/dɪsˈrʌp.ʃən/',
    userDetectedIpa: '/dɪsˈrɑːp.ʃən/ (中元音 /ʌ/ 开口过大且 /p/ 爆破过响)',
    issueType: '中元音 /ʌ/ 音色偏暗 & 词中塞音未做不完全爆破',
    acousticDiff: '第 2 音节 [-rup-] 结尾处出现多余爆破尖峰，阻碍与 -tion 的连贯过渡',
    mouthShape: '双唇微开放松，结尾 /p/ 双唇闭合持阻但不送气',
    tonguePosition: '舌中部略微隆起发短促 /ʌ/，旋即闭合双唇准备发 /ʃ/',
    articulationTip: '发完 /rʌ/ 后双唇迅速闭合做 /p/ 的口型，但不要喷气爆破，直接滑向 /ʃən/，语流会瞬间地道流畅。'
  }
};

/**
 * 声学波形音节精修数据（B buildPronunciationCoachData 逐字移植）：
 * 预设词命中 → 精细诊断；未命中 → 取 2 个最长实词动态双音节；
 * 36 柱 native 有机包络 + user 按诊断区间凹陷。
 */
function buildPronunciationCoachData(sentence, phoneticFocus) {
  const cleanWords = String(sentence || '')
    .replace(/[^\w\s'-]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const diagnoses = [];
  const totalWords = Math.max(1, cleanWords.length);

  cleanWords.forEach((rawWord, idx) => {
    const lower = rawWord.toLowerCase();
    if (SYLLABLE_PRESETS[lower]) {
      const preset = SYLLABLE_PRESETS[lower];
      const startRatio = Number(Math.max(0.05, Math.min(0.85, idx / totalWords)).toFixed(2));
      const endRatio = Number(Math.min(0.96, startRatio + Math.max(0.12, 1.3 / totalWords)).toFixed(2));
      diagnoses.push(Object.assign({}, preset, {
        id: 'syl-' + lower + '-' + idx,
        startRatio,
        endRatio
      }));
    }
  });

  // 未命中预设：动态取 2 个最长实词（≥5 字母）做双音节诊断
  if (diagnoses.length === 0) {
    const candidates = cleanWords
      .map((w, idx) => ({ w, idx }))
      .filter((item) => item.w.length >= 5)
      .sort((a, b) => b.w.length - a.w.length)
      .slice(0, 2);

    candidates.forEach((item, cIdx) => {
      const w = item.w;
      const mid = Math.max(2, Math.floor(w.length / 2));
      const part1 = w.slice(0, mid);
      const part2 = w.slice(mid);
      const startRatio = Number(Math.max(0.08, Math.min(0.82, item.idx / totalWords)).toFixed(2));
      const endRatio = Number(Math.min(0.95, startRatio + 0.16).toFixed(2));

      diagnoses.push({
        id: 'syl-dyn-' + cIdx,
        word: w,
        syllableBreakdown: [
          { text: part1, status: cIdx === 0 ? 'error' : 'accurate' },
          { text: part2, status: cIdx === 0 ? 'accurate' : 'warning' }
        ],
        focusSyllable: '-' + (cIdx === 0 ? part1 : part2) + '-',
        status: cIdx === 0 ? 'error' : 'warning',
        startRatio,
        endRatio,
        standardIpa: '/' + part1 + 'ˈ' + part2 + '/',
        userDetectedIpa: '/' + part1 + '.' + part2 + '/ (重音音高起伏度偏弱)',
        issueType: cIdx === 0 ? '重读音节元音饱满度不足' : '词尾弱读音节收音偏重',
        acousticDiff:
          cIdx === 0
            ? '音节 [-' + part1 + '-] 声学能量比原声低 27%，元音共振峰持续时间偏短'
            : '音节 [-' + part2 + '-] 收尾时长超出原声 38ms，弱读不够轻快',
        mouthShape: '双唇微张自然放松，重读音节下颌打开度增加 30%',
        tonguePosition: '舌前部保持灵活弹动，辅音与元音交界处连贯过渡',
        articulationTip:
          phoneticFocus ||
          '注意 "' + w + '" 的主次重音对比：重读音节拉长并提高音调，非重读音节轻快一带而过。'
      });
    });
  }

  // 36 柱双轨包络
  const BINS = 36;
  const nativeWaveform = [];
  const userWaveform = [];
  for (let i = 0; i < BINS; i++) {
    const ratio = i / BINS;
    const baseWave =
      42 +
      Math.round(28 * Math.sin(i * 0.65) + 18 * Math.cos(i * 1.35) + ((i * 17) % 11));
    const clampedNative = Math.max(18, Math.min(96, baseWave));
    nativeWaveform.push(clampedNative);

    const matchedDiag = diagnoses.find(
      (d) => ratio >= d.startRatio && ratio <= d.endRatio
    );
    if (matchedDiag) {
      if (matchedDiag.status === 'error') {
        userWaveform.push(Math.max(14, Math.round(clampedNative * 0.56)));
      } else {
        userWaveform.push(Math.max(18, Math.round(clampedNative * 0.76)));
      }
    } else {
      const delta = ((i % 3) - 1) * 4;
      userWaveform.push(Math.max(16, Math.min(96, clampedNative + delta)));
    }
  }

  return { nativeWaveform, userWaveform, syllableDiagnoses: diagnoses };
}

/**
 * 跟读评测兜底（B api.evaluateSpeech 无服务端时的本地算法，逐字移植）。
 * 沙箱注记：迁移 yuanlu-weapp 时换 eval-card 真实录音评测。
 */
function evalFallback(params) {
  const p = params || {};
  const coachData = buildPronunciationCoachData(p.sentence, p.phoneticFocus);

  const baseScore = Math.floor(84 + Math.random() * 12);
  const accuracy = Math.min(98, baseScore + Math.floor(Math.random() * 6 - 2));
  const fluency = Math.min(97, baseScore + Math.floor(Math.random() * 5 - 3));
  const integrity = Math.min(99, baseScore + Math.floor(Math.random() * 4));
  const connectedSpeech = Math.min(96, baseScore + Math.floor(Math.random() * 6 - 4));

  let celebrationBadge = '🌟 口语达人';
  if (baseScore >= 92) celebrationBadge = '🏆 卓越原声复刻';
  else if (baseScore >= 85) celebrationBadge = '⚡ 连读流动先锋';

  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  return {
    score: baseScore,
    accuracy,
    fluency,
    integrity,
    connectedSpeech,
    feedback:
      '发音清晰有力，整句节奏感把握极佳！' +
      (p.targetVocabulary && p.targetVocabulary.length > 0
        ? "重点词汇 '" + p.targetVocabulary[0] + "' 吐字到位。"
        : ''),
    phonemeAdvice: p.phoneticFocus
      ? '建议针对重点："' + p.phoneticFocus + '"稍作放慢跟读，注意弱读元音的轻快掠过。'
      : '注意爆破音在句尾的轻柔收音，避免过度拖长音节。',
    strengths: '句式语调自然上升与回落，意群停顿契合母语者习惯。',
    improvementTip: '在长单词重音后，非重音音节可以更加轻盈自然。',
    celebrationBadge,
    evaluatedAt: pad(now.getHours()) + ':' + pad(now.getMinutes()),
    nativeWaveform: coachData.nativeWaveform,
    userWaveform: coachData.userWaveform,
    syllableDiagnoses: coachData.syllableDiagnoses
  };
}

/** B server 兜底的 date 种子（逐字移植：(seed*31+code)%100000） */
function dateSeed(dateStr) {
  let seed = 0;
  for (let i = 0; i < dateStr.length; i++) {
    seed = (seed * 31 + dateStr.charCodeAt(i)) % 100000;
  }
  return seed;
}

/**
 * date 种子打分选 5 条（B server scoredCorpus 兜底逐字移植；
 * vocabHit 为可选的「切片词命中用户生词表」加分回调，+150 同 B）。
 */
function seededPick(items, seed, vocabHit) {
  const scored = items.map((clip, idx) => {
    let score = (seed + idx * 7) % 100;
    if (vocabHit && vocabHit(clip)) score += 150;
    return { clip, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.clip);
}

module.exports = {
  buildPronunciationCoachData,
  evalFallback,
  dateSeed,
  seededPick,
};
