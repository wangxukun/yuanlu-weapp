/**
 * pages/home/leaderboard-mock.js — 排行榜数据层（B工程 api.ts getDailyLeaderboard
 * 客户端兜底逐字移植；yuanlu 后端无 /api/leaderboard/* 路由，B 原型实际也恒走
 * 此兜底——沙箱按 relay-mock 同范式落本地实现，模块级内存态无持久化）
 *
 * 与 B 的两处口径差（迁移注记）：
 * ① me 代表作：B featuredClipId=clip-ted-01 不在 NATIVE_CORPUS（本地
 *    reels-corpus 12 条无此 id；B 兜底是 0.45s/词合成时间戳 + ogg 环境音，
 *    weapp 播不了 ogg），换成 clip-story-05（跟读练习主题句），代表作句与
 *    播放音频同源；
 * ② 其余 7 位成员的 featuredSentence/featuredClipId 与本地语料 1:1 对上
 *    （econ-01/science-02/career-01/business-02/ted-02/nomad-01/story-06），
 *    逐字保留——「挑战同款」按钮可真音频播放。
 *
 * 点赞口径同 B：likedByMe 按日落 wx storage（B localStorage
 * yuanlu_cheered_{date} → studio_cheered_{date}）；likes +1 仅内存乐观
 * 更新（B 同款不落盘，可重复点赞）。
 */
const corpus = require('../discover/reels-corpus');

const ME_CLIP = corpus.find((c) => c.id === 'clip-story-05');

/** B fallbackMembers 逐字段（me 代表作换 clip-story-05，见头部注记①） */
const MEMBERS = [
  {
    id: 'user-elena',
    name: 'Elena · 伦敦精听派',
    avatar: '/assets/avatars/av-photo-1534528741775-53994a69daeb.jpg',
    shadowingCount: 24,
    averageScore: 95,
    streakDays: 42,
    badge: '🏆 原声复刻传奇',
    featuredSentence: 'Consumers rarely evaluate price in isolation; they anchor their expectations on subtle environmental cues.',
    featuredClipId: 'clip-econ-01',
    likes: 128,
    lastActive: '3分钟前',
  },
  {
    id: 'user-marcus',
    name: 'Marcus · 硅谷晨读',
    avatar: '/assets/avatars/av-photo-1507003211169-0a1dd7228f2d.jpg',
    shadowingCount: 19,
    averageScore: 93,
    streakDays: 29,
    badge: '⚡ 连读音律宗师',
    featuredSentence: 'Cognitive neuroscientists emphasize that neuroplasticity enables rapid linguistic adaptation at any age.',
    featuredClipId: 'clip-science-02',
    likes: 96,
    lastActive: '8分钟前',
  },
  {
    id: 'user-chloe',
    name: 'Chloe · 雅思考官控',
    avatar: '/assets/avatars/av-photo-1517841905240-472988babdf9.jpg',
    shadowingCount: 15,
    averageScore: 92,
    streakDays: 21,
    badge: '🌟 弱读节奏达人',
    featuredSentence: 'When navigating complex team dynamics, active listening always bridges the gap between disparate viewpoints.',
    featuredClipId: 'clip-career-01',
    likes: 84,
    lastActive: '12分钟前',
  },
  {
    id: 'user-liam',
    name: 'Liam · 外企面试突击',
    avatar: '/assets/avatars/av-photo-1500648767791-00dcc994a43e.jpg',
    shadowingCount: 11,
    averageScore: 90,
    streakDays: 16,
    badge: '🔥 职场表达先锋',
    featuredSentence: 'Sustainable innovation rarely happens by accident; it stems from rigorous testing and customer empathy.',
    featuredClipId: 'clip-business-02',
    likes: 63,
    lastActive: '19分钟前',
  },
  {
    id: 'user-sophia',
    name: 'Sophia · TED狂热粉',
    avatar: '/assets/avatars/av-photo-1544005313-94ddf0286df2.jpg',
    shadowingCount: 8,
    averageScore: 89,
    streakDays: 14,
    badge: '🎙️ 语调抑扬之星',
    featuredSentence: 'Creative thinking is not a mystical gift; it is a deliberate discipline of mindful observation.',
    featuredClipId: 'clip-ted-02',
    likes: 51,
    lastActive: '25分钟前',
  },
  {
    id: 'user-noah',
    name: 'Noah · 咖啡厅慢听',
    avatar: '/assets/avatars/av-photo-1492562080023-ab3db95bfbce.jpg',
    shadowingCount: 5,
    averageScore: 88,
    streakDays: 9,
    badge: '✨ 晨间开口新秀',
    featuredSentence: 'Digital nomads are revolutionizing the traditional boundaries between career and leisure.',
    featuredClipId: 'clip-nomad-01',
    likes: 39,
    lastActive: '32分钟前',
  },
  {
    id: 'user-ava',
    name: 'Ava · 医疗人文精听',
    avatar: '/assets/avatars/av-photo-1524504388940-b1c1722653e1.jpg',
    shadowingCount: 3,
    averageScore: 87,
    streakDays: 7,
    badge: '🌱 每日打卡新星',
    featuredSentence: 'Genuine empathy requires setting aside our instinctive urge to immediately offer solutions.',
    featuredClipId: 'clip-story-06',
    likes: 27,
    lastActive: '45分钟前',
  },
  {
    id: 'user-me',
    name: '我 · 远路学习者',
    avatar: '/assets/avatars/av-photo-1535713875002-d1d0cf377fde.jpg',
    shadowingCount: 0,
    averageScore: 88,
    streakDays: 12,
    badge: '🚀 进阶冲榜者',
    featuredSentence: ME_CLIP ? ME_CLIP.textEn : '',
    featuredClipId: ME_CLIP ? ME_CLIP.id : '',
    likes: 34,
    lastActive: '刚刚在线',
    isCurrentUser: true,
  },
];

