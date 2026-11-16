/**
 * pages/home/relay-mock.js — 跟读接力数据层（B工程 server.ts /api/relay/* 逐字移植）
 *
 * 四操作（与 B 服务端同构，模块级内存态——B RELAY_ROOMS_STATE 同款，
 * 小程序冷启动重置；沙箱注记：迁移 yuanlu-weapp 时换真实社交后端）：
 *   listRooms()              → 全量房间（含初始两间：招募中 1 + 已完成 1）
 *   createRoom(clip, t, s)   → 发起：以 clip 为第 1 棒，系统配 2 位语伴自动
 *                              接力并生成趣味合集（B /api/relay/create）
 *   joinRoom(roomId, s)      → 接棒压轴：第 n 棒 + 标记完成 + 合成合集
 *                              （B /api/relay/join）
 *   likeRoom(roomId)         → 点赞 +1（B /api/relay/like）
 *
 * 段（segment）音频字段与页面 _prepareAudio 协议对齐：本地语伴段
 * real:false + clipAudioUrl=整轨直链；由真实切片发起的第 1 棒保留
 * real/clipAudioUrl/clipOffset/duration，走网关懒取。
 */
const corpus = require('../discover/reels-corpus');

const AV = {
  me: '/assets/avatars/av-photo-1535713875002-d1d0cf377fde.jpg',
  elena: '/assets/avatars/av-photo-1534528741775-53994a69daeb.jpg',
  marcus: '/assets/avatars/av-photo-1507003211169-0a1dd7228f2d.jpg',
  chloe: '/assets/avatars/av-photo-1517841905240-472988babdf9.jpg',
  liam: '/assets/avatars/av-photo-1500648767791-00dcc994a43e.jpg',
  sophia: '/assets/avatars/av-photo-1544005313-94ddf0286df2.jpg',
  noah: '/assets/avatars/av-photo-1492562080023-ab3db95bfbce.jpg',
};

/** 本地语料段（整轨窗口，与 _prepareAudio 的 local 分支对齐） */
function localSeg(c, stepOrder, speakerName, avatar, voiceStyle, score, recordedAt, isMe) {
  return {
    id: 'seg-' + Math.random().toString(36).slice(2, 10),
    stepOrder,
    speakerName,
    speakerAvatar: avatar,
    voiceStyle,
    textEn: c.textEn,
    textCn: c.textCn,
    audioUrl: c.audioUrl,
    start: c.start,
    end: c.end,
    words: c.words,
    score,
    recordedAt,
    isCurrentUser: !!isMe,
    real: false,
    clipAudioUrl: c.audioUrl,
  };
}

