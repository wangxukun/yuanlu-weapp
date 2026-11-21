const FILTERS = [
  { key: 'all', label: '全部勋章' },
  { key: 'streak', label: '学习连胜' },
  { key: 'vocab', label: '词汇积累' },
  { key: 'pronunciation', label: '发音评测' },
];

const ICON = '/assets/icons/';
const DESIGNS = {
  flame: { color: 'amber', rarity: 'SSR 传奇流光', icon: 'local-fire-department-accent.svg' },
  book: { color: 'jade', rarity: 'SR 翡翠炫光', icon: 'menu-book-onsurface.svg' },
  mic: { color: 'violet', rarity: 'SSR 极光全息', icon: 'mic-ink.svg' },
  spark: { color: 'rose', rarity: 'SR 玫瑰流金', icon: 'auto-awesome.svg' },
  star: { color: 'teal', rarity: 'SR 翡翠炫光', icon: 'workspace-premium-amber.svg' },
  trophy: { color: 'gold', rarity: 'SSR 传奇流光', icon: 'emoji-events-gold.svg' },
};

// 沿用服务端已有勋章和历史解锁记录。精选卡依照参考版的六种配色陈列。
const FEATURED = ['STREAK_7', 'VOCAB_50', 'SPEECH_GREAT_10', 'SPEECH_50', 'VOCAB_500', 'STREAK_30'];
const FEATURED_DESIGNS = ['flame', 'book', 'mic', 'spark', 'star', 'trophy'];
const RULES = [
  { key: /^STREAK_(\d+)$/, kind: 'streak', label: '连续学习', field: 'streakDays', unit: '天', design: 'flame' },
  { key: /^VOCAB_(\d+)$/, kind: 'vocab', label: '已积累生词', field: 'wordsLearned', unit: '词', design: 'book' },
  { key: /^SPEECH_GREAT_(\d+)$/, kind: 'pronunciation', label: '85 分及以上', field: 'speechHighScoreCount', unit: '次', design: 'mic' },
  { key: /^SPEECH_(\d+)$/, kind: 'pronunciation', label: '完成发音评测', field: 'speechEvalCount', unit: '次', design: 'spark' },
  { key: /^LISTEN_(\d+)H$/, kind: 'other', label: '累计收听', field: 'totalHours', unit: '小时', design: 'trophy' },
];

function buildMedals(items, stats) {
  return items.map((item) => {
    const order = FEATURED.indexOf(item.key);
    const rule = RULES.find((candidate) => candidate.key.test(item.key));
    const design = DESIGNS[FEATURED_DESIGNS[order] || (rule ? rule.design : 'star')];
    const current = rule && stats && stats[rule.field] != null ? Math.max(0, Number(stats[rule.field]) || 0) : null;
    const target = rule ? Number(item.key.match(rule.key)[1]) : 0;
    const percent = item.unlocked ? 100 : current == null ? 0 : Math.min(100, Math.floor(current / target * 100));
    const earnedDate = (item.unlockedAt || '').match(/^\d{4}-\d{2}-\d{2}/);
    return {
      id: item.key,
      title: item.name,
      description: item.description,
      dimension: rule ? rule.kind : 'other',
      dimensionLabel: rule ? rule.label : '活跃成就',
      color: design.color,
      rarity: design.rarity,
      rank: design.rarity.split(' ')[0],
      icon: ICON + design.icon,
      unlocked: item.unlocked,
      progress: percent,
      progressText: current == null ? '' : current + ' / ' + target + ' ' + rule.unit,
      metric: current == null ? '' : rule.label + ' ' + current + ' ' + rule.unit,
      status: item.unlocked ? (earnedDate ? '已点亮 · ' + earnedDate[0] : '已点亮') : '全息流光预览',
      order: order < 0 ? FEATURED.length : order,
    };
  }).sort((a, b) => a.order - b.order);
}

function showMedals(medals, dimension, selectedId) {
  const shownMedals = dimension === 'all' ? medals : medals.filter((medal) => medal.dimension === dimension);
  return {
    shownMedals,
    selectedMedal: shownMedals.find((medal) => medal.id === selectedId) || shownMedals[0] || null,
  };
}

module.exports = { FILTERS, buildMedals, showMedals };
