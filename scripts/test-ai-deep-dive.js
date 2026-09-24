/**
 * scripts/test-ai-deep-dive.js — AI 精讲本集字号规范测试
 * （2026-09-23 字号体系对齐闪卡 Material3 口径：1sp=2rpx、正文可读下限
 *  28rpx、labelSmall 下限 24rpx，参考 pages/review/vocab-review）
 *
 * 纯静态断言：锁定 dd-* 内容字号不回退（b21cd29 同款教训——小屏真机
 * rpx 整体偏小，字号决策必须显式锁定）。
 *
 * 运行：node scripts/test-ai-deep-dive.js
 */

const fs = require('fs');
const path = require('path');

const wxss = fs.readFileSync(path.join(__dirname, '../components/ai-deep-dive/index.wxss'), 'utf8');
const wxml = fs.readFileSync(path.join(__dirname, '../components/ai-deep-dive/index.wxml'), 'utf8');

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

/** 取指定选择器块内的 font-size（rpx） */
function fontSize(cls) {
  const m = wxss.match(new RegExp('\\.' + cls + '\\s*\\{[^}]*font-size:\\s*(\\d+)rpx'));
  return m ? Number(m[1]) : null;
}

console.log('━━━ AI 精讲字号规范（闪卡 Material3 口径） ━━━');

/* 主干英文：titleLarge 20sp / bodyLarge 16sp */
assert(fontSize('dd-vocab-word') === 40, '主干词汇 40rpx（titleLarge 20sp，text-xl 级）');
assert(fontSize('dd-sentence-text') === 32, '长难句 32rpx（bodyLarge 16sp，text-lg 级）');
assert(fontSize('dd-shadow-text') === 32, '跟读句 32rpx（bodyLarge 16sp）');
assert(fontSize('dd-quiz-question') === 32, '测验题干 32rpx（bodyLarge 16sp）');

/* 音标与层级次文案：闪卡音标 28rpx 正文可读级 */
assert(fontSize('dd-vocab-phonetic') === 28, '音标 28rpx（对齐闪卡背面音标 labelMedium 可读级）');
assert(/\.dd-vocab-phonetic\s*\{[^}]*#9ca3af/.test(wxss), '音标保持浅色（灰 #9ca3af，不与主词抢层级）');

/* 中文释义与解析正文：bodyMedium 14sp / labelMedium 12sp */
assert(fontSize('dd-vocab-meaning') === 32, '中文释义 32rpx（对齐闪卡背面释义 bodyMedium 14sp）');
assert(fontSize('dd-vocab-reason') === 28, '词汇解析 28rpx（正文可读级）');
assert(fontSize('dd-sentence-analysis') === 28, '长难句拆解 28rpx（正文可读级）');
assert(fontSize('dd-quiz-explain-text') === 28, '测验解析 28rpx（正文可读级）');
assert(fontSize('dd-opt-text') === 28, '选项正文 28rpx（正文可读级）');

/* 分类小标题：labelMedium 12sp（眉标级，高于 body 但保持层级差） */
assert(fontSize('dd-section-title') === 26, '分类小标题 26rpx（labelMedium，四区块同步）');

/* 行高：正文 relaxed（1.7），防密集 */
['dd-vocab-meaning', 'dd-vocab-reason', 'dd-sentence-text', 'dd-sentence-analysis', 'dd-quiz-explain-text']
  .forEach((cls) => assert(new RegExp('\\.' + cls + '\\s*\\{[^}]*line-height:\\s*1\\.7').test(wxss), `${cls} 行高 1.7（leading-relaxed）`));

/* 全局下限：内容字号不低于 labelSmall 24rpx（PRO 徽章 18rpx 除外） */
const sizes = [...wxss.matchAll(/font-size:\s*(\d+)rpx/g)].map((m) => Number(m[1]));
assert(sizes.length > 0 && sizes.every((s) => s >= 24 || s === 18), '字号全局下限：≥24rpx（唯一例外 PRO 徽章 18rpx）');
assert(!sizes.includes(22) && !sizes.includes(20), '无 22/20rpx 小屏不可读残留');

/* WXML 结构：四分类标题与主干类名在位 */
['难点词汇预扫', '长难句拆解', '跟读句推荐', '理解测验']
  .forEach((t) => assert(wxml.includes(t), `WXML 含分类标题「${t}」`));
['dd-vocab-word', 'dd-vocab-phonetic', 'dd-sentence-text', 'dd-quiz-question'].forEach((cls) => assert(wxml.includes(cls), `WXML 含主干类名 ${cls}`));

console.log('----------------------------------------');
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 断言`);
} else {
  console.log(`❌ 失败 ${failed} 项：${failures.join('；')}`);
  process.exit(1);
}