/** 本地时区 YYYY-MM-DD（页面 _todayStr 同款口径，两处共用当日键） */
function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 当日已点赞 id 列表（B getCheeredUsers → wx storage） */
function getCheered(today) {
  try {
    const raw = wx.getStorageSync('studio_cheered_' + today);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

/** 记一次点赞（Set 语义只加不去重，B 同款） */
function markCheered(id) {
  const today = todayStr();
  const list = getCheered(today);
  if (list.indexOf(id) < 0) list.push(id);
  try {
    wx.setStorageSync('studio_cheered_' + today, list);
  } catch (e) {
    /* 存储异常不打断 */
  }
}

/**
 * 组榜（B getDailyLeaderboard 兜底分支逐字：count 降序 → score 降序 →
 * 排名 → myEntry/nextTargetDiff/nextTargetName；firstName 为 WXML 预派生
 * 字段——B 在 JSX 里 name.split(' ')[0]，wxml 无字符串切分能力）。
 */
function build(userCount, userScore) {
  const today = todayStr();
  const cheered = getCheered(today);
  const count = userCount || 0;
  const score = userScore || 88;

  const members = MEMBERS.map((m) =>
    m.id === 'user-me'
      ? Object.assign({}, m, {
          shadowingCount: count,
          averageScore: score,
          badge: count >= 5 ? '⚡ 今日满贯先锋' : '🚀 进阶冲榜者',
        })
      : Object.assign({}, m)
  );
  members.sort((a, b) => b.shadowingCount - a.shadowingCount || b.averageScore - a.averageScore);

  const entries = members.map((m, idx) =>
    Object.assign({}, m, {
      rank: idx + 1,
      likedByMe: cheered.indexOf(m.id) >= 0,
      firstName: m.name.split(' ')[0],
    })
  );
  const myIdx = entries.findIndex((e) => e.isCurrentUser);
  const myEntry = entries[myIdx] || entries[entries.length - 1];
  const nextTargetDiff = myIdx > 0 ? Math.max(1, entries[myIdx - 1].shadowingCount - myEntry.shadowingCount + 1) : 0;
  const nextTargetName = myIdx > 0 ? entries[myIdx - 1].firstName : undefined;

  return {
    date: today,
    totalParticipants: 1428 + count,
    entries,
    myEntry,
    nextTargetDiff,
    nextTargetName,
  };
}

module.exports = { build, markCheered };
