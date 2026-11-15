/**
 * 字幕句界 → 物理切片内的播放窗口（秒）。
 * /api/clips/{id}/audio 的 duration 是含首尾 padding 的文件时长，
 * 不能作为句尾；feed 的 duration 也不能直接当作切片内的结束位置。
 * 预签、懒取和缓存重播统一使用字幕 start/end 减去实际 clipOffset。
 */
function sentenceWindow(clip, offset) {
  if (!clip || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) ||
      !Number.isFinite(offset) || offset < 0 || clip.start < 0 || clip.end <= clip.start) {
    throw new Error('invalid sentence audio window');
  }
  const winStart = Math.max(0, clip.start - offset);
  const winEnd = clip.end - offset;
  if (winEnd <= winStart) throw new Error('sentence outside audio window');
  return { offset, winStart, winEnd };
}

module.exports = { sentenceWindow };
