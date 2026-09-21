/**
 * scripts/test-login.js — 登录 / 注册页与认证链路自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getCurrentPages），
 * 全链路驱动 pages/auth/index.js → utils/api/auth.js → utils/request.js → wx.request：
 * 不依赖微信开发者工具即可回归登录注册相关的纯前端逻辑。
 *
 * 状态机对照 Android 端 LoginViewModel.kt / LoginSheet.kt：
 *   双 Tab 切换、邮箱 Tab 内部登录⇄注册切换、60s 倒计时、防重入、
 *   requireCaptcha 风控文案、邮箱注册三步串联（verify-code → sign-up → 自动登录）、
 *   协议门禁、token 落库（authStore 订阅广播）与路由回退。
 *
 * 运行：node scripts/test-login.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const calls = { request: [], navigateTo: null, switchTab: null, navigateBack: 0 };

// 每个用例注入：({ url, method, data, header }) => 调 success/fail
let requestHandler = null;

let intervalFn = null; // 捕获 setInterval 注册的回调，测试手动 tick

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ""),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o),
  showModal: () => {},
  request: (opts) => {
    calls.request.push(opts);
    requestHandler && requestHandler(opts);
  },
  navigateTo: (o) => (calls.navigateTo = o.url),
  switchTab: (o) => (calls.switchTab = o.url),
  navigateBack: () => (calls.navigateBack += 1),
};

global.Page = (cfg) => (global.__pageConfig = cfg);
global.getCurrentPages = () => (global.__pages || [{}, {}]);

// 假计时器：立即执行 setTimeout；setInterval 捕获回调供手动 tick
global.setTimeout = (fn) => {
  fn();
  return 0;
};
global.setInterval = (fn) => {
  intervalFn = fn;
  return 1;
};
global.clearInterval = () => {
  intervalFn = null;
};

/* ==================== 加载被测模块 ==================== */

const path = require("path");
const request = require(path.join(__dirname, "../utils/request.js"));
const authStore = require(path.join(__dirname, "../store/authStore.js"));
require(path.join(__dirname, "../pages/auth/index.js"));
const pageConfig = global.__pageConfig;
const agreement = require(path.join(__dirname, "../pages/auth/agreement.js"));

/* ==================== 工具函数 ==================== */

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

/** 实例化一个隔离的页面对象（独立 data / 定时器） */
function makePage(initial = {}) {
  const page = Object.assign({}, pageConfig, {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    countdownTimer: null,
  });
  page.setData = function (patch) {
    Object.assign(this.data, patch);
  };
  Object.assign(page.data, initial);
  return page;
}

let storeFired = 0;
authStore.subscribe(() => (storeFired += 1));

function resetMock() {
  storage.clear();
  toasts.length = 0;
  calls.request.length = 0;
  calls.navigateTo = null;
  calls.switchTab = null;
  calls.navigateBack = 0;
  intervalFn = null;
  requestHandler = null;
  storeFired = 0;
  authStore.setState({ isLoggedIn: false, token: "", userInfo: null });
  global.__pages = [{}, {}];
}

/** 让 wx.request 的下一个响应为指定 statusCode/body（须在触发请求前调用） */
const respond = (statusCode, data) => {
  requestHandler = (opts) => opts.success({ statusCode, data });
};

