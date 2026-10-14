/**
 * utils/entry-source.js — 启动来源捕获（注册归因，公众号联动 T2/T3）
 *
 * 两种带参小程序码入口，统一归一化到同一存储键 entrySource：
 *   - scene：后端 getwxacodeunlimit 生成的码（微信投递时为百分号编码，需 decode）
 *   - src：小程序后台「工具 → 生成小程序码」自定义路径参数（如 pages/home/index?src=gzh_follow）
 *
 * 写入时机：app.js onLaunch / onShow 带新的 scene/src 时覆盖存储（最近一次
 * 扫码进入为准）；无参数的普通启动不触碰旧值。
 * 读取时机：建号请求（utils/api/auth.js 的 loginWithSms / verifyAndSignUp）
 * 携带给后端，落 User.signupSource（后端仅建号时写入，登录不覆盖）。
 *
 * 安全口径（与服务端 core/utils/signup-source.ts 同一正则）：
 * /^[A-Za-z0-9_.\-]{1,100}$/——异常值一律视为无来源，静默丢弃。
 */

const STORAGE_KEY = 'entrySource';
const SOURCE_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

/** 从启动参数 query 捕获来源（scene 优先于 src），合法才落 storage */
function captureFromQuery(query) {
  try {
    if (!query || typeof query !== 'object') return;

    let raw = '';
    const scene = query.scene;
    if (scene !== undefined && scene !== null && scene !== '') {
      // getwxacodeunlimit 的 scene 经百分号编码投递
      raw = decodeURIComponent(String(scene));
    } else if (query.src !== undefined && query.src !== null && query.src !== '') {
      raw = String(query.src);
    }

    raw = raw.trim();
    if (raw && SOURCE_RE.test(raw)) {
      wx.setStorageSync(STORAGE_KEY, raw);
    }
  } catch (e) {
    // 归因属于"锦上添花"，任何异常都不外抛
  }
}

/** 读取当前来源；无来源或存储值非法时返回 '' */
function get() {
  try {
    const v = wx.getStorageSync(STORAGE_KEY);
    return typeof v === 'string' && SOURCE_RE.test(v) ? v : '';
  } catch (e) {
    return '';
  }
}

module.exports = { captureFromQuery, get };