/** 初始两间房（B RELAY_ROOMS_STATE 逐字段） */
function buildInitialRooms() {
  return [
    {
      id: 'relay-room-01',
      title: '硅谷咖啡厅奇遇：数字游民的跨界对话',
      topic: '现代生活 · 职场哲学',
      difficulty: 'B2',
      coverUrl: '/assets/avatars/av-photo-1522202176988-66273c2fd55f.jpg',
      initiatorName: 'Elena · 伦敦精听派',
      initiatorAvatar: AV.elena,
      targetSteps: 3,
      status: 'recruiting',
      likes: 86,
      invitedUsers: [
        { name: 'Elena · 伦敦精听派', avatar: AV.elena, status: 'joined' },
        { name: 'Marcus · 硅谷晨读', avatar: AV.marcus, status: 'joined' },
        { name: '我 · 远路学习者 (受邀接棒)', avatar: AV.me, status: 'invited' },
      ],
      segments: [
        localSeg(corpus[5], 1, 'Elena · 伦敦精听派', AV.elena, '🎙️ 英伦知性播音腔', 95, '10分钟前'),
        localSeg(corpus[7], 2, 'Marcus · 硅谷晨读', AV.marcus, '⚡ 美式阳光快节奏', 93, '4分钟前'),
      ],
      nextPromptSegment: {
        textEn: corpus[8].textEn,
        textCn: corpus[8].textCn,
        phoneticTip: corpus[8].phoneticTip,
        audioUrl: corpus[8].audioUrl,
        start: corpus[8].start,
        end: corpus[8].end,
        words: corpus[8].words,
      },
      compilation: null,
    },
    {
      id: 'relay-room-02',
      title: '大脑潜能与商业决策三部曲',
      topic: '认知科学 · 商业心理',
      difficulty: 'C1',
      coverUrl: '/assets/avatars/av-photo-1507668077129-56e32842fceb.jpg',
      initiatorName: 'Chloe · 雅思考官控',
      initiatorAvatar: AV.chloe,
      targetSteps: 3,
      status: 'completed',
      likes: 142,
      invitedUsers: [
        { name: 'Chloe · 雅思考官控', avatar: AV.chloe, status: 'joined' },
        { name: 'Liam · 外企面试突击', avatar: AV.liam, status: 'joined' },
        { name: 'Sophia · TED狂热粉', avatar: AV.sophia, status: 'joined' },
      ],
      segments: [
        localSeg(corpus[10], 1, 'Chloe · 雅思考官控', AV.chloe, '🌟 学术严谨女声', 94, '35分钟前'),
        localSeg(corpus[6], 2, 'Liam · 外企面试突击', AV.liam, '💼 华尔街沉稳低音', 91, '28分钟前'),
        localSeg(corpus[11], 3, 'Sophia · TED狂热粉', AV.sophia, '🎭 感染力演讲腔', 93, '20分钟前'),
      ],
      nextPromptSegment: null,
      compilation: {
        compilationTitle: '🎬 《从神经可塑性到商业破局》三人跨界节目合集',
        chemistryScore: 97,
        vibeBadge: '🔥 殿堂级丝滑转场',
        aiDirectorComment:
          'Chloe 的学术起承极具悬念，Liam 用浑厚的商务重音稳稳接住价格锚定理论，最后 Sophia 以富有感染力的上扬语调收尾，三人宛如坐在同一间 BBC 录音室！',
        totalDuration: 18,
        generatedAt: '20分钟前',
      },
    },
  ];
}

let rooms = buildInitialRooms();

function listRooms() {
  // isDemo：未登录兜底演示房标识（前端据此显示「演示数据」，防假分误解）
  return rooms.map((r) => Object.assign({}, r, { isDemo: true }));
}

