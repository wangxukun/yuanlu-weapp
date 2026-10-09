/**
 * scripts/test-channel-card.js — 频道卡片组件测试（Node 环境，mock Component/wx）
 *
 * 验证目标（严格复刻 Web components/discover/ChannelCard.tsx）：
 *   - formatEpisodeCount 万位缩写（416→"416"；10000→"1万"；12500→"1.3万"）
 *   - 兜底字标缩写 initialsOf（对齐 ui-avatars 前两词首字母规则）
 *   - observers.channel → WXML 就绪派生字段（hasCover/coverError 复位/
 *     showPodcastCount ≥3 阈值/episodeText/podcastCount）
 *   - 封面加载失败 binderror → coverError 本地字标兜底
 *   - 卡片点击 triggerEvent('open', {name})
 *   - WXML/WXSS 静态复刻规格（16:9 封面/眉标 uppercase/单行截断/深色三轨）
 *   - 图标资产 podcasts-ink(-dark).svg 烘焙色
 *
 * 运行：node scripts/test-channel-card.js
 */

const fs = require('fs');
const path = require('path');

/* ==================== mock 基础设施 ==================== */

global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  showToast: () => {},
  navigateTo: () => {},
};

let componentDef = null;
global.Component = (cfg) => {
  componentDef = cfg;
};

require(path.join(__dirname, '../components/common/channel-card/index.js'));

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

function makeInstance() {
  const inst = {
    data: JSON.parse(JSON.stringify(componentDef.data)),
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail) {
      this._events = this._events || [];
      this._events.push({ name, detail });
    },
  };
  Object.assign(inst, componentDef.methods);
  return inst;
}

function fireChannel(inst, channel) {
  componentDef.observers.channel.call(inst, channel);
}

/* ==================== 用例 ==================== */

section('一、formatEpisodeCount 万位缩写（Web 同源规则）');
{
  const format = (n) => {
    const inst = makeInstance();
    fireChannel(inst, { name: 'X', episodeCount: n });
    return inst.data.episodeText;
  };
  assert(format(0) === '0', '0 集 → "0"');
  assert(format(416) === '416', '416 集 → "416"（不缩写）');
  assert(format(9999) === '9999', '9999 → "9999"（万位以下原样）');
  assert(format(10000) === '1万', '10000 → "1万"（.0 尾巴剥除）');
  assert(format(12500) === '1.3万', '12500 → "1.3万"（一位小数）');
  assert(format(158400) === '15.8万', '158400 → "15.8万"');
}

section('二、initialsOf 兜底字标（对齐 ui-avatars 前两词首字母）');
{
  const initialOf = (name) => {
    const inst = makeInstance();
    fireChannel(inst, { name });
    return inst.data.initial;
  };
  assert(initialOf('BBC Learning English') === 'BL', 'BBC Learning English → "BL"（前两词首字母）');
  assert(initialOf('CNN') === 'C', 'CNN → "C"（单词取一首字母）');
  assert(initialOf('NHK World') === 'NW', 'NHK World → "NW"');
  assert(initialOf('') === '', '空名 → ""（不抛错）');
}

section('三、observers.channel 派生字段（WXML 零方法调用红线）');
{
  const inst = makeInstance();
  fireChannel(inst, {
    name: 'BBC Learning English',
    coverUrl: 'https://oss/signed-banner.jpg',
    podcastCount: 9,
    episodeCount: 416,
  });
  assert(inst.data.name === 'BBC Learning English', 'name 透传');
  assert(inst.data.hasCover === true && inst.data.coverUrl === 'https://oss/signed-banner.jpg', '有封面 → hasCover + coverUrl');
  assert(inst.data.coverError === false, '换频道后 coverError 复位');
  assert(inst.data.showPodcastCount === true && inst.data.podcastCount === 9, 'podcastCount=9 ≥3 → 展示档数');

  // default_cover_url 哨兵 → 本地品牌色字标兜底（Web hasCover 同款判定）
  fireChannel(inst, { name: 'CNN', coverUrl: 'default_cover_url', podcastCount: 2, episodeCount: 30 });
  assert(inst.data.hasCover === false && inst.data.coverUrl === '', 'default_cover_url → hasCover=false（字标兜底）');
  assert(inst.data.showPodcastCount === false, 'podcastCount=2 <3 → 不展示档数（Web 观感口径）');
  assert(inst.data.episodeText === '30', 'episodeCount=30 → "30"');

  // 空值防御
  fireChannel(inst, {});
  assert(inst.data.name === '' && inst.data.episodeText === '0' && inst.data.showPodcastCount === false, '空对象 → 全兜底不抛错');
}

