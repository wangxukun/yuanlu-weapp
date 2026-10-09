// utils/channels — 频道数据源（发现页「推荐频道」/全部频道页共用）
// 对齐 Web lib/discover-service.getRecommendedChannels 的公开口径：后端
// GET /api/channels（app/api/channels/route.ts，Web 发现页/全部频道页同源）
// 按 platform 聚合并返回频道品牌横幅（7 天签名）或代表节目封面（3 小时签名）、
// 总集数、节目档数、频道排序（channel 表 sortOrder 优先，其余按总播放量）。
// 小程序端不做客户端聚合——封面签名与排序逻辑全部收敛在服务端，与 Web 完全同口径。
const { get } = require('./request');

/**
 * 拉取频道列表（含封面/集数/档数）
 * @returns {Promise<Array<{name,coverUrl,podcastCount,episodeCount,totalPlays}>>}
 * @throws {Error} 网络失败 / 非 2xx（request.js ApiError）或信封 success:false
 */
async function fetchChannels() {
  const res = await get('/api/channels');
  if (!res || !res.success || !Array.isArray(res.data)) {
    throw new Error((res && res.error) || '加载频道失败');
  }
  return res.data.map((c) => ({
    name: c.name || '',
    coverUrl: c.coverUrl || '',
    podcastCount: c.podcastCount || 0,
    episodeCount: c.episodeCount || 0,
    totalPlays: c.totalPlays || 0,
  }));
}

module.exports = { fetchChannels };
