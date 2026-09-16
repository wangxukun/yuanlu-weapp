/**
 * scripts/test-login.js — 登录页与核心登录逻辑自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp / getCurrentPages），
 * 全链路驱动 pages/auth/login/login.js → utils/request.js → wx.request：
 * 不依赖微信开发者工具即可回归登录相关的纯前端逻辑。
 *
 * 运行：node scripts/test-login.js
 *
 * 说明：计时器（setInterval/setTimeout）被替换为可手动推进的假实现，
 * 倒计时/登录成功跳转等用例可以同步断言。
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
global.getApp = () => global.__app;
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
require(path.join(__dirname, "../pages/auth/login/login.js"));
const pageConfig = global.__pageConfig;

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

function resetMock() {
  storage.clear();
  toasts.length = 0;
  calls.request.length = 0;
  calls.navigateTo = null;
  calls.switchTab = null;
  calls.navigateBack = 0;
  intervalFn = null;
  requestHandler = null;
  global.__app = { globalData: { userInfo: null } };
  global.__pages = [{}, {}];
}

/** 让 wx.request 的下一个响应为指定 statusCode/body（须在触发请求前调用） */
const respond = (statusCode, data) => {
  requestHandler = (opts) => opts.success({ statusCode, data });
};

/** 冲刷微任务队列（页面方法内部的 .then 链需要多跳才落定） */
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/* ==================== 用例 ==================== */

