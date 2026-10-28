/**
 * scripts/test-compliance-redlines.js — 个人主体提审合规红线门禁（RESHAPE-TASK T0.3）
 *
 * 走查范围（动态解析，增删页面/组件自动跟随）：
 *   A. app.json：无 requiredBackgroundModes；标题=远路听说；未注册任何已退役
 *      整集/播客目录页（podcast/episode/search/channel + 暂隐的 favorites/history）
 *   B. 全部已注册页面（app.json pages 解析出的目录，.wxml/.js/.json）与
 *      页面引用的全部组件（usingComponents 传递闭包）：
 *      零「AI」（词边界匹配，类名 btn-ai-text 等小写不误伤）、零「大模型」、
 *      零「智能」、零「播客」（去播客化红线 1）
 *   C. 零退役模块标识：mini-player / player-panel / audioManager / playerStore /
 *      download-manager / transcript-preview（红线 2：整集播放与离线下载退役）
 *   D. 零 /api/comment 调用（红线 4：UGC 评论下线）
 *   E. 订阅权益字典同步口径：utils/plans.js、pages/subscription/agreement.js、
 *      components/premium-modal/index.js 同样过 B/C 字样门禁
 *
 * 运行：node scripts/test-compliance-redlines.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('✗ FAIL: ' + msg);
    process.exit(1);
  }
  passed += 1;
}

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

// ---- A. app.json 全局配置 ----
const app = JSON.parse(read('app.json'));
ok(!('requiredBackgroundModes' in app), 'A app.json 不含 requiredBackgroundModes（后台音频权限退役）');
ok(app.window && app.window.navigationBarTitleText === '远路听说', 'A 全局标题 = 远路听说');

const RETIRED_PAGES = [
  'pages/podcast/podcast',
  'pages/episode/episode',
  'pages/search/search',
  'pages/channel/all/index',
  'pages/channel/index',
  // T5.2 以「精研足迹 / 收藏的微剧场与卡册」重建后再注册
  'pages/library/favorites/index',
  'pages/library/history/index',
];
RETIRED_PAGES.forEach((p) => {
  ok(!app.pages.includes(p), 'A app.json 未注册已退役页 ' + p);
});

// ---- B. 已注册页面 + 组件传递闭包 ----
const compRefs = new Set();
function collectComponents(pageJsonPath) {
  if (!exists(pageJsonPath)) return;
  let conf;
  try {
    conf = JSON.parse(read(pageJsonPath));
  } catch (e) {
    return;
  }
  Object.values(conf.usingComponents || {}).forEach((ref) => {
    const rel = ref.replace(/^\//, '');
    if (!compRefs.has(rel)) {
      compRefs.add(rel);
      // 组件自身 json 还可引用其他组件（递归收口）
      collectComponents(rel + '.json');
    }
  });
}

// 页面/组件条目均为「目录/文件名」完整路径（如 pages/home/index、
// components/vocabulary-modal/index），直接拼扩展名即扫描目标
const scanTargets = [];
app.pages.forEach((p) => {
  scanTargets.push(p);
  collectComponents(p + '.json');
});
compRefs.forEach((rel) => scanTargets.push(rel));

// 字样门禁：AI 词边界（前后均非字母，防 EMAIL/btn-ai-text 误伤）+ 中文敏感词
const FORBIDDEN = [
  { re: /(^|[^A-Za-z])AI([^A-Za-z]|$)/, label: '「AI」字眼' },
  { re: /大模型/, label: '「大模型」字眼' },
  { re: /智能/, label: '「智能」字眼' },
  { re: /播客/, label: '「播客」字眼' },
  { re: /mini-player|player-panel/, label: '整集播放器组件残留' },
  { re: /audioManager|playerStore/, label: '整集播放内核残留' },
  { re: /download-manager/, label: '整集离线下载模块残留' },
  { re: /transcript-preview/, label: '整集文稿预览模块残留' },
  { re: /\/api\/comment/, label: 'UGC 评论接口调用残留' },
];

let scanned = 0;
function scanFile(rel) {
  const src = read(rel);
  scanned += 1;
  // 结构红线：页面/组件 JSON 必须可解析（删注册行留下的悬空尾逗号曾致编译失败）
  if (/\.json$/.test(rel)) {
    try {
      JSON.parse(src);
    } catch (e) {
      console.error('✗ FAIL: ' + rel + ' JSON 解析失败：' + e.message);
      process.exit(1);
    }
  }
  src.split(/\r?\n/).forEach((line, i) => {
    FORBIDDEN.forEach(({ re, label }) => {
      if (re.test(line)) {
        console.error('✗ FAIL: ' + rel + ':' + (i + 1) + ' 含' + label + ' → ' + line.trim().slice(0, 100));
        process.exit(1);
      }
    });
  });
}

Array.from(new Set(scanTargets)).forEach((rel) => {
  ['.wxml', '.js', '.json'].forEach((ext) => {
    if (exists(rel + ext)) scanFile(rel + ext);
  });
});
ok(scanned > 30, 'B/C/D 扫描覆盖已注册页面与组件文件数 > 30（实际 ' + scanned + '）');

// ---- E. 订阅权益与协议口径（虽经页面引用也扫，此处显式兜底防脱离引用链） ----
[
  'utils/plans.js',
  'pages/subscription/agreement.js',
  'components/premium-modal/index.js',
  'utils/wxpay.js',
].forEach((f) => {
  if (exists(f)) scanFile(f);
});

// premium-modal 场景字典：下载门禁场景已随整集链路退役
const premiumSrc = read('components/premium-modal/index.js');
ok(!/'episode_audio_download'/.test(premiumSrc), 'E premium-modal 已移除 episode_audio_download 场景');
ok(premiumSrc.includes('心愿卡册无限定制') || read('utils/plans.js').includes('心愿卡册无限定制'),
  'E 订阅权益含「心愿卡册无限定制」新口径');

console.log('✓ compliance-redlines 全部通过（' + passed + ' 断言 / ' + scanned + ' 文件）');
