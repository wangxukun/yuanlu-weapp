/**
 * scripts/test-entry-source.js — 启动来源捕获与剧集直达测试
 *
 * 把门口径 = utils/entry-source.js 与服务端 core/utils/signup-source.ts 的同一正则：
 *   - scene（getwxacodeunlimit，百分号编码投递）与 src（后台路径参数码）两种入口
 *   - scene 优先于 src；合法才落 storage，最近一次扫码进入覆盖旧值
 *   - 非法值（空格/中文/超长）静默丢弃，不影响已有来源；get() 对存储同款校验兜底
 *   - captureFromQuery 返回本次新捕获值（自然打开返回 ''，不触发直达）
 *
 * 直达（T2）：handleEntry 仅对新来源发起 GET /api/wxacode 解析；
 *   targetType=episode → navigateTo /pages/episode/episode?id=；follow/404/网络失败
 *   一律静默不导航；冷启动 onLaunch+onShow 同参双触发 10s 去重；
 *   navigateTo 冷启动竞态 fail 时退避重试（最多 2 次）。
 *
 * 运行：node scripts/test-entry-source.js
 */

const storage = new Map();
const requests = []; // 捕获的 wx.request 调用
const navigations = []; // 捕获的 wx.navigateTo url（含重试）
let requestResponder = null; // (opt) => { statusCode, data } | { networkFail: true }
let navigateFailCount = 0; // 前N次导航强制 fail（模拟首页未就绪竞态）

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  // utils/config.js 在 require 时读取（entry-source 依赖它）
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
  request(opt) {
    requests.push(opt);
    setTimeout(() => {
      const r = requestResponder
        ? requestResponder(opt)
        : { statusCode: 404, data: { success: false } };
      if (r && r.networkFail) {
        opt.fail && opt.fail({});
        return;
      }
      opt.success && opt.success({ statusCode: r.statusCode, data: r.data });
    }, 1);
  },
  navigateTo(opt) {
    navigations.push(opt.url);
    if (navigateFailCount > 0) {
      navigateFailCount -= 1;
      opt.fail && opt.fail({ errMsg: 'navigateTo:fail page is not ready' });
    } else {
      opt.success && opt.success({});
    }
  },
};

const entrySource = require('../utils/entry-source');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}

