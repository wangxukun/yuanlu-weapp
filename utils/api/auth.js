/**
 * utils/api/auth.js — 认证服务层
 *
 * 移植自 Android 端 AuthRepositoryImpl.kt，接口路径与请求体一一同构：
 *   POST /api/auth/mobile/token           登录（type: "sms" | "password"，信封 { success, data: { token } }）
 *   POST /api/auth/sms/send               发送短信验证码（{ phone, scene }；业务失败也返回 HTTP 200，
 *                                         requireCaptcha 标识阿里云滑块风控）
 *   POST /api/auth/send-verification-code 发送邮箱注册验证码（裸 { success, message }）
 *   POST /api/auth/verify-code            校验邮箱验证码（裸 { success, message }，错误随 4xx）
 *   POST /api/auth/sign-up                邮箱 + 密码创建账号（裸 { success, message }，已注册随 400）
 *
 * 登录成功统一经 authStore.setLoginData 完成 token 本地持久化
 * （对齐 Android TokenStore.saveToken），并触发订阅页面的登录态刷新。
 */

const { post } = require('../request');
const authStore = require('../../store/authStore');

/** 匿名接口选项：不带 token、错误不弹全局 Toast（由登录页行内展示） */
const NO_AUTH = { needAuth: false, showError: false };

/** HTTP 200 但 success:false 的裸响应 → 抛出带后端文案的 Error */
function assertAction(body, fallback) {
  if (body && body.success) return body;
  const message =
    (body && ((body.error && String(body.error)) || (body.message && String(body.message)))) ||
    fallback;
  const err = new Error(message);
  err.body = body || null;
  throw err;
}

/** 信封响应 { success, data: { token, user? } } → 写入登录态并返回 token */
function persistLogin(body, fallbackUser) {
  if (body && body.success && body.data && body.data.token) {
    authStore.setLoginData(body.data.token, body.data.user || fallbackUser);
    return body.data.token;
  }
  const message =
    (body && ((body.error && String(body.error)) || (body.message && String(body.message)))) ||
    '登录失败，请稍后重试';
  const err = new Error(message);
  err.body = body || null;
  throw err;
}

// ==================== 登录 ====================

/** 邮箱 + 密码登录（对齐 repository.loginWithPassword） */
function loginWithPassword(email, password) {
  return post(
    '/api/auth/mobile/token',
    { type: 'password', email, password },
    NO_AUTH
  ).then((body) => persistLogin(body, { email }));
}

/** 手机号 + 短信验证码登录（对齐 repository.loginWithSms；手机验证码登录自动建号） */
function loginWithSms(phone, code) {
  return post(
    '/api/auth/mobile/token',
    { type: 'sms', phone, code },
    NO_AUTH
  ).then((body) => persistLogin(body, { phone }));
}

// ==================== 验证码 ====================

/**
 * 发送短信登录验证码（scene=LOGIN）。业务失败也为 HTTP 200：
 * requireCaptcha 时后端文案转译为「触发安全验证，请改用邮箱登录」
 * （对齐 AuthRepositoryImpl.sendSmsCode 的风控降级策略）。
 */
function sendSmsCode(phone) {
  return post('/api/auth/sms/send', { phone, scene: 'LOGIN' }, NO_AUTH).then((body) => {
    if (body && body.success) return body;
    const message =
      body && body.requireCaptcha
        ? '触发安全验证，请改用邮箱登录'
        : (body && body.error) || '验证码发送失败';
    const err = new Error(message);
    err.body = body || null;
    throw err;
  });
}

/** 发送邮箱注册验证码（5 分钟有效，对齐 repository.sendEmailVerificationCode） */
function sendEmailVerificationCode(email) {
  return post('/api/auth/send-verification-code', { email }, NO_AUTH).then((body) =>
    assertAction(body, '验证码发送失败，请稍后重试')
  );
}

// ==================== 邮箱注册（verify-code → sign-up 两步，登录由调用方串联） ====================

/**
 * 校验邮箱验证码并创建账号（对齐 repository.signUp 的 verify + create 链）。
 * 注册成功不返回 token——邮箱分支不会自动建号登录，
 * 调用方需接着用同一凭据调用 loginWithPassword 完成「注册成功，正在自动登录」
 * （对齐 LoginViewModel.register 的串联逻辑）。
 */
function verifyAndSignUp(email, code, password) {
  return post('/api/auth/verify-code', { email, code }, NO_AUTH)
    .then((body) => assertAction(body, '验证码错误'))
    .then(() => post('/api/auth/sign-up', { email, password }, NO_AUTH))
    .then((body) => assertAction(body, '注册失败，请稍后重试'));
}

module.exports = {
  loginWithPassword,
  loginWithSms,
  sendSmsCode,
  sendEmailVerificationCode,
  verifyAndSignUp,
};
