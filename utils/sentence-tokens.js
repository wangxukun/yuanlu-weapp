// 字幕原文负责显示（保留标点、大小写、空格），语音对齐结果只提供时间。
function buildSentenceTokens(text, query, words, start, end) {
  const tokens = [];
  const pattern = /[a-z0-9]+(?:['’][a-z0-9]+)*/gi;
  const normalize = (value) => value.toLowerCase().replace(/’/g, "'");
  const needle = normalize(query.trim()).replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
  const queryPattern = needle ? new RegExp('\\b' + needle + '\\b', 'g') : null;
  const normalizedText = normalize(text);
  let hit = queryPattern && queryPattern.exec(normalizedText);
  let match;
  while ((match = pattern.exec(text))) {
    if (tokens.length) {
      const previous = tokens[tokens.length - 1];
      previous.after = text.slice(previous.offset + previous.text.length, match.index);
    }
    while (hit && hit.index + hit[0].length <= match.index) hit = queryPattern.exec(normalizedText);
    tokens.push({
      text: match[0], before: tokens.length ? '' : text.slice(0, match.index), after: '',
      offset: match.index, target: !!hit && hit.index < pattern.lastIndex,
    });
  }
  if (!tokens.length) return [];
  const last = tokens[tokens.length - 1];
  last.after = text.slice(last.offset + last.text.length);

  let cursor = 0;
  for (const word of words) {
    const key = normalize(word.word).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const index = tokens.findIndex((token, i) => i >= cursor && normalize(token.text) === key);
    if (index < 0 || word.end <= start || word.start >= end) continue;
    tokens[index].start = Math.max(start, word.start);
    tokens[index].end = Math.min(end, word.end);
    cursor = index + 1;
  }
  // 旧字幕可能缺少部分或全部词窗。在已有时间锚点之间均分缺口，保留整句播放范围。
  let first = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && tokens[i].start == null) continue;
    const left = first ? tokens[first - 1].end : start;
    const right = i < tokens.length ? tokens[i].start : end;
    const step = i > first ? Math.max(0, right - left) / (i - first) : 0;
    for (let j = first; j < i; j++) {
      tokens[j].start = left + (j - first) * step;
      tokens[j].end = left + (j - first + 1) * step;
    }
    first = i + 1;
  }
  return tokens;
}

module.exports = { buildSentenceTokens };
