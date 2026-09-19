/**
 * utils/config.js — 环境配置
 *
 * 后端与 Web 端共用同一 Next.js 服务（https://www.wxkzd.com）。
 * 通过微信基础库的 envVersion 自动区分环境：
 *   develop  → 开发版（开发者工具 / 预览）
 *   trial    → 体验版
 *   release  → 正式版
 *
 * 注意：
 * 1. 开发者工具中请开启「不校验合法域名」或将 BASE_URL 加入小程序后台
 *    request 合法域名（必须 HTTPS 且已备案）。
 * 2. 真机联调本地服务时，把 dev.baseUrl 改为局域网 IP，
 *    并确保手机与电脑同一网络，例如 http://192.168.1.100:3000。
 */

const ENV = {
  // 本地开发：指向本机 Next.js dev server
  dev: {
    // BASE_URL: "http://localhost:3000",
    BASE_URL: "https://www.wxkzd.com",
  },
  // 体验版（灰度/预发可在此覆盖）
  trial: {
    BASE_URL: "https://www.wxkzd.com",
  },
  // 正式版：与 Web 端生产环境共用
  prod: {
    BASE_URL: "https://www.wxkzd.com",
  },
};

function resolveEnv() {
  try {
    const { envVersion } = wx.getAccountInfoSync().miniProgram;
    if (envVersion === "develop") return ENV.dev;
    if (envVersion === "trial") return ENV.trial;
    return ENV.prod;
  } catch (e) {
    // 基础库过低等异常情况兜底为生产
    return ENV.prod;
  }
}

module.exports = {
  ...resolveEnv(),
  ENV,
};
