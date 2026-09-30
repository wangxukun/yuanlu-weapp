/**
 * utils/api/profile.js — 「个人中心」接口封装（PROFILE-TASK 1.3 API 契约）
 *
 * 端点与响应形状对照 yuanlu-android data/remote/AuthApi.kt + 后端 app/api/**：
 *   - GET  /api/user/profile                        裸 user_profile 行 + 嵌套 User（404=无
 *     profile 行，邮箱新注册常态 → 返回 null 交 mapProfile 走 toFallbackProfile 兜底）
 *   - GET  /api/user/stats/overview                 裸 { totalHours, streakDays, wordsLearned, ... }
 *   - GET  /api/user/stats/weekly-activity?weekOffset=0|1   { weeklyActivity: [{day, minutes}] }
 *   - GET  /api/user/achievements                   裸数组 [{key, name, icon(emoji), unlocked, ...}]
 *   - POST /api/user/profile                        保存：JSON 纯文本 / multipart 带头像
 *     （后端 T1.1 别名；wx.uploadFile 无 method 参数只能 POST）
 *   - POST /api/auth/sms/send {phone, scene:'BIND'} / sms/bind {phone, code}
 *   - POST /api/auth/bind-email/send {email} / bind-email/confirm {email, code, password}
 *   - DELETE /api/user/self-delete                  注销（服务端清 OSS + 级联删库）
 *
 * 读接口统一 showError:false（区块级降级，由页面决定空态/骨架）；写接口沿用
 * request.js 默认 toast（调用方 catch 勿重复提示）。
 */
const { get, post, delete: del, ApiError } = require('../request');

/**
 * HTTP 200 但 success:false 的裸响应（assertAction 口径，同 utils/api/auth.js）
 * → 抛出带后端文案的 Error；绑定/注销链路错误走弹层行内展示或页面自管 toast。
 */
function assertAction(body, fallback) {
  if (body && body.success) return body;
  const message =
    (body && ((body.error && String(body.error)) || (body.message && String(body.message)))) ||
    fallback;
  const err = new Error(message);
  err.body = body || null;
  throw err;
}

/** GET profile；404 归一为 null（mapProfile(null, userInfo) 合成最小资料） */
function getProfile() {
  return get('/api/user/profile', undefined, { showError: false }).then(
    (body) => body || null,
    (err) => {
      if (err instanceof ApiError && err.statusCode === 404) return null;
      throw err;
    }
  );
}

function getStatsOverview() {
  return get('/api/user/stats/overview', undefined, { showError: false });
}

/** weekOffset：0 本周 / 1 上周（后端 parseInt+isNaN→0 兜底） */
function getWeeklyActivity(weekOffset) {
  const offset = Number(weekOffset) === 1 ? 1 : 0;
  return get('/api/user/stats/weekly-activity?weekOffset=' + offset, undefined, {
    showError: false,
  });
}

function getAchievements() {
  return get('/api/user/achievements', undefined, { showError: false });
}

/**
 * 纯文本保存（编辑资料不改头像时走 wx.request JSON，uploadFile 必须带文件）。
 * 字段：nickname/bio/learnLevel + 三目标（dailyStudyGoalMins/weeklyListeningGoalHours/weeklyWordsGoal）。
 */
function saveProfile(fields) {
  return post('/api/user/profile', fields || {});
}

/**
 * 带头像保存（wx.uploadFile multipart，name=avatar；multipart 文件名由运行时取自
 * filePath——canvasToTempFilePath(fileType:'jpg') 产物天然带 .jpg 后缀，后端据此
 * 生成 yuanlu/avatar/{ts}_{rand}.jpg objectKey）。
 * formData 文本分片与 JSON 分支字段同构；成功返回 {success, data: profile}，
 * 失败 reject Error（HTTP 状态码挂 err.statusCode），由调用方 toast。
 */
function uploadProfileWithAvatar(filePath, fields) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: require('../config').BASE_URL + '/api/user/profile',
      filePath: filePath,
      name: 'avatar',
      header: { Authorization: 'Bearer ' + (wx.getStorageSync('token') || '') },
      formData: fields || {},
      success: (res) => {
        let body = null;
        try {
          body = JSON.parse(res.data);
        } catch (e) {
          body = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.success) {
          resolve(body);
        } else {
          const err = new Error((body && (body.error || body.message)) || '上传失败，请重试');
          err.statusCode = res.statusCode;
          reject(err);
        }
      },
      fail: (e) => {
        reject(new Error((e && e.errMsg) || '网络错误，请重试'));
      },
    });
  });
}

// ---- 账号与安全写接口：showError:false——错误由页面行内/自管 toast 展示
// （对齐 Android Result.Error → form.error / VM toast 口径，勿弹全局 toast 双提示） ----

/** 绑定手机验证码（scene=BIND 专用短信模板） */
function sendBindPhoneCode(phone) {
  return post('/api/auth/sms/send', { phone: phone, scene: 'BIND' }, { showError: false }).then(
    (body) => assertAction(body, '验证码发送失败，请稍后重试')
  );
}

function bindPhone(phone, code) {
  return post('/api/auth/sms/bind', { phone: phone, code: code }, { showError: false }).then(
    (body) => assertAction(body, '绑定失败，请稍后重试')
  );
}

function sendBindEmailCode(email) {
  return post('/api/auth/bind-email/send', { email: email }, { showError: false }).then((body) =>
    assertAction(body, '验证码发送失败，请稍后重试')
  );
}

function bindEmailConfirm(email, code, password) {
  return post(
    '/api/auth/bind-email/confirm',
    { email: email, code: code, password: password },
    { showError: false }
  ).then((body) => assertAction(body, '绑定失败，请稍后重试'));
}

/** 注销账号（成功后调用方 authStore.logout + navigateBack；失败 toast 由页面自管） */
function deleteSelfAccount() {
  return del('/api/user/self-delete', undefined, { showError: false }).then((body) =>
    assertAction(body, '注销失败，请稍后重试')
  );
}

module.exports = {
  getProfile,
  getStatsOverview,
  getWeeklyActivity,
  getAchievements,
  saveProfile,
  uploadProfileWithAvatar,
  sendBindPhoneCode,
  bindPhone,
  sendBindEmailCode,
  bindEmailConfirm,
  deleteSelfAccount,
};
