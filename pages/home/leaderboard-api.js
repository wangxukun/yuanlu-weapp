/**
 * pages/home/leaderboard-api.js — home 排行榜真实数据层（yuanlu
 * /api/speech/leaderboard 扩展契约 + cheer）。
 *
 * home 榜固定 period=daily&metric=count（今日跟读次数榜）。后端 entries 为
 * 评测聚合（userid/evalCount/avgScore…），本模块映射成 leaderboard-mock 的
 * Entry 字段名（id/name/shadowingCount/averageScore/…），WXML 零改动。
 * 未登录/接口失败由调用方回落 leaderboard-mock 兜底。
 */
const { get, post } = require('../../utils/request');
const authStore = require('../../store/authStore');

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function mapEntry(e, myUserid) {
  return {
    id: e.userid,
    name: e.nickname,
    avatar: e.avatar,
    shadowingCount: e.evalCount,
    averageScore: e.avgScore,
    streakDays: e.streakDays || 0,
    badge: e.badge || '',
    featuredSentence: e.featuredSentence || '',
    featuredClipId: e.featuredClipId || '',
    likes: e.likes || 0,
    likedByMe: !!e.likedByMe,
    firstName: e.firstName || '',
    lastActive: e.lastActive || '',
    rank: e.rank || 0,
    isCurrentUser: !!myUserid && e.userid === myUserid,
  };
}

/** 今日跟读榜（扩展装饰：streak/badge/代表作/点赞/myEntry/nextTarget） */
async function fetchDaily() {
  const auth = authStore.getState();
  const myUserid = (auth.userInfo && auth.userInfo.userid) || '';
  const body = await get(
    '/api/speech/leaderboard',
    { period: 'daily', metric: 'count' },
    { showError: false }
  );
  if (!body || !body.success || !body.data) throw new Error('leaderboard unavailable');
  const d = body.data;
  return {
    date: todayStr(),
    totalParticipants: d.totalParticipants || 0,
    entries: (d.entries || []).map((e) => mapEntry(e, myUserid)),
    // 零跟读用户不显示站位卡（否则 nextTarget 兜底文案会误报「已登顶」）
    myEntry: d.myEntry && d.myEntry.evalCount > 0 ? mapEntry(d.myEntry, myUserid) : null,
    nextTargetDiff: d.nextTargetDiff || 0,
    nextTargetName: d.nextTargetName || '',
  };
}

/** 点赞（当日幂等，禁自赞）→ { likes, likedByMe } */
async function cheer(targetUserid) {
  const body = await post(
    '/api/speech/leaderboard/cheer',
    { targetUserid },
    { showError: false }
  );
  if (!body || !body.success || !body.data) {
    const err = new Error((body && body.error) || '点赞失败');
    err.body = body || null;
    throw err;
  }
  return body.data;
}

module.exports = { fetchDaily, cheer };