/** 发起接力（B /api/relay/create 逐字；starter 为完整切片对象而非仅 id） */
function createRoom(starterClip, customTitle, score) {
  const userScore = typeof score === 'number' ? score : Math.floor(90 + Math.random() * 8);
  const title = (customTitle || '').trim() || '原声接力：' + (starterClip.topic || '原声') + '漫谈';

  // 语伴选料（B：同主题优先，兜底 [2]/[4]；本地语伴恒走整轨直链）
  const partner1Clip =
    corpus.find((c) => c.id !== starterClip.id && c.topic === starterClip.topic) || corpus[2];
  const partner2Clip =
    corpus.find((c) => c.id !== starterClip.id && c.id !== partner1Clip.id) || corpus[4];

  const firstSeg = {
    id: 'seg-' + Date.now() + '-1',
    stepOrder: 1,
    speakerName: '我 · 远路学习者 (第1棒发起)',
    speakerAvatar: AV.me,
    voiceStyle: '🔥 领航主理人声线',
    textEn: starterClip.textEn,
    textCn: starterClip.textCn,
    audioUrl: starterClip.clipAudioUrl || starterClip.audioUrl || '',
    start: starterClip.start != null ? starterClip.start : 0,
    end: starterClip.end != null ? starterClip.end : (starterClip.duration || 6),
    words: starterClip.words || [],
    score: userScore,
    recordedAt: '刚刚发起',
    isCurrentUser: true,
    real: !!starterClip.real,
    clipAudioUrl: starterClip.clipAudioUrl || starterClip.audioUrl || null,
    clipOffset: starterClip.clipOffset || starterClip.audioOffset || 0,
    duration: starterClip.duration || null,
  };

  const newRoom = {
    id: 'relay-room-' + Date.now(),
    title,
    topic: starterClip.topic || '原声口语',
    difficulty: starterClip.difficulty || 'B2',
    coverUrl: starterClip.coverUrl || '',
    initiatorName: '我 · 远路学习者',
    initiatorAvatar: AV.me,
    targetSteps: 3,
    status: 'completed',
    likes: 12,
    invitedUsers: [
      { name: '我 · 远路学习者 (发起人)', avatar: AV.me, status: 'joined' },
      { name: 'Elena · 伦敦精听派 (已响应)', avatar: AV.elena, status: 'joined' },
      { name: 'Noah · 咖啡厅慢听 (已响应)', avatar: AV.noah, status: 'joined' },
    ],
    segments: [
      firstSeg,
      localSeg(partner1Clip, 2, 'Elena · 伦敦精听派 (受邀第2棒)', AV.elena, '🎙️ 英伦优雅共鸣腔', 94, '闪电接棒'),
      localSeg(partner2Clip, 3, 'Noah · 咖啡厅慢听 (受邀第3棒)', AV.noah, '☕ 温暖叙事收尾腔', 91, '闪电接棒'),
    ],
    nextPromptSegment: null,
    compilation: {
      compilationTitle: '🎬 《' + title + '》语伴共创趣味合集',
      chemistryScore: 99,
      vibeBadge: '✨ 灵魂共鸣节目秀',
      aiDirectorComment:
        '由你发起的首棒录音（' + userScore + '分）瞬间点燃了话题张力！系统邀请的语伴 Elena 与 Noah 紧随其后完成了二、三棒口语接力，三种声线层层递进，合成了一段堪比真实广播剧的趣味英语合集！',
      totalDuration: 16,
      generatedAt: '刚刚生成',
    },
  };

  rooms.unshift(newRoom);
  return { room: newRoom, rooms };
}

/** 接棒压轴（B /api/relay/join 逐字） */
function joinRoom(roomId, score) {
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const promptSeg = room.nextPromptSegment || corpus[8];
  const userScore = typeof score === 'number' ? score : Math.floor(89 + Math.random() * 9);

  const newSegment = {
    id: 'seg-' + Date.now(),
    stepOrder: room.segments.length + 1,
    speakerName: '我 · 远路学习者',
    speakerAvatar: AV.me,
    voiceStyle: '🚀 自信连读压轴腔',
    textEn: promptSeg.textEn,
    textCn: promptSeg.textCn,
    audioUrl: promptSeg.audioUrl,
    start: promptSeg.start,
    end: promptSeg.end,
    words: promptSeg.words,
    score: userScore,
    recordedAt: '刚刚接棒',
    isCurrentUser: true,
    real: false,
    clipAudioUrl: promptSeg.audioUrl,
  };

  room.segments.push(newSegment);
  room.status = 'completed';
  room.nextPromptSegment = null;
  room.invitedUsers = room.invitedUsers.map((u) =>
    u.status === 'invited' ? Object.assign({}, u, { status: 'joined' }) : u
  );
  room.compilation = {
    compilationTitle: '🎬 《' + room.title + '》跨时空三人接力合集',
    chemistryScore: 98,
    vibeBadge: '🏆 天衣无缝合拍王',
    aiDirectorComment:
      'Elena 与 Marcus 铺垫了极具思辨感的开场，你的第 ' + newSegment.stepOrder +
      ' 棒压轴跟读不仅连读自然饱满（' + userScore + '分），更在尾音收束上与前两位形成了完美的节目对话闭环！',
    totalDuration: 17,
    generatedAt: '刚刚生成',
  };

  return { room, rooms };
}

/** 点赞（B /api/relay/like：+1 并回全量） */
function likeRoom(roomId) {
  const room = rooms.find((r) => r.id === roomId);
  if (room) room.likes += 1;
  return rooms;
}

module.exports = { listRooms, createRoom, joinRoom, likeRoom };
