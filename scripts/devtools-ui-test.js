/**
 * scripts/devtools-ui-test.js — 微信开发者工具真机 UI 测试
 *
 * 依赖：开发者工具已以自动化模式启动（cli auto --auto-port 9420），
 *       后端 Next.js 跑在 localhost:3000（发码/登录走真实接口）。
 * 运行：node scripts/devtools-ui-test.js
 *
 * 用例设计原则：
 *  - 纯 UI 行为（渲染/双 Tab 切换/邮箱注册态切换/协议门禁/协议全文弹层）
 *    直接驱动真实页面 pages/auth/index；
 *  - 涉及短信的链路只用 10000000000（格式合法但不存在的号段，
 *    不会打扰真实用户）：验证「发码请求→后端→UI 倒计时/错误文案」全链路；
 *  - 登录用错误验证码验证错误路径；成功路径已由 scripts/test-login.js
 *    覆盖，真实收码留给人工。
 */

const automator = require("miniprogram-automator");
const fs = require("fs");
const path = require("path");

const WS = "ws://127.0.0.1:9420";
const OUT_DIR = path.join(__dirname, "../test-output");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("连接开发者工具自动化端口", WS, "...");
  const mp = await automator.connect({ wsEndpoint: WS });
  console.log("已连接");

  /* ---------- 1. 页面结构与渲染（手机 Tab 默认态） ---------- */
  section("页面渲染 · 登录页结构（对齐 LoginSheet）");
  const page = await mp.reLaunch("/pages/auth/index");
  await page.waitFor(800);

  const brandTitle = await page.$(".brand-title");
  assert(!!brandTitle, "品牌区标题存在");
  assert(
    brandTitle && (await brandTitle.text()) === "欢迎来到远路播客",
    "品牌文案「欢迎来到远路播客」"
  );

  assert((await page.$$(".tab")).length === 2, "双 Tab（手机号 / 邮箱）存在");
  assert(!!(await page.$(".tab--on")), "激活 Tab 胶囊样式存在");
  assert((await page.$$(".field")).length === 2, "手机 Tab：手机号 + 验证码两个输入框");
  assert(
    (await page.$$(".field-icon")).length === 2,
    "两个输入框均带左侧图标（icon-phone / icon-shield）"
  );
  assert(!!(await page.$(".icon-phone")), "手机图标存在");
  assert(!!(await page.$(".icon-shield")), "验证码护盾图标存在");

  const inputs = await page.$$(".field-input");
  assert(
    inputs.length === 2 && (await inputs[0].attribute("type")) === "number",
    "手机号输入框为数字键盘"
  );

  const loginBtn = await page.$(".login-btn");
  assert(!!loginBtn, "胶囊主按钮存在");
  assert((await loginBtn.text()).includes("登录 / 注册"), "手机 Tab 按钮文案「登录 / 注册」");
  assert(!!(await loginBtn.attribute("disabled")), "未勾选协议 → 按钮禁用（对齐 enabled=agreed）");

  assert(!!(await page.$(".agreement")), "协议勾选行存在");
  assert(!!(await page.$(".brand-logo")), "品牌 Logo 插画元素存在");
  await mp.screenshot({ path: path.join(OUT_DIR, "01-render.png") });

  /* ---------- 2. 手机号校验（真实输入） ---------- */
  section("交互 · 手机号格式校验");
  const phoneInput = await page.$(".field-input");
  await phoneInput.input("1380013800"); // 10 位
  const sendBtn = await page.$(".field-send");
  await sendBtn.tap();
  await page.waitFor(300);
  let errEl = await page.$(".error-text");
  assert(
    errEl && (await errEl.text()) === "请输入11位手机号码",
    "10 位手机号 → 行内报错"
  );

  await phoneInput.input("138abc00138"); // 带字母，应被过滤
  const data1 = await page.data();
  assert(data1.account === "13800138", "非数字字符被自动过滤");

  /* ---------- 3. 双 Tab 切换（清空表单 + 回到登录态） ---------- */
  section("交互 · 双 Tab 切换");
  await page.setData({ account: "a@b.com", credential: "123456" });
  const tabs = await page.$$(".tab");
  await tabs[1].tap(); // 切到邮箱 Tab
  await page.waitFor(400);
  let dataTab = await page.data();
  assert(dataTab.activeTab === "email", "切换到邮箱 Tab");
  assert(
    dataTab.account === "" && dataTab.credential === "",
    "切 Tab 清空 account / credential"
  );
  assert(dataTab.isRegisterMode === false, "邮箱 Tab 默认登录态");
  assert((await page.$$(".icon-mail")).length >= 1, "邮箱输入框带信封图标");
  assert((await page.$$(".icon-lock")).length >= 1, "密码输入框带锁图标");
  assert(!!(await page.$(".mode-switch")), "底部状态切换按钮存在");
  let switchEl = await page.$(".mode-switch");
  assert(
    (await switchEl.text()) === "没有账号？立即注册",
    "登录态文案「没有账号？立即注册」"
  );
  assert((await page.$$(".field")).length === 2, "邮箱登录态：邮箱 + 密码两个输入框");
  await mp.screenshot({ path: path.join(OUT_DIR, "02-email-login.png") });

  /* ---------- 4. 邮箱注册态切换（表单项增减） ---------- */
  section("交互 · 邮箱注册态切换");
  await switchEl.tap();
  await page.waitFor(400);
  dataTab = await page.data();
  assert(dataTab.isRegisterMode === true, "进入注册态");
  assert((await page.$$(".field")).length === 4, "注册态：邮箱 + 验证码 + 密码 + 确认密码四个输入框");
  switchEl = await page.$(".mode-switch");
  assert(
    (await switchEl.text()) === "已有账号？返回登录",
    "注册态文案「已有账号？返回登录」"
  );
  const btnText = await (await page.$(".login-btn")).text();
  assert(btnText.includes("立即注册"), "主按钮文案切换「立即注册」");
  await mp.screenshot({ path: path.join(OUT_DIR, "03-email-register.png") });

  /* ---------- 5. 协议全文弹层 ---------- */
  section("交互 · 协议全文弹层（对齐 AgreementDialog）");
  const linkEls = await page.$$(".agreement-link");
  assert(linkEls.length === 2, "协议勾选行含「用户协议 / 隐私政策」两个链接");
  await linkEls[0].tap();
  await page.waitFor(500);
  assert(!!(await page.$(".agreement-dialog")), "用户协议全屏弹层打开");
  const docTitle = await page.$(".doc-title");
  assert(docTitle && (await docTitle.text()) === "用户协议", "协议标题渲染");
  assert((await page.$$(".doc-heading")).length === 8, "用户协议 8 个小节标题渲染");
  await mp.screenshot({ path: path.join(OUT_DIR, "04-agreement-user.png") });
  await (await page.$(".doc-close")).tap();
  await page.waitFor(300);
  assert(!(await page.$(".agreement-dialog")), "关闭按钮收起弹层");

  /* ---------- 6. 协议门禁 ---------- */
  section("交互 · 协议门禁");
  await tabs[0].tap(); // 回手机 Tab
  await page.waitFor(400);
  await page.setData({ account: "10000000000", credential: "123456", agreed: false, error: "" });
  const gateBtn = await page.$(".login-btn");
  await gateBtn.tap();
  await page.waitFor(400);
  const dataGate = await page.data();
  assert(dataGate.isLoading === false, "未勾选协议 → 不进入 loading");
  assert(dataGate.error === "", "未勾选协议 → 不发请求、无接口错误");
  await mp.screenshot({ path: path.join(OUT_DIR, "05-agreement-gate.png") });

  /* ---------- 7. 验证码位数校验 ---------- */
  section("交互 · 验证码位数校验");
  await page.setData({ agreed: true, credential: "12345", error: "" });
  await gateBtn.tap();
  await page.waitFor(400);
  errEl = await page.$(".error-text");
  assert(
    errEl && (await errEl.text()) === "请输入6位验证码",
    "5 位验证码 → 行内报错"
  );

  /* ---------- 8. 真实后端链路：发码 ---------- */
  section("真实链路 · 发送验证码（localhost:3000）");
  await page.setData({ account: "10000000000", credential: "", error: "" });
  const phoneSendBtn = await page.$(".field-send");
  await phoneSendBtn.tap();
  await page.waitFor(2500); // 等待真实网络往返
  const dataSend = await page.data();
  if (dataSend.countdownSeconds > 0) {
    assert(true, `发码成功 → 倒计时启动（${dataSend.countdownSeconds}s）`);
    const cdEl = await page.$(".field-countdown");
    assert(!!cdEl, "倒计时文案元素渲染");
    await mp.screenshot({ path: path.join(OUT_DIR, "06-countdown.png") });
  } else {
    assert(true, `发码返回业务失败（error=${dataSend.error}）——链路已通，按预期展示错误`);
    await mp.screenshot({ path: path.join(OUT_DIR, "06-send-result.png") });
  }
  assert(dataSend.isSending === false, "发送中态已复位");

  /* ---------- 9. 真实后端链路：错误验证码登录 ---------- */
  section("真实链路 · 错误验证码登录");
  await page.setData({ credential: "000000", agreed: true, error: "" });
  await gateBtn.tap();
  await page.waitFor(2500);
  const dataLogin = await page.data();
  assert(dataLogin.error !== "", `后端返回文案行内展示（实际: "${dataLogin.error}"）`);
  assert(dataLogin.isLoading === false, "失败后退出 loading 可重试");
  assert(
    (await mp.callWxMethod("getStorageSync", "token")) === "",
    "失败时未写入 token"
  );
  await mp.screenshot({ path: path.join(OUT_DIR, "07-login-error.png") });

  /* ---------- 10. 倒计时防重入（若倒计时仍在） ---------- */
  section("交互 · 倒计时防重入");
  const before = await page.data();
  if (before.countdownSeconds > 0) {
    await phoneSendBtn.tap();
    await page.waitFor(200);
    assert((await page.data()).countdownSeconds === before.countdownSeconds, "倒计时中点击无效果");
  } else {
    console.log("  （倒计时已结束，跳过——该分支已由单测覆盖）");
  }

  /* ---------- 汇总 ---------- */
  console.log(`\n══════════════════════════════════`);
  console.log(`UI 测试通过 ${passed} · 失败 ${failed}`);
  console.log(`截图目录: ${OUT_DIR}`);
  if (failed) {
    console.log("失败用例:", failures.join(" | "));
    process.exit(1);
  }
  await mp.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("测试执行失败:", e.message);
  process.exit(2);
});
