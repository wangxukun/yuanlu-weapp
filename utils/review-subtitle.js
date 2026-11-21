const audioClip = require('./audio-clip');
const { resolveEpisode, findSubtitle } = require('./episode-context');
const { buildSentenceTokens } = require('./sentence-tokens');

function timedWords(words) {
  return (Array.isArray(words) ? words : [])
    .filter((w) => w && typeof w.word === 'string' && w.start != null && w.end != null)
    .map((w) => ({ word: w.word, start: Number(w.start), end: Number(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
}

function subtitle(sentence, url, absoluteStart, absoluteEnd, offset, words) {
  const start = absoluteStart - offset;
  const end = absoluteEnd - offset;
  const aligned = words
    .filter((w) => w.end > absoluteStart && w.start < absoluteEnd)
    .map((w) => ({ word: w.word, start: Math.max(start, w.start - offset), end: Math.min(end, w.end - offset) }));
  return {
    textEn: sentence.textEn, textCn: sentence.textCn || '', audioUrl: url, start, end,
    episodeStart: absoluteStart, episodeEnd: absoluteEnd, clipId: sentence.clipId || '',
    words: aligned, sentenceTokens: buildSentenceTokens(sentence.textEn, '', aligned, start, end),
  };
}

async function resolveReviewSubtitle(sentence) {
  const { startTime, endTime } = sentence;
  const words = timedWords(sentence.clipWords && sentence.clipWords.length ? sentence.clipWords : sentence.subtitleWords);
  const hasWindow = Number.isFinite(startTime) && startTime >= 0 && endTime > startTime;
  const unavailable = () => subtitle(sentence, '', startTime || 0, hasWindow ? endTime : (startTime || 0) + 3, 0, words);
  let clip;
  try {
    clip = await audioClip.resolveClipSource(sentence, { showError: false });
  } catch (error) {
    if (error.statusCode === 401 || error.statusCode === 403) return unavailable();
  }
  if (clip && clip.url) {
    const offset = clip.offset || 0;
    const limit = clip.duration > 0 ? offset + clip.duration : Infinity;
    // 历史评测的 targetStartTime 可能是 0；物理切片本身已经限定了这一句。
    const start = Number.isFinite(startTime) && startTime >= offset && startTime < limit ? startTime : offset;
    const end = endTime > start ? Math.min(endTime, limit) : limit;
    if (Number.isFinite(end) && end > start) return subtitle(sentence, clip.url, start, end, offset, words);
    if (words.length && words[words.length - 1].end > start) {
      return subtitle(sentence, clip.url, start, words[words.length - 1].end, offset, words);
    }
  }

  let episodeUrl = /^https?:\/\//i.test(sentence.episodeAudioUrl || '')
    ? sentence.episodeAudioUrl.replace(/^http:/i, 'https:') : '';
  if (episodeUrl && hasWindow && startTime > 0 && words.length) {
    return subtitle(sentence, episodeUrl, startTime, endTime, 0, words);
  }
  if (sentence.episodeid) {
    try {
      const episode = await resolveEpisode(sentence.episodeid);
      episodeUrl = episode.url;
      const row = findSubtitle(episode.subs, {
        subtitleId: sentence.subtitleId, text: sentence.textEn, timestamp: startTime,
      });
      if (row && row.start != null && Number.isFinite(Number(row.start)) && Number(row.end) > Number(row.start)) {
        const rowWords = timedWords(row.words);
        return subtitle(sentence, episode.url, Number(row.start), Number(row.end), 0, rowWords.length ? rowWords : words);
      }
    } catch (_) { /* 字幕服务暂不可用时，弱项接口可能已返回签名原声与词窗。 */ }
  }
  // 评测接口会把未知起点记作 0，不能因此从整集开头播放到句尾。
  const missingStart = startTime == null || (sentence.weakRecord && startTime === 0);
  const start = missingStart ? (words.length ? words[0].start : null) : startTime;
  const end = endTime > start ? endTime : words.length && words[words.length - 1].end;
  if (episodeUrl && Number.isFinite(start) && end > start) {
    return subtitle(sentence, episodeUrl, start, end, 0, words);
  }
  return unavailable();
}

module.exports = { resolveReviewSubtitle };