(async () => {
  /* ---------- utils/request.js 传输层 ---------- */
  section("request.js · Token 注入与请求头");
  resetMock();
  storage.set("yuanlu_token", "tk-123");
  respond(200, { success: true, data: { ok: 1 } });
  await request.get("/api/user/detail");
  const header = calls.request[0].header;
  assert(header.Authorization === "Bearer tk-123", "自动注入 Authorization: Bearer");
  assert(header["X-Client"] === "weapp", "携带 X-Client: weapp");

  section("request.js · 业务失败（HTTP 200 + success:false）");
  resetMock();
  respond(200, { success: false, error: "验证码错误或已失效" });
  const bizErr = await request
    .post("/api/auth/sms/send", {}, { showError: false })
    .catch((e) => e);
  assert(bizErr.code === "BIZ_ERROR", "按 code=BIZ_ERROR 拒绝");
  assert(bizErr.message === "验证码错误或已失效", "透传后端 error 文案");
  assert(toasts.length === 0, "showError:false 时不弹全局 toast");

  section("request.js · 401 拦截");
  resetMock();
  storage.set("yuanlu_token", "expired-token");
  respond(401, {});
  await request.get("/api/user/detail", {}, { showError: false }).catch(() => {});
  assert(storage.get("yuanlu_token") === undefined, "非 auth 接口 401 → 清除本地 token");
  assert(calls.navigateTo === "/pages/auth/login/login", "非 auth 接口 401 → 跳转登录页");

  resetMock();
  storage.set("yuanlu_token", "still-valid");
  respond(401, {});
  await request
    .post("/api/auth/mobile/token", {}, { showError: false })
    .catch(() => {});
  assert(
    storage.get("yuanlu_token") === "still-valid",
    "auth 接口自身 401 → 不误清 token"
  );

  section("request.js · 网络层失败");
  resetMock();
  requestHandler = (opts) =>
    opts.fail({ errMsg: "request:fail timeout" });
  const netErr = await request
    .get("/api/episode/list", {}, { showError: false })
    .catch((e) => e);
  assert(netErr.code === "NETWORK_ERROR", "code=NETWORK_ERROR");
  assert(netErr.message.includes("超时"), "超时给出可读文案");

  section("request.js · mobileLogin 成功落库");
  resetMock();
  respond(200, {
    success: true,
    data: {
      userid: "u1",
      nickname: "测试用户",
      role: "USER",
      token: "jwt-abc",
      expiresAt: "2026-10-16T00:00:00.000Z",
    },
  });
  await request.mobileLogin({ phone: "13800138000", code: "123456" });
  assert(storage.get("yuanlu_token") === "jwt-abc", "token 写入 storage");
  assert(!!storage.get("yuanlu_token_expires_at"), "过期时间写入 storage");
  assert(
    (storage.get("yuanlu_user_info") || {}).userid === "u1",
    "用户信息写入 storage"
  );
  assert(
    global.__app.globalData.userInfo && global.__app.globalData.userInfo.userid === "u1",
    "globalData.userInfo 同步更新"
  );

  /* ---------- pages/auth/login/login.js 页面逻辑 ---------- */
  section("登录页 · 手机号校验");
  resetMock();
  let page = makePage({ phone: "12345" });
  page.onSendCode();
  assert(page.data.error === "请输入11位手机号码", "非法手机号 → 行内报错");
  assert(calls.request.length === 0, "不发请求");

  resetMock();
  page = makePage({ phone: "23800138000" }); // 非 1 开头
  page.onSendCode();
  assert(page.data.error === "请输入11位手机号码", "非 1 开头 → 行内报错");

  section("登录页 · 发码成功与 60s 倒计时");
  resetMock();
  page = makePage({ phone: "13800138000" });
  respond(200, { success: true });
  await page.onSendCode();
  await tick();
  assert(page.data.isSending === false, "成功后退出发送中态");
  assert(page.data.countdownSeconds === 60, "倒计时从 60 开始");
  assert(
    toasts.some((t) => t.title === "验证码已发送"),
    "toast 验证码已发送"
  );
  assert(
    calls.request[0].url.endsWith("/api/auth/sms/send") &&
      calls.request[0].data.scene === "LOGIN",
    "POST /api/auth/sms/send 且 scene=LOGIN"
  );
  intervalFn && intervalFn(); // 手动推进 1 秒
  assert(page.data.countdownSeconds === 59, "倒计时每秒递减");

  section("登录页 · 倒计时防重入");
  resetMock();
  page = makePage({ phone: "13800138000", countdownSeconds: 59 });
  page.onSendCode();
  assert(calls.request.length === 0, "倒计时期间重复点击不发请求");

  section("登录页 · requireCaptcha 风控文案");
  resetMock();
  page = makePage({ phone: "13800138000" });
  respond(200, { success: false, code: "CAPTCHA_REQUIRED", requireCaptcha: true });
  await page.onSendCode();
  await tick();
  assert(
    page.data.error.includes("安全验证"),
    "requireCaptcha → 提示改用邮箱登录"
  );
  assert(page.data.isSending === false, "失败后退出发送中态");

  section("登录页 · 协议门禁");
  resetMock();
  page = makePage({ phone: "13800138000", code: "123456", agreed: false });
  page.onLogin();
  assert(
    toasts.some((t) => t.title.includes("用户协议")),
    "未勾选协议 → toast 提示"
  );
  assert(calls.request.length === 0, "未勾选协议 → 不发登录请求");
  assert(page.data.isLoading === false, "未进入 loading 态");

  section("登录页 · 验证码位数校验");
  resetMock();
  page = makePage({ phone: "13800138000", code: "12345", agreed: true });
  page.onLogin();
  assert(page.data.error === "请输入6位验证码", "5 位验证码 → 行内报错");
  assert(calls.request.length === 0, "不发请求");

  section("登录页 · 登录成功跳转（有上级页面）");
  resetMock();
  respond(200, {
    success: true,
    data: { userid: "u1", token: "jwt-ok", expiresAt: "x", nickname: "n" },
  });
  page = makePage({ phone: "13800138000", code: "123456", agreed: true });
  await page.onLogin();
  await tick();
  assert(
    page.data.isLoading === true,
    "成功后保持 loading 直到跳转（600ms 过渡期内防重复提交）"
  );
  assert(storage.get("yuanlu_token") === "jwt-ok", "token 已持久化");
  assert(calls.navigateBack === 1, "页面栈>1 → navigateBack");
  assert(calls.switchTab === null, "不走 switchTab");

  section("登录页 · 登录成功跳转（登录页为入口页）");
  resetMock();
  respond(200, {
    success: true,
    data: { userid: "u1", token: "jwt-ok", expiresAt: "x", nickname: "n" },
  });
  global.__pages = [{}]; // 页面栈只有登录页自己
  page = makePage({ phone: "13800138000", code: "123456", agreed: true });
  await page.onLogin();
  await tick();
  assert(calls.switchTab === "/pages/home/home", "页面栈=1 → switchTab 回首页");

  section("登录页 · 登录失败保留在当前页");
  resetMock();
  respond(200, { success: false, error: "验证码错误或已失效" });
  page = makePage({ phone: "13800138000", code: "000000", agreed: true });
  await page.onLogin();
  await tick();
  assert(page.data.error === "验证码错误或已失效", "行内展示后端错误");
  assert(page.data.isLoading === false, "失败后退出 loading（可重试）");
  assert(calls.navigateBack === 0, "不跳转");

  section("登录页 · loading 防抖");
  resetMock();
  page = makePage({ phone: "13800138000", code: "123456", agreed: true });
  // 请求不回调（悬挂），模拟慢网络
  requestHandler = () => {};
  page.onLogin();
  assert(page.data.isLoading === true, "请求中进入 loading");
  page.onLogin(); // 请求未返回时再次点击
  assert(calls.request.length === 1, "loading 期间重复点击只发一次请求");

  section("登录页 · 输入自动清错");
  resetMock();
  page = makePage({ phone: "13800138000", error: "旧错误" });
  page.onPhoneInput({ detail: { value: "13800138000" } });
  assert(page.data.error === "", "重新输入时清除旧错误");
  assert(page.data.phone === "13800138000", "手机号正常回填");

  resetMock();
  page = makePage({});
  page.onPhoneInput({ detail: { value: "138abc00@138x" } });
  assert(page.data.phone === "13800138", "非数字字符被过滤且截断到 11 位内");

  /* ---------- 汇总 ---------- */
  console.log(`\n══════════════════════════════════`);
  console.log(`通过 ${passed} · 失败 ${failed}`);
  if (failed) {
    console.log("失败用例：", failures.join(" | "));
    process.exit(1);
  }
})();
