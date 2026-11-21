const WIDTH = 600;
const HEIGHT = 820;
const THEMES = [
  { key: 'aurora', label: '极光声波', base: '#062d27', edge: '#15132e', accent: '#6ee7b7', ink: '#fafaf9', muted: '#b8c9c3', card: '#20433e' },
  { key: 'gilded', label: '鎏金荣誉', base: '#301905', edge: '#17120e', accent: '#fcd34d', ink: '#fff8e5', muted: '#d8bf9e', card: '#493016' },
  { key: 'editorial', label: '留白纪实', base: '#f7f2e7', edge: '#e5eee7', accent: '#1f7a5c', ink: '#221f18', muted: '#5e5a50', card: '#fffaf2' },
];

function roundedRect(ctx, x, y, w, h, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawBadgePoster(canvas, themeKey, stats, medals) {
  const theme = THEMES.find((entry) => entry.key === themeKey) || THEMES[0];
  canvas.width = WIDTH * 2;
  canvas.height = HEIGHT * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  bg.addColorStop(0, theme.base);
  bg.addColorStop(1, theme.edge);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.textBaseline = 'middle';

  function text(label, x, y, size, color, bold) {
    ctx.font = (bold ? 'bold ' : '') + size + 'px sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
  }

  text('远路原声 · 学习成就馆', 42, 56, 21, theme.accent, true);
  text('我的学习战报', 42, 116, 47, theme.ink, true);
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 35; i++) {
    const h = 12 + Math.abs(Math.sin(i * 1.31) * Math.cos(i * 0.42)) * 51;
    ctx.beginPath();
    ctx.moveTo(43 + i * 15, 177 - h / 2);
    ctx.lineTo(43 + i * 15, 177 + h / 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const metrics = [
    ['连续学习', stats && stats.streakDays != null ? stats.streakDays + ' 天' : '—'],
    ['生词积累', stats && stats.wordsLearned != null ? stats.wordsLearned + ' 词' : '—'],
    ['发音评测', stats && stats.speechEvalCount != null ? stats.speechEvalCount + ' 次' : '—'],
    ['85 分及以上', stats && stats.speechHighScoreCount != null ? stats.speechHighScoreCount + ' 次' : '—'],
  ];
  metrics.forEach(([label, value], index) => {
    const x = 42 + index % 2 * 264;
    const y = 224 + Math.floor(index / 2) * 112;
    roundedRect(ctx, x, y, 252, 100, 18, theme.card);
    text(label, x + 20, y + 29, 17, theme.muted, false);
    text(value, x + 20, y + 67, 30, theme.ink, true);
  });

  const earned = medals.filter((medal) => medal.unlocked);
  text('已点亮的勋章  ' + earned.length + ' / ' + medals.length, 42, 486, 25, theme.ink, true);
  roundedRect(ctx, 42, 523, 516, 208, 23, theme.card);
  if (!earned.length) text('开始学习，点亮第一枚勋章', 68, 623, 24, theme.muted, false);
  earned.slice(0, 3).forEach((medal, index) => {
    const y = 558 + index * 55;
    text(medal.rank, 68, y, 19, theme.accent, true);
    text(medal.title, 135, y, 24, theme.ink, true);
  });
  if (earned.length > 3) text('另有 ' + (earned.length - 3) + ' 枚已点亮', 68, 706, 17, theme.muted, false);
  text('原声练习 · 记录每一次进步', 42, 775, 20, theme.accent, true);
}

module.exports = { THEMES, drawBadgePoster };
