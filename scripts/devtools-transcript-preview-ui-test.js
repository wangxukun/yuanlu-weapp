/**
 * scripts/devtools-transcript-preview-ui-test.js — 文稿预览弹层/下载门禁 工具级 UI 冒烟（DOWNLOAD-TASK T2.3）
 *
 * 依赖：微信开发者工具 CLI 自动化（automator.launch 自拉起，端口 9420）；
 *       详情页数据走线上 wxkzd.com（公开内容，游客即可）。
 * 运行：node scripts/devtools-transcript-preview-ui-test.js
 *
 * 定位：Node 单测覆盖不到的真实渲染管线——WXML/WXSS 编译、transcript-preview 的
 * wxss @import premium-modal（pm-* 类生效性）、组件挂载/精减后拦截卡结构、
 * 游客门禁交互、premium-modal 本体回归。截图落 test-output/ 供视觉复核。
 * （iOS「文件」App/Android 转发菜单等物理设备项归 T5.3 真机回归，本脚本不覆盖。）
 */

const automator = require("miniprogram-automator");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "../test-output");
// 2026-10-01 取自线上 /api/episode/list 的真实剧集（游客可见公开内容）
const EPISODE_ID = "cmqz8gp9b0hgygxu0dckqrq8q";

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
function section(t) {
  console.log(`\n━━━ ${t} ━━━`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("拉起开发者工具自动化（cli, port 9420）...");
  const mp = await automator.launch({
    cliPath: "D:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat",
    projectPath: "D:\\WebstormProjects\\yuanlu-weapp",
    port: 9420,
    timeout: 150000,
  });
  console.log("已连接");

  /* ---------- 1. 剧集页渲染（游客） ---------- */
  section("一、剧集页渲染（游客态）");
  const page = await mp.reLaunch(`/pages/episode/episode?id=${EPISODE_ID}`);
  await page.waitFor(3000); // 详情 + 相关剧集 + 评论网络往返

  const data = await page.data();
  assert(!!data.episode && data.episode.episodeid === EPISODE_ID, "线上详情加载完成");
  assert(data.isLoggedIn === false, "游客态（未登录）");
  assert(data.isPremium === false, "游客态 isPremium=false");
  assert((await page.$$(".action-box")).length >= 4, "操作区四钮渲染（音频/文稿/收藏/分享）");
  await mp.screenshot({ path: path.join(OUT_DIR, "tp-01-episode-guest.png") });

  /* ---------- 2. 游客门禁（两按钮均不进链路） ---------- */
  section("二、游客门禁");
  await page.callMethod("onTranscript");
  await page.waitFor(300);
  let d = await page.data();
  assert(d.showTranscriptPreview === false && d.showPremiumModal === false, "游客点文稿 → 预览/会员弹窗均不开");
  await page.callMethod("onDownloadAudio");
  await page.waitFor(300);
  d = await page.data();
  assert(d.showPremiumModal === false, "游客点音频 → 会员弹窗不开");
  assert(d.isGeneratingPdf === false, "游客态无 PDF 在途标记");

  /* ---------- 3. 预览弹层渲染（数据注入，等价非会员视觉） ---------- */
  section("三、预览弹层渲染（拦截卡 = premium-modal 场景卡精减版）");
  await page.setData({
    showTranscriptPreview: true,
    transcriptPreview: {
      podcastTitle: "The World Today",
      episodeTitle: "Why is the US ending AIDS funding for South Africa?",
      coverUrl: "",
      subtitles: [
        { textEn: "Hello world, this is a preview line.", textCn: "[SPEAKER_1]: 你好，世界，这是预览行。" },
        { textEn: "Second subtitle goes here.", textCn: "[SPEAKER_2]: 第二句字幕。" },
      ],
      totalSubtitles: 20,
    },
  });
  await page.waitFor(500);
  assert(!!(await page.$(".tp-mask")), "预览弹层挂载（tp-mask）");
  assert(!!(await page.$(".tp-paper")), "PDF 纸张区渲染（tp-paper）");
  const badge = await page.$(".tp-badge-text");
  assert(badge && (await badge.text()) === "文稿预览", "徽标「文稿预览」");
  assert(!!(await page.$(".pm-icon-circle")), "拦截卡图标圆渲染（wxss @import pm-* 类生效）");
  const titleEl = await page.$(".pm-title");
  assert(titleEl && (await titleEl.text()) === "文稿下载是会员专属", "拦截卡标题（精减后文稿语境）");
  assert(!(await page.$(".pm-desc")), "拦截卡描述已去除（wx:if 空值不渲染）");
  const rows = await page.$$(".pm-benefit-row");
  assert(rows.length === 1, "权益仅 1 行（音频无限下载/离线精听已去除）");
  assert((await rows[0].text()).includes("文稿 PDF 下载"), "权益文案 = 文稿 PDF 下载");
  const ctaEl = await page.$(".pm-cta-text");
  assert(ctaEl && (await ctaEl.text()) === "解锁下载", "CTA「解锁下载」");
  const laterEl = await page.$(".pm-later-text");
  assert(laterEl && (await laterEl.text()) === "暂不开通", "次级按钮「暂不开通」");
  const priceEl = await page.$(".pm-price");
  assert(priceEl && (await priceEl.text()) === "¥5/7天起 · 低至 ¥0.46/天", "价格锚点双锚");
  const footerEl = await page.$(".tp-p-footer-text");
  assert(footerEl && (await footerEl.text()).includes("共2页，第 1 页"), "页脚页数公式（total 20 → 2 页）");
  await mp.screenshot({ path: path.join(OUT_DIR, "tp-02-preview-card.png") });

  /* ---------- 4. 空态（预览失败降级） ---------- */
  section("四、空态降级");
  await page.setData({ transcriptPreview: null });
  await page.waitFor(300);
  const emptyEl = await page.$(".tp-p-empty-text");
  assert(emptyEl && (await emptyEl.text()) === "暂无预览数据", "preview=null → 「暂无预览数据」");
  await mp.screenshot({ path: path.join(OUT_DIR, "tp-03-preview-empty.png") });

  /* ---------- 5. premium-modal 本体完整场景（音频触墙回归） ---------- */
  section("五、premium-modal 本体（episode_audio_download 完整场景）");
  await page.setData({ showTranscriptPreview: false, showPremiumModal: true, premiumSource: "episode_audio_download" });
  await page.waitFor(400);
  const pmTitle = await page.$(".pm-title");
  assert(pmTitle && (await pmTitle.text()) === "音频与文稿下载是会员专属", "本体标题完整场景（未受预览精减影响）");
  assert((await page.$$(".pm-benefit-row")).length === 3, "本体三权益完整（音频无限下载/文稿 PDF 下载/离线精听）");
  await mp.screenshot({ path: path.join(OUT_DIR, "tp-04-premium-modal.png") });
  await page.setData({ showPremiumModal: false });

  /* ---------- 汇总 ---------- */
  console.log(`\n════════════════════════════════`);
  console.log(`UI 冒烟通过 ${passed} · 失败 ${failed}`);
  console.log(`截图目录: ${OUT_DIR}`);
  await mp.disconnect();
  if (failed) {
    console.log("失败用例:", failures.join(" | "));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("测试执行失败:", e.message);
  process.exit(2);
});