section('四、封面加载失败 binderror → 字标兜底');
{
  const inst = makeInstance();
  fireChannel(inst, { name: 'CNN', coverUrl: 'https://oss/expired.jpg' });
  inst._onCoverError();
  assert(inst.data.coverError === true, '有 coverUrl 时 binderror → coverError=true（WXML 切字标）');

  const inst2 = makeInstance();
  fireChannel(inst2, { name: 'CNN', coverUrl: '' });
  inst2._onCoverError();
  assert(inst2.data.coverError === false, '无 coverUrl 时误报不翻转（字标本就在展示）');
}

section('五、卡片点击 open 事件');
{
  const inst = makeInstance();
  fireChannel(inst, { name: 'BBC News & Sport', coverUrl: 'x' });
  inst._onTap();
  assert(
    inst._events.length === 1 && inst._events[0].name === 'open' && inst._events[0].detail.name === 'BBC News & Sport',
    'triggerEvent("open", {name})（页面侧 encodeURIComponent 深链）'
  );
}

section('六、WXML/WXSS 复刻规格（Web ChannelCard.tsx）');
{
  const wxml = fs.readFileSync(path.join(__dirname, '../components/common/channel-card/index.wxml'), 'utf8');
  [
    'cc-card', 'cc-cover', 'cc-cover-img', 'mode="aspectFill"', 'binderror="_onCoverError"',
    'cc-cover-fallback', 'cc-cover-initial',
    '频道 Channel', 'cc-label', 'cc-name', 'cc-meta', 'cc-meta-icon', 'cc-meta-text', 'cc-meta-dot',
    'podcasts-ink-dark.svg', 'podcasts-ink.svg',
    'wx:if="{{showPodcastCount}}"', '{{episodeText}} 集', '{{podcastCount}} 档节目',
    'bindtap="_onTap"', '{{themeClass}}',
  ].forEach((frag) => assert(wxml.includes(frag), `WXML 含 ${frag}`));

  const wxss = fs.readFileSync(path.join(__dirname, '../components/common/channel-card/index.wxss'), 'utf8');
  assert(wxss.includes('padding-bottom: 56.25%'), '封面 aspect-[16/9]（16:9 比例底垫）');
  assert(wxss.includes('background-color: var(--primary-50)'), '卡底 bg-primary-50（随主题令牌翻转）');
  assert(wxss.includes('border-radius: 24rpx'), '圆角 rounded-xl=12dp');
  assert(wxss.includes('border: 2rpx solid var(--cc-border)') && wxss.includes('rgba(213, 237, 225, 0.7)'), '描边 primary-100/70');
  assert(wxss.includes('background-color: var(--ink-200)'), '封面底垫 bg-base-200→ink-200');
  assert(wxss.includes('text-transform: uppercase') && wxss.includes('font-size: 20rpx') && wxss.includes('letter-spacing: 2rpx'), '眉标 10px bold uppercase tracking-widest');
  assert(wxss.includes('color: var(--color-primary)'), '眉标/品牌色走主题令牌（深色=primary-400）');
  assert(wxss.includes('font-size: 32rpx') && wxss.includes('text-overflow: ellipsis'), '频道名 16sp bold 单行截断（line-clamp-1）');
  assert(wxss.includes('font-size: 24rpx') && wxss.includes('color: var(--ink-500)'), '集数行 12sp ink-500');
  assert(wxss.includes('width: 28rpx') && wxss.includes('height: 28rpx'), '天线图标 14px');
  assert(wxss.includes('border-radius: 50%') && wxss.includes('background-color: var(--ink-300)'), '分隔圆点 bg-ink-300');
  assert(wxss.includes('background-color: #1f7a5c'), '字标兜底品牌底 #1F7A5C（ui-avatars 同色，不随主题）');
  assert(wxss.includes('padding: 32rpx'), '信息区 p-4=16dp');
  // 深色三轨（媒体查询排除 .theme-light + .theme-dark/.theme-light 全量重声明）
  assert(wxss.includes('@media (prefers-color-scheme: dark)') && wxss.includes('.cc-card:not(.theme-light)'), '深色三轨：媒体查询跟随系统（排除手动浅色）');
  assert(wxss.includes('.cc-card.theme-dark') && wxss.includes('.cc-card.theme-light'), '深色三轨：手动深/浅类全量重声明');

  // 图标烘焙色（台账 Android-Meterial.md 第十三批）
  const svgLight = fs.readFileSync(path.join(__dirname, '../assets/icons/podcasts-ink.svg'), 'utf8');
  const svgDark = fs.readFileSync(path.join(__dirname, '../assets/icons/podcasts-ink-dark.svg'), 'utf8');
  assert(svgLight.includes('fill="#857c68"') && svgLight.includes('viewBox="0 0 24 24"'), 'podcasts-ink.svg = #857c68（ink-500）');
  assert(svgDark.includes('fill="#a8a29e"') && svgDark.includes('viewBox="0 0 24 24"'), 'podcasts-ink-dark.svg = #a8a29e（深色 ink-500）');
}

/* ==================== 汇总 ==================== */

console.log(`\n========== 频道卡片测试：${passed} 通过 / ${failed} 失败 ==========`);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