/** 冲刷微任务队列（页面方法内部的 .then 链需要多跳才落定） */
const tick = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const reqPath = (i) => calls.request[i] && calls.request[i].url.replace(/^https?:\/\/[^/]+/, "");

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- utils/request.js 传输层 ---------- */
  section("request.js · Token 注入与 needAuth");
  resetMock();
  storage.set("token", "tk-123");
  respond(200, { success: true });
  await request.get("/api/user/detail");
  assert(
    calls.request[0].header.Authorization === "Bearer tk-123",
    "默认自动注入 Authorization: Bearer"
  );

  resetMock();
  storage.set("token", "tk-123");
  respond(200, { success: true });
  await request.post("/api/auth/mobile/token", {}, { needAuth: false });
  assert(
    !calls.request[0].header.Authorization,
    "needAuth:false → 登录接口不携带 Authorization"
  );

  section("request.js · 4xx 错误文案提取（对齐 errorMessage()）");
  resetMock();
  respond(400, { success: false, error: "邮箱或密码错误" });
  const bizErr = await request
    .post("/api/auth/mobile/token", {}, { needAuth: false, showError: false })
    .catch((e) => e);
  assert(bizErr.name === "ApiError", "reject 统一为 ApiError");
  assert(bizErr.message === "邮箱或密码错误", "透传后端 error 文案");
  assert(bizErr.statusCode === 400, "携带 statusCode");
  assert(toasts.length === 0, "showError:false 时不弹全局 toast");

  resetMock();
  respond(500, { message: "服务器开小差" });
  const msgErr = await request
    .get("/api/x", undefined, { showError: false })
    .catch((e) => e);
  assert(msgErr.message === "服务器开小差", "error 缺失时回退 message 字段");

  section("request.js · 401 拦截");
  resetMock();
  storage.set("token", "expired-token");
  respond(401, {});
  await request.get("/api/user/detail", undefined, { showError: false }).catch(() => {});
  assert(storage.get("token") === undefined, "401 → 清除本地 token");
  assert(
    toasts.some((t) => t.title.includes("登录已过期")),
    "401 → 全局提示重新登录"
  );

  section("request.js · 网络层失败");
  resetMock();
  requestHandler = (opts) => opts.fail({ errMsg: "request:fail timeout" });
  const netErr = await request
    .get("/api/episode/list", undefined, { showError: false })
    .catch((e) => e);
  assert(netErr.message === "网络连接失败", "对齐 Android Result.NetworkError 文案");
  assert(toasts.length === 0, "showError:false 时网络失败不弹 toast");

  /* ---------- 协议全文数据 ---------- */
  section("协议 · 全文数据完整性（对齐 AgreementContent.kt）");
  assert(agreement.USER_AGREEMENT.title === "用户协议", "用户协议标题");
  assert(
    agreement.USER_AGREEMENT.lastUpdated === "最后更新：2025年11月",
    "用户协议落款时间"
  );
  assert(
    agreement.USER_AGREEMENT.blocks.filter((b) => b.type === "heading").length === 8,
    "用户协议 8 个小节标题（欢迎语 + 1~7）"
  );
  assert(
    agreement.PRIVACY_POLICY.blocks.some(
      (b) => b.type === "paragraph" && b.text.includes("wxk-zd@qq.com")
    ),
    "隐私政策含联系方式"
  );
  assert(
    agreement.PRIVACY_POLICY.blocks.some((b) => b.type === "bullets" && b.items.length === 4),
    "隐私政策「信息收集」四条 bullets"
  );

  /* ---------- 页面 · Tab 与模式切换 ---------- */
  section("登录页 · 双 Tab 切换清空表单");
  resetMock();
  let page = makePage({
    activeTab: "email",
    isRegisterMode: true,
    account: "a@b.com",
    credential: "123456",
    registerPassword: "secret123",
    registerConfirm: "secret123",
    error: "旧错误",
  });
  page.onSwitchTab({ currentTarget: { dataset: { tab: "phone" } } });
  assert(page.data.activeTab === "phone", "切换到手机 Tab");
  assert(
    page.data.account === "" &&
      page.data.credential === "" &&
      page.data.registerPassword === "" &&
      page.data.registerConfirm === "",
    "account / credential / 两组密码全部清空"
  );
  assert(page.data.isRegisterMode === false, "切 Tab 回到登录表单（注册仅存在于邮箱 Tab）");
  assert(page.data.error === "", "切换时清空行内错误");

  page.onSwitchTab({ currentTarget: { dataset: { tab: "phone" } } });
  assert(calls.request.length === 0, "重复点同 Tab 无副作用");

  section("登录页 · 邮箱 Tab 内部登录⇄注册切换");
  resetMock();
  page = makePage({ activeTab: "email", credential: "old-password" });
  page.onSwitchToRegister();
  assert(page.data.isRegisterMode === true, "进入注册态");
  assert(page.data.credential === "", "登录密码被清空");

  page = makePage({
    activeTab: "email",
    isRegisterMode: true,
    credential: "654321",
    registerPassword: "secret123",
    registerConfirm: "secret123",
  });
  page.onSwitchToLogin();
  assert(page.data.isRegisterMode === false, "返回登录态");
  assert(
    page.data.credential === "" &&
      page.data.registerPassword === "" &&
      page.data.registerConfirm === "",
    "验证码与两组密码被清空"
  );

  /* ---------- 页面 · 输入过滤 ---------- */
  section("登录页 · 输入过滤");
  resetMock();
  page = makePage({ activeTab: "phone", error: "旧错误" });
  page.onAccountInput({ detail: { value: "138abc00@138x" } });
  assert(page.data.account === "13800138", "手机 Tab：非数字过滤且截断 11 位");
  assert(page.data.error === "", "重新输入时清除旧错误");

  page = makePage({ activeTab: "email" });
  page.onAccountInput({ detail: { value: "user@mail.com" } });
  assert(page.data.account === "user@mail.com", "邮箱 Tab：原样保留");

  page = makePage({ activeTab: "phone" });
  page.onCredentialInput({ detail: { value: "12a34567" } });
  assert(page.data.credential === "123456", "验证码：非数字过滤且截断 6 位");

  page = makePage({ activeTab: "email", isRegisterMode: false });
  page.onCredentialInput({ detail: { value: "p@ss word!" } });
  assert(page.data.credential === "p@ss word!", "邮箱登录密码：不过滤");

  /* ---------- 页面 · 发码与倒计时 ---------- */
  section("登录页 · 手机号校验（发码）");
  resetMock();
  page = makePage({ activeTab: "phone", account: "12345" });
  page.onSendCode();
  assert(page.data.error === "请输入11位手机号码", "非法手机号 → 行内报错");
  assert(calls.request.length === 0, "不发请求");

  section("登录页 · 发码成功与 60s 倒计时");
  resetMock();
  page = makePage({ activeTab: "phone", account: "13800138000" });
  respond(200, { success: true });
  await page.onSendCode();
  await tick();
  assert(page.data.isSending === false, "成功后退出发送中态");
  assert(page.data.countdownSeconds === 60, "倒计时从 60 开始");
  assert(toasts.some((t) => t.title === "验证码已发送"), "toast 验证码已发送");
  assert(
    reqPath(0) === "/api/auth/sms/send" && calls.request[0].data.scene === "LOGIN",
    "POST /api/auth/sms/send 且 scene=LOGIN"
  );
  intervalFn && intervalFn(); // 手动推进 1 秒
  assert(page.data.countdownSeconds === 59, "倒计时每秒递减");

  section("登录页 · 倒计时防重入");
  resetMock();
  page = makePage({ activeTab: "phone", account: "13800138000", countdownSeconds: 59 });
  page.onSendCode();
  assert(calls.request.length === 0, "倒计时期间重复点击不发请求");

  section("登录页 · requireCaptcha 风控文案");
  resetMock();
  page = makePage({ activeTab: "phone", account: "13800138000" });
  respond(200, { success: false, code: "CAPTCHA_REQUIRED", requireCaptcha: true });
  await page.onSendCode();
  await tick();
  assert(
    page.data.error === "触发安全验证，请改用邮箱登录",
    "requireCaptcha → 提示改用邮箱登录（对齐 Android 转译）"
  );
  assert(page.data.isSending === false, "失败后退出发送中态");

  section("登录页 · 邮箱验证码格式校验");
  resetMock();
  page = makePage({ activeTab: "email", isRegisterMode: true, account: "not-an-email" });
  page.onSendCode();
  assert(page.data.error === "请输入正确的邮箱地址", "非法邮箱 → 行内报错");

  resetMock();
  page = makePage({ activeTab: "email", isRegisterMode: true, account: "a@b.com" });
  respond(200, { success: true, message: "sent" });
  await page.onSendCode();
  await tick();
  assert(reqPath(0) === "/api/auth/send-verification-code", "POST /api/auth/send-verification-code");
  assert(page.data.countdownSeconds === 60, "邮箱发码复用同一倒计时");

  /* ---------- 页面 · 协议门禁与全文 ---------- */
  section("登录页 · 协议门禁");
  resetMock();
  page = makePage({ activeTab: "phone", account: "13800138000", credential: "123456", agreed: false });
  page.onSubmit();
  assert(toasts.some((t) => t.title.includes("用户协议")), "未勾选协议 → toast 提示");
  assert(calls.request.length === 0, "未勾选协议 → 不发登录请求");
  assert(page.data.isLoading === false, "未进入 loading 态");

  section("登录页 · 协议全文弹层");
  resetMock();
  page = makePage({});
  page.onOpenAgreement({ currentTarget: { dataset: { doc: "user" } } });
  assert(
    page.data.agreementDoc && page.data.agreementDoc.title === "用户协议",
    "打开用户协议全文"
  );
  page.onOpenAgreement({ currentTarget: { dataset: { doc: "privacy" } } });
  assert(
    page.data.agreementDoc && page.data.agreementDoc.title === "隐私政策",
    "切换打开隐私政策全文"
  );
  page.onCloseAgreement();
  assert(page.data.agreementDoc === null, "关闭协议弹层");

  /* ---------- 页面 · 登录流程 ---------- */
  section("登录页 · 手机验证码登录成功（token 落库 + 回退）");
  resetMock();
  respond(200, { success: true, data: { token: "jwt-sms" } });
  page = makePage({ activeTab: "phone", account: "13800138000", credential: "123456", agreed: true });
  await page.onSubmit();
  await tick();
  assert(reqPath(0) === "/api/auth/mobile/token", "POST /api/auth/mobile/token");
  assert(
    calls.request[0].data.type === "sms" &&
      calls.request[0].data.phone === "13800138000" &&
      calls.request[0].data.code === "123456",
    "请求体 { type: sms, phone, code } 对齐 LoginRequest"
  );
  assert(storage.get("token") === "jwt-sms", "token 写入本地存储（对齐 TokenStore）");
  assert(authStore.getState().isLoggedIn === true, "authStore.isLoggedIn 翻真");
  assert(storeFired >= 1, "authStore 订阅者收到广播（首页/我的自动刷新）");
  assert(calls.navigateBack === 1, "页面栈>1 → navigateBack");
  assert(calls.switchTab === null, "不走 switchTab");

  section("登录页 · 登录页为入口页时回首页");
  resetMock();
  respond(200, { success: true, data: { token: "jwt-x" } });
  global.__pages = [{}]; // 页面栈只有登录页自己
  page = makePage({ activeTab: "phone", account: "13800138000", credential: "123456", agreed: true });
  await page.onSubmit();
  await tick();
  assert(calls.switchTab === "/pages/home/index", "页面栈=1 → switchTab 回首页 tab");

  section("登录页 · 邮箱密码登录成功");
  resetMock();
  respond(200, { success: true, data: { token: "jwt-mail" } });
  page = makePage({ activeTab: "email", account: "a@b.com", credential: "secret123", agreed: true });
  await page.onSubmit();
  await tick();
  assert(
    calls.request[0].data.type === "password" &&
      calls.request[0].data.email === "a@b.com" &&
      calls.request[0].data.password === "secret123",
    "请求体 { type: password, email, password } 对齐 LoginRequest"
  );
  assert(storage.get("token") === "jwt-mail", "token 落库");
  assert(calls.navigateBack === 1, "登录成功回退");

  section("登录页 · 登录失败行内展示");
  resetMock();
  respond(400, { success: false, error: "邮箱或密码错误" });
  page = makePage({ activeTab: "email", account: "a@b.com", credential: "wrong", agreed: true });
  await page.onSubmit();
  await tick();
  assert(page.data.error === "邮箱或密码错误", "4xx 后端文案行内展示");
  assert(page.data.isLoading === false, "失败后退出 loading（可重试）");
  assert(calls.navigateBack === 0, "不跳转");
  assert(storage.get("token") === undefined, "失败时不写入 token");

  section("登录页 · 空字段兜底");
  resetMock();
  page = makePage({ activeTab: "email", account: "", credential: "", agreed: true });
  page.onSubmit();
  assert(page.data.error === "请输入邮箱和密码", "邮箱登录空字段 → 行内报错");
  assert(calls.request.length === 0, "不发请求");

  section("登录页 · loading 防抖");
  resetMock();
  page = makePage({ activeTab: "phone", account: "13800138000", credential: "123456", agreed: true });
  requestHandler = () => {}; // 请求不回调（悬挂），模拟慢网络
  page.onSubmit();
  assert(page.data.isLoading === true, "请求中进入 loading");
  page.onSubmit(); // 请求未返回时再次点击
  assert(calls.request.length === 1, "loading 期间重复点击只发一次请求");

  /* ---------- 页面 · 邮箱注册三步 ---------- */
  section("登录页 · 邮箱注册表单校验");
  resetMock();
  page = makePage({
    activeTab: "email",
    isRegisterMode: true,
    account: "a@b.com",
    credential: "12345",
    registerPassword: "secret123",
    registerConfirm: "secret123",
    agreed: true,
  });
  page.onSubmit();
  assert(page.data.error === "请输入6位邮箱验证码", "5 位验证码 → 行内报错");

  page.setData({ credential: "123456", registerPassword: "12345", registerConfirm: "12345" });
  page.onSubmit();
  assert(page.data.error === "密码至少需要6位", "短密码 → 行内报错");

  page.setData({ registerPassword: "secret123", registerConfirm: "secret999" });
  page.onSubmit();
  assert(page.data.error === "两次输入的密码不一致", "确认密码不一致 → 行内报错");

  page.setData({ registerConfirm: "" });
  page.onSubmit();
  assert(page.data.error === "请填写完整注册信息", "缺字段 → 行内报错");
  assert(calls.request.length === 0, "校验失败不发请求");

  section("登录页 · 邮箱注册成功（verify-code → sign-up → 自动登录）");
  resetMock();
  let step = 0;
  requestHandler = (opts) => {
    step += 1;
    const p = opts.url.replace(/^https?:\/\/[^/]+/, "");
    if (p === "/api/auth/verify-code") {
      opts.success({ statusCode: 200, data: { success: true } });
    } else if (p === "/api/auth/sign-up") {
      opts.success({ statusCode: 200, data: { success: true } });
    } else if (p === "/api/auth/mobile/token") {
      opts.success({ statusCode: 200, data: { success: true, data: { token: "jwt-reg" } } });
    } else {
      opts.success({ statusCode: 404, data: { error: "unexpected " + p } });
    }
  };
  page = makePage({
    activeTab: "email",
    isRegisterMode: true,
    account: "new@user.com",
    credential: "654321",
    registerPassword: "secret123",
    registerConfirm: "secret123",
    agreed: true,
  });
  const p = page.onSubmit();
  await tick(6);
  assert(page.data.notice === "注册成功，正在自动登录", "注册成功 → notice 非侵扰提示");
  await p;
  await tick();
  assert(
    reqPath(0) === "/api/auth/verify-code" &&
      calls.request[0].data.email === "new@user.com" &&
      calls.request[0].data.code === "654321",
    "第一步 POST /api/auth/verify-code"
  );
  assert(
    reqPath(1) === "/api/auth/sign-up" &&
      calls.request[1].data.password === "secret123",
    "第二步 POST /api/auth/sign-up"
  );
  assert(
    reqPath(2) === "/api/auth/mobile/token" &&
      calls.request[2].data.type === "password",
    "第三步用同一凭据自动登录（type=password）"
  );
  assert(storage.get("token") === "jwt-reg", "自动登录后 token 落库");
  assert(calls.navigateBack === 1, "注册完成路由回退");

  section("登录页 · 注册失败（verify-code 拒绝）");
  resetMock();
  respond(200, { success: false, message: "验证码已过期" });
  page = makePage({
    activeTab: "email",
    isRegisterMode: true,
    account: "new@user.com",
    credential: "000000",
    registerPassword: "secret123",
    registerConfirm: "secret123",
    agreed: true,
  });
  await page.onSubmit();
  await tick();
  assert(page.data.error === "验证码已过期", "verify-code 业务失败文案透出");
  assert(calls.request.length === 1, "失败即短路，不发起 sign-up");
  assert(page.data.isLoading === false, "失败后退出 loading");

  /* ---------- 生命周期 ---------- */
  section("登录页 · onUnload 清理倒计时");
  resetMock();
  page = makePage({ countdownSeconds: 60 });
  page.countdownTimer = 1; // 模拟已注册的定时器句柄
  page.onUnload();
  assert(intervalFn === null, "离开页面停掉倒计时（对齐 onCleared）");

  /* ---------- 汇总 ---------- */
  console.log(`\n══════════════════════════════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failed) {
    console.log("失败用例：", failures.join(" | "));
    process.exit(1);
  }
})();
