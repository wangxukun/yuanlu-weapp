/**
 * utils/entry-source.js — 启动来源捕获与剧集直达（注册归因 + 公众号联动 T2）
 *
 * 两种带参小程序码入口，统一归一化到同一存储键 entrySource：
 *   - scene：后端 getwxacodeunlimit 生成的码（微信投递时为百分号编码，需 decode）
 *   - src：小程序后台「工具 → 生成小程序码」自定义路径参数（如 pages/home/index?src=gzh_follow）
 *
 * ── 归因（T3）──
 * 写入时机：onLaunch / onShow 带新的 scene/src 时覆盖存储（最近一次扫码进入为准）；
 * 无参数的普通启动不触碰旧值。读取时机：建号请求（utils/api/auth.js）携带给后端，
 * 落 User.signupSource（后端仅建号时写入，登录不覆盖）。
 *
 * ── 剧集直达（T2，重塑后改道精研页）──
 * handleEntry(query)：仅当**本次启动携带了新来源**时，调 GET /api/wxacode?scene=
 * 解析短码（服务端 qr_scene 表映射）；targetType=episode 则导航到原声精研页
 * （/pages/intensive-listening/index?id=）。已存储的旧来源在自然打开时**不**
 * 触发直达，避免昨天扫过码的用户今天正常进小程序被劫持到旧剧集。
 *
 * 请求口径（对齐 utils/visit-reporter.js）：不走 utils/request.js——解析属于
 * "锦上添花"，任何失败（404 短码不存在/网络异常/字段缺失）一律静默收敛，
 * 绝不弹错、绝不阻塞启动。
 *
 * 安全口径（与服务端 core/utils/signup-source.ts 同一正则）：
 * /^[A-Za-z0-9_.\-]{1,100}$/——异常值一律视为无来源，静默丢弃。
 */

const { BASE_URL } = require('./config');

const STORAGE_KEY = 'entrySource';
const SOURCE_RE = /^[A-Za-z0-9_.\-]{1,100}$/;

// 冷启动 onLaunch + onShow 会带同一份 query 先后触发两次——同 scene 10s 内去重，
// 防止剧集页被压两次栈；顺带挡掉 10s 内的重复真扫（场景不存在）
const NAV_DEDUPE_MS = 10000;
const NAV_MAX_RETRY = 2;

let lastNavScene = '';
let lastNavAt = 0;

/** 从启动参数 query 捕获来源（scene 优先于 src），合法才落 storage；
 *  返回本次新捕获的值（无新来源/非法值返回 ''），供调用方决定是否解析直达 */
function captureFromQuery(query) {
  try {
    if (!query || typeof query !== 'object') return '';

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
      return raw;
    }
    return '';
  } catch (e) {
    // 归因属于"锦上添花"，任何异常都不外抛
    return '';
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

/** 解析 scene 短码 → { targetType, episodeId, ... } | null（永不 reject） */
function resolveTarget(scene) {
  return new Promise((resolve) => {
    try {
      wx.request({
        url: BASE_URL + '/api/wxacode?scene=' + encodeURIComponent(scene),
        method: 'GET',
        success: (res) => {
          const body = res.data;
          if (res.statusCode === 200 && body && body.success && body.data) {
            resolve(body.data);
          } else {
            resolve(null);
          }
        },
        fail: () => resolve(null),
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** 导航并退避重试——冷启动竞态下首页可能尚未就绪（navigateTo 会 fail），最多重试 2 次 */
function navigateWithRetry(url, attempt) {
  attempt = attempt || 0;
  try {
    wx.navigateTo({
      url,
      fail: () => {
        if (attempt < NAV_MAX_RETRY) {
          setTimeout(() => navigateWithRetry(url, attempt + 1), 600 * (attempt + 1));
        }
      },
    });
  } catch (e) {
    // 静默
  }
}

/**
 * 启动入口统一处理（app.js 的 onLaunch/onShow 调用）：
 * 捕获归因来源；episode 型 scene 解析成功后直达剧集页。
 */
function handleEntry(query) {
  const fresh = captureFromQuery(query);
  if (!fresh) return;

  const now = Date.now();
  if (fresh === lastNavScene && now - lastNavAt < NAV_DEDUPE_MS) return;
  lastNavScene = fresh;
  lastNavAt = now;

  resolveTarget(fresh).then((target) => {
    if (target && target.targetType === 'episode' && target.episodeId) {
      navigateWithRetry('/pages/intensive-listening/index?id=' + target.episodeId);
    }
    // follow/article（无剧集目标）与解析失败：仅归因，不导航
  });
}

module.exports = { captureFromQuery, get, resolveTarget, handleEntry };
