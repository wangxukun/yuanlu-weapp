/**
 * pages/home/relay-api.js — 跟读接力真实数据层（yuanlu /api/relay/*）。
 *
 * 后端房间语义（对 B 原型的一处真实化）：targetSteps=3；发起=第 1 棒（用户
 * 真录音）+ 语伴 Elena 完成第 2 棒 → RECRUITING 等接棒；接棒=第 3 棒压轴 →
 * COMPLETED + 合集。本模块把后端 RoomView 映射成 relay-mock 同名字段，
 * WXML 零改动；未登录/接口失败由调用方（index.js）回落 relay-mock 兜底。
 *
 * 音频协议对齐 _prepareAudio 三分支：
 *   USER 棒 → real:false + clipAudioUrl=OSS 现签直链 + start:0/end:录音时长
 *   （直播路径，不额外请求）；PERSONA 棒 → real:true + clipid 懒取
 *   /api/clips/{id}/audio（sentenceWindow 需要 start/end=字幕窗，由后端给）。
 */
const { get, post } = require('../../utils/request');

function mapSegment(seg) {
  const base = {
    stepOrder: seg.stepOrder,
    kind: seg.kind,
    speakerName: seg.speakerName,
    speakerAvatar: seg.speakerAvatar,
    voiceStyle: seg.voiceStyle,
    textEn: seg.textEn,
    textCn: seg.textCn,
    words: seg.words || [],
    score: Math.round(seg.score || 0),
    recordedAt: seg.recordedAt,
    duration: seg.duration || 0,
    clipid: seg.clipid,
  };
  if (seg.kind === 'USER') {
    return Object.assign(base, {
      id: seg.id,
      isCurrentUser: !!seg.isCurrentUser,
      real: false,
      clipAudioUrl: seg.audioUrl || '',
      start: 0,
      end: seg.duration || 0,
    });
  }
  // PERSONA：id 用 clipid（_prepareAudio real:true 分支按 clip.id 懒取切片音频）
  return Object.assign(base, {
    id: seg.clipid,
    isCurrentUser: false,
    real: true,
    clipAudioUrl: null,
    start: seg.start,
    end: seg.end,
  });
}

function mapRoom(r) {
  return {
    id: r.id,
    title: r.title,
    topic: r.topic,
    difficulty: r.difficulty,
    status: String(r.status || '').toLowerCase(),
    targetSteps: r.targetSteps || 3,
    initiatorName: r.initiatorName,
    initiatorAvatar: r.initiatorAvatar,
    likes: r.likes || 0,
    likedByMe: !!r.likedByMe,
    isMine: !!r.isMine,
    starterClipId: r.starterClipId || '',
    invitedUsers: r.invitedUsers || [],
    segments: (r.segments || []).map(mapSegment),
    nextPromptSegment: r.nextPromptSegment
      ? Object.assign({}, r.nextPromptSegment, { audioUrl: r.nextPromptSegment.audioUrl || '' })
      : null,
    compilation: r.compilation || null,
  };
}

/** 分层小窗口（T15）：recruitBatch=推荐层换一批页码。
 * 返回 { rooms, totalRecruiting, recruitHasMore }——我的招募≤5 → 推荐接棒×5
 * → 最近完成合集×3；读取前服务端已懒清扫 24h 过期招募房（T7）。 */
async function fetchRooms(recruitBatch) {
  const q = recruitBatch > 1 ? '?recruitBatch=' + recruitBatch : '';
  const body = await get('/api/relay/list' + q, null, { showError: false });
  if (!body || !body.success || !body.data) throw new Error('relay list unavailable');
  return {
    rooms: (body.data.rooms || []).map(mapRoom),
    totalRecruiting: body.data.totalRecruiting || 0,
    recruitHasMore: !!body.data.recruitHasMore,
  };
}

/** 发起第 1 棒。params: { clipId, title, recognitionId, audioBase64 } */
async function createRoom(params) {
  const body = await post('/api/relay/create', params, { showError: false, timeout: 60000 });
  if (!body || !body.success || !body.data) {
    const err = new Error((body && body.error) || '发起接力失败');
    err.body = body || null;
    throw err;
  }
  return mapRoom(body.data.room);
}

/** 接棒压轴（第 3 棒）。params: { roomId, recognitionId, audioBase64 } */
async function joinRoom(params) {
  const body = await post('/api/relay/join', params, { showError: false, timeout: 60000 });
  if (!body || !body.success || !body.data) {
    const err = new Error((body && body.error) || '接棒失败');
    err.body = body || null;
    throw err;
  }
  return mapRoom(body.data.room);
}

/** 点赞（当日幂等）→ { likes, likedByMe } */
async function likeRoom(roomId) {
  const body = await post('/api/relay/like', { roomId }, { showError: false });
  if (!body || !body.success || !body.data) throw new Error((body && body.error) || '点赞失败');
  return body.data;
}

/** 发起人撤销未完成接力 → 房间与棒次删除（评测/连胜保留） */
async function cancelRoom(roomId) {
  const body = await post('/api/relay/cancel', { roomId }, { showError: false });
  if (!body || !body.success) {
    const err = new Error((body && body.error) || '撤销失败');
    err.body = body || null;
    throw err;
  }
  return body;
}

/** 管理员删除接力房/趣味合集（内容治理，不限状态） */
async function adminDeleteRoom(roomId) {
  const body = await post('/api/relay/admin-delete', { roomId }, { showError: false });
  if (!body || !body.success) {
    const err = new Error((body && body.error) || '删除失败');
    err.body = body || null;
    throw err;
  }
  return body;
}

module.exports = { fetchRooms, createRoom, joinRoom, likeRoom, cancelRoom, adminDeleteRoom };