async function main() {
  console.log('utils/entry-source.js — 启动来源捕获与剧集直达');

  // ── 基础捕获 ──
  ok(entrySource.captureFromQuery({ src: 'gzh_follow' }) === 'gzh_follow', 'src 路径参数码捕获并返回新捕获值');
  ok(entrySource.get() === 'gzh_follow', '来源已落 storage');

  ok(entrySource.captureFromQuery({ scene: 'gzh_w1_b' }) === 'gzh_w1_b', 'scene 短码捕获并覆盖旧来源（最近扫码为准）');
  ok(entrySource.captureFromQuery({ scene: '%67zh_w2_b' }) === 'gzh_w2_b', 'scene 百分号编码自动 decode（微信投递形态）');
  ok(entrySource.captureFromQuery({ scene: 'gzh_w3_b', src: 'gzh_follow' }) === 'gzh_w3_b', 'scene 与 src 同时存在时 scene 优先');

  // ── 非法值拒收 ──
  storage.delete('entrySource');
  ok(entrySource.captureFromQuery({ src: 'bad source!' }) === '', '含空格/感叹号的值拒收且返回空串');
  ok(entrySource.captureFromQuery({ src: '公众号来源' }) === '', '中文值拒收');
  ok(entrySource.captureFromQuery({ src: 'a'.repeat(101) }) === '', '超长值（>100）拒收');
  ok(entrySource.captureFromQuery({ src: '  gzh_w4_b  ' }) === 'gzh_w4_b', '首尾空白 trim 后接受');

  // ── 自然打开不触碰旧值、不触发直达 ──
  const before = requests.length;
  ok(entrySource.captureFromQuery({}) === '', '无参数启动返回空串');
  ok(entrySource.captureFromQuery(undefined) === '', 'query 缺省（onLaunch 无 options）不抛异常');
  ok(entrySource.captureFromQuery({ scene: '', src: '' }) === '', '空字符串参数视为无来源');
  ok(entrySource.get() === 'gzh_w4_b', '自然打开保持旧来源（归因不丢）');

  // ── get() 兜底 ──
  storage.set('entrySource', 'tampered!! value');
  ok(entrySource.get() === '', 'get() 对被篡改的存储值做同款校验兜底');
  storage.delete('entrySource');
  ok(entrySource.get() === '', '无来源时 get() 返回空串');

  // ── T2 剧集直达 ──
  requestResponder = () => ({
    statusCode: 200,
    data: { success: true, data: { scene: 'gzh_w5_b', targetType: 'episode', episodeId: 'cmivwgyal_ep5' } },
  });
  entrySource.handleEntry({ scene: 'gzh_w5_b' });
  await sleep(20);
  ok(navigations[navigations.length - 1] === '/pages/episode/episode?id=cmivwgyal_ep5', 'episode 型 scene 解析后直达剧集页');
  ok(entrySource.get() === 'gzh_w5_b', '直达与归因互不干扰（storage 已更新）');

  // follow 类型：只归因不导航
  requestResponder = () => ({
    statusCode: 200,
    data: { success: true, data: { scene: 'gzh_follow2', targetType: 'follow' } },
  });
  const navCountBefore = navigations.length;
  entrySource.handleEntry({ scene: 'gzh_follow2' });
  await sleep(20);
  ok(navigations.length === navCountBefore, 'follow 类型（无剧集目标）不导航');

  // 冷启动同参双触发去重
  requestResponder = () => ({
    statusCode: 200,
    data: { success: true, data: { scene: 'gzh_w6_b', targetType: 'episode', episodeId: 'ep6' } },
  });
  const reqBefore = requests.length;
  entrySource.handleEntry({ scene: 'gzh_w6_b' }); // 模拟 onLaunch
  entrySource.handleEntry({ scene: 'gzh_w6_b' }); // 模拟紧随其后的 onShow
  await sleep(20);
  ok(requests.length - reqBefore === 1, '冷启动 onLaunch+onShow 双触发只解析一次');
  ok(navigations.filter((u) => u === '/pages/episode/episode?id=ep6').length === 1, '剧集页只被压栈一次');

  // 404 / 网络失败：静默不导航不抛错
  requestResponder = () => ({ statusCode: 404, data: { success: false, error: '短码不存在' } });
  const nav404 = navigations.length;
  entrySource.handleEntry({ scene: 'gzh_w7_b' });
  await sleep(20);
  ok(navigations.length === nav404, '短码不存在（404）静默不导航');

  requestResponder = () => ({ networkFail: true });
  entrySource.handleEntry({ scene: 'gzh_w8_b' });
  await sleep(20);
  ok(navigations.length === nav404, '网络失败静默不导航不抛错');

  // 自然打开（无新来源）不发起任何解析请求
  requestResponder = () => ({ statusCode: 200, data: { success: true, data: { targetType: 'episode', episodeId: 'x' } } });
  const reqNatural = requests.length;
  entrySource.handleEntry({});
  entrySource.handleEntry(undefined);
  await sleep(20);
  ok(requests.length === reqNatural, '自然打开不触发解析（防止旧来源劫持导航）');

  // navigateTo 冷启动竞态：fail 两次后第三次成功（退避 600+1200ms）
  navigateFailCount = 2;
  requestResponder = () => ({
    statusCode: 200,
    data: { success: true, data: { scene: 'gzh_w9_b', targetType: 'episode', episodeId: 'ep9' } },
  });
  entrySource.handleEntry({ scene: 'gzh_w9_b' });
  await sleep(2000);
  ok(navigations.filter((u) => u === '/pages/episode/episode?id=ep9').length === 3, '首页未就绪时退避重试直达（2 次失败后成功）');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main();
